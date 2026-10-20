/**
 * `pnputil.exe` 的封装与解析。
 *
 * ## 为什么用 pnputil 而不是 Get-PnpDevice
 *
 * 实测（本机 Win11 26200.9711）：
 * - `pnputil /enum-devices /connected /class USB /location /services` → **0.58 s**
 * - `pnputil /enum-devicetree /connected` → **1.5 s**
 * - `Get-PnpDevice -Class USB` → **12.93 s**
 *
 * 而且本机的 `PnpDevice` 模块（v1.0.0.0）只有 Get/Disable/Enable，**没有 Remove**，
 * 卸载只能走 pnputil。所以整条链路统一用 pnputil，输出自己解析。
 *
 * ## 输出格式的两个坑
 *
 * 1. **编码是 GBK**，不是 UTF-8（`lib/exec.js` 的 decodeOutput 处理）。
 * 2. **字段名会随系统语言变**，所以解析器同时认英文键名和中文键名，并保留未识别的键到 `extra`。
 *
 * @module lib/pnputil
 */

import { join } from 'node:path';
import { isAdmin, run } from './exec.js';

/** pnputil 的绝对路径（走 System32，避免 PATH 被改）。 */
export const PNPUTIL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'pnputil.exe');

/**
 * 跑一次 pnputil。
 * @param {string[]} args
 * @param {{timeoutMs?:number}} [opts]
 */
export async function pnputil(args, opts = {}) {
  const res = await run(PNPUTIL, args, { timeoutMs: opts.timeoutMs ?? 60_000 });
  return {
    ...res,
    output: `${res.stdout}\n${res.stderr}`.trim(),
    /** pnputil 有时用 stdout 报错，不能只看退出码 */
    looksLikeError: /failed|error|invalid|access is denied|拒绝访问|失败|错误/i.test(`${res.stdout}\n${res.stderr}`),
  };
}

/* ------------------------------------------------------------------ *
 * /enum-devices 文本解析
 * ------------------------------------------------------------------ */

/**
 * 把 `pnputil /enum-devices` 的文本块解析成结构体。
 *
 * 输出是「若干设备块，块间空行，块内 `Key: value`」。字段名随语言变化，所以这里
 * **不按固定顺序取**，而是先把所有 `Key: value` 收齐，再按多种别名映射。
 *
 * @param {string} text
 * @returns {Array<{instanceId:string, description?:string, className?:string, classGuid?:string,
 *   manufacturer?:string, status?:string, driverName?:string, service?:string, locationInfo?:string,
 *   locationPaths?:string, extra:Record<string,string>}>}
 */
export function parseEnumDevices(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  let current = null;

  const isHeader = (line) => /^\s*(Microsoft PnP Utility|微软 PnP 实用工具)/i.test(line);

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    if (isHeader(line)) continue;

    const m = /^([^:]{1,60}?):\s+(.*)$/.exec(line);
    if (!m) {
      // 续行（例如 Location Paths 被折断）：挂到上一个键上
      if (current && current.__lastKey) {
        current[current.__lastKey] = `${current[current.__lastKey]} ${line.trim()}`.trim();
      }
      continue;
    }
    const key = m[1].trim();
    const value = m[2].trim();
    if (!current) current = { extra: {} };
    current.__lastKey = key;

    const put = (field) => {
      if (!current[field]) current[field] = value;
    };
    switch (key) {
      case 'Instance ID':
      case '实例 ID':
        put('instanceId');
        break;
      case 'Device Description':
      case '设备描述':
        put('description');
        break;
      case 'Class Name':
      case '类名':
        put('className');
        break;
      case 'Class GUID':
      case '类 GUID':
        put('classGuid');
        break;
      case 'Manufacturer Name':
      case '制造商名称':
        put('manufacturer');
        break;
      case 'Status':
      case '状态':
        put('status');
        break;
      case 'Driver Name':
      case '驱动程序名称':
        put('driverName');
        break;
      case 'Service':
      case '服务':
        put('service');
        break;
      case 'Location Info':
      case '位置信息':
        put('locationInfo');
        break;
      case 'Location Paths':
      case '位置路径':
        put('locationPaths');
        break;
      default:
        if (!current.extra[key]) current.extra[key] = value;
    }
  }
  if (current) blocks.push(current);

  return blocks
    .filter((b) => b.instanceId)
    .map((b) => {
      const { __lastKey, ...rest } = b;
      return rest;
    });
}

/** 从 `Port_#0003.Hub_#0004` 里抠出端口号与所在 hub 号。 */
export function parseLocationInfo(text) {
  const s = String(text ?? '');
  const port = /Port_#0*(\d+)/i.exec(s);
  const hub = /Hub_#0*(\d+)/i.exec(s);
  if (!port && !hub) return undefined;
  return {
    port: port ? Number(port[1]) : undefined,
    hub: hub ? Number(hub[1]) : undefined,
    raw: s,
  };
}

/* ------------------------------------------------------------------ *
 * /enum-devicetree 文本解析
 * ------------------------------------------------------------------ */

/**
 * 解析 `pnputil /enum-devicetree` 的树形文本。
 *
 * 每行形如 `  | +-USB\VID_x&PID_y\z (描述) [Started]`，前缀每级 2 字符（`| ` 或两个空格），
 * 所以 `depth = 前缀长度 / 2`。描述里可能含括号，所以状态用**最后一个** `)` 之后的 `[]` 定位。
 *
 * @param {string} text
 * @returns {Array<{depth:number, instanceId:string, description?:string, status?:string, parent:number}>}
 */
export function parseDeviceTree(text) {
  const nodes = [];
  const stack = []; // stack[depth] = node index

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^\s*Microsoft PnP Utility/i.test(line)) continue;

    const m = /^((?:(?:\|\s)|(?:\s\s))*)\+-(.+)$/.exec(line);
    if (!m) continue;

    const depth = Math.floor(m[1].length / 2);
    const body = m[2].trim();

    let instanceId;
    let description;
    let status;
    const withDesc = /^(\S+)\s+\((.*)\)\s+\[([^\]]*)\]\s*$/.exec(body);
    if (withDesc) {
      instanceId = withDesc[1];
      description = withDesc[2];
      status = withDesc[3];
    } else {
      const bare = /^(\S+)\s*(?:\[([^\]]*)\])?\s*$/.exec(body);
      if (!bare) continue;
      instanceId = bare[1];
      status = bare[2];
    }

    const parent = depth === 0 ? -1 : (stack[depth - 1] ?? -1);
    const index = nodes.length;
    nodes.push({ depth, instanceId, description, status, parent });
    stack[depth] = index;
    stack.length = depth + 1;
  }

  return nodes;
}

/**
 * 从整棵设备树里裁出「USB 相关」的那几棵子树。
 *
 * 起点是 `USB\ROOT_HUB*` 节点，向上带上它的 PCI 父节点（这样才看得到控制器名），
 * 向下收全部后代。返回的每个元素是一棵独立子树（含 `parentIndex` 指向原数组）。
 *
 * @param {ReturnType<typeof parseDeviceTree>} nodes
 */
export function extractUsbSubtrees(nodes) {
  const isRootHub = (n) => /^USB\\ROOT_HUB/i.test(n.instanceId);
  const include = new Set();

  for (let i = 0; i < nodes.length; i += 1) {
    if (!isRootHub(nodes[i])) continue;
    // 向上带 1~2 层父节点（PCI 控制器 / PCI bus）
    let up = nodes[i].parent;
    let guard = 0;
    while (up >= 0 && guard < 3) {
      include.add(up);
      up = nodes[up].parent;
      guard += 1;
    }
    include.add(i);
    // 向下收后代
    for (let j = i + 1; j < nodes.length && nodes[j].depth > nodes[i].depth; j += 1) {
      include.add(j);
    }
  }

  return nodes
    .map((n, i) => ({ ...n, index: i }))
    .filter((n) => include.has(n.index));
}

/* ------------------------------------------------------------------ *
 * 控制动作
 * ------------------------------------------------------------------ */

const VERB = {
  remove: '/remove-device',
  restart: '/restart-device',
  enable: '/enable-device',
  disable: '/disable-device',
};

/**
 * 控制一个设备（卸载 / 重启 / 启用 / 禁用）。
 *
 * **写操作**。未提权时会自动走 UAC 提权路径，并把 UAC 取消识别成独立结果码。
 *
 * @param {'remove'|'restart'|'enable'|'disable'} action
 * @param {string} instanceId
 * @param {{subtree?:boolean, force?:boolean, dryRun?:boolean, timeoutMs?:number}} [opts]
 */
export async function controlDevice(action, instanceId, opts = {}) {
  const verb = VERB[action];
  if (!verb) return { ok: false, code: 'bad-action', error: `不支持的动作：${action}` };

  const args = [verb, instanceId];
  if (action === 'remove' && opts.subtree) args.push('/subtree');
  if (action === 'remove' && opts.force) args.push('/force');

  const admin = await isAdmin();

  // 预演：不碰目标、**也不弹 UAC**。卸载/重启用错实例 ID 的代价太大，
  // 所以工具层默认先预演一遍，把要执行的命令行原样给调用方看。
  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      command: `pnputil ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`,
      elevated: false,
      requiresAdmin: !admin,
      message: `[预演] pnputil ${args.join(' ')}${admin ? '' : '（未提权，实跑时会弹 UAC）'}`,
    };
  }

  if (admin) {
    const res = await pnputil(args, { timeoutMs: opts.timeoutMs ?? 60_000 });
    const succeeded = res.code === 0 && !res.looksLikeError;
    return {
      ok: succeeded,
      code: succeeded ? undefined : 'pnp-command-failed',
      exitCode: res.code,
      output: res.output,
      elevated: false,
      error: succeeded ? undefined : res.output.split(/\r?\n/).filter(Boolean).pop(),
    };
  }

  // 未提权：直接起提权子进程跑同一条命令。
  const { runPsElevated } = await import('./exec.js');
  const res = await runPsElevated(
    [
      `$ErrorActionPreference = 'Continue'`,
      `try { [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936) } catch { }`,
      `$lines = @()`,
      `$code = 0`,
      `& '${PNPUTIL.replace(/'/g, "''")}' @($P.args) 2>&1 | ForEach-Object { $lines += [string]$_ }`,
      `$code = $LASTEXITCODE`,
      `$Out.exitCode = $code`,
      `$Out.output = ($lines -join "\`n")`,
      `$Out.looksLikeError = [bool](($lines -join "\`n") -match 'failed|error|invalid|拒绝访问|失败|错误')`,
    ].join('\r\n'),
    { params: { args }, timeoutMs: opts.timeoutMs ?? 180_000 },
  );

  if (!res.ok && res.code && res.code.startsWith('elevation')) {
    return { ok: false, code: res.code, error: res.error, elevated: true };
  }
  const value = res.value ?? {};
  const succeeded = value.exitCode === 0 && !value.looksLikeError;
  return {
    ok: succeeded,
    code: succeeded ? undefined : res.code === 'elevated-command-failed' ? 'elevated-command-failed' : 'pnp-command-failed',
    exitCode: value.exitCode,
    output: String(value.output ?? '').trim(),
    elevated: true,
    error: succeeded
      ? undefined
      : res.error ?? String(value.output ?? '').split(/\r?\n/).filter(Boolean).pop(),
  };
}

/**
 * 触发一次设备重新扫描（热插拔的软件等价物）。
 *
 * @param {{instanceId?:string, dryRun?:boolean, timeoutMs?:number}} [opts]
 */
export async function scanDevices(opts = {}) {
  const args = ['/scan-devices'];
  if (opts.instanceId) args.push(opts.instanceId);
  const admin = await isAdmin();
  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      command: `pnputil ${args.join(' ')}`,
      requiresAdmin: !admin,
      message: `[预演] pnputil ${args.join(' ')}${admin ? '' : '（未提权，实跑时会弹 UAC）'}`,
    };
  }
  if (admin) {
    const res = await pnputil(args, { timeoutMs: opts.timeoutMs ?? 120_000 });
    return { ok: res.code === 0 && !res.looksLikeError, output: res.output, exitCode: res.code, elevated: false };
  }
  const { runPsElevated } = await import('./exec.js');
  const res = await runPsElevated(
    [
      `$ErrorActionPreference = 'Continue'`,
      `try { [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936) } catch { }`,
      `$lines = @()`,
      `& '${PNPUTIL.replace(/'/g, "''")}' @($P.args) 2>&1 | ForEach-Object { $lines += [string]$_ }`,
      `$Out.exitCode = $LASTEXITCODE`,
      `$Out.output = ($lines -join "\`n")`,
    ].join('\r\n'),
    { params: { args }, timeoutMs: opts.timeoutMs ?? 180_000 },
  );
  if (!res.ok && res.code && res.code.startsWith('elevation')) {
    return { ok: false, code: res.code, error: res.error, elevated: true };
  }
  const value = res.value ?? {};
  return { ok: value.exitCode === 0, output: String(value.output ?? ''), exitCode: value.exitCode, elevated: true };
}
