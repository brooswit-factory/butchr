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
 * worktree this ticket names, never invented. FACTORY-730: writes reach any
 * EXISTING rule id (the route-level `ui-`-prefix gate was retired — the
 * per-write field allowlist is the one remaining gate) — this module still
 * builds no "create a new rule" capability, only edit/enable of a rule
 * already in the file.
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
import type { AccountPolicy, AgentEffort, AgentHarness, AgentRole, ExecutionMode, ResourceProvider, RulePermissionMode } from "../../../src/rules/rules.js";
import { AGENT_ROLES, CAPACITY_ROLE_DEFAULT, RULE_FORM_CATALOG, type RuleFormCatalogEntry } from "../../../src/rules/rule-form-catalog.js";

export type { RuleFormCatalogEntry };

/** FACTORY-817 — `GET /api/rules/catalog`'s own `capacityRoles` field: the "Included in capacity" toggle's allowed values plus the engine's own default, served alongside the per-harness catalog (never hardcoded here — see `../../../src/rules/rule-form-catalog.js`'s own doc comment). */
export interface RuleCapacityRolesCatalog {
  values: readonly AgentRole[];
  default: AgentRole;
}

/** The one seeded template id FACTORY-669's daemon-startup seed writes (`src/rules/seed-first-run.ts`). FACTORY-730: this id carries no special write-eligibility anymore (every existing rule is web-UI-writable) — it is still the one id the "Set up your first rule" flow (`FirstRuleSetup.tsx`) looks for specifically. */
export const FIRST_RULE_ID = "ui-first-rule";

/** The exact placeholder string FACTORY-669 seeds `ui-first-rule.query` with — `src/rules/rules-write-registry.ts`'s own `PLACEHOLDER_QUERY` (PR #647). The server refuses to enable a rule whose query still equals this; this constant lets the UI recognize that state without guessing. */
export const PLACEHOLDER_QUERY = "PLACEHOLDER_QUERY";

/** Mirrors `src/rules/rules-write-registry.ts`'s own `ENABLE_SCOPE_CEILING` (PR #647) for DISPLAY purposes only (e.g. "above the 25-ticket limit") — the SERVER is the authority on whether a write actually requires `confirm`; this module never enforces the ceiling itself, only echoes the server's own refusal message verbatim when it refuses one. */
export const ENABLE_SCOPE_CEILING = 25;

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
  /** FACTORY-729 — `null` when absent (butchr's own launch default applies; see `Rule.permissionMode`'s own doc comment, `../../../src/rules/rules.js`). */
  permissionMode: RulePermissionMode | null;
  /** FACTORY-729 — `null` when absent (the "eligible for scanning" default — see `Rule.lizardMode`'s own doc comment). */
  lizardMode: boolean | null;
  /** FACTORY-851 — `null` when absent; means ON, no tri-state (see `Rule.resumeOnRespawn`'s own doc comment, `../../../src/rules/rules.js`). Display-only in this slice, same as `account`/`role` above. */
  resumeOnRespawn: boolean | null;
  /** FACTORY-851 — `null` when absent; means the daemon's own default cutoff applies (see `Rule.resumeContextCutoff`'s own doc comment). Display-only in this slice, same as `account`/`role` above. */
  resumeContextCutoff: number | null;
  /**
   * FACTORY-846 (epic FACTORY-836, story FACTORY-844): CONFIG SURFACE ONLY
   * for the idle poke. `idlePokeMinutes`/`idlePokeMessage`, like
   * `permissionMode`/`lizardMode` above, are `null` when absent on the raw
   * `Rule` — and `null` here means something specific: this rule's real
   * EFFECTIVE threshold/text is today's global `stalledMinutes`/existing
   * wake text, NOT the epic's own 30-minute/default-text seed
   * (`DEFAULT_IDLE_POKE_MINUTES`/`DEFAULT_IDLE_POKE_MESSAGE`,
   * `../../../src/rules/rules.js`) — review round 1 caught an earlier
   * version of this DTO defaulting to that seed here, which misreported a
   * rule's real threshold as 30 when it was actually inheriting the
   * global 10. `idlePokeEnabled` has no such inherit-ambiguity —
   * `Rule.idlePokeEnabled` is always resolved server-side (see that
   * field's own doc comment) — so it is never `null`, same as it is
   * always a real boolean for a rule that matched. Nothing in the daemon
   * reads any of these three yet.
   */
  idlePokeMinutes: number | null;
  idlePokeMessage: string | null;
  idlePokeEnabled: boolean;
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

/** The only shape a PUT body's `agentPreferences` element may take, per `src/rules/rules-write-registry.ts`'s own `AgentPreferencePatch`. FACTORY-729: `harness` is now included — see that interface's own doc comment for why the original "never harness" restriction was reversed. */
export interface RuleAgentPreferencePatch {
  harness?: AgentHarness;
  model?: string;
  effort?: AgentEffort;
  modelPower?: number;
  effortPower?: number;
}

/**
 * `PUT /api/rules/:id`'s own editable allowlist — `query`, `permissionMode`,
 * `lizardMode`, `role`, and/or `agentPreferences[i].harness/model/effort/
 * modelPower/effortPower` ONLY (FACTORY-729 adds `permissionMode`/
 * `lizardMode`/`agentPreferences[i].harness` to FACTORY-663's original
 * `query`/`agentPreferences[i].model/effort/modelPower/effortPower`;
 * FACTORY-817 adds `role`, previously file-only — see that field's own doc
 * comment). No `title`/`maxAgents`/`brief`/`mcpServers`/`account`/
 * `relationships`/`linked*`/`mcpConfigFile`/`resourceProvider`/`id` field
 * exists here — those stay file-only, per this ticket's own scope
 * discipline.
 */
export interface RuleFieldPatch {
  query?: string;
  /** `"bypassPermissions"`/`"auto"` additionally require `confirm: true` on the write (the server's own `requireConfirmForRiskyFields`) — never a default. */
  permissionMode?: RulePermissionMode;
  /** `true` additionally requires `confirm: true` on the write — never a default. */
  lizardMode?: boolean;
  /**
   * FACTORY-817 — the "Included in capacity" toggle: `"worker"` (ON, the
   * default) counts this rule's agent(s) toward `BUTCHR_MAX_AGENTS`;
   * `"sentinel"` (OFF) opts them out entirely. `"sentinel"` additionally
   * requires `confirm: true` on the write — never a default, same as a
   * risky `permissionMode`/`lizardMode: true`.
   */
  role?: AgentRole;
  agentPreferences?: RuleAgentPreferencePatch[];
  /** FACTORY-846 — CONFIG SURFACE ONLY, never risky: no confirm is required for any of these three. */
  idlePokeMinutes?: number;
  idlePokeMessage?: string;
  idlePokeEnabled?: boolean;
}

/** `POST /api/rules/plan`'s own patch shape — the SAME `RuleFieldPatch` plus the one extra field only the dedicated enable route (and this report-only plan) ever considers. */
export interface RulePlanPatch extends RuleFieldPatch {
  enabled?: boolean;
}

/**
 * FACTORY-927 — `POST /api/rules`'s own body shape (minus `confirm`, which
 * `createRule` below takes as its own separate argument, same discipline as
 * `setEnabled`/`updateFields`). Mirrors the server's own `RuleCreateInput`
 * (`src/rules/rules-write-registry.ts`) field-for-field: `brief`/
 * `execution`/`account`/`enabled` are deliberately absent — there is
 * nothing to send for them, the server hardcodes all four (a created rule
 * is ALWAYS disabled; see that module's own doc comment for why the other
 * three stay file-only in this v1 slice).
 */
export interface RuleCreateDraft {
  id: string;
  resourceProvider: ResourceProvider;
  query: string;
  permissionMode?: RulePermissionMode;
  lizardMode?: boolean;
  role?: AgentRole;
  /** At most one entry — a brand-new rule has no existing slot to grow, so (unlike `RuleFieldPatch.agentPreferences`) this is 0 or 1, never more; `harness` is REQUIRED on this one entry (unlike a PUT patch to an existing rule, there is no prior value to leave unchanged). */
  agentPreferences?: [RuleAgentPreferencePatch & { harness: AgentHarness }] | [];
}

/**
 * `POST /api/rules/plan`'s response, named on the ticket:
 * `{planHash, spawned, stopped, restarted, etag, scopeCount?}`.
 * Report-only — computing one never changes anything. `scopeCount` is
 * present for a patch that would newly enable the rule (a dry-run Jira
 * ticket count against the CURRENT query) OR — FACTORY-730 — a patch that
 * CHANGES `query` (a dry-run against the NEW query text, regardless of the
 * rule's enabled state; `confirmReason: "query-change"` names this case).
 * PR #647's own in-flight implementation at the time this was written names
 * this field `scope`, not `scopeCount` — `planRule` below reads either key
 * defensively (see its own comment) so a late rename on that PR doesn't
 * break this slice either way.
 */
export interface RulePlanResponse {
  planHash: string;
  spawned: number;
  stopped: number;
  restarted: number;
  etag: string;
  scopeCount?: number;
  /**
   * FACTORY-685 (item 2/3): the server's own authoritative verdict on
   * whether this exact patch (with whatever `confirm` the caller already
   * passed) needs an explicit confirm before it would be accepted — folds
   * in EVERY gate the server enforces (the scope ceiling, ANY swarm enable,
   * a stop/restart, an unmeasurable scope), so the UI never re-derives this
   * from `spawned`/`stopped`/`restarted`/`scopeCount` itself and risks
   * missing a gate the server adds later. `src/rules/rules-write.ts`'s own
   * `RulesPlanResult.requiresConfirm` — read verbatim off the real server's
   * response; `fixturesRulesApi` computes the same verdict locally so a
   * component test can exercise this without a real daemon.
   */
  requiresConfirm: boolean;
  /** Mirrors `src/rules/rules-write.ts`'s own `RulesPlanResult.confirmReason` — present iff `requiresConfirm` is `true`. Display-only: which gate is why. */
  /** FACTORY-729 adds `"risky-permission"` — `permissionMode: "bypassPermissions" | "auto"` or `lizardMode: true`, never a default. FACTORY-730 adds `"query-change"` — a CHANGED `query`'s own dry-run scope, regardless of the rule's enabled state. FACTORY-817 adds `"capacity-sentinel"` — `role: "sentinel"`, same discipline. */
  confirmReason?: "unmeasurable-scope" | "scope-ceiling" | "swarm-enable" | "query-change" | "stop-restart" | "risky-permission" | "capacity-sentinel";
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
  /**
   * FACTORY-729 — `GET /api/rules/catalog`: the rule form's own harness/
   * model/effort/permission-mode catalog (one entry per `AgentHarness`),
   * served verbatim from `../../../src/rules/rule-form-catalog.js`'s
   * `RULE_FORM_CATALOG` — never a second, hand-maintained list on this side
   * either. `realRulesApi` fetches it fresh every call (it is cheap, pure
   * constants server-side, and never changes within a daemon's lifetime —
   * a caller that wants to avoid refetching may cache the result itself).
   */
  getCatalog(signal?: AbortSignal): Promise<readonly RuleFormCatalogEntry[]>;
  /**
   * FACTORY-817 — `GET /api/rules/catalog`'s own `capacityRoles` field:
   * the "Included in capacity" toggle's allowed values plus the engine's
   * own default (`"worker"`), served alongside the per-harness catalog
   * above but NOT per-harness itself (`Rule.role` applies uniformly across
   * every harness/provider) — never hardcoded on this side either. See
   * `../../../src/rules/rule-form-catalog.js`'s own doc comment.
   */
  getCapacityRoles(signal?: AbortSignal): Promise<RuleCapacityRolesCatalog>;
  /**
   * FACTORY-730 — `queryOverride`, when given, dry-runs the SAME rule with a
   * DIFFERENT (not-yet-saved) query instead of the rule's own stored one —
   * the edit dialog's own "what would this match" preview for a draft query
   * edit, before that edit is ever applied. `GET /api/rules/:id/preview`'s
   * own `?query=` param (`src/web/rules-preview.ts`), the SAME dry-run
   * mechanism `searchRules`/`searchJiraIdeaRules` already run for the
   * no-override case — never a second preview mechanism.
   */
  previewRule(ruleId: string, signal?: AbortSignal, queryOverride?: string): Promise<RulePreviewResponse>;
  /** Report-only: never applies anything. */
  planRule(ruleId: string, patch: RulePlanPatch, confirm: boolean, signal?: AbortSignal): Promise<RulePlanResponse>;
  /** `POST /api/rules/:id/enabled` — the ONLY call that may flip `enabled`. `ifMatch` must be the rule list's own `sourceEtag` (never `fileEtag`); `planHash` must be the SAME plan just returned by `planRule` for this exact patch. */
  setEnabled(ruleId: string, enabled: boolean, ifMatch: string, planHash: string, confirm: boolean, signal?: AbortSignal): Promise<RuleWriteResult>;
  /** `PUT /api/rules/:id` — the nested allowlist edit. Same `ifMatch`/`planHash` discipline as `setEnabled`. */
  updateFields(ruleId: string, patch: RuleFieldPatch, ifMatch: string, planHash: string, confirm: boolean, signal?: AbortSignal): Promise<RuleWriteResult>;
  /**
   * FACTORY-927 — `POST /api/rules`: create a new rule. No `ifMatch`/
   * `planHash` to pass (unlike `setEnabled`/`updateFields`) — there is no
   * prior read of a not-yet-existing rule to be stale against, and the
   * server computes its own fresh plan hash internally on every call (see
   * that route's own doc comment, `src/web/view.ts`); a caller never tracks
   * one. Call with `confirm: false` first to see the dry-run scope (it
   * comes back as the rejection's own message text, same as every other
   * unconfirmed write on this path — `describeWriteError` below renders it
   * verbatim), then again with `confirm: true` to actually create it.
   */
  createRule(draft: RuleCreateDraft, confirm: boolean, signal?: AbortSignal): Promise<RuleWriteResult>;
  /** `POST /api/undo/:backupId` — only ever the backup id a write JUST returned; the server scopes this further (this SAME process's most recent UI write only). */
  undo(backupId: string, signal?: AbortSignal): Promise<RuleWriteResult>;
  /**
   * FACTORY-731 — `DELETE /api/rules/:id`. `confirm` is ALWAYS required by
   * the server (`writeRuleDelete`'s own unconditional confirm gate) — there
   * is no plan-then-apply step for delete the way `setEnabled`/
   * `updateFields` have (no blast-radius count to preview; the server's
   * refusal, naming the rule's id and query, is itself what a caller shows
   * before resending with `confirm: true`). Refused (independent of
   * `confirm`) while the rule is enabled or has a live agent — see
   * `writeRuleDelete`'s own doc comment.
   */
  deleteRule(ruleId: string, ifMatch: string, confirm: boolean, signal?: AbortSignal): Promise<RuleWriteResult>;
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
  permissionMode: RulePermissionMode | null;
  lizardMode: boolean | null;
  resumeOnRespawn: boolean | null;
  resumeContextCutoff: number | null;
  idlePokeMinutes: number | null;
  idlePokeMessage: string | null;
  idlePokeEnabled: boolean;
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
      permissionMode: r.permissionMode,
      lizardMode: r.lizardMode,
      resumeOnRespawn: r.resumeOnRespawn,
      resumeContextCutoff: r.resumeContextCutoff,
      idlePokeMinutes: r.idlePokeMinutes,
      idlePokeMessage: r.idlePokeMessage,
      idlePokeEnabled: r.idlePokeEnabled,
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
/** Maps the server's `GET /api/rules/:id/preview` body (counts + keys only) to this client's `RulePreviewResponse`. Tolerates the older `tickets: [{key}]` shape too, and refuses an `ok: false` body instead of rendering garbage. */
export function mapServerPreview(ruleId: string, raw: unknown): RulePreviewResponse {
  const r = (raw ?? {}) as { ok?: boolean; error?: string; keys?: unknown; tickets?: unknown; total?: unknown };
  if (r.ok === false) throw new Error(typeof r.error === "string" ? r.error : "preview failed");
  const keys: string[] = Array.isArray(r.keys)
    ? r.keys.filter((k): k is string => typeof k === "string")
    : Array.isArray(r.tickets)
      ? (r.tickets as unknown[]).map((t) => (t && typeof t === "object" ? (t as { key?: unknown }).key : undefined)).filter((k): k is string => typeof k === "string")
      : [];
  return { ruleId, total: typeof r.total === "number" ? r.total : keys.length, tickets: keys.map((key) => ({ key })) };
}

export const realRulesApi: RulesApi = {
  capabilities: { write: false },
  listRules: async (signal) => mapServerRulesResponse(await request<ServerRulesApiResponse>("/api/rules", { signal })),
  getCatalog: async (signal) => (await request<{ harnesses: RuleFormCatalogEntry[] }>("/api/rules/catalog", { signal })).harnesses,
  getCapacityRoles: async (signal) => (await request<{ capacityRoles: RuleCapacityRolesCatalog }>("/api/rules/catalog", { signal })).capacityRoles,
  // FACTORY-686: the REAL server answers `{ok, keys: string[], total, cap, warning}`
  // (src/web/rules-preview.ts), not the `{ruleId, total, tickets: [{key}]}` shape this
  // client's fixtures grew around: reading `tickets` off the real response was
  // `undefined`, and the preview dialog's `.map` crashed the whole React app to a blank
  // page in a real browser. Map at this one edge.
  previewRule: async (ruleId, signal, queryOverride) => {
    const qs = queryOverride !== undefined ? `?query=${encodeURIComponent(queryOverride)}` : "";
    return mapServerPreview(ruleId, await request<unknown>(`/api/rules/${encodeURIComponent(ruleId)}/preview${qs}`, { signal }));
  },
  planRule: async (ruleId, patch, confirm, signal) => {
    // `csrf: true` is REQUIRED here even though this route only ever
    // reports, never writes: the real merged guard (`src/web/view.ts`'s
    // `onRequest` hook) fails closed on PATH SHAPE, not per-route
    // intent — ANY non-safe method under `/api/` (this included) must
    // pass the full `checkWriteGuard`, CSRF included, before its own
    // handler (which itself calls `checkWriteGuard` again) is ever
    // reached. Omitting this would 403 every real plan call.
    const raw = await request<RulePlanResponse & { scope?: number | null }>("/api/rules/plan", { method: "POST", body: { id: ruleId, patch, confirm }, csrf: true, signal });
    // `requiresConfirm`/`confirmReason` are read straight off the server's
    // own response — same field names on both sides (FACTORY-685, item 2's
    // own deliberate deviation: no rename to the ticket's literal
    // `confirmRequired`/`reason`), unlike `scope`/`scopeCount` below, which
    // DOES still need translating.
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
  createRule: (draft, confirm, signal) => request<RuleWriteResult>("/api/rules", { method: "POST", body: { ...draft, confirm }, csrf: true, signal }),
  // `body: {}` is REQUIRED here, not cosmetic: the real merged guard
  // (`src/web/view.ts`'s `onRequest` hook, `./write-guard.ts`'s
  // `checkWriteGuard`) demands `content-type: application/json` on EVERY
  // non-safe method under `/api/`, unconditionally — including this route,
  // which otherwise has no body of its own. `request()` only attaches that
  // header when `opts.body !== undefined`; omitting this would 415 every
  // real undo call. Confirmed against `test/unit/rules-write-route.test.ts`
  // on `main`, which sends the same `content-type` + `body: "{}"` here.
  undo: (backupId, signal) => request<RuleWriteResult>(`/api/undo/${encodeURIComponent(backupId)}`, { method: "POST", body: {}, csrf: true, signal }),
  deleteRule: (ruleId, ifMatch, confirm, signal) =>
    request<RuleWriteResult>(`/api/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE", body: { ifMatch, confirm }, csrf: true, signal }),
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
  /** FACTORY-730 — keyed `${ruleId}:${queryOverride}`: a distinct scope count for a draft (not-yet-saved) query preview, consulted before `previews` whenever `previewRule` is called with a `queryOverride`. */
  previewsByQuery?: Record<string, RulePreviewResponse>;
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
  /** FACTORY-729: override `getCatalog()`'s answer — defaults to the real `RULE_FORM_CATALOG`. Set this only to rehearse a UI against a DIFFERENT catalog shape than the real one ships (e.g. an empty harness list) — not needed for ordinary tests. */
  catalog?: readonly RuleFormCatalogEntry[];
  /** FACTORY-817: override `getCapacityRoles()`'s answer — defaults to `{values: AGENT_ROLES, default: CAPACITY_ROLE_DEFAULT}` (the real values). Set this only to rehearse a UI against a DIFFERENT shape than the real one ships — not needed for ordinary tests. */
  capacityRoles?: RuleCapacityRolesCatalog;
}

const DEFAULT_FIXTURE_ETAG = "fixture-etag-0";

/** Mirrors `src/rules/rules-write.ts`'s own `computeLocalPlanCounts` (PR #647) — the SAME blast-radius decision, so a fixture's default plan/refusal behavior matches what the real server would actually do for the same patch. */
function computeLocalPlanCounts(wasEnabled: boolean, patch: RulePlanPatch): { spawned: number; stopped: number; restarted: number } {
  if (patch.enabled !== undefined && patch.enabled !== wasEnabled) {
    return patch.enabled ? { spawned: 1, stopped: 0, restarted: 0 } : { spawned: 0, stopped: 1, restarted: 0 };
  }
  // FACTORY-729: mirrors the real server's own `computeLocalPlanCounts` (`src/rules/rules-write.ts`) — permissionMode/lizardMode count the same as query/agentPreferences.
  const otherFieldsChanged = patch.query !== undefined || patch.agentPreferences !== undefined || patch.permissionMode !== undefined || patch.lizardMode !== undefined;
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
        permissionMode: null,
        lizardMode: null,
        resumeOnRespawn: null,
        resumeContextCutoff: null,
        idlePokeMinutes: null,
        idlePokeMessage: null,
        idlePokeEnabled: true,
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
        permissionMode: null,
        lizardMode: null,
        resumeOnRespawn: null,
        resumeContextCutoff: null,
        idlePokeMinutes: null,
        idlePokeMessage: null,
        idlePokeEnabled: true,
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
        permissionMode: "default",
        lizardMode: true,
        resumeOnRespawn: false,
        resumeContextCutoff: 50_000,
        idlePokeMinutes: 15,
        idlePokeMessage: null,
        idlePokeEnabled: false,
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
        permissionMode: null,
        lizardMode: null,
        resumeOnRespawn: null,
        resumeContextCutoff: null,
        idlePokeMinutes: null,
        idlePokeMessage: null,
        idlePokeEnabled: true,
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
  const requireConfirmForBlastRadius = (counts: { spawned: number; stopped: number; restarted: number }, confirm: boolean) => {
    if ((counts.stopped > 0 || counts.restarted > 0) && !confirm) {
      throw new Error(`this change would stop ${counts.stopped} and restart ${counts.restarted} running agent(s) — retry with confirm: true to proceed`);
    }
  };
  // FACTORY-729: mirrors the real server's own `RISKY_PERMISSION_MODES`/`requireConfirmForRiskyFields` (`src/rules/rules-write-registry.ts`/`rules-write.ts`).
  const RISKY_PERMISSION_MODES = new Set<RulePermissionMode>(["bypassPermissions", "auto"]);
  // FACTORY-817: `role: "sentinel"` joins this gate — see the real server's own `isRiskyFieldPatch` doc comment (`src/rules/rules-write.ts`) for why.
  const isRiskyFieldPatch = (patch: Pick<RuleFieldPatch, "permissionMode" | "lizardMode" | "role">): boolean =>
    (patch.permissionMode !== undefined && RISKY_PERMISSION_MODES.has(patch.permissionMode)) || patch.lizardMode === true || patch.role === "sentinel";
  const requireConfirmForRiskyFields = (patch: Pick<RuleFieldPatch, "permissionMode" | "lizardMode" | "role">, confirm: boolean) => {
    if (isRiskyFieldPatch(patch) && !confirm) {
      const named = patch.permissionMode !== undefined ? `permissionMode: ${JSON.stringify(patch.permissionMode)}` : patch.lizardMode === true ? "lizardMode: true" : `role: "sentinel"`;
      throw new Error(`setting ${named} is never a default and requires an explicit confirm — retry with confirm: true to proceed`);
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
    async previewRule(ruleId, _signal, queryOverride) {
      await delay();
      maybeFail();
      // FACTORY-730: a draft-query preview (`queryOverride`) looks up
      // `opts.previewsByQuery` first (keyed `${ruleId}:${queryOverride}`),
      // falling back to the ordinary `opts.previews` — lets a test fix a
      // distinct scope count for a NOT-YET-SAVED query without needing a
      // real previewer.
      if (queryOverride !== undefined) {
        const byQuery = opts.previewsByQuery?.[`${ruleId}:${queryOverride}`];
        if (byQuery) return byQuery;
      }
      return opts.previews?.[ruleId] ?? { ruleId, total: 0, tickets: [] };
    },
    async getCatalog() {
      await delay();
      maybeFail();
      // FACTORY-729: the SAME `RULE_FORM_CATALOG` the real server serves
      // from `GET /api/rules/catalog` — never a second, fixture-only list.
      return opts.catalog ?? RULE_FORM_CATALOG;
    },
    async getCapacityRoles() {
      await delay();
      maybeFail();
      return opts.capacityRoles ?? { values: AGENT_ROLES, default: CAPACITY_ROLE_DEFAULT };
    },
    async planRule(ruleId, patch, confirm) {
      await delay();
      maybeFail();
      if (opts.plans?.[ruleId]) return opts.plans[ruleId]!;
      const rule = findRule(ruleId);
      // Mirrors the real server's own check order (`planRuleWrite`): the
      // placeholder-query refusal happens BEFORE any confirm/scope logic is
      // even computed, so a still-placeholder enable refuses plainly rather
      // than showing a confirm dialog for a write that can never succeed.
      if (patch.enabled === true && !rule.enabled && rule.query === PLACEHOLDER_QUERY) {
        throw new Error(`rule "${ruleId}" cannot be enabled while its query is still the placeholder — edit the query first`);
      }
      const counts = computeLocalPlanCounts(rule.enabled, patch);
      // FACTORY-730 (review round 2): a CHANGED `query` is dry-run against
      // its NEW text — regardless of `counts.spawned` (always 0 for a real
      // field edit) — mirroring the real server's own `planRuleWrite`.
      // `previewsByQuery` (keyed `${ruleId}:${patch.query}`) lets a test fix
      // a distinct count for the draft text; falls back to `previews`.
      const queryChanged = patch.query !== undefined && patch.query !== rule.query;
      const scopeCount = counts.spawned > 0
        ? opts.previews?.[ruleId]?.total ?? 0
        : queryChanged
          ? opts.previewsByQuery?.[`${ruleId}:${patch.query}`]?.total ?? opts.previews?.[ruleId]?.total ?? 0
          : undefined;
      // Mirrors `src/rules/rules-write.ts`'s own `planRuleWrite` gate order
      // (FACTORY-685, item 2): a swarm enable needs confirm at ANY scope,
      // not only above the ceiling.
      const rawSwarmEnable = counts.spawned > 0 && rule.execution === "swarm";
      const rawOverCeiling = counts.spawned > 0 && scopeCount !== undefined && scopeCount > ENABLE_SCOPE_CEILING;
      // FACTORY-730: raw/unconditional, same discipline as the gates above.
      const rawQueryChange = queryChanged;
      const rawStopRestart = counts.stopped > 0 || counts.restarted > 0;
      // FACTORY-729/FACTORY-730/FACTORY-817: mirrors the real server's own `planRuleWrite` — least-specific gates, see that function's own comment.
      const rawRiskyPermission = (patch.permissionMode !== undefined && RISKY_PERMISSION_MODES.has(patch.permissionMode)) || patch.lizardMode === true;
      const rawCapacitySentinel = patch.role === "sentinel";
      const rawRiskyField = rawRiskyPermission || rawCapacitySentinel;
      const requiresConfirm = (rawOverCeiling && !confirm) || (rawSwarmEnable && !confirm) || (rawQueryChange && !confirm) || (rawStopRestart && !confirm) || (rawRiskyField && !confirm);
      const confirmReason: RulePlanResponse["confirmReason"] = !requiresConfirm
        ? undefined
        : rawOverCeiling
          ? "scope-ceiling"
          : rawSwarmEnable
            ? "swarm-enable"
            : rawQueryChange
              ? "query-change"
              : rawStopRestart
                ? "stop-restart"
                : rawRiskyPermission
                  ? "risky-permission"
                  : "capacity-sentinel";
      const base: RulePlanResponse = {
        planHash: `${ruleId}:${JSON.stringify(patch)}:${confirm}:${state.sourceEtag}`,
        spawned: counts.spawned,
        stopped: counts.stopped,
        restarted: counts.restarted,
        etag: state.sourceEtag,
        requiresConfirm,
        ...(confirmReason ? { confirmReason } : {}),
      };
      return scopeCount !== undefined ? { ...base, scopeCount } : base;
    },
    async setEnabled(ruleId, enabled, ifMatch, planHash, confirm) {
      await delay();
      maybeFail();
      maybeFailWriteOnce();
      const rule = findRule(ruleId);
      checkIfMatch(ifMatch);
      if (!planHash) throw new Error("planHash does not match a fresh plan for this write (the file may have changed, or the plan is stale) — call POST /api/rules/plan again");
      if (enabled && rule.query === PLACEHOLDER_QUERY) {
        throw new Error(`rule "${ruleId}" cannot be enabled while its query is still the placeholder — edit the query first`);
      }
      const counts = computeLocalPlanCounts(rule.enabled, { enabled });
      const plan = opts.plans?.[ruleId];
      // FACTORY-685 (item 2): ANY swarm enable needs confirm, mirrored here
      // so a component test exercising setEnabled directly (not just the
      // plan step) sees the same gate the real server enforces.
      if (enabled && counts.spawned > 0 && rule.execution === "swarm" && !confirm) {
        throw new Error(`enabling "${ruleId}" will staff up to ${plan?.scopeCount ?? opts.previews?.[ruleId]?.total ?? 0} ticket(s); resend with confirm: true to proceed`);
      }
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
      checkIfMatch(ifMatch);
      if (!planHash) throw new Error("planHash does not match a fresh plan for this write (the file may have changed, or the plan is stale) — call POST /api/rules/plan again");
      const counts = computeLocalPlanCounts(rule.enabled, patch);
      requireConfirmForBlastRadius(counts, confirm);
      requireConfirmForRiskyFields(patch, confirm);
      // FACTORY-730 (review round 2): a CHANGED query must be confirmed —
      // mirrors the real server's own `writeRuleFields` gate, regardless of
      // whether `requireConfirmForBlastRadius` above already caught it
      // (an enabled rule's query edit trips both; a disabled rule's trips
      // only this one).
      if (patch.query !== undefined && patch.query !== rule.query && !confirm) {
        const scopeCount = opts.previewsByQuery?.[`${ruleId}:${patch.query}`]?.total ?? opts.previews?.[ruleId]?.total ?? 0;
        throw new Error(`editing "${ruleId}"'s query would now match ${scopeCount} ticket(s) — retry with confirm: true to proceed`);
      }
      const updated: RuleDto = {
        ...rule,
        query: patch.query ?? rule.query,
        permissionMode: patch.permissionMode ?? rule.permissionMode,
        lizardMode: patch.lizardMode ?? rule.lizardMode,
        role: patch.role ?? rule.role,
        idlePokeMinutes: patch.idlePokeMinutes ?? rule.idlePokeMinutes,
        idlePokeMessage: patch.idlePokeMessage ?? rule.idlePokeMessage,
        idlePokeEnabled: patch.idlePokeEnabled ?? rule.idlePokeEnabled,
        agentPreferences:
          patch.agentPreferences?.map((p, i) => ({ ...(rule.agentPreferences[i] ?? { harness: "claude" as AgentHarness }), ...p })) ?? rule.agentPreferences,
      };
      return commitWrite(state.rules.map((r) => (r.id === ruleId ? updated : r)), [ruleId]);
    },
    async deleteRule(ruleId, ifMatch, confirm) {
      await delay();
      maybeFail();
      maybeFailWriteOnce();
      const rule = findRule(ruleId);
      checkIfMatch(ifMatch);
      if (rule.enabled) {
        throw new Error(`rule "${ruleId}" cannot be deleted while it is enabled — disable it first`);
      }
      // Mirrors the real server's `hasLiveAgents` gate (`writeRuleDelete`,
      // `src/rules/rules-write.ts`) as best a fixture can: `staffed ===
      // true` is the SAME tri-state fact `GET /api/rules` already reports
      // for this rule, never a second signal invented here.
      if (rule.staffed === true) {
        throw new Error(`rule "${ruleId}" cannot be deleted while it has live agent(s) running — wait for them to finish or stop them first`);
      }
      if (!confirm) {
        throw new Error(`delete rule "${ruleId}" (query: ${JSON.stringify(rule.query)})? resend with confirm: true to proceed`);
      }
      return commitWrite(state.rules.filter((r) => r.id !== ruleId), [ruleId]);
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
    // FACTORY-927 — mirrors the real server's own unconditional confirm gate
    // (`createRule`, `src/rules/rules-write.ts`): refuses an id collision
    // (regardless of `confirm`) and refuses with no `confirm: true` at all,
    // naming the dry-run scope in the message — the SAME two refusals a
    // component test against the real route would see, just without a real
    // previewer behind it (`opts.previews`/the id's own entry stand in for
    // the dry-run scope count, defaulting to 0).
    async createRule(draft, confirm) {
      await delay();
      maybeFail();
      maybeFailWriteOnce();
      if (state.rules.some((r) => r.id === draft.id)) {
        throw new Error(`a rule with id ${JSON.stringify(draft.id)} already exists`);
      }
      const scopeCount = opts.previews?.[draft.id]?.total ?? 0;
      if (!confirm) {
        throw new Error(`create rule ${JSON.stringify(draft.id)} (query: ${JSON.stringify(draft.query)}, scope: ${scopeCount} ticket(s))? resend with confirm: true to proceed`);
      }
      const created: RuleDto = {
        id: draft.id,
        resourceProvider: draft.resourceProvider,
        query: draft.query,
        enabled: false,
        execution: "swarm",
        account: "none",
        role: draft.role ?? "worker",
        agentPreferences: draft.agentPreferences ?? [],
        permissionMode: draft.permissionMode ?? null,
        lizardMode: draft.lizardMode ?? null,
        resumeOnRespawn: null,
        resumeContextCutoff: null,
        staffed: false,
        reason: "disabled",
      };
      return commitWrite([...state.rules, created], [draft.id]);
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
