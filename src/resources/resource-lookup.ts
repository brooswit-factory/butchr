/**
 * FACTORY-339 (implementing FACTORY-335, epic FACTORY-330): builds
 * `GET /resources/for-url`'s JSON body — url resolution (`url-to-resource.ts`)
 * PLUS the "which agents serve it" half, over the SAME poll-fed
 * `DashboardResponse.rows` `/dashboard` already serves (`../agents/
 * dashboard.ts`). No new I/O, no re-run query: this is exactly the "look up
 * the daemon's own live/known agent registry" match model the ticket rules
 * on, not a second one.
 *
 * WHY THE STAFFED-AGENT REGISTRY, NOT A LIVE QUERY — do not "optimize" this
 * into re-running each rule's query against the URL's resource: the daemon
 * already runs every rule's query on its own poll cadence and staffs one
 * agent per matching resource (`../rules/*-type.ts`); a per-request Jira/
 * GitHub/Zendesk call here would be slow, rate-limited by that provider, AND
 * would report matches this daemon isn't actually staffing (a rule that
 * matches the resource but hasn't been enabled, or a resource excluded by a
 * project allowlist) — exactly the false positive this endpoint's whole
 * consumer (Cleavr's terminal-open dropdown) must never show. `dashboard.rows`
 * is that live registry already: `../rules/agent-key.ts`'s `decodeAnyAgentKey`
 * recovers `(resourceProvider, ruleId, resourceId)` from every row's own
 * `resourceKey`, so a resource match here is by construction a resource this
 * daemon has ALREADY matched and (at least tried to) staff.
 *
 * `live` distinguishes a row this daemon is actually RUNNING right now
 * (`kind: "agent"`) from one it has matched but is currently withholding
 * (`kind: "withheld"`, the fleet-wide admission cap, BUTCHR-332) — both are
 * real agent keys in this daemon's registry, but only the former has a pane
 * to attach a terminal to.
 */
import { decodeAnyAgentKey } from "../rules/agent-key.js";
import type { DashboardRow } from "../agents/dashboard.js";
import { resolveUrlToResource, type UrlToResourceDeps, type ResourceIdentity } from "./url-to-resource.js";

export interface ResourceForUrlAgent {
  agentKey: string;
  ruleId: string;
  pane: string | null;
  live: boolean;
  /** Rule id + resource id — no title fetch (ticket's own wording); see `agentLabel` below for the exact join. */
  label: string;
}

export interface ResourcesForUrlResponse {
  url: string;
  canonicalUrl: string | null;
  resource: ResourceIdentity | null;
  agents: ResourceForUrlAgent[];
}

/** Rule id + resource id, joined the same way an agent key's own components are (`:`) — deliberately NOT `display-label.ts`'s `baseDisplayLabel` (which fetches nothing itself either, but combines short-id and rule id in the OTHER order, and special-cases managed sessions) — this is its own, narrower "no title fetch" format, not a second implementation of that one. */
const agentLabel = (ruleId: string, resourceId: string): string => `${ruleId}:${resourceId}`;

/**
 * Every dashboard row whose decoded agent key names exactly `resource` —
 * `"resource"`-kind keys only (a `"query"`-kind key, BUTCHR-397, has no
 * single `resourceId` to match against). Sorted by rule id, per the ticket's
 * own "deterministic" requirement — the dropdown's own render order must not
 * depend on this daemon's internal row order.
 */
function agentsForResource(rows: readonly DashboardRow[], resource: ResourceIdentity): ResourceForUrlAgent[] {
  const out: ResourceForUrlAgent[] = [];
  for (const row of rows) {
    const decoded = decodeAnyAgentKey(row.resourceKey);
    if (!decoded || decoded.kind !== "resource") continue;
    if (decoded.resourceProvider !== resource.provider || decoded.resourceId !== resource.id) continue;
    out.push({
      agentKey: row.resourceKey,
      ruleId: decoded.ruleId,
      pane: row.kind === "agent" ? row.pane : null,
      live: row.kind === "agent",
      label: agentLabel(decoded.ruleId, decoded.resourceId),
    });
  }
  return out.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

/**
 * The whole response. `agents` is `[]` both when `resource` is `null` and
 * when a resource resolved but nothing in `rows` matches it — the ticket's
 * own requirement that a caller (Cleavr) can tell "not a Butchr resource"
 * apart from "a Butchr resource with nothing running" ONLY by reading
 * `resource` itself, never by `agents.length` alone.
 */
export function buildResourcesForUrlResponse(url: string, deps: UrlToResourceDeps, rows: readonly DashboardRow[]): ResourcesForUrlResponse {
  const { canonicalUrl, resource } = resolveUrlToResource(url, deps);
  return {
    url,
    canonicalUrl,
    resource,
    agents: resource ? agentsForResource(rows, resource) : [],
  };
}
