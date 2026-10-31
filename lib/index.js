// dsh-mcp-manager —host half.
//
// One MCP supervisor for the web profile:
//   - inventory: global servers (from $DSH_HOME/mcp.claude.json, generated
//     from ~/.claude.json), project servers (each dsh workspace's .mcp.json),
//     and manual servers (other live @deepseek-ai/dsh-mcp-client loader
//     entries, e.g. profile-patch entries like codebase / openpencil).
//   - state: a `mcp` settings namespace storing PER-WORKSPACE disabled lists
//     ({ projects: [{ path, disabled: [serverName...] }] }) in the settings
//     document (~/.dsh/settings.yaml). A workspace's disabled list covers BOTH
//     its own project servers AND the global servers —so global MCP usage is
//     per-workspace (workspace A may enable 1 global server, workspace B 3).
//     Legacy plain names in `disabled` keep matching the workspace-qualified
//     runtime identities, so existing config needs no migration.
//   - mounting: the manager owns every MCP connection. The mount set is the
//     UNION of every workspace that currently has a live session (host
//     `sessions` service + session/created|disposed events); a workspace's
//     MCPs stay up as long as any of its sessions is open, so switching the
//     focused session NEVER stops another workspace's MCPs. Project servers
//     are mounted per (workspace, server) with workspace-qualified runtime
//     serverNames (`<slug>__<name>` -> tools `mcp__<workspace>__<name>__<tool>`),
//     each with its own config/cwd; globals are one shared process mounted
//     when any live workspace enables them; manual loader entries follow
//     "wanted by any live workspace". A per-session system-prompt/assemble
//     filter then drops other workspaces' `mcp__<workspace>__*` tools, so a
//     session only ever receives its own workspace's MCP tools.
//   - API:
//       GET  /api/dsh-mcp-manager/inventory[?active=<path>]
//       POST /api/dsh-mcp-manager/activate  { path }
//       POST /api/dsh-mcp-manager/set       { path, kind, name, enabled }
//
// The browser half renders a popup opened from each workspace's MCP button and
// writes toggles through the standard settings wire (settings.mutate), which
// this plugin watches.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve, normalize, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { installSkillFilter } from "./skill-filter.js";
import { registerClaudeSkillRoots } from "./skill-roots.js";

export const name = "dsh-mcp-manager";

export const inject = ["webServer", "loader"];

const MCP_CLIENT = "@deepseek-ai/dsh-mcp-client";
const NS = "mcp";
const INVENTORY_PATH = "/api/dsh-mcp-manager/inventory";
const ACTIVATE_PATH = "/api/dsh-mcp-manager/activate";
const SET_PATH = "/api/dsh-mcp-manager/set";

const dshHome = () => process.env.DSH_HOME || join(homedir(), ".dsh");

/**
 * This plugin owns its state file instead of the DSH settings service.
 *
 * dsh 0.2.x replaced `settings.register(ns, schema)` with a per-entry model:
 * a settings namespace is a composed profile entry id and its schema is that
 * entry's Config, so a plugin can no longer claim an arbitrary namespace like
 * `mcp`. Keeping the state in `<home>/mcp-manager/state.json` keeps the same
 * data shape as before and works on both the old and the new runtime.
 */
const statePath = () => join(dshHome(), "mcp-manager", "state.json");

/** Normalize any parsed state document to `{ projects: [...] }`. */
function normalizeState(value) {
  const projects = Array.isArray(value?.projects) ? value.projects : [];
  return {
    projects: projects
      .filter((row) => row !== null && typeof row === "object" && typeof row.path === "string" && row.path.length > 0)
      .map((row) => ({
        path: row.path,
        disabled: Array.isArray(row.disabled) ? row.disabled.filter((name) => typeof name === "string") : [],
        disabledSkills: Array.isArray(row.disabledSkills) ? row.disabledSkills.filter((name) => typeof name === "string") : [],
      })),
  };
}

/** The legacy `mcp` section of the removed `<home>/settings.yaml` document. */
function readLegacySection() {
  for (const candidate of [join(dshHome(), "settings.yaml"), join(dshHome(), "settings.yaml.imported")]) {
    if (!existsSync(candidate)) continue;
    try {
      const text = readFileSync(candidate, "utf8");
      // The section is a small, flat list of per-workspace rows; a focused
      // reader avoids depending on a YAML package.
      const section = extractYamlSection(text, NS);
      if (section !== null) {
        const parsed = parseProjectRows(section);
        if (parsed.length > 0) return { projects: parsed };
      }
    } catch {
      /* an unreadable legacy document must not block startup */
    }
  }
  return null;
}

/** Slice one top-level `key:` block (its indented body) out of a YAML document. */
function extractYamlSection(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  if (start < 0) return null;
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length > 0 && !/^\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/** Read `- path: ... / disabled: [...] / disabledSkills: [...]` rows from a section body. */
function parseProjectRows(section) {
  const rows = [];
  let current = null;
  let field = null;
  for (const line of section.split(/\r?\n/)) {
    const item = /^\s*-\s*path:\s*(.+?)\s*$/.exec(line);
    if (item !== null) {
      current = { path: unquoteYaml(item[1]), disabled: [], disabledSkills: [] };
      rows.push(current);
      field = null;
      continue;
    }
    if (current === null) continue;
    const inline = /^\s*(disabled|disabledSkills):\s*\[(.*)\]\s*$/.exec(line);
    if (inline !== null) {
      current[inline[1]] = inline[2]
        .split(",")
        .map((part) => unquoteYaml(part.trim()))
        .filter((part) => part.length > 0);
      field = null;
      continue;
    }
    const block = /^\s*(disabled|disabledSkills):\s*$/.exec(line);
    if (block !== null) {
      current[block[1]] = [];
      field = block[1];
      continue;
    }
    const entry = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (entry !== null && field !== null) {
      const value = unquoteYaml(entry[1]);
      if (value.length > 0) current[field].push(value);
    }
  }
  return rows;
}

/** Strip surrounding quotes from one scalar YAML value. */
function unquoteYaml(value) {
  const text = String(value).trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

/** Generic spawner command basenames that are too generic to identify a server. */
const GENERIC_MARKER_TOKENS = new Set(["python", "python3", "node", "npx", "npm", "cmd", "powershell", "pwsh", "bash", "sh", "dot", "exe", "mcp"]);

/**
* Derive a distinctive process-command-line marker for one mcp-client config,
* so orphaned children of a stopped server can be found and killed. Prefers the
* command basename; falls back to the longest distinctive argument token.
* Returns null when nothing distinctive exists (sweep is then skipped).
*/
function markerFor(config) {
  const command = typeof config?.command === "string" ? config.command : "";
  const args = Array.isArray(config?.args) ? config.args : [];
  const candidates = [];
  const base = command.split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  if (stem.length >= 4) candidates.push(stem);
  for (const arg of args) {
    for (const part of String(arg).split(/[\\/\s=]/).filter(Boolean)) {
      if (part.length >= 4) candidates.push(part);
    }
  }
  const distinct = candidates.filter((candidate) => !GENERIC_MARKER_TOKENS.has(candidate.toLowerCase()));
  if (distinct.length === 0) return null;
  return [...distinct].sort((a, b) => b.length - a.length)[0];
}

/**
* Read a directory with entry types; rejects propagate (callers treat ENOENT as
* an absent root).
*/
function readdirWithTypes(path) {
  return readdir(path, { withFileTypes: true, encoding: "utf8" });
}

/**
* Minimal SKILL.md frontmatter parser: extracts `name` and `description`
* (quoted or plain). Frontmatter-less files (Claude Code style) fall back to
* the file name + first content line. Returns null when nothing usable exists.
*/
function parseSkillFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const firstLineEnd = raw.indexOf("\n");
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") {
    return fallbackSkillMeta(path, raw);
  }
  const closing = raw.indexOf("\n---", firstLineEnd + 1);
  if (closing < 0) return null;
  const frontmatter = raw.slice(firstLineEnd + 1, closing);
  const name = frontmatterValue(frontmatter, "name");
  const description = frontmatterValue(frontmatter, "description");
  if (name === null || description === null) return null;
  return { name, description };
}

/** Frontmatter-less fallback (Claude Code compatibility): name from the skill
* identity — the parent directory for a <name>/SKILL.md bundle, else the file
* stem — and description from the first content line. */
function fallbackSkillMeta(path, raw) {
  const parts = path.split(/[\\/]/);
  const basename = parts.pop() ?? "";
  let stem;
  if (basename === "SKILL.md") stem = parts.pop() ?? "";
  else if (basename.endsWith(".md")) stem = basename.slice(0, -3);
  else stem = basename;
  if (stem.length === 0 || stem.length > 64) return null;
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  if (line === void 0) return null;
  return { name: stem, description: line.slice(0, 200) };
}

function frontmatterValue(frontmatter, key) {
  const match = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(frontmatter);
  if (match === null || match[1] === void 0) return null;
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value : null;
}

/**
* Kill processes matching `marker` whose parent is already gone (orphans of a
* stopped server). Windows venv launchers (Scripts/python.exe) spawn the real
* interpreter as a child, so killing the direct child orphans the rest —this
* sweeps those leftovers without touching unrelated processes whose parent is
* still alive (e.g. the same server running under Claude Code).
*/
function killOrphanTree(marker) {
  if (marker === null || marker === void 0 || marker.length === 0) return;
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const script =
    "$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '" +
    escaped +
    "' }; " +
    "$ids = @(Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId }); " +
    "foreach ($p in $procs) { if ($ids -notcontains $p.ParentProcessId) { & taskkill /F /T /PID $p.ProcessId 2>$null | Out-Null } }";
  const child = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore", windowsHide: true });
  child.on("error", (error) => {
    process.stderr.write(`dsh-mcp-manager: orphan sweep failed: ${String(error)}\n`);
  });
}

/**
* Retried orphan sweep: the MCP SDK's transport close has a ~4s grace window
* (stdin end -> SIGTERM -> SIGKILL), so the direct child may still be alive
* when the first sweep runs. Schedule a few passes so the eventual orphans
* (the launcher's own children) are caught once the direct child dies.
*/
function scheduleOrphanSweep(marker) {
  if (marker === null || marker === void 0 || marker.length === 0) return;
  for (const delay of [1000, 3000, 6000]) {
    setTimeout(() => killOrphanTree(marker), delay);
  }
}

function serverNameOk(name) {
  return /^[A-Za-z0-9_-]{1,32}$/.test(name);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Claude-Code-style .mcp.json entry -> dsh mcp-client config (null when unsupported). */
function toMcpConfig(name, cfg) {
  const type = cfg?.type || (cfg?.url ? "streamable-http" : "stdio");
  if (type === "stdio" && cfg?.command) {
    const config = { serverName: name, transport: "stdio", command: cfg.command };
    if (Array.isArray(cfg.args) && cfg.args.length > 0) config.args = cfg.args;
    if (cfg.env && Object.keys(cfg.env).length > 0) config.env = cfg.env;
    if (cfg.cwd) config.cwd = cfg.cwd;
    return config;
  }
  // Claude Code's .mcp.json also spells streamable HTTP as "http".
  if ((type === "http" || type === "streamable-http") && cfg?.url) {
    const config = { serverName: name, transport: "streamable-http", url: cfg.url };
    if (cfg.headers) config.headers = cfg.headers;
    return config;
  }
  return null;
}

/** Short, filesystem-safe slug for one workspace directory (basename). */
function workspaceSlug(path) {
  const base = basename(resolve(String(path))).replace(/[^A-Za-z0-9_-]/g, "_");
  return base.length > 0 ? base : "ws";
}

/** One unique slug per workspace path; duplicate basenames get "-2", "-3", … */
function uniqueSlugs(paths) {
  const result = new Map();
  const seen = new Map();
  for (const p of paths) {
    const base = workspaceSlug(p);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    result.set(normKey(p), count > 1 ? `${base}-${count}` : base);
  }
  return result;
}

/** Normalize a project path for display and for settings keys. */
function normPath(p) {
  return normalize(String(p));
}

/** Case-insensitive dedup key (Windows). */
function normKey(p) {
  return normPath(p).toLowerCase();
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolveBody(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

class McpManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.projectPath = resolve(process.cwd()); // dsh launch directory
    this.activePath = this.projectPath; // focused workspace (display + fallback)
    this.state = { projects: [] };
    this.globalServers = new Map(); // serverName -> mcp-client config (mcp.claude.json + ~/.claude.json)
    this.globalSource = null; // where the global list was read from, for the popup
    this.workspacePaths = new Map(); // normKey -> display path (launch dir + dsh workspaces)
    this.projectServersByPath = new Map(); // normKey -> { path, servers: Map<serverName, config> }
    this.fibers = new Map(); // runtime serverName -> Fiber (union of all live workspaces' sets)
    this.fiberConfigs = new Map(); // runtime serverName -> config (for orphan sweeping)
    this.applyQueue = Promise.resolve();
    this.disposers = [];
  }

  /**
  * Load the global server list from two sources; the live one is read last so
  * it wins a same-named server:
  *
  *   1. `$DSH_HOME/mcp.claude.json` — the dsh-side list that
  *      `$DSH_HOME/bin/dsh-mcp-sync.mjs` generates from `~/.claude.json`. It is
  *      optional: when that script was never run (the packaged app never runs
  *      it) the file is simply absent.
  *   2. `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) — Claude Code's
  *      own `mcpServers`. Read directly, so editing Claude's config is enough and
  *      no sync step can be forgotten. Its entries have the `.mcp.json` shape,
  *      so the project normalizer is reused for them.
  */
  loadGlobal() {
    const generatedFile = join(dshHome(), "mcp.claude.json");
    const generatedDoc = readJson(generatedFile);
    for (const entry of Array.isArray(generatedDoc) ? generatedDoc : []) {
      const config = entry?.config;
      const serverName = config?.serverName;
      if (typeof serverName === "string" && serverNameOk(serverName)) this.globalServers.set(serverName, config);
    }
    const fromGenerated = this.globalServers.size;

    const claudeDir = process.env.CLAUDE_CONFIG_DIR;
    const claudeFile = join(claudeDir !== undefined && claudeDir.trim().length > 0 ? claudeDir : homedir(), ".claude.json");
    const claudeDoc = readJson(claudeFile);
    let fromClaude = 0;
    for (const [name, cfg] of Object.entries(claudeDoc?.mcpServers ?? {})) {
      if (!serverNameOk(name)) {
        this.ctx.logger?.warn(`dsh-mcp-manager: global server "${name}" in ${claudeFile} skipped (name is not usable as a dsh serverName)`);
        continue;
      }
      const config = toMcpConfig(name, cfg);
      if (config === null) {
        this.ctx.logger?.warn(`dsh-mcp-manager: global server "${name}" in ${claudeFile} skipped (unsupported transport)`);
        continue;
      }
      this.globalServers.set(name, config);
      fromClaude += 1;
    }
    this.globalSource = { generatedFile, claudeFile, fromGenerated, fromClaude };
  }

  /**
  * Re-discover every project (dsh workspaces + launch dir) and their
  * .mcp.json servers. Called at boot AND on every inventory request / activate
  * so workspaces added after boot and edited .mcp.json files show up without a
  * restart. Never throws: a failing read keeps the previous project table.
  */
  rescanProjects() {
    const candidates = new Map(); // normKey -> display path
    const add = (p) => {
      if (typeof p !== "string" || p.trim().length === 0) return;
      const normalized = normPath(p);
      candidates.set(normKey(normalized), normalized);
    };
    add(this.projectPath);
    try {
      const workspaces = this.ctx.get("workspaceRegistry")?.list?.();
      for (const workspace of workspaces ?? []) add(workspace?.path);
    } catch {
      /* workspace registry optional */
    }

    const next = new Map();
    for (const [key, dir] of candidates) {
      const mcpFile = join(dir, ".mcp.json");
      if (!existsSync(mcpFile)) continue;
      const doc = readJson(mcpFile);
      const servers = new Map();
      for (const [serverName, cfg] of Object.entries(doc?.mcpServers ?? {})) {
        if (!serverNameOk(serverName)) {
          this.ctx.logger?.warn(`dsh-mcp-manager: skip server "${serverName}" in ${dir} (invalid name)`);
          continue;
        }
        const config = toMcpConfig(serverName, cfg);
        if (config === null) {
          this.ctx.logger?.warn(`dsh-mcp-manager: skip server "${serverName}" in ${dir} (unsupported transport)`);
          continue;
        }
        // Claude Code semantics: a stdio server without an explicit `cwd` runs
        // in the WORKSPACE directory, so relative paths in its args (e.g.
        // `--db .codebase/codebase.db`) resolve inside the owning workspace
        // instead of the dsh launch directory — each workspace's same-named
        // server (e.g. `codebase`) points at ITS OWN database.
        if (config.transport === "stdio" && !config.cwd) config.cwd = dir;
        servers.set(serverName, config);
      }
      if (servers.size === 0) continue;
      next.set(key, { path: dir, servers });
    }
    this.workspacePaths = candidates;
    this.projectServersByPath = next;
    this.qualifyProjectServers();
  }

  /**
  * Give every project server a workspace-qualified runtime serverName
  * `<workspaceSlug>__<name>` (e.g. `xxsbm__codebase`), producing model-facing
  * tool names `mcp__<workspace>__<name>__<tool>`. Two reasons:
  *   - the tool registry is Host-process-global, and the union model mounts
  *     several workspaces' sets in parallel — the workspace prefix keeps each
  *     (workspace, server) pair a distinct process AND tool namespace;
  *   - the per-session filter (system-prompt/assemble middleware) drops
  *     `mcp__<workspace>__*` tools of OTHER workspaces, so a session never
  *     receives another workspace's MCP tools.
  * Global servers and manual loader entries keep their plain serverName.
  */
  qualifyProjectServers() {
    const slugs = uniqueSlugs([...this.workspacePaths.values()]);
    this.workspaceSlugs = slugs; // normKey -> slug
    this.workspaceSlugSet = new Set(slugs.values());
    const reserved = new Set();
    for (const name of this.globalServers.keys()) reserved.add(name.toLowerCase());
    for (const entry of this.loaderEntriesByServer()) {
      const name = entry.options?.config?.serverName;
      if (typeof name === "string") reserved.add(name.toLowerCase());
    }
    for (const row of this.projectServersByPath.values()) {
      const slug = slugs.get(normKey(row.path));
      for (const [name, config] of row.servers) {
        let candidate = `${slug}__${name}`.slice(0, 32);
        let qualified = candidate;
        let n = 2;
        while (reserved.has(qualified.toLowerCase())) {
          const suffix = `-${n++}`;
          qualified = `${candidate.slice(0, 32 - suffix.length)}${suffix}`;
        }
        reserved.add(qualified.toLowerCase());
        config.serverName = qualified;
      }
    }
  }

  /** Workspace slug (basename) for the workspace containing `cwd`. */
  slugForCwd(cwd) {
    const path = this.workspacePathForCwd(cwd);
    if (path === null) return null;
    return this.workspaceSlugs?.get(normKey(path)) ?? null;
  }

  /**
  * Whether one model-facing tool may be transmitted to a session in the
  * workspace `ownSlug`. Non-MCP tools and global/manual MCP servers
  * (one-segment serverName, e.g. `mcp__everything-search__search`) always
  * pass; project MCP tools (`mcp__<workspace>__<name>__<tool>`) pass only for
  * the session's OWN workspace — other live workspaces' tools stay out.
  */
  toolVisibleTo(name, ownSlug) {
    if (typeof name !== "string" || !name.startsWith("mcp__")) return true;
    const rest = name.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep <= 0) return true; // malformed / one-segment: treat as global
    const first = rest.slice(0, sep);
    if (!this.workspaceSlugSet?.has(first)) return true; // global or manual server
    return first === ownSlug; // project tool: only the session's own workspace
  }

  /** Live loader entries that mount an MCP client, keyed by serverName. */
  loaderEntriesByServer() {
    const result = new Map();
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options?.name !== MCP_CLIENT) continue;
      const serverName = entry.options?.config?.serverName;
      if (typeof serverName === "string") result.set(serverName, entry);
    }
    return result;
  }

  /** One workspace's disabled server names (from the mcp settings namespace). */
  disabledSetFor(path) {
    const value = this.state;
    const projects = value?.projects;
    if (!Array.isArray(projects)) return new Set();
    const key = normKey(path);
    const row = projects.find((candidate) => candidate?.path && normKey(candidate.path) === key);
    return new Set(Array.isArray(row?.disabled) ? row.disabled : []);
  }

  /** One workspace's disabled skill names (from the mcp settings namespace). */
  skillDisabledSetFor(path) {
    const value = this.state;
    const projects = value?.projects;
    if (!Array.isArray(projects)) return new Set();
    const key = normKey(path);
    const row = projects.find((candidate) => candidate?.path && normKey(candidate.path) === key);
    return new Set(Array.isArray(row?.disabledSkills) ? row.disabledSkills : []);
  }

  /**
  * Whether a skill is disabled for the workspace containing `cwd` —used by the
  * model-facing skill catalog (dsh-tool-skill) so sessions only see enabled
  * skills. Matches the row whose path is the longest normalized prefix of cwd.
  */
  isSkillDisabled(cwd, name) {
    if (typeof cwd !== "string" || cwd.length === 0 || typeof name !== "string") return false;
    const value = this.state;
    const projects = value?.projects;
    if (!Array.isArray(projects)) return false;
    const target = normPath(cwd).toLowerCase();
    let best = null;
    let bestLen = -1;
    for (const row of projects) {
      if (!row?.path) continue;
      const candidate = normPath(row.path).toLowerCase();
      if (candidate.length > bestLen && (target === candidate || target.startsWith(candidate + "\\") || target.startsWith(candidate + "/"))) {
        best = row;
        bestLen = candidate.length;
      }
    }
    if (best === null) return false;
    return Array.isArray(best.disabledSkills) && best.disabledSkills.includes(name);
  }

  /**
  * The plain .mcp.json name and the qualified runtime name of one project
  * server (identity for globals/manual when no project row matches).
  */
  serverNamePair(path, name) {
    const row = this.projectServersByPath.get(normKey(path));
    if (row !== void 0) {
      for (const [plain, config] of row.servers) {
        const runtime = config.serverName ?? plain;
        if (plain === name) return { plain, runtime };
        if (runtime === name) return { plain, runtime };
      }
    }
    return { plain: name, runtime: name };
  }

  /** Toggle one MCP server or skill for one workspace, persist, and live-apply. */
  async set(path, kind, name, enabled) {
    if (typeof path !== "string" || path.length === 0) throw new TypeError("set: path is required");
    if (kind !== "mcp" && kind !== "skill") throw new TypeError(`set: kind must be "mcp" or "skill", got ${JSON.stringify(kind)}`);
    if (typeof name !== "string" || name.length === 0) throw new TypeError("set: name is required");
    const key = normKey(path);
    const value = this.state;
    const projects = Array.isArray(value?.projects) ? value.projects.map((row) => ({ ...row })) : [];
    const index = projects.findIndex((row) => row?.path && normKey(row.path) === key);
    const row = index >= 0 ? projects[index] : { path: normPath(path), disabled: [], disabledSkills: [] };
    const field = kind === "mcp" ? "disabled" : "disabledSkills";
    const list = new Set(Array.isArray(row[field]) ? row[field] : []);
    if (kind === "mcp") {
      // Store the qualified runtime identity; enabling clears BOTH the legacy
      // plain name and the runtime name (existing settings keep working).
      const { plain, runtime } = this.serverNamePair(path, name);
      if (enabled) {
        list.delete(plain);
        list.delete(runtime);
      } else {
        list.add(runtime);
      }
    } else if (enabled) {
      list.delete(name);
    } else {
      list.add(name);
    }
    row[field] = [...list].sort();
    const nextProjects = index >= 0 ? projects.map((entry, i) => (i === index ? row : entry)) : [...projects, row];
    this.state = { projects: nextProjects };
    this.persistState();
    if (kind === "mcp") await this.applyState();
    return { ok: true };
  }

  /**
  * Workspaces that currently have at least one live session (from the host
  * `sessions` service, via each session's header.cwd). Falls back to the
  * focused/launch workspace so MCPs are available before any session opens.
  */
  liveWorkspaceKeys() {
    const keys = new Set();
    try {
      const sessions = this.ctx.get("sessions")?.list?.() ?? [];
      for (const session of sessions) {
        const cwd = session?.header?.cwd;
        if (typeof cwd !== "string" || cwd.length === 0) continue;
        const path = this.workspacePathForCwd(cwd);
        if (path !== null) keys.add(normKey(path));
      }
    } catch {
      /* sessions service optional */
    }
    if (keys.size === 0) keys.add(normKey(this.activePath));
    return keys;
  }

  /** The known workspace whose path is the longest normalized prefix of cwd. */
  workspacePathForCwd(cwd) {
    const target = normPath(cwd).toLowerCase();
    let best = null;
    let bestLen = -1;
    for (const [key, path] of this.workspacePaths) {
      if (key.length > bestLen && (target === key || target.startsWith(key + "\\") || target.startsWith(key + "/"))) {
        best = path;
        bestLen = key.length;
      }
    }
    return best;
  }

  /** Display path for a workspace key, when known. */
  workspacePathForKey(key) {
    return this.workspacePaths.get(key) ?? this.projectServersByPath.get(key)?.path ?? null;
  }

  /**
  * The union mount set: every server any LIVE workspace wants, keyed by its
  * runtime serverName (globally unique — colliding project names are
  * workspace-qualified, so several workspaces' same-named servers coexist as
  * separate processes). Parallel sessions in different workspaces therefore
  * never stop each other's MCPs.
  *
  * - globals: one shared process, mounted when ANY live workspace enables it.
  * - project servers: one process per (workspace, server), each with its own
  *   config/cwd, mounted unless the owning workspace disables it.
  */
  unionMountSet(liveKeys) {
    const set = new Map();
    for (const [serverName, config] of this.globalServers) {
      let wanted = false;
      for (const key of liveKeys) {
        const path = this.workspacePathForKey(key);
        if (path !== null && !this.disabledSetFor(path).has(serverName)) {
          wanted = true;
          break;
        }
      }
      if (wanted) set.set(serverName, config);
    }
    for (const key of liveKeys) {
      const row = this.projectServersByPath.get(key);
      if (row === void 0) continue;
      const disabled = this.disabledSetFor(row.path);
      for (const [serverName, config] of row.servers) {
        const runtimeName = config.serverName ?? serverName;
        // Honor BOTH the qualified identity (new toggles) and the legacy plain
        // name (existing settings) so no migration is needed.
        if (disabled.has(runtimeName) || disabled.has(serverName)) continue;
        set.set(runtimeName, config);
      }
    }
    return set;
  }

  /** One serialized apply pass: reconcile every server against the disabled set. */
  applyState() {
    this.applyQueue = this.applyQueue.then(async () => {
      try {
        await this.applyStateNow();
      } catch (error) {
        this.ctx.logger?.warn(`dsh-mcp-manager: applyState failed: ${String(error)}`);
      }
    });
    return this.applyQueue;
  }

  async applyStateNow() {
    const liveKeys = this.liveWorkspaceKeys();
    const mountSet = this.unionMountSet(liveKeys);

    // 1) Manager-mounted fibers: unmount anything no live workspace wants;
    //    sweep orphaned child processes after.
    for (const serverName of [...this.fibers.keys()]) {
      if (mountSet.has(serverName)) continue;
      const fiber = this.fibers.get(serverName);
      const config = this.fiberConfigs.get(serverName);
      this.fibers.delete(serverName);
      this.fiberConfigs.delete(serverName);
      try {
        await fiber?.dispose();
      } catch (error) {
        this.ctx.logger?.warn(`dsh-mcp-manager: unmount ${serverName} failed: ${String(error)}`);
      }
      const marker = markerFor(config);
      if (marker !== null) scheduleOrphanSweep(marker);
    }

    // 2) Mount what live workspaces want and is not yet mounted.
    //    ctx.plugin() reads dependency metadata from `plugin.inject`, so the
    //    bare apply function is NOT enough: mcp-client injects the "tools"
    //    service, and without it every registration fails with
    //    "cannot get property \"tools\" without inject" (tools silently never
    //    registered while the connection stays up). Pass the full plugin
    //    object so Cordis resolves the injected services.
    const { apply: mcpClientApply, inject: mcpClientInject, Config: mcpClientConfig, name: mcpClientName } = await import(MCP_CLIENT);
    for (const [serverName, config] of mountSet) {
      if (this.fibers.has(serverName)) continue;
      try {
        const fiber = await this.ctx.plugin({
          apply: mcpClientApply,
          inject: mcpClientInject,
          Config: mcpClientConfig,
          name: mcpClientName,
        }, config);
        this.fibers.set(serverName, fiber);
        this.fiberConfigs.set(serverName, config);
      } catch (error) {
        this.ctx.logger?.warn(`dsh-mcp-manager: mount ${config?.serverName ?? serverName} failed: ${String(error)}`);
      }
    }

    // 3) Manual loader entries: keep mounted while ANY live workspace wants
    //    them (a shared process cannot be per-workspace); disable only when
    //    every live workspace disables the server (or none is live).
    for (const [serverName, entry] of this.loaderEntriesByServer()) {
      if (this.globalServers.has(serverName)) continue; // global now manager-owned
      let wanted = false;
      for (const key of liveKeys) {
        const path = this.workspacePathForKey(key);
        if (path !== null && !this.disabledSetFor(path).has(serverName)) {
          wanted = true;
          break;
        }
      }
      const shouldDisable = !wanted;
      if (entry.disabled !== shouldDisable) {
        try {
          await entry.update({ disabled: shouldDisable });
        } catch (error) {
          this.ctx.logger?.warn(`dsh-mcp-manager: ${shouldDisable ? "disable" : "enable"} ${serverName} failed: ${String(error)}`);
        }
        if (shouldDisable) {
          const marker = markerFor(entry.options?.config);
          if (marker !== null) scheduleOrphanSweep(marker);
        }
      }
    }
  }

  /**
  * Remember the focused workspace (display + no-session fallback). Mounting is
  * driven by the union of live workspaces (session events), so switching the
  * focused session does NOT stop another workspace's MCPs; the reconcile here
  * only matters for the no-session fallback path.
  */
  async activate(path) {
    if (typeof path !== "string" || path.trim().length === 0) return this.activePath;
    const next = normPath(path);
    if (normKey(next) === normKey(this.activePath)) return this.activePath;
    this.activePath = next;
    this.ctx.logger?.info(`dsh-mcp-manager: active workspace -> ${next}`);
    await this.applyState();
    return this.activePath;
  }

  /** Compose the inventory for one display workspace (does NOT mutate the active one). */
  async inventory(displayPath) {
    const context = displayPath ? normPath(displayPath) : this.activePath;
    const loaderEntries = this.loaderEntriesByServer();
    const disabled = this.disabledSetFor(context);
    const global = [];
    for (const [serverName, config] of this.globalServers) {
      global.push({
        serverName,
        transport: config.transport ?? "stdio",
        command: typeof config.command === "string" ? config.command : config.url ?? "",
        enabled: !disabled.has(serverName),
        mounted: this.fibers.has(serverName),
      });
    }
    global.sort((a, b) => a.serverName.localeCompare(b.serverName));

    const manual = [];
    for (const [serverName, entry] of loaderEntries) {
      if (this.globalServers.has(serverName)) continue;
      const config = entry.options?.config ?? {};
      manual.push({
        serverName,
        transport: config.transport ?? "stdio",
        command: typeof config.command === "string" ? config.command : config.url ?? "",
        enabled: !disabled.has(serverName),
        mounted: !entry.disabled,
      });
    }
    manual.sort((a, b) => a.serverName.localeCompare(b.serverName));

    const projects = [];
    for (const [key, { path, servers: map }] of this.projectServersByPath) {
      const isContext = key === normKey(context);
      const pDisabled = this.disabledSetFor(path);
      const rows = [];
      for (const [serverName, config] of map) {
        // Project rows expose their runtime identity (workspace-qualified for
        // colliding names like `codebase-xxsbm`); toggles and the mounted flag
        // use that identity.
        const runtimeName = config.serverName ?? serverName;
        rows.push({
          serverName: runtimeName,
          rawName: serverName,
          transport: config.transport,
          command: typeof config.command === "string" ? config.command : config.url ?? "",
          enabled: !(pDisabled.has(runtimeName) || pDisabled.has(serverName)),
          mounted: isContext && this.fibers.has(runtimeName),
        });
      }
      rows.sort((a, b) => a.serverName.localeCompare(b.serverName));
      projects.push({ path, current: isContext, servers: rows });
    }
    projects.sort((a, b) => (a.current ? -1 : 0) - (b.current ? -1 : 0) || a.path.localeCompare(b.path));

    // Skills visible to this workspace (unfiltered — disabled ones stay listed
    // so they can be re-enabled), with per-workspace enabled state. Discovered
    // directly from the same roots the per-agent skill-filesystem uses (the web
    // profile keeps the host skill provider disabled; presets own discovery).
    const skillDisabled = this.skillDisabledSetFor(context);
    const skills = (await this.discoverSkills(context)).map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      // The popup groups project-scoped and globally-scoped skills separately;
      // the host decides which is which so the client never parses source names.
      scope: String(skill.source ?? "").startsWith("project-") ? "project" : "global",
      enabled: !skillDisabled.has(skill.name),
    }));
    skills.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return {
      projectPath: this.projectPath,
      currentProject: context,
      activeWorkspace: this.activePath,
      writable: true,
      disabled: [...disabled].sort(),
      global,
      globalSource: this.globalSource,
      manual,
      projects,
      skills,
    };
  }

  /** Skill roots mirroring dsh-skill-filesystem's defaults for one workspace. */
  skillRoots(workspacePath) {
    return [
      { path: join(workspacePath, ".dsh", "skills"), source: "project-dsh" },
      { path: join(workspacePath, ".claude", "skills"), source: "project-claude" },
      { path: join(workspacePath, ".agents", "skills"), source: "project-agents" },
      { path: join(dshHome(), "skills"), source: "user-dsh" },
      { path: join(homedir(), ".claude", "skills"), source: "user-claude" },
      { path: join(this.agentsHome(), "skills"), source: "user-agents" },
    ];
  }

  agentsHome() {
    return process.env.DSH_AGENTS_HOME || join(homedir(), ".agents");
  }

  /** Discover skills for one workspace (name/description from SKILL.md frontmatter). */
  async discoverSkills(workspacePath) {
    const seen = new Map();
    for (const root of this.skillRoots(workspacePath)) {
      let entries;
      try {
        entries = await readdirWithTypes(root.path);
      } catch {
        continue; // absent root
      }
      for (const entry of entries) {
        let skillPath;
        if (entry.isDirectory()) skillPath = join(root.path, entry.name, "SKILL.md");
        else if (entry.isFile() && entry.name.endsWith(".md")) skillPath = join(root.path, entry.name);
        else continue;
        const parsed = parseSkillFile(skillPath);
        if (parsed === null || seen.has(parsed.name)) continue;
        seen.set(parsed.name, { ...parsed, source: root.source });
      }
    }
    return [...seen.values()];
  }

  registerRoutes() {
    this.disposers.push(
      this.ctx.webServer.register({
        kind: "exact",
        path: INVENTORY_PATH,
        handler: async (req, res) => {
          try {
            const query = new URL(req.url ?? "/", "http://localhost").searchParams;
            const active = query.get("active");
            this.rescanProjects(); // fresh workspace + .mcp.json state on every open
            sendJson(res, 200, await this.inventory(active ?? void 0));
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
          }
        },
      })
    );
    this.disposers.push(
      this.ctx.webServer.register({
        kind: "exact",
        path: ACTIVATE_PATH,
        handler: async (req, res) => {
          try {
            const body = await readBody(req);
            this.rescanProjects();
            const active = await this.activate(body?.path);
            sendJson(res, 200, { ok: true, currentProject: active });
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
          }
        },
      })
    );
    this.disposers.push(
      this.ctx.webServer.register({
        kind: "exact",
        path: SET_PATH,
        handler: async (req, res) => {
          try {
            const body = await readBody(req);
            const result = await this.set(body?.path, body?.kind, body?.name, body?.enabled === true);
            sendJson(res, 200, result);
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
          }
        },
      })
    );
  }

  registerSettings() {
    // Prefer this plugin's own state file; seed it once from the legacy `mcp`
    // settings section so existing per-workspace toggles survive the upgrade.
    let loaded = null;
    try {
      if (existsSync(statePath())) loaded = normalizeState(JSON.parse(readFileSync(statePath(), "utf8")));
    } catch (error) {
      this.ctx.logger?.warn(`dsh-mcp-manager: unreadable state file: ${String(error)}`);
    }
    if (loaded === null) {
      loaded = normalizeState(readLegacySection() ?? { projects: [] });
      this.state = loaded;
      try {
        this.persistState();
      } catch (error) {
        this.ctx.logger?.warn(`dsh-mcp-manager: could not seed state file: ${String(error)}`);
      }
      return;
    }
    this.state = loaded;
  }

  /** Write the current in-memory state to the plugin's own state file. */
  persistState() {
    const target = statePath();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(this.state, null, 2) + "\n", "utf8");
  }

  async start() {
    this.loadGlobal();
    this.rescanProjects();
    this.registerSettings();
    this.registerRoutes();
    // Union mounting follows LIVE sessions: opening/closing a session mounts/
    // unmounts that workspace's MCP set without disturbing other workspaces'.
    // Events bubble to the app root, so listen there (the manager's context is
    // a sibling of the sessions service).
    const onRoot = (event, handler) => {
      const off = this.ctx.root?.on?.(event, handler);
      if (typeof off === "function") this.disposers.push(off);
    };
    onRoot("session/created", () => this.applyState());
    onRoot("session/disposed", () => this.applyState());
    // Per-session MCP tool filter: a session only ever receives its OWN
    // workspace's project MCP tools (mcp__<ownWorkspace>__*) plus globals and
    // manual entries — never another live workspace's (mcp__<other>__*).
    onRoot("system-prompt/assemble", async (assembly, context, next) => {
      const assembled = await next();
      const cwd = context?.scope?.session?.header?.cwd;
      const slug = typeof cwd === "string" && cwd.length > 0 ? this.slugForCwd(cwd) : null;
      if (slug === null || this.workspaceSlugSet?.size === 0) return assembled;
      assembled.tools = assembled.tools.filter((tool) => this.toolVisibleTo(tool.name, slug));
      return assembled;
    });
    this.ctx.effect(() => () => {
      for (const dispose of this.disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* disposal best effort */
        }
      }
      for (const [serverName, fiber] of this.fibers) {
        fiber.dispose().catch(() => {});
        const marker = markerFor(this.fiberConfigs.get(serverName));
        if (marker !== null) scheduleOrphanSweep(marker);
      }
      this.fibers.clear();
      this.fiberConfigs.clear();
    }, "dsh-mcp-manager: teardown");
    await this.applyState();
  }
}

export async function apply(ctx) {
  const manager = new McpManager(ctx);
  ctx.provide("mcpManager", manager);
  // Claude-Code skill roots (see lib/skill-roots.js): a nested inject() fiber
  // keeps the MCP manager itself independent of profiles that do not mount the
  // skill registry.
  ctx.inject(["skills"], function claudeSkillRoots(skillsCtx) {
    registerClaudeSkillRoots(skillsCtx);
  });
  // Per-workspace skill filtering (see lib/skill-filter.js): the 0.2.x
  // replacement for the old dsh-tool-skill core patch. Installed from an
  // injected fiber for the same reason, and owned by that fiber so disposing
  // the plugin restores the original service methods.
  ctx.inject(["skills"], function mcpManagerSkillFilter(skillsCtx) {
    skillsCtx.effect(() => installSkillFilter(manager, skillsCtx), "dsh-mcp-manager: skill filter");
  });
  await manager.start();
  ctx.logger?.info(
    `dsh-mcp-manager: active=${manager.activePath} global=${manager.globalServers.size} projects=${manager.projectServersByPath.size}`
  );
}
