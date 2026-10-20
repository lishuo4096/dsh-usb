/**
 * `defineTool` 的本地实现 —— 让插件**不依赖任何 `@deepseek-ai/*` 包**。
 *
 * 为什么要自己实现：本插件以 `link:` 方式装进 profile 时，Node 会按插件目录的
 * **真实路径**向上找 `node_modules`，而 `@deepseek-ai/dsh-tools` 只存在于宿主
 * 自己的模块图里（Desktop 下它在 app.asar 内，磁盘上没有）——
 * 于是 `import { defineTool } from '@deepseek-ai/dsh-tools'` 会以
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'` 失败，
 * 整行插件 `failed to import`。实测：安装后 `dsh: warning: 1 entry did not activate /
 * enet-review (@local/dsh-enet-review): failed to import`。
 *
 * 宿主侧真正的机制在 `dsh-tools` 的 `defineTool`（lib/index.js:838）：
 * 它把作者侧 DSL 编译成原始 JSON Schema、给 `execute` 包一层参数校验、
 * 并把可选钩子原样透传。这里做等价的事，只依赖内置能力。
 *
 * 作者侧 DSL 兼容（`lib/tools.js` 就在用）：
 *   - 标量简写：`{ type: 'string', description, required, enum, default }`
 *   - `type: 'json'` → 一个 **开放/无约束** schema（`{}`，只保留 `description`），
 *     等价于 `assertSupportedJsonSchema` 接受的空对象；`validateJsonSchemaValue`
 *     对空 schema 恒通过，所以「只返回被声明的 JSON 值」这一约束不被削弱。
 *   - 复合：`{ type: 'object', properties: {...} }` / `{ type: 'array', items: {...} }` /
 *     `{ oneOf: [...] }` —— 直接递归编译。
 *   - 已是原始 JSON Schema（含 `additionalProperties` / `oneOf` 等）的节点原样保留。
 *
 * ## 事故记录：`parameters` 写成原始 JSON Schema 形状时 `type:'json'` 会漏出去
 *
 * 症状：插件一装上，**每一轮对话**都直接失败，且跟调用什么工具无关：
 *
 *     Invalid schema for function 'mcu_regs': "json" is not valid under any of
 *     the schemas listed in the 'anyOf' keyword
 *
 * 原因在 `defineTool`：`parameters` 有两种写法 —— 扁平 DSL（键即参数名）和
 * 原始 JSON Schema（`{ type: 'object', properties: {...} }`）。后者以前被 `{...spec}`
 * **原样透传**，于是 `properties.set = { type: 'json' }` 这个作者侧标记既没被编译成
 * `{}`，也没被拦下，字面量 `{"type":"json"}` 直接进了 function schema。provider 校验
 * function 的 JSON Schema 时对 `type` 只认 `anyOf[array,boolean,integer,null,number,
 * object,string]`，一处非法 → **整份工具列表被拒** → 之后每次请求都失败。
 *
 * 现在两根保险：
 *   1. `compileNode` 对 `properties` / `items` 无条件递归（不再看有没有显式 `type`），
 *      所以两种写法走的是同一条编译路径，`type:'json'` 一律变成 `{}`；
 *   2. `sanitizeSchema` 在注册前对整棵树做最后清洗，任何非法 `type`（拼错、照抄
 *      别的 DSL）都会被摘掉而不是漏出去 —— 这类错误必须是「插件没效果」，绝不能是
 *      「所有对话全挂」。
 */

/** 不需要额外关键字的简单类型。 */
const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/**
 * provider 侧允许的 JSON Schema `type` 取值。
 *
 * **这就是那次「所有对话都报错」的判据**：provider 把 `type` 约束成一个
 * `anyOf[array, boolean, integer, null, number, object, string]`，不在集合里的
 * 字符串（比如作者侧 DSL 的 `'json'`）会让**整份 function 列表**校验失败。
 */
export const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']);

/**
 * provider 侧允许的 JSON Schema **关键字**白名单（来自 `@deepseek-ai/dsh-tools`
 * 的 `assertSupportedJsonSchema` 子集）。
 *
 * 用 harness 自己的校验器实测确认：
 *   - `anyOf` / `allOf` / `format` / `pattern` / `minimum` … → `is not a supported keyword`
 *   - `oneOf` 只有一支 → `must be an array of at least two schemas`
 * 也就是说「作者写了个标准 JSON Schema 关键字」并不等于「provider 收得下」。
 */
export const SUPPORTED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
]);

/** 纯注解关键字：有它们没有约束也算合法 schema（"unconstrained JSON" 的官方写法）。 */
export const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);

/** 已编译过的节点（原始 JSON Schema 特征）：带这些键就认为不必再编译。 */
const RAW_HINTS = ['additionalProperties', 'oneOf', 'anyOf', 'allOf', 'enum', 'const'];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 节点里可保留的 `description`（编译成开放 schema 时不至于把说明也丢掉）。 */
function descOf(node) {
  return node.description !== undefined ? { description: node.description } : {};
}

/**
 * 把一个作者侧节点编译成原始 JSON Schema。
 *
 * @param node 作者侧节点，或已是原始 schema 的节点
 * @returns 原始 JSON Schema 节点
 */
export function compileNode(node) {
  if (node === undefined || node === null) return {};       // 无约束
  if (node === true || node === false) return {};           // JSON Schema 布尔根：放开
  if (!isPlainObject(node)) return {};

  const desc = descOf(node);

  // 显式 type:'json' = 任意 JSON 值 = 开放 schema（只留 description）
  if (node.type === 'json') return { ...desc };

  // type 是个不认识的字符串（拼错、从别的 DSL 抄来的）：退化成开放 schema。
  // **绝不能把非法类型名漏给 provider** —— 见文件头的事故记录。
  if (typeof node.type === 'string' && !SCHEMA_TYPES.has(node.type)) return { ...desc };

  // object / array：有 properties / items 就**无条件**递归编译，不看有没有显式 type。
  // `parameters` 写成 `{ type:'object', properties:{...} }` 时走的就是这条路径 ——
  // 以前这条路径被 `{...spec}` 直接跳过了，才让 `type:'json'` 溜进 function schema。
  if (node.type === 'object' || isPlainObject(node.properties)) return compileObject(node, desc);
  if (node.type === 'array' || isPlainObject(node.items) || Array.isArray(node.items)) {
    return compileArray(node, desc);
  }

  if (Array.isArray(node.oneOf)) {
    if (node.oneOf.length === 1) return compileNode(node.oneOf[0]);
    return { oneOf: node.oneOf.map(compileNode), ...desc };
  }

  if (PRIMITIVES.has(node.type)) {
    const out = { type: node.type, ...desc };
    if (Array.isArray(node.enum)) out.enum = [...node.enum];
    if (node.default !== undefined) out.default = node.default;
    return out;
  }

  // 已含注解/复合关键字又没声明类型的 —— 原样保留剩余关键字，总比丢信息好
  return stripIllegal({ ...node });
}

/** 对象节点：编译 `properties`，并收集子节点里的 `required: true`。 */
function compileObject(node, desc) {
  const out = { type: 'object', ...desc };
  const props = isPlainObject(node.properties) ? node.properties : {};
  const compiled = {};
  const required = [];
  for (const [key, child] of Object.entries(props)) {
    compiled[key] = compileNode(child);
    if (isPlainObject(child) && child.required === true) required.push(key);
  }
  out.properties = compiled;
  if (node.additionalProperties !== undefined) out.additionalProperties = node.additionalProperties;
  if (Array.isArray(node.required)) {
    out.required = [...new Set([...node.required, ...required])];
  } else if (required.length) {
    out.required = required;
  }
  return out;
}

/** 数组节点：编译 `items`（元组写法 `items: [...]` 时逐个编译）。 */
function compileArray(node, desc) {
  const out = { type: 'array', ...desc };
  out.items = Array.isArray(node.items) ? node.items.map(compileNode) : compileNode(node.items);
  if (node.minItems !== undefined) out.minItems = node.minItems;
  if (node.maxItems !== undefined) out.maxItems = node.maxItems;
  return out;
}

/**
 * 注册前的最后一道清洗：整棵树深度遍历，把**provider 收不下的东西**全部摘掉。
 *
 * 摘三类（判据来自 `assertSupportedJsonSchema`，已用 harness 自己的校验器实测）：
 *   1. 非法 `type`（`'json'`、拼错、抄错 DSL）；
 *   2. 子集外的关键字（`anyOf` / `allOf` / `format` / `pattern` / `minimum` …）；
 *   3. 退化形态 —— 少于两支的 `oneOf`（子集要求至少两支）、非数组 `required`、
 *      非非空数组的 `enum`。
 *
 * 摘掉而不是报错，是因为这类问题**必须表现为「插件效果打折」，绝不能是「所有对话全挂」**：
 * 门槛设成 throw，一旦作者写错，插件连加载都过不去；摘掉则该参数退化成「任意 JSON」，
 * 工具照常可用，同时在控制台留一条 alarm 让人来修。
 */
export function sanitizeSchema(node) {
  if (!isPlainObject(node)) return node;
  const out = {};

  for (const [key, value] of Object.entries(node)) {
    // 子集外的关键字：整个丢弃（anyOf/allOf/format/pattern/minimum …）
    if (!SUPPORTED_KEYWORDS.has(key)) {
      if (ANNOTATION_KEYWORDS.has(key)) out[key] = value;
      continue;
    }

    if (key === 'type') {
      if (typeof value === 'string' && SCHEMA_TYPES.has(value)) out.type = value;
      continue;
    }
    if (key === 'properties') {
      if (!isPlainObject(value)) continue;
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeSchema(v)]));
      continue;
    }
    if (key === 'items') {
      if (Array.isArray(value)) continue; // 子集只认单个 schema 的 items
      out.items = sanitizeSchema(value);
      continue;
    }
    if (key === 'oneOf') {
      if (!Array.isArray(value)) continue;
      const branches = value.map(sanitizeSchema).filter((b) => isPlainObject(b) && Object.keys(b).length > 0);
      if (branches.length >= 2) out.oneOf = branches;
      continue; // 少于一支持：退化成「任意 JSON」，由注解兜底
    }
    if (key === 'required') {
      if (!Array.isArray(value)) continue;
      const names = value.filter((s) => typeof s === 'string');
      if (names.length) out.required = names;
      continue;
    }
    if (key === 'enum') {
      if (!Array.isArray(value) || value.length === 0) continue;
      out.enum = value;
      continue;
    }
    if (key === 'additionalProperties') {
      if (typeof value === 'boolean' || isPlainObject(value)) out.additionalProperties = value;
      continue;
    }
    if (key === 'const') {
      out.const = value;
      continue;
    }
  }
  return out;
}

/**
 * 扫出树里所有非法的 `type` 取值，返回 `['properties.set.type=json', …]`。
 *
 * 空数组 = 这份 function schema 不会被 provider 拒。自检脚本与单测用。
 *
 * @param node 原始 JSON Schema
 * @param path 内部递归用
 * @returns 非法处的路径 + 原值
 */
export function findIllegalSchemaTypes(node, path = '') {
  const bad = [];
  if (!isPlainObject(node)) return bad;
  const here = (k) => (path ? `${path}.${k}` : k);
  if (node.type !== undefined && (typeof node.type !== 'string' || !SCHEMA_TYPES.has(node.type))) {
    bad.push(`${here('type')}=${JSON.stringify(node.type)}`);
  }
  if (isPlainObject(node.properties)) {
    for (const [k, v] of Object.entries(node.properties)) {
      bad.push(...findIllegalSchemaTypes(v, `${here('properties')}.${k}`));
    }
  }
  if (isPlainObject(node.items)) bad.push(...findIllegalSchemaTypes(node.items, here('items')));
  if (Array.isArray(node.items)) {
    node.items.forEach((v, i) => bad.push(...findIllegalSchemaTypes(v, `${here('items')}[${i}]`)));
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[key])) {
      node[key].forEach((v, i) => bad.push(...findIllegalSchemaTypes(v, `${here(key)}[${i}]`)));
    }
  }
  return bad;
}

/**
 * 把参数描述表编译成对象根的原始 JSON Schema。
 *
 * 与 `dsh-tools` 的 `parameterSchemaSpecToJsonSchema` 同名同义：
 * 隐式开放（不写 `additionalProperties: false`），`required` 取显式 `required: true`。
 */
export function parameterSchemaSpecToJsonSchema(spec) {
  const props = isPlainObject(spec) ? spec : {};
  const properties = {};
  const required = [];
  for (const [key, child] of Object.entries(props)) {
    properties[key] = compileNode(child);
    if (isPlainObject(child) && child.required === true) required.push(key);
  }
  return required.length ? { type: 'object', properties, required } : { type: 'object', properties };
}

/** 把输出 schema 描述编译成原始 JSON Schema。 */
export function valueSchemaSpecToJsonSchema(spec) {
  return compileNode(spec);
}

/**
 * 参数校验：对照编译后的原始 JSON Schema 走一遍。
 *
 * 只实现本插件参数表真正用得到的子集（type / enum / oneOf / 必需键），
 * 且**只报错不纠正** —— 与 `validateArgs` 的语义一致（返回违规列表，
 * 空数组 = 通过），调用方据此抛 `ToolArgsError`。
 */
export function validateArgs(schema, args) {
  const violations = [];
  const path = (p) => (p === '' ? '(root)' : p);

  function walk(node, value, p) {
    if (!isPlainObject(node)) return;
    if (Array.isArray(node.oneOf) && node.oneOf.length) {
      const hits = node.oneOf.filter((sub) => {
        const probe = [];
        walkInto(sub, value, p, probe);
        return probe.length === 0;
      });
      if (hits.length === 0) violations.push(`${path(p)}: 不匹配 any oneOf 分支`);
      return;
    }
    walkInto(node, value, p, violations);
  }

  function walkInto(node, value, p, sink) {
    if (!isPlainObject(node)) return;
    if (Array.isArray(node.enum) && !node.enum.includes(value)) {
      sink.push(`${path(p)}: 取值 ${JSON.stringify(value)} 不在 ${JSON.stringify(node.enum)} 内`);
      return;
    }
    switch (node.type) {
      case 'string':
        if (typeof value !== 'string') sink.push(`${path(p)}: 需要 string，收到 ${typeof value}`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') sink.push(`${path(p)}: 需要 boolean，收到 ${typeof value}`);
        break;
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) sink.push(`${path(p)}: 需要 number`);
        break;
      case 'integer':
        if (!Number.isInteger(value)) sink.push(`${path(p)}: 需要 integer`);
        break;
      case 'null':
        if (value !== null) sink.push(`${path(p)}: 需要 null`);
        break;
      case 'array':
        if (!Array.isArray(value)) {
          sink.push(`${path(p)}: 需要 array`);
        } else if (isPlainObject(node.items)) {
          value.forEach((v, i) => walkInto(node.items, v, `${p}[${i}]`, sink));
        }
        break;
      case 'object': {
        if (!isPlainObject(value)) {
          sink.push(`${path(p)}: 需要 object`);
          break;
        }
        for (const key of Array.isArray(node.required) ? node.required : []) {
          if (!(key in value)) sink.push(`${path(p)}.${key}: 缺少必需参数`);
        }
        if (isPlainObject(node.properties)) {
          for (const [key, child] of Object.entries(node.properties)) {
            if (key in value) walkInto(child, value[key], p === '' ? key : `${p}.${key}`, sink);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // 参数根永远是对象
  if (!isPlainObject(args)) {
    violations.push('(root): 参数必须是对象');
    return violations;
  }
  for (const key of Array.isArray(schema?.required) ? schema.required : []) {
    if (!(key in args)) violations.push(`${key}: 缺少必需参数`);
  }
  for (const [key, child] of Object.entries(isPlainObject(schema?.properties) ? schema.properties : {})) {
    if (key in args) walk(child, args[key], key);
  }
  return violations;
}

/** 非法模型参数。与 `dsh-tools` 的 `ToolArgsError` 同名同码。 */
export class ToolArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`);
    this.name = 'ToolArgsError';
    this.code = 'INVALID_ARGS';
    this.violations = violations;
  }
}

/**
 * `parameters` 的两种写法编译成**同一个**原始 JSON Schema。
 *
 * - 扁平 DSL（键即参数名）：`{ target: { type:'string' }, … }`
 * - 原始 JSON Schema：`{ type:'object', properties:{…}, required:[…] }`
 *
 * ⚠️ 两条路都必须经过 `compileNode` 递归 —— 这条路以前对第二种写法是
 * `{ ...spec }` 原样透传，正是 `mcu_regs` 把 `"type":"json"` 漏给 provider、
 * 导致每一轮对话都失败的直接原因。
 */
function compileParameters(spec) {
  if (isPlainObject(spec) && 'properties' in spec) return compileNode(spec);
  return parameterSchemaSpecToJsonSchema(spec);
}

/**
 * 构造一个可注册的工具定义。
 *
 * 与 `@deepseek-ai/dsh-tools` 的 `defineTool` 保持相同的调用形状，
 * 并额外允许 `parameters` 直接是**原始 JSON Schema**（带 `properties` 键时自动识别）。
 *
 * @param options 工具定义
 * @returns 传给 `ctx.tools.register()` 的定义对象
 */
export function defineTool(options) {
  const userExecute = options.execute;
  const userRender = options.output.render;
  const userPresentationMeta = options.output.presentationMeta;
  const userFinalizeContent = options.finalizeContent;
  const userProjectContent = options.projectContent;
  const userPresentCall = options.presentCall;
  const userPresentResult = options.presentResult;
  const userIsConcurrencySafe = options.isConcurrencySafe;

  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
  }

  const parameters = sanitizeSchema(compileParameters(options.parameters));
  const outputSchema = sanitizeSchema(valueSchemaSpecToJsonSchema(options.output.schema));

  // 兜底闹钟：真出了非法 type，要在**注册时**就喊出来并留下证据，
  // 而不是等 provider 把整轮对话打死（那次事故里连"哪个插件干的"都看不出来）。
  const illegal = findIllegalSchemaTypes(parameters);
  if (illegal.length) {
    console.error(
      `[defineTool] ${options.name}: function schema 清洗后仍有非法 type —— ${illegal.join(', ')}` +
        '；这会让 provider 拒掉整份工具列表，请立刻修 parameters。',
    );
  }

  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return userRender(args, value);
      },
      ...(userPresentationMeta !== undefined
        ? { presentationMeta(args, value) { return userPresentationMeta(args, value); } }
        : {}),
    },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args ?? {});
      if (violations.length > 0) throw new ToolArgsError(violations);
      return userExecute(args, exec);
    },
  };

  if (userProjectContent) tool.projectContent = (exec, result) => userProjectContent(exec, result);
  if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
  if (userPresentCall) {
    tool.presentCall = (args) => (validateArgs(parameters, args ?? {}).length > 0 ? undefined : userPresentCall(args));
  }
  if (userPresentResult) {
    tool.presentResult = (args, result) =>
      (validateArgs(parameters, args ?? {}).length > 0 ? undefined : userPresentResult(args, result));
  }
  if (userIsConcurrencySafe) {
    tool.isConcurrencySafe = (args) =>
      (validateArgs(parameters, args ?? {}).length > 0 ? false : userIsConcurrencySafe(args));
  }
  if (options.deferLoading === true) tool.deferLoading = true;
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs;

  return tool;
}
