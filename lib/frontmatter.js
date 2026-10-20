/**
 * 数据手册 / 技能目录的 YAML frontmatter 解析。
 *
 * 只解析 SKILL.md 顶部 `---` 之间的 `name` 与 `description`（以及
 * `metadata.user-invocable`）。刻意不引第三方 YAML 库：插件要能在
 * 离线环境零依赖安装，而这里需要的子集极小。
 */

/** YAML 块标量指示符：`|` 或 `>`，可带 chomping（-/+）与缩进数字。 */
const BLOCK_SCALAR = /^([|>])[+-]?\d*$/;

/**
 * 读 `key: |`（起始行的上一行）开始的块标量，返回文本与块结束后的行号。
 * 不处理块标量时，`description: |` 会被解析成字面量 "|"，技能就彻底失去路由描述。
 */
function readBlockScalar(lines, start, style) {
  const raw = [];
  let i = start;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      raw.push('');
      continue;
    }
    if (!/^[ \t]/.test(line)) break; // 无缩进 = 块结束（含收尾的 ---）
    raw.push(line);
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const indents = raw.filter((l) => l !== '').map((l) => (l.match(/^[ \t]*/)?.[0] ?? '').length);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  const text = raw.map((l) => (l === '' ? '' : l.slice(indent)));
  if (style === '|') return { value: text.join('\n').trim(), next: i };
  // 折叠标量：单个换行变空格，空行保留为段落分隔。
  const folded = text.map((l, idx) => (l === '' ? '\n' : idx === 0 ? l : ` ${l}`)).join('');
  return { value: folded.replace(/\n{3,}/g, '\n\n').trim(), next: i };
}

/** 解析 frontmatter；没有 frontmatter 时返回空对象与原正文。 */
export function parseFrontmatter(text) {
  // 去 BOM + 统一 CRLF，避免 Windows 检出与编辑器编码差异让分隔符找不到。
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---')) return { fm: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, body: src };
  const fmText = src.slice(3, end);
  const body = src.slice(end + 4);
  const fm = {};
  let metaUserInvocable;
  const lines = fmText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === 'metadata:') {
      let j = i + 1;
      while (j < lines.length && /^\s/.test(lines[j])) {
        const m = lines[j].match(/user-invocable:\s*"?([^"\n]+)"?/);
        if (m) metaUserInvocable = m[1].trim();
        j += 1;
      }
      i = j - 1;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (BLOCK_SCALAR.test(value)) {
      const block = readBlockScalar(lines, i + 1, value[0]);
      fm[key] = block.value;
      i = block.next - 1;
      continue;
    }
    fm[key] = value.replace(/^["']|["']$/g, '');
  }
  if (metaUserInvocable !== undefined) fm['user-invocable'] = metaUserInvocable;
  return { fm, body };
}
