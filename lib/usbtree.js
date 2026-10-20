/**
 * 在 `report.js` 的解析结果之上做**视图层**：树、扁平列表、按条件查设备、ASCII 渲染。
 *
 * 为什么不在这里再解析一遍报告：`report.js` 已经把 16000 行文本变成了结构化对象，
 * 这里只做「怎么给 agent 看」——过滤、截断、渲染。两份职责分开，改渲染不会碰解析器。
 *
 * ## 两个关键事实（都实测过，写错就出鬼）
 *
 * 1. **父子关系只能看 `Port Chain` 段**。报告的章节顺序是深度优先的
 *    （`3-1-1-4-1..4` 之后紧跟 `3-1-2`），缩进也不反映层级，行号更不能比。
 *    `report.js` 已经按 chain 前缀把树接好了，这里只做遍历。
 * 2. **根 hub 的 `bNumberOfPorts` 与控制器自报的 `NumberOfRootPorts` 常常不等**
 *    （实测 xHCI 报 3 个根端口、根 hub 报 5 个）。显示以**根 hub** 为准，
 *    因为端口章节是根 hub 枚举出来的。
 *
 * @module dsh-usb/lib/usbtree
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { generateReport, parseReport } from './report.js';
import { PLUGIN_ROOT, RUN_DIR } from './exec.js';
import { padDisplay } from './result.js';

/* ------------------------------------------------------------------ *
 * UsbTreeView.exe 定位
 * ------------------------------------------------------------------ */

/** 用户桌面那份（本插件最初就是为它写的）。 */
const DESKTOP_EXE = 'C:\\Users\\lishuo\\Desktop\\实用程序\\UsbTreeView.exe';

/** 插件自带副本（可选，谁把 exe 拷进来就用这个，不依赖桌面路径）。 */
const VENDORED_EXE = join(PLUGIN_ROOT, 'vendor', 'UsbTreeView.exe');

/**
 * 解析 UsbTreeView.exe 的路径。
 *
 * 优先级：显式参数 → 环境变量 `DSH_USB_TREEVIEW` → 插件自带 → 桌面默认位置。
 * 找不到就返回 `undefined`，由调用方给出「装在哪、怎么配」的说明 ——
 * 不在这里抛异常，因为「没装 UsbTreeView」是这个插件的**正常退化路径**
 * （纯 pnputil 的枚举/树/控制仍然能用，只是没有描述符细节）。
 *
 * @param {string} [explicit]
 * @returns {{path?:string, source:string, checked:string[]}}
 */
export function resolveExe(explicit) {
  const checked = [];
  const candidates = [
    explicit ? { path: explicit, source: '参数 exePath' } : null,
    process.env.DSH_USB_TREEVIEW ? { path: process.env.DSH_USB_TREEVIEW, source: '环境变量 DSH_USB_TREEVIEW' } : null,
    { path: VENDORED_EXE, source: '插件自带 vendor/UsbTreeView.exe' },
    { path: DESKTOP_EXE, source: '桌面默认位置' },
  ].filter(Boolean);

  for (const c of candidates) {
    checked.push(c.path);
    if (existsSync(c.path)) return { path: c.path, source: c.source, checked };
  }
  return { source: '未找到', checked };
}

/* ------------------------------------------------------------------ *
 * 报告 → 树（带解析缓存）
 * ------------------------------------------------------------------ */

/**
 * 解析结果的进程内缓存。
 *
 * `generateReport()` 本身已经做了**磁盘**缓存（TTL 5 分钟、只留 3 份），
 * 但每次工具调用都会重新 `parseReport()` 一遍 1.7 MB 文本。解析要几十毫秒，
 * 而 agent 一轮里连调 3–5 次 `usb_*` 是常态 —— 所以按报告路径 + mtime 再缓存一层。
 */
let parsedCache = /** @type {{path:string, size:number, mtimeMs:number, tree:any}|undefined} */ (undefined);

/**
 * 拿到一棵解析好的 USB 树。
 *
 * @param {object} [opts]
 * @param {string} [opts.exePath] 显式指定 UsbTreeView.exe
 * @param {number} [opts.maxAgeMs] 报告缓存有效期，默认 300000；0 = 强制重新生成
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.reuse] 复用进程内已解析的树（默认 true）
 * @returns {Promise<{ok:boolean, tree?:any, reportPath?:string, generatedAt?:number,
 *   cached?:boolean, durationMs?:number, code?:string, error?:string, hint?:string}>}
 */
export async function loadTree(opts = {}) {
  const { exePath, maxAgeMs = 300_000, timeoutMs = 120_000, reuse = true } = opts;

  if (reuse && maxAgeMs > 0 && parsedCache && existsSync(parsedCache.path)) {
    const age = Date.now() - parsedCache.mtimeMs;
    if (age >= 0 && age < maxAgeMs) {
      return {
        ok: true,
        tree: parsedCache.tree,
        reportPath: parsedCache.path,
        // 命中进程内缓存时也要给 generatedAt —— 早前漏了这个字段，
        // 上层 `new Date(undefined).toISOString()` 直接抛 RangeError: Invalid time value。
        generatedAt: new Date(parsedCache.mtimeMs).toISOString(),
        cached: true,
        durationMs: 0,
        parseMs: 0,
      };
    }
  }

  const res = resolveExe(exePath);
  if (!res.path) {
    return {
      ok: false,
      code: 'no-usbtreeview',
      error: '没找到 UsbTreeView.exe（描述符/速度/端口链这些细节需要它）',
      hint:
        '三选一：① 把 UsbTreeView.exe 放到 ' +
        VENDORED_EXE +
        '；② 设环境变量 DSH_USB_TREEVIEW=<绝对路径>；③ 调工具时传 exePath。' +
        '  没有它也能用 usb_devices（pnputil 快速枚举），只是没有描述符细节。',
    };
  }

  const report = await generateReport({ exePath: res.path, maxAgeMs, timeoutMs });
  if (!report.ok) return { ok: false, code: report.code, error: report.error, durationMs: report.durationMs };

  let tree;
  const t0 = Date.now();
  try {
    tree = parseReport(report.text);
  } catch (error) {
    return { ok: false, code: 'parse-failed', error: `报告解析失败：${String(error?.message ?? error)}` };
  }
  const parseMs = Date.now() - t0;
  tree.exePath = res.path;
  tree.exeSource = res.source;

  if (report.path) {
    try {
      const { statSync } = await import('node:fs');
      const st = statSync(report.path);
      parsedCache = { path: report.path, size: st.size, mtimeMs: st.mtimeMs, tree };
    } catch {
      parsedCache = undefined;
    }
  }

  return {
    ok: true,
    tree,
    reportPath: report.path,
    generatedAt: report.generatedAt,
    cached: report.cached,
    durationMs: report.durationMs,
    parseMs,
  };
}

/** 丢掉进程内解析缓存（报告被外部改过、或强制刷新时用）。 */
export function invalidateCache() {
  parsedCache = undefined;
}

/* ------------------------------------------------------------------ *
 * 扁平化 / 查询
 * ------------------------------------------------------------------ */

/**
 * 把树拍平成一维设备表，每行带上「在树里的位置」。
 *
 * 拍平而不是让调用方递归，是因为 agent 侧最常问的是
 * 「哪些设备/某个 VID 在哪/第 3 个控制器下面挂了什么」，一维表最省 token。
 *
 * @param {any} tree `parseReport()` 的返回值
 * @returns {Array<any>}
 */
export function flatten(tree) {
  const rows = [];

  const visitPorts = (hub, controllerIndex, depth, parentChain) => {
    for (const port of hub.ports ?? []) {
      const dev = port.device;
      if (!dev) continue;
      rows.push({
        controllerIndex,
        depth,
        portNumber: port.portNumber,
        chain: port.chain,
        parentChain: port.parentChain ?? parentChain,
        // 端口段自己的 Summary（VID/PID 厂商名、"Demanded Current" 之类）
        portSummary: port.summary,
        device: dev,
      });
      if (dev.ports?.length) visitPorts(dev, controllerIndex, depth + 1, port.chain);
    }
  };

  for (const c of tree.controllers ?? []) {
    if (c.rootHub) visitPorts(c.rootHub, c.index, 0, undefined);
  }
  return rows;
}

/** 设备的显示名：优先 Product String，退到 Windows 描述。 */
export function labelOf(dev) {
  return (
    dev?.productName ||
    dev?.info?.description ||
    dev?.info?.busReportedDesc ||
    dev?.info?.friendlyName ||
    '(未命名设备)'
  );
}

/** `24ae:4077`（小写、补满 4 位十六进制，`1a86:03aa` 而不是 `1a86:3aa`）。 */
export function vidPidOf(dev) {
  const v = dev?.vid;
  const p = dev?.pid;
  if (v === undefined || p === undefined) return undefined;
  const hex = (n) => Number(n).toString(16).padStart(4, '0');
  return `${hex(v)}:${hex(p)}`;
}

/** 树里出现过的最短 VID/PID 形式，用于紧凑列表。 */
export function compactRow(row) {
  const d = row.device;
  return {
    chain: row.chain,
    port: row.portNumber,
    vidPid: vidPidOf(d),
    name: labelOf(d),
    kind: d.kindGuess?.kind,
    kindZh: d.kindGuess?.zh,
    speed: d.speed,
    status: d.info?.status,
    instanceId: d.instanceId,
    children: d.children?.length ?? 0,
  };
}

/**
 * 把用户/agent 给的 `id` 解析成一个设备。
 *
 * 支持四种写法（都实测过 agent 会混着用）：
 *   - 端口链：`1-1`、`3-1-1-4-4`
 *   - VID:PID：`24ae:4077`（大小写、冒号/斜杠都认）
 *   - 实例 ID 全串或尾部片段：`USB\VID_24AE&PID_4077\6&1C1844B5&0&1`
 *   - 关键词：`Rapoo`、`webcam`、`蓝牙`
 *
 * 命中多个就全返回，让调用方自己选 —— **不猜**。猜错会卸载错设备。
 *
 * @param {any} tree
 * @param {string} query
 * @returns {{matches:Array<any>, reason:string}}
 */
export function resolveDevice(tree, query) {
  const q = String(query ?? '').trim();
  if (!q) return { matches: [], reason: 'empty' };

  const rows = flatten(tree);
  const qLower = q.toLowerCase();

  // 1) 端口链：整串等于 chain
  const byChain = rows.filter((r) => String(r.chain ?? '') === q);
  if (byChain.length === 1) return { matches: byChain, reason: 'port-chain' };
  if (byChain.length > 1) return { matches: byChain, reason: 'port-chain-ambiguous' };

  // 2) VID:PID —— 允许 `24ae:4077` / `24AE/4077` / `0x24ae:0x4077`
  const vidPid = /^(?:0x)?([0-9a-f]{1,4})\s*[:/]\s*(?:0x)?([0-9a-f]{1,4})$/i.exec(q);
  if (vidPid) {
    const v = parseInt(vidPid[1], 16);
    const p = parseInt(vidPid[2], 16);
    const hits = rows.filter((r) => r.device.vid === v && r.device.pid === p);
    return { matches: hits, reason: hits.length ? 'vid-pid' : 'vid-pid-not-found' };
  }

  // 3) 实例 ID：全串精确 → 尾部精确 → 子串
  const exact = rows.filter((r) => r.device.instanceId === q);
  if (exact.length) return { matches: exact, reason: 'instance-id' };
  const instLike = rows.filter((r) => String(r.device.instanceId ?? '').toLowerCase().includes(qLower));
  if (instLike.length) return { matches: instLike, reason: 'instance-id-partial' };

  // 4) 关键词：描述 / 厂商 / 序列号
  const kw = rows.filter((r) => {
    const d = r.device;
    const hay = [
      d.productName,
      d.manufacturerName,
      d.vendorName,
      d.serialNumber,
      d.info?.description,
      d.info?.busReportedDesc,
      d.info?.friendlyName,
      d.info?.service,
      d.kindGuess?.kind,
      d.kindGuess?.zh,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(qLower);
  });
  return { matches: kw, reason: kw.length ? 'keyword' : 'not-found' };
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/** 速度显示，统一成 `Low-Speed` / `High-Speed` / `SuperSpeed` 这类短名。 */
export function speedText(dev) {
  const s = dev?.speed ?? dev?.connection?.busSpeedText;
  if (!s) return '?';
  // 报告里可能是 "Low-Speed"，也可能是 "1.5 Mbit/s LowSpeed"
  if (/Low/i.test(s)) return 'Low';
  if (/Full/i.test(s)) return 'Full';
  if (/High/i.test(s)) return 'High';
  if (/Super/i.test(s)) return 'Super';
  return String(s).slice(0, 10);
}

/** 一行的紧凑文本（树和列表共用）。 */
export function rowText(row, { wide = false } = {}) {
  const d = row.device;
  const nameW = wide ? 40 : 28;
  const rawName = labelOf(d);
  // 名字按显示宽度截断：中文名按码元截会切出半个字
  let name = rawName;
  if ([...rawName].length > nameW * 2) name = `${[...rawName].slice(0, nameW).join('')}…`;
  const bits = [
    padDisplay(String(row.chain ?? '?'), wide ? 14 : 10),
    (vidPidOf(d) ?? '----:----').padEnd(9),
    padDisplay(name, nameW),
    padDisplay(speedText(d), 5),
    padDisplay(d.kindGuess?.kind ?? '?', 11),
  ];
  const kids = d.children?.length ? `+${d.children.length}子` : '';
  const hubPorts = d.ports?.length ? `${d.ports.length}口` : '';
  const tail = [kids, hubPorts].filter(Boolean).join(' ');
  return (bits.join(' ') + (tail ? ` ${tail}` : '')).replace(/\s+$/, '');
}

/**
 * 渲染成树状文本。
 *
 * 只列**连着设备的端口**（`showEmpty: true` 才列空端口）：
 * 本机实测 28 个端口里只有 7 个接着设备，全列出来纯噪音。
 *
 * @param {any} tree
 * @param {{showEmpty?:boolean, maxDepth?:number, maxChildren?:number}} [opts]
 */
export function renderTree(tree, opts = {}) {
  const { showEmpty = false, maxDepth = 10 } = opts;
  const lines = [];

  for (const c of tree.controllers ?? []) {
    const rootPorts = c.rootHub?.hubDescriptor?.ports ?? c.rootPorts;
    const occupied = (c.rootHub?.ports ?? []).filter((p) => p.device).length;
    lines.push(
      `控制器 ${c.index}: ${c.name}` +
        (c.pciVendorId !== undefined
          ? ` [${hex4(c.pciVendorId)}:${hex4(c.pciDeviceId)}]`
          : '') +
        ` — 根端口 ${rootPorts ?? '?'} 个，占用 ${occupied}`,
    );

    const walk = (hub, prefix, depth) => {
      const ports = hub.ports ?? [];
      const shown = showEmpty ? ports : ports.filter((p) => p.device);
      shown.forEach((port, i) => {
        const last = i === shown.length - 1;
        const branch = last ? '└─' : '├─';
        const childPrefix = prefix + (last ? '   ' : '│  ');
        const dev = port.device;
        if (!dev) {
          lines.push(`${prefix}${branch} 端口${port.portNumber} [${port.chain}] （空）`);
          return;
        }
        lines.push(`${prefix}${branch} ${rowText({ chain: port.chain, portNumber: port.portNumber, device: dev })}`);
        if (depth + 1 > maxDepth) {
          if (dev.ports?.length) lines.push(`${childPrefix}   … 层级过深，已截断`);
          return;
        }
        if (dev.ports?.length) walk(dev, childPrefix, depth + 1);
      });
    };
    if (c.rootHub) walk(c.rootHub, '  ', 0);
  }
  return lines.join('\n');
}

function hex4(n) {
  return n === undefined ? '????' : `0x${Number(n).toString(16).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

/**
 * 树的一行统计（`usb_tree` 的 message 用它，避免 agent 非要把整棵树读一遍才知道有多少设备）。
 */
export function summarize(tree) {
  const rows = flatten(tree);
  const kinds = new Map();
  for (const r of rows) {
    const k = r.device.kindGuess?.zh ?? r.device.kindGuess?.kind ?? '未知';
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  return {
    controllers: tree.controllers?.length ?? 0,
    devices: rows.length,
    hubs: rows.filter((r) => r.device.kind === 'hub').length,
    occupiedPorts: rows.length,
    byKind: Object.fromEntries([...kinds.entries()].sort((a, b) => b[1] - a[1])),
    counts: tree.meta?.counts,
    adminPrivileges: tree.meta?.adminPrivileges,
  };
}

export { RUN_DIR, PLUGIN_ROOT };
