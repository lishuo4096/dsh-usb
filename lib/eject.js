/**
 * 「安全移除 / 卸载」USB 设备 —— 走 **ConfigMgr（CfgMgr32）** 的官方 API。
 *
 * ## 为什么不直接用 pnputil
 *
 * `pnputil /remove-device` 是**卸载驱动栈**（DIF_REMOVE），要管理员，而且它把设备
 * 从 PnP 里摘掉、需要重新扫描才会回来 —— 语义是「卸载」，不是「安全弹出」。
 * 用户日常说的「卸载 USB 设备」两种都有：
 *
 * | 想干的事 | 正确 API | 要管理员 |
 * |---|---|---|
 * | 安全弹出（等价"删除硬件"托盘图标） | `CM_Request_Device_EjectW` | 通常不要 |
 * | 强制摘除整棵子树 | `CM_Query_And_Remove_SubTreeW` | 要 |
 * | 卸载设备节点 + 删驱动 | `pnputil /remove-device` | 要 |
 *
 * 所以这里实现前两个，第三个在 `pnputil.js` 的 `controlDevice()` 里。
 *
 * ## 棘手的点：要 eject 哪个 devnode
 *
 * 一个 USB 键盘在设备树里是一串节点：
 * `USB\VID_24AE&PID_4077\6&...`（USB 设备节点）
 *   → `HID\VID_24AE&PID_4077&MI_00\...`（接口）
 *     → `HID_DEVICE_SYSTEM_KEYBOARD\...`（功能）
 *
 * 用户给的多半是**最上层的 VID_/PID_ 节点**，但也有 agent 会把 `HID\...` 子节点
 * 的实例 ID 传进来。对子节点调 eject 一般会 `CR_NO_SUCH_DEVNODE` 或直接被拒。
 * 所以 `probeRemovalTarget()` 会从给定节点**向上爬**，找到第一个声明了
 * `CM_DEVCAP_REMOVABLE / EJECTSUPPORTED / SURPRISEREMOVALOK` 的祖先 —— 那才是
 * 真正该被弹出的节点。这条逻辑是 devcon 的 `RemoveTarget` 做的事，这里只读版地重做了一遍。
 *
 * @module dsh-usb/lib/eject
 */

import { runPs } from './exec.js';

/** CfgMgr32 `CM_DEVCAP_*` 能力位 → 人类可读标签（**按 wdm.h 的定义**，别凭印象排）。 */
const CAPS = [
  [0x00000001, 'LOCKSUPPORTED'],
  [0x00000002, 'EJECTSUPPORTED'],
  [0x00000004, 'REMOVABLE'],
  [0x00000008, 'DOCKDEVICE'],
  [0x00000010, 'UNIQUEID'],
  [0x00000020, 'SILENTINSTALL'],
  [0x00000040, 'RAWDEVICEOK'],
  [0x00000080, 'SURPRISEREMOVALOK'],
  [0x00000100, 'HARDWAREDISABLED'],
  [0x00000200, 'NONDYNAMIC'],
];

/** `CM_Query_And_Remove_SubTree` 的否决类型。 */
const VETO = {
  0: '无关决',
  1: '遗留设备（无驱动）',
  2: '有待关闭的句柄',
  3: 'Windows 应用（有未保存数据）',
  4: '有未关闭的文件句柄',
  5: '设备本身拒绝',
  6: '驱动拒绝',
  7: '非法的设备请求',
  8: '电源不足',
  9: '权限不足（需要管理员）',
};

/** 把 `0x0180400A` 这样的能力值拆成标签数组。 */
export function describeCapabilities(value) {
  const raw = Number(value) >>> 0;
  return CAPS.filter(([bit]) => (raw & bit) !== 0).map(([, name]) => name);
}

/**
 * 嵌入的 C#。写成常量而不是塞进 ps1 正文里，是为了：
 *   1. `Add-Type` 只依赖我们传进去的字符串，不受 ps1 编码影响；
 *   2. 这段代码要能被单元测试直接读到（以后要加更多 API 也在这里加）。
 */
const CS_DECL = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class UsbDevNode
{
    public string InstanceId;
    public string DeviceId;
    public uint   DevInst;
    public int    LocateStatus;
    public uint   Capabilities;
    public uint   Status;
    public uint   Problem;
    public bool   Removable;
    public bool   EjectSupported;
    public bool   SurpriseRemovalOk;
    public bool   HardwareDisabled;
    public string VetoName;
    public int    VetoType;
    public int    Cr;
    public string CrText;
    public int    Depth;
}

public static class UsbDev
{
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    static extern int CM_Locate_DevNodeW(out uint pdnDevInst, string pDeviceID, uint ulFlags);

    [DllImport("cfgmgr32.dll", SetLastError = false)]
    static extern int CM_Get_Parent(out uint pdnDevInst, uint dnDevInst, uint ulFlags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    static extern int CM_Get_Device_IDW(uint dnDevInst, StringBuilder Buffer, int BufferLen, uint ulFlags);

    [DllImport("cfgmgr32.dll", SetLastError = false)]
    static extern int CM_Get_DevNode_Status(out uint pulStatus, out uint pulProblemNumber, uint dnDevInst, uint ulFlags);

    [DllImport("cfgmgr32.dll", SetLastError = false)]
    static extern int CM_Get_DevNode_Registry_PropertyW(
        uint dnDevInst, uint ulProperty, out uint pulRegDataType, IntPtr buffer, ref int pulLength, uint ulFlags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    static extern int CM_Request_Device_EjectW(
        uint dnDevInst, out int pVetoType, StringBuilder pszVetoName, int ulNameLength, uint ulFlags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    static extern int CM_Query_And_Remove_SubTreeW(
        uint dnDevInst, out int pVetoType, StringBuilder pszVetoName, int ulNameLength, uint ulFlags);

    // ⚠️ CM_DRP_CAPABILITIES 是 **0x10**。0x0F 是 CM_DRP_PHYSICAL_DEVICE_OBJECT_NAME（字符串），
    // 拿 4 字节缓冲去读它只会返回 CR_BUFFER_SMALL，于是"能力值永远是 0"、
    // 向上找可移除祖先永远找不到 —— 这个错值曾经把 eject 的探测逻辑整个废掉。
    const uint CM_DRP_CAPABILITIES = 0x00000010;
    const int  CM_REMOVE_UI_OK     = 0x00000000;
    const int  MAX_UP              = 8;

    public static string CrText(int cr)
    {
        // 数值按 cfgmgr32.h 的 CR_* 常量（不是按"看着顺眼"排的 —— 早前那版把
        // CR_INVALID_DEVNODE 写成 3，实际是 5，错误码全串位）。
        switch (cr)
        {
            case 0x00: return "CR_SUCCESS";
            case 0x02: return "CR_OUT_OF_MEMORY";
            case 0x03: return "CR_INVALID_POINTER";
            case 0x04: return "CR_INVALID_FLAG";
            case 0x05: return "CR_INVALID_DEVNODE";
            case 0x0D: return "CR_NO_SUCH_DEVNODE";
            case 0x10: return "CR_ALREADY_SUCH_DEVNODE";
            case 0x17: return "CR_REMOVE_VETOED";
            case 0x1A: return "CR_BUFFER_SMALL";
            case 0x1C: return "CR_NO_REGISTRY_HANDLE";
            case 0x1D: return "CR_REGISTRY_ERROR";
            case 0x1E: return "CR_INVALID_DEVICE_ID";
            case 0x1F: return "CR_INVALID_DATA";
            case 0x20: return "CR_INVALID_API";
            case 0x21: return "CR_DEVLOADER_NOT_READY";
            case 0x22: return "CR_NEED_RESTART";
            case 0x24: return "CR_DEVICE_NOT_THERE";
            case 0x25: return "CR_NO_SUCH_VALUE";
            case 0x26: return "CR_WRONG_TYPE";
            case 0x28: return "CR_NOT_DISABLEABLE";
            case 0x2A: return "CR_QUERY_VETOED";
            case 0x2B: return "CR_CANT_SHARE_IRQ";
            case 0x2C: return "CR_NO_DEPENDENT";
            case 0x2D: return "CR_SAME_RESOURCES";
            case 0x2E: return "CR_NO_SUCH_REGISTRY_KEY";
            case 0x30: return "CR_REMOTE_COMM_FAILURE";
            case 0x31: return "CR_MACHINE_UNAVAILABLE";
            case 0x33: return "CR_ACCESS_DENIED";
            case 0x34: return "CR_CALL_NOT_IMPLEMENTED";
            case 0x35: return "CR_INVALID_PROPERTY";
            default:   return "CR_FAILED_0x" + cr.ToString("X8");
        }
    }

    static uint ReadCapabilities(uint devInst)
    {
        int len = 4;
        IntPtr buf = Marshal.AllocHGlobal(4);
        try
        {
            uint regType;
            int cr = CM_Get_DevNode_Registry_PropertyW(devInst, CM_DRP_CAPABILITIES, out regType, buf, ref len, 0);
            if (cr != 0) return 0;
            return (uint)Marshal.ReadInt32(buf);
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    static string ReadDeviceId(uint devInst)
    {
        var sb = new StringBuilder(512);
        int cr = CM_Get_Device_IDW(devInst, sb, sb.Capacity, 0);
        return cr == 0 ? sb.ToString() : null;
    }

    /// <summary>定位实例 ID 对应的 devnode 并读能力/状态（不写任何东西）。</summary>
    public static UsbDevNode Probe(string instanceId)
    {
        var o = new UsbDevNode { InstanceId = instanceId };
        uint devInst;
        o.LocateStatus = CM_Locate_DevNodeW(out devInst, instanceId, 0);
        o.Cr = o.LocateStatus;
        o.CrText = CrText(o.LocateStatus);
        if (o.LocateStatus != 0) return o;

        o.DevInst = devInst;
        o.DeviceId = ReadDeviceId(devInst);
        o.Capabilities = ReadCapabilities(devInst);
        o.Removable      = (o.Capabilities & 0x00000004u) != 0;
        o.EjectSupported = (o.Capabilities & 0x00000002u) != 0;
        o.SurpriseRemovalOk = (o.Capabilities & 0x00000080u) != 0;
        o.HardwareDisabled  = (o.Capabilities & 0x00000100u) != 0;

        uint status, problem;
        if (CM_Get_DevNode_Status(out status, out problem, devInst, 0) == 0)
        {
            o.Status = status;
            o.Problem = problem;
        }
        return o;
    }

    /// <summary>
    /// 从给定节点向上找「真正该弹的节点」：第一个带 REMOVABLE / EJECTSUPPORTED /
    /// SURPRISEREMOVALOK 的祖先；自己就是就返回自己。最多爬 8 层。
    /// </summary>
    public static UsbDevNode FindRemovalTarget(string instanceId)
    {
        var start = Probe(instanceId);
        if (start.Cr != 0) return start;

        uint cur = start.DevInst;
        var chain = new List<string>();
        for (int depth = 0; depth < MAX_UP; depth++)
        {
            string id = ReadDeviceId(cur);
            chain.Add(id);
            uint caps = ReadCapabilities(cur);
            bool ok = (caps & 0x00000004u) != 0 || (caps & 0x00000002u) != 0 || (caps & 0x00000080u) != 0;
            if (ok)
            {
                var o = new UsbDevNode
                {
                    InstanceId = id,
                    DeviceId = id,
                    DevInst = cur,
                    Capabilities = caps,
                    Removable = (caps & 0x00000004u) != 0,
                    EjectSupported = (caps & 0x00000002u) != 0,
                    SurpriseRemovalOk = (caps & 0x00000080u) != 0,
                    HardwareDisabled = (caps & 0x00000100u) != 0,
                    Depth = depth,
                    Cr = 0,
                    CrText = "CR_SUCCESS",
                };
                uint status, problem;
                if (CM_Get_DevNode_Status(out status, out problem, cur, 0) == 0)
                {
                    o.Status = status;
                    o.Problem = problem;
                }
                return o;
            }
            uint parent;
            if (CM_Get_Parent(out parent, cur, 0) != 0) break;
            cur = parent;
        }
        // 爬到顶都没找到一个"可移除"的祖先：把起点原样返回，让上层提示原因
        start.Depth = chain.Count;
        return start;
    }

    /// <summary>IRP_MN_EJECT：等价的"安全删除硬件"。</summary>
    public static UsbDevNode Eject(uint devInst)
    {
        int vetoType = 0;
        var vetoName = new StringBuilder(260);
        int cr = CM_Request_Device_EjectW(devInst, out vetoType, vetoName, vetoName.Capacity, 0);
        return new UsbDevNode
        {
            DevInst = devInst,
            Cr = cr,
            CrText = CrText(cr),
            VetoType = vetoType,
            VetoName = vetoName.ToString(),
        };
    }

    /// <summary>强制摘除整棵子树（要管理员，且用户会丢未保存数据）。</summary>
    public static UsbDevNode RemoveSubTree(uint devInst)
    {
        int vetoType = 0;
        var vetoName = new StringBuilder(260);
        int cr = CM_Query_And_Remove_SubTreeW(devInst, out vetoType, vetoName, vetoName.Capacity, CM_REMOVE_UI_OK);
        return new UsbDevNode
        {
            DevInst = devInst,
            Cr = cr,
            CrText = CrText(cr),
            VetoType = vetoType,
            VetoName = vetoName.ToString(),
        };
    }
}
`;

/**
 * 只读探测：这个实例 ID 能不能弹、该弹哪个节点。
 *
 * @param {string} instanceId
 * @returns {Promise<{ok:boolean, target?:any, capabilities?:string[], error?:string, code?:string}>}
 */
export async function probeRemovalTarget(instanceId) {
  if (!instanceId) return { ok: false, code: 'no-instance-id', error: '缺少实例 ID' };

  const res = await runPs(
    [
      `$cs = @'`,
      CS_DECL,
      `'@`,
      `if (-not ('UsbDev' -as [type])) { Add-Type -TypeDefinition $cs -Language CSharp }`,
      `$node = [UsbDev]::FindRemovalTarget([string]$P.instanceId)`,
      `$Result.target = [ordered]@{`,
      `  instanceId = $node.InstanceId`,
      `  requested  = [string]$P.instanceId`,
      `  devInst    = $node.DevInst`,
      `  capabilities = $node.Capabilities`,
      `  removable = $node.Removable`,
      `  ejectSupported = $node.EjectSupported`,
      `  surpriseRemovalOk = $node.SurpriseRemovalOk`,
      `  hardwareDisabled = $node.HardwareDisabled`,
      `  status = $node.Status`,
      `  problem = $node.Problem`,
      `  depth = $node.Depth`,
      `  cr = $node.Cr`,
      `  crText = $node.CrText`,
      `}`,
    ].join('\r\n'),
    { params: { instanceId }, timeoutMs: 60_000 },
  );

  if (!res.ok) {
    return {
      ok: false,
      code: res.value?.ok === false ? 'probe-failed' : 'powershell-failed',
      error: res.value?.error ?? res.error ?? 'PowerShell 调用失败',
    };
  }
  const target = res.value.target;
  return { ok: true, target, capabilities: describeCapabilities(target.capabilities) };
}

/**
 * 弹出（安全移除）或强制摘除。
 *
 * `dryRun: true` 时**只探测不执行** —— 这是工具层的默认行为：卸载设备是不可撤销的
 * 有副作用的操作，必须先让调用方明确 `confirm: true`。
 *
 * @param {string} instanceId
 * @param {{dryRun?:boolean, mode?:'eject'|'remove-subtree', timeoutMs?:number}} [opts]
 */
export async function ejectDevice(instanceId, opts = {}) {
  const { dryRun = true, mode = 'eject', timeoutMs = 60_000 } = opts;

  const probe = await probeRemovalTarget(instanceId);
  if (!probe.ok) return probe;

  const target = probe.target;
  const basis = {
    requested: instanceId,
    ejectTarget: target.instanceId,
    climbedLevels: target.depth,
    capabilities: probe.capabilities,
  };

  if (target.cr !== 0) {
    return {
      ok: false,
      code: 'devnode-not-found',
      error: `找不到设备节点（${target.crText}）：${instanceId}`,
      ...basis,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      ...basis,
      message:
        `[预演] 将 ${mode === 'eject' ? '安全弹出' : '强制摘除'} ${target.instanceId}` +
        (target.depth ? `（从你给的节点向上爬了 ${target.depth} 层）` : '') +
        `；能力：${probe.capabilities.join(', ') || '（无）'}`,
    };
  }

  const method = mode === 'remove-subtree' ? 'RemoveSubTree' : 'Eject';
  const res = await runPs(
    [
      `$cs = @'`,
      CS_DECL,
      `'@`,
      `if (-not ('UsbDev' -as [type])) { Add-Type -TypeDefinition $cs -Language CSharp }`,
      `$r = [UsbDev]::${method}([uint32]$P.devInst)`,
      `$Result.target = [string]$P.targetId`,
      `$Result.cr = $r.Cr`,
      `$Result.crText = $r.CrText`,
      `$Result.vetoType = $r.VetoType`,
      `$Result.vetoName = $r.VetoName`,
    ].join('\r\n'),
    { params: { devInst: target.devInst, targetId: target.instanceId }, timeoutMs },
  );

  if (!res.ok) {
    return {
      ok: false,
      code: res.value?.ok === false ? 'eject-failed' : 'powershell-failed',
      error: res.value?.error ?? res.error ?? 'PowerShell 调用失败',
      ...basis,
    };
  }

  const { cr, crText, vetoType, vetoName } = res.value;
  const succeeded = cr === 0;
  return {
    ok: succeeded,
    code: succeeded ? undefined : 'ejected-vetoed',
    error: succeeded
      ? undefined
      : `${crText}${vetoName ? `，被「${vetoName}」否决` : ''}` +
        (VETO[Number(vetoType)] ? `（${VETO[Number(vetoType)]}）` : ''),
    ...basis,
    cr,
    crText,
    vetoType,
    vetoName,
    message: succeeded
      ? `已${mode === 'eject' ? '安全弹出' : '强制摘除'} ${target.instanceId}`
      : `${crText}${vetoName ? `：${vetoName}` : ''}`,
  };
}

export { VETO, CAPS };
