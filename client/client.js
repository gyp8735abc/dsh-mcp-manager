// dsh-mcp-manager — browser half (hand-built ModuleLoader bundle).
//
// MCP + skills management in a popup opened from each workspace's MCP button
// (added to dsh-client-ui-workspace's workspace row, next to the "..." menu).
// The popup shows that workspace's own project servers, the global servers,
// manual servers, and the available skills — with PER-WORKSPACE enable/disable
// for everything. State is stored per workspace (settings ns `mcp`) by the
// host; toggles go through POST /api/dsh-mcp-manager/set, which persists and
// live-applies (MCP mounting follows the active workspace; the model-facing
// skill catalog is filtered so sessions only see enabled skills).
//
// Rendering is deliberately IMPERATIVE: the window event listener is attached
// in apply() and the popup is rendered with react-dom createRoot into a
// container on document.body — no slot mounting, no external CSS classes.
window.__ModuleLoader__.load({
  id: "dsh-mcp-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");
    // NOTE: @deepseek-ai/dsh-client-runtime was removed on harness master
    // (0.1.3-alpha.2) and the variable was never used anyway.
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    let ReactDOM = require("react-dom");
    let ReactDOMClient = require("react-dom/client");

    const NS = "mcp";
    const INVENTORY_URL = "/api/dsh-mcp-manager/inventory";
    const ACTIVATE_URL = "/api/dsh-mcp-manager/activate";
    const SET_URL = "/api/dsh-mcp-manager/set";
    const OPEN_EVENT = "dsh-mcp-manager:open-workspace";
    // Short root names for the host's skill `source` values, so a row says where
    // the skill actually lives instead of a bare "skill" badge.
    const SOURCE_TAGS = {
      "project-dsh": ".dsh",
      "project-claude": ".claude",
      "project-agents": ".agents",
      "user-dsh": "~/.dsh",
      "user-claude": "~/.claude",
      "user-agents": "~/.agents",
    };
    const inject = ["locale", "sessions", "workspaces"];

    const zh = {
      title: "MCP 与技能",
      path: "工作区",
      activeNote: "当前工作区 — MCP 切换立即生效",
      inactiveNote: "非当前工作区 — 开关保存状态，切换到这个工作区时生效",
      groupGlobal: "全局 MCP（~/.claude.json）",
      groupProject: "项目 MCP（.mcp.json）",
      groupManual: "手动 MCP（profile 配置）",
      groupSkills: "技能（skills）",
      groupProjectSkills: "项目技能（本工作区）",
      groupGlobalSkills: "全局技能（所有工作区）",
      enabled: "已启用",
      disabled: "已停用",
      mounted: "已连接",
      unmounted: "未连接",
      loading: "加载中…",
      error: "无法读取配置",
      empty: "这个工作区没有可用的 MCP 或技能",
      close: "关闭",
    };
    const en = {
      title: "MCP & skills",
      path: "Workspace",
      activeNote: "Active workspace — MCP toggles apply immediately",
      inactiveNote: "Not the active workspace — toggles save state and apply when this workspace becomes active",
      groupGlobal: "Global MCP (~/.claude.json)",
      groupProject: "Project MCP (.mcp.json)",
      groupManual: "Manual MCP (profile)",
      groupSkills: "Skills",
      groupProjectSkills: "Project skills (this workspace)",
      groupGlobalSkills: "Global skills (all workspaces)",
      enabled: "Enabled",
      disabled: "Disabled",
      mounted: "Connected",
      unmounted: "Not connected",
      loading: "Loading…",
      error: "Failed to read configuration",
      empty: "No MCP or skills available for this workspace",
      close: "Close",
    };

    const h = React.createElement;

    function baseName(p) {
      const parts = String(p ?? "").split(/[\\/]/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : String(p ?? "");
    }

    function samePath(a, b) {
      if (!a || !b) return false;
      return String(a).replace(/\\/g, "/").toLowerCase() === String(b).replace(/\\/g, "/").toLowerCase();
    }

    // ---- inline styles (no dependency on external CSS classes) ----
    const S = {
      overlay: {
        position: "fixed",
        inset: "0",
        zIndex: "10000",
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "inherit",
      },
      dialog: {
        background: "var(--dsw-alias-bg-layer-2, #202024)",
        color: "var(--dsw-alias-label-primary, #eee)",
        borderRadius: "12px",
        padding: "20px",
        width: "620px",
        maxWidth: "92vw",
        maxHeight: "82vh",
        overflow: "auto",
        boxShadow: "0 8px 40px rgba(0,0,0,0.4)",
        flexDirection: "column",
        gap: "10px",
        display: "flex",
      },
      title: { margin: "0", fontSize: "16px", fontWeight: "600" },
      path: { margin: "0", fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #999)", wordBreak: "break-all" },
      note: { margin: "0", fontSize: "12px", color: "var(--dsw-alias-state-success-primary, #4ade80)" },
      noteInactive: { margin: "0", fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #999)" },
      group: { margin: "10px 0 4px", fontSize: "13px", fontWeight: "600", color: "var(--dsw-alias-label-secondary, #bbb)" },
      row: {
        border: "1px solid var(--dsw-alias-border-l2, #333)",
        borderRadius: "10px",
        alignItems: "center",
        gap: "10px",
        padding: "7px 12px",
        display: "flex",
      },
      rowName: { fontSize: "13px", fontWeight: "500", minWidth: "0" },
      rowMeta: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "280px" },
      badge: { border: "1px solid var(--dsw-alias-border-l3, #444)", color: "var(--dsw-alias-label-secondary, #bbb)", borderRadius: "4px", padding: "0 5px", fontSize: "10px", flex: "none" },
      badgeMounted: { border: "1px solid var(--dsw-alias-state-success-primary, #22c55e)", color: "var(--dsw-alias-state-success-primary, #22c55e)", borderRadius: "4px", padding: "0 5px", fontSize: "10px", flex: "none" },
      badgeUnmounted: { border: "1px solid var(--dsw-alias-border-l3, #444)", color: "var(--dsw-alias-label-tertiary, #999)", borderRadius: "4px", padding: "0 5px", fontSize: "10px", flex: "none" },
      spacer: { flex: "1" },
      switch: {
        boxSizing: "border-box",
        width: "32px",
        height: "18px",
        borderRadius: "9px",
        border: "1px solid var(--dsw-alias-border-l2, #333)",
        background: "var(--dsw-alias-bg-layer-3, #2a2a2e)",
        cursor: "pointer",
        position: "relative",
        flex: "none",
        padding: "0",
      },
      switchOn: { background: "var(--dsw-alias-state-success-primary, #22c55e)", borderColor: "transparent" },
      knob: {
        position: "absolute",
        top: "2px",
        left: "2px",
        width: "12px",
        height: "12px",
        borderRadius: "50%",
        background: "var(--dsw-alias-label-tertiary, #999)",
        transition: "transform .15s",
      },
      knobOn: { transform: "translateX(14px)", background: "#fff" },
      closeBtn: {
        height: "32px",
        font: "inherit",
        cursor: "pointer",
        border: "none",
        borderRadius: "16px",
        padding: "0 14px",
        fontSize: "13px",
        background: "var(--dsw-alias-button-primary-fill, #4f8cff)",
        color: "var(--dsw-alias-label-primary-foreground, #fff)",
        alignSelf: "flex-end",
      },
      status: { margin: "0", fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #999)" },
    };

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-mcp-manager: dictionaries");

      // ---- report the active workspace to the host (debounced, on change) ----
      let reported = null;
      let reportTimer = null;
      const reportActive = () => {
        let path = null;
        try {
          const sessionsList = ctx.sessions.list.getSnapshot();
          const currentId = sessionsList.current;
          const items = ctx.workspaces.list.getSnapshot().items ?? [];
          const workspace = currentId ? items.find((w) => (w.sessionIds ?? []).includes(currentId)) : void 0;
          path = workspace?.path ?? null;
        } catch {
          /* stores not ready yet */
        }
        if (path === reported) return;
        reported = path;
        if (reportTimer !== null) clearTimeout(reportTimer);
        reportTimer = setTimeout(() => {
          fetch(ACTIVATE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
          }).catch(() => {});
        }, 300);
      };
      reportActive();
      ctx.effect(() => {
        const offSessions = ctx.sessions.list.subscribe(reportActive);
        const offWorkspaces = ctx.workspaces.list.subscribe(reportActive);
        return () => {
          offSessions();
          offWorkspaces();
          if (reportTimer !== null) clearTimeout(reportTimer);
        };
      }, "dsh-mcp-manager: active workspace");

      // ---- popup component (imperatively rendered) ----
      function Popup({ path, onClose }) {
        const [data, setData] = React.useState({ status: "loading", writable: false, global: [], manual: [], projects: [], skills: [], activeWorkspace: null });

        const refresh = React.useCallback(() => {
          let alive = true;
          fetch(INVENTORY_URL + "?active=" + encodeURIComponent(path), { headers: { Accept: "application/json" } })
            .then((response) => {
              if (!response.ok) throw new Error("HTTP " + response.status);
              return response.json();
            })
            .then((json) => {
              if (!alive) return;
              setData({
                status: "ready",
                writable: json.writable !== false,
                global: Array.isArray(json.global) ? json.global : [],
                manual: Array.isArray(json.manual) ? json.manual : [],
                projects: Array.isArray(json.projects) ? json.projects : [],
                skills: Array.isArray(json.skills) ? json.skills : [],
                activeWorkspace: json.activeWorkspace ?? null,
              });
            })
            .catch(() => {
              if (alive) setData((current) => ({ ...current, status: "error" }));
            });
          return () => {
            alive = false;
          };
        }, [path]);

        React.useEffect(() => {
          const cancel = refresh();
          return () => cancel();
        }, [refresh]);

        const toggle = React.useCallback(
          (kind, name, enabled) => {
            fetch(SET_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path, kind, name, enabled }),
            })
              .then(() => refresh())
              .catch(() => refresh());
          },
          [path, refresh]
        );

        const isActive = samePath(path, data.activeWorkspace);
        const projectGroup = (data.projects ?? []).find((group) => samePath(group.path, path));
        const projectRows = projectGroup?.servers ?? [];
        // Skills are split by scope: the ones this workspace owns versus the
        // user-wide ones every workspace shares. Empty groups are dropped below.
        const skillRows = data.skills ?? [];
        const projectSkills = skillRows.filter((row) => row.scope !== "global");
        const globalSkills = skillRows.filter((row) => row.scope === "global");
        const groups = [
          { key: "project", label: t("groupProject"), rows: projectRows, kind: "mcp" },
          { key: "global", label: t("groupGlobal"), rows: data.global ?? [], kind: "mcp" },
          { key: "manual", label: t("groupManual"), rows: data.manual ?? [], kind: "mcp" },
          { key: "skills-project", label: t("groupProjectSkills"), rows: projectSkills, kind: "skill" },
          { key: "skills-global", label: t("groupGlobalSkills"), rows: globalSkills, kind: "skill" },
        ].filter((group) => group.rows.length > 0);
        const anyRows = groups.length > 0;

        const rowEl = (row, group) => {
          const enabled = row.enabled !== false;
          const meta = row.command || row.transport || row.description || "";
          const isMounted = row.mounted === true;
          return h(
            "div",
            { style: S.row, key: group.kind + ":" + row.name + ":" + row.serverName },
            h("span", { style: S.rowName }, row.name || row.serverName),
            h(
              "span",
              { style: S.badge, title: row.source || group.key },
              group.kind === "skill" ? SOURCE_TAGS[row.source] ?? "skill" : group.key
            ),
            group.kind === "skill"
              ? null
              : h(
                  "span",
                  { style: isMounted ? S.badgeMounted : S.badgeUnmounted, title: isMounted ? t("mounted") : t("unmounted") },
                  isMounted ? t("mounted") : t("unmounted")
                ),
            h("span", { style: S.rowMeta, title: meta }, meta),
            h("span", { style: S.spacer }),
            h(
              "button",
              {
                type: "button",
                role: "switch",
                "aria-checked": enabled,
                "aria-label": (row.name || row.serverName) + " (" + (enabled ? t("enabled") : t("disabled")) + ")",
                style: enabled ? { ...S.switch, ...S.switchOn } : S.switch,
                disabled: !data.writable,
                onClick: () => toggle(group.kind, row.name || row.serverName, !enabled),
              },
              h("span", { style: enabled ? { ...S.knob, ...S.knobOn } : S.knob })
            )
          );
        };

        return h(
          "div",
          { style: S.overlay, onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
          h(
            "div",
            { style: S.dialog, role: "dialog", "aria-modal": "true" },
            h("h2", { style: S.title }, t("title") + " — " + baseName(path)),
            h("p", { style: S.path }, t("path") + ": " + path),
            isActive ? h("p", { style: S.note }, t("activeNote")) : h("p", { style: S.noteInactive }, t("inactiveNote")),
            data.status === "loading" ? h("p", { style: S.status }, t("loading")) : null,
            data.status === "error" ? h("p", { style: S.status }, t("error")) : null,
            data.status === "ready" && !anyRows ? h("p", { style: S.status }, t("empty")) : null,
            data.status === "ready"
              ? groups.map((group) =>
                  h(
                    "div",
                    { key: group.key },
                    h("p", { style: S.group }, group.label),
                    group.rows.map((row) => rowEl(row, group))
                  )
                )
              : null,
            h("button", { type: "button", style: S.closeBtn, onClick: onClose }, t("close"))
          )
        );
      }

      // ---- imperative open/close ----
      let popupRoot = null;
      let popupContainer = null;
      const closePopup = () => {
        try {
          if (popupRoot !== null) {
            popupRoot.unmount();
            popupRoot = null;
          } else if (popupContainer !== null && typeof ReactDOM.unmountComponentAtNode === "function") {
            ReactDOM.unmountComponentAtNode(popupContainer);
          }
        } catch (error) {
          console.error("[dsh-mcp-manager] popup unmount error", error);
        }
        if (popupContainer !== null) {
          popupContainer.remove();
          popupContainer = null;
        }
      };
      const openPopup = (path) => {
        if (popupContainer !== null) closePopup();
        try {
          popupContainer = document.createElement("div");
          popupContainer.id = "dsh-mcp-manager-popup-root";
          document.body.appendChild(popupContainer);
          const element = h(Popup, { path, onClose: closePopup });
          if (typeof ReactDOMClient?.createRoot === "function") {
            popupRoot = ReactDOMClient.createRoot(popupContainer);
            popupRoot.render(element);
          } else if (typeof ReactDOM?.render === "function") {
            ReactDOM.render(element, popupContainer);
          } else {
            console.error("[dsh-mcp-manager] no react-dom renderer available");
            popupContainer.remove();
            popupContainer = null;
          }
        } catch (error) {
          console.error("[dsh-mcp-manager] popup render error", error);
          if (popupContainer !== null) {
            popupContainer.remove();
            popupContainer = null;
          }
        }
      };
      const onOpenEvent = (event) => {
        const path = event?.detail?.path ?? null;
        if (typeof path === "string" && path.length > 0) openPopup(path);
      };
      window.addEventListener(OPEN_EVENT, onOpenEvent);
      ctx.effect(() => () => window.removeEventListener(OPEN_EVENT, onOpenEvent), "dsh-mcp-manager: popup listener");

      // ---- per-workspace-row MCP button, injected into the DOM ----
      // 0.2.x declares no slot for workspace-row actions (only session-row ones),
      // so instead of patching dsh-client-ui-workspace's bundle the button is
      // injected into each row's `.rowActions` span. The row carries
      // `data-row-key="workspace:<workspaceId>"`, which maps exactly onto the
      // client `workspaces` list, so the workspace path needs no guessing.
      const BUTTON_ATTR = "data-dsh-mcp-manager-button";
      const ROW_SELECTOR = '[data-row-key^="workspace:"]';
      // The button's mark: a plug seated in a rounded frame whose right edge
      // opens where the cord leaves — "this workspace is wired to MCP servers".
      // Drawn inline on the icons' own 16-unit grid, in currentColor, so it
      // needs nothing from @deepseek-ai/dsh-client-ui-primitives (which has no
      // MCP glyph) and keeps the weight of the neighbouring 1px stroke icons.
      const MARK_FRAME = "M14 9.4V11a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v1.6";
      const MARK_BODY = "M6.6 5.7h2a2.3 2.3 0 0 1 0 4.6h-2z";
      const MARK_DETAIL = "M4.6 6.6h2M4.6 9.4h2M10.9 8H14";
      /** The mark as an SVG element sized like the neighbouring row icons. */
      const mcpMark = () => {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("width", "16");
        svg.setAttribute("height", "16");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.style.display = "block";
        const stroked = (d) => {
          const path = document.createElementNS(ns, "path");
          path.setAttribute("d", d);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", "currentColor");
          path.setAttribute("stroke-width", "1");
          path.setAttribute("stroke-linecap", "round");
          path.setAttribute("stroke-linejoin", "round");
          return path;
        };
        // The frame and the leads are stroked like the rest of the UI; the plug
        // body is solid, as in the reference, because an outline that small
        // would read as noise at 16px.
        svg.appendChild(stroked(MARK_FRAME));
        const body = document.createElementNS(ns, "path");
        body.setAttribute("d", MARK_BODY);
        body.setAttribute("fill", "currentColor");
        body.setAttribute("stroke", "none");
        svg.appendChild(body);
        svg.appendChild(stroked(MARK_DETAIL));
        return svg;
      };
      const injectRowButtons = () => {
        const items = ctx.workspaces?.list?.getSnapshot?.()?.items ?? [];
        const pathById = new Map();
        for (const item of items) {
          if (typeof item?.workspaceId === "string" && typeof item?.path === "string" && item.path.length > 0) {
            pathById.set(item.workspaceId, item.path);
          }
        }
        for (const row of document.querySelectorAll(ROW_SELECTOR)) {
          const key = row.getAttribute("data-row-key") ?? "";
          const workspaceId = key.slice("workspace:".length);
          const path = workspaceId.length > 0 ? pathById.get(workspaceId) : undefined;
          if (typeof path !== "string" || path.length === 0) continue;
          const actions = row.querySelector('[class*="rowActions"]');
          if (actions === null) continue;
          if (actions.querySelector("[" + BUTTON_ATTR + "]") !== null) continue;
          const sample = actions.querySelector("button");
          const button = document.createElement("button");
          button.type = "button";
          button.setAttribute(BUTTON_ATTR, "");
          button.setAttribute("aria-label", "MCP");
          button.title = "MCP";
          // Reuse the sibling icon buttons' own class so the shipped styles and
          // hover behaviour apply without importing a CSS module.
          if (sample !== null && typeof sample.className === "string" && sample.className.length > 0) {
            button.className = sample.className;
          } else {
            button.style.cssText =
              "display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;background:transparent;color:inherit;cursor:pointer;border-radius:4px;";
          }
          const iconBox = document.createElement("span");
          iconBox.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;";
          iconBox.appendChild(mcpMark());
          button.appendChild(iconBox);
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { workspaceId, path } }));
          });
          actions.insertBefore(button, actions.firstChild);
        }
      };
      let injectScheduled = false;
      const scheduleInject = () => {
        if (injectScheduled) return;
        injectScheduled = true;
        const run = () => {
          injectScheduled = false;
          try {
            injectRowButtons();
          } catch (error) {
            console.error("[dsh-mcp-manager] row button injection error", error);
          }
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
        else setTimeout(run, 50);
      };
      const observer = typeof MutationObserver === "function" ? new MutationObserver(scheduleInject) : null;
      const observeBody = () => {
        if (observer !== null && document.body !== null) {
          observer.observe(document.body, { childList: true, subtree: true });
        }
      };
      if (document.body !== null) observeBody();
      else document.addEventListener("DOMContentLoaded", observeBody, { once: true });
      // Safety net: React may reconcile a row without a mutation we observe
      // ordering-wise, so re-check on a slow interval as well.
      const sweepTimer = setInterval(scheduleInject, 1500);
      const offWorkspaces = ctx.workspaces?.list?.subscribe?.(scheduleInject) ?? null;
      scheduleInject();
      ctx.effect(() => () => {
        if (observer !== null) observer.disconnect();
        document.removeEventListener("DOMContentLoaded", observeBody);
        clearInterval(sweepTimer);
        if (typeof offWorkspaces === "function") offWorkspaces();
        for (const node of document.querySelectorAll("[" + BUTTON_ATTR + "]")) node.remove();
      }, "dsh-mcp-manager: workspace-row button");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
