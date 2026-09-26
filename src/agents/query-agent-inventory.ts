/**
 * FACTORY-72 (story FACTORY-69, epic FACTORY-68) — a read-only inventory of
 * EVERY configured query agent, whether or not it currently has a running
 * agent: every rule in the daemon's own rules file, and every managed-session
 * definition (active or archived), each with a real, computed reason when it
 * is not currently staffed. Served by the daemon's `/config-inventory` GET
 * route (`src/web/view.ts`) — this module builds the response; the route
 * itself does no shaping of its own.
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
import type { DashboardResponse, DashboardRow } from "./dashboard.js";
import {
  listSessionDefinitions,
  type SessionDefinitionListDeps,
  type SessionDefinitionListEntry,
} from "../resources/session-definition-manage.js";
import { assertArchiveDirDisjoint } from "../resources/session-archive.js";

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
   * (`harness`/`model`/`effort` — none secret) rather than reused as-is. This
   * is the ticket's own "harness/provider list, tier" ask: `AgentPreference`'s
   * `model`/`effort` are the only rule-level analogue of "tier" — a `Rule` has
   * no `tier` field at all (that name belongs to `SessionDefinition` instead;
   * see `SessionDefinitionInventoryEntry.tier`) — so a `RuleInventoryEntry`
   * deliberately has no separate `tier` field either; a reader who needs a
   * per-rule model/effort reads it here. `[]` when the rule sets no
   * preference (uses butchr's global agent config).
   */
  agentPreferences: { harness: AgentHarness; model?: string; effort?: AgentEffort }[];
  /** `rule.linkedEventing === true`; `false` for absent/false alike (see that field's own doc comment on `Rule` — absent and false are the same no-op). */
  linkedEventing: boolean;
  /** `rule.mcpServers`' own `name`s ONLY — see this module's own top comment on why nothing else from a binding is ever copied here. `[]` when the rule binds none. */
  mcpServerNames: string[];
  /** `true` when at least one live agent (or, for a `singleton`/`persistent` rule, its one query-level agent) is currently observed for this rule. */
  staffed: boolean;
  /** Why this rule is not currently staffed — `null` when `staffed` or not applicable (see `ruleStaffingReason`'s own doc comment for the exact vocabulary). */
  reason: string | null;
}

export interface SessionDefinitionInventoryEntry extends SessionDefinitionListEntry {
  kind: "session-definition";
  /** `true` when this entry was read from the archive directory rather than the active one — computed from which directory actually produced it, never guessed. */
  archived: boolean;
}

export interface QueryAgentInventory {
  rules: RuleInventoryEntry[];
  sessionDefinitions: SessionDefinitionInventoryEntry[];
  /** Every rules-file or session-definition-file load/parse error, one entry per bad file — see this module's own top comment. Independent of `rules`/`sessionDefinitions`: a bad session-definition file ALSO appears there with `valid: false` and its own `problems`; this list exists so a caller can scan for trouble without walking every entry. */
  errors: FileErrorEntry[];
}

const ruleCorrelationKey = (resourceProvider: ResourceProvider, ruleId: string): string => `${resourceProvider}:${ruleId}`;

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

export interface RuleStaffingDeps {
  /** From `githubIssueStaffing`/`zendeskTicketStaffing` (or any future provider's own equivalent) — `null` when this rule's provider has no config/credential problem right now (may still be unstaffed for another reason below). Never consulted for a disabled rule. */
  configReason: string | null;
  live: ReadonlySet<string>;
  withheld: ReadonlySet<string>;
  /** `DashboardResponse.checked` — whether at least one `agent.list()` poll has ever succeeded. Distinguishes a genuine "no matches" from "this daemon hasn't observed anything yet" (same discriminator `dashboard.ts` itself uses via `checked`/`declinedAt`). */
  dashboardChecked: boolean;
}

/**
 * The real, computed "why isn't this rule staffed" reason — see this
 * module's own top comment for the reuse this is built from. Checked in
 * this fixed order, each one a strictly narrower question than the last:
 *
 * 1. `enabled === false` → `"disabled"`. Nothing else is even asked.
 * 2. A provider-wide config/credential problem (`configReason`, e.g. no
 *    `GITHUB_TOKEN_FILE`) → that exact reason string, reused verbatim from
 *    `githubIssueStaffing`/`zendeskTicketStaffing`.
 * 3. A live agent already observed for this rule → staffed, `reason: null`.
 * 4. A matched-but-withheld resource observed for this rule (the fleet-wide
 *    admission cap) → `"admission cap: ..."`.
 * 5. No successful poll yet (`!dashboardChecked`) → `"not yet observed: ..."`
 *    — never a false "no matches" before this daemon has looked even once.
 * 6. Otherwise: a real, current zero — worded per `execution` mode, since
 *    "no matching resources" is not quite the right claim for a
 *    `singleton`/`persistent` rule's one query-level agent (see `Rule.execution`'s
 *    own doc comment, `../rules/rules.ts`).
 */
export function ruleStaffingReason(rule: Rule, deps: RuleStaffingDeps): { staffed: boolean; reason: string | null } {
  if (!rule.enabled) return { staffed: false, reason: "disabled" };
  if (deps.configReason) return { staffed: false, reason: deps.configReason };
  const key = ruleCorrelationKey(rule.resourceProvider, rule.id);
  if (deps.live.has(key)) return { staffed: true, reason: null };
  if (deps.withheld.has(key)) return { staffed: false, reason: "admission cap: matched resource(s) currently withheld by the fleet-wide agent cap" };
  if (!deps.dashboardChecked) return { staffed: false, reason: "not yet observed: no successful agent-list poll since this daemon started" };
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

const tagEntries = (entries: readonly SessionDefinitionListEntry[], archived: boolean): SessionDefinitionInventoryEntry[] =>
  entries.map((e) => ({ ...e, kind: "session-definition" as const, archived }));

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
    buildRuleInventoryEntry(rule, { configReason: deps.configReasonFor(rule), live, withheld, dashboardChecked: deps.dashboard.checked }),
  );
  const { entries: sessionDefinitions, errors: sessionErrors } = await buildSessionDefinitionInventory(deps.sessionDefinitions);
  const errors: FileErrorEntry[] = [...(deps.rulesFile.error ? [deps.rulesFile.error] : []), ...sessionErrors];
  return { rules, sessionDefinitions, errors };
}
