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
import { checkWriteGuard, cappedReadText, BODY_CAP_BYTES, CSRF_HEADER, type WriteGuardDeps, type WriteGuardRequest } from "./write-guard.js";
import type { WriteRateLimitOutcome } from "./write-rate-limit.js";
import type { CsrfTokenIssuer } from "./csrf.js";
import { validateRuleFieldPatch, validateRuleCreateInput, type RuleFieldPatch, type RuleCreateInput } from "../rules/rules-write-registry.js";
import { AGENT_ROLES, CAPACITY_ROLE_DEFAULT, type RuleFormCatalogEntry } from "../rules/rule-form-catalog.js";
import type { RulesWriteOutcome, RulesPlanOutcome } from "../rules/rules-write.js";
import { ptyAttachRefusalMessage, type PtyAttachResolution } from "../terminal/pty-attach.js";
import { parseClientFrame, ptyTick, PTY_CLOSED_REASON, type PtyTickState } from "../terminal/pty-bridge.js";
import { resolveWebRoot, serveStaticAsset, dashboardAppStatus, dashboardAppMissingResponse } from "./static-assets.js";
import type { Rule } from "../rules/rules.js";
import type { ReloadResult } from "../rules/reload.js";
import type { SettingsApiResponse } from "./settings-api.js";
import type { JiraTestResult } from "./jira-connection-test.js";
import { SettingProvidedByEnvironmentError } from "../settings/write-settings.js";
import type { DaemonRestartOutcome } from "./daemon-restart.js";
import type { SetupStatusResponse, JiraWriteRequestOutcome, RateGate } from "./setup-api.js";
import { validateStopRequestBody, validateShelveRequestBody, validateAdoptRequestBody, validatePrioritizeRequestBody, type AgentWriteOutcome, type AdoptInput } from "../agents/agents-write.js";

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
  peerUidCheck?: (client: { address: string; port: number }) => boolean | Promise<boolean>;
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
   * FACTORY-729: `GET /api/rules/catalog`'s own data — the rule form's
   * harness/model/effort/permission-mode catalog (`../rules/rule-form-
   * catalog.js`'s `RULE_FORM_CATALOG`), pure constants with no I/O, behind
   * the SAME dashboard-origin + same-UID peer guard as `GET /api/rules`
   * above (this ticket's own instruction) — never a looser check just
   * because this route happens to do no disk/network I/O of its own.
   * Optional, same "absent means disabled" discipline as every other guard
   * dep in this file.
   */
  rulesCatalog?: () => readonly RuleFormCatalogEntry[];
  /**
   * FACTORY-660: `GET /api/rules/:id/preview`'s own dry-run
   * (`./rules-preview.ts`'s `createRulesPreviewer`, built once by the
   * caller so its per-rule rate-limit state persists across requests —
   * never rebuilt per request here).
   */
  rulesPreview?: (id: string, queryOverride?: string) => Promise<RulesPreviewResult>;
  /**
   * FACTORY-662 — this process's one CSRF token issuer (`./csrf.ts`),
   * handed out by `GET /api/session` and checked by every write route's
   * `writeGuard` below. Optional, same "absent means disabled" discipline
   * as every other guard dep in this file: an omitted issuer makes
   * `GET /api/session` and every write route unreachable (503), never
   * open.
   */
  csrf?: CsrfTokenIssuer;
  /**
   * FACTORY-662 — the combined Origin/Host/peer-uid/Content-Type/CSRF
   * guard every write route runs through (`./write-guard.ts`). Reuses the
   * SAME `dashboardOriginGuard`/`peerUidCheck` deps above rather than a
   * second pair — a write route is never guarded more loosely than the
   * read-only rules routes are.
   */
  writeGuard?: WriteGuardDeps;
  /**
   * FACTORY-662 — the rules write orchestration (`../rules/rules-write.ts`).
   * One function per route; each already does its own etag/placeholder/
   * allowlist checks (FACTORY-730: the route-level `ui-`-prefix check is
   * retired) and returns a tagged outcome this file maps straight to a
   * status + body, never re-deciding anything here.
   */
  rulesWrite?: {
    enabled: (id: string, enabled: boolean, ifMatch: string, confirm: boolean, planHash: string) => Promise<RulesWriteOutcome>;
    fields: (id: string, patch: RuleFieldPatch, ifMatch: string, confirm: boolean, planHash: string) => Promise<RulesWriteOutcome>;
    undo: (backupId: string) => RulesWriteOutcome;
    plan: (id: string, patch: RuleFieldPatch, confirm: boolean) => Promise<RulesPlanOutcome>;
    /** FACTORY-731 — `DELETE /api/rules/:id`. See `../rules/rules-write.ts`'s `writeRuleDelete` for the full gate list (unknown id, stale etag, enabled, live agents, missing confirm). */
    delete: (id: string, ifMatch: string, confirm: boolean) => RulesWriteOutcome;
    /**
     * FACTORY-927 — `POST /api/rules`'s own write (`createRule`,
     * `../rules/rules-write.ts`). Always creates the new rule DISABLED;
     * confirm is mandatory, independent of blast radius — see that
     * function's own doc comment. Optional (unlike `enabled`/`fields`/
     * `undo`/`plan`/`delete` above, which predate this ticket and every
     * existing caller of this object already supplies): an omitted
     * `create` (or `planCreate` below) makes `POST /api/rules` answer 503,
     * same "endpoint disabled: not configured" discipline every other
     * optional `ViewDeps` dependency already follows — never a reason to
     * widen every pre-existing literal of this object.
     */
    create?: (input: RuleCreateInput, confirm: boolean, planHash: string) => Promise<RulesWriteOutcome>;
    /** FACTORY-927 — `POST /api/rules`'s own report-only dry-run (`planRuleCreate`), used identically to a plain request without `confirm: true`: never writes, returns the dry-run scope and a fresh `planHash` to echo back. Optional — see `create`'s own doc comment immediately above. */
    planCreate?: (input: RuleCreateInput, confirm: boolean) => Promise<RulesPlanOutcome>;
  };
  /**
   * FACTORY-662 — records one audit line (accepted or rejected) for every
   * write attempt that got far enough to be route-specific logic (i.e.
   * passed `writeGuard`) — see `../web/audit-log.ts`. Optional: an omitted
   * value means writes are still refused/accepted exactly the same, just
   * unaudited — never a reason to open a route that would otherwise be
   * closed.
   */
  auditWrite?: (event: { route: string; action: string; ids: string[]; diffSummary: string; origin: string | null; uid: number | undefined; outcome: "accepted" | "rejected"; reason?: string }) => void;
  /**
   * N2 (FACTORY-678) — the per-client write-flood limit (`./write-rate-
   * limit.ts`'s `createWriteRateLimiter`), shared by ALL FOUR write-shaped
   * routes (`POST /api/rules/:id/enabled`, `PUT /api/rules/:id`, `POST
   * /api/rules/plan`, `POST /api/undo/:backupId`) — ONE instance, built
   * once by the caller (same discipline as `rulesPreview`/`scopeOf`
   * above), so its per-client state actually accumulates across requests
   * and across routes. Keyed by the caller's own socket address (see that
   * module's own header for why). Checked AFTER `checkWriteGuard` passes
   * but BEFORE any route-specific write logic runs, so a request this
   * limiter refuses never reaches `rulesWrite.*` at all, and a request it
   * allows still counts against the budget regardless of what the
   * downstream write logic decides. Optional: an omitted limiter means no
   * flood protection, never a reason to refuse a write that would
   * otherwise be allowed.
   */
  writeRateLimit?: (clientKey: string) => WriteRateLimitOutcome;
  /**
   * FACTORY-664 (epic FACTORY-659, slice S1, READ-ONLY) — `GET /api/settings`'s
   * own data: one entry per setting butchr reads (see `./settings-api.ts`),
   * secrets redacted, plus the `ATLASSIAN_TOKEN_FILE` path status and a
   * best-effort `unitHint`. Read FRESH every request (same discipline as
   * `rulesFileState` above) — this does real but small I/O (one `fs.stat`
   * and one `systemctl` call), never on `/`'s or `/dashboard`'s own request
   * path. Optional: an omitted value makes the route unreachable (503),
   * never open.
   */
  settings?: () => Promise<SettingsApiResponse>;
  /**
   * FACTORY-664 — `POST /api/settings/jira/test`'s own logic: calls
   * Atlassian `GET /rest/api/3/myself` with the daemon's OWN credentials
   * (never anything from the request) and reports back the fixed, non-
   * leaking shape `./jira-connection-test.ts` defines. Optional: an omitted
   * value makes the route unreachable (503), never open.
   */
  jiraTest?: () => Promise<JiraTestResult>;
  /**
   * FACTORY-664 — a SEPARATE rate limiter from `writeRateLimit` above (1 per
   * 5s, per the ticket's own spec, not the generic write budget): this route
   * makes a real outbound credentialed call, so it gets its own, tighter
   * budget. Same "absent means no flood protection, never a reason to
   * refuse" discipline as `writeRateLimit`.
   */
  jiraTestRateLimit?: (clientKey: string) => WriteRateLimitOutcome;
  /**
   * FACTORY-665 — `PUT /api/settings/:key`'s own write logic
   * (`../settings/write-settings.ts`'s `writeSetting`), already bound to
   * this daemon's own `SettingsFileEnv`. Returns the new effective
   * `SettingsApiResponse` (same shape `GET /api/settings` serves) so the
   * UI can update in place without a second round-trip. Throws
   * `SettingsWriteRefusedError` (not a route-shaped outcome object, unlike
   * `rulesWrite.*` above) on any validation/range/lock failure — the route
   * catches it, same pattern `jiraTest`'s own error handling would use if
   * it threw. Optional: an omitted value makes the route unreachable
   * (503), never open.
   */
  settingsWrite?: (key: string, value: string, confirm: boolean) => Promise<SettingsApiResponse>;
  /**
   * FACTORY-665 — `POST /api/daemon/restart`'s own logic
   * (`./daemon-restart.ts`'s `restartDaemon`): fires `systemctl --user
   * restart butchr.service` (fixed argv) ONLY when this daemon is actually
   * running under that unit, else returns the 409 refusal verbatim.
   * Optional: an omitted value makes the route unreachable (503).
   */
  daemonRestart?: () => Promise<DaemonRestartOutcome>;
  /**
   * FACTORY-665 — a SEPARATE, much tighter rate limiter from
   * `writeRateLimit` above: restart is rate-limited to 1 per 10 minutes
   * PER THE TICKET'S OWN SPEC (not the generic write-flood budget, and not
   * per-client — restarting butchr once already affects every client).
   * Optional: an omitted value means no flood protection on this route,
   * never a reason to refuse a restart that would otherwise be allowed.
   */
  daemonRestartRateLimit?: () => WriteRateLimitOutcome;
  /**
   * FACTORY-665 (PR-2) — `GET /api/setup/status`'s own data: whether the
   * daemon is fully configured (Atlassian identity present) or running in
   * setup mode. Synchronous, no I/O (reads a boolean this daemon's own
   * startup already decided — see `../config/config.ts`'s
   * `isAtlassianConfigured`). Optional: an omitted value makes the route
   * unreachable (503), never open.
   */
  setupStatus?: () => SetupStatusResponse;
  /**
   * FACTORY-665 (PR-2) — `POST /api/setup/jira`'s own logic (setup mode
   * ONLY — this daemon's setup-mode startup, `../daemon/setup-mode.ts`,
   * binds this with `requireEnvCheck: false` baked in, since setup mode by
   * definition means no env-provided token exists yet). Site/email come
   * from the request body here (this is the ONE time they are ever
   * settable other than by hand/shell — see the ticket's own "shell-only
   * after setup" rule). Optional: an omitted value makes the route
   * unreachable (503).
   */
  setupJiraWrite?: (input: { site: string; email: string; token: string; setupCode: string }, rateGate?: RateGate) => Promise<JiraWriteRequestOutcome>;
  /**
   * FACTORY-665 (PR-2) — `PUT /api/settings/jira/token`'s own logic
   * (configured mode — ROTATION only, never settable site/email here: this
   * daemon's own already-loaded `config.atlassian.site`/`.email` are
   * reused by the closure `../daemon/index.ts` binds, with
   * `requireEnvCheck: true` baked in). Optional: an omitted value makes
   * the route unreachable (503).
   */
  jiraTokenRotate?: (input: { token: string; setupCode: string }, rateGate?: RateGate) => Promise<JiraWriteRequestOutcome>;
  /**
   * FACTORY-665 (PR-2) — shared by BOTH `POST /api/setup/jira` and `PUT
   * /api/settings/jira/token`: 5 attempts per 10 minutes per the ticket's
   * own spec (every call makes a real outbound credentialed test, same
   * reasoning as `jiraTestRateLimit` above, just a tighter budget since a
   * successful call here also WRITES a secret). Counts every attempt,
   * accepted or refused — same "no free re-tries" discipline `writeRateLimit`
   * documents. Optional: absent means no flood protection, never a reason
   * to refuse.
   */
  jiraTokenTestRateLimit?: (clientKey: string) => WriteRateLimitOutcome;
  /**
   * FACTORY-665 (PR-2) — a SEPARATE, much tighter budget on top of
   * `jiraTokenTestRateLimit`: 3 SUCCESSFUL writes per hour, per the
   * ticket's own spec. Checked immediately alongside the test limiter
   * (before any network call), not only after a write succeeds — see
   * `./view.ts`'s own route comment for why checking it up-front, even
   * though it is a "successful write" budget, is the conservative and
   * simple choice here. Optional: absent means no flood protection.
   */
  jiraTokenWriteRateLimit?: (clientKey: string) => WriteRateLimitOutcome;
  /**
   * FACTORY-666 — the agent-control orchestration (`../agents/agents-write.ts`).
   * One function per action; each already does its own ownership/reason/
   * confirm checks and returns a tagged outcome this file maps straight to
   * a status + body, never re-deciding anything here. Optional: an omitted
   * value makes every `/api/agents/:issue/*` route answer 503, same
   * "endpoint disabled: not configured" discipline every other optional
   * `ViewDeps` dependency already follows.
   */
  agentsWrite?: {
    snapshot: (issue: string) => Promise<AgentWriteOutcome>;
    start: (issue: string) => Promise<AgentWriteOutcome>;
    planStop: (issue: string) => Promise<AgentWriteOutcome>;
    stop: (issue: string) => Promise<AgentWriteOutcome>;
    planShelve: (issue: string, reason: string) => Promise<AgentWriteOutcome>;
    shelve: (issue: string, reason: string) => Promise<AgentWriteOutcome>;
    adopt: (issue: string, input: AdoptInput) => Promise<AgentWriteOutcome>;
    prioritize: (issue: string, priority: string) => Promise<AgentWriteOutcome>;
  };
}

/** `onParse`'s own sentinels for a body that failed to become JSON cleanly (too large, or not valid JSON) — see `view.ts`'s `onParse` hook. A route handler checks for either BEFORE reading any of its own expected fields off `body`. */
function bodyProblem(body: unknown): { status: number; error: string } | null {
  if (body && typeof body === "object") {
    if ((body as Record<string, unknown>).__bodyTooLarge) return { status: 413, error: `request body exceeds the ${BODY_CAP_BYTES} byte cap` };
    if ((body as Record<string, unknown>).__invalidJson) return { status: 400, error: "invalid JSON body" };
  }
  return null;
}

/**
 * FACTORY-662 item 4: records one audit line for a write ROUTE's outcome
 * (accepted or rejected) — `deps.auditWrite` is optional (absent means
 * unaudited, never a reason to refuse or allow anything differently, see
 * `ViewDeps.auditWrite`'s own doc comment). `uid` is `process.getuid?.()`,
 * not a value read off the request: by the time a write route's handler
 * runs, `onRequest`'s `peerUidCheck` has ALREADY proven the caller's own
 * uid equals this process's — so this process's own uid IS the caller's,
 * by construction, with no second lookup needed.
 */
/** The test limiter then the write limiter, checked only once the setup code has verified (see `RateGate`). */
function jiraRateGate(deps: ViewDeps, clientKey: string): RateGate {
  return () => {
    const test = deps.jiraTokenTestRateLimit?.(clientKey);
    if (test && !test.ok) return { ok: false, error: `rate limited: too many token tests — retry after ${test.retryAfterSeconds}s`, retryAfterSeconds: test.retryAfterSeconds };
    const write = deps.jiraTokenWriteRateLimit?.(clientKey);
    if (write && !write.ok) return { ok: false, error: `rate limited: too many token writes this hour — retry after ${write.retryAfterSeconds}s`, retryAfterSeconds: write.retryAfterSeconds };
    return { ok: true };
  };
}

/**
 * FACTORY-729 — one audit line per CHANGED field, old -> new, for `PUT
 * /api/rules/:id` (the ticket's own instruction). `current` is this
 * daemon's own already-loaded rule (`deps.getRules()`, no second read) —
 * `undefined` only when that dep is absent or the id is unknown, in which
 * case a field's "old" value reads as `null` rather than failing the audit
 * line entirely (this is a best-effort annotation on top of an outcome the
 * route already computed; it must never block or alter that outcome).
 */
function buildFieldDiffSummary(current: Rule | undefined, patch: RuleFieldPatch): string {
  const parts: string[] = [];
  const show = (v: unknown): string => JSON.stringify(v === undefined ? null : v);
  if (patch.query !== undefined) parts.push(`query: ${show(current?.query)} -> ${show(patch.query)}`);
  if (patch.permissionMode !== undefined) parts.push(`permissionMode: ${show(current?.permissionMode)} -> ${show(patch.permissionMode)}`);
  if (patch.lizardMode !== undefined) parts.push(`lizardMode: ${show(current?.lizardMode)} -> ${show(patch.lizardMode)}`);
  if (patch.role !== undefined) parts.push(`role: ${show(current?.role)} -> ${show(patch.role)}`);
  // FACTORY-846: same one-line-per-changed-field treatment as permissionMode/lizardMode above.
  if (patch.idlePokeMinutes !== undefined) parts.push(`idlePokeMinutes: ${show(current?.idlePokeMinutes)} -> ${show(patch.idlePokeMinutes)}`);
  if (patch.idlePokeMessage !== undefined) parts.push(`idlePokeMessage: ${show(current?.idlePokeMessage)} -> ${show(patch.idlePokeMessage)}`);
  if (patch.idlePokeEnabled !== undefined) parts.push(`idlePokeEnabled: ${show(current?.idlePokeEnabled)} -> ${show(patch.idlePokeEnabled)}`);
  if (patch.agentPreferences !== undefined) {
    patch.agentPreferences.forEach((p, i) => {
      const cur = current?.agentPreferences?.[i] as Record<string, unknown> | undefined;
      for (const leaf of ["harness", "model", "effort", "modelPower", "effortPower"] as const) {
        const v = (p as Record<string, unknown>)[leaf];
        if (v !== undefined) parts.push(`agentPreferences[${i}].${leaf}: ${show(cur?.[leaf])} -> ${show(v)}`);
      }
    });
  }
  return parts.length ? parts.join("; ") : "edit";
}

/**
 * FACTORY-694 item 2: `ctx.kind` defaults to `"write"` (every pre-existing
 * caller is a real config write, unchanged) — `POST /api/settings/jira/test`
 * is the one caller that passes `kind: "test"`, since a connection test
 * changes nothing and must never be labeled or alerted on as a write (see
 * `./audit-log.ts`'s own `composeAlertText`/`createAuditLogger` for what
 * `kind` changes: a "test" success alerts nobody, and a "test" failure gets
 * its own label and never joins the write-rejection aggregator).
 */
function auditOutcome(deps: ViewDeps, ctx: { route: string; action: string; ids: string[]; origin: string | null; kind?: "write" | "test" }, outcome: { ok: boolean; error?: string }): void {
  if (!deps.auditWrite) return;
  const base = { route: ctx.route, action: ctx.action, ids: ctx.ids, diffSummary: ctx.action, origin: ctx.origin, uid: process.getuid?.(), kind: ctx.kind ?? "write" as const };
  deps.auditWrite(outcome.ok ? { ...base, outcome: "accepted" } : { ...base, outcome: "rejected", reason: outcome.error ?? "rejected" });
}

/**
 * N2 (FACTORY-678) — run right after `checkWriteGuard` passes, before any
 * route-specific write logic. `null` means "allowed, proceed" (or no
 * limiter configured at all); a non-null result is the ALREADY-AUDITED
 * 429 refusal a route handler should return immediately, verbatim —
 * `auditOutcome` is called here (not left to the caller) so every route
 * records this refusal through the SAME rejected-write pipeline (and so
 * the existing B4 rejected-burst alert aggregation, `./audit-log.ts`,
 * still bounds the alert count across a write-flood burst rather than
 * this limiter creating its own unbounded stream of 429 alerts).
 */
function checkWriteRateLimit(deps: ViewDeps, client: { address: string; port: number } | undefined, ctx: { route: string; action: string; ids: string[]; origin: string | null }): { status: 429; body: { error: string }; retryAfterSeconds: number } | null {
  if (!deps.writeRateLimit) return null;
  const clientKey = client?.address ?? "unresolved";
  const result = deps.writeRateLimit(clientKey);
  if (result.ok) return null;
  const error = `rate limited: too many write attempts — retry after ${result.retryAfterSeconds}s`;
  auditOutcome(deps, ctx, { ok: false, error });
  return { status: 429, body: { error }, retryAfterSeconds: result.retryAfterSeconds };
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

  // FACTORY-662 — `GET /api/session` and every write route share a guard
  // checked in `onRequest`, BEFORE Elysia's own body parsing ever runs (see
  // `./write-guard.ts`'s own header for why this ordering is load-bearing,
  // not cosmetic). A refusal here returns a value, which Elysia's
  // `mapEarlyResponse` turns into the actual response and skips
  // `onParse`/the route handler entirely.
  //
  // AGENTSAFETY FIRST-PASS FINDING B1 (SHIP-BLOCKER, 2026-10-06): the
  // previous version matched write routes with EXACT per-route regexes
  // (`^/api/rules/plan$`, ...) — a trailing slash, a repeated slash, or any
  // other path variant Elysia's own router still dispatches to the SAME
  // handler matched none of them, so the guard silently never ran while
  // the write still happened. Fixed with TWO independent layers, per the
  // review's own "attach the guard to the routes themselves AND fail
  // closed for every non-GET under /api/ regardless of path shape":
  //   1. This `onRequest` hook now fails closed on PATH SHAPE, not path
  //      MATCH: any method other than GET/HEAD/OPTIONS whose pathname
  //      starts with `/api/` is refused unless it passes `checkWriteGuard`
  //      — a plain `startsWith`, which (unlike a route-shaped regex) stays
  //      true for a trailing slash, a repeated slash, or any other
  //      variant, because none of those change the string's own prefix.
  //   2. Every write route handler below ALSO calls `checkWriteGuard`
  //      itself, as its own first lines — see each route's own comment.
  //      That makes the guard a property of the HANDLER, never of a
  //      separate path-matching mechanism that could drift from what
  //      Elysia's router actually dispatches — so even a future route this
  //      `onRequest` prefix check somehow failed to cover is still safe.
  // `checkWriteGuard` (`./write-guard.ts`) is called directly here, not
  // re-implemented inline — the SAME function both layers and every tests'
  // own go-red cases exercise.
  const API_PREFIX = "/api/";
  const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

  function buildWriteGuardRequest(request: Request, server: { requestIP: (r: Request) => { address: string; port: number } | null } | null): WriteGuardRequest {
    return {
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
      method: request.method,
      contentType: request.headers.get("content-type"),
      csrfHeader: request.headers.get(CSRF_HEADER),
      client: server?.requestIP(request) ?? undefined,
    };
  }

  return new Elysia()
    .onRequest(async ({ request, set, server }) => {
      const method = request.method;
      const path = new URL(request.url).pathname;
      const isSessionRoute = method === "GET" && path === "/api/session";
      if (isSessionRoute) {
        if (!deps.dashboardOriginGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
        // S1 (agentsafety second pass, 2026-10-05): this is a GET, so the
        // SAME no-Origin + `Sec-Fetch-Site: same-origin` fallback the other
        // GET routes (`/api/rules`, `/api/rules/:id/preview`) already pass
        // applies here too — omitting it blocked the dashboard's own
        // same-origin `fetch("/api/session")` (no `Origin` header at all).
        const originGuard = checkDashboardOrigin({ origin: request.headers.get("origin"), host: request.headers.get("host"), secFetchSite: request.headers.get("sec-fetch-site"), method }, deps.dashboardOriginGuard);
        if (!originGuard.ok) { set.status = originGuard.status; return originGuard.body; }
        if (!deps.peerUidCheck) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
        const client = server?.requestIP(request) ?? undefined;
        if (!client || !(await deps.peerUidCheck(client))) { set.status = 403; return { error: "peer uid check failed" }; }
        return;
      }
      if (SAFE_METHODS.has(method) || !path.startsWith(API_PREFIX)) return; // not a write route this gate owns
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
    })
    // FACTORY-662 item 3: a capped, counted read (never a trust in
    // `Content-Length` alone) BEFORE `JSON.parse` — global, since every
    // write route in this daemon is small JSON and `/resources/for-url`'s
    // existing POST body is a single URL string, well under the cap too.
    // Runs AFTER `onRequest` above, so a request already refused there
    // (forbidden Origin, bad CSRF, etc.) never reaches this read at all —
    // oversize is tested from an ALLOWED origin for exactly this reason.
    .onParse(async ({ request, set }, contentType) => {
      if (!contentType.startsWith("application/json")) return undefined;
      const result = await cappedReadText(request, BODY_CAP_BYTES);
      if (!result.ok) {
        set.status = 413;
        return { __bodyTooLarge: true };
      }
      if (result.text.length === 0) return {};
      try {
        return JSON.parse(result.text);
      } catch {
        set.status = 400;
        return { __invalidJson: true };
      }
    })
    // FACTORY-662 item 8: dashboard hardening headers, on EVERY response
    // this app serves — `default-src 'self'` with no inline script (every
    // script this daemon serves is an external file, per `static-assets.ts`),
    // `frame-ancestors 'none'` (this dashboard is never meant to be framed),
    // and `X-Content-Type-Options: nosniff`. `esc()`-ing every rendered
    // field is `dashboard-page.ts`/`config-inventory-page.ts`'s own job
    // (pre-existing, unchanged by this ticket) — these headers are the
    // browser-side backstop if that ever lapsed.
    .onAfterHandle(({ set, request }) => {
      // Second-pass finding: `/` and `/configurations` (the pre-existing
      // legacy pages, `dashboard-page.ts`/`config-inventory-page.ts`, both
      // UNCHANGED by this ticket) render inline `<style>` blocks — a
      // strict `style-src 'self'` blocks them in a real browser. Scoped to
      // exactly those two paths; `script-src` stays `'self'` with NO
      // `'unsafe-inline'` everywhere, including on these two pages — only
      // style, never script, gets the relaxation, and only on these two
      // routes.
      const path = new URL(request.url).pathname;
      const styleSrc = path === "/" || path === "/configurations" ? "style-src 'self' 'unsafe-inline';" : "style-src 'self';";
      set.headers["content-security-policy"] = `default-src 'self'; frame-ancestors 'none'; script-src 'self'; ${styleSrc} object-src 'none'; base-uri 'none'`;
      set.headers["x-content-type-options"] = "nosniff";
      set.headers["x-frame-options"] = "DENY";
    })
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
      if (!client || !(await deps.peerUidCheck(client))) { set.status = 403; return { error: "peer uid check failed" }; }
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
    // FACTORY-729 — the rule form's own catalog: one entry per harness
    // naming the shipped models/efforts/permission-modes the UI's
    // provider/model/effort/mode dropdowns and lizard-mode toggle should
    // offer, plus whether a custom model id is allowed. Pure constants, no
    // I/O at all — still behind the SAME dashboard-origin + same-UID peer
    // guard `GET /api/rules` uses (this ticket's own instruction), never a
    // looser check just because there's nothing to protect on disk here.
    .get("/api/rules/catalog", async ({ request, server, set }) => {
      if (!deps.dashboardOriginGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = checkDashboardOrigin({ origin: request.headers.get("origin"), host: request.headers.get("host"), secFetchSite: request.headers.get("sec-fetch-site"), method: request.method }, deps.dashboardOriginGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.peerUidCheck) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const client = server?.requestIP(request);
      if (!client || !(await deps.peerUidCheck(client))) { set.status = 403; return { error: "peer uid check failed" }; }
      if (!deps.rulesCatalog) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      set.headers["cache-control"] = "no-store";
      // FACTORY-817: `role` ("Included in capacity") is not per-harness like
      // the rest of this catalog — one global pair of allowed values plus
      // the engine's own default, documented here so the UI never hardcodes
      // either (`AGENT_ROLES`/the `"worker"` default both come straight off
      // `../rules/rules.js`'s own `Rule.role` doc comment, never a second,
      // hand-maintained copy).
      return { harnesses: deps.rulesCatalog(), capacityRoles: { values: AGENT_ROLES, default: CAPACITY_ROLE_DEFAULT } };
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
    .get("/api/rules/:id/preview", async ({ params, query, request, server, set }) => {
      if (!deps.dashboardOriginGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = checkDashboardOrigin({ origin: request.headers.get("origin"), host: request.headers.get("host"), secFetchSite: request.headers.get("sec-fetch-site"), method: request.method }, deps.dashboardOriginGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.peerUidCheck) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const client = server?.requestIP(request);
      if (!client || !(await deps.peerUidCheck(client))) { set.status = 403; return { error: "peer uid check failed" }; }
      if (!deps.rulesPreview) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      let id: string;
      try {
        id = decodeURIComponent(params.id);
      } catch {
        set.status = 400;
        return { error: "malformed rule id" };
      }
      set.headers["cache-control"] = "no-store";
      // FACTORY-730 — `?query=`: the edit dialog's own draft-query dry-run,
      // never persisted and never the rule's own stored query (`deps.rulesPreview`
      // reads that fresh on every call regardless of this override).
      const queryOverride = typeof query?.query === "string" ? query.query : undefined;
      const result = await deps.rulesPreview(id, queryOverride);
      if (!result.ok) { set.status = result.status; return { error: result.error }; }
      const { ok, ...body } = result;
      return body;
    })
    // FACTORY-664 (epic FACTORY-659, slice S1, READ-ONLY) — `GET /api/settings`.
    // Same guard chain as `GET /api/rules` (dashboard-origin guard, same-UID
    // peer check, `Cache-Control: no-store`): this reflects live,
    // possibly-sensitive-feeling configuration state, never cached, and
    // never reachable by a local user who isn't this daemon's own operator.
    .get("/api/settings", async ({ request, server, set }) => {
      if (!deps.dashboardOriginGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = checkDashboardOrigin({ origin: request.headers.get("origin"), host: request.headers.get("host"), secFetchSite: request.headers.get("sec-fetch-site"), method: request.method }, deps.dashboardOriginGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.peerUidCheck) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const client = server?.requestIP(request);
      if (!client || !(await deps.peerUidCheck(client))) { set.status = 403; return { error: "peer uid check failed" }; }
      if (!deps.settings) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      set.headers["cache-control"] = "no-store";
      return deps.settings();
    })
    // FACTORY-664 — `POST /api/settings/jira/test`. The FULL write guard
    // chain (Origin, Host, peer-uid, Content-Type, CSRF) because this makes
    // an outbound credentialed call, plus its own tighter rate limit (1 per
    // 5s — separate from the generic write-flood budget). Every attempt
    // (accepted or rejected by the guard/limiter) is audited, with its OWN
    // "jira-test" audit kind (FACTORY-694 item 2 — see `auditOutcome`'s own
    // doc comment: a test is never a config write, so it must never alert
    // on success and must never share the write-rejection aggregator); the
    // result handed back is the fixed, non-leaking shape `jiraTest()`
    // already returns — this route never sees or forwards the upstream
    // body/token.
    //
    // FACTORY-694 item 1: this route has NO body of its own to read (the
    // test always uses the daemon's own already-loaded credentials) — but
    // the global `onParse` hook still runs before this handler and sets
    // `set.status` to 413/400 on an oversize or malformed body, which would
    // otherwise leak through verbatim underneath this route's own 200 (the
    // outbound call still made, the limiter slot still burned, with a
    // misleading 413/400 glued onto a real result). Checked here, right
    // after the guard and BEFORE the limiter or `jiraTest()` — a bad
    // sentinel refuses outright, same as every other write route's own
    // `bodyProblem` check.
    .post("/api/settings/jira/test", async ({ set, request, server, body }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) {
        auditOutcome(deps, { route: "POST /api/settings/jira/test", action: "jira-test", ids: [], origin: request.headers.get("origin"), kind: "test" }, { ok: false, error: guard.reason });
        set.status = guard.status;
        return guard.body;
      }
      if (!deps.jiraTest) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const bad = bodyProblem(body);
      if (bad) {
        auditOutcome(deps, { route: "POST /api/settings/jira/test", action: "jira-test", ids: [], origin: request.headers.get("origin"), kind: "test" }, { ok: false, error: bad.error });
        set.status = bad.status;
        return { error: bad.error };
      }
      if (deps.jiraTestRateLimit) {
        const clientKey = server?.requestIP(request)?.address ?? "unresolved";
        const result = deps.jiraTestRateLimit(clientKey);
        if (!result.ok) {
          const error = `rate limited: too many jira connection tests — retry after ${result.retryAfterSeconds}s`;
          auditOutcome(deps, { route: "POST /api/settings/jira/test", action: "jira-test", ids: [], origin: request.headers.get("origin"), kind: "test" }, { ok: false, error });
          set.status = 429;
          set.headers["retry-after"] = String(result.retryAfterSeconds);
          return { error };
        }
      }
      const result = await deps.jiraTest();
      auditOutcome(deps, { route: "POST /api/settings/jira/test", action: "jira-test", ids: [], origin: request.headers.get("origin"), kind: "test" }, result.ok ? { ok: true } : { ok: false, error: result.error ?? "rejected" });
      return result;
    })
    // FACTORY-665 (PR-2) — `GET /api/setup/status`. Same guard discipline as
    // `GET /api/settings` immediately above (dashboard-origin + peer-uid) —
    // deliberately NOT gated on this daemon being configured, since the
    // dashboard's own Setup page polls this route BEFORE configuration
    // exists at all.
    .get("/api/setup/status", async ({ request, server, set }) => {
      if (!deps.dashboardOriginGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = checkDashboardOrigin({ origin: request.headers.get("origin"), host: request.headers.get("host"), secFetchSite: request.headers.get("sec-fetch-site"), method: request.method }, deps.dashboardOriginGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.peerUidCheck) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const client = server?.requestIP(request);
      if (!client || !(await deps.peerUidCheck(client))) { set.status = 403; return { error: "peer uid check failed" }; }
      if (!deps.setupStatus) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      set.headers["cache-control"] = "no-store";
      return deps.setupStatus();
    })
    // FACTORY-665 (PR-2) — `POST /api/setup/jira` (setup mode only — see
    // `../daemon/setup-mode.ts`, which is the only place this dep is ever
    // bound). Full write guard chain, THEN both the test and write rate
    // limiters (checked up front, before any network call — see
    // `ViewDeps.jiraTokenWriteRateLimit`'s own doc comment), THEN the
    // route hands the body straight to `deps.setupJiraWrite`, which owns
    // the setup-code check, site-shape validation, and the token test +
    // write themselves. This route NEVER logs or audits the request body's
    // own `token`/`setupCode` fields — `ids`/`diffSummary` below name only
    // the route and a fixed action string.
    .post("/api/setup/jira", async ({ set, request, server, body }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) {
        auditOutcome(deps, { route: "POST /api/setup/jira", action: "setup", ids: [], origin: request.headers.get("origin") }, { ok: false, error: guard.reason });
        set.status = guard.status;
        return guard.body;
      }
      if (!deps.setupJiraWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const clientKey = server?.requestIP(request)?.address ?? "unresolved";
      const rateGate = jiraRateGate(deps, clientKey);
      const bad = bodyProblem(body);
      if (bad) { set.status = bad.status; return { error: bad.error }; }
      const b = body as Record<string, unknown>;
      if (typeof b.site !== "string" || typeof b.email !== "string" || typeof b.token !== "string" || typeof b.setupCode !== "string") {
        set.status = 400;
        return { error: "body must be { site: string, email: string, token: string, setupCode: string }" };
      }
      const result = await deps.setupJiraWrite({ site: b.site, email: b.email, token: b.token, setupCode: b.setupCode }, rateGate);
      auditOutcome(deps, { route: "POST /api/setup/jira", action: "setup", ids: [], origin: request.headers.get("origin") }, result.ok ? { ok: true } : { ok: false, error: result.body.error });
      set.status = result.status;
      if (result.status === 429) set.headers["retry-after"] = String(result.retryAfterSeconds);
      return result.body;
    })
    // FACTORY-665 (PR-2) — `PUT /api/settings/jira/token` (configured mode
    // — ROTATION only; see `src/daemon/index.ts`, which binds
    // `jiraTokenRotate` with `requireEnvCheck: true` and this daemon's own
    // already-loaded site/email). Same guard/rate-limit/audit discipline as
    // `POST /api/setup/jira` immediately above.
    .put("/api/settings/jira/token", async ({ set, request, server, body }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) {
        auditOutcome(deps, { route: "PUT /api/settings/jira/token", action: "rotate", ids: [], origin: request.headers.get("origin") }, { ok: false, error: guard.reason });
        set.status = guard.status;
        return guard.body;
      }
      if (!deps.jiraTokenRotate) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const clientKey = server?.requestIP(request)?.address ?? "unresolved";
      const rateGate = jiraRateGate(deps, clientKey);
      const bad = bodyProblem(body);
      if (bad) { set.status = bad.status; return { error: bad.error }; }
      const b = body as Record<string, unknown>;
      if (typeof b.token !== "string" || typeof b.setupCode !== "string") {
        set.status = 400;
        return { error: "body must be { token: string, setupCode: string }" };
      }
      const result = await deps.jiraTokenRotate({ token: b.token, setupCode: b.setupCode }, rateGate);
      auditOutcome(deps, { route: "PUT /api/settings/jira/token", action: "rotate", ids: [], origin: request.headers.get("origin") }, result.ok ? { ok: true } : { ok: false, error: result.body.error });
      set.status = result.status;
      if (result.status === 429) set.headers["retry-after"] = String(result.retryAfterSeconds);
      return result.body;
    })
    // FACTORY-662 item 1: `GET /api/session` — mints/hands out this
    // process's one CSRF token. The Origin/Host/peer-uid guard already ran
    // in `onRequest` above; by the time this handler runs, the caller has
    // already proven it IS this daemon's own dashboard, on this same
    // machine, as this same uid.
    .get("/api/session", ({ set }) => {
      if (!deps.csrf) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      set.headers["cache-control"] = "no-store";
      return { csrfToken: deps.csrf.token };
    })
    // FACTORY-927 — `POST /api/rules`: create a new rule from the Rules
    // page. Own `checkWriteGuard` call (see the enable route's own comment
    // below for why that's load-bearing, not merely redundant with
    // `onRequest`'s own prefix check), the SAME shared write-rate limit
    // every other write-shaped route uses, and the SAME `auditOutcome`
    // pipeline. `deps.rulesWrite.planCreate` is called FIRST, on every
    // request — it never writes, and is the ONE call every attempt makes
    // regardless of `confirm`.
    //
    // THREE OUTCOMES (review round 1, 2026-10-09, items 2/3 — fixing an
    // audit-noise bug: the previous version called `create` even when the
    // plan merely reported "not yet confirmed," so every ORDINARY two-step
    // create wrote a spurious REJECTED audit line on its first call):
    //   1. `plan.ok === false`, OR `plan.ok === true` but the scope could
    //      not be measured (`plan.scopeUnmeasurable`) — a genuine refusal
    //      (collision, stale file, or a previewer that's down), audited as
    //      rejected, same as any other write refusal. `confirmReason`
    //      (`"unmeasurable-scope"` for the second case; absent for the
    //      first — a collision/staleness refusal is never a "just confirm
    //      it" situation) rides the response body verbatim, same shape
    //      `DELETE /api/rules/:id` already returns it in.
    //   2. `plan.ok === true`, scope WAS measured, but `confirm` was not
    //      `true` on this call — the ORDINARY first step of the two-step
    //      flow: returns the plan itself, 200, `requiresConfirm: true`,
    //      `confirmReason: "rule-create"` — a real, typed response shape
    //      (the SAME `RulesPlanResult` shape `POST /api/rules/plan`
    //      already returns for an edit/enable dry run) carrying `scope`/
    //      `planHash` structurally, never a string for the client to parse
    //      a number back out of. UNAUDITED — same precedent `POST
    //      /api/rules/plan` already sets for its own report-only dry run
    //      (that route has no `auditOutcome` call at all): this is
    //      exploration, not an attempted write, so it must never count
    //      against N2's write-flood budget's own alert aggregation the way
    //      a real rejected write does.
    //   3. `plan.ok === true`, scope measured, AND `confirm === true` —
    //      the real write: `create` is called (with the plan's own
    //      just-computed `planHash` — see `createRule`'s own doc comment
    //      for why a client-supplied one is never needed here), and its
    //      outcome (accepted or refused) is ALWAYS audited — this is the
    //      one call this route makes that can actually write.
    .post("/api/rules", async ({ body, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      const createRule = deps.rulesWrite?.create;
      const planCreateRule = deps.rulesWrite?.planCreate;
      if (!createRule || !planCreateRule) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const limited = checkWriteRateLimit(deps, server?.requestIP(request) ?? undefined, { route: "POST /api/rules", action: "create", ids: [], origin: request.headers.get("origin") });
      if (limited) { set.status = limited.status; set.headers["retry-after"] = String(limited.retryAfterSeconds); return limited.body; }
      const bad = bodyProblem(body);
      if (bad) {
        // Review round 1, item 4 (AC7 gap): a malformed body is still a
        // refused create ATTEMPT — audited exactly like every other
        // validation failure below, never silently skipped just because
        // the failure is early. No id is known yet at this point (the body
        // never parsed far enough to have one).
        auditOutcome(deps, { route: "POST /api/rules", action: "create", ids: [], origin: request.headers.get("origin") }, { ok: false, error: bad.error });
        set.status = bad.status;
        return { error: bad.error };
      }
      // Best-effort id for the audit line below even when validation
      // itself is what's about to fail — the same "name what we can" spirit
      // every other route's own audit context already follows.
      const rawId = body && typeof body === "object" ? (body as Record<string, unknown>).id : undefined;
      const idsForAudit = typeof rawId === "string" ? [rawId] : [];
      const parsed = validateRuleCreateInput(body);
      if (!parsed.ok) {
        auditOutcome(deps, { route: "POST /api/rules", action: "create", ids: idsForAudit, origin: request.headers.get("origin") }, { ok: false, error: parsed.error });
        set.status = 400;
        return { error: parsed.error };
      }
      const b = body as Record<string, unknown>;
      const confirm = b.confirm === true;
      const ids = [parsed.input.id];
      const plan = await planCreateRule(parsed.input, confirm);
      if (!plan.ok) {
        auditOutcome(deps, { route: "POST /api/rules", action: "create", ids, origin: request.headers.get("origin") }, { ok: false, error: plan.error });
        set.status = plan.status;
        return { error: plan.error };
      }
      if (plan.scopeUnmeasurable) {
        // Same unconditional fail-closed discipline `createRule` itself
        // documents for this case — refused here, before ever reaching the
        // write lock, so a previewer outage never produces a confusing
        // "needs confirm" response for a number that was never real.
        auditOutcome(deps, { route: "POST /api/rules", action: "create", ids, origin: request.headers.get("origin") }, { ok: false, error: `could not evaluate the scope for the new rule's query — the previewer is unavailable; try again` });
        set.status = 503;
        return { error: `could not evaluate the scope for the new rule's query — the previewer is unavailable; this create is refused closed (even with confirm: true) until scope can be measured — try again`, confirmReason: plan.confirmReason };
      }
      if (plan.requiresConfirm) {
        // Outcome 2 above — the ordinary "not yet confirmed" dry run.
        // Deliberately `return plan;` verbatim, never audited: see this
        // route's own header comment.
        return plan;
      }
      const outcome = await createRule(parsed.input, confirm, plan.planHash);
      auditOutcome(deps, { route: "POST /api/rules", action: "create", ids, origin: request.headers.get("origin") }, outcome);
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error, ...(outcome.confirmReason ? { confirmReason: outcome.confirmReason } : {}) }; }
      return outcome;
    })
    // FACTORY-662 item 7: `POST /api/rules/:id/enabled` — the ONLY route
    // that may flip `enabled`, for exactly the "ui-" marked rules, gated by
    // the scope ceiling (director's decision) and, since agentsafety's B3
    // finding, a bound `planHash` + `confirm` for a stop. B1: this
    // handler calls `checkWriteGuard` ITSELF, as its own first lines — see
    // this file's `onRequest` hook's own header for why that is load-
    // bearing (guard-by-construction), not merely redundant with it.
    .post("/api/rules/:id/enabled", async ({ params, body, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.rulesWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const id = decodeURIComponent(params.id);
      const limited = checkWriteRateLimit(deps, server?.requestIP(request) ?? undefined, { route: "POST /api/rules/:id/enabled", action: "enabled", ids: [id], origin: request.headers.get("origin") });
      if (limited) { set.status = limited.status; set.headers["retry-after"] = String(limited.retryAfterSeconds); return limited.body; }
      const bad = bodyProblem(body);
      if (bad) { set.status = bad.status; return { error: bad.error }; }
      const b = body as Record<string, unknown>;
      if (typeof b.enabled !== "boolean" || typeof b.ifMatch !== "string" || typeof b.planHash !== "string") {
        set.status = 400;
        return { error: "body must be { enabled: boolean, ifMatch: string, planHash: string, confirm?: boolean }" };
      }
      const confirm = b.confirm === true;
      const outcome = await deps.rulesWrite.enabled(id, b.enabled, b.ifMatch, confirm, b.planHash);
      auditOutcome(deps, { route: "POST /api/rules/:id/enabled", action: `enabled=${b.enabled}`, ids: [id], origin: request.headers.get("origin") }, outcome);
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error }; }
      return outcome;
    })
    // FACTORY-662 item 7: `PUT /api/rules/:id` — the nested allowlist edit
    // (`query`, `agentPreferences[i].model/effort/modelPower/effortPower`),
    // bound to a `planHash` + `confirm` for a restart (B3). B1: own
    // `checkWriteGuard` call, see the enable route's own comment above.
    .put("/api/rules/:id", async ({ params, body, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.rulesWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const id = decodeURIComponent(params.id);
      const limited = checkWriteRateLimit(deps, server?.requestIP(request) ?? undefined, { route: "PUT /api/rules/:id", action: "edit", ids: [id], origin: request.headers.get("origin") });
      if (limited) { set.status = limited.status; set.headers["retry-after"] = String(limited.retryAfterSeconds); return limited.body; }
      const bad = bodyProblem(body);
      if (bad) { set.status = bad.status; return { error: bad.error }; }
      const b = body as Record<string, unknown>;
      if (typeof b.ifMatch !== "string" || typeof b.planHash !== "string") { set.status = 400; return { error: "body must include ifMatch: string and planHash: string" }; }
      // Same refusal `writeRuleFields` itself enforces (defense in depth,
      // checked again at the HTTP boundary): the dedicated enable route
      // owns `enabled` — a PUT that also permitted it would silently
      // bypass that route's scope-ceiling/placeholder gates.
      if ("enabled" in b) {
        auditOutcome(deps, { route: "PUT /api/rules/:id", action: "edit", ids: [id], origin: request.headers.get("origin") }, { ok: false, error: `PUT /api/rules/:id does not accept "enabled" — use POST /api/rules/:id/enabled` });
        set.status = 400;
        return { error: `PUT /api/rules/:id does not accept "enabled" — use POST /api/rules/:id/enabled` };
      }
      const parsed = validateRuleFieldPatch(body);
      if (!parsed.ok) {
        auditOutcome(deps, { route: "PUT /api/rules/:id", action: "edit", ids: [id], origin: request.headers.get("origin") }, { ok: false, error: parsed.error });
        set.status = 400;
        return { error: parsed.error };
      }
      const confirm = b.confirm === true;
      // Read BEFORE the write (which reloads the live holder in place on
      // success, `rulesWriteDeps.reload`, `../daemon/index.ts`) — the diff
      // summary's "old" side must be the PRE-write value, never the
      // just-written one a read taken after would see.
      const ruleBeforeWrite = deps.getRules?.()?.find((r) => r.id === id);
      const outcome = await deps.rulesWrite.fields(id, parsed.patch, b.ifMatch, confirm, b.planHash);
      auditOutcome(deps, { route: "PUT /api/rules/:id", action: buildFieldDiffSummary(ruleBeforeWrite, parsed.patch), ids: [id], origin: request.headers.get("origin") }, outcome);
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error }; }
      return outcome;
    })
    // FACTORY-731: `DELETE /api/rules/:id` — see `../rules/rules-write.ts`'s
    // `writeRuleDelete` for the full gate list. B1: own `checkWriteGuard`
    // call, same discipline as every other write route in this file (see
    // the enable route's own comment above for why this is load-bearing,
    // not merely redundant with `onRequest`'s own prefix gate).
    .delete("/api/rules/:id", async ({ params, body, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.rulesWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const id = decodeURIComponent(params.id);
      const limited = checkWriteRateLimit(deps, server?.requestIP(request) ?? undefined, { route: "DELETE /api/rules/:id", action: "delete", ids: [id], origin: request.headers.get("origin") });
      if (limited) { set.status = limited.status; set.headers["retry-after"] = String(limited.retryAfterSeconds); return limited.body; }
      const bad = bodyProblem(body);
      if (bad) { set.status = bad.status; return { error: bad.error }; }
      const b = body as Record<string, unknown>;
      if (typeof b.ifMatch !== "string") { set.status = 400; return { error: "body must include ifMatch: string" }; }
      const confirm = b.confirm === true;
      const outcome = deps.rulesWrite.delete(id, b.ifMatch, confirm);
      auditOutcome(deps, { route: "DELETE /api/rules/:id", action: "delete", ids: [id], origin: request.headers.get("origin") }, outcome);
      if (!outcome.ok) {
        set.status = outcome.status;
        return { error: outcome.error, ...(outcome.confirmReason ? { confirmReason: outcome.confirmReason } : {}) };
      }
      return outcome;
    })
    // FACTORY-662 item 5 (DECISION ADDED): `POST /api/rules/plan` —
    // REPORT-ONLY, never writes. Same body shape as the write routes
    // (minus `ifMatch`, which a dry-run has no use for) plus `confirm`. B1:
    // own `checkWriteGuard` call — this route never writes, but it still
    // only hands out a `planHash` to a caller who already proved every
    // guard, same as any other write-shaped route.
    .post("/api/rules/plan", async ({ body, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.rulesWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      // N2 decision: `POST /api/rules/plan` shares the SAME per-client
      // budget as the other three write-shaped routes (one limiter
      // instance, see `ViewDeps.writeRateLimit`'s own doc comment) — a
      // report-only plan still does a real Jira dry-run and is cheap to
      // flood on its own, and N1 needs a plan-then-apply pair (2 calls) to
      // never trip this limit, which the default budget (10/min) leaves
      // ample room for.
      const limited = checkWriteRateLimit(deps, server?.requestIP(request) ?? undefined, { route: "POST /api/rules/plan", action: "plan", ids: [], origin: request.headers.get("origin") });
      if (limited) { set.status = limited.status; set.headers["retry-after"] = String(limited.retryAfterSeconds); return limited.body; }
      const bad = bodyProblem(body);
      if (bad) { set.status = bad.status; return { error: bad.error }; }
      const b = body as Record<string, unknown>;
      if (typeof b.id !== "string" || b.id.length === 0) { set.status = 400; return { error: "body must include id: string" }; }
      const patchSource = typeof b.patch === "object" && b.patch !== null ? b.patch : {};
      const parsed = validateRuleFieldPatch(patchSource);
      if (!parsed.ok) { set.status = 400; return { error: parsed.error }; }
      const confirm = b.confirm === true;
      const outcome = await deps.rulesWrite.plan(b.id, parsed.patch, confirm);
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error }; }
      set.headers["cache-control"] = "no-store";
      return outcome;
    })
    // FACTORY-662 item 5: `POST /api/undo/:backupId` — restores a previous
    // backup through the same guard and the same validated/atomic write
    // path every other write uses (`restoreBackup`, FACTORY-658), scoped
    // (B2) to the SAME process's own most recent UI write's own backup, at
    // its own resulting etag — see `rules-write.ts`'s own header. B1: own
    // `checkWriteGuard` call, see the enable route's own comment above.
    .post("/api/undo/:backupId", async ({ params, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.rulesWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const backupId = decodeURIComponent(params.backupId);
      const limited = checkWriteRateLimit(deps, server?.requestIP(request) ?? undefined, { route: "POST /api/undo/:backupId", action: "undo", ids: [backupId], origin: request.headers.get("origin") });
      if (limited) { set.status = limited.status; set.headers["retry-after"] = String(limited.retryAfterSeconds); return limited.body; }
      const outcome = deps.rulesWrite.undo(backupId);
      auditOutcome(deps, { route: "POST /api/undo/:backupId", action: "undo", ids: [backupId], origin: request.headers.get("origin") }, outcome);
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error }; }
      return outcome;
    })
    // FACTORY-665 — `PUT /api/settings/:key`: the ONE route that may change
    // an allowlisted settings.json value. Full write guard chain (own
    // `checkWriteGuard` call, same discipline as every other write route in
    // this file) + the generic write-flood limiter (shared with the rules
    // write routes — this is the same "local operator, same budget"
    // trust model). `confirm` is the escape hatch for a ceiling/floor
    // crossing (e.g. raising BUTCHR_MAX_AGENTS past its confirm ceiling —
    // see `../settings/settings-file.ts`'s `MAX_AGENTS_CEILING`); every
    // other refusal (malformed value, non-allowlisted key, lock
    // contention) is a plain 400, never offering a confirm bypass that
    // can't fix it.
    .put("/api/settings/:key", async ({ params, body, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.settingsWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const key = decodeURIComponent(params.key);
      const limited = checkWriteRateLimit(deps, server?.requestIP(request) ?? undefined, { route: "PUT /api/settings/:key", action: "edit", ids: [key], origin: request.headers.get("origin") });
      if (limited) { set.status = limited.status; set.headers["retry-after"] = String(limited.retryAfterSeconds); return limited.body; }
      const bad = bodyProblem(body);
      if (bad) { set.status = bad.status; return { error: bad.error }; }
      const b = body as Record<string, unknown>;
      if (typeof b.value !== "string") {
        set.status = 400;
        return { error: "body must be { value: string, confirm?: boolean }" };
      }
      const confirm = b.confirm === true;
      try {
        const response = await deps.settingsWrite(key, b.value, confirm);
        auditOutcome(deps, { route: "PUT /api/settings/:key", action: `set ${key}`, ids: [key], origin: request.headers.get("origin") }, { ok: true });
        set.headers["cache-control"] = "no-store";
        return response;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        auditOutcome(deps, { route: "PUT /api/settings/:key", action: `set ${key}`, ids: [key], origin: request.headers.get("origin") }, { ok: false, error });
        set.status = e instanceof SettingProvidedByEnvironmentError ? 409 : 400;
        return { error };
      }
    })
    // FACTORY-665 — `POST /api/daemon/restart`: full write guard chain +
    // explicit `confirm: true` body field + its OWN rate limit (1 per 10
    // minutes — a global budget, not per-client, since one restart already
    // affects every client). Expect the connection to drop; the dashboard's
    // own retry/reconnect loop is a client-side concern, not this route's.
    .post("/api/daemon/restart", async ({ body, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) {
        auditOutcome(deps, { route: "POST /api/daemon/restart", action: "restart", ids: [], origin: request.headers.get("origin") }, { ok: false, error: guard.reason });
        set.status = guard.status;
        return guard.body;
      }
      if (!deps.daemonRestart) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const bad = bodyProblem(body);
      if (bad) { set.status = bad.status; return { error: bad.error }; }
      const b = body as Record<string, unknown>;
      if (b.confirm !== true) {
        const error = "restart requires confirm: true";
        auditOutcome(deps, { route: "POST /api/daemon/restart", action: "restart", ids: [], origin: request.headers.get("origin") }, { ok: false, error });
        set.status = 400;
        return { error };
      }
      if (deps.daemonRestartRateLimit) {
        const result = deps.daemonRestartRateLimit();
        if (!result.ok) {
          const error = `rate limited: at most one restart per 10 minutes — retry after ${result.retryAfterSeconds}s`;
          auditOutcome(deps, { route: "POST /api/daemon/restart", action: "restart", ids: [], origin: request.headers.get("origin") }, { ok: false, error });
          set.status = 429;
          set.headers["retry-after"] = String(result.retryAfterSeconds);
          return { error };
        }
      }
      const outcome = await deps.daemonRestart();
      auditOutcome(deps, { route: "POST /api/daemon/restart", action: "restart", ids: [], origin: request.headers.get("origin") }, outcome.ok ? { ok: true } : { ok: false, error: outcome.error });
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error }; }
      return outcome;
    })
    .get("/agents", () => mcp.connections.list().map((c) => ({ id: c.id, issue: c.headers["x-issue"] ?? null, connectedAt: c.connectedAt })))
    .post("/agents/:issue/open", async ({ params, set }) => {
      const r = await deps.open(decodeURIComponent(params.issue));
      if (!r.ok) { set.status = 409; return { ok: false, error: r.error ?? "could not open" }; }
      return { ok: true };
    })
    // FACTORY-666 — `GET /api/agents/:issue`: the agent-control panel's own
    // read, same guard discipline as `GET /api/rules` (dashboard-origin
    // guard + same-UID peer check, `Cache-Control: no-store`) since this
    // reflects live Jira state. `decodeURIComponent` can throw on a
    // malformed `%` escape — same 400, never an uncaught 500, as
    // `GET /api/rules/:id/preview` already handles this.
    .get("/api/agents/:issue", async ({ params, request, server, set }) => {
      if (!deps.dashboardOriginGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = checkDashboardOrigin({ origin: request.headers.get("origin"), host: request.headers.get("host"), secFetchSite: request.headers.get("sec-fetch-site"), method: request.method }, deps.dashboardOriginGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.peerUidCheck) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const client = server?.requestIP(request);
      if (!client || !(await deps.peerUidCheck(client))) { set.status = 403; return { error: "peer uid check failed" }; }
      if (!deps.agentsWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      let issue: string;
      try { issue = decodeURIComponent(params.issue); } catch { set.status = 400; return { error: "malformed issue key" }; }
      set.headers["cache-control"] = "no-store";
      const result = await deps.agentsWrite.snapshot(issue);
      if (!result.ok) { set.status = result.status; return { error: result.error }; }
      const { ok, ...rest } = result;
      return rest;
    })
    // FACTORY-666 — `POST /api/agents/:issue/start`: `start_worker`'s own
    // effect (`../agents/agents-write.ts`'s `doAgentStart`), under the
    // worker's own current boss. Never destructive — no confirm step. B1:
    // own `checkWriteGuard` call, same discipline as every other write
    // route in this file (see the rules-enable route's own comment for why
    // this is load-bearing, not merely redundant with `onRequest`'s own
    // prefix gate).
    .post("/api/agents/:issue/start", async ({ params, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.agentsWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      let issue: string;
      try { issue = decodeURIComponent(params.issue); } catch { set.status = 400; return { error: "malformed issue key" }; }
      const limited = checkWriteRateLimit(deps, server?.requestIP(request) ?? undefined, { route: "POST /api/agents/:issue/start", action: "start", ids: [issue], origin: request.headers.get("origin") });
      if (limited) { set.status = limited.status; set.headers["retry-after"] = String(limited.retryAfterSeconds); return limited.body; }
      const outcome = await deps.agentsWrite.start(issue);
      auditOutcome(deps, { route: "POST /api/agents/:issue/start", action: "start", ids: [issue], origin: request.headers.get("origin") }, outcome);
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error }; }
      return outcome;
    })
    // FACTORY-666 — `POST /api/agents/:issue/stop`. DESTRUCTIVE (AC2): the
    // SAME combined plan-then-confirm pattern `POST /api/rules` (FACTORY-927)
    // uses — `planAgentStop` is called FIRST on every request, and is the
    // one call every attempt makes regardless of `confirm`. THREE OUTCOMES,
    // same discipline as that route's own header comment:
    //   1. The plan itself is a refusal (nothing running for this issue) —
    //      audited as rejected, same as any other write refusal.
    //   2. The plan succeeded but `confirm` was not `true` — the ORDINARY
    //      first step of the two-step flow: returns the plan verbatim (200,
    //      `requiresConfirm: true`, `confirmReason: "agent-stop"`, a
    //      structured `preview` naming the pane about to be closed) —
    //      UNAUDITED, exploration, not an attempted write.
    //   3. The plan succeeded AND `confirm === true` — the real stop
    //      (`Herd.stop`, idempotent): its outcome is ALWAYS audited.
    .post("/api/agents/:issue/stop", async ({ params, body, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.agentsWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      let issue: string;
      try { issue = decodeURIComponent(params.issue); } catch { set.status = 400; return { error: "malformed issue key" }; }
      const limited = checkWriteRateLimit(deps, server?.requestIP(request) ?? undefined, { route: "POST /api/agents/:issue/stop", action: "stop", ids: [issue], origin: request.headers.get("origin") });
      if (limited) { set.status = limited.status; set.headers["retry-after"] = String(limited.retryAfterSeconds); return limited.body; }
      const bad = bodyProblem(body);
      if (bad) {
        auditOutcome(deps, { route: "POST /api/agents/:issue/stop", action: "stop", ids: [issue], origin: request.headers.get("origin") }, { ok: false, error: bad.error });
        set.status = bad.status;
        return { error: bad.error };
      }
      const parsed = validateStopRequestBody(body);
      if (!parsed.ok) {
        auditOutcome(deps, { route: "POST /api/agents/:issue/stop", action: "stop", ids: [issue], origin: request.headers.get("origin") }, { ok: false, error: parsed.error });
        set.status = 400;
        return { error: parsed.error };
      }
      if (!parsed.confirm) {
        const plan = await deps.agentsWrite.planStop(issue);
        if (!plan.ok) {
          auditOutcome(deps, { route: "POST /api/agents/:issue/stop", action: "stop", ids: [issue], origin: request.headers.get("origin") }, { ok: false, error: plan.error });
          set.status = plan.status;
          return { error: plan.error };
        }
        return plan; // outcome 2 — deliberately verbatim, never audited.
      }
      const outcome = await deps.agentsWrite.stop(issue);
      auditOutcome(deps, { route: "POST /api/agents/:issue/stop", action: "stop", ids: [issue], origin: request.headers.get("origin") }, outcome);
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error }; }
      return outcome;
    })
    // FACTORY-666 — `POST /api/agents/:issue/shelve`. DESTRUCTIVE (AC2),
    // same three-outcome plan-then-confirm shape as `stop` immediately
    // above, PLUS a mandatory, non-empty `reason` (checked by
    // `planAgentShelve`/`doAgentShelve` themselves — see `shelve_worker`'s
    // own refusal) before a `confirmReason` is ever handed out.
    .post("/api/agents/:issue/shelve", async ({ params, body, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.agentsWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      let issue: string;
      try { issue = decodeURIComponent(params.issue); } catch { set.status = 400; return { error: "malformed issue key" }; }
      const limited = checkWriteRateLimit(deps, server?.requestIP(request) ?? undefined, { route: "POST /api/agents/:issue/shelve", action: "shelve", ids: [issue], origin: request.headers.get("origin") });
      if (limited) { set.status = limited.status; set.headers["retry-after"] = String(limited.retryAfterSeconds); return limited.body; }
      const bad = bodyProblem(body);
      if (bad) {
        auditOutcome(deps, { route: "POST /api/agents/:issue/shelve", action: "shelve", ids: [issue], origin: request.headers.get("origin") }, { ok: false, error: bad.error });
        set.status = bad.status;
        return { error: bad.error };
      }
      const parsed = validateShelveRequestBody(body);
      if (!parsed.ok) {
        auditOutcome(deps, { route: "POST /api/agents/:issue/shelve", action: "shelve", ids: [issue], origin: request.headers.get("origin") }, { ok: false, error: parsed.error });
        set.status = 400;
        return { error: parsed.error };
      }
      if (!parsed.confirm) {
        const plan = await deps.agentsWrite.planShelve(issue, parsed.reason);
        if (!plan.ok) {
          auditOutcome(deps, { route: "POST /api/agents/:issue/shelve", action: "shelve", ids: [issue], origin: request.headers.get("origin") }, { ok: false, error: plan.error });
          set.status = plan.status;
          return { error: plan.error };
        }
        return plan; // outcome 2 — deliberately verbatim, never audited.
      }
      const outcome = await deps.agentsWrite.shelve(issue, parsed.reason);
      auditOutcome(deps, { route: "POST /api/agents/:issue/shelve", action: "shelve", ids: [issue], origin: request.headers.get("origin") }, outcome);
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error }; }
      return outcome;
    })
    // FACTORY-666 — `POST /api/agents/:issue/adopt`: `adopt_worker`'s own
    // effect, with the operator-supplied `bossKey` (the one action with no
    // current boss to derive). Not flagged destructive in this ticket's
    // scope — no confirm step — but a "shelve" disposition still requires
    // a non-empty `reason`, checked by `doAgentAdopt` itself.
    .post("/api/agents/:issue/adopt", async ({ params, body, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.agentsWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      let issue: string;
      try { issue = decodeURIComponent(params.issue); } catch { set.status = 400; return { error: "malformed issue key" }; }
      const limited = checkWriteRateLimit(deps, server?.requestIP(request) ?? undefined, { route: "POST /api/agents/:issue/adopt", action: "adopt", ids: [issue], origin: request.headers.get("origin") });
      if (limited) { set.status = limited.status; set.headers["retry-after"] = String(limited.retryAfterSeconds); return limited.body; }
      const bad = bodyProblem(body);
      if (bad) {
        auditOutcome(deps, { route: "POST /api/agents/:issue/adopt", action: "adopt", ids: [issue], origin: request.headers.get("origin") }, { ok: false, error: bad.error });
        set.status = bad.status;
        return { error: bad.error };
      }
      const parsed = validateAdoptRequestBody(body);
      if (!parsed.ok) {
        auditOutcome(deps, { route: "POST /api/agents/:issue/adopt", action: "adopt", ids: [issue], origin: request.headers.get("origin") }, { ok: false, error: parsed.error });
        set.status = 400;
        return { error: parsed.error };
      }
      const input: AdoptInput = parsed.input;
      const outcome = await deps.agentsWrite.adopt(issue, input);
      auditOutcome(deps, { route: "POST /api/agents/:issue/adopt", action: `adopt bossKey=${input.bossKey} disposition=${input.disposition}`, ids: [issue], origin: request.headers.get("origin") }, outcome);
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error }; }
      return outcome;
    })
    // FACTORY-666 — `POST /api/agents/:issue/prioritize`: `prioritize_worker`'s
    // own effect, under the worker's own current boss. Not flagged
    // destructive — no confirm step.
    .post("/api/agents/:issue/prioritize", async ({ params, body, set, request, server }) => {
      if (!deps.writeGuard) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      const guard = await checkWriteGuard(buildWriteGuardRequest(request, server), deps.writeGuard);
      if (!guard.ok) { set.status = guard.status; return guard.body; }
      if (!deps.agentsWrite) { set.status = 503; return { error: "endpoint disabled: not configured" }; }
      let issue: string;
      try { issue = decodeURIComponent(params.issue); } catch { set.status = 400; return { error: "malformed issue key" }; }
      const limited = checkWriteRateLimit(deps, server?.requestIP(request) ?? undefined, { route: "POST /api/agents/:issue/prioritize", action: "prioritize", ids: [issue], origin: request.headers.get("origin") });
      if (limited) { set.status = limited.status; set.headers["retry-after"] = String(limited.retryAfterSeconds); return limited.body; }
      const bad = bodyProblem(body);
      if (bad) {
        auditOutcome(deps, { route: "POST /api/agents/:issue/prioritize", action: "prioritize", ids: [issue], origin: request.headers.get("origin") }, { ok: false, error: bad.error });
        set.status = bad.status;
        return { error: bad.error };
      }
      const parsed = validatePrioritizeRequestBody(body);
      if (!parsed.ok) {
        auditOutcome(deps, { route: "POST /api/agents/:issue/prioritize", action: "prioritize", ids: [issue], origin: request.headers.get("origin") }, { ok: false, error: parsed.error });
        set.status = 400;
        return { error: parsed.error };
      }
      const outcome = await deps.agentsWrite.prioritize(issue, parsed.priority);
      auditOutcome(deps, { route: "POST /api/agents/:issue/prioritize", action: `prioritize=${parsed.priority}`, ids: [issue], origin: request.headers.get("origin") }, outcome);
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error }; }
      return outcome;
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
