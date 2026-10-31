# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-11-01

First public release, as `@gyp8735abc/dsh-mcp-manager`.

### Added

- Per-workspace MCP switching: a popup on each workspace row lists that
  workspace's own `.mcp.json` servers, the global servers from `~/.claude.json`,
  profile-declared ("manual") servers, and the skills visible to the workspace,
  each with its own switch.
- Per-workspace skill switching, enforced for the model through a
  `SkillRegistry` prototype filter plus a `tools.guard()` refusal.
- Union mounting: every workspace with a live session keeps its MCP servers
  mounted, one process per (workspace, server); focusing another session never
  stops them, and a workspace's servers unload with its last session.
- Session-scoped tool filtering, so another live workspace's `mcp__*` tools never
  reach the current session.
- Claude Code compatibility: project `.claude/skills` and user `~/.claude/skills`
  roots, including `SKILL.md` files without YAML frontmatter.
- Dynamic rescan on every popup open, so workspaces and `.mcp.json` edits apply
  without restarting.
- `GET /api/dsh-mcp-manager/inventory`, `POST /api/dsh-mcp-manager/activate` and
  `POST /api/dsh-mcp-manager/set` endpoints.
- Plugin market index entry (`docs/index.json`) for one-click installs from the
  Plugins → Discover tab.

### Changed

- State moved out of the DSH settings namespace into
  `$DSH_HOME/mcp-manager/state.json`; the legacy `mcp:` settings section is
  imported once on first start.
- No core package is patched any more: the workspace-row button, the Claude skill
  roots and the skill filter are all implemented through public seams
  (`MutationObserver` DOM injection, `ctx.skills.registerProvider()`,
  `SkillRegistry.prototype`).

### Known limitations

- No filesystem watcher for skills; a skill added while DSH runs appears after a
  restart.
- The workspace-row button is injected into the sidebar DOM, because DSH 0.2.x
  declares slots for session rows only.
