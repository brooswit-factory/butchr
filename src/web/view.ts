import { Elysia } from "elysia";
import type { McpHandle } from "@brooswit/thatch";
import { PAGE } from "./page.js";
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
}

/** The live view: the page, its data (/state), the connected-agents feed (/agents), and the open action. */
export function liveView(mcp: McpHandle, deps: ViewDeps) {
  return new Elysia()
    .get("/", () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }))
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
    });
}
