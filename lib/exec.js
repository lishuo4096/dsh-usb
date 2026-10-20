/**
 * 进程执行、编码解码、提权 —— 本插件的运行时底座。
 *
 * ## 为什么编码要单独处理
 *
 * Windows 上的 `pnputil` 把中文设备名按**控制台 ANSI 代码页**（本机 CP936/GBK）写到管道里，
 * 不是 UTF-8。Node 直接 `toString()` 会得到一堆 `锟斤拷`。而 `UsbTreeView /R:` 生成的报告
 * 文件是 **UTF-16LE + BOM**。两种源、两种编码，所以统一走 {@link decodeOutput}：
 * 先认 BOM，再试严格 UTF-8，失败退 GBK，最后才 latin1 兜底。
 *
 * ## 为什么提权要绕一圈
 *
 * 本机 `ConsentPromptBehaviorAdmin=5` + `PromptOnSecureDesktop=1`：`pnputil /remove-device`
 * 这类写操作必须弹 UAC，而 UAC 在**安全桌面**上，Node 子进程拿不到它的返回值。
 * 所以走「写一个 .ps1 到私有目录 → `Start-Process -Verb RunAs` 拉起 → 结果落 JSON 文件 →
 * 父进程读文件」。用户点「否」时 `Start-Process` 抛 1223，据此区分「取消」与「失败」。
 *
 * @module lib/exec
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

/** 插件根目录（`lib/` 的上一级）。 */
export const PLUGIN_ROOT = (() => {
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return process.cwd();
  }
})();

/** 私有运行区：所有临时脚本、报告缓存、记住的默认值都在这里，绝不写用户的工程目录。 */
export const RUN_DIR = join(PLUGIN_ROOT, '.run');

export function ensureRunDir(sub) {
  const dir = sub ? join(RUN_DIR, sub) : RUN_DIR;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 短随机 id，用于临时文件名。 */
export function shortId(prefix = 'x') {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

const utf8Strict = () => new TextDecoder('utf-8', { fatal: true });

/**
 * 把一段原始字节解码成文本。
 *
 * 判据顺序：UTF-16 BOM → UTF-8 BOM → 严格 UTF-8 → GBK → latin1。
 * 严格 UTF-8 这一步很关键：`pnputil` 的 GBK 输出里偶尔有能凑巧通过 UTF-8 校验的片段，
 * 但没有——**中文 GBK 双字节几乎必然违反 UTF-8 续字节规则**，所以先 UTF-8 再 GBK 是安全的。
 *
 * @param {Buffer} buf
 * @param {string} [forceEncoding] 显式指定（'utf16le' / 'utf8' / 'gbk'）
 * @returns {string}
 */
export function decodeOutput(buf, forceEncoding) {
  if (!buf || buf.length === 0) return '';
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  if (forceEncoding) {
    try {
      let enc = forceEncoding;
      if (enc === 'utf16le' && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(bytes.subarray(2));
      }
      return new TextDecoder(enc === 'utf8' ? 'utf-8' : enc).decode(bytes);
    } catch {
      return bytes.toString('latin1');
    }
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  try {
    return utf8Strict().decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return bytes.toString('latin1');
    }
  }
}

/**
 * 跑一个外部程序并收齐输出。
 *
 * 永不抛异常：失败也是返回值（`ok:false` + `error`）。这一点与工具层的约定一致——
 * 把「命令没跑起来」表达成可读结论，而不是一段栈。
 *
 * @param {string} file 可执行文件
 * @param {string[]} [args]
 * @param {{timeoutMs?:number, cwd?:string, env?:object, encoding?:string, input?:string}} [opts]
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string,
 *   error?:string, timedOut:boolean, durationMs:number}>}
 */
export function run(file, args = [], opts = {}) {
  const { timeoutMs = 30_000, cwd, env, encoding, input } = opts;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: `spawn 失败：${String(error?.message ?? error)}`,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const out = [];
    const err = [];
    let timedOut = false;
    let settled = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGKILL');
          } catch {
            /* 进程可能已经退出 */
          }
        }, timeoutMs)
      : null;

    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));

    if (input !== undefined && child.stdin) {
      try {
        child.stdin.end(input);
      } catch {
        /* 目标不读 stdin */
      }
    }

    const finish = (code, extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut && !extra,
        code,
        stdout: decodeOutput(Buffer.concat(out), encoding),
        stderr: decodeOutput(Buffer.concat(err), encoding),
        ...(timedOut ? { error: `超时（${timeoutMs} ms）被强制结束` } : {}),
        ...(extra ? { error: extra } : {}),
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (error) => finish(null, `进程错误：${String(error?.message ?? error)}`));
    child.on('close', (code) => finish(code ?? null));
  });
}

/** 本机是否 PowerShell 可用（Windows 一定有，这里只做一次性探测缓存）。 */
let psPathCache;
/**
 * 读 PowerShell 写下的结果 JSON。
 *
 * ⚠️ Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 写出来是**带 BOM** 的 UTF-8，
 * 而 `JSON.parse('\uFEFF{...}')` 直接抛 `Unexpected token ''`。
 * 这个坑只在 PS 5.1 上出现（pwsh 7 的 utf8 是 no-BOM），所以必须在这里剥掉，
 * 而不是让每个调用方各自 trim。
 *
 * @param {string} path
 * @returns {string}
 */
export function readResultJson(path) {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}

export function powershellPath() {
  if (psPathCache !== undefined) return psPathCache;
  const candidates = [
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ];
  psPathCache = candidates.find((p) => (p === 'powershell.exe' ? true : existsSync(p))) ?? 'powershell.exe';
  return psPathCache;
}

/**
 * 跑一段 PowerShell 脚本，并把 `$Result` 走 JSON 文件带回来。
 *
 * 脚本正文里可以直接用 `$P`（调用方传的 `params`，已 `ConvertFrom-Json`）和
 * `$Result`（有序字典，已预置 `ok=$true`）。结束时自动落盘、自动带 `ok/error`。
 *
 * @param {string} body 脚本正文（不含 try/catch 外框）
 * @param {{timeoutMs?:number, params?:object}} [opts]
 * @returns {Promise<{ok:boolean, value:any, stdout:string, stderr:string,
 *   error?:string, durationMs:number}>}
 */
export async function runPs(body, opts = {}) {
  const { timeoutMs = 60_000, params = {} } = opts;
  const dir = ensureRunDir('ps');
  const id = shortId('ps');
  const scriptPath = join(dir, `${id}.ps1`);
  const paramsPath = join(dir, `${id}.params.json`);
  const resultPath = join(dir, `${id}.result.json`);

  writeFileSync(paramsPath, JSON.stringify(params), 'utf8');
  const escaped = (p) => p.replace(/'/g, "''");
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `$P = (Get-Content -LiteralPath '${escaped(paramsPath)}' -Raw -Encoding UTF8) | ConvertFrom-Json`,
    `$Result = [ordered]@{ ok = $true }`,
    `try {`,
    body,
    `} catch {`,
    `  $Result.ok = $false`,
    `  $Result.error = $_.Exception.Message`,
    `}`,
    `($Result | ConvertTo-Json -Depth 10 -Compress) | Set-Content -LiteralPath '${escaped(resultPath)}' -Encoding UTF8`,
  ].join('\r\n');

  // 带 BOM 的 UTF-8：Windows PowerShell 5.1 在没有 BOM 时按 ANSI 解脚本，
  // 脚本里的中文注释会变成乱码，极端情况下还会破坏字符串字面量。
  writeFileSync(scriptPath, `\ufeff${script}`, 'utf8');

  const res = await run(
    powershellPath(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { timeoutMs },
  );

  const cleanup = () => {
    for (const p of [scriptPath, paramsPath, resultPath]) {
      try {
        unlinkSync(p);
      } catch {
        /* 已经不在 */
      }
    }
  };

  if (!existsSync(resultPath)) {
    cleanup();
    return {
      ok: false,
      value: undefined,
      stdout: res.stdout,
      stderr: res.stderr,
      error: res.error ?? `PowerShell 没有写出结果文件（退出码 ${res.code}）${
        res.stderr ? `：${res.stderr.trim().slice(0, 400)}` : ''
      }`,
      durationMs: res.durationMs,
    };
  }

  let value;
  try {
    value = JSON.parse(readResultJson(resultPath));
  } catch (error) {
    cleanup();
    return {
      ok: false,
      value: undefined,
      stdout: res.stdout,
      stderr: res.stderr,
      error: `结果 JSON 解析失败：${String(error?.message ?? error)}`,
      durationMs: res.durationMs,
    };
  }

  cleanup();
  return { ok: value?.ok !== false, value, stdout: res.stdout, stderr: res.stderr, durationMs: res.durationMs };
}

/** 当前进程是否**已提权**（High/System 完整性级别）。结果缓存 30 秒。 */
let adminCache;
export async function isAdmin({ refresh = false } = {}) {
  if (!refresh && adminCache && Date.now() - adminCache.at < 30_000) return adminCache.value;
  const res = await run('whoami', ['/groups', '/fo', 'csv', '/nh'], { timeoutMs: 8000, encoding: 'utf8' });
  // 提权后组列表里有 Medium 或 High；未提权只有 Medium。更稳的判据是看 Mandatory Label。
  const text = res.stdout;
  const high = /S-1-16-(12288|16384|20480|28672)/.test(text) || /Mandatory Label\\\\High/.test(text);
  const medium = /S-1-16-8192/.test(text);
  const value = high || (!medium && res.ok && /Administrators/.test(text));
  adminCache = { at: Date.now(), value };
  return value;
}

/**
 * 以管理员身份跑一段 PowerShell（触发 UAC）。
 *
 * 用户点「否」时返回 `code:'elevation-cancelled'`——这**不是错误**，是正常结果，
 * 工具层据此告诉模型「用户拒绝了提权」而不是「命令失败」。
 *
 * @param {string} body 脚本正文（同 {@link runPs}）
 * @param {{timeoutMs?:number, params?:object}} [opts]
 */
export async function runPsElevated(body, opts = {}) {
  const { timeoutMs = 180_000, params = {} } = opts;
  const dir = ensureRunDir('elevated');
  const id = shortId('elev');
  const scriptPath = join(dir, `${id}.ps1`);
  const paramsPath = join(dir, `${id}.params.json`);
  const resultPath = join(dir, `${id}.result.json`);

  writeFileSync(paramsPath, JSON.stringify(params), 'utf8');
  const script = [
    `param([string]$Params, [string]$Result)`,
    `$ErrorActionPreference = 'Stop'`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `$P = (Get-Content -LiteralPath $Params -Raw -Encoding UTF8) | ConvertFrom-Json`,
    `$Out = [ordered]@{ ok = $true }`,
    `try {`,
    body,
    `} catch {`,
    `  $Out.ok = $false`,
    `  $Out.error = $_.Exception.Message`,
    `}`,
    `($Out | ConvertTo-Json -Depth 10 -Compress) | Set-Content -LiteralPath $Result -Encoding UTF8`,
  ].join('\r\n');
  writeFileSync(scriptPath, `\ufeff${script}`, 'utf8');

  const argLine = [
    '-NoProfile',
    '-ExecutionPolicy Bypass',
    `-File "${scriptPath}"`,
    `-Params "${paramsPath}"`,
    `-Result "${resultPath}"`,
  ].join(' ');

  const launcher = [
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    `  $p = Start-Process -FilePath '${powershellPath().replace(/'/g, "''")}' -ArgumentList '${argLine.replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru`,
    `  "exit=$($p.ExitCode)"`,
    `} catch {`,
    `  "error=$($_.Exception.Message)"`,
    `}`,
  ].join('\r\n');

  const res = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', launcher], {
    timeoutMs,
  });

  const cancelled = /cancel|取消|1223/i.test(`${res.stdout}\n${res.stderr}`);

  if (!existsSync(resultPath)) {
    try {
      unlinkSync(scriptPath);
      unlinkSync(paramsPath);
    } catch {
      /* ignore */
    }
    if (res.timedOut) {
      return {
        ok: false,
        value: undefined,
        code: 'elevation-timeout',
        error: `等待 UAC 提权超时（${Math.round(timeoutMs / 1000)} 秒内没有在安全桌面上批准）`,
      };
    }
    if (cancelled) {
      return { ok: false, value: undefined, code: 'elevation-cancelled', error: 'UAC 提权被取消' };
    }
    return {
      ok: false,
      value: undefined,
      code: 'elevation-failed',
      error: `提权进程没有产出结果：${(res.stderr || res.stdout || '').trim().slice(0, 400) || `退出码 ${res.code}`}`,
    };
  }

  let value;
  try {
    value = JSON.parse(readResultJson(resultPath));
  } catch (error) {
    return {
      ok: false,
      value: undefined,
      code: 'elevation-bad-json',
      error: `提权结果无法解析：${String(error?.message ?? error)}`,
    };
  } finally {
    for (const p of [scriptPath, paramsPath, resultPath]) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }

  return { ok: value?.ok !== false, value, code: value?.ok === false ? 'elevated-command-failed' : undefined };
}
