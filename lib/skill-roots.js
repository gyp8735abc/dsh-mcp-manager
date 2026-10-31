// dsh-mcp-manager — Claude-Code skill roots (host-half helper).
//
// An older build of this plugin patched the core package
// `@deepseek-ai/dsh-skill-filesystem` to add two roots and a fallback:
//   1. a project root `<projectRoot>/.claude/skills`,
//   2. a user root `~/.claude/skills`,
//   3. discovery of a Claude-Code-style `SKILL.md` WITHOUT YAML frontmatter.
// 0.2.0-rc.2 seals that package inside app.asar, so the patch cannot be
// re-applied. This module re-implements the three behaviours on the public
// seam the shipped provider itself uses: `ctx.skills.registerProvider(create)`
// (`@deepseek-ai/dsh-skill`, the skill-registry Service; the shipped
// `dsh-skill-filesystem` is just another provider on it).
//
// Precedence, as the shipped code actually expresses it
// (`dsh-skill/lib/index.js`): every candidate carries a numeric `rank`, and
// `compareIndexedCandidates` sorts `rank asc || providerOrder || localOrder`
// inside ONE scope layer, so the LOWEST rank wins a same-named skill. The
// shipped provider ranks project-dsh 100, project-agents 200, custom 300,
// user-dsh 400, user-agents 500 and bundled 600
// (`dsh-skill-filesystem/lib/index.js:21-25,150-188`). The legacy ranks map:
//   project `.claude/skills`  150 -> 250  (still below custom 300 and every
//       user root; it loses to project-dsh 100 and project-agents 200)
//   user `~/.claude/skills`   450 -> 450  (unchanged: between user-dsh 400
//       and user-agents 500)
// Rank 250 keeps the legacy intent under the shipped ascending-rank rule; the
// single difference from the patched ranks is that a `.claude` skill now also
// loses to a same-named project `.agents/skills` skill, which is what the
// legacy patch's own rank slot (between project-dsh and project-agents) was
// reaching for under a higher-rank-wins reading.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** Provider name on `ctx.skills`; unique inside one scope layer. */
export const PROVIDER_NAME = "claude-roots";

/** Root sources, mirroring the shipped naming scheme. */
export const SOURCE_PROJECT_CLAUDE = "project-claude";
export const SOURCE_USER_CLAUDE = "user-claude";

/** Project `.claude/skills`: below project-dsh (100) and project-agents (200). */
const PROJECT_CLAUDE_RANK = 250;
/** User `~/.claude/skills`: between user-dsh (400) and user-agents (500). */
const USER_CLAUDE_RANK = 450;
/** Legacy fallback truncation for a description taken from the body. */
const MAX_DESCRIPTION_LENGTH = 300;
/** Legacy cap for a fallback name taken from the file system identity. */
const MAX_NAME_LENGTH = 64;
// The registry validates every candidate name against the shipped kebab-case
// grammar (`dsh-skill/lib/index.js:17,454`) from inside its own collect pass,
// where a violation is a THROWN error that would break the whole catalog, so a
// candidate whose identity cannot be expressed in that grammar is skipped
// instead of published.
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `.claude/skills` provider: two roots, the shipped frontmatter parser
 * semantics, and the Claude-Code frontmatter-less fallback.
 */
class ClaudeSkillRootProvider {
  constructor(ctx, control) {
    this.ctx = ctx;
    this.name = PROVIDER_NAME;
    this.control = control;
    this.disposed = false;
    this.seenRoots = [];
    this.reportedParser = false;
    this.warn = this.warn.bind(this);
    control.signal.addEventListener(
      "abort",
      () => {
        this.disposed = true;
      },
      { once: true }
    );
  }

  /**
   * Discover candidates for one lookup. An absent root is skipped silently; a
   * root that fails for another reason makes the observation incomplete (which
   * the registry never caches) instead of failing the whole catalog.
   */
  async list(options) {
    if (this.disposed) return [];
    const parseYaml = await loadFrontmatterParser();
    this.reportParser(parseYaml);
    const roots = this.roots(options?.cwd);
    this.seenRoots = roots;
    const candidates = [];
    let complete = true;
    for (const root of roots) {
      try {
        for (const candidate of discoverRoot(root, parseYaml, this.warn)) candidates.push(candidate);
      } catch (error) {
        complete = false;
        this.warn(`dsh-mcp-manager: skill root ${root.path} skipped: ${String(error)}`);
      }
    }
    return complete ? candidates : { candidates, complete };
  }

  /** Load the winning candidate's body from its locator. */
  async get(candidate, options) {
    if (this.disposed || options?.signal?.aborted === true) return undefined;
    const locator = candidate?.locator;
    if (locator === undefined || typeof locator.path !== "string") return undefined;
    const parseYaml = await loadFrontmatterParser();
    const parsed = parseSkillFile(locator.path, parseYaml, this.warn);
    if (parsed === undefined) return undefined;
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: parsed.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: "directory", path: locator.directory },
      path: parsed.path,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
      content: parsed.content,
    };
  }

  /** The roots this provider owns for one lookup. */
  roots(cwd) {
    const roots = [];
    if (typeof cwd === "string" && cwd.length > 0) {
      roots.push({
        path: join(findProjectRoot(resolve(cwd)), ".claude", "skills"),
        source: SOURCE_PROJECT_CLAUDE,
        rank: PROJECT_CLAUDE_RANK,
      });
    }
    roots.push({
      path: join(homedir(), ".claude", "skills"),
      source: SOURCE_USER_CLAUDE,
      rank: USER_CLAUDE_RANK,
    });
    return roots;
  }

  /** Whether one host path can change what this provider just discovered. */
  observes(path) {
    const target = resolve(path).toLowerCase();
    for (const root of this.seenRoots) {
      const lower = resolve(root.path).toLowerCase();
      if (target === lower || target.startsWith(lower + sep)) return true;
    }
    return false;
  }

  /** Drop the registry's cached catalog for this provider. */
  invalidate() {
    if (this.disposed) return;
    this.control.invalidate();
  }

  /** No watchers are owned, so disposal only contains late callbacks. */
  dispose() {
    this.disposed = true;
  }

  warn(message) {
    this.ctx.logger?.warn(message);
  }

  /** Record once which frontmatter parser this runtime can reach. */
  reportParser(parseYaml) {
    if (this.reportedParser) return;
    this.reportedParser = true;
    const kind = parseYaml === parseFlatFrontmatter ? "built-in flat reader" : "shipped yaml parser";
    this.ctx.logger?.info(`dsh-mcp-manager: .claude skill roots use the ${kind}`);
  }
}

/**
 * Register the `.claude/skills` provider on a context that has `skills`.
 * @param ctx - context carrying the injected `skills` service.
 */
export function registerClaudeSkillRoots(ctx) {
  let provider;
  ctx.effect(function* () {
    yield ctx.skills.registerProvider((control) => {
      provider = new ClaudeSkillRootProvider(ctx, control);
      return provider;
    });
    // No host watcher (the shipped provider's chokidar manager is package
    // private): invalidate on first-party filesystem mutations under our
    // roots, the same signal `dsh-skill-filesystem` reacts to.
    ctx.on("fs/observed", (target, _observation, actor) => {
      if (!isMutationActor(actor)) return;
      const path = target?.displayPath;
      if (typeof path !== "string") return;
      if (provider?.observes(path) === true) provider.invalidate();
    });
    yield () => provider?.dispose();
  }, "dsh-mcp-manager: .claude skill roots");
}

/** Discover one root: `<name>/SKILL.md` bundles plus loose `*.md` files. */
function discoverRoot(root, parseYaml, warn) {
  const candidates = [];
  let entries;
  try {
    entries = readdirSync(root.path, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if (isAbsentPathError(error)) return candidates; // absent root: skipped silently
    throw error;
  }
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = join(root.path, entry.name);
    const kind = entryKind(entry, fullPath);
    const locator =
      kind === "directory"
        ? { path: join(fullPath, "SKILL.md"), directory: fullPath }
        : kind === "file" && entry.name.endsWith(".md")
          ? { path: fullPath, directory: root.path }
          : undefined;
    if (locator === undefined) continue;
    const parsed = parseSkillFile(locator.path, parseYaml, warn);
    if (parsed === undefined) continue;
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: parsed.invocation,
      source: root.source,
      provider: PROVIDER_NAME,
      rank: root.rank,
      locator,
      resourceBase: { kind: "directory", path: locator.directory },
      path: parsed.path,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    });
  }
  return candidates;
}

/**
 * Parse one skill file exactly as `dsh-skill-filesystem` does, with the
 * Claude-Code fallback: a file without YAML frontmatter still yields a skill
 * (name from the on-disk identity, description from the first content line).
 * Returns `undefined` for a malformed or unusable file; never throws for
 * content problems.
 */
function parseSkillFile(filePath, parseYaml, warn) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isAbsentPathError(error)) return undefined;
    throw error;
  }
  let frontmatter;
  try {
    frontmatter = parseFrontmatter(raw, parseYaml);
  } catch (error) {
    warn(`skill file ${filePath} ignored: invalid YAML frontmatter: ${String(error)}`);
    return undefined;
  }
  if (frontmatter === null) {
    warn(`skill file ${filePath} ignored: missing YAML frontmatter`);
    return undefined;
  }
  if (frontmatter !== undefined) {
    const name = stringField(frontmatter.data, "name");
    const description = stringField(frontmatter.data, "description");
    if (name === undefined || description === undefined) {
      warn(`skill file ${filePath} ignored: frontmatter requires name and description`);
      return undefined;
    }
    if (!SKILL_NAME.test(name)) {
      warn(`skill file ${filePath} ignored: invalid skill name "${name}"`);
      return undefined;
    }
    let invocation;
    try {
      invocation = parseInvocationPolicy(frontmatter.data);
    } catch (error) {
      warn(`skill file ${filePath} ignored: invalid invocation frontmatter: ${String(error)}`);
      return undefined;
    }
    return {
      name,
      description,
      ...optionalString(frontmatter.data, "whenToUse"),
      invocation,
      ...optionalMetadata(frontmatter.data),
      path: realPath(filePath),
      content: frontmatter.body.trim(),
    };
  }
  // Claude-Code compatibility: no YAML frontmatter at all.
  const name = fallbackName(filePath);
  const description = fallbackDescription(raw);
  if (name === undefined || description === undefined) {
    warn(`skill file ${filePath} ignored: no frontmatter and no usable body line`);
    return undefined;
  }
  return {
    name,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    path: realPath(filePath),
    content: raw.trim(),
  };
}

/**
 * The shipped frontmatter splitter (`dsh-skill-filesystem/lib/index.js:780`),
 * mirrored: `---` on the first line, then the next `---` line, YAML between.
 * The shipped function is module private and the package exports no parser
 * helper (its export list is `Config, FileSystemSkillProvider, apply, inject,
 * name`), so only the algorithm is shared; the YAML parse itself reuses the
 * very dependency that package imports (`yaml`, line 7).
 *
 * @returns `undefined` when the file carries no frontmatter (Claude-Code
 *   style, eligible for the fallback), `null` when it carries frontmatter that
 *   is not a YAML mapping, and the split pair otherwise.
 */
function parseFrontmatter(raw, parseYaml) {
  const firstLineEnd = raw.indexOf("\n");
  const firstLine = (firstLineEnd < 0 ? raw : raw.slice(0, firstLineEnd)).replace(/\r$/, "");
  // The fallback is only for files that never opened a frontmatter block: a
  // file whose first line is `---` is frontmatter-shaped, so a broken block is
  // a malformed skill rather than a Claude-Code-style body.
  if (firstLine !== "---") return undefined;
  const start = firstLineEnd + 1;
  const closing = findClosingFrontmatter(raw, start);
  if (closing === undefined) return null;
  const parsed = parseYaml(raw.slice(start, closing.start));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return { data: parsed, body: raw.slice(closing.bodyStart) };
}

function findClosingFrontmatter(raw, start) {
  let lineStart = start;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf("\n", lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
    }
    if (nextNewline < 0) return undefined;
    lineStart = nextNewline + 1;
  }
  return undefined;
}

/**
 * Resolve the YAML parser once per process. The shipped package imports
 * `parse` from "yaml"; when that specifier is not resolvable from here the
 * flat reader below covers the documented name/description frontmatter.
 */
let frontmatterParserPromise;
function loadFrontmatterParser() {
  frontmatterParserPromise ??= import("yaml").then(
    (module) => (typeof module.parse === "function" ? module.parse : parseFlatFrontmatter),
    () => parseFlatFrontmatter
  );
  return frontmatterParserPromise;
}

/** Minimal `key: value` reader (plus folded/literal blocks) used as a fallback. */
function parseFlatFrontmatter(text) {
  const data = {};
  let block;
  let sawKey = false;
  for (const line of text.split(/\r?\n/)) {
    if (block !== undefined) {
      if (/^\s+\S/.test(line)) {
        block.lines.push(line.trim());
        continue;
      }
      data[block.key] = block.lines.join(" ").trim();
      block = undefined;
    }
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    sawKey = true;
    const value = match[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      block = { key: match[1], lines: [] };
      continue;
    }
    data[match[1]] = unquoteScalar(value);
  }
  if (block !== undefined) data[block.key] = block.lines.join(" ").trim();
  return sawKey ? data : undefined;
}

function unquoteScalar(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Legacy fallback identity: parent directory of `SKILL.md`, else the file stem. */
function fallbackName(filePath) {
  const base = basename(filePath);
  const stem = base.toLowerCase() === "skill.md" ? basename(dirname(filePath)) : base.replace(/\.md$/i, "");
  const sanitized = stem.replace(/[^A-Za-z0-9_-]/g, "-");
  const name = sanitized
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return undefined;
  return SKILL_NAME.test(name) ? name : undefined;
}

/** Legacy fallback description: first non-empty line, leading `#` stripped. */
function fallbackDescription(raw) {
  const line = raw
    .split(/\r?\n/)
    .map((text) => text.replace(/^#+\s*/, "").trim())
    .find((text) => text.length > 0);
  if (line === undefined) return undefined;
  return line.slice(0, MAX_DESCRIPTION_LENGTH);
}

function entryKind(entry, fullPath) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return undefined;
  try {
    const info = statSync(fullPath);
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
  } catch {
    return undefined;
  }
  return undefined;
}

/** The shipped project-root rule: the nearest ancestor holding `.git`, else cwd. */
function findProjectRoot(cwd) {
  let current = cwd;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function realPath(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function stringField(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? { [key]: value } : {};
}

function optionalMetadata(data) {
  const value = data.metadata;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return { metadata: value };
  return {};
}

/** Shipped invocation policy (`dsh-skill-filesystem/lib/index.js:849`). */
function parseInvocationPolicy(data) {
  rejectLegacyInvocationKey(data, "disableModelInvocation", "disable-model-invocation");
  rejectLegacyInvocationKey(data, "modelInvocable", "disable-model-invocation");
  rejectLegacyInvocationKey(data, "userInvocable", "user-invocable");
  const disableModelInvocation = frontmatterBoolean(data, "disable-model-invocation");
  const userInvocable = frontmatterBoolean(data, "user-invocable");
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  };
}

function rejectLegacyInvocationKey(data, legacy, canonical) {
  if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`);
}

function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined;
  const value = data[key];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    switch (value.toLowerCase()) {
      case "true":
      case "yes":
      case "on":
        return true;
      case "false":
      case "no":
      case "off":
        return false;
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}

/** Shipped `fs/observed` actor filter: only model-facing writes and edits. */
function isMutationActor(actor) {
  if (actor === undefined || actor === null || !("name" in actor)) return false;
  return actor.name === "edit" || actor.name === "write";
}

function isAbsentPathError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}
