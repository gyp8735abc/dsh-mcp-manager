// dsh-mcp-manager — per-workspace skill filtering (0.2.x host half).
//
// The original plugin got this by patching three sites in the core package
// `dsh-tool-skill`. Those packages now live inside the application's sealed
// `app.asar`, so the same behaviour is installed from the plugin instead, by
// patching the `SkillRegistry` prototype that `dsh-skill` serves:
//
//   * `snapshot()`/`list()` feed the session's skill catalog message
//     (dsh-tool-skill's `agent/pre-step` listener) and the `skill` tool's
//     lookup, so a disabled skill disappears from both the model's catalog and
//     its own tool lookups;
//   * `get()` feeds the `/name` user invocation and the tool's content read, so
//     a disabled skill can neither be injected nor loaded;
//   * `tools.guard()` runs before the `skill` tool's `execute`, so a direct call
//     is refused with a message that says *why* rather than the tool's generic
//     "unknown or no longer available".
//
// Why the prototype and not the service object: `ctx.skills` is a per-context
// facade that resolves each method from the prototype on every access (two
// reads of `ctx.skills.snapshot` are not the same function). Assigning to the
// service instance is therefore never observed by callers — measured, not
// assumed — while a prototype patch is what that facade picks up.
//
// The filter is keyed by the lookup's `cwd`: DSH passes the owning session's
// `header.cwd` on every skill lookup, which is exactly the workspace this
// plugin's state is keyed by. A lookup without a `cwd`, or one matching no
// configured workspace, is never filtered.

/**
 * Install the per-workspace skill filter.
 * @param manager - the McpManager instance (supplies `isSkillDisabled`).
 * @param context - the context to install from; pass the `skills`-injected fiber
 *   context so the service is guaranteed to exist (defaults to the manager's).
 * @returns a disposer that restores the prototype methods and unregisters the guard.
 */
export function installSkillFilter(manager, context = manager.ctx) {
  const ctx = context;
  const skills = ctx.get?.("skills", false) ?? ctx.skills ?? null;
  if (skills === null || typeof skills !== "object") {
    ctx.logger?.warn("dsh-mcp-manager: skills service unavailable; per-workspace skill filtering is off");
    return () => {};
  }
  const registry = Object.getPrototypeOf(skills);
  const originalSnapshot = registry?.snapshot;
  const originalGet = registry?.get;
  if (typeof originalSnapshot !== "function" || typeof originalGet !== "function") {
    ctx.logger?.warn("dsh-mcp-manager: unexpected skills service shape; per-workspace skill filtering is off");
    return () => {};
  }

  // `list()` delegates to `this.snapshot`, so patching `snapshot` covers both.
  registry.snapshot = async function snapshot(options = {}) {
    const snapshotValue = await originalSnapshot.call(this, options);
    if (snapshotValue === null || typeof snapshotValue !== "object" || !Array.isArray(snapshotValue.skills)) {
      return snapshotValue;
    }
    const cwd = options?.cwd;
    const kept = snapshotValue.skills.filter((skill) => manager.isSkillDisabled(cwd, skill?.name) !== true);
    if (kept.length === snapshotValue.skills.length) return snapshotValue;
    return { ...snapshotValue, skills: kept };
  };
  registry.get = async function get(name, options = {}) {
    if (manager.isSkillDisabled(options?.cwd, name) === true) return undefined;
    return originalGet.call(this, name, options);
  };

  let offGuard = null;
  const tools = ctx.get?.("tools", false) ?? ctx.tools ?? null;
  if (tools !== null && typeof tools.guard === "function") {
    offGuard = tools.guard((execution) => {
      if (execution?.name !== "skill") return undefined;
      const name = execution.arguments?.name;
      if (typeof name !== "string" || name.length === 0) return undefined;
      const cwd = execution.agent?.session?.header?.cwd;
      if (manager.isSkillDisabled(cwd, name) !== true) return undefined;
      return `skill "${name}" is disabled for this workspace`;
    });
  } else {
    ctx.logger?.warn("dsh-mcp-manager: tools.guard unavailable; a disabled skill is refused by lookup only");
  }

  return () => {
    registry.snapshot = originalSnapshot;
    registry.get = originalGet;
    if (typeof offGuard === "function") offGuard();
  };
}
