# dsh-usb

给 DeepSeek Harness 的 USB 观察与摘除插件：**看 USB 树、读枚举值（描述符）、判设备类型、安全弹出 / 卸载设备**。

两类数据源，各管一段：

| 数据源 | 负责 | 代价 |
| --- | --- | --- |
| **UsbTreeView** `/R:` 报告 | 描述符原文（设备/配置/接口/HID/端点/字符串）、速度、端口链、hub 拓扑、复合子设备 | 一次约 10 s，落盘缓存 |
| **pnputil** | 快速枚举、设备树、卸载/禁用/重启/重新扫描 | 0.2–1.5 s |

报告解析结果在进程内按「路径 + mtime」复用，所以同一份快照下 `usb_tree` / `usb_device` / `usb_devices` 都是毫秒级。

## 工具

只读（`lib/tools-enum.js`）：

| 工具 | 作用 |
| --- | --- |
| `usb_env` | 自检：UsbTreeView / pnputil 在哪、是否管理员、报告缓存状态 |
| `usb_tree` | USB 树：控制器 → 根 hub → 端口 → 设备 →（嵌套 hub）→ … |
| `usb_devices` | 扁平设备表，可按 `keyword` / `vid` / `pid` / `kind` 过滤；`source:pnputil` 走快速通道 |
| `usb_device` | 单个设备全量详情（描述符、接口、端点、字符串、连接信息、复合子设备） |
| `usb_report` | 生成 / 刷新报告，给路径与统计 |

控制（`lib/tools-control.js`）：

| 工具 | 作用 |
| --- | --- |
| `usb_eject` | 安全弹出（`CM_Request_Device_EjectW`）。`mode:'remove-subtree'` 是强摘整棵子树 |
| `usb_control` | `remove` / `disable` / `enable` / `restart` / `scan`，走 `pnputil` |
| `usb_help` | 剧本与踩坑（`overview` / `eject` / `driver` / `permission` / `troubleshoot` / `tools`） |

### `id` 认四种写法

端口链 `3-1-1-4` 最稳（插拔变了它会变）；`VID:PID` 形如 `24ae:4077`；实例 ID `USB\VID_...\...`；以及产品名关键词。多个命中时**全部列出让你挑**，不猜。

### 控制类默认是预演

`usb_eject` / `usb_control` 都**必须 `confirm: true`** 才真的动手，否则只回「将要执行什么 + 命令行 + 当前权限 + 风险提示」。这是硬约束：卸载用错实例 ID 的代价太大。另外 hub 的 `remove` 在没 `force:true` 时直接拒绝 —— 一拔就是一整串设备。

## 依赖

- **UsbTreeView**（必需，仅描述符功能）：`UsbTreeView /R:<file>` 静默产报告。
  本仓库自带一份 `vendor/UsbTreeView.exe`（V4.7.2.0 x64，**原封未改**），开箱即用。
  查找顺序：工具参数 `exePath` → 环境变量 `DSH_USB_TREEVIEW` → 插件内 `vendor/UsbTreeView.exe` → 桌面默认位置。
  没有它只读类会退化到 pnputil（能枚举、能树，但没有描述符细节）。
- **pnputil**：Windows 自带（`%SystemRoot%\System32\pnputil.exe`）。
- **管理员权限**：只读不需要；`remove`/`disable`/`enable`/`restart` 需要。未提权时会走 `Start-Process -Verb RunAs` 弹 UAC，**会切到安全桌面**，需要有人在机器前点。
- 安全弹出（`usb_eject`）不需要管理员。

## 安装

```js
plugin_manager({ action: 'install_bundle', target: 'C:\\Users\\lishuo\\Documents\\DSH_Project\\插件开发\\dsh-usb' })
```

从 GitHub 装：

```powershell
git clone https://github.com/lishuo4096/dsh-usb.git C:\path\to\dsh-usb
```

```js
plugin_manager({ action: 'install_bundle', target: 'C:\\path\\to\\dsh-usb' })
```

`application: 'applied'` 之后用 `plugin_manager({action:'list_plugins'})` 看 `fiberPhase: 'active'`，再用 `cordis_inspect_query(Tool.listTools)` 确认 8 个 `usb_*` 工具在列。

**改源码不热重载**：`set_plugin` 关掉再开一次。

## 结构

```
index.js              导出 name / inject / apply，不导出 default
lib/exec.js           子进程（永不抛异常）、PowerShell 脚本执行、提权、UTF-8/GBK 解码
lib/pnputil.js        pnputil 调用与文本解析（枚举 / 设备树 / 控制）
lib/report.js         UsbTreeView 报告的解析器（章节 → 块 → 键值 → 结构化设备）
lib/usbtree.js        视图层：加载/缓存报告、拍平、按 id 查设备、渲染
lib/usbcodes.js       USB 类代码表、设备类型推断（来自描述符 + 来自 Windows 两侧）
lib/format.js         单设备详情渲染
lib/eject.js          CfgMgr32 安全弹出（内嵌 C#，Add-Type 加载）
lib/result.js         ok/fail、截断、按显示宽度对齐
lib/define-tool.js    自带的 defineTool（link: 装载拿不到宿主依赖）
lib/skills.js         技能 provider
skills/usb-inspect/   查树 / 描述符 / 类型
skills/usb-remove/    弹出 vs 卸载 vs 禁用
```

## 踩过的坑（都修好了，写在这里免得再犯）

1. **报告的章节缩进不可信** —— 所有 `=====` 章节头都是 4 或 6 空格缩进，和层级无关；章节顺序还是深度优先的。父子关系**只能**用 `Port Chain` 前缀判定（`3-1-1-4-4` 的父是 `3-1-1-4`）。
2. **`CM_DRP_CAPABILITIES` 是 0x10**，不是 0x0F（那是设备对象名字符串属性）。写错会拿到 `CR_BUFFER_SMALL`，能力值恒 0，于是「往上找可移除祖先」永远找不到。
3. **`CAPS` 位表**按 `wdm.h`：`0x02 EJECTSUPPORTED` / `0x04 REMOVABLE` / `0x80 SURPRISEREMOVALOK`。这里错一位就会把不可移除的设备当成可安全弹出。
4. **PowerShell 5.1 的 `Set-Content -Encoding UTF8` 带 BOM**，`JSON.parse` 会炸在 `Unexpected token '\uFEFF'` —— 读回结果要先剥 BOM。
5. **`pnputil /enum-devices /class USB` 会带上 PCI 主机控制器**，那不是外设，要按 `^PCI\` 过滤。
6. **设备的 `Status` 不是「OK」**，是 `0x0180400A (DN_DRIVER_LOADED, DN_STARTED, ...)`；判故障要看 `DN_HAS_PROBLEM`(0x400) 位。
7. **复合设备的类型不能因为「接口数 > 1」就报成「复合设备」** —— 那是没判类型。要逐接口定类型再汇总（键盘 + 鼠标 / 音频 + HID / 摄像头 …）。

## 许可

本仓库自己的代码（`index.js`、`lib/`、`skills/`、`cordis.patch.yml`、`README.md`）以 [MIT](LICENSE) 发布。

`vendor/UsbTreeView.exe` **不是**本仓库的作品，版权归 Uwe Sieber，以 Freeware 分发（见 [THIRD-PARTY.md](THIRD-PARTY.md)）。其条款明确允许「include in software products, including commercial」，所以放进仓库是合规的；但**不允许修改文件**，升级时请整份替换。

`pnputil` 是 Windows 自带组件，不随本仓库分发。

