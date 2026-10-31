# dsh-mcp-manager

English | [中文](README.zh.md) · [![npm](https://img.shields.io/npm/v/@gyp8735abc/dsh-mcp-manager)](https://www.npmjs.com/package/@gyp8735abc/dsh-mcp-manager) · [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A **per-workspace** MCP and skill manager for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

One button on each workspace row opens a popup where you decide which MCP servers and which
skills that workspace gets. Global MCP, project MCP and skills all switch **independently per
workspace**.

## The problem it solves

DSH's own MCP configuration is **profile-wide**: whatever is in `mcp:` applies to every
workspace and every session. In daily use that means:

- `codebase` is useful in project A and in project B, but the two projects keep different
  `.codebase/codebase.db` files — one global config can only point at one of them.
- You keep five MCP servers around, but this workspace needs one. The other four hold their
  processes open and stuff the tool list, so the model picks the wrong tool more often.
- The same for skills: the dozens under `~/.claude/skills` show up in every session although
  only a couple of workspaces really want them.

This plugin moves the switches down to the **workspace** layer:

| Object | Source | Switch granularity |
|---|---|---|
| Global MCP | `mcpServers` in `~/.claude.json` | per workspace |
| Project MCP | the workspace's own `.mcp.json` | per workspace |
| Manual MCP | hand-written `dsh-mcp-client` rows in the profile | per workspace |
| Skills | `.dsh/skills`, `.claude/skills`, `.agents/skills`, `~/.dsh/skills`, `~/.claude/skills`, `~/.agents/skills` | per workspace |

## Features

- **One popup for everything** — grouped into project MCP / global MCP / manual MCP / project
  skills / global skills, one switch per row, with `Enabled`/`Disabled` and
  `Connected`/`Not connected` shown inline.
- **Real per-workspace isolation** — the state key is the workspace path; a server you turn
  off in A stays on in B.
- **Union mounting** — every workspace with a live session keeps its own MCP servers mounted,
  one process per (workspace, server) with its own config and `cwd`. Focusing or switching a
  session never stops another workspace's servers; a workspace's servers unload with its last
  session.
- **Session-scoped tool filtering** — only this workspace's `mcp__<workspace>__*` tools plus
  global/manual ones reach the current session, so another live workspace's tools never leak in.
- **Skills filtered the same way** — a disabled skill disappears from the model's catalog and
  from `/name` injection, and a direct `skill` tool call is refused with an explicit reason.
- **Claude Code skill compatibility** — project `.claude/skills` and user `~/.claude/skills`
  are scanned, including `SKILL.md` files without YAML frontmatter.
- **Dynamic rescan** — every popup open re-reads the workspace list and each workspace's
  `.mcp.json`, so new workspaces and edited configs apply without restarting DSH.
- **Zero core patches** — nothing inside the DSH installation is modified; installing or
  removing the plugin only touches the profile and `$DSH_HOME`.
- **Bilingual UI** — follows the DSH interface language (English / 简体中文).

## Install

### Option 1: plugin market (two steps)

1. Open **Plugins → Discover → Add index source** and enter:

   ```
   https://gyp8735abc.github.io/dsh-mcp-manager/index.json
   ```

2. Search for `MCP manager`, open the entry, press **Install**.

> Market indexes are unsigned; titles, authors and sources are publisher claims. Only add
> index sources you trust, and check in the confirmation dialog that the source is
> `@gyp8735abc/dsh-mcp-manager`.

### Option 2: one command

```sh
dsh plugin --profile web add @gyp8735abc/dsh-mcp-manager
```

The package is also a DSH bundle (`dsh.bundle.patch`), so the plugin row is inserted into the
profile composition automatically — no hand-written `cordis.patch.yml` needed.

### Option 3: from source

```sh
git clone https://github.com/gyp8735abc/dsh-mcp-manager.git
cd dsh-mcp-manager
dsh plugin --profile web add .
```

### Verify

```sh
dsh --profile web --dump-config | grep -A 3 dsh-mcp-manager
```

Seeing `id: dsh-mcp-manager` means it is in the composition tree. Then **restart `dsh web`**
and hard-reload the browser (`Ctrl+Shift+R`) — the client bundle is injected at startup only.

After that, every workspace row gains a plug icon to the left of its `⋯` menu.

## Usage

The popup shows:

```
┌ MCP & skills ───────────────────────────────┐
│ Workspace  D:\ai-workspace   Active          │
│                                              │
│ Project MCP (.mcp.json)                      │
│   ● codebase      stdio   Enabled  Connected │
│   ○ e2e-runner    stdio   Disabled —         │
│                                              │
│ Global MCP (~/.claude.json)                  │
│   ● everything-search  http  Enabled Connected│
│                                              │
│ Manual MCP (profile)                         │
│   ○ codegraph     stdio   Disabled —         │
│                                              │
│ Project skills (this workspace)              │
│   ● officecli  .dsh    Enabled               │
│   ○ probe      .claude Disabled              │
│                                              │
│ Global skills (all workspaces)               │
│   ● diagnose-windows-sandbox-acl  ~/.dsh     │
└──────────────────────────────────────────────┘
```

- **Active workspace** (noted at the top): toggles apply **immediately** — enabling connects the
  process and registers its tools, disabling disconnects and unmounts them.
- **Not the active workspace**: toggles only save state; the servers mount when that workspace
  gets a session.
- Empty groups are hidden; a workspace with nothing to show gets an empty-state hint.
- Project servers carry a workspace prefix at runtime: `codebase` in workspace A becomes
  `a__codebase`, and the model sees `mcp__a__codebase__search_code`. That is what lets two
  workspaces' same-named servers coexist as separate processes instead of shadowing each other.

## State

`$DSH_HOME/mcp-manager/state.json` (`$DSH_HOME` defaults to `~/.dsh`):

```json
{
  "projects": [
    {
      "path": "D:\\ai-workspace",
      "disabled": ["dsh-mcp-manager__codebase"],
      "disabledSkills": ["office"]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `path` | Absolute workspace path (identity key) |
| `disabled` | MCP runtime names disabled in this workspace; project servers use the workspace-qualified name (`<slug>__<name>`), global/manual servers their plain name |
| `disabledSkills` | Skill names disabled in this workspace |

- On first start the legacy `mcp:` section of `$DSH_HOME/settings.yaml` is imported once.
- Both qualified and legacy plain names (`codebase`) are honoured in `disabled`, so old lists
  keep working.
- Editing the file by hand takes effect on restart or on the next popup open.

### HTTP API

The popup uses three same-origin endpoints, which you can also call yourself:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/dsh-mcp-manager/inventory?active=<workspace path>` | Full inventory for one workspace (MCP groups, skills, connection state) |
| `POST` | `/api/dsh-mcp-manager/activate` | `{ "path": "..." }` — remember the focused workspace |
| `POST` | `/api/dsh-mcp-manager/set` | `{ "path": "...", "kind": "mcp"\|"skill", "name": "...", "enabled": true }` |

## Mounting semantics

- **Union model**: the mount set is the union of what every workspace with a live session wants.
  With no live session it falls back to the focused workspace's set.
- **Process granularity**: one process per (workspace, server) for project servers, with `cwd`
  defaulting to the workspace directory — so relative paths such as `.codebase/codebase.db`
  land in their own workspace.
- **Global servers**: one shared process, mounted while any live workspace enables it.
- **Manual servers** (hand-written `dsh-mcp-client` rows): kept enabled while any live workspace
  wants them, because one loader row can only own one process.
- **Unmount**: a workspace's dedicated processes are disposed after its last session closes, and
  the manager sweeps leftover child processes by their command-line signature.
- **Orphans**: when a managed server is disabled or unmounted, a sweep kills leftover children
  so stdio servers do not survive as stray processes.

## Skills

- Roots are merged with **lowest rank winning**, one entry per skill name:

  | Order | Root | Source tag |
  |---|---|---|
  | 1 | `<workspace>/.dsh/skills` | `project-dsh` |
  | 2 | `<workspace>/.claude/skills` | `project-claude` |
  | 3 | `<workspace>/.agents/skills` | `project-agents` |
  | 4 | `~/.dsh/skills` | `user-dsh` |
  | 5 | `~/.claude/skills` | `user-claude` |
  | 6 | `~/.agents/skills` | `user-agents` |

  The `.claude` roots and the frontmatter-less parser are added through
  `ctx.skills.registerProvider()` — the same public seam the shipped provider uses — so no core
  package is patched.
- A skill is `<dir>/SKILL.md` or a bare `.md` file directly under a root. Without frontmatter the
  directory name becomes the skill name and the first body line the description (the usual Claude
  Code shape).
- A disabled skill takes effect in three places: the session catalog stops listing it,
  `/skill-name` is no longer injected, and the `skill` tool refuses it with an explicit
  “disabled for this workspace” message.

## Compatibility

| Item | Requirement |
|---|---|
| DSH | `>=0.2.0-rc.2 <0.3.0` (checked against the running version at install time) |
| Node.js | `>=22` |
| Surface | Web only (`dsh web` and the desktop GUI's web view); `headless` / `acp` have no UI entry |

The only runtime dependencies are packages that ship with the DSH installation
(`@deepseek-ai/dsh-mcp-client` etc.); the plugin itself has none.

## Known limitations

- **No skill file watcher** — a skill added to `.claude/skills` while DSH is running appears after
  a restart (existing and project skills all load at startup).
- **The workspace button is DOM-injected** — DSH 0.2.x declares slots for session rows only, so
  the button is inserted with a `MutationObserver` and re-added after re-renders. If it does not
  show up, first check that the DSH version is inside `>=0.2.0-rc.2 <0.3.0`.
- **The skill filter patches a prototype** — it affects every consumer of the skill service (for
  example a skill picker UI). That is intended: the switch is per workspace and every lookup
  carries the `cwd`.
- **State is not in the DSH settings page** — DSH 0.2.x no longer lets a plugin claim an arbitrary
  settings namespace, so the switches live in the plugin's own `state.json`.
- **Non-active workspaces only save state** — they do not spawn processes eagerly, which keeps
  unused workspaces from holding servers open.

## Security

- The plugin spawns the **stdio commands** declared in project `.mcp.json` files and
  `~/.claude.json` — that is the same trust you would give that configuration. Only use it with
  repositories and configs you trust.
- The three HTTP endpoints are **unauthenticated**; the design assumes `dsh web` listens on
  loopback only (the default `127.0.0.1`). With `--host 0.0.0.0`, anyone who can reach the port
  can toggle your MCP servers.
- The plugin never modifies the DSH installation and never writes `settings.yaml`; its only write
  is `$DSH_HOME/mcp-manager/state.json`.

## Development

```sh
node --check lib/index.js        # host: inventory, per-workspace state, union mounting, routes
node --check lib/skill-filter.js # skill filter (SkillRegistry prototype + tools.guard)
node --check lib/skill-roots.js  # Claude skill-root provider
node --check client/client.js    # browser bundle (ModuleLoader factory form)

npm run pack:check               # verify the npm package contents (run before publishing)
npm run market:index             # regenerate docs/index.json
```

| Path | Purpose |
|---|---|
| `lib/index.js` | Host: state, `inventory` / `activate` / `set`, union mounting, session tool filtering |
| `lib/skill-filter.js` | Per-workspace skill filtering (catalog, injection, tool call) |
| `lib/skill-roots.js` | `.claude` roots and frontmatter-less `SKILL.md` parsing |
| `client/client.js` | Browser half: workspace-row button and the popup (English / 中文) |
| `cordis.patch.yml` | Bundle patch that inserts the plugin row |
| `locale/{en,zh}.json` | Title/description shown on the Plugins page |
| `docs/index.json` | Plugin market index (format 1), served from GitHub Pages |
| `docs/PUBLISHING.md` | Release process (npm, GitHub, market index) |

The browser half is a **hand-written ModuleLoader bundle**
(`window.__ModuleLoader__.load({ factory })`) with no build step — edit and reload the page.

## Publishing

See [docs/PUBLISHING.md](docs/PUBLISHING.md).

## License

[MIT](LICENSE)
