/**
 * FACTORY-81 (story FACTORY-70, epic FACTORY-68) — the cross-link matching
 * between `QueryAgentInventory` entries (`./query-agent-inventory.ts`) and
 * `DashboardRow`s (`./dashboard.ts`), kept as small, pure, unit-testable
 * functions per that ticket's own requirement, reused by BOTH render
 * directions rather than each inventing its own half of the match:
 *
 *   - `src/web/config-inventory-page.ts` (the new Configurations view) uses
 *     `agentRowsForRule`/`agentRowsForSessionDefinition` to link a config
 *     entry FORWARD to its running agent row(s).
 *   - `src/web/dashboard-page.ts` (the existing agent view, additively) uses
 *     `configAnchorForResourceKey` to link a running agent row BACK to its
 *     config entry — deliberately WITHOUT taking the inventory as an input,
 *     so adding this back-link does not add a fresh inventory read (real
 *     disk I/O — see `query-agent-inventory.ts`'s own top comment) to `/`'s
 *     existing no-I/O request path (`src/web/view.ts`'s own doc comment on
 *     that route). Both directions decode exactly one way — never a second,
 *     invented correlation format — per the FACTORY-72 Confluence doc's own
 *     "Correlation identifier — reused, not invented" section.
 *
 * A RULE matches an agent row when `decodeAnyAgentKey(row.resourceKey)`
 * yields the same `(resourceProvider, ruleId)` pair as the rule's own
 * `(resourceProvider, id)` — true for both an ordinary per-resource `swarm`
 * match (`kind: "resource"`) and a `singleton`/`persistent` rule's one
 * query-level agent (`kind: "query"`); this module never distinguishes the
 * two kinds itself; either any match is enough.
 *
 * A SESSION DEFINITION matches an agent row when `row.resourceKey` equals
 * the entry's own `agentKey` EXACTLY — not decoded-and-compared-by-parts,
 * because an archived definition's `agentKey` is deliberately derived from
 * the path it would be RESTORED to (BUTCHR-455), which is not the value any
 * decode of the row's own key would reconstruct independently.
 *
 * `configAnchorForResourceKey`'s ONLY way to tell "this row is a managed
 * session" from "this row is an ordinary filesystem-provider rule" without
 * the actual entries in hand is the same sentinel check `herd.ts`/
 * `workspace.ts` already use elsewhere in this codebase
 * (`resourceProvider === "filesystem" && ruleId === MANAGED_SESSIONS_RULE_ID`):
 * that id is reserved — only `builtinManagedSessionsRule` (`../rules/
 * session-definition-type.ts`) ever constructs a `Rule` carrying it, and it
 * never appears in `rules.json`'s own loaded `rules[]` (a managed-session
 * agent "has no entry in `rules` at all", `herd.ts`'s own comment) — so this
 * check is airtight, not a guess.
 */
import { decodeAnyAgentKey, type ResourceProvider } from "../rules/agent-key.js";
import { MANAGED_SESSIONS_RULE_ID } from "../rules/session-definition-type.js";
import type { AgentDashboardRow, DashboardRow } from "./dashboard.js";

/** One rule's correlation identity — half of `RuleInventoryEntry`, kept narrow so a caller doesn't have to import the whole entry type just to match. */
export interface RuleCorrelationKey {
  id: string;
  resourceProvider: ResourceProvider;
}

/** One session definition's correlation identity — `undefined` for an oversized-path entry, which has no agent key and so can never match any row (see `SessionDefinitionListEntry.agentKey`'s own doc comment). */
export interface SessionDefinitionCorrelationKey {
  agentKey?: string;
}

/** Every LIVE (`kind: "agent"`) row matching this rule's `(resourceProvider, id)` pair — see this module's own top comment for the match rule. Never a withheld row: item 3 of the ticket asks a config entry to link to its "running agent row(s)", and `staffed`/`reason` already carry the admission-cap case. */
export function agentRowsForRule(rule: RuleCorrelationKey, rows: readonly DashboardRow[]): AgentDashboardRow[] {
  return rows.filter((row): row is AgentDashboardRow => {
    if (row.kind !== "agent") return false;
    const decoded = decodeAnyAgentKey(row.resourceKey);
    return decoded !== null && decoded.ruleId === rule.id && decoded.resourceProvider === rule.resourceProvider;
  });
}

/** Every live row whose `resourceKey` equals this session definition's own `agentKey` exactly — see this module's own top comment for why this is exact-match, not decode-and-compare. `[]` when the entry has no `agentKey` (the oversized-path case) — nothing to match. */
export function agentRowsForSessionDefinition(entry: SessionDefinitionCorrelationKey, rows: readonly DashboardRow[]): AgentDashboardRow[] {
  if (entry.agentKey === undefined) return [];
  return rows.filter((row): row is AgentDashboardRow => row.kind === "agent" && row.resourceKey === entry.agentKey);
}

/** Percent-encodes each part and joins with `--` — an HTML-id-safe, URL-fragment-safe token with no `:`/`/`/`#` of its own, so the SAME string is valid both as an `id="..."` attribute value and, prefixed with `#`, as an `href` fragment. */
const anchorToken = (...parts: string[]): string => parts.map(encodeURIComponent).join("--");

/** The `id` this agent row's own `<div>` carries on `/` (`dashboard-page.ts`) — what a config entry's forward link (`config-inventory-page.ts`) points at. One resourceKey, one row, one anchor: never shared across rows (same uniqueness `dashboard.ts`'s own `agentKeys` set already relies on). */
export const agentRowAnchorId = (resourceKey: string): string => `agent-${anchorToken(resourceKey)}`;

/** The `id` a rule's own row carries on the Configurations view. */
export const ruleAnchorId = (resourceProvider: ResourceProvider, ruleId: string): string => `rule-${anchorToken(resourceProvider, ruleId)}`;

/** The `id` a session definition's own row carries on the Configurations view — keyed on its `agentKey` (never its `name`/`path`, which are not the correlation identifier this module reuses elsewhere). */
export const sessionAnchorId = (agentKey: string): string => `session-${anchorToken(agentKey)}`;

/**
 * The Configurations-view anchor a running agent row's OWN back-link should
 * point at — `null` when `resourceKey` does not decode at all (nothing in
 * this daemon produces such a row today, but `decodeAnyAgentKey` is total,
 * so this function stays total too). See this module's own top comment for
 * why a managed session is told apart from an ordinary filesystem rule by
 * the reserved `MANAGED_SESSIONS_RULE_ID` sentinel alone, with no inventory
 * lookup — the whole point of this function existing separately from
 * `agentRowsForRule`/`agentRowsForSessionDefinition` above.
 */
export function configAnchorForResourceKey(resourceKey: string): string | null {
  const decoded = decodeAnyAgentKey(resourceKey);
  if (!decoded) return null;
  if (decoded.resourceProvider === "filesystem" && decoded.ruleId === MANAGED_SESSIONS_RULE_ID) {
    return sessionAnchorId(resourceKey);
  }
  return ruleAnchorId(decoded.resourceProvider, decoded.ruleId);
}
