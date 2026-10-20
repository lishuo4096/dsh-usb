/**
 * dsh-usb —— 让 Harness 看见并操作本机 USB 设备。
 *
 * 两条数据源，各司其职：
 *   - UsbTreeView `/R:` 报告：完整描述符、速度、端口链、复合子设备。生成一次 ~10 秒 / 1.7 MB，带 5 分钟缓存。
 *   - pnputil：Windows 侧设备节点、状态、驱动、位置。~1 秒，但没有描述符细节。
 *
 * 能力分两层：
 *   - 只读（tools-enum.js）：环境自检、拓扑树、设备清单、单设备详情、报告生成。不需要管理员。
 *   - 控制（tools-control.js）：安全弹出（CfgMgr32）、卸载/禁用/启用/重启（pnputil）、排错剧本。
 *     全部默认 `confirm: false` 只预演，改设备状态必须显式确认。
 *
 * 注意：本插件是 `link:` 方式装载的，Node 会按**插件真实路径**向上找 node_modules，
 * 而 `@deepseek-ai/*` 只存在于宿主 asar 内 —— 所以这里绝不能 import 任何 `@deepseek-ai/*`，
 * 工具定义用的是包内自带的 `lib/define-tool.js`。
 */

import { registerEnumTools } from './lib/tools-enum.js';
import { registerControlTools } from './lib/tools-control.js';
import { createProvider } from './lib/skills.js';

/** 与 cordis.patch.yml 里 `insert[].id` 必须逐字一致。 */
export const name = 'usb';

export const inject = ['tools', 'skills'];

export function apply(ctx) {
  const registered = [];

  // 分组注册：一组挂了不至于把另一组也带下水
  for (const [label, register] of [
    ['只读', registerEnumTools],
    ['控制', registerControlTools],
  ]) {
    try {
      registered.push(...register(ctx));
    } catch (error) {
      console.error(`[usb] ${label}工具注册失败：${error?.message ?? error}`);
    }
  }

  try {
    ctx.skills.registerProvider((control) => createProvider(control));
  } catch (error) {
    console.error(`[usb] 技能 provider 注册失败：${error?.message ?? error}`);
  }

  console.log(`[usb] 已注册 ${registered.length} 个工具：${registered.join(', ')}`);
}
