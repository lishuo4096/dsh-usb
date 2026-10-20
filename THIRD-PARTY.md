# 第三方组件与许可

本仓库自己的代码与文档（`index.js`、`lib/`、`skills/`、`cordis.patch.yml`、`README.md`、`package.json`、`.gitignore`）以 [MIT](LICENSE) 发布。

下列内容**不是**本仓库的作品，按各自上游许可分发，不适用 MIT。

---

## `vendor/UsbTreeView.exe`

| 项 | 值 |
| --- | --- |
| 名称 | USB Device Tree Viewer (UsbTreeView) |
| 版本 | 4.7.2.0 (x64) |
| 作者 | Uwe Sieber |
| 上游 | <https://www.uwe-sieber.de/usbtreeview_e.html> |
| 下载 | <https://www.uwe-sieber.de/files/UsbTreeView_x64.zip> |
| 许可 | Freeware（自有条款，非 OSI 许可） |

上游许可原文（<https://www.uwe-sieber.de/usbtreeview_e.html> 的 "Conditions and Download" 一节）：

> UsbTreeView is Freeware.
>
> Allowed:
> - usage in any environment, including commercial
> - include in software products, including commercial
> - include on CD/DVD of computer magazines
> - distribution by means of packet managers
>
> Not allowed:
> - modify any of the files
> - offer for download by means of a "downloader" software

### 本仓库如何使用它

- 以**未修改**的原件随插件分发（"include in software products" 明确允许）。
- 只在插件运行时以 `UsbTreeView /R:<文件>` 方式调用它生成一份 XML/文本报告，然后由 `lib/report.js` 解析该报告。
- 不修改其任何文件。升级时**整份替换** `vendor/UsbTreeView.exe`，不要打补丁。
- 运行后它可能在同一目录生成 `UsbTreeView.ini`（自身配置），该文件已加入 `.gitignore`。

### 授权链说明

UsbTreeView 基于 Microsoft 的 USBView 示例代码（Windows Driver Development Kits）演进而来。随附的二进制是 Uwe Sieber 的发行版，本仓库不对其来源做任何改动或再许可。

---

## Windows 自带组件（不随仓库分发）

- `pnputil.exe`（`%SystemRoot%\System32\pnputil.exe`）—— 枚举、装载/卸载、启用/禁用、重启 PnP 设备。
- `cfgmgr32.dll`（`CM_Request_Device_EjectW` / `CM_Query_And_Remove_SubTreeW` / `CM_Get_DevNode_Registry_PropertyW`）—— 安全弹出与移除能力查询，经内嵌 C# 以 P/Invoke 调用。
