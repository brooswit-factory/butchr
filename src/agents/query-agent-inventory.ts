/**
 * FACTORY-72 (story FACTORY-69, epic FACTORY-68) — a read-only inventory of
 * EVERY configured query agent, whether or not it currently has a running
 * agent: every rule in the daemon's own rules file, and every managed-session
 * definition (active or archived), each with a real, computed reason when it
 * is not currently staffed. Served by the daemon's `/config-inventory` GET
 * route (`src/web/view.ts`) — this module builds the response; the route
 * itself does no shaping of its own.
 *
 * FACTORY-132: a `RuleInventoryEntry`'s staffing is a THREE-state fact, not
 * two — `staffed: true` (staffed), `staffed: false` (genuinely not staffed,
 * `reason` says why), or `staffed: null` (COULD NOT CHECK: the agent census
 * itself is unavailable this poll, so neither "staffed" nor "not staffed" is
 * a fact this daemon can currently assert). See `RuleInventoryEntry.staffed`'s
 * own doc comment for the exact contract and `ruleStaffingReason`'s own doc
 * comment for the fixed check order that produces it.
 *
 * REUSE, NOT RE-DERIVATION, is this module's whole design constraint:
 *
 * - "Is this rule currently staffed, and why not" is answered by reading
 *   `DashboardResponse` (`./dashboard.ts`) — the SAME poll-fed snapshot
 *   `/dashboard` already serves, decoded back to (resourceProvider, ruleId)
 *   via `decodeAnyAgentKey` (`../rules/agent-key.ts`). This module makes NO
 *   fresh call of its own to `herd.runningIssues()` or to any admission
 *   census: a rule's live agent(s) already appear as `AgentDashboardRow`s and
 *   a rule's admission-cap-withheld resource(s) already appear as
 *   `WithheldDashboardRow`s (BUTCHR-332's `updateWithheldRows` builds those
 *   for every admission source this daemon declares, not just "issue" —
 *   see that function's own doc comment), so cross-referencing rows already
 *   IN HAND against every enabled rule answers "staffed?" / "admission cap?"
 *   for every provider uniformly, with zero new I/O and zero new per-provider
 *   match-count plumbing.
 * - A provider's "missing token/config" reason is answered by
 *   `githubIssueStaffing`/`zendeskTicketStaffing` (`../rules/github-issue-
 *   type.ts` / `../rules/zendesk-ticket-type.ts`) — the exact functions
 *   `src/daemon/index.ts` already calls once at startup to decide whether
 *   those providers run at all. This module never re-implements that check;
 *   the caller (`src/daemon/index.ts`) passes a `configReasonFor` callback
 *   built directly from its own already-computed `githubStaffing`/
 *   `zendeskStaffing` values.
 * - A managed-session definition's fields are answered by
 *   `listSessionDefinitions` (`../resources/session-definition-manage.ts`) —
 *   the exact function `butchr session list` already uses, extended
 *   (additively; see that module's own diff) with the handful of fields this
 *   ticket needs that the CLI never surfaced (`permissionMode`, `account`,
 *   `workingDirectory`, `mcpServerNames`) but that `SessionDefinition` always
 *   had. Called TWICE — once for the active definitions directory, once for
 *   the archive directory (`../resources/session-archive.ts`'s
 *   `sessionArchiveDir`) with `identityDir` pointed back at the active
 *   directory, exactly the shape `butchr session list --archived` already
 *   uses — so "archived" is a real, computed boolean, never guessed.
 *
 * NO SECRETS, BY CONSTRUCTION, NOT BY REDACTION: every field on
 * `RuleInventoryEntry`/`SessionDefinitionInventoryEntry` is copied out one at
 * a time, by name, from an already-validated `Rule`/`SessionDefinition` —
 * never a spread of the source object. An MCP server binding contributes
 * only its OWN `name` (`mcpServerNames`), never `url`/`headersEnvVar`/
 * `accountHeader` — see `McpServerBinding`'s own doc comment (`../rules/
 * rules.ts`) for why those two fields are already NAMES, not secret values,
 * but this module omits them anyway, exactly matching this ticket's own
 * wording ("MCP server NAMES ONLY"). A parse-error `message` is whatever
 * `sessionDefinitionProblems`/`parseRules` already produced — both of those
 * validators are themselves field-whitelisted and echo unknown-field KEYS
 * only, never values (see `session-definition.ts`/`rules.ts`'s own
 * `unknownFields` helpers), so no new secret-echoing surface is introduced
 * here; `test/unit/query-agent-inventory.test.ts` proves this end-to-end
 * against fixtures carrying fake secret-shaped strings, including in a
 * malformed-file case.
 *
 * CORRELATION IDENTIFIER — reused, never invented a second one (this
 * ticket's own requirement): a `RuleInventoryEntry`'s `(resourceProvider,
 * id)` pair is exactly what `decodeAnyAgentKey` returns for any agent that
 * rule ever spawns — a `{kind: "resource", resourceProvider, ruleId,
 * resourceId}` for an ordinary per-resource `swarm` match, or a `{kind:
 * "query", resourceProvider, ruleId}` for a `singleton`/`persistent` rule's
 * one query-level agent — either way, `ruleId === entry.id &&
 * resourceProvider === entry.resourceProvider` is the whole match. A
 * `SessionDefinitionInventoryEntry`'s `agentKey` (when present — see that
 * field's own doc comment on `SessionDefinitionListEntry`) is `sessionAgentKey
 * (path)`, byte-identical to the `resourceKey` a managed-session's own
 * `AgentDashboardRow` carries. Neither is a new format this ticket invented.
 */
import type { AgentEffort, AgentHarness, AgentPreference, AgentRole, AccountPolicy, ExecutionMode, ReadRulesFile, Rule, RulesEnv, ResourceProvider } from "../rules/rules.js";
import { loadRules, rulesPath } from "../rules/rules.js";
import { decodeAnyAgentKey } from "../rules/agent-key.js";
import type { AdmissionCensusField, AdmissionView, DashboardResponse, DashboardRow } from "./dashboard.js";
import {
  listSessionDefinitions,
  type SessionDefinitionListDeps,
  type SessionDefinitionListEntry,
} from "../resources/session-definition-manage.js";
import { assertArchiveDirDisjoint } from "../resources/session-archive.js";
import { effectiveAgent } from "../resources/session-definition.js";

/** One file (a rules file, or a session-definition file) that failed to load or parse — never swallowed, never log-only. */
export interface FileErrorEntry {
  path: string;
  message: string;
}

export interface RuleInventoryEntry {
  kind: "rule";
  /** Correlation identifier, half 1 of 2 — see this module's own top comment. Stable; part of every agent key this rule produces (`../rules/rules.ts`'s own `Rule.id` doc comment). */
  id: string;
  /** Correlation identifier, half 2 of 2. */
  resourceProvider: ResourceProvider;
  query: string;
  enabled: boolean;
  execution: ExecutionMode;
  account: AccountPolicy;
  role: AgentRole;
  /**
   * `rule.agentPreferences`, ranked-order preserved, each copied field-by-field
   * (`harness`/`model`/`effort` — none secret) rather than reused as-is.
   * `model`/`effort` here are ALREADY the fully resolved effective values,
   * whether the rule expressed them directly or via `modelPower`/
   * `effortPower` — `rules.ts`'s own `parsePreferences` resolves either axis
   * through `../resources/power-scale.ts`'s `resolveModelPower`/
   * `resolveEffortPower` once, at rule-load time, and keeps only the
   * resolved `{harness, model?, effort?}` shape on the parsed preference —
   * the raw 0-100 input is not retained there (see `AgentPreference`'s own
   * doc comment, `../rules/rules.ts`), so this module has no raw power to
   * copy even if it wanted to, and makes no second call to those tables
   * either way. FACTORY-120: keeping/showing the raw `modelPower`/
   * `effortPower` for a rule preference was considered and ruled OUT of
   * scope (it would mean changing `parsePreferences`/`AgentPreference`,
   * which are also read to build spawn specs and the duplicate-preference
   * identity key) — see FACTORY-120's own ticket if you're looking for that
   * raw value; it was filed onward to FACTORY-73 instead of built here.
   * `[]` when the rule sets no preference (uses butchr's global agent
   * config).
   */
  agentPreferences: { harness: AgentHarness; model?: string; effort?: AgentEffort }[];
  /** `rule.linkedEventing === true`; `false` for absent/false alike (see that field's own doc comment on `Rule` — absent and false are the same no-op). */
  linkedEventing: boolean;
  /** `rule.mcpServers`' own `name`s ONLY — see this module's own top comment on why nothing else from a binding is ever copied here. `[]` when the rule binds none. */
  mcpServerNames: string[];
  /**
   * `true` when at least one live agent (or, for a `singleton`/`persistent`
   * rule, its one query-level agent) is currently observed for this rule;
   * `false` when this rule is genuinely not staffed right now (`reason` says
   * why); `null` when staffing could NOT be determined because the agent
   * census is unavailable (FACTORY-132) — a third state, neither a truthy
   * "staffed" nor a falsy "not staffed". `null` is NOT the same claim as
   * `false`: `false` says this daemon looked and found nothing (or a config
   * reason already rules it out); `null` says this daemon could not look at
   * all this poll. Every reader in this repo compares with `=== true` /
   * `=== false` / `=== null` (or an exhaustive branch) — never a truthiness
   * test, which would silently collapse `null` back into "not staffed" and
   * reintroduce the exact defect this field exists to fix.
   */
  staffed: boolean | null;
  /** Why this rule is not currently staffed, or why that could not be determined — `null` iff `staffed === true`; non-null and explanatory for BOTH `staffed === false` and `staffed === null` alike (see `ruleStaffingReason`'s own doc comment for the exact vocabulary). */
  reason: string | null;
}

export interface SessionDefinitionInventoryEntry extends SessionDefinitionListEntry {
  kind: "session-definition";
  /** `true` when this entry was read from the archive directory rather than the active one — computed from which directory actually produced it, never guessed. */
  archived: boolean;
  /**
   * FACTORY-120 — the resolved effective model for this definition, via
   * `effectiveAgent()` (`../resources/session-definition.ts`): reused
   * verbatim, never re-derived from `../resources/power-scale.ts`'s tables
   * directly, whether this entry is a `tier`-based (deprecated) definition
   * or a `modelPower`/`effort`-based one — see that function's own doc
   * comment for why each path resolves differently. `undefined` for an
   * INVALID entry (`valid: false`) — its content fields, this one included,
   * structurally do not exist, same NOT-APPLICABLE discipline every other
   * optional field on this interface already follows.
   */
  resolvedModel?: string;
  /**
   * Same source (`effectiveAgent()`). `undefined` for an INVALID entry
   * (as `resolvedModel` above) AND, by design, for a valid `tier`-based
   * (deprecated) definition: `effectiveAgent()` deliberately returns no
   * `effort` for that path so a tier-based launch's real behaviour (no
   * `--effort` override derived from `tier`) is reflected exactly, not
   * approximated — see `effectiveAgent`'s own doc comment.
   */
  resolvedEffort?: AgentEffort;
}

export interface QueryAgentInventory {
  rules: RuleInventoryEntry[];
  sessionDefinitions: SessionDefinitionInventoryEntry[];
  /** Every rules-file or session-definition-file load/parse error, one entry per bad file — see this module's own top comment. Independent of `rules`/`sessionDefinitions`: a bad session-definition file ALSO appears there with `valid: false` and its own `problems`; this list exists so a caller can scan for trouble without walking every entry. */
  errors: FileErrorEntry[];
}

const ruleCorrelationKey = (resourceProvider: ResourceProvider, ruleId: string): string => `${resourceProvider}:${ruleId}`;

/**
 * FACTORY-731 — `DELETE /api/rules/:id`'s own "does this rule currently have
 * a live agent" check: whether `rows` (the SAME poll-fed `DashboardResponse.
 * rows` every staffing check in this module already reads — see this
 * module's own top comment) carries at least one row for `ruleId`, decoded
 * via `decodeAnyAgentKey` (`../rules/agent-key.ts`), that is NOT a withheld
 * row. A rule id is validated unique across the whole rules document at load
 * time (`rules.ts`'s own duplicate-id check), so matching on `ruleId` alone
 * (never pairing it with `resourceProvider`, unlike `ruleCorrelationKey`
 * above) is unambiguous here — this call site does not have a `Rule` object
 * in hand to read `resourceProvider` off of, only the bare id a `DELETE`
 * path segment names.
 *
 * KNOWN RACE, DELIBERATELY ACCEPTED, NEVER PAPERED OVER: `rows` is a
 * SNAPSHOT from the daemon's own periodic poll (`createDashboardFeed`), not
 * a live, real-time query — so this can be WRONG in both directions between
 * polls. A false POSITIVE (an agent that finished seconds ago still shows as
 * live) only makes a delete attempt bounce and need a retry — annoying, not
 * unsafe. A false NEGATIVE (an agent spawned since the last poll is not yet
 * in `rows`) is the dangerous direction: it could let a delete through while
 * an agent is, in fact, about to start running against the just-deleted
 * rule's id. This check narrows that window to one poll interval; it cannot
 * close it to zero without a synchronous, on-demand census this daemon does
 * not have today. The write path's own `enabled === false` requirement
 * (checked separately, inside the write lock) is the deeper mitigation: a
 * rule has to be disabled before it can be deleted, and a disabled rule's
 * running agents are stopped by the reconciler's own ordinary stop/reap path
 * on an upcoming poll (same as any other disable) — the live-agent check
 * here exists to catch the WINDOW between "just disabled" and "the
 * reconciler has actually reaped it", not to replace that path.
 */
export function ruleHasLiveAgent(ruleId: string, rows: readonly DashboardRow[]): boolean {
  for (const row of rows) {
    if (row.kind === "withheld") continue;
    const decoded = decodeAnyAgentKey(row.resourceKey);
    if (decoded && decoded.ruleId === ruleId) return true;
  }
  return false;
}

/**
 * Every rule key (`resourceProvider:ruleId`) with at least one row in `rows`
 * — split into `live` (an ordinary `AgentDashboardRow`: a real running agent)
 * and `withheld` (a `WithheldDashboardRow`: matched but held back by the
 * fleet-wide admission cap this poll) — see this module's own top comment
 * for why reading `DashboardResponse.rows` answers this for every provider
 * uniformly, with no new I/O. A row whose `resourceKey` does not decode
 * (nothing in this daemon ever produces one, but `decodeAnyAgentKey` is
 * total) is silently skipped, same discipline `dashboard.ts` itself already
 * uses for a row with no resolvable resource key.
 */
function liveAndWithheldRuleKeys(rows: readonly DashboardRow[]): { live: ReadonlySet<string>; withheld: ReadonlySet<string> } {
  const live = new Set<string>();
  const withheld = new Set<string>();
  for (const row of rows) {
    const decoded = decodeAnyAgentKey(row.resourceKey);
    if (!decoded) continue;
    const key = ruleCorrelationKey(decoded.resourceProvider, decoded.ruleId);
    (row.kind === "withheld" ? withheld : live).add(key);
  }
  return { live, withheld };
}

/**
 * FACTORY-136: every rule provider's own admission-source name, verified by
 * reading every `admissionController.admit(...)` call site in
 * `src/daemon/index.ts` — each rule-driving loop admits under its own
 * `ADMISSION_SOURCE_*` constant, and every one of those constants' STRING
 * VALUE equals the `ResourceProvider` it drives, with exactly one exception:
 * the `jira-work` loop (`runResourceLoop(ruleResourceType, ...)`, the plain
 * Jira issue/project-search rule engine) admits under the source name
 * `"issue"`, not `"jira-work"` — confirmed by `ownsRuleAgent`/the `enabled`
 * filter in `src/rules/resource-type.ts` both keying on `resourceProvider
 * === "jira-work"` while the SAME loop's own `admission:` callback in
 * `index.ts` passes `ADMISSION_SOURCE_ISSUE = "issue"`. No other provider has
 * this mismatch. The mapping is TOTAL and 1:1 over every `ResourceProvider` —
 * no two providers share a source, and no provider spans more than one.
 * `"managed-sessions"` (`ADMISSION_SOURCE_MANAGED_SESSIONS`) has no entry
 * here: it is never a `Rule.resourceProvider` value, only the built-in
 * managed-session-definitions loop's own admission bucket, which this module
 * already handles separately (`SessionDefinitionInventoryEntry`, no
 * `staffed`/`reason` of its own).
 */
const RULE_ADMISSION_SOURCE: Readonly<Record<ResourceProvider, string>> = {
  "jira-work": "issue",
  "github-issue": "github-issue",
  "github-pr": "github-pr",
  "jira-idea": "jira-idea",
  "zendesk-ticket": "zendesk-ticket",
  "jira-project": "jira-project",
  filesystem: "filesystem",
};

/**
 * A rule's own covering admission source's census entry, resolved from
 * `AdmissionView.sources` (`./dashboard.ts`) via `RULE_ADMISSION_SOURCE`.
 *
 * FACTORY-340: a source CAN be entirely absent from `admission.sources` in a
 * real daemon — `src/daemon/index.ts`'s conditional `sources:` list omits a
 * provider's entry whenever that provider's own client failed to construct
 * (e.g. `github-pr`'s `githubPrs = githubPrStaffingResult.run && config.github`
 * being falsy when an enabled `github-pr` rule exists but `config.github` is
 * unset — no `GITHUB_TOKEN_FILE`/`BUTCHR_GITHUB_ORGS`), independent of
 * whether `configReasonFor` (below) also happens to cover that provider. The
 * previous doc comment here claimed this was structurally impossible; it was
 * wrong (epic-reviewer finding on FACTORY-136). Returns `{ source, absent:
 * true }` in that case — resolved via `RULE_ADMISSION_SOURCE` all the same,
 * so the source name is still known and reportable even though its census
 * entry is not — rather than `undefined`, so `ruleStaffingReason` below can
 * never mistake "not present in the census" for "reported and fine".
 */
function admissionSourceCensusFor(rule: Rule, admission: AdmissionView): { source: string; census: AdmissionCensusField } | { source: string; absent: true } {
  const source = RULE_ADMISSION_SOURCE[rule.resourceProvider];
  const entry = admission.sources.find((s) => s.source === source);
  return entry ? { source: entry.source, census: entry.census } : { source, absent: true };
}

export interface RuleStaffingDeps {
  /** From `githubIssueStaffing`/`zendeskTicketStaffing` (or any future provider's own equivalent) — `null` when this rule's provider has no config/credential problem right now (may still be unstaffed for another reason below). Never consulted for a disabled rule. */
  configReason: string | null;
  live: ReadonlySet<string>;
  withheld: ReadonlySet<string>;
  /**
   * `DashboardResponse.checked` verbatim — whether the MOST RECENT
   * `agent.list()` poll succeeded. NOT "whether at least one poll has ever
   * succeeded": per `createDashboardFeed`'s own doc comment (`./dashboard.ts`),
   * a poll that fails AFTER an earlier success also flips this back to
   * `false`, carrying the previous (possibly stale) rows forward. So
   * `dashboardChecked === false` covers TWO cases — never yet succeeded, and
   * most-recently failed — and distinguishes both alike from a genuine "no
   * matches" (same discriminator `dashboard.ts` itself uses via
   * `checked`/`declinedAt`, and the same one `dashboard-page.ts`'s own page
   * banner keys its COULD NOT CHECK rendering on). Any reason string derived
   * from this flag being `false` must read as true under BOTH cases.
   */
  dashboardChecked: boolean;
  /**
   * FACTORY-136: this rule's own covering admission source's census entry
   * (`admissionSourceCensusFor`, above) — INDEPENDENT of `dashboardChecked`:
   * either can fail alone (see `AdmissionView`'s own doc comment on
   * `./dashboard.ts`). This is what closes the remaining gap `dashboardChecked`
   * does not cover — a rule whose admission source is declined or has never
   * reported has no way to know whether a matched resource is currently being
   * withheld by the fleet-wide cap (`withheld` above is built only from
   * sources that HAVE reported), so asserting a genuine zero in that case
   * would repeat exactly the defect FACTORY-132 fixed for the agent census.
   *
   * FACTORY-340: `{ source, absent: true }` — no `census` field at all — is
   * a DISTINCT case from `{ source, census }` with `census.checked === false`:
   * both mean "this rule's covering source cannot currently vouch for a
   * zero", but `absent` means the source was never even DECLARED this poll
   * (see `admissionSourceCensusFor`'s own doc comment for the real
   * `github-pr`-without-`config.github` case that makes this reachable),
   * while `census.checked === false` means it was declared and reported a
   * decline. `ruleStaffingReason` below treats both as COULD NOT CHECK.
   * `undefined` remains a third, allowed value for existing tests/fixtures
   * that construct `RuleStaffingDeps` directly and want to skip this branch
   * entirely — a real daemon path (via `admissionSourceCensusFor`) never
   * produces it, only `{ source, absent: true }` or `{ source, census }`.
   */
  admissionSourceCensus: { source: string; census: AdmissionCensusField } | { source: string; absent: true } | undefined;
}

/**
 * The real, computed "why isn't this rule staffed" reason — see this
 * module's own top comment for the reuse this is built from. Checked in
 * this fixed order, each one a strictly narrower question than the last:
 *
 * 1. `enabled === false` → `"disabled"`. Nothing else is even asked — a
 *    config fact, true regardless of census state.
 * 2. A provider-wide config/credential problem (`configReason`, e.g. no
 *    `GITHUB_TOKEN_FILE`) → that exact reason string, reused verbatim from
 *    `githubIssueStaffing`/`zendeskTicketStaffing` — also a config fact,
 *    also true regardless of census state.
 * 3. A live agent already observed for this rule → staffed, `reason: null`.
 * 4. A matched-but-withheld resource observed for this rule (the fleet-wide
 *    admission cap) → `"admission cap: ..."`.
 * 5. FACTORY-132: the agent census is unavailable (`!dashboardChecked` — see
 *    that field's own doc comment: the MOST RECENT poll didn't succeed,
 *    whether or not an earlier one did) → `staffed: null` (neither true nor
 *    false — this daemon genuinely cannot say), `"census unavailable: ..."`.
 *    Must never collapse into `UNSTAFFED` — that was this exact defect.
 * 6. FACTORY-136/FACTORY-340: the admission source covering this rule's own
 *    provider (`admissionSourceCensus`, resolved via `RULE_ADMISSION_SOURCE`)
 *    has NOT reported this poll — declined, never-reported, OR (FACTORY-340)
 *    entirely ABSENT from this poll's admission census (`{ source, absent:
 *    true }` — see `admissionSourceCensusFor`'s own doc comment for the real
 *    `github-pr`-without-`config.github` case this covers) → `staffed: null`
 *    (the SAME tri-state FACTORY-132 introduced, not a distinct fourth
 *    state — see this function's own module-level discussion of that
 *    choice), naming the unavailable source in the reason. This is checked
 *    strictly AFTER the agent-census check (5) and AFTER the withheld check
 *    (4): a rule already known live or withheld (freshly observed OR carried
 *    forward from an earlier successful report of THIS SAME source) keeps
 *    that answer regardless of this poll's admission state, and a fully-down
 *    agent census is reported as that broader, more fundamental unknown
 *    rather than this narrower one. Only a rule whose provider's OWN source
 *    is unavailable (declined, never-reported, or absent) is affected — a
 *    rule whose source reported this poll keeps today's behaviour exactly,
 *    unchanged by this branch.
 * 7. Otherwise: a real, current zero — worded per `execution` mode, since
 *    "no matching resources" is not quite the right claim for a
 *    `singleton`/`persistent` rule's one query-level agent (see `Rule.execution`'s
 *    own doc comment, `../rules/rules.ts`).
 */
export function ruleStaffingReason(rule: Rule, deps: RuleStaffingDeps): { staffed: boolean | null; reason: string | null } {
  if (!rule.enabled) return { staffed: false, reason: "disabled" };
  if (deps.configReason) return { staffed: false, reason: deps.configReason };
  const key = ruleCorrelationKey(rule.resourceProvider, rule.id);
  if (deps.live.has(key)) return { staffed: true, reason: null };
  if (deps.withheld.has(key)) return { staffed: false, reason: "admission cap: matched resource(s) currently withheld by the fleet-wide agent cap" };
  if (!deps.dashboardChecked) return { staffed: null, reason: "census unavailable: the most recent agent-list poll did not succeed (or none has run yet), so this daemon cannot currently confirm whether a live agent is running" };
  if (deps.admissionSourceCensus && "absent" in deps.admissionSourceCensus) {
    return {
      staffed: null,
      reason: `census unavailable: the "${deps.admissionSourceCensus.source}" admission source covering this rule is not present in this poll's admission census, so an admission-cap withholding for this rule cannot currently be ruled out`,
    };
  }
  if (deps.admissionSourceCensus && !deps.admissionSourceCensus.census.checked) {
    return {
      staffed: null,
      reason: `census unavailable: the "${deps.admissionSourceCensus.source}" admission source covering this rule has not reported this poll (${deps.admissionSourceCensus.census.reason}), so an admission-cap withholding for this rule cannot currently be ruled out`,
    };
  }
  return {
    staffed: false,
    reason: rule.execution === "swarm" ? "no matching resources this poll" : "no live agent observed for this rule this poll",
  };
}

/** Field-by-field copy of one `AgentPreference` — never a spread of the raw object (same discipline as every other field on this module's entries), even though none of the three fields is secret. */
const copyAgentPreference = (p: AgentPreference): { harness: AgentHarness; model?: string; effort?: AgentEffort } => ({
  harness: p.harness,
  ...(p.model !== undefined ? { model: p.model } : {}),
  ...(p.effort !== undefined ? { effort: p.effort } : {}),
});

function buildRuleInventoryEntry(rule: Rule, deps: RuleStaffingDeps): RuleInventoryEntry {
  const { staffed, reason } = ruleStaffingReason(rule, deps);
  return {
    kind: "rule",
    id: rule.id,
    resourceProvider: rule.resourceProvider,
    query: rule.query,
    enabled: rule.enabled,
    execution: rule.execution,
    account: rule.account,
    role: rule.role,
    agentPreferences: (rule.agentPreferences ?? []).map(copyAgentPreference),
    linkedEventing: rule.linkedEventing === true,
    mcpServerNames: (rule.mcpServers ?? []).map((s) => s.name),
    staffed,
    reason,
  };
}

/** The rules-file half of `QueryAgentInventory`'s input — either the rules a successful load already produced, or the one error an unsuccessful load produced (never both). */
export interface RulesFileState {
  path: string;
  rules: readonly Rule[];
  error: FileErrorEntry | null;
}

/**
 * Non-throwing wrapper around `loadRules` (`../rules/rules.ts`) — reused
 * verbatim, never re-implemented. `src/daemon/index.ts` calls `loadRules`
 * itself at startup and `process.exit(1)`s on failure (a daemon can never be
 * SERVING this inventory over HTTP with a rules file that failed to load —
 * by the time a request reaches this module, the file that's currently
 * running already parsed), so this wrapper exists for exactly two things:
 * (a) this module's own tests, which exercise `RulesFileState` directly
 * against real fixture text (including a malformed-file case) with no
 * daemon involved at all, and (b) any future caller that wants to check the
 * CURRENT on-disk file independent of what a running daemon already loaded.
 * `src/daemon/index.ts`'s own wiring does not call this — it passes its
 * already-successful `{ path: rulesPath(), rules, error: null }` directly,
 * zero extra I/O on the request path, same discipline `dashboard.ts`'s own
 * "no fetch of its own" already sets.
 */
export function loadRulesFileState(env: RulesEnv = process.env, read?: ReadRulesFile): RulesFileState {
  const path = rulesPath(env);
  try {
    const loaded = read ? loadRules(env, read) : loadRules(env);
    return { path: loaded.path, rules: loaded.rules, error: null };
  } catch (e) {
    return { path, rules: [], error: { path, message: (e as Error).message } };
  }
}

export interface SessionDefinitionInventoryDeps extends Omit<SessionDefinitionListDeps, "dir" | "identityDir"> {
  activeDir: string;
  archiveDir: string;
}

/**
 * Every managed-session definition, active and archived alike — see this
 * module's own top comment for why `listSessionDefinitions` is called twice
 * rather than reimplemented. `assertArchiveDirDisjoint` (`../resources/
 * session-archive.ts`) is checked first, exactly as every archive-touching
 * CLI command already does: a misconfigured archive directory that sits
 * inside (or equals) the active one would otherwise double-list the same
 * files as both active and archived, which is confusing but never unsafe
 * (this whole module is read-only) — reported as one `FileErrorEntry`
 * keyed on `archiveDir` rather than thrown, so one misconfigured archive
 * directory does not take down the rest of this endpoint (the same "one bad
 * file must not hide the good ones" discipline this ticket asks for,
 * extended to "one bad directory").
 */
async function buildSessionDefinitionInventory(deps: SessionDefinitionInventoryDeps): Promise<{ entries: SessionDefinitionInventoryEntry[]; errors: FileErrorEntry[] }> {
  const errors: FileErrorEntry[] = [];
  try {
    assertArchiveDirDisjoint(deps.activeDir, deps.archiveDir);
  } catch (e) {
    errors.push({ path: deps.archiveDir, message: (e as Error).message });
    const active = await listSessionDefinitions({ ...deps, dir: deps.activeDir });
    return { entries: tagEntries(active, false), errors: [...errors, ...fileErrorsOf(active)] };
  }
  const [active, archived] = await Promise.all([
    listSessionDefinitions({ ...deps, dir: deps.activeDir }),
    listSessionDefinitions({ ...deps, dir: deps.archiveDir, identityDir: deps.activeDir }),
  ]);
  return {
    entries: [...tagEntries(active, false), ...tagEntries(archived, true)],
    errors: [...errors, ...fileErrorsOf(active), ...fileErrorsOf(archived)],
  };
}

/**
 * FACTORY-120 — `resolvedModel`/`resolvedEffort` via `effectiveAgent()`
 * (`../resources/session-definition.ts`), computed only for a `valid` entry
 * with a `vendor` (an invalid entry's `vendor` is `undefined` by the same
 * NOT-APPLICABLE discipline every other content field here follows — see
 * `SessionDefinitionInventoryEntry`'s own doc comments). Safe to call
 * unconditionally once those two hold: `sessionDefinitionProblems`
 * (`../resources/session-definition.ts`) already rejects a valid entry that
 * sets neither `tier` nor both `modelPower`/`effort`, so `effectiveAgent()`
 * never hits its own "no band covers ..." throw here.
 */
function resolvedAgentFields(e: SessionDefinitionListEntry): { resolvedModel?: string; resolvedEffort?: AgentEffort } {
  if (!e.valid || e.vendor === undefined) return {};
  const { model, effort } = effectiveAgent({
    vendor: e.vendor,
    ...(e.tier !== undefined ? { tier: e.tier } : {}),
    ...(e.modelPower !== undefined ? { modelPower: e.modelPower } : {}),
    ...(e.effort !== undefined ? { effort: e.effort } : {}),
  });
  return { resolvedModel: model, ...(effort !== undefined ? { resolvedEffort: effort } : {}) };
}

const tagEntries = (entries: readonly SessionDefinitionListEntry[], archived: boolean): SessionDefinitionInventoryEntry[] =>
  entries.map((e) => ({ ...e, kind: "session-definition" as const, archived, ...resolvedAgentFields(e) }));

/** One `FileErrorEntry` per invalid definition — `problems` joined the same way `loadRulesFileState`'s own `error.message` is (a single string), never truncated to the first problem. */
const fileErrorsOf = (entries: readonly SessionDefinitionListEntry[]): FileErrorEntry[] =>
  entries.filter((e) => !e.valid).map((e) => ({ path: e.path, message: e.problems.join("\n") }));

export interface BuildQueryAgentInventoryDeps {
  rulesFile: RulesFileState;
  /** The SAME poll-fed snapshot `/dashboard` already serves (`createDashboardFeed(...).snapshot()`, `./dashboard.ts`) — never a fresh call of this module's own. */
  dashboard: DashboardResponse;
  /** Built by the caller from its own already-computed `githubIssueStaffing`/`zendeskTicketStaffing` (or any future provider's own equivalent) — see `RuleStaffingDeps.configReason`'s own doc comment. Never consulted for a disabled rule. */
  configReasonFor: (rule: Rule) => string | null;
  sessionDefinitions: SessionDefinitionInventoryDeps;
}

/** The whole inventory — see this module's own top comment for the shape and the reuse it is built from. */
export async function buildQueryAgentInventory(deps: BuildQueryAgentInventoryDeps): Promise<QueryAgentInventory> {
  const { live, withheld } = liveAndWithheldRuleKeys(deps.dashboard.rows);
  const rules = deps.rulesFile.rules.map((rule) =>
    buildRuleInventoryEntry(rule, {
      configReason: deps.configReasonFor(rule),
      live,
      withheld,
      dashboardChecked: deps.dashboard.checked,
      admissionSourceCensus: admissionSourceCensusFor(rule, deps.dashboard.admission),
    }),
  );
  const { entries: sessionDefinitions, errors: sessionErrors } = await buildSessionDefinitionInventory(deps.sessionDefinitions);
  const errors: FileErrorEntry[] = [...(deps.rulesFile.error ? [deps.rulesFile.error] : []), ...sessionErrors];
  return { rules, sessionDefinitions, errors };
}
