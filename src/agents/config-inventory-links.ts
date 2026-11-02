/**
 * FACTORY-81 (story FACTORY-70, epic FACTORY-68) — the cross-link matching
 * between `QueryAgentInventory` entries (`./query-agent-inventory.ts`) and
 * `DashboardRow`s (`./dashboard.ts`), kept as small, pure, unit-testable
 * functions per that ticket's own requirement, reused by BOTH render
 * directions rather than each inventing its own half of the match:
 *
 *   - `src/web/config-inventory-page.ts` (the new Configurations view) uses
 *     `agentRowsForRule` to link a config entry FORWARD to its running agent
 *     row(s).
 *   - `src/web/dashboard-page.ts` (the existing agent view, additively) uses
 *     `configAnchorForResourceKey` to link a running agent row BACK to its
 *     config entry — deliberately WITHOUT taking the inventory as an input,
 *     so adding this back-link does not add an inventory build to `/`'s
 *     existing request path (`src/web/view.ts`'s own doc comment on that
 *     route). Both directions decode exactly one way — never a second,
 *     invented correlation format — per the FACTORY-72 Confluence doc's own
 *     "Correlation identifier — reused, not invented" section.
 *
 * A RULE matches an agent row when `decodeAnyAgentKey(row.resourceKey)`
 * yields the same `(resourceProvider, ruleId)` pair as the rule's own
 * `(resourceProvider, id)` — true for both an ordinary per-resource `swarm`
 * match (`kind: "resource"`) and a `singleton`/`persistent` rule's one
 * query-level agent (`kind: "query"`); this module never distinguishes the
 * two kinds itself; either any match is enough.
 */
import { decodeAnyAgentKey, type ResourceProvider } from "../rules/agent-key.js";
import type { AgentDashboardRow, DashboardRow } from "./dashboard.js";

/** One rule's correlation identity — half of `RuleInventoryEntry`, kept narrow so a caller doesn't have to import the whole entry type just to match. */
export interface RuleCorrelationKey {
  id: string;
  resourceProvider: ResourceProvider;
}

/** Every LIVE (`kind: "agent"`) row matching this rule's `(resourceProvider, id)` pair — see this module's own top comment for the match rule. Never a withheld row: item 3 of the ticket asks a config entry to link to its "running agent row(s)", and `staffed`/`reason` already carry the admission-cap case. */
export function agentRowsForRule(rule: RuleCorrelationKey, rows: readonly DashboardRow[]): AgentDashboardRow[] {
  return rows.filter((row): row is AgentDashboardRow => {
    if (row.kind !== "agent") return false;
    const decoded = decodeAnyAgentKey(row.resourceKey);
    return decoded !== null && decoded.ruleId === rule.id && decoded.resourceProvider === rule.resourceProvider;
  });
}

/** Percent-encodes each part and joins with `--` — an HTML-id-safe, URL-fragment-safe token with no `:`/`/`/`#` of its own, so the SAME string is valid both as an `id="..."` attribute value and, prefixed with `#`, as an `href` fragment. */
const anchorToken = (...parts: string[]): string => parts.map(encodeURIComponent).join("--");

/** The `id` this agent row's own `<div>` carries on `/` (`dashboard-page.ts`) — what a config entry's forward link (`config-inventory-page.ts`) points at. One resourceKey, one row, one anchor: never shared across rows (same uniqueness `dashboard.ts`'s own `agentKeys` set already relies on). */
export const agentRowAnchorId = (resourceKey: string): string => `agent-${anchorToken(resourceKey)}`;

/** The `id` a rule's own row carries on the Configurations view. */
export const ruleAnchorId = (resourceProvider: ResourceProvider, ruleId: string): string => `rule-${anchorToken(resourceProvider, ruleId)}`;

/**
 * The Configurations-view anchor a running agent row's OWN back-link should
 * point at: its rule's row — `null` when `resourceKey` does not decode at all
 * (nothing in this daemon produces such a row today, but `decodeAnyAgentKey`
 * is total, so this function stays total too). Takes no inventory — the
 * whole point of this function existing separately from `agentRowsForRule`
 * above (see this module's own top comment).
 */
export function configAnchorForResourceKey(resourceKey: string): string | null {
  const decoded = decodeAnyAgentKey(resourceKey);
  if (!decoded) return null;
  return ruleAnchorId(decoded.resourceProvider, decoded.ruleId);
}
