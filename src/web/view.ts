import { Elysia } from "elysia";
import type { McpHandle } from "@brooswit/thatch";
import { renderDashboard, type DashboardHeaderInfo } from "./dashboard-page.js";
import { renderConfigInventory, type ConfigInventoryFetchResult } from "./config-inventory-page.js";
import type { HealthStatus } from "../daemon/health.js";
import type { DashboardResponse } from "../agents/dashboard.js";
import type { QueryAgentInventory } from "../agents/query-agent-inventory.js";
import { agentRowAnchorId } from "../agents/config-inventory-links.js";
import type { ResourcesForUrlResponse } from "../resources/resource-lookup.js";
import { checkBearerOrigin, checkBearerOriginForUpgrade, preflightBearerOrigin, type BearerOriginGuardDeps } from "./bearer-origin-guard.js";
import { ptyAttachRefusalMessage, type PtyAttachResolution } from "../terminal/pty-attach.js";
import { parseClientFrame, ptyTick, PTY_CLOSED_REASON, type PtyTickState } from "../terminal/pty-bridge.js";

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
  /**
   * FACTORY-72 — every configured query agent (rules + managed-session
   * definitions), whether or not it currently has a running agent. See
   * `../agents/query-agent-inventory.ts` for the full shape and the reuse
   * it's built from. Async (unlike `dashboard`/`header`) because it reads
   * the managed-session definitions directory fresh each call (local disk,
   * not a network round trip) — see that module's own top comment for why
   * that I/O is unavoidable and acceptable here.
   */
  configInventory: () => Promise<QueryAgentInventory>;
  /**
   * FACTORY-339 (implementing FACTORY-335, epic FACTORY-330): the
   * `GET /resources/for-url` body — see `../resources/resource-lookup.ts`'s
   * own header for why this reads the staffed-agent registry
   * (`dashboard()`'s SAME snapshot, never a second poll or a re-run query)
   * rather than doing any I/O of its own. Optional so every pre-existing
   * `ViewDeps` literal in this codebase's own tests keeps compiling
   * unchanged; `extensionAuth` below defaults to disabled when either is
   * absent, so an omitted `resourcesForUrl` is never reachable anyway.
   */
  resourcesForUrl?: (url: string) => Promise<ResourcesForUrlResponse>;
  /**
   * FACTORY-339: the bearer-token + Origin-allowlist guard config for
   * `GET /resources/for-url` (see `./bearer-origin-guard.ts`). Optional,
   * same reasoning as `resourcesForUrl` above — absent means disabled, the
   * same "never silently open" default the guard itself enforces for an
   * `undefined` token.
   */
  extensionAuth?: BearerOriginGuardDeps;
  /**
   * FACTORY-453 (implementing FACTORY-337, epic FACTORY-330): the
   * `GET /agents/:agentKey/pty` WebSocket's own deps — resolving an agent
   * key to a pane, checking that pane is still live on each poll tick, and
   * reading/writing its text. Optional, same "absent means disabled"
   * discipline as `resourcesForUrl` above: this route is gated by the SAME
   * `extensionAuth` token/origin guard (see `./bearer-origin-guard.ts`'s
   * `checkBearerOriginForUpgrade`), and an omitted `ptyAttach` makes it
   * unreachable regardless of `extensionAuth`.
   */
  ptyAttach?: {
    /** Resolves `:agentKey` against the daemon's current dashboard snapshot — no I/O, see `../terminal/pty-attach.ts`. */
    resolve: (agentKey: string) => PtyAttachResolution;
    /** Re-checked every poll tick against a fresh snapshot read (still no I/O) so a pane that goes away mid-session is caught promptly. */
    isLive: (agentKey: string, pane: string) => boolean;
    /** `herdr.pane.read`, wrapped — see `../terminal/pty-bridge.ts`'s header for why this is a poll, not a push stream. */
    read: (pane: string) => Promise<string>;
    /** `herdr.pane.sendText`, wrapped. */
    send: (pane: string, text: string) => Promise<void>;
    /** Poll interval, in ms — this daemon's own choice, not herdr's; see `docs/pty-attach.md`'s Config section. */
    pollMs: number;
  };
}

/** One open `/agents/:agentKey/pty` socket's server-side bookkeeping — keyed by `ElysiaWS.id`, since neither Elysia nor Bun hands the `open`/`message`/`close` callbacks a shared closure over each other by default. */
interface PtySession {
  pane: string;
  timer: ReturnType<typeof setInterval>;
  state: PtyTickState;
}

/** The live view: the page, its data (/state), the connected-agents feed (/agents), and the open action. */
export function liveView(mcp: McpHandle, deps: ViewDeps) {
  // FACTORY-339: `undefined` (either half omitted) means DISABLED, never
  // open — see `ViewDeps.extensionAuth`'s own doc comment and
  // `bearer-origin-guard.ts`'s header for why an absent token must never
  // read as "no auth required".
  const extensionAuth: BearerOriginGuardDeps = deps.extensionAuth ?? { token: undefined, allowedOrigins: [] };
  // FACTORY-453: one entry per currently-open `/agents/:agentKey/pty` socket — see `PtySession`'s own doc comment for why this exists instead of closing over per-connection state directly.
  const ptySessions = new Map<string, PtySession>();
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
        // FACTORY-81: a pure URL builder, same as the two above — adds NO
        // I/O to this route (see dashboard-page.ts's own `configLinkHref`
        // doc comment for why this back-link never needs the inventory).
        configLinkHref: (anchor) => `/configurations#${anchor}`,
      });
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    })
    // FACTORY-81: the Configurations view — a pure, synchronous render
    // (src/web/config-inventory-page.ts) of the SAME `/config-inventory`
    // shape, plus the SAME poll-fed `/dashboard` rows `/` already reads, for
    // the cross-link matching only. `configInventory()` DOES do real disk
    // I/O (see that dep's own doc comment) — accepted here because this is
    // a distinct, less-frequently-hit route, never added to `/`'s own
    // request path. A rejected `configInventory()` is reported as a loud
    // fetch-failure banner (requirement 4), never a thrown 500.
    .get("/configurations", async () => {
      const dashboard = await deps.dashboard();
      let result: ConfigInventoryFetchResult;
      try {
        result = { ok: true, inventory: await deps.configInventory() };
      } catch (e) {
        result = { ok: false, error: (e as Error).message };
      }
      const html = renderConfigInventory(result, dashboard.rows, {
        dashboardLinkHref: (resourceKey) => `/#${agentRowAnchorId(resourceKey)}`,
        // FACTORY-132: the SAME snapshot `dashboard.rows` above already came
        // from — never a second, independently-timed read — so the matches
        // and the reason an empty match list means what it means always
        // agree (see `RenderConfigInventoryOpts.agentCensusChecked`'s own
        // doc comment).
        agentCensusChecked: dashboard.checked,
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
    // FACTORY-72: read-only, same discipline as `/dashboard` — a VIEW over
    // every configured rule and managed-session definition, staffed or not.
    .get("/config-inventory", () => deps.configInventory())
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
    })
    // FACTORY-339 (implementing FACTORY-335, epic FACTORY-330): the ONLY
    // guarded route in this file — every other route above is deliberately
    // unauthenticated (see `docs/resources-for-url.md`'s own "why not the
    // others" note). Never open the same way `/dashboard`/`/agents` are:
    // `extensionAuth` above is `{ token: undefined, allowedOrigins: [] }`
    // whenever this daemon's config doesn't set `BUTCHR_EXTENSION_TOKEN`, and
    // `checkBearerOrigin` turns that into a hard 503 refusal per request,
    // never a fallback to "unauthenticated". `deps.resourcesForUrl` is only
    // ever called once the guard has already said `ok`.
    .options("/resources/for-url", ({ request, set }) => {
      const preflight = preflightBearerOrigin({ origin: request.headers.get("origin") }, extensionAuth);
      set.status = preflight.status;
      for (const [k, v] of Object.entries(preflight.headers)) set.headers[k] = v;
      return "";
    })
    .get("/resources/for-url", async ({ request, query, set }) => {
      const guard = checkBearerOrigin({ authorization: request.headers.get("authorization"), origin: request.headers.get("origin") }, extensionAuth);
      for (const [k, v] of Object.entries(guard.corsHeaders)) set.headers[k] = v;
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.resourcesForUrl) { set.status = 503; return { error: "endpoint disabled: no token configured" }; }
      // `query.url` is the raw `?url=` value; Elysia decodes it the same way
      // `URLSearchParams` would, so the ticket's own `url=<percent-encoded>`
      // contract needs no extra decoding here. Absent entirely is treated as
      // the empty string — `resolveUrlToResource("")` already resolves to
      // `{ canonicalUrl: null, resource: null }`, the same normal "not a
      // resource" shape as any other unparseable input, never a special error.
      const url = typeof query["url"] === "string" ? query["url"] : "";
      return deps.resourcesForUrl(url);
    })
    // FACTORY-453 (implementing FACTORY-337, epic FACTORY-330): the ONLY
    // other guarded route in this file, and the highest-risk one — a
    // WebSocket that gives a browser keystroke access to a live agent's
    // terminal. See `docs/pty-attach.md` for the full contract, framing,
    // close-reason and back-pressure policy, and — most importantly — why
    // this route's Origin rule is STRICTER than `/resources/for-url`'s
    // above: `checkBearerOriginForUpgrade`, not `checkBearerOrigin`, because
    // CORS does not apply to WebSocket upgrades (see that function's own
    // doc comment in `./bearer-origin-guard.ts`). `beforeHandle` runs before
    // Elysia ever calls `server.upgrade()`, so a refusal here is an ordinary
    // HTTP response (401/403/404/503) — the socket is never opened at all,
    // never opened-then-closed.
    .ws("/agents/:agentKey/pty", {
      // Bun-native back-pressure policy (see `docs/pty-attach.md`'s Contract
      // section for the justification): once a slow client's own unread
      // buffer exceeds this bound, the connection is dropped outright
      // rather than silently discarding pane output the client would have
      // no way to know it missed — an honest, visible failure a client can
      // reconnect from, not a terminal that quietly desyncs.
      backpressureLimit: 4 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      beforeHandle({ request, params, set }) {
        const guard = checkBearerOriginForUpgrade(
          {
            authorization: request.headers.get("authorization"),
            origin: request.headers.get("origin"),
            subprotocol: request.headers.get("sec-websocket-protocol"),
          },
          extensionAuth,
        );
        if (!guard.ok) {
          set.status = guard.status;
          return guard.body;
        }
        // FACTORY-455: echoed back ONLY when auth actually went through the
        // subprotocol channel (`checkBearerOriginForUpgrade` sets this) —
        // never for header auth, which offered no subprotocol to select
        // from in the first place. See `PTY_BEARER_SUBPROTOCOL_MARKER`'s own
        // doc comment in `./bearer-origin-guard.ts` for why this must be
        // exactly the marker and never the token.
        if (guard.selectedSubprotocol) set.headers["sec-websocket-protocol"] = guard.selectedSubprotocol;
        if (!deps.ptyAttach) {
          set.status = 503;
          return { error: "endpoint disabled: no token configured" };
        }
        const agentKey = decodeURIComponent(params.agentKey);
        const resolution = deps.ptyAttach.resolve(agentKey);
        if (!resolution.ok) {
          set.status = 404;
          return { error: ptyAttachRefusalMessage(resolution.refusal) };
        }
      },
      open(ws) {
        // `beforeHandle` above already refused anything that doesn't
        // resolve — `deps.ptyAttach` and a successful `resolve` are both
        // guaranteed here. Re-running `resolve` (a cheap, synchronous scan
        // of the in-memory snapshot, not a second I/O call) rather than
        // smuggling its result through Elysia's context avoids relying on
        // exactly how far `beforeHandle`'s own derived values propagate
        // into the `open` handler's context, which this codebase has no
        // other `.ws()` route to already prove out.
        const agentKey = decodeURIComponent((ws.data as { params: { agentKey: string } }).params.agentKey);
        const ptyAttach = deps.ptyAttach!;
        const resolution = ptyAttach.resolve(agentKey);
        if (!resolution.ok) {
          ws.close(4004, ptyAttachRefusalMessage(resolution.refusal));
          return;
        }
        const pane = resolution.pane;
        const session: PtySession = {
          pane,
          state: { lastText: "" },
          timer: setInterval(() => {
            void (async () => {
              const current = ptySessions.get(ws.id);
              if (!current) return;
              const live = ptyAttach.isLive(agentKey, current.pane);
              let text = "";
              if (live) {
                try {
                  text = await ptyAttach.read(current.pane);
                } catch {
                  // A read failure on an otherwise-live-looking pane is
                  // treated the same as the pane having gone away: this
                  // socket's whole job is showing a live pane, and there is
                  // no meaningful partial state to report instead.
                  clearInterval(current.timer);
                  ptySessions.delete(ws.id);
                  ws.close(4000, PTY_CLOSED_REASON);
                  return;
                }
              }
              const result = ptyTick(current.state, live, text);
              if (result.kind === "closed") {
                clearInterval(current.timer);
                ptySessions.delete(ws.id);
                ws.close(4000, result.reason);
              } else {
                current.state = result.state;
                if (result.kind === "output") ws.send(result.text);
              }
            })();
          }, ptyAttach.pollMs),
        };
        ptySessions.set(ws.id, session);
      },
      message(ws, message) {
        const session = ptySessions.get(ws.id);
        if (!session || !deps.ptyAttach) return;
        const frame = parseClientFrame(message as string | Uint8Array);
        // Only "input" is ever acted on: a "control" (resize) frame is
        // accepted and parsed, never rejected, but is NOT wired through —
        // see `../terminal/pty-bridge.ts`'s header for why no herdr call
        // exists to do that, and `docs/pty-attach.md`'s Contract section for
        // this stated plainly rather than left to be discovered by a
        // resize that silently does nothing. "ignored" frames (unparseable
        // binary, or a JSON shape this daemon doesn't recognize) are
        // likewise never fatal to the connection.
        if (frame.kind === "input") void deps.ptyAttach.send(session.pane, frame.text);
      },
      close(ws) {
        const session = ptySessions.get(ws.id);
        if (session) clearInterval(session.timer);
        ptySessions.delete(ws.id);
      },
    });
}
