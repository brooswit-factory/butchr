import { Elysia } from "elysia";
import type { McpHandle } from "@brooswit/thatch";
import { renderDashboard, type DashboardHeaderInfo } from "./dashboard-page.js";
import { ICON_ROUTES } from "./icons.js";
import { renderConfigInventory, type ConfigInventoryFetchResult } from "./config-inventory-page.js";
import type { HealthStatus } from "../daemon/health.js";
import type { DashboardResponse } from "../agents/dashboard.js";
import type { QueryAgentInventory } from "../agents/query-agent-inventory.js";
import { agentRowAnchorId } from "../agents/config-inventory-links.js";
import type { ResourcesForUrlResponse } from "../resources/resource-lookup.js";
import { checkExtensionOrigin, preflightExtensionOrigin, type OriginGuardDeps } from "./origin-guard.js";
import { createOriginGuardLogger, type OriginGuardLogger } from "./origin-guard-log.js";
import { checkDashboardOrigin, type DashboardOriginGuardDeps } from "./dashboard-origin-guard.js";
import { buildRulesApiResponse, type RulesApiResponse } from "./rules-api.js";
import type { RulesFileState } from "../agents/query-agent-inventory.js";
import type { RulesPreviewResult } from "./rules-preview.js";
import { ptyAttachRefusalMessage, type PtyAttachResolution } from "../terminal/pty-attach.js";
import { parseClientFrame, ptyTick, PTY_CLOSED_REASON, type PtyTickState } from "../terminal/pty-bridge.js";
import { resolveWebRoot, serveStaticAsset, dashboardAppStatus, dashboardAppMissingResponse } from "./static-assets.js";
import type { Rule } from "../rules/rules.js";
import type { ReloadResult } from "../rules/reload.js";

const iconResponse = ({ path }: { path: string }) => new Response(ICON_ROUTES[path]!, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });

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
   * FACTORY-647: where `GET /dashboard-app*` looks for the built web app —
   * optional, defaulting to `resolveWebRoot()` (the real production
   * resolution, src/web/static-assets.ts). Exists so a test can point this
   * at a temp-dir fixture through the REAL route code (`liveView`/`buildApp`)
   * instead of a hand-rolled handler, never used by production wiring,
   * which gets the default.
   */
  dashboardAppRoot?: string;
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
   * `GET`/`POST /resources/for-url` body (FACTORY-480 added the POST) — see
   * `../resources/resource-lookup.ts`'s own header for why this reads the
   * staffed-agent registry (`dashboard()`'s SAME snapshot, never a second
   * poll or a re-run query) rather than doing any I/O of its own. Optional
   * so every pre-existing `ViewDeps` literal in this codebase's own tests
   * keeps compiling unchanged; `extensionAuth` below defaults to disabled
   * when either is absent, so an omitted `resourcesForUrl` is never
   * reachable anyway.
   */
  resourcesForUrl?: (url: string) => Promise<ResourcesForUrlResponse>;
  /**
   * FACTORY-339: the Origin-allowlist guard config for
   * `GET`/`POST /resources/for-url` (see `./origin-guard.ts`). Optional, same
   * reasoning as `resourcesForUrl` above — absent means an empty
   * `allowedOrigins`, which the guard treats as "reject everything", the
   * same "never silently open" default it enforces generally.
   */
  extensionAuth?: OriginGuardDeps;
  /**
   * FACTORY-476 (implementing FACTORY-474): the journal-logger for a
   * rejection from `extensionAuth`'s guard, on every route it gates — see
   * `./origin-guard-log.ts` for the line shape, the rate-limit/dedupe
   * contract, and why `origin` still gets sanitized despite being logged
   * "verbatim". Optional so every pre-existing `ViewDeps` literal keeps
   * compiling unchanged; an omitted value defaults to
   * `createOriginGuardLogger()` (real clock, `console.error`) — the same
   * "absent means the safe default, never disabled" discipline
   * `extensionAuth` above already follows. A test that needs to control the
   * clock or capture emitted lines builds its own with
   * `createOriginGuardLogger({ now, log })` and passes it here.
   */
  originGuardLog?: OriginGuardLogger;
  /**
   * FACTORY-453 (implementing FACTORY-337, epic FACTORY-330): the
   * `GET /agents/:agentKey/pty` WebSocket's own deps — resolving an agent
   * key to a pane, checking that pane is still live on each poll tick, and
   * reading/writing its text. Optional, same "absent means disabled"
   * discipline as `resourcesForUrl` above: this route is gated by the SAME
   * `extensionAuth` origin guard (see `./origin-guard.ts`'s
   * `checkExtensionOrigin`), and an omitted `ptyAttach` makes it
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
  /**
   * FACTORY-657: the daemon's own LIVE rules (`RulesHolder.getRules()`,
   * src/rules/rules.ts) — the SAME array every poll already reads through,
   * never a second load. FACTORY-660's `rulesFileState`/previewer below are
   * rewired off this (review round 2, R2) rather than a startup-only array,
   * so a live reload is reflected without a daemon restart.
   */
  getRules?: () => readonly Rule[];
  /**
   * FACTORY-657, agentsafety review R2: sha256 hex of the exact text the
   * CURRENTLY held rules were parsed from (`RulesHolder.getSourceEtag()`)
   * — the same `sha256(text ?? "")` convention `src/rules/write-rules.ts`'s
   * `rulesEtag` uses. FACTORY-660's `GET /api/rules` `stale` flag (review
   * round 2, G1) compares this against a FRESH `rulesEtag()` read to tell
   * "the file changed since this daemon last loaded it" apart from
   * "nothing changed" — `getRules()` alone can't make that distinction (an
   * edit that reorders but doesn't change any enabled rule's effective
   * content would look identical).
   */
  getRulesSourceEtag?: () => string | undefined;
  /**
   * FACTORY-657: re-reads `rules.json` in-process and swaps the daemon's
   * live holder — literally `() => reloadRules(rulesHolder)`
   * (src/rules/reload.ts), the EXACT same function `SIGHUP` already calls.
   * No route calls this today; exists so FACTORY-663's web write path can
   * call it directly after it writes the file itself, with no HTTP
   * round-trip and no second reload code path to drift from SIGHUP's. Its
   * own result's `sourceEtag` (on success) is the new `getRulesSourceEtag()`
   * value — read it off THIS result rather than calling
   * `getRulesSourceEtag()` separately right after, so there is no window
   * where the two could observe a different reload.
   */
  reloadRulesNow?: () => ReloadResult;
  /**
   * FACTORY-660: the Origin/Host guard for `GET /api/rules` and
   * `GET /api/rules/:id/preview` — see `./dashboard-origin-guard.ts`'s own
   * header for why this is a SEPARATE mechanism from `extensionAuth` above
   * (this dashboard's own first-party origin, never an extension
   * allowlist). Optional, same "absent means disabled" discipline as
   * `resourcesForUrl`/`extensionAuth`: an omitted guard makes both routes
   * unreachable (503) rather than open.
   */
  dashboardOriginGuard?: DashboardOriginGuardDeps;
  /**
   * FACTORY-660 (SPEC CHANGE (c); PR #642 review round 2, G2): the same-UID
   * peer check (`./peer-uid.ts`) BOTH `GET /api/rules` and `GET
   * /api/rules/:id/preview` require — `/api/rules` reads this process's own
   * already-loaded config (no outbound Jira call), but still reveals rule
   * shapes/queries to any local user who can reach loopback, so G2 put the
   * same fail-closed check on it. Takes the CLIENT's own address+port
   * (`server.requestIP(request)`, read in this file — this dep has no
   * Elysia/Bun dependency of its own) and answers whether that socket
   * belongs to this daemon's own uid. Optional, same discipline as
   * `dashboardOriginGuard` above: absent means the route is unreachable,
   * never open.
   */
  peerUidCheck?: (client: { address: string; port: number }) => boolean;
  /**
   * FACTORY-660: `GET /api/rules`' own data — the validated rules file
   * state (reusing `loadRulesFileState`, `../agents/query-agent-
   * inventory.js`) plus its on-disk mtime and `fileEtag` (`rulesEtag()`,
   * `../rules/write-rules.js`, FACTORY-658 — FACTORY-662's F7 requirement),
   * read FRESH every request. Deliberately separate from `configInventory`
   * above (which this route ALSO calls, for the SAME per-rule staffing
   * computation `/configurations` already does) because `configInventory`'s
   * `RuleInventoryEntry` carries no `brief` field at all (see
   * `../web/rules-api.ts`'s own header) — this is where the raw `Rule` list
   * (and so `Rule.brief`, excerpted there) comes from. Review round 2, R2:
   * the daemon's own production implementation reads `rules` through
   * `getRules()` above, never a startup-only array.
   */
  rulesFileState?: () => Promise<RulesFileState & { mtime: string | null; fileEtag: string }>;
  /**
   * FACTORY-660: `GET /api/rules/:id/preview`'s own dry-run
   * (`./rules-preview.ts`'s `createRulesPreviewer`, built once by the
   * caller so its per-rule rate-limit state persists across requests —
   * never rebuilt per request here).
   */
  rulesPreview?: (id: string) => Promise<RulesPreviewResult>;
}

/** One open `/agents/:agentKey/pty` socket's server-side bookkeeping — keyed by `ElysiaWS.id`, since neither Elysia nor Bun hands the `open`/`message`/`close` callbacks a shared closure over each other by default. */
interface PtySession {
  pane: string;
  timer: ReturnType<typeof setInterval>;
  state: PtyTickState;
}

/** The live view: the page, its data (/state), the connected-agents feed (/agents), and the open action. */
export function liveView(mcp: McpHandle, deps: ViewDeps) {
  // FACTORY-339: an omitted `extensionAuth` means an empty allowlist, which
  // `origin-guard.ts` treats as DISABLED (every origin rejected) — see
  // `ViewDeps.extensionAuth`'s own doc comment and `origin-guard.ts`'s
  // header for why an empty allowlist must never read as "no auth
  // required".
  const extensionAuth: OriginGuardDeps = deps.extensionAuth ?? { allowedOrigins: [] };
  // FACTORY-476: same "absent means the safe default" discipline as
  // `extensionAuth` immediately above — see `ViewDeps.originGuardLog`'s own
  // doc comment.
  const originGuardLog: OriginGuardLogger = deps.originGuardLog ?? createOriginGuardLogger();
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
    // Brand icons (favicon, apple-touch/PWA sizes) the two pages above link to; static, no I/O.
    .get("/favicon-16.png", iconResponse)
    .get("/favicon-32.png", iconResponse)
    .get("/favicon.ico", iconResponse)
    .get("/apple-touch-icon.png", iconResponse)
    // FACTORY-613 (replays FACTORY-432 / PR #546): the built React dashboard
    // app (dashboard-app/, vite.config.ts), served as static files from
    // src/web/static-assets.ts. Plumbing only — nothing above links here
    // yet, and no page currently served by `/` or `/configurations` changes
    // behavior because of this route existing.
    .get("/dashboard-app", () => {
      const root = deps.dashboardAppRoot ?? resolveWebRoot();
      const status = dashboardAppStatus(root);
      return status.built ? serveStaticAsset(root, "/") : dashboardAppMissingResponse(status.path);
    })
    .get("/dashboard-app/*", ({ params }) => {
      const root = deps.dashboardAppRoot ?? resolveWebRoot();
      const status = dashboardAppStatus(root);
      return status.built ? serveStaticAsset(root, "/" + (params["*"] ?? "")) : dashboardAppMissingResponse(status.path);
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
    // FACTORY-660 (slice R1, read-only) — the rules page's data route.
    // GUARDS RUN BEFORE ANY WORK (SPEC CHANGE (e)): the dashboard-origin
    // guard, the same-UID peer check (PR #642 review round 2, G2 — this
    // route reveals rule shapes/queries, so it gets the SAME fail-closed
    // check `/api/rules/:id/preview` always had, even with no outbound Jira
    // call of its own), and both remaining dep presences are all checked
    // before either `rulesFileState()` (local disk I/O) or
    // `configInventory()` runs. `Cache-Control: no-store` per the ticket —
    // this reflects live, possibly-sensitive-feeling configuration state,
    // never cached by an intermediary or the browser.
    .get("/api/rules", async ({ request, server, set }) => {
      if (!deps.dashboardOriginGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = checkDashboardOrigin({ origin: request.headers.get("origin"), host: request.headers.get("host"), secFetchSite: request.headers.get("sec-fetch-site"), method: request.method }, deps.dashboardOriginGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.peerUidCheck) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const client = server?.requestIP(request);
      if (!client || !deps.peerUidCheck(client)) { set.status = 403; return { error: "peer uid check failed" }; }
      if (!deps.rulesFileState || !deps.getRulesSourceEtag) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      // FACTORY-657/review round 2, R2: `getRulesSourceEtag()` reads this
      // daemon's LIVE holder — the SAME value `getRules()` (fed through
      // `rulesFileState()`'s own production implementation) is current
      // for — never a startup-only snapshot. `undefined` only for a holder
      // that has never loaded any file at all (`RulesHolder.getSourceEtag`'s
      // own doc comment); this route's data is meaningless without it.
      const sourceEtag = deps.getRulesSourceEtag();
      if (sourceEtag === undefined) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      set.headers["cache-control"] = "no-store";
      const [rulesFile, inventory] = await Promise.all([deps.rulesFileState(), deps.configInventory()]);
      const response: RulesApiResponse = buildRulesApiResponse({ rulesFile, mtime: rulesFile.mtime, sourceEtag, fileEtag: rulesFile.fileEtag, ruleInventory: inventory.rules });
      return response;
    })
    // FACTORY-660 — the rules page's read-only dry-run preview. A GET that
    // DOES do outbound Jira reads (SPEC CHANGE (b): counts and ticket keys
    // only, never Jira's own error body), so it carries BOTH guards: the
    // dashboard-origin guard above, AND the same-UID peer check (SPEC
    // CHANGE (c)) — both run, in that order, before `rulesPreview()` (and
    // so before the Jira call) ever executes. PR #642 review round 2 (G4):
    // `params.id` is caller-controlled URL-encoded text — a malformed `%`
    // escape makes `decodeURIComponent` THROW, which must become a 400 JSON
    // error, never an uncaught 500.
    .get("/api/rules/:id/preview", async ({ params, request, server, set }) => {
      if (!deps.dashboardOriginGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = checkDashboardOrigin({ origin: request.headers.get("origin"), host: request.headers.get("host"), secFetchSite: request.headers.get("sec-fetch-site"), method: request.method }, deps.dashboardOriginGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.peerUidCheck) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const client = server?.requestIP(request);
      if (!client || !deps.peerUidCheck(client)) { set.status = 403; return { error: "peer uid check failed" }; }
      if (!deps.rulesPreview) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      let id: string;
      try {
        id = decodeURIComponent(params.id);
      } catch {
        set.status = 400;
        return { error: "malformed rule id" };
      }
      set.headers["cache-control"] = "no-store";
      const result = await deps.rulesPreview(id);
      if (!result.ok) { set.status = result.status; return { error: result.error }; }
      const { ok, ...body } = result;
      return body;
    })
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
    // FACTORY-339 (implementing FACTORY-335, epic FACTORY-330): one of two
    // guarded routes in this file — every other route above is deliberately
    // unauthenticated (see `docs/resources-for-url.md`'s own "why not the
    // others" note). Never open the same way `/dashboard`/`/agents` are:
    // FACTORY-497 hardcoded `extensionAuth` above to Cleavr's fixed id alone
    // — not configurable any more — and `checkExtensionOrigin` refuses (403)
    // any other origin, including an absent one, never a fallback to
    // "unauthenticated". `deps.resourcesForUrl` is only ever called once the
    // guard has already said `ok`.
    //
    // FACTORY-480: a real MV3 service-worker GET (Cleavr's own
    // `fetchResources`) carries NO `Origin` header at all — Chrome only
    // stamps `Origin` on a POST from that context — so the strict guard
    // above 403s every real install of the GET-only route below, and no
    // allowlist entry can fix that (see FACTORY-478's measurement). The
    // GET route is kept, UNCHANGED, for any caller that can present a real
    // allowlisted Origin itself (e.g. `curl -H Origin: ...`, exactly what
    // `docs/resources-for-url.md` already documented) — it is not removed
    // because nothing here requires removing it, and removing it would be
    // a needless behavior change for such a caller. Cleavr itself now uses
    // the POST route below, which Chrome DOES stamp with Origin from the
    // same service-worker context.
    .options("/resources/for-url", ({ request, set }) => {
      const origin = request.headers.get("origin");
      const preflight = preflightExtensionOrigin({ origin }, extensionAuth);
      set.status = preflight.status;
      for (const [k, v] of Object.entries(preflight.headers)) set.headers[k] = v;
      // FACTORY-476: `preflight.reason` is present only on refusal — see
      // `preflightExtensionOrigin`'s own doc comment. `new URL(...).pathname`
      // strips the query string unconditionally (this route takes none, but
      // the shared logger's own contract — ticket criterion 2 — is "never
      // the query string", not "never on routes known to carry one").
      if (preflight.reason) originGuardLog.reject({ method: "OPTIONS", path: new URL(request.url).pathname, origin, result: preflight.reason });
      return "";
    })
    .get("/resources/for-url", async ({ request, query, set }) => {
      const origin = request.headers.get("origin");
      const guard = checkExtensionOrigin({ origin }, extensionAuth);
      for (const [k, v] of Object.entries(guard.corsHeaders)) set.headers[k] = v;
      if (!guard.ok) {
        // FACTORY-476: `?url=` carries the page URL the extension is
        // looking at — this logs `pathname` only, never `request.url` whole.
        originGuardLog.reject({ method: "GET", path: new URL(request.url).pathname, origin, result: guard.reason });
        set.status = guard.status;
        return guard.body;
      }
      if (!deps.resourcesForUrl) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      // `query.url` is the raw `?url=` value; Elysia decodes it the same way
      // `URLSearchParams` would, so the ticket's own `url=<percent-encoded>`
      // contract needs no extra decoding here. Absent entirely is treated as
      // the empty string — `resolveUrlToResource("")` already resolves to
      // `{ canonicalUrl: null, resource: null }`, the same normal "not a
      // resource" shape as any other unparseable input, never a special error.
      const url = typeof query["url"] === "string" ? query["url"] : "";
      return deps.resourcesForUrl(url);
    })
    // FACTORY-480: the route Cleavr's extension service worker actually uses
    // now — same guard, same response shape as the GET above, but the URL
    // travels in a JSON body instead of a query string, because that's the
    // request shape Chrome stamps with `Origin: chrome-extension://<id>`
    // from an MV3 service worker (a GET from that context never carries
    // one — see this route group's own header comment above). The guard
    // check happens BEFORE the body is ever read, same discipline as the
    // GET route.
    .post("/resources/for-url", async ({ request, body, set }) => {
      const origin = request.headers.get("origin");
      const guard = checkExtensionOrigin({ origin }, extensionAuth);
      for (const [k, v] of Object.entries(guard.corsHeaders)) set.headers[k] = v;
      if (!guard.ok) {
        // FACTORY-493: this route's own rejection was silent until now — see
        // FACTORY-476's dedupe-key comment (`origin-guard-log.ts`) for why
        // `method: "POST"` here doesn't suppress the GET route's own line.
        originGuardLog.reject({ method: "POST", path: new URL(request.url).pathname, origin, result: guard.reason });
        set.status = guard.status;
        return guard.body;
      }
      if (!deps.resourcesForUrl) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      // Same "absent/malformed is just the empty-string case" discipline as
      // the GET route's own `query.url` handling above — `body` is whatever
      // Elysia parsed from the request (or `undefined`/non-JSON), never
      // trusted to have the right shape.
      const parsedUrl = (body as { url?: unknown } | undefined)?.url;
      const url = typeof parsedUrl === "string" ? parsedUrl : "";
      return deps.resourcesForUrl(url);
    })
    // FACTORY-453 (implementing FACTORY-337, epic FACTORY-330): the other
    // guarded route in this file, and the highest-risk one — a WebSocket
    // that gives a browser keystroke access to a live agent's terminal. See
    // `docs/pty-attach.md` for the full contract, framing, close-reason and
    // back-pressure policy. Since FACTORY-464/FACTORY-465 dropped the bearer
    // token, this route's Origin rule is now the SAME `checkExtensionOrigin`
    // `/resources/for-url` uses above — see `./origin-guard.ts`'s own header
    // for why the two routes no longer need separate guard functions.
    // `beforeHandle` runs before Elysia ever calls `server.upgrade()`, so a
    // refusal here is an ordinary HTTP response (403/404/503) — the socket
    // is never opened at all, never opened-then-closed.
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
        const origin = request.headers.get("origin");
        const guard = checkExtensionOrigin({ origin }, extensionAuth);
        if (!guard.ok) {
          // FACTORY-476: the PTY upgrade path — ticket criterion 1's third
          // route. This only ever fires for the origin-guard refusal, never
          // for a resolve failure (malformed key / unknown pane) below —
          // those are a different, already-diagnosable refusal, not this
          // ticket's scope. `path` here IS `new URL(request.url).pathname`,
          // which for this route contains the raw agent key
          // (`/agents/<agentKey>/pty`) — FACTORY-502 found that this
          // previous comment's claim ("only the path itself, never
          // params.agentKey") was false reassurance: the path itself IS the
          // agent key. `origin-guard-log.ts`'s own `normalizeRoutePattern`
          // now collapses this to the fixed pattern `/agents/:agentKey/pty`
          // before it's used as a dedupe key OR printed, so neither the
          // journal line nor the dedupe map ever varies on the raw key —
          // see that module's own header for why.
          originGuardLog.reject({ method: "GET", path: new URL(request.url).pathname, origin, result: guard.reason });
          set.status = guard.status;
          return guard.body;
        }
        if (!deps.ptyAttach) {
          set.status = 503;
          return { error: "endpoint disabled: not configured" };
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
