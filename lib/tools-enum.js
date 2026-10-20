/**
 * 只读工具：环境自检、拓扑树、设备清单、单设备详情、报告生成。
 *
 * 全部只读 —— 不改设备、不弹 UAC、不需要管理员。
 * 会改设备状态的在 `tools-control.js`。
 *
 * @module dsh-usb/lib/tools-enum
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineTool } from './define-tool.js';
import { ok, fail, output, clip } from './result.js';
import {
  RUN_DIR,
  loadTree,
  resolveExe,
  flatten,
  resolveDevice,
  renderTree,
  summarize,
  rowText,
  labelOf,
  vidPidOf,
  speedText,
} from './usbtree.js';
import { describeDevice, candidateList, summaryText } from './format.js';
import { PNPUTIL, pnputil, parseEnumDevices } from './pnputil.js';
import { parseHexMaybe } from './usbcodes.js';
import { isAdmin } from './exec.js';

const CACHE_INDEX = () => join(RUN_DIR, 'reports', 'index.json');

function readCacheInfo() {
  try {
    const idx = JSON.parse(readFileSync(CACHE_INDEX(), 'utf8'));
    const path = Array.isArray(idx) ? idx[0]?.path : idx?.path;
    if (!path || !existsSync(path)) return { exists: false };
    const st = statSync(path);
    return {
      exists: true,
      path,
      sizeBytes: st.size,
      generatedAt: idx?.generatedAt ?? idx?.[0]?.generatedAt ?? st.mtime.toISOString(),
      ageSec: Math.round((Date.now() - st.mtimeMs) / 1000),
    };
  } catch {
    return { exists: false };
  }
}

/** 在复合设备的子设备里找（`flatten` 不含子设备）。 */
function findInChildren(tree, query) {
  const q = String(query ?? '').toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const row of flatten(tree)) {
    for (const child of row.device.children ?? []) {
      const hay = [child.instanceId, child.description, child.className, child.service]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (hay.includes(q)) hits.push({ parent: row, child });
    }
  }
  return hits;
}

/**
 * 统一的 id 解析：先按顶层设备解析，找不到再下沉到复合子设备。
 * 命中多个**一律全返回**，由调用方决定 —— 猜错会操作错设备。
 */
function resolveAny(tree, id) {
  const base = resolveDevice(tree, id);
  if (base.matches.length) return { ...base, level: 'device' };
  const kids = findInChildren(tree, id);
  if (kids.length) return { matches: kids, reason: 'child-instance-id', level: 'child' };
  return { ...base, level: 'device' };
}

const fromCache = (t) => {
  const d = new Date(t.generatedAt ?? NaN);
  const when = Number.isNaN(d.getTime()) ? String(t.generatedAt ?? '未知时间') : d.toISOString();
  return `报告：${t.reportPath}\n生成：${when}（${t.cached ? '命中缓存' : '本次生成'}，${t.durationMs} ms，解析 ${t.parseMs ?? '?'} ms）`;
};

/* ------------------------------------------------------------------ *
 * usb_env
 * ------------------------------------------------------------------ */

const envTool = defineTool({
  name: 'usb_env',
  description:
    '检查这台机器的 USB 工具链：UsbTreeView 报告生成器在哪、pnputil 是否可用、当前进程是不是管理员、报告缓存有没有。' +
    '开始任何 USB 操作前先跑一次；它不改设备、不生成报告，只回答「能不能干活」。',
  parameters: {
    refresh: { type: 'boolean', description: 'true 重新探测管理员权限（默认复用 30 秒内的缓存检测结果）' },
  },
  output,
  timeoutMs: 60000,
  async execute(args) {
    const exe = resolveExe();
    const admin = await isAdmin({ refresh: args.refresh === true });
    const cache = readCacheInfo();
    const pnputilOk = existsSync(PNPUTIL);

    const lines = [
      `UsbTreeView：${exe.path ? `找到 → ${exe.path}（来源：${exe.source}）` : '未找到'}`,
      `pnputil：${pnputilOk ? `可用 → ${PNPUTIL}` : '缺失（枚举与卸载类操作不可用）'}`,
      `管理员权限：${admin ? '是（可直接卸载/禁用设备）' : '否（卸载、禁用类操作会弹 UAC 提权窗口）'}`,
      `报告缓存：${
        cache.exists
          ? `有 → ${cache.path}（${cache.ageSec} 秒前，${(cache.sizeBytes / 1024).toFixed(0)} KB）`
          : '无（第一次调用 usb_tree / usb_devices 会生成，约 10 秒）'
      }`,
    ];
    if (!exe.path) {
      lines.push('');
      lines.push('UsbTreeView 缺失的三种补法（任选其一）：');
      lines.push('  1. 把 UsbTreeView.exe 放到插件目录 vendor/ 下');
      lines.push('  2. 设环境变量 DSH_USB_TREEVIEW=完整路径');
      lines.push('  3. 调 usb_tree 时传 exePath 参数');
    }

    const message = lines.join('\n');
    if (!exe.path && !pnputilOk) {
      return fail('no-tooling', message, { exe, pnputil: { path: PNPUTIL, exists: pnputilOk }, admin, cache });
    }
    return ok(message, { exe, pnputil: { path: PNPUTIL, exists: pnputilOk }, admin, cache });
  },
});

/* ------------------------------------------------------------------ *
 * usb_tree
 * ------------------------------------------------------------------ */

const treeTool = defineTool({
  name: 'usb_tree',
  description:
    '列出 USB 拓扑树：控制器 → 根 hub → 端口 → 设备，每个设备带端口链、VID:PID、名称、速度、类型判定。' +
    '默认只显示接着设备的端口（空端口是噪音）。首次调用要生成 UsbTreeView 报告，约 10 秒。',
  parameters: {
    showEmpty: { type: 'boolean', description: 'true 也列出没接设备的端口（排查「为什么这个口不认设备」时用）' },
    maxAgeSec: {
      type: 'number',
      description: '报告缓存有效期（秒），默认 300；传 0 强制重新生成。刚插拔设备、想看到最新状态就传 0',
    },
    exePath: { type: 'string', description: 'UsbTreeView.exe 的完整路径；不给就按环境变量/插件目录/桌面默认位置找' },
  },
  output,
  timeoutMs: 180000,
  async execute(args) {
    const t = await loadTree({
      exePath: args.exePath,
      maxAgeMs: (args.maxAgeSec ?? 300) * 1000,
    });
    if (!t.ok) return fail(t.code ?? 'tree-failed', t.message ?? '取 USB 树失败', t);

    const tree = t.tree;
    const s = summarize(tree);
    const body = renderTree(tree, { showEmpty: args.showEmpty === true });
    const message = `${body}\n\n${summaryText(s)}`;

    return ok(message, {
      tree: t.reportPath,
      reportPath: t.reportPath,
      generatedAt: t.generatedAt,
      cached: t.cached,
      summary: s,
      controllers: (tree.controllers ?? []).map((c) => ({
        index: c.index,
        name: c.name,
        pciVendorId: c.pciVendorId,
        pciDeviceId: c.pciDeviceId,
        occupied: (c.rootHub?.ports ?? []).filter((p) => p.device).length,
      })),
      rows: flatten(tree).map((r) => rowText(r, { wide: true })),
    });
  },
});

/* ------------------------------------------------------------------ *
 * usb_devices
 * ------------------------------------------------------------------ */

const devicesTool = defineTool({
  name: 'usb_devices',
  description:
    '列出 USB 设备清单（扁平表，一行一个设备，带端口链）。按 VID/PID、类型或关键词筛选时用它，' +
    '比 usb_tree 更适合逐条读。数据源默认是 UsbTreeView 报告（含描述符里的厂商名与产品名）；' +
    'source=pnputil 快得多（约 1 秒）但只有 Windows 侧信息，且只涵盖已连接设备。',
  parameters: {
    source: {
      type: 'string',
      enum: ['report', 'pnputil'],
      description: 'report（默认，信息全）/ pnputil（快，只有 Windows 侧描述与位置）',
    },
    keyword: { type: 'string', description: '关键词，不区分大小写，匹配产品名/厂商名/序列号/设备描述/实例 ID' },
    vid: { type: 'string', description: '厂商 ID，十六进制，如 24ae 或 0x24AE' },
    pid: { type: 'string', description: '产品 ID，十六进制，如 4077' },
    kind: { type: 'string', description: '类型关键词，如 keyboard / 键盘 / hub / audio / 蓝牙' },
    limit: { type: 'integer', minimum: 1, maximum: 400, description: '最多返回多少行，默认 40' },
    maxAgeSec: { type: 'number', description: '报告缓存有效期（秒），默认 300；只对 source=report 有效' },
  },
  output,
  timeoutMs: 180000,
  async execute(args) {
    const limit = args.limit ?? 40;

    if (args.source === 'pnputil') {
      const r = await pnputil(['/enum-devices', '/connected', '/class', 'USB', '/location', '/services']);
      if (!r.ok) return fail('pnputil-failed', r.error ?? r.stderr ?? 'pnputil 执行失败', { stderr: r.stderr });
      const all = parseEnumDevices(r.output);
      // `/class USB` 会把主机控制器（PCI\VEN_...）也带出来 —— 那不是「插上的 USB 设备」，滤掉
      const peripherals = all.filter((d) => !/^PCI\\/i.test(d.instanceId ?? ''));
      const rows = filterPnputil(peripherals, args);
      const { rows: shown, truncated } = clip(rows, limit, 400);
      const lines = shown.map(
        (d) =>
          `${(d.instanceId ?? '?').padEnd(50)} ${(d.description ?? '').slice(0, 40).padEnd(40)} [${d.status ?? '?'}] ${d.locationInfo ?? ''}`.trimEnd(),
      );
      if (truncated) lines.push(`… 还有 ${rows.length - shown.length} 个未显示（调大 limit）`);
      const head = `pnputil 枚举到 ${rows.length} 个已连接 USB 外设（另有 ${all.length - peripherals.length} 个主机控制器已排除）`;
      return ok(`${head}${lines.length ? `：\n\n${lines.join('\n')}` : ''}`, {
        source: 'pnputil',
        count: rows.length,
        devices: shown,
        truncated,
      });
    }

    const t = await loadTree({ maxAgeMs: (args.maxAgeSec ?? 300) * 1000 });
    if (!t.ok) return fail(t.code ?? 'tree-failed', t.message ?? '取 USB 设备表失败', t);

    let rows = flatten(t.tree);
    const vid = args.vid === undefined ? undefined : parseHexMaybe(args.vid);
    const pid = args.pid === undefined ? undefined : parseHexMaybe(args.pid);
    const kw = args.keyword?.toLowerCase();
    const kind = args.kind?.toLowerCase();
    rows = rows.filter((r) => {
      const d = r.device;
      if (vid !== undefined && d.vid !== vid) return false;
      if (pid !== undefined && d.pid !== pid) return false;
      if (kind) {
        const hay = [d.kindGuess?.kind, d.kindGuess?.zh, d.info?.className, d.info?.service].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(kind)) return false;
      }
      if (kw) {
        const hay = [d.productName, d.manufacturerName, d.vendorName, d.serialNumber, d.instanceId, d.info?.description, d.info?.busReportedDesc, d.info?.friendlyName]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    const { rows: shown, truncated } = clip(rows, limit, 400);
    const lines = shown.map((r) => rowText(r, { wide: true }));
    if (truncated) lines.push(`… 还有 ${rows.length - shown.length} 个未显示（调大 limit）`);
    const head = `匹配 ${rows.length} 个设备 / 报告里共 ${flatten(t.tree).length} 个`;
    return ok(`${head}${lines.length ? `：\n\n${lines.join('\n')}` : ''}`, {
      source: 'report',
      count: rows.length,
      devices: shown.map((r) => ({
        chain: r.chain,
        port: r.portNumber,
        vidPid: vidPidOf(r.device),
        name: labelOf(r.device),
        speed: speedText(r.device),
        kind: r.device.kindGuess?.kind,
        kindZh: r.device.kindGuess?.zh,
        instanceId: r.device.instanceId,
        status: r.device.info?.status,
        children: r.device.children?.length ?? 0,
      })),
      truncated,
      reportPath: t.reportPath,
    });
  },
});

function filterPnputil(rows, args) {
  const vid = args.vid === undefined ? undefined : parseHexMaybe(args.vid);
  const pid = args.pid === undefined ? undefined : parseHexMaybe(args.pid);
  const kw = args.keyword?.toLowerCase();
  const kind = args.kind?.toLowerCase();
  return rows.filter((d) => {
    const inst = String(d.instanceId ?? '');
    if (vid !== undefined) {
      const m = /VID_([0-9A-Fa-f]{4})/i.exec(inst);
      if (!m || parseInt(m[1], 16) !== vid) return false;
    }
    if (pid !== undefined) {
      const m = /PID_([0-9A-Fa-f]{4})/i.exec(inst);
      if (!m || parseInt(m[1], 16) !== pid) return false;
    }
    const hay = [d.description, d.className, d.service, d.manufacturer, inst].filter(Boolean).join(' ').toLowerCase();
    if (kind && !hay.includes(kind)) return false;
    if (kw && !hay.includes(kw)) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * usb_device
 * ------------------------------------------------------------------ */

const deviceTool = defineTool({
  name: 'usb_device',
  description:
    '查一个 USB 设备的完整信息：设备/配置/接口/端点/HID 描述符、字符串描述符、连接信息、复合设备的子设备。' +
    'id 支持端口链（1-1）、VID:PID（24ae:4077）、实例 ID、或关键词（Rapoo、蓝牙）。' +
    '命中多个设备时会列出候选而不猜 —— 改用更精确的 id 再来一次。',
  parameters: {
    id: { type: 'string', description: '端口链 / VID:PID / 实例 ID / 关键词' },
    maxAgeSec: { type: 'number', description: '报告缓存有效期（秒），默认 300；传 0 强制重新生成' },
    interfaces: { type: 'integer', minimum: 1, maximum: 64, description: '最多展开多少个接口，默认 10' },
    endpoints: { type: 'integer', minimum: 1, maximum: 32, description: '每个接口最多展开多少个端点，默认 6' },
    children: { type: 'integer', minimum: 0, maximum: 250, description: '最多列多少个复合子设备，默认 10' },
    strings: { type: 'integer', minimum: 0, maximum: 64, description: '最多列多少条字符串描述符，默认 6' },
  },
  output,
  timeoutMs: 180000,
  async execute(args) {
    const t = await loadTree({ maxAgeMs: (args.maxAgeSec ?? 300) * 1000 });
    if (!t.ok) return fail(t.code ?? 'tree-failed', t.message ?? '取 USB 设备失败', t);

    const r = resolveAny(t.tree, args.id);
    if (!r.matches.length) {
      const all = flatten(t.tree);
      const sample = candidateList(all, 12);
      return fail('device-not-found', `找不到 id="${args.id}" 对应的设备。当前接着的设备：\n${sample}`, {
        reason: r.reason,
        available: all.map((row) => ({ chain: row.chain, vidPid: vidPidOf(row.device), name: labelOf(row.device) })),
      });
    }
    if (r.matches.length > 1) {
      if (r.level === 'child') {
        const lines = r.matches
          .slice(0, 20)
          .map(({ parent, child }) => `  [${parent.chain}] ${child.instanceId}  ${child.description ?? ''} [${child.className ?? '?'}]`);
        if (r.matches.length > 20) lines.push(`  … 另有 ${r.matches.length - 20} 个`);
        return fail(
          'ambiguous',
          `id="${args.id}" 命中 ${r.matches.length} 个复合子设备，请用完整实例 ID：\n${lines.join('\n')}`,
          { candidates: r.matches.slice(0, 50) },
        );
      }
      return fail('ambiguous', `id="${args.id}" 命中 ${r.matches.length} 个设备，请用更精确的 id：\n${candidateList(r.matches, 20)}`, {
        candidates: r.matches.map((row) => ({ chain: row.chain, vidPid: vidPidOf(row.device), name: labelOf(row.device), instanceId: row.device.instanceId })),
      });
    }

    // 命中复合子设备：把父设备的详情给出来，并说明命中的是哪个子设备
    if (r.level === 'child') {
      const { parent, child } = r.matches[0];
      const { text, detail } = describeDevice(parent.device, {
        interfaces: args.interfaces,
        endpoints: args.endpoints,
        children: args.children,
        strings: args.strings,
      });
      const head = `id 命中的是复合子设备 ${child.instanceId}（${child.description ?? '?'}），下面给出它所属的父设备 [${parent.chain}] ${labelOf(parent.device)}：`;
      return ok(`${head}\n\n${text}`, { matched: { level: 'child', child }, detail, reportPath: t.reportPath });
    }

    const row = r.matches[0];
    const { text, detail } = describeDevice(row.device, {
      interfaces: args.interfaces,
      endpoints: args.endpoints,
      children: args.children,
      strings: args.strings,
    });
    return ok(text, { matched: { level: 'device', chain: row.chain, reason: r.reason }, detail, reportPath: t.reportPath });
  },
});

/* ------------------------------------------------------------------ *
 * usb_report
 * ------------------------------------------------------------------ */

const reportTool = defineTool({
  name: 'usb_report',
  description:
    '生成或复用 UsbTreeView 报告，给出文件路径与统计（控制器/设备/hub/权限）。' +
    '其他 usb_* 工具都读这份报告；刚插拔过设备、或缓存过期想拿最新快照时用它刷新（约 10 秒）。' +
    '报告是 1.7 MB 的原始文本，不要直接读全文 —— 用 usb_tree / usb_device 取结构化结果。',
  parameters: {
    maxAgeSec: {
      type: 'number',
      description: '缓存有效期（秒），默认 300；传 0 强制重新生成',
    },
    exePath: { type: 'string', description: 'UsbTreeView.exe 完整路径；不给就自动找' },
  },
  output,
  timeoutMs: 180000,
  async execute(args) {
    const t = await loadTree({
      exePath: args.exePath,
      maxAgeMs: (args.maxAgeSec ?? 300) * 1000,
      reuse: args.maxAgeSec === 0 ? false : true,
    });
    if (!t.ok) return fail(t.code ?? 'report-failed', t.message ?? '生成报告失败', t);
    const s = summarize(t.tree);
    const message = `${s.controllers} 个控制器 / ${s.devices} 个接着设备的端口 / ${s.hubs} 个 hub\n${fromCache(t)}`;
    return ok(message, { reportPath: t.reportPath, generatedAt: t.generatedAt, cached: t.cached, durationMs: t.durationMs, parseMs: t.parseMs, summary: s });
  },
});

/** 注册全部只读工具。 */
export function registerEnumTools(ctx) {
  for (const tool of [envTool, treeTool, devicesTool, deviceTool, reportTool]) {
    ctx.tools.register(tool);
  }
  return [envTool, treeTool, devicesTool, deviceTool, reportTool].map((t) => t.name);
}
