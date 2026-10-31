# dsh-mcp-manager → DSH 0.2.0-rc.2 (packaged desktop app) port notes

This directory is a **ported copy** of `C:\Users\gyp87\.dsh\mcp-manager`
(v0.1.0, written against a source build of DSH 0.1.3-alpha.2). The original is
left untouched as the backup.

## Why a port was needed

The original plugin's host half depended on three patches applied to *core*
packages by `re-patch.mjs`:

| # | Legacy core patch | Target |
|---|---|---|
| 1 | per-workspace-row "MCP" button | `dsh-client-ui-workspace/lib/client.js` |
| 2 | `.claude/skills` roots + frontmatter-less `SKILL.md` | `dsh-skill-filesystem/lib/index.js` |
| 3 | per-workspace skill filtering (3 sites) | `dsh-tool-skill/lib/index.js` |

In the packaged desktop app every one of those packages lives **inside
`resources/app.asar`** (121 MB). Editing them means repacking the archive, which
breaks on every app update. This port therefore re-implements all three on
public seams, and changes nothing outside the plugin directory and `~/.dsh`.

## Legacy patch → port mapping

| Legacy behaviour | New mechanism | Where |
|---|---|---|
| Patch 1: row button | the client half injects the button into each row's `.rowActions`; rows carry `data-row-key="workspace:<workspaceId>"`, mapped to its path through the client `workspaces` list. The icon is an inline SVG **plug seated in a rounded frame that opens on its right edge where the cord leaves** (the cord/plug concept, drawn on the icons' own 16-unit grid in `currentColor`: stroked frame and leads at 1px, solid plug body), so it needs nothing from the shipped primitives bundle | `client/client.js` |
| Patch 2: project `~/.claude/skills` roots | plugin-owned skill provider via `ctx.skills.registerProvider()` (the same seam `dsh-skill-filesystem` itself uses) | `lib/skill-roots.js` |
| Patch 2: frontmatter-less `SKILL.md` | parsed by that provider (name = `<dir>/SKILL.md` parent, else file stem; description = first non-empty line with `#` stripped) | `lib/skill-roots.js` |
| Patch 3 (sites 2+3): catalog + `/name` injection | `SkillRegistry.prototype.snapshot`/`get` filtered per workspace | `lib/skill-filter.js` |
| Patch 3 (site 1): `skill` tool execute | `ctx.tools.guard()` denying with `skill "<name>" is disabled for this workspace` | `lib/skill-filter.js` |
| `~/.dsh/settings.yaml` `mcp` namespace | plugin-owned `~/.dsh/mcp-manager/state.json`, seeded once from the legacy `mcp` section | `lib/index.js` |

### Rank mapping (patch 2)

The shipped provider wins a same-named skill by **lowest** `rank` within one
scope layer (`dsh-skill` sorts `rank asc || providerOrder || localOrder`).
Legacy rank 150 for project `.claude/skills` was written for a
higher-rank-wins reading, so it is re-expressed as **250** — still losing to
`project-dsh` 100 and `project-agents` 200, still beating `custom` 300 and every
user root. User `~/.claude/skills` keeps **450** (between `user-dsh` 400 and
`user-agents` 500). See `lib/skill-roots.js` lines 14–29.

## Other compatibility changes

- `peerDependencies`: `@deepseek-ai/dsh-mcp-client` was pinned to `0.1.0-rc.7`.
  DSH evaluates every `@deepseek-ai/dsh*` peer against the runtime and **skips**
  a bundle whose peers do not satisfy it, so it now reads
  `">=0.2.0-rc.2 <0.3.0"`. `@deepseek-ai/schemastery` was dropped entirely — it
  was only used by the removed settings schema.
- `ctx.settings.register(ns, schema)` **no longer exists**: a settings namespace
  is now a composed profile entry id and its schema is that entry's `Config`, so
  a plugin cannot claim an arbitrary namespace. Hence the state file.
- `version` bumped to `0.2.0-port.1` so the two builds are distinguishable.

## Why the skill filter patches the *prototype*, not the service object

`ctx.skills` is a per-context facade that resolves each method from the
prototype on every access (`ctx.skills.snapshot === ctx.skills.snapshot` is
`false`). Assigning to the service instance is therefore never observed by
callers — measured in the sandbox, not assumed. Patching
`SkillRegistry.prototype` is what that facade picks up, and it covers every
consumer at once (the `skill` tool's lookup, the `/name` pre-step injection, and
the session catalog message). The patch is undone on plugin disposal.

## Verification performed (all in a sandboxed `DSH_HOME` under this workspace)

1. **Composition** — `dsh --profile web --dump-config` contains the plugin and
   reports no skipped bundles.
2. **Boot** — `dsh --profile web` starts with `dsh-mcp-manager` activated and no
   `entry did not activate` line.
3. **Host API** — `GET /api/dsh-mcp-manager/inventory` answers `200` and scans
   the workspace's skills.
4. **Client half** — `dsh-mcp-manager/client.js` appears in the browser client
   module graph served to the page.
5. **Row button** — a DOM harness loads the real bundle and asserts 13
   behaviours: correct row→path mapping, first child of `.rowActions`, sibling
   class reuse, MCP label, icon rendered, event detail, no bubbling, idempotent
   re-injection, removal on disposal (`_clienttest/run.mjs`).
6. **Skill filter** — 22 assertions against a fake registry plus a real-runtime
   probe: with `diagnose-windows-sandbox-acl` disabled for `D:\ai-workspace`,
   the real catalog for that workspace **omits** it while a lookup without a
   matching workspace **keeps** it, and `get()` returns `undefined` for it
   (`_clienttest/skillfilter.test.mjs`).
7. **Claude skill roots** — the real catalog for `D:\ai-workspace` returns 19
   skills with `provider: "claude-roots"`, including all 15 skills under
   `C:\Users\gyp87\.claude\skills` plus the frontmatter-less and loose-`.md`
   fixtures; precedence resolves `agents-probe`/`officecli`/`caveman` to
   `.agents/skills`/`.dsh/skills`/`user-dsh` respectively, never to `.claude`.

## Behaviour fixes over the original

1. **Global MCP is read from Claude's own config.** The original read only
   `$DSH_HOME/mcp.claude.json`, a file that `$DSH_HOME/bin/dsh-mcp-sync.mjs`
   generates from `~/.claude.json` — and which the packaged app never produces,
   so the popup showed no global servers at all. `loadGlobal()` now reads both:
   the generated list first (still honoured if present), then
   `~/.claude.json`'s `mcpServers` (or `$CLAUDE_CONFIG_DIR/.claude.json`),
   normalised with the same `.mcp.json` conversion the project roots use. The
   live file wins a same-named server, so editing Claude's config is enough and
   no sync step can be forgotten. The inventory reports where the list came from
   (`globalSource`).
2. **Project and global skills are listed separately.** Every skill row now
   carries `scope` (`project` for the workspace's `.dsh/.claude/.agents` roots,
   `global` for the user-wide `~/.dsh`, `~/.claude`, `~/.agents` roots), and the
   popup renders two groups — 项目技能（本工作区）and 全局技能（所有工作区）— with an
   empty group dropped. Each row also shows the exact root it came from
   (`.dsh` / `.claude` / `.agents` / `~/.dsh` / `~/.claude` / `~/.agents`)
   instead of a generic `skill` badge.

## Known limitations

1. **No filesystem watcher.** The shipped provider has a chokidar watcher; this
   provider does not, so a skill added to `.claude/skills` **while dsh is
   running** appears only after the app restarts. The 15 existing user skills
   and all project skills load at boot. (`chokidar` resolves in this runtime, so
   a watcher calling `control.invalidate()` is a contained follow-up.)
2. **The row button is DOM-injected**, because 0.2.x declares no slot for
   workspace-row actions (only session-row ones). React can drop the injected
   node on a re-render; a `MutationObserver` plus a 1.5 s sweep re-adds it.
3. **The skill filter is a prototype patch**, so it also affects non-session
   consumers of the skill service (for example a skill picker UI) — intended,
   since the switch is per workspace and the lookup carries `cwd`.
4. **The state file replaces the settings namespace**, so the values no longer
   appear in DSH's own settings UI. Migration from the legacy `mcp` section is
   automatic on first start.
