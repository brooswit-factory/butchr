/**
 * FACTORY-661 (epic FACTORY-659, slice U1) / FACTORY-663 (slice U2, the
 * write path) — the ONE client module the Rules page talks to.
 *
 * FACTORY-663 extends this module's contract to match PR #647 (FACTORY-662,
 * head 4d5b2de at the time this was written — "may shift slightly with the
 * fixes" per the director's own "START NOW" comment): `GET /api/session`
 * (CSRF), `GET /api/rules`'s `sourceEtag`/`fileEtag`/`stale`,
 * `POST /api/rules/plan` (report-only), `POST /api/rules/:id/enabled`,
 * `PUT /api/rules/:id`, `POST /api/undo/:backupId`. None of this is a guess
 * at wire format: every shape below is read off PR #647's own
 * `src/web/view.ts` / `src/rules/rules-write.ts` / `src/rules/
 * rules-write-registry.ts` / `src/web/csrf.ts` in the read-only reference
 * worktree this ticket names, never invented. Writes only ever reach
 * `ui-`-prefixed rule ids (`UI_EDITABLE_ID_PREFIX`) — in practice the one
 * seeded template, `FIRST_RULE_ID` (FACTORY-669) — never a generic
 * create-a-rule capability, which this slice deliberately does not build.
 *
 * READ-SIDE SHAPE IS DELIBERATELY KEPT STABLE: the real `GET /api/rules`
 * response (`RulesApiResponse` on the server) carries `path`/`valid`/
 * `problems`/`whyUnstaffed` — this module's own `RulesListResponse`/`RuleDto`
 * keep FACTORY-661's original `errors`/`reason` field names (every existing
 * view-model/component/test built against those untouched) and
 * `realRulesApi.listRules` maps one shape onto the other at the edge
 * (`mapServerRulesResponse` below) — the ONLY place that translation
 * happens. `sourceEtag`/`fileEtag`/`stale` are NEW fields this ticket adds
 * to the client shape (the write flow's whole reason for being); nothing
 * else about the read contract changes.
 *
 * TWO IMPLEMENTATIONS, same `RulesApi` interface:
 *   - `fixturesRulesApi` (built by `createFixturesRulesApi`): in-memory,
 *     simulates latency and lets a caller force failures — `capabilities.write
 *     === true` by default, so the Rules page's whole flow (toggle, preview,
 *     plan, edit, enable, undo) is actually exercisable against it (dev
 *     server, component tests) with no real daemon, per this ticket's own
 *     isolation rule (never a daemon against the shared herdr in tests).
 *   - `realRulesApi`: hits the real endpoints named above. `capabilities.write`
 *     starts `false` and is flipped only by a caller-driven `refreshCapabilities()`
 *     call that succeeds against a real `GET /api/session` — so the Rules
 *     page still renders (reads work, writes stay disabled) against
 *     TODAY'S main, where none of PR #647 has merged yet and `/api/session`
 *     404s. This is deliberate, not a bug: this slice must ship green
 *     without depending on #647 merging first.
 *
 * `rulesApi` picks between them on Vite's own dev/build distinction
 * (`import.meta.env.DEV`) — true under `vite dev`, false in a production
 * `vite build`, and simply absent (so `=== true` is false) under `bun test`,
 * which is why every test in this repo imports `fixturesRulesApi`/
 * `realRulesApi`/`createFixturesRulesApi` BY NAME instead of this
 * flag-selected default: a test must never depend on which bundler ran it.
 */
import type { AccountPolicy, AgentEffort, AgentHarness, AgentRole, ExecutionMode, ResourceProvider } from "../../../src/rules/rules.js";

/** The reserved id prefix FACTORY-669 seeds its one template rule under — see `src/rules/rules-write-registry.ts`'s own `UI_EDITABLE_ID_PREFIX` (PR #647). Only a rule whose id starts with this may ever be written by this module. */
export const UI_EDITABLE_ID_PREFIX = "ui-";

/** The one seeded template id this whole write slice ever targets (FACTORY-669). This module builds no "create a new rule" capability — see this file's own top comment. */
export const FIRST_RULE_ID = "ui-first-rule";

/** The exact placeholder string FACTORY-669 seeds `ui-first-rule.query` with — `src/rules/rules-write-registry.ts`'s own `PLACEHOLDER_QUERY` (PR #647). The server refuses to enable a rule whose query still equals this; this constant lets the UI recognize that state without guessing. */
export const PLACEHOLDER_QUERY = "PLACEHOLDER_QUERY";

/** Mirrors `src/rules/rules-write-registry.ts`'s own `ENABLE_SCOPE_CEILING` (PR #647) for DISPLAY purposes only (e.g. "above the 25-ticket limit") — the SERVER is the authority on whether a write actually requires `confirm`; this module never enforces the ceiling itself, only echoes the server's own refusal message verbatim when it refuses one. */
export const ENABLE_SCOPE_CEILING = 25;

export function isUiEditableRuleId(id: string): boolean {
  return id.startsWith(UI_EDITABLE_ID_PREFIX);
}

export interface RuleAgentPreferenceDto {
  harness: AgentHarness;
  model?: string;
  effort?: AgentEffort;
}

export interface RuleDto {
  id: string;
  resourceProvider: ResourceProvider;
  query: string;
  enabled: boolean;
  /** Display-only in this slice — the count control is `execution`, not a `maxAgents` field (spec change, agentsafety review 2026-10-05: there is no `title`/`maxAgents` field). See `../../../src/rules/rules.js`'s own `ExecutionMode` doc comment for what each value means. */
  execution: ExecutionMode;
  account: AccountPolicy;
  role: AgentRole;
  /** `[]` when the rule sets no preference (uses butchr's global agent config) — same as `RuleInventoryEntry.agentPreferences`. */
  agentPreferences: RuleAgentPreferenceDto[];
  /**
   * Tri-state, reused verbatim from `RuleInventoryEntry.staffed`
   * (`../../../src/agents/query-agent-inventory.ts`): `true` staffed,
   * `false` genuinely not staffed (`reason` says why), `null` COULD NOT
   * CHECK (the agent census itself is unavailable this poll). Every reader
   * in this module compares with `=== true` / `=== false` / `=== null` —
   * never a truthiness test, which would silently collapse `null` into
   * "not staffed" (see `rules-view.ts`'s `renderStaffed`).
   */
  staffed: boolean | null;
  /** Why not staffed, or why that could not be determined; `null` iff `staffed === true`. Server-side this is named `whyUnstaffed` (`RulesApiRuleEntry`) — renamed here only, at the `mapServerRulesResponse` edge, to keep every pre-existing reader of this field unchanged. */
  reason: string | null;
}

export interface RulesFileError {
  path: string;
  message: string;
}

export interface RulesListResponse {
  rules: RuleDto[];
  /** Every rules-file load/parse error — same shape as `QueryAgentInventory.errors`. Non-empty means the validation-problems banner renders, independent of whether `rules` is also empty. */
  errors: RulesFileError[];
  /**
   * FACTORY-663: sha256 of the text this process's currently-LOADED rules
   * came from (`RulesApiResponse.sourceEtag`, PR #647) — the ONLY value any
   * write's `ifMatch` body field may ever carry (never `fileEtag`, even
   * when the two differ — see `stale` below).
   */
  sourceEtag: string;
  /** FACTORY-663: sha256 of the file's CURRENT on-disk bytes, read fresh this request (`RulesApiResponse.fileEtag`). Shown for diagnostics only; never sent as `ifMatch`. */
  fileEtag: string;
  /** FACTORY-663: `sourceEtag !== fileEtag` — the file changed on disk since this process last loaded it. The Rules page shows "reload pending" and disables every write control while this is true (ticket item 5); it is never computed client-side, only read off this field. */
  stale: boolean;
}

export interface RulePreviewTicket {
  /** The ticket/resource key only (b) — agentsafety review 2026-10-05: no summary field. */
  key: string;
}

export interface RulePreviewResponse {
  ruleId: string;
  total: number;
  tickets: RulePreviewTicket[];
}

/** The only shape a PUT body's `agentPreferences` element may take, per `src/rules/rules-write-registry.ts`'s own `AgentPreferencePatch` (PR #647) — never `harness`, never the whole element. */
export interface RuleAgentPreferencePatch {
  model?: string;
  effort?: AgentEffort;
  modelPower?: number;
  effortPower?: number;
}

/** `PUT /api/rules/:id`'s own editable allowlist — `query` and/or `agentPreferences[i].model/effort/modelPower/effortPower` ONLY. No `title`/`maxAgents`/`brief`/`mcpServers`/`account`/`role`/`relationships`/`linked*`/`harness`/`mcpConfigFile`/`permissionMode`/`lizardMode`/`resourceProvider`/`id` field exists here — those stay file-only, per this ticket's own scope discipline. */
export interface RuleFieldPatch {
  query?: string;
  agentPreferences?: RuleAgentPreferencePatch[];
}

/** `POST /api/rules/plan`'s own patch shape — the SAME `RuleFieldPatch` plus the one extra field only the dedicated enable route (and this report-only plan) ever considers. */
export interface RulePlanPatch extends RuleFieldPatch {
  enabled?: boolean;
}

/**
 * `POST /api/rules/plan`'s response, named on the ticket:
 * `{planHash, spawned, stopped, restarted, etag, scopeCount?}`.
 * Report-only — computing one never changes anything. `scopeCount` is
 * present only for a patch that would newly enable the rule (a dry-run Jira
 * ticket count); PR #647's own in-flight implementation at the time this was
 * written names this field `scope`, not `scopeCount` — `planRule` below
 * reads either key defensively (see its own comment) so a late rename on
 * that PR doesn't break this slice either way.
 */
export interface RulePlanResponse {
  planHash: string;
  spawned: number;
  stopped: number;
  restarted: number;
  etag: string;
  scopeCount?: number;
}

/** The success shape every real write route (`enabled`, `PUT`, `undo`) returns — `RulesWriteOutcome`'s `ok: true` branch, PR #647's `src/rules/rules-write.ts`, minus the `reload` field (an internal daemon detail this UI has no use for). */
export interface RuleWriteResult {
  backupId: string | null;
  etag: string;
  changedIds: string[];
}

export interface RulesApiCapabilities {
  /**
   * `fixturesRulesApi` defaults this `true`. `realRulesApi` starts `false`
   * and is flipped only by a successful `refreshCapabilities()` call (a real
   * `GET /api/session`) — so this module never guesses whether PR #647 has
   * merged; it only ever reports what it has actually observed. The Rules
   * page reads this to render every write control disabled, with a "needs
   * the write API" tooltip, whenever it's `false`.
   */
  write: boolean;
}

export interface RulesApi {
  readonly capabilities: RulesApiCapabilities;
  listRules(signal?: AbortSignal): Promise<RulesListResponse>;
  previewRule(ruleId: string, signal?: AbortSignal): Promise<RulePreviewResponse>;
  /** Report-only: never applies anything. */
  planRule(ruleId: string, patch: RulePlanPatch, confirm: boolean, signal?: AbortSignal): Promise<RulePlanResponse>;
  /** `POST /api/rules/:id/enabled` — the ONLY call that may flip `enabled`. `ifMatch` must be the rule list's own `sourceEtag` (never `fileEtag`); `planHash` must be the SAME plan just returned by `planRule` for this exact patch. */
  setEnabled(ruleId: string, enabled: boolean, ifMatch: string, planHash: string, confirm: boolean, signal?: AbortSignal): Promise<RuleWriteResult>;
  /** `PUT /api/rules/:id` — the nested allowlist edit. Same `ifMatch`/`planHash` discipline as `setEnabled`. */
  updateFields(ruleId: string, patch: RuleFieldPatch, ifMatch: string, planHash: string, confirm: boolean, signal?: AbortSignal): Promise<RuleWriteResult>;
  /** `POST /api/undo/:backupId` — only ever the backup id a write JUST returned; the server scopes this further (this SAME process's most recent UI write only). */
  undo(backupId: string, signal?: AbortSignal): Promise<RuleWriteResult>;
  /**
   * Probes `GET /api/session` and updates `capabilities.write` IN PLACE
   * (mutating the SAME object `capabilities` already points at, never
   * reassigning it) before resolving with it. `realRulesApi`: `true` only on
   * a response that actually succeeds — a 404 (today's main, #647 not
   * merged) or any other failure leaves/sets it `false`, never guessed any
   * other way. `fixturesRulesApi`: resolves the fixture's own configured
   * capability (`FixturesRulesApiOptions.sessionOk`, default `true`) —
   * exists on fixtures too so a test can exercise the Rules page's own
   * "writes disabled until the session check resolves" render path without
   * needing `realRulesApi` at all.
   */
  refreshCapabilities(signal?: AbortSignal): Promise<RulesApiCapabilities>;
}

interface RequestOpts {
  method?: string;
  body?: unknown;
  /** Attach the CSRF header (via `fetchCsrfToken` below) — only ever `true` for a write call. */
  csrf?: boolean;
  signal?: AbortSignal | undefined;
}

/**
 * `GET /api/session` — mints/hands out this process's one CSRF token
 * (`src/web/csrf.ts`, PR #647). Real CSRF resolution goes through this
 * function alone, never a second hand-rolled fetch. Also doubles as
 * `refreshCapabilities`'s own liveness probe: a success here IS "the
 * write-path slice is live", by construction — no separate check exists.
 */
async function fetchCsrfToken(signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/session", signal ? { signal } : {});
  if (!res.ok) throw new Error(`/api/session: HTTP ${res.status}`);
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}

/**
 * The exact header name `GET /api/session`'s token must be echoed back on
 * (`src/web/csrf.ts`'s own `CSRF_HEADER` constant, PR #647) —
 * `"x-butchr-csrf"`, NOT a guessed `x-csrf-token`. Named here, once, so a
 * future rename of that server constant has exactly one client-side call
 * site to update.
 */
const CSRF_HEADER = "x-butchr-csrf";

/**
 * The ONLY place `realRulesApi` attaches headers: `content-type` for a body,
 * and the CSRF header (via `fetchCsrfToken` above) for a `csrf: true` call.
 * Every real method below goes through this instead of calling `fetch`
 * directly. Errors are JSON `{error}` (this ticket's own instruction: "show
 * them verbatim") — read off the body and thrown as the Error's own message
 * whenever the response is JSON and shaped that way; a non-JSON or
 * differently-shaped error body falls back to a generic `HTTP <status>`
 * message, never a thrown parse error.
 */
async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.csrf) headers[CSRF_HEADER] = await fetchCsrfToken(opts.signal);
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    let message = `${path}: HTTP ${res.status}`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
        message = (body as { error: string }).error;
      }
    } catch {
      // Non-JSON (or unparseable) error body — keep the generic HTTP message.
    }
    // FACTORY-678 (landing soon, not yet merged): a server-side write rate
    // limit returns 429 with the SAME `{error}` body shape as every other
    // refusal on these routes (handled, verbatim, above) PLUS a
    // `Retry-After` header — an integer number of seconds, per the HTTP
    // spec. Surface that value structurally (not mashed into the message
    // string) so a caller can actually use it (e.g. "try again in 6s")
    // rather than parse it back out of text. Absent/unparseable header ->
    // `retryAfterSeconds` is `undefined`, same message as today.
    if (res.status === 429) {
      const header = res.headers.get("retry-after");
      const parsed = header !== null ? Number.parseInt(header, 10) : NaN;
      const retryAfterSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
      throw new RateLimitError(message, retryAfterSeconds);
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/**
 * Thrown by `request()` (and, in fixtures, by `createFixturesRulesApi`'s
 * `nextRateLimit` one-shot — see `FixturesRulesApiOptions.nextRateLimit`)
 * for a 429 response, in place of a plain `Error` — FACTORY-678 (landing
 * soon, not yet merged) adds a server-side write rate limit across every
 * write route this module calls. `message` is still the verbatim `{error}`
 * body text (or the generic HTTP fallback), exactly as every other refusal
 * on these routes gets handled — this class is purely additive: every
 * existing `catch`/`instanceof Error`/`.message` read at any call site
 * keeps working unchanged. `retryAfterSeconds` is the parsed `Retry-After`
 * header (an integer number of seconds), or `undefined` when the header was
 * absent or unparseable — a caller (the UI) reads this field directly
 * instead of parsing it back out of the message string.
 */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number | undefined;
  constructor(message: string, retryAfterSeconds: number | undefined) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The server's own `GET /api/rules` response shape (`RulesApiResponse`, `src/web/rules-api.ts`) — kept as a private, server-side-only type; `mapServerRulesResponse` is the one place anything reads it. */
interface ServerRulesApiResponse {
  path: string;
  mtime: string | null;
  sourceEtag: string;
  fileEtag: string;
  stale: boolean;
  valid: boolean;
  problems: string[];
  rules: ServerRuleEntry[];
}
interface ServerRuleEntry {
  id: string;
  resourceProvider: ResourceProvider;
  query: string;
  enabled: boolean;
  execution: ExecutionMode;
  account: AccountPolicy;
  role: AgentRole;
  agentPreferences: RuleAgentPreferenceDto[];
  staffed: boolean | null;
  whyUnstaffed: string | null;
}

/** The ONE place the server's `RulesApiResponse` shape is translated onto this module's own stable `RulesListResponse` — see this file's top comment for why the two deliberately differ. */
function mapServerRulesResponse(data: ServerRulesApiResponse): RulesListResponse {
  return {
    sourceEtag: data.sourceEtag,
    fileEtag: data.fileEtag,
    stale: data.stale,
    rules: data.rules.map((r) => ({
      id: r.id,
      resourceProvider: r.resourceProvider,
      query: r.query,
      enabled: r.enabled,
      execution: r.execution,
      account: r.account,
      role: r.role,
      agentPreferences: r.agentPreferences,
      staffed: r.staffed,
      reason: r.whyUnstaffed,
    })),
    errors: data.valid ? [] : data.problems.map((message) => ({ path: data.path, message })),
  };
}

/**
 * Real endpoints only, every shape read off PR #647's own source, never
 * invented. `capabilities.write` starts `false` (unreachable write controls
 * against today's main, where none of this has merged) and is flipped only
 * by `refreshCapabilities()` — see that method's own doc comment and this
 * file's top comment for why that is deliberate, not a bug.
 */
export const realRulesApi: RulesApi = {
  capabilities: { write: false },
  listRules: async (signal) => mapServerRulesResponse(await request<ServerRulesApiResponse>("/api/rules", { signal })),
  previewRule: (ruleId, signal) => request<RulePreviewResponse>(`/api/rules/${encodeURIComponent(ruleId)}/preview`, { signal }),
  planRule: async (ruleId, patch, confirm, signal) => {
    const raw = await request<RulePlanResponse & { scope?: number | null }>("/api/rules/plan", { method: "POST", body: { id: ruleId, patch, confirm }, signal });
    // `scopeCount` per the ticket's own named contract. The real merged
    // server (PR #647, `src/rules/rules-write.ts`'s `planRuleWrite`) names
    // this field `scope`, typed `number | null` (`null` whenever the patch
    // wouldn't newly enable the rule) — NOT `scopeCount`, and NOT always a
    // `number`. Read either key defensively, but normalize `null`/`0`/
    // absent all the same way: only a POSITIVE number ever becomes
    // `scopeCount` here, so a caller's `!== undefined` check (this file's
    // own `RulePlanResponse.scopeCount` doc comment, and
    // `FirstRuleSetup.tsx`'s `overCeiling`/display logic) never sees a
    // `null` masquerading as "defined".
    const { scope, ...rest } = raw;
    const candidate = rest.scopeCount ?? scope;
    const scopeCount = typeof candidate === "number" ? candidate : undefined;
    return scopeCount === undefined ? rest : { ...rest, scopeCount };
  },
  setEnabled: (ruleId, enabled, ifMatch, planHash, confirm, signal) =>
    request<RuleWriteResult>(`/api/rules/${encodeURIComponent(ruleId)}/enabled`, { method: "POST", body: { enabled, ifMatch, planHash, confirm }, csrf: true, signal }),
  updateFields: (ruleId, patch, ifMatch, planHash, confirm, signal) =>
    request<RuleWriteResult>(`/api/rules/${encodeURIComponent(ruleId)}`, { method: "PUT", body: { ...patch, ifMatch, planHash, confirm }, csrf: true, signal }),
  // `body: {}` is REQUIRED here, not cosmetic: the real merged guard
  // (`src/web/view.ts`'s `onRequest` hook, `./write-guard.ts`'s
  // `checkWriteGuard`) demands `content-type: application/json` on EVERY
  // non-safe method under `/api/`, unconditionally — including this route,
  // which otherwise has no body of its own. `request()` only attaches that
  // header when `opts.body !== undefined`; omitting this would 415 every
  // real undo call. Confirmed against `test/unit/rules-write-route.test.ts`
  // on `main`, which sends the same `content-type` + `body: "{}"` here.
  undo: (backupId, signal) => request<RuleWriteResult>(`/api/undo/${encodeURIComponent(backupId)}`, { method: "POST", body: {}, csrf: true, signal }),
  async refreshCapabilities(signal) {
    try {
      await fetchCsrfToken(signal);
      this.capabilities.write = true;
    } catch {
      this.capabilities.write = false;
    }
    return this.capabilities;
  },
};

export interface FixturesRulesApiOptions {
  /** `rules`/`errors` required (FACTORY-661's original shape); `sourceEtag`/`fileEtag`/`stale` default to a fixed fixture etag / `false` when omitted, so every pre-FACTORY-663 test literal keeps compiling and behaving unchanged. */
  initial?: Pick<RulesListResponse, "rules" | "errors"> & Partial<Pick<RulesListResponse, "sourceEtag" | "fileEtag" | "stale">>;
  /** Simulated network latency per call, ms. Defaults to 150. Component tests pass 0. */
  latencyMs?: number;
  /** Keyed by rule id; falls back to a trivial empty preview when absent. */
  previews?: Record<string, RulePreviewResponse>;
  /** Keyed by rule id; falls back to a plan computed from the SAME blast-radius logic the real server uses (`computeLocalPlanCounts` below) when absent. */
  plans?: Record<string, RulePlanResponse>;
  /** When set, every call rejects with this message — simulates a fixtures-mode backend error. */
  failWith?: string;
  /** `refreshCapabilities()`'s own answer — defaults `true`. Set `false` to rehearse the Rules page's "session check failed, writes stay disabled" render path without touching `realRulesApi`. */
  sessionOk?: boolean;
  /**
   * One-shot refusal consumed by the very next `setEnabled`/`updateFields`/
   * `undo` call, then cleared — simulates a write-time-only failure (e.g.
   * PR #647's own "stale file / stale lock" 409, naming the file to remove)
   * that a plan/preview call must NOT see. The exact string is echoed
   * verbatim as the thrown error's message, same as `request()` does for a
   * real `{error}` body.
   */
  nextWriteError?: string;
  /**
   * One-shot FACTORY-678 rate-limit simulation, consumed by the very next
   * `setEnabled`/`updateFields`/`undo` call, then cleared — same one-shot
   * discipline as `nextWriteError` (a plan/preview call must NOT see it
   * either). Throws a `RateLimitError` (never a plain `Error`) so a caller
   * can exercise the "too many changes" UI path without a real daemon.
   * `retryAfterSeconds` omitted simulates a 429 with no `Retry-After`
   * header at all — the fallback path a caller must also be able to prove.
   */
  nextRateLimit?: { retryAfterSeconds?: number };
}

const DEFAULT_FIXTURE_ETAG = "fixture-etag-0";

/** Mirrors `src/rules/rules-write.ts`'s own `computeLocalPlanCounts` (PR #647) — the SAME blast-radius decision, so a fixture's default plan/refusal behavior matches what the real server would actually do for the same patch. */
function computeLocalPlanCounts(wasEnabled: boolean, patch: RulePlanPatch): { spawned: number; stopped: number; restarted: number } {
  if (patch.enabled !== undefined && patch.enabled !== wasEnabled) {
    return patch.enabled ? { spawned: 1, stopped: 0, restarted: 0 } : { spawned: 0, stopped: 1, restarted: 0 };
  }
  const otherFieldsChanged = patch.query !== undefined || patch.agentPreferences !== undefined;
  return { spawned: 0, stopped: 0, restarted: wasEnabled && otherFieldsChanged ? 1 : 0 };
}

/**
 * Demo dataset for `bun run dev:web` — every tri-state `staffed` value, a
 * disabled rule, more than one `resourceProvider`, and the seeded
 * `ui-first-rule` template (still carrying its placeholder query, so the
 * dev server shows the exact "set up your first rule" state a fresh install
 * would), so the Rules page has something real to render without a live
 * daemon.
 */
export function defaultRulesFixture(): RulesListResponse {
  return {
    sourceEtag: DEFAULT_FIXTURE_ETAG,
    fileEtag: DEFAULT_FIXTURE_ETAG,
    stale: false,
    rules: [
      {
        id: "factory-triage",
        resourceProvider: "jira-work",
        query: 'project = FACTORY AND status = "To Do"',
        enabled: true,
        execution: "swarm",
        account: "none",
        role: "worker",
        agentPreferences: [{ harness: "claude", model: "claude-opus-5" }],
        staffed: true,
        reason: null,
      },
      {
        id: "stale-github-prs",
        resourceProvider: "github-pr",
        query: "is:open label:needs-triage",
        enabled: false,
        execution: "swarm",
        account: "none",
        role: "worker",
        agentPreferences: [],
        staffed: false,
        reason: "disabled",
      },
      {
        id: "vip-zendesk",
        resourceProvider: "zendesk-ticket",
        query: "tags:vip status<solved",
        enabled: true,
        execution: "singleton",
        account: "none",
        role: "worker",
        agentPreferences: [{ harness: "claude", effort: "high" }],
        staffed: null,
        reason: "census unavailable: most recent agent-list poll failed",
      },
      {
        id: FIRST_RULE_ID,
        resourceProvider: "jira-work",
        query: PLACEHOLDER_QUERY,
        enabled: false,
        execution: "swarm",
        account: "none",
        role: "worker",
        agentPreferences: [],
        staffed: false,
        reason: "disabled: not yet configured (query is still the placeholder)",
      },
    ],
    errors: [],
  };
}

/**
 * Builds a fresh, independent in-memory `RulesApi` — a factory, not a
 * singleton, so each test/dev-server instance owns its own mutable state
 * (every write below mutates `state`, never the input `initial` object in
 * place). Replays the SAME refusal wording the real server would (etag
 * mismatch, non-`ui-` id, placeholder query, over-ceiling, stop/restart
 * without confirm, undo scoping) so a component test asserting on an error
 * message is asserting on real server text, not an invented fixture-only
 * string.
 */
export function createFixturesRulesApi(opts: FixturesRulesApiOptions = {}): RulesApi {
  const latencyMs = opts.latencyMs ?? 150;
  let state: RulesListResponse = opts.initial
    ? {
        rules: opts.initial.rules,
        errors: opts.initial.errors,
        sourceEtag: opts.initial.sourceEtag ?? DEFAULT_FIXTURE_ETAG,
        fileEtag: opts.initial.fileEtag ?? opts.initial.sourceEtag ?? DEFAULT_FIXTURE_ETAG,
        stale: opts.initial.stale ?? false,
      }
    : defaultRulesFixture();
  let lastUiWrite: { backupId: string; resultingEtag: string } | null = null;
  let nextWriteError = opts.nextWriteError;
  let nextRateLimit = opts.nextRateLimit;
  let backupCounter = 0;
  const backups = new Map<string, RulesListResponse>();

  const delay = () => (latencyMs > 0 ? new Promise<void>((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve());
  const maybeFail = () => {
    if (opts.failWith) throw new Error(opts.failWith);
  };
  const maybeFailWriteOnce = () => {
    if (nextRateLimit !== undefined) {
      const { retryAfterSeconds } = nextRateLimit;
      nextRateLimit = undefined;
      const message = retryAfterSeconds !== undefined ? `too many changes — retry after ${retryAfterSeconds}s` : "too many changes — rate limited, retry shortly";
      throw new RateLimitError(message, retryAfterSeconds);
    }
    if (nextWriteError !== undefined) {
      const message = nextWriteError;
      nextWriteError = undefined;
      throw new Error(message);
    }
  };
  const findRule = (id: string): RuleDto => {
    const rule = state.rules.find((r) => r.id === id);
    if (!rule) throw new Error(`unknown rule "${id}"`);
    return rule;
  };
  const checkIfMatch = (ifMatch: string) => {
    if (ifMatch !== state.sourceEtag) {
      throw new Error(`etag mismatch — expected ${ifMatch}, the rules file is currently at ${state.sourceEtag}; reload and retry`);
    }
  };
  const assertUiEditable = (id: string) => {
    if (!isUiEditableRuleId(id)) {
      throw new Error(`rule "${id}" does not carry the "ui-" prefix — only web-UI-marked rules may be written by this route`);
    }
  };
  const requireConfirmForBlastRadius = (counts: { spawned: number; stopped: number; restarted: number }, confirm: boolean) => {
    if ((counts.stopped > 0 || counts.restarted > 0) && !confirm) {
      throw new Error(`this change would stop ${counts.stopped} and restart ${counts.restarted} running agent(s) — retry with confirm: true to proceed`);
    }
  };
  const commitWrite = (nextRules: RuleDto[], changedIds: string[]): RuleWriteResult => {
    const n = ++backupCounter;
    const backupId = `fixture-backup-${n}`;
    backups.set(backupId, state);
    const etag = `fixture-etag-${n}`;
    state = { ...state, rules: nextRules, sourceEtag: etag, fileEtag: etag, stale: false };
    lastUiWrite = { backupId, resultingEtag: etag };
    return { backupId, etag, changedIds };
  };

  return {
    capabilities: { write: true },
    async listRules() {
      await delay();
      maybeFail();
      return state;
    },
    async previewRule(ruleId) {
      await delay();
      maybeFail();
      return opts.previews?.[ruleId] ?? { ruleId, total: 0, tickets: [] };
    },
    async planRule(ruleId, patch, confirm) {
      await delay();
      maybeFail();
      if (opts.plans?.[ruleId]) return opts.plans[ruleId]!;
      const rule = findRule(ruleId);
      const counts = computeLocalPlanCounts(rule.enabled, patch);
      const base: RulePlanResponse = {
        planHash: `${ruleId}:${JSON.stringify(patch)}:${confirm}:${state.sourceEtag}`,
        spawned: counts.spawned,
        stopped: counts.stopped,
        restarted: counts.restarted,
        etag: state.sourceEtag,
      };
      return counts.spawned > 0 ? { ...base, scopeCount: opts.previews?.[ruleId]?.total ?? 0 } : base;
    },
    async setEnabled(ruleId, enabled, ifMatch, planHash, confirm) {
      await delay();
      maybeFail();
      maybeFailWriteOnce();
      const rule = findRule(ruleId);
      assertUiEditable(ruleId);
      checkIfMatch(ifMatch);
      if (!planHash) throw new Error("planHash does not match a fresh plan for this write (the file may have changed, or the plan is stale) — call POST /api/rules/plan again");
      if (enabled && rule.query === PLACEHOLDER_QUERY) {
        throw new Error(`rule "${ruleId}" cannot be enabled while its query is still the placeholder — edit the query first`);
      }
      const counts = computeLocalPlanCounts(rule.enabled, { enabled });
      const plan = opts.plans?.[ruleId];
      if (enabled && plan?.scopeCount !== undefined && plan.scopeCount > ENABLE_SCOPE_CEILING && !confirm) {
        throw new Error(`enabling "${ruleId}" would stage ${plan.scopeCount} ticket(s), above the ${ENABLE_SCOPE_CEILING}-ticket confirm ceiling — retry with confirm: true to proceed`);
      }
      requireConfirmForBlastRadius(counts, confirm);
      const updated: RuleDto = { ...rule, enabled };
      return commitWrite(state.rules.map((r) => (r.id === ruleId ? updated : r)), [ruleId]);
    },
    async updateFields(ruleId, patch, ifMatch, planHash, confirm) {
      await delay();
      maybeFail();
      maybeFailWriteOnce();
      const rule = findRule(ruleId);
      assertUiEditable(ruleId);
      checkIfMatch(ifMatch);
      if (!planHash) throw new Error("planHash does not match a fresh plan for this write (the file may have changed, or the plan is stale) — call POST /api/rules/plan again");
      const counts = computeLocalPlanCounts(rule.enabled, patch);
      requireConfirmForBlastRadius(counts, confirm);
      const updated: RuleDto = {
        ...rule,
        query: patch.query ?? rule.query,
        agentPreferences:
          patch.agentPreferences?.map((p, i) => ({ ...(rule.agentPreferences[i] ?? { harness: "claude" as AgentHarness }), ...p })) ?? rule.agentPreferences,
      };
      return commitWrite(state.rules.map((r) => (r.id === ruleId ? updated : r)), [ruleId]);
    },
    async undo(backupId) {
      await delay();
      maybeFail();
      maybeFailWriteOnce();
      if (!lastUiWrite || lastUiWrite.backupId !== backupId) {
        throw new Error(`undo is only permitted for the most recent web-UI write's own backup — "${backupId}" is not it (or no UI write has happened yet this process)`);
      }
      if (state.sourceEtag !== lastUiWrite.resultingEtag) {
        throw new Error(`the rules file has changed since that write (expected etag ${lastUiWrite.resultingEtag}, found ${state.sourceEtag}) — undo refused rather than reverting a change it did not make`);
      }
      const prior = backups.get(backupId);
      if (!prior) throw new Error(`no backup found for "${backupId}"`);
      const n = ++backupCounter;
      const restoredEtag = `fixture-etag-${n}`;
      state = { ...prior, sourceEtag: restoredEtag, fileEtag: restoredEtag };
      lastUiWrite = null;
      return { backupId, etag: restoredEtag, changedIds: [] };
    },
    async refreshCapabilities() {
      await delay();
      this.capabilities.write = opts.sessionOk ?? true;
      return this.capabilities;
    },
  };
}

export const fixturesRulesApi: RulesApi = createFixturesRulesApi();

/**
 * Build/dev flag selecting the implementation (DoD requirement 3): `vite
 * dev` sets `import.meta.env.DEV === true`, a production `vite build`
 * statically replaces it with `false`, and `bun test` sees neither (the
 * object is empty under bun, so `=== true` is false) — which is exactly
 * why every test imports `fixturesRulesApi`/`realRulesApi`/
 * `createFixturesRulesApi` directly instead of this export.
 */
const viteEnv = (import.meta as unknown as { env?: Record<string, unknown> }).env;
export const rulesApi: RulesApi = viteEnv?.["DEV"] === true ? fixturesRulesApi : realRulesApi;
