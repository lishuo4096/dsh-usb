/**
 * 工具返回值与渲染的公共约定。
 *
 * ## 约定（所有 `wch_*` 工具一致）
 *
 * 1. 每个工具都返回**纯数据** `{ ok, message, … }`，不抛异常。
 *    普通失败（连不上、文件不存在、目标没插）是**正常结果**，用 `ok:false` + `code`
 *    表达；只有「调用方把参数写错了」才由 `defineTool` 抛 `ToolArgsError`。
 *    这样 agent 拿到的是「可读的失败原因」，而不是一段栈。
 * 2. `message` 是给人看的**完整结论**，自带判据（哪只眼睛看出来的）；
 *    其余字段是结构化的补充，供 agent 二次判断。
 * 3. `output.render` 只把 `message` 变成文本 —— 其余字段仍然在结构化返回值里，
 *    不会因为渲染而丢失。
 *
 * 这套形状沿用本机 `dsh-gowin` 插件的既有约定，便于 agent 在多个硬件插件间迁移直觉。
 *
 * @module lib/result
 */

/** 统一的文本渲染器：只取 `message`。 */
export const textRender = (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }];

/** 统一的 `output` 描述块。 */
export const output = { schema: { type: 'json' }, render: textRender };

/** 成功。 */
export function ok(message, extra = {}) {
  return { ok: true, message, ...extra };
}

/**
 * 失败。
 *
 * `code` 是**稳定标识**（agent 可以据此分支），`message` 是给人看的原因。
 * 不要把动态内容塞进 `code`。
 */
export function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/** 截断列表，并如实说明截掉了多少（不静默丢弃）。 */
export function clip(list, limit = 60, max = 400) {
  const arr = Array.isArray(list) ? list : [];
  const n = Math.max(1, Math.min(Number(limit) || 60, max));
  if (arr.length <= n) return { rows: arr, truncated: 0 };
  return { rows: arr.slice(0, n), truncated: arr.length - n };
}

/** 人类可读的字节数。 */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  if (abs < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (abs < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 人类可读的耗时。 */
export function fmtMs(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

/**
 * 计算字符串的**显示宽度**：CJK / 全角字符占 2 列，其余占 1 列。
 *
 * `String#length` 按 UTF-16 码元数，中文标签（「端口链」=3）和英文标签（「VID:PID」=7）
 * 长度差 4 但对齐要差 8 列 —— 直接用 length 补齐会错行。
 */
export function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || // 韩文字母
      (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 / 标点
      (cp >= 0x3041 && cp <= 0x33ff) || // 假名 / CJK 兼容
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || // 全角
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
      (cp >= 0x1f900 && cp <= 0x1f9ff);
    w += wide ? 2 : 1;
  }
  return w;
}

/** 按显示宽度右补空格（CJK 安全）。 */
export function padDisplay(text, width) {
  const s = String(text);
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

/** 把「标签: 值」拼成对齐的多行文本（按显示宽度对齐，中文标签不会错行）。 */
export function kvBlock(pairs) {
  const rows = pairs.filter((p) => p && p[1] !== undefined && p[1] !== null);
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => displayWidth(r[0])));
  return rows.map((r) => `${padDisplay(r[0], width)} ：${r[1]}`).join('\n');
}

/** 把十六进制字节串按 16 字节一行排版。 */
export function hexDump(bytes, base = 0, width = 16) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += width) {
    const chunk = bytes.slice(i, i + width);
    const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk)
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(`${(base + i).toString(16).padStart(8, '0')}  ${hex.padEnd(width * 3 - 1)}  |${ascii}|`);
  }
  return lines;
}

/** 成功/失败的前缀（报告里一眼能扫出来）。 */
export function stamp(okFlag) {
  return okFlag ? '[ ok ]' : '[FAIL]';
}
