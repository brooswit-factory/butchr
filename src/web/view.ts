import { Elysia } from "elysia";
import type { McpHandle } from "@brooswit/thatch";
import { renderDashboard, type DashboardHeaderInfo } from "./dashboard-page.js";
import type { HealthStatus } from "../daemon/health.js";
import type { DashboardResponse } from "../agents/dashboard.js";

export interface AgentState { issue: string; status: string; summary: string }

export interface ViewDeps {
  /** The active agents to show (herdr-managed, with status). */
  state: () => Promise<AgentState[]>;
  /** Open the agent's shell in a terminal. Returns whether it launched. */
  open: (issue: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * BUTCHR-267: pane-keyed sibling of `open` — the dashboard row link target.
   * Opens a terminal attached to the given pane, refusing anything that
   * isn't one of this daemon's own live agents. `error`, when present, is
   * the exact human-readable refusal reason (see src/terminal/open.ts's
   * `attachRefusalMessage`) — this is a GET link's whole reporting surface,
   * so it must never be a generic "could not open".
   */
  openPane: (pane: string) => Promise<{ ok: boolean; error?: string }>;
  /** Current liveness snapshot (see src/daemon/health.ts) — `ok` stays a top-level field so existing callers still find it. */
  health: () => HealthStatus;
  /**
   * BUTCHR-269: one row per agent, five fields, per-row freshness — see
   * src/agents/dashboard.ts for the shape and the "could not check" contract.
   */
  dashboard: () => Promise<DashboardResponse>;
  /**
   * BUTCHR-339: the dashboard PAGE's own header info (build sha + the
   * optional build-currency verdict) — SYNCHRONOUS, same discipline as
   * `dashboard` above (no I/O on the request path): the caller (src/daemon/
   * index.ts) already has both values in hand from its own build-identity
   * and currency-tracker singletons, so this reads them, never recomputes.
   */
  header: () => DashboardHeaderInfo;
  /**
   * BUTCHR-339: resolves a resource key (a Jira issue key, or a project id)
   * to its correct external target — the Jira issue for an issue key, the
   * project's Confluence ROOT DOC for a project id — for the `/resource/:key/open`
   * redirect route. Unlike `dashboard`/`header`, this DOES do I/O (a project's
   * root doc is not cached anywhere on the dashboard snapshot — see
   * src/tools/docs.ts's `projectRootDoc`), but only when a human clicks the
   * link, never on `/dashboard`'s or `/`'s own request path. `error`, when
   * present, is the exact human-readable refusal reason — the same honesty
   * bar as `openPane` above.
   */
  resourceLink: (key: string) => Promise<{ ok: true; url: string } | { ok: false; error: string }>;
}

/** The live view: the page, its data (/state), the connected-agents feed (/agents), and the open action. */
export function liveView(mcp: McpHandle, deps: ViewDeps) {
  return new Elysia()
    // BUTCHR-339: the dashboard page itself — a pure, synchronous render
    // (src/web/dashboard-page.ts) of the SAME snapshot `/dashboard` serves,
    // plus the SAME synchronous header info `/health`'s `build`/`currency`
    // fields already carry. No I/O on this request path either: `dashboard()`
    // and `header()` both just read state a poll already produced.
    .get("/", async () => {
      const response = await deps.dashboard();
      const html = renderDashboard(response, {
        now: Date.now(),
        header: deps.header(),
        terminalLinkHref: (pane) => `/agents/pane/${encodeURIComponent(pane)}/attach`,
        resourceLinkHref: (key) => `/resource/${encodeURIComponent(key)}/open`,
      });
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    })
    // 503 (not just a false `ok`) when unhealthy, so a `curl -f` or any dumb
    // uptime checker goes red too — an endpoint nobody curls doesn't satisfy
    // "loud" (BUTCHR-18/BUTCHR-6).
    .get("/health", ({ set }) => {
      const status = deps.health();
      if (!status.ok) set.status = 503;
      return status;
    })
    .get("/state", () => deps.state())
    // BUTCHR-269: read-only, no action verbs, no alerting — a VIEW over data
    // this daemon already has in hand (see src/agents/dashboard.ts's own
    // header for the "could not check" contract this serves as-is).
    .get("/dashboard", () => deps.dashboard())
    .get("/agents", () => mcp.connections.list().map((c) => ({ id: c.id, issue: c.headers["x-issue"] ?? null, connectedAt: c.connectedAt })))
    .post("/agents/:issue/open", async ({ params, set }) => {
      const r = await deps.open(decodeURIComponent(params.issue));
      if (!r.ok) { set.status = 409; return { ok: false, error: r.error ?? "could not open" }; }
      return { ok: true };
    })
    // BUTCHR-267: the dashboard row's terminal-attach link target, keyed by
    // pane rather than issue (the row data BUTCHR-264 serves carries the
    // pane, not the issue). GET, not POST, because criterion 1 requires an
    // ordinary `<a href>` a person can click — a form/fetch-driven POST
    // isn't reachable that way. That makes this a GET with a side effect,
    // which browser prefetch, link scanners and history restores can fire
    // without a human clicking: ACCEPTED deliberately, not overlooked — the
    // worst case is one stray terminal window spawned on the daemon's own
    // desktop (fire-and-forget, no state change, trivially closed), and nothing
    // else in this codebase treats opening a terminal as sensitive. See this
    // ticket's PR body and doc for the same reasoning.
    //
    // The response body is plain text, not JSON: unlike the POST action above
    // (driven by `fetch()`, whose caller renders its own UI), this route IS
    // the reporting surface a browser shows a person who clicked the link —
    // criterion 5 requires the failure be something they can actually read.
    .get("/agents/pane/:pane/attach", async ({ params, set }) => {
      const pane = decodeURIComponent(params.pane);
      const r = await deps.openPane(pane);
      set.headers["content-type"] = "text/plain; charset=utf-8";
      if (!r.ok) { set.status = 409; return r.error ?? "could not open"; }
      // BUTCHR-267 criterion 6: the spawn is fire-and-forget — say only what
      // is actually known (the emulator was launched), never that a window
      // appeared, which was never observed.
      return `launched a terminal for ${pane} (fire-and-forget: whether a window actually appeared was not, and cannot be, confirmed)`;
    })
    // BUTCHR-339: the dashboard row's RESOURCE link target — a small
    // server-side redirect that resolves a resource key to its correct
    // target ONLY when a human clicks (never on `/dashboard`'s own request
    // path, per that route's own no-I/O contract). 302 on success; a plain-
    // text, human-readable refusal on failure — the same honesty bar as the
    // terminal-attach route above, never a blank page or a silent failure.
    .get("/resource/:key/open", async ({ params, set }) => {
      const key = decodeURIComponent(params.key);
      const r = await deps.resourceLink(key);
      set.headers["content-type"] = "text/plain; charset=utf-8";
      if (!r.ok) { set.status = 409; return r.error; }
      set.status = 302;
      set.headers["location"] = r.url;
      return "";
    });
}
