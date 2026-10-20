/**
 * 会改设备状态的工具：安全弹出、pnputil 控制、排错剧本。
 *
 * 安全约定（全部工具一致）：
 *   - `confirm` 默认 false → 只**预演**，回显将要执行的命令行/目标节点，不改设备、也不弹 UAC；
 *   - 真正改变设备状态前，先在 message 里写清「会失去什么」，再写「怎么执行」。
 *
 * @module dsh-usb/lib/tools-control
 */

import { defineTool } from './define-tool.js';
import { ok, fail, output } from './result.js';
import { loadTree, flatten, resolveDevice, labelOf, vidPidOf } from './usbtree.js';
import { candidateList } from './format.js';
import { ejectDevice } from './eject.js';
import { controlDevice, scanDevices } from './pnputil.js';

/**
 * 统一解析 id → 实例 ID。
 * 命中多个一律报错并给候选（猜错会操作错设备）。
 */
async function resolveInstanceId(id, maxAgeSec = 300) {
  // 已经是完整实例 ID 就不必花 10 秒去生成报告
  if (/^(USB|USBSTOR|HID|PCI|SWD|ROOT|BTHENUM|BTHLEDEVICE)\\/i.test(id)) {
    return { ok: true, instanceId: id, direct: true };
  }
  const t = await loadTree({ maxAgeMs: maxAgeSec * 1000 });
  if (!t.ok) return { ok: false, code: t.code ?? 'tree-failed', error: t.message ?? '取 USB 树失败' };

  const r = resolveDevice(t.tree, id);
  if (!r.matches.length) {
    return {
      ok: false,
      code: 'device-not-found',
      error: `找不到 id="${id}"。当前接着的设备：\n${candidateList(flatten(t.tree), 12)}`,
      tree: t.tree,
    };
  }
  if (r.matches.length > 1) {
    return {
      ok: false,
      code: 'ambiguous',
      error: `id="${id}" 命中 ${r.matches.length} 个设备，请用完整实例 ID：\n${candidateList(r.matches, 20)}`,
      candidates: r.matches.map((row) => ({ chain: row.chain, vidPid: vidPidOf(row.device), name: labelOf(row.device), instanceId: row.device.instanceId })),
      tree: t.tree,
    };
  }
  const row = r.matches[0];
  return { ok: true, instanceId: row.device.instanceId, row, tree: t.tree, reason: r.reason };
}

/**
 * 设备的 Windows 状态是不是「有问题」。
 *
 * 报告里的 Status 是 `0x0180400A (DN_DRIVER_LOADED, DN_STARTED, ...)` —— 健康设备也是这串，
 * 所以**不能**拿 `!== 'OK'` 判故障（早前这么写，每台设备都被判成异常）。
 * 权威判据是 `DN_HAS_PROBLEM`(0x400) 位；pnputil 给的本地化文本（「已启动」/「错误」）走关键词兜底。
 */
const DN_HAS_PROBLEM = 0x00000400;

function statusLooksBad(status) {
  if (!status) return false;
  const s = String(status);
  const hex = /^0x([0-9a-f]+)/i.exec(s);
  if (hex) return (parseInt(hex[1], 16) & DN_HAS_PROBLEM) !== 0;
  return /error|failed|unknown|problem|错误|未知|失败|已禁用|disabled/i.test(s);
}

/**
 * 操作前的风险提示。只提示、不阻断（hub 卸载例外，见 usb_control）。
 */
function riskNotes(tree, row) {
  const notes = [];
  if (!row) return notes;
  const dev = row.device;
  // 类型要用 kindGuess.kinds —— 键盘接收器的 kind 是 'composite'，光看 kind 会漏掉「这是输入设备」
  const kindWords = [dev.kindGuess?.kind, ...(dev.kindGuess?.kinds ?? []), dev.info?.className, dev.info?.service]
    .filter(Boolean)
    .join(' ');
  if (dev.kind === 'hub') {
    const downstream = flatten(tree).filter((r) => String(r.chain ?? '').startsWith(`${row.chain}-`));
    notes.push(`这是 hub，它下面挂着 ${downstream.length} 个设备，操作会一并影响它们。`);
  }
  if (dev.children?.length) notes.push(`这是复合设备（${dev.children.length} 个子功能），整机操作会让全部功能一起消失。`);
  if (/keyboard|mouse|hid|键盘|鼠标/i.test(kindWords)) {
    const inputs = flatten(tree).filter((r) =>
      /keyboard|mouse|hid|键盘|鼠标/i.test(
        [r.device.kindGuess?.kind, ...(r.device.kindGuess?.kinds ?? []), r.device.info?.className, r.device.info?.service]
          .filter(Boolean)
          .join(' '),
      ),
    );
    notes.push(
      inputs.length <= 1
        ? '这看起来是当前**唯一**的输入设备（键盘/鼠标）。禁用或卸载后你将无法操作这台机器，只能靠重新插拔或远程手段恢复。'
        : `这是输入设备之一（同类共 ${inputs.length} 个）。同一个接收器上的键鼠可能一起失效。`,
    );
  }
  if (statusLooksBad(dev.info?.status)) notes.push(`设备状态是「${String(dev.info.status).slice(0, 60)}」，不是正常启动状态。`);
  return notes;
}

const noteBlock = (notes) => (notes.length ? `\n\n注意：\n${notes.map((n) => `  - ${n}`).join('\n')}` : '');

/* ------------------------------------------------------------------ *
 * usb_eject
 * ------------------------------------------------------------------ */

const ejectTool = defineTool({
  name: 'usb_eject',
  description:
    '安全弹出 USB 设备（等价于任务栏「安全删除硬件」）：先让驱动释放设备，驱动可以拒绝并报出否决者名称；弹出成功后多数设备仍需物理拔出。' +
    'mode=remove-subtree 是强制摘除整棵设备子树，只用于设备卡死、普通弹出失败且重插无效的场合。' +
    '正在写入的存储设备弹错会丢数据。confirm 默认 false —— 只探测并回显将要弹哪个节点，不改设备、不弹 UAC。',
  parameters: {
    id: { type: 'string', description: '端口链（1-1）/ VID:PID（24ae:4077）/ 实例 ID / 关键词' },
    confirm: { type: 'boolean', description: 'true 才真正执行；默认 false 只预演（探测目标节点与能力）' },
    mode: {
      type: 'string',
      enum: ['eject', 'remove-subtree'],
      description: 'eject（默认，安全弹出）/ remove-subtree（强制摘除整树，危险）',
    },
  },
  output,
  timeoutMs: 180000,
  async execute(args) {
    const r = await resolveInstanceId(args.id, args.maxAgeSec);
    if (!r.ok) return fail(r.code, r.error, { candidates: r.candidates, tree: r.tree?.reportPath });

    const notes = riskNotes(r.tree, r.row);
    const res = await ejectDevice(r.instanceId, {
      dryRun: args.confirm !== true,
      mode: args.mode ?? 'eject',
    });

    if (!res.ok) {
      return fail(res.code ?? 'eject-failed', `${res.error ?? res.message ?? '弹出失败'}${noteBlock(notes)}`, {
        instanceId: r.instanceId,
        ejectTarget: res.ejectTarget,
        capabilities: res.capabilities,
        cr: res.cr,
        crText: res.crText,
        vetoType: res.vetoType,
        vetoName: res.vetoName,
      });
    }

    const head = res.dryRun ? res.message : `✅ ${res.message}`;
    const tail = res.dryRun
      ? `\n\n目标节点：${res.ejectTarget}${res.climbedLevels ? `（从你给的设备向上爬了 ${res.climbedLevels} 层）` : ''}` +
        `\n能力：${(res.capabilities ?? []).join(', ') || '（无）'}` +
        `\n确认无误后加 confirm: true 再调一次。`
      : '';
    return ok(`${head}${tail}${noteBlock(notes)}`, {
      dryRun: res.dryRun === true,
      instanceId: r.instanceId,
      ejectTarget: res.ejectTarget,
      climbedLevels: res.climbedLevels,
      capabilities: res.capabilities,
      cr: res.cr,
      crText: res.crText,
      vetoType: res.vetoType,
      vetoName: res.vetoName,
      notes,
    });
  },
});

/* ------------------------------------------------------------------ *
 * usb_control
 * ------------------------------------------------------------------ */

const VERB_ZH = {
  remove: '卸载',
  disable: '禁用',
  enable: '启用',
  restart: '重启',
  scan: '重新扫描硬件',
};

const controlTool = defineTool({
  name: 'usb_control',
  description:
    '用 pnputil 改变 USB 设备状态：remove 卸载设备节点（驱动随后可能重新枚举）、disable / enable 禁用启用、restart 重启设备、scan 重新扫描硬件（等效于「扫描检测硬件改动」）。' +
    '除 scan 外都需要管理员权限；未提权时会弹 UAC 窗口，用户必须亲自在安全桌面上点确认。' +
    'confirm 默认 false —— 只回显将要执行的命令行，不执行、不弹 UAC。' +
    '卸载 hub 会带走整棵下游子树（需 force: true 才放行）；卸载唯一键鼠会让你无法操作机器。',
  parameters: {
    action: {
      type: 'string',
      enum: ['remove', 'disable', 'enable', 'restart', 'scan'],
      description: '要执行的动作；scan 不需要 id',
    },
    id: { type: 'string', description: '端口链 / VID:PID / 实例 ID / 关键词；action=scan 时可省略' },
    confirm: { type: 'boolean', description: 'true 才真正执行；默认 false 只预演命令行' },
    subtree: { type: 'boolean', description: '只对 remove 有效：true 连子树一起卸载（复合设备、hub 用）' },
    force: { type: 'boolean', description: '只对 remove 有效：true 即使卸载 hub 或输入设备也放行' },
  },
  output,
  timeoutMs: 180000,
  async execute(args) {
    const needId = args.action !== 'scan';
    if (needId && !args.id) {
      return fail('missing-id', `action=${args.action} 需要 id：给端口链、VID:PID、实例 ID 或关键词。`);
    }

    if (args.action === 'scan') {
      const res = await scanDevices({ instanceId: args.id, dryRun: args.confirm !== true });
      if (res.dryRun) {
        return ok(
          `[预演] 将执行：${res.command}${res.requiresAdmin ? '\n（当前未提权：实跑会弹 UAC 安全桌面）' : ''}\n\n确认无误后加 confirm: true 再调一次。`,
          { dryRun: true, command: res.command, requiresAdmin: res.requiresAdmin },
        );
      }
      if (!res.ok) return fail('scan-failed', res.output || res.error || 'pnputil 重新扫描失败', { code: res.code });
      return ok(`已重新扫描硬件。${res.output ? `\n\n${res.output.trim()}` : ''}`, { command: res.command, output: res.output });
    }

    const r = await resolveInstanceId(args.id, args.maxAgeSec);
    if (!r.ok) return fail(r.code, r.error, { candidates: r.candidates });

    // hub 卸载会带走整棵子树 —— 这是最容易造成「整机 USB 全灭」的操作，必须显式 force
    if (args.action === 'remove' && r.row?.device?.kind === 'hub' && args.force !== true) {
      const downstream = flatten(r.tree).filter((row) => String(row.chain ?? '').startsWith(`${r.row.chain}-`));
      return fail(
        'hub-remove-blocked',
        `拒绝卸载 hub ${r.instanceId}：它下面挂着 ${downstream.length} 个设备，卸载会让它们全部消失（且根 hub 可能无法恢复）。` +
          `\n如果确实要这么做，加 force: true。`,
        { instanceId: r.instanceId, downstream: downstream.map((row) => ({ chain: row.chain, name: labelOf(row.device) })) },
      );
    }

    const notes = riskNotes(r.tree, r.row);
    const res = await controlDevice(args.action, r.instanceId, {
      subtree: args.subtree === true,
      force: args.force === true,
      dryRun: args.confirm !== true,
    });

    if (res.dryRun) {
      return ok(
        `[预演] 将${VERB_ZH[args.action]} ${r.instanceId}` +
          (r.row ? `（[${r.row.chain}] ${labelOf(r.row.device)}）` : '') +
          `\n命令行：${res.command}` +
          (res.requiresAdmin ? '\n当前未提权：实跑会弹 UAC 安全桌面窗口，需要有人在机器前点确认。' : '') +
          `\n\n确认无误后加 confirm: true 再调一次。` +
          noteBlock(notes),
        { dryRun: true, instanceId: r.instanceId, command: res.command, requiresAdmin: res.requiresAdmin, notes },
      );
    }

    if (!res.ok) {
      return fail(
        'control-failed',
        `${VERB_ZH[args.action]} ${r.instanceId} 失败：${res.error ?? res.output ?? '未知错误'}` +
          `\n命令行：${res.command ?? '—'}${noteBlock(notes)}`,
        { instanceId: r.instanceId, code: res.code, output: res.output, stderr: res.stderr, elevated: res.elevated },
      );
    }

    return ok(
      `✅ 已${VERB_ZH[args.action]} ${r.instanceId}${r.row ? `（[${r.row.chain}] ${labelOf(r.row.device)}）` : ''}` +
        `${res.output ? `\n\n${String(res.output).trim()}` : ''}${noteBlock(notes)}`,
      { instanceId: r.instanceId, action: args.action, elevated: res.elevated, output: res.output, notes },
    );
  },
});

/* ------------------------------------------------------------------ *
 * usb_help
 * ------------------------------------------------------------------ */

const TOPICS = {
  overview: `USB 工具总览
  usb_env      环境自检：UsbTreeView / pnputil / 管理员 / 报告缓存
  usb_tree     拓扑树（控制器 → 根 hub → 端口 → 设备）
  usb_devices  扁平设备清单，可按 VID/PID/类型/关键词筛
  usb_device   单个设备的完整描述符与连接信息
  usb_report   生成或刷新 UsbTreeView 报告
  usb_eject    安全弹出（CM_Request_Device_Eject）
  usb_control  pnputil 卸载/禁用/启用/重启/重新扫描

数据来源两条：
  - UsbTreeView /R: 报告 —— 描述符、速度、端口链、复合子设备。生成一次约 10 秒 / 1.7 MB，缓存 5 分钟。
  - pnputil —— Windows 侧设备节点、状态、驱动、位置。约 1 秒，但没有描述符细节。

常用起手式：
  usb_env → usb_tree → usb_device id=1-1 → usb_eject id=1-1（先预演、再 confirm）`,

  eject: `弹出 vs 卸载 —— 两者不是一回事
  安全弹出（usb_eject，CM_Request_Device_EjectW）：通知驱动「请求移除」，驱动可以先刷缓存再同意，
      设备驱动通常保留，重新插上就能用。这就是任务栏那个「安全删除硬件」。
  卸载（usb_control action=remove，pnputil /remove-device）：走 DIF_REMOVE，把设备节点从设备树里摘掉、
      卸驱动。U 盘再插上会重新枚举；某些设备会留下「残留节点」，需要 scan 或拔插恢复。

怎么选：
  - U 盘/移动硬盘要拔线 → usb_eject
  - 设备卡死、驱动异常、要它重新枚举 → usb_control action=restart（不行再 remove）
  - 「设备管理器里有个黄色感叹号的幽灵设备」→ usb_control action=remove（不是 eject）

弹出被拒绝时 message 会给出否决者（vetoName），常见的是资源管理器、杀毒软件、
或正在写盘的进程。关掉占用者再试，别直接上 remove-subtree。`,

  driver: `驱动与实例 ID
  实例 ID 形如 USB\\VID_24AE&PID_4077\\6&1C1844B5&0&1，其中：
    6&1C1844B5&0  是端口/父 hub 派生的地址，**换一个 USB 口就会变**；
    1             是端口号。
  所以「按实例 ID 记设备」不可靠。要稳定指代某台设备，用它的**端口链**（1-1、3-1-1-4），
  端口链只跟物理插口有关。

  复合设备（带 MI_00 后缀的实例 ID）：
    一台物理设备会暴露多个 PDO（每个接口一个），例如键盘的「键盘」和「鼠标」两个功能。
    操作 MI_00 这个子节点只影响该功能；操作父节点（不带 MI_）才影响整台设备。
    usb_device 会把这些子设备列在「复合子设备」里。

  hub：根 hub 是控制器的一部分，卸载它会让整条链上的设备全部消失，通常无法自行恢复。
  usb_control 默认拒绝卸载 hub，除非显式 force: true。`,

  permission: `权限与 UAC
  只读操作（usb_env / usb_tree / usb_devices / usb_device / usb_report）不需要管理员。
  卸载、禁用、启用、重启设备需要管理员；安全弹出（CM_Request_Device_Eject）通常不需要。

  本插件在未提权时用 Start-Process -Verb RunAs 提权，Windows 会切到**安全桌面**弹 UAC。
  如果没人坐在机器前点确认，这个窗口会挂在那里直到超时。
  所以：先用 confirm: false 拿到确切命令行，再决定要不要真跑；
  或者把这行命令交给用户在管理员终端里执行。`,

  troubleshoot: `排查清单
  1. usb_tree 里看不到设备
     - 换 showEmpty: true，确认是「端口空」还是「设备没被识别」
     - 端口空 → 供电/线缆/接口问题；端口有设备但没名字 → 描述符没读出来，看 usb_device
  2. 报告是旧的
     - 默认缓存 300 秒。刚插拔过就传 maxAgeSec: 0 强制重新生成
  3. 找不到 UsbTreeView.exe
     - 放到插件 vendor/ 目录，或设 DSH_USB_TREEVIEW，或调用时传 exePath
  4. 设备状态不是 OK
     - pnputil 枚举里 Status 会是 Error / Unknown / Disabled；先 restart，再考虑 remove
  5. 卸载后设备立刻又回来了
     - 说明设备被重新枚举了（正常）。要它彻底不出现，应该 disable 而不是 remove
  6. CJK 乱码
     - pnputil 输出是 GBK，插件内部已按 GBK 解码；自定义 PowerShell 也要设 OutputEncoding 936`,

  tools: `参数速查
  usb_devices  source=report|pnputil  keyword  vid  pid  kind  limit  maxAgeSec
  usb_device   id  maxAgeSec  interfaces  endpoints  children  strings
  usb_eject    id  confirm  mode=eject|remove-subtree
  usb_control  action=remove|disable|enable|restart|scan  id  confirm  subtree  force
  usb_tree     showEmpty  maxAgeSec  exePath
  usb_report   maxAgeSec  exePath

id 的四种写法（所有带 id 的工具都认）：
  1-1            端口链，最稳，跟物理插口绑定
  24ae:4077      VID:PID，认大小写、0x 前缀、冒号和斜杠
  USB\\VID_...   实例 ID 全串或片段
  Rapoo, 蓝牙     关键词，匹配产品名/厂商名/序列号/设备描述`,
};

const helpTool = defineTool({
  name: 'usb_help',
  description:
    'USB 操作剧本与踩坑清单：弹出 vs 卸载的区别、实例 ID 与端口链为什么不同、复合设备与 hub 的风险、UAC 权限怎么绕、常见故障怎么查、全部工具参数速查。' +
    '不确定该用 eject 还是 remove、或者设备状态看不懂时先读它。',
  parameters: {
    topic: {
      type: 'string',
      enum: Object.keys(TOPICS),
      description: 'overview 总览 / eject 弹出与卸载 / driver 实例 ID 与驱动 / permission 权限与 UAC / troubleshoot 排查 / tools 参数速查',
    },
  },
  output,
  timeoutMs: 30000,
  async execute(args) {
    if (!args.topic) {
      return ok(Object.entries(TOPICS).map(([k, v]) => `【${k}】${v.split('\n')[0]}`).join('\n') + '\n\n（传 topic 看某一篇）', {
        topics: Object.keys(TOPICS),
      });
    }
    const body = TOPICS[args.topic];
    return ok(body, { topic: args.topic });
  },
});

/** 注册会改设备状态的工具。 */
export function registerControlTools(ctx) {
  for (const tool of [ejectTool, controlTool, helpTool]) {
    ctx.tools.register(tool);
  }
  return [ejectTool, controlTool, helpTool].map((t) => t.name);
}

export { TOPICS };
