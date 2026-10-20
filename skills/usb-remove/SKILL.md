---
name: usb-remove
description: 弹出、卸载、禁用、启用或重启本机 USB 设备。当用户说「安全弹出这个 U 盘」「把这个设备卸载掉」「设备卡死了帮我重启它」「让这个 USB 设备从设备管理器里消失」时使用。配套工具 usb_eject / usb_control / usb_help。
---

# 弹出 / 卸载 / 禁用 USB 设备

## 先分清三件事

| 用户想要 | 动作 | 工具 | 需要管理员 |
| --- | --- | --- | --- |
| 拔线前让系统放行 | **安全弹出**（CM_Request_Device_Eject） | `usb_eject` | 通常不需要 |
| 让设备重新枚举 | **重启设备**（pnputil /restart-device） | `usb_control action="restart"` | 需要 |
| 设备节点从树里消失 | **卸载**（pnputil /remove-device，DIF_REMOVE） | `usb_control action="remove"` | 需要 |
| 让它别再出现 | **禁用**（pnputil /disable-device） | `usb_control action="disable"` | 需要 |

「卸载后又马上回来」是正常的——设备被重新枚举了。真要它不工作，用 `disable`。

## 固定流程（不许跳步）

1. **定位**：`usb_device id=<端口链或实例 ID>`，确认这是一台设备而不是 hub。
2. **预演**：`usb_eject id=...`（或 `usb_control ...`），**不传 confirm**。工具会回显目标节点、能力位、要执行的命令行、风险提示。
3. **把风险讲给用户**：预演结果里的「注意」段必须转述，尤其是「这是唯一输入设备」「这是 hub，下面挂着 N 个设备」。
4. **确认后执行**：同一个 id 加 `confirm: true`。

没拿到用户明确同意前，不要自己加 `confirm: true`。

## 风险清单（预演时工具会自动提示）

- **hub**：卸载会带走整棵下游子树；根 hub 摘掉后可能无法自行恢复。`usb_control` 默认**拒绝**卸载 hub，除非显式 `force: true`。
- **唯一键鼠**：卸载或禁用后这台机器就没有输入设备了，只能靠重新插拔恢复。必须先确认有别的输入手段。
- **复合设备**：一台物理设备有多个子功能（`MI_00` 之类）。操作子节点只影响该功能，操作父节点影响整机。
- **存储设备正在写**：安全弹出会被驱动拒绝（`vetoName` 指出是谁在占用），关掉占用进程再试，**不要**立刻改用 `remove-subtree`。

## 权限：UAC 会弹在安全桌面

未提权时插件用 `Start-Process -Verb RunAs` 提权，Windows 会切到安全桌面弹 UAC。**如果没人在机器前点确认，这个窗口会一直挂着直到超时（工具会报 `elevation-timeout`）**。

所以：
- 先用 `confirm: false` 拿到确切命令行；
- 或者把命令行交给用户在管理员终端里自己跑；
- 别连着调两次真执行——第一次的 UAC 可能还没被点掉。

安全弹出（`usb_eject`）走 CfgMgr32，通常不需要管理员。

## 排错

- `devnode-not-found`：实例 ID 不对或设备已经不在了。重新 `usb_devices` 拿最新实例 ID。
- `ejected-vetoed`：驱动/应用否决。看 `vetoName`。
- `control-failed` + `CR_ACCESS_DENIED`：没提权。
- `hub-remove-blocked`：这是保护，不是故障。确实要摘 hub 才加 `force: true`，并再向用户确认一次。

更细的剧本（弹出 vs 卸载的机制差异、实例 ID 为什么换口就变）在 `usb_help` 里：`usb_help topic="eject"` / `topic="driver"` / `topic="permission"`。
