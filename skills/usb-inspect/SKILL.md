---
name: usb-inspect
description: 查本机 USB 树、设备描述符与设备类型。当用户问「电脑上插了哪些 USB 设备」「这个设备的 VID/PID/速度/端点是什么」「为什么这个 USB 口不认设备」「哪个口插的是键盘」时使用。配套工具 usb_env / usb_tree / usb_devices / usb_device / usb_report。
---

# 查本机 USB 设备

## 起手式

1. `usb_env` —— 确认 UsbTreeView 与 pnputil 都在、当前是不是管理员。缺工具它会给出补法。
2. 按问题选一个：
   - 要**拓扑**（哪个口挂了什么、hub 级联）→ `usb_tree`
   - 要**列表**（按 VID/PID、类型、关键词筛）→ `usb_devices`
   - 要**某个设备的细节**（描述符、端点、字符串）→ `usb_device`

不要一上来就 `usb_device`：它的 `id` 需要先知道。先 `usb_tree` 或 `usb_devices` 拿到端口链/VID:PID。

## id 的四种写法

| 写法 | 例 | 稳定性 |
| --- | --- | --- |
| 端口链 | `1-1`、`3-1-1-4` | 最稳，绑物理插口 |
| VID:PID | `24ae:4077` | 同型号设备会撞（多个同款接收器） |
| 实例 ID | `USB\VID_24AE&PID_4077\6&1C1844B5&0&1` | **换口就变**，别用来记设备 |
| 关键词 | `Rapoo`、`蓝牙` | 方便但容易多命中 |

命中多个时工具会列候选并报 `ambiguous`，不会替你猜。改成端口链再来。

## 数据源与节奏

- `usb_tree` / `usb_devices` / `usb_device` 都读 UsbTreeView 报告：**首次约 10 秒**，之后 5 分钟走缓存。
- 刚插拔过设备、或怀疑看到的是旧状态 → 传 `maxAgeSec: 0` 强制重新生成。
- 只想快速看一眼 Windows 侧有哪些设备 → `usb_devices source="pnputil"`，约 1 秒，但没有描述符细节。
- `usb_report` 是「我要刷新并拿到报告文件路径」，一般不用它开头。

## 读结果时注意

- **速度**：`Low` / `Full` / `High` / `Super`。键盘接收器常见 Low-Speed，别当成故障。
- **复合设备**：`children` 数量大（蓝牙接收器实测 187 个子设备）表示这台物理设备会枚举成很多子节点。`usb_device` 默认只列前 10 个，用 `children` 参数放宽。
- **类型判定**（`kind` / `kindZh`）来自两处证据：设备/接口描述符里的 class，或 Windows 侧的服务名与类名。结果里带 `evidence`，别把推断当手册。
- 报告里的 `Admin Privileges: no` 只代表生成报告那一刻的权限，不影响只读查询。

## 常见问答映射

- 「插了哪些设备」→ `usb_devices`（默认 report 源，含厂商与产品名）
- 「某个口上是啥」→ `usb_tree`，看端口链
- 「这个 U 盘是 USB 2 还是 3」→ `usb_device id=<VID:PID>`，看 `速度` 与 `bcdUSB`
- 「为什么设备插上没反应」→ `usb_tree showEmpty=true`：端口空 = 供电/线缆/接口问题；端口有设备但名字是 `(未命名设备)` = 描述符没读出来
- 「设备的 VID/PID」→ `usb_devices vid=xxxx pid=yyyy` 或 `usb_device`
