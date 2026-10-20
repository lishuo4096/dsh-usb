/**
 * 把包内 `skills/**\/SKILL.md` 暴露成 DSH 技能 provider。
 *
 * 契约（DSH 0.2.0-rc.2 的 `@deepseek-ai/dsh-skill` 接缝，与 dsh-enet-review 同构）：
 *   - `ctx.skills.registerProvider(factory)` 把 `SkillProviderControl` 交给工厂；
 *     `control.signal` 是本次注册的生命周期信号，取消后必须立刻停止遍历。
 *   - `list(options)` 返回 `{ candidates, complete }`。目录读不动时 `complete: false`，
 *     **不要**把残缺目录当权威缓存起来。
 *   - `get(candidate, options)` 返回正文；`candidate.path` 是 SKILL.md 的绝对路径。
 *
 * 数据驱动：新增技能 = 往 `skills/` 里加一个含 `SKILL.md` 的目录。
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';

export const PROVIDER_NAME = 'usb';

/**
 * 解析包内相对路径。宿主可能用非 `file:` 的模块加载器，
 * 此时 `fileURLToPath` 会抛 —— 那就返回 undefined，让该根目录的发现结果
 * 标记为「不完整」，而不是伪装成「空目录」。
 */
function resolveBundledRoot(relative) {
  try {
    return fileURLToPath(new URL(relative, import.meta.url));
  } catch {
    return undefined;
  }
}

const SKILLS_ROOT = resolveBundledRoot('../skills');

function throwIfAborted(registration, options) {
  if (registration?.aborted) throw registration.reason;
  const { signal } = options ?? {};
  if (signal?.aborted) throw signal.reason;
}

async function collect(root, registration, options) {
  const items = [];
  let complete = true;
  async function walk(dir) {
    throwIfAborted(registration, options);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      complete = false; // 读不动 = 残缺视图，绝不缓存
      return;
    }
    for (const e of entries) {
      throwIfAborted(registration, options);
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.name === 'SKILL.md') {
        const text = await readFile(p, 'utf8');
        const { fm, body } = parseFrontmatter(text);
        if (fm.name) items.push({ path: p, fm, body });
      }
    }
  }
  await walk(root);
  return { items, complete };
}

/** 每次注册一个 provider 实例，目录缓存放闭包内 —— 热重载后不会复用已销毁 provider 的候选。 */
export function createProvider(control) {
  let cache = null;
  async function build(options) {
    if (cache !== null) return cache;
    const registration = control.signal;
    const skills = SKILLS_ROOT === undefined
      ? { items: [], complete: false }
      : await collect(SKILLS_ROOT, registration, options);
    const candidates = skills.items.map(({ path, fm }) => {
      const userInv = fm['user-invocable'];
      return {
        name: fm.name,
        description: fm.description ?? '',
        invocation: {
          modelInvocable: true,
          userInvocable: userInv === undefined ? true : userInv !== 'false',
        },
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: dirname(path) },
        path,
        rank: 0,
        locator: pathToFileURL(path),
      };
    });
    const catalog = { candidates, complete: skills.complete };
    if (catalog.complete) cache = catalog; // 只缓存可信目录
    return catalog;
  }
  return {
    name: PROVIDER_NAME,
    async list(options = {}) {
      throwIfAborted(control.signal, options);
      const catalog = await build(options);
      return { candidates: catalog.candidates, complete: catalog.complete };
    },
    async get(candidate, options = {}) {
      throwIfAborted(control.signal, options);
      const source = candidate.path ?? candidate.locator;
      const text = await readFile(source, 'utf8');
      const { body } = parseFrontmatter(text);
      return {
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        provider: candidate.provider,
        source: candidate.source,
        resourceBase: candidate.resourceBase,
        path: candidate.path,
        content: body,
      };
    },
  };
}

