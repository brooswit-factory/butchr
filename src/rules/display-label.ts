/**
 * FACTORY-95 (implementing FACTORY-90, epic FACTORY-83): the herdr workspace
 * LABEL — a short, human-readable string computed from an agent key, wired
 * into `HerdrHerd` (src/agents/herd.ts) at spawn time and by
 * `relabelOwnedWorkspaces` for already-running workspaces. NEVER used for
 * ownership/reconcile matching — that stays keyed on the pane-cwd -> agent-key
 * derivation FACTORY-89 already moved `reap.ts`/residency-census onto (see
 * `agentIdOfWorkspacePath`, src/agents/workspace.ts) — a label is free text
 * that, after this ticket ships, is exactly the thing being CHANGED, so it
 * can never double as an identity source anywhere.
 *
 * NAMING SPEC (operator, verbatim — FACTORY-83's 2026-09-26T19:47Z comment,
 * which supersedes any older example): "for query resource agents, its the
 * resource ID of the resource they are associated with. Every provider
 * decides what that resource id is. For jira issues, its the issue id
 * (FACTORY-20). For directories, its the directory and parent directory
 * (brooswit-factory:rinth)."
 *
 * ONE METHOD PER PROVIDER, NOT A CENTRAL SWITCH (the ticket's own words):
 * every provider/rule-type module owns its OWN `*ShortDisplayId` function —
 * `jiraWorkShortDisplayId` (resource-type.ts), `jiraIdeaShortDisplayId`
 * (jira-idea-type.ts), `jiraProjectShortDisplayId` (jira-project-type.ts),
 * `filesystemShortDisplayId` (filesystem-type.ts), `managedSessionShortDisplayId`
 * (session-definition-type.ts), `githubIssueShortDisplayId`
 * (github-issue-type.ts), `githubPrShortDisplayId` (github-pr-type.ts), and
 * `zendeskTicketShortDisplayId` (zendesk-ticket-type.ts). `shortDisplayId`
 * below is NOT a second implementation of any of them — it is the one,
 * narrow DISPATCH from a decoded agent key's `resourceProvider` (plus the
 * one structural exception below) to the matching provider's own method.
 * Something has to know which method to call for a given provider; this is
 * that spot, and it must never grow provider-specific ID LOGIC of its own —
 * only routing.
 *
 * THE ONE STRUCTURAL EXCEPTION: a managed-session agent is, underneath, a
 * `filesystem`-provider resource (BUTCHR-407/BUTCHR-408) — but FACTORY-83
 * deliberately decided it gets its OWN short-id method
 * (`managedSessionShortDisplayId`) rather than the generic filesystem one,
 * because its parent directory is always the same fixed well-known
 * definitions root and naming it on every label would be noise (see that
 * function's own doc comment). The dispatch below tells the two apart by
 * RULE ID (`MANAGED_SESSIONS_RULE_ID`), never by provider alone.
 *
 * COMBINING WITH THE RULE ID: an ordinary resource agent displays as
 * `"<ruleId> · <shortId>"` (e.g. `"jira-work · FACTORY-51"`; rule id first so panes group by query when sorted, FACTORY-861) — a managed
 * session displays its bare short id alone (its rule id is the same reserved
 * literal for every session, so appending it would add noise, not
 * information), and a query-level agent (BUTCHR-397 singleton/persistent
 * rules, no single resource) has nothing to combine with and displays its
 * bare rule id.
 */
import { createHash } from "node:crypto";
import { decodeAnyAgentKey, type ResourceProvider } from "./agent-key.js";
import { jiraWorkShortDisplayId } from "./resource-type.js";
import { jiraIdeaShortDisplayId } from "./jira-idea-type.js";
import { jiraProjectShortDisplayId } from "./jira-project-type.js";
import { filesystemShortDisplayId } from "./filesystem-type.js";
import { managedSessionShortDisplayId, MANAGED_SESSIONS_RULE_ID } from "./session-definition-type.js";
import { githubIssueShortDisplayId } from "./github-issue-type.js";
import { githubPrShortDisplayId } from "./github-pr-type.js";
import { zendeskTicketShortDisplayId } from "./zendesk-ticket-type.js";
import { confluencePageShortDisplayId } from "./confluence-page-type.js";

/**
 * The one dispatch spot — see this module's own top comment for why this is
 * routing, not a second implementation of any provider's own logic. Exported
 * (FACTORY-118) for `src/agents/workspace.ts`'s own leaf-naming use, which
 * needs the BARE provider short id, never combined with the ruleId the way
 * `baseDisplayLabel` below combines it for a herdr LABEL — a workspace path
 * already carries the ruleId as its own separate directory segment (the
 * `<provider>/<ruleId>/<leaf>` shape), so appending it into the leaf too
 * would duplicate it.
 */
export function shortDisplayId(provider: ResourceProvider, ruleId: string, resourceId: string): string {
  if (provider === "filesystem" && ruleId === MANAGED_SESSIONS_RULE_ID) return managedSessionShortDisplayId(resourceId);
  switch (provider) {
    case "jira-work": return jiraWorkShortDisplayId(resourceId);
    case "jira-idea": return jiraIdeaShortDisplayId(resourceId);
    case "jira-project": return jiraProjectShortDisplayId(resourceId);
    case "filesystem": return filesystemShortDisplayId(resourceId);
    case "github-issue": return githubIssueShortDisplayId(resourceId);
    case "github-pr": return githubPrShortDisplayId(resourceId);
    case "zendesk-ticket": return zendeskTicketShortDisplayId(resourceId);
    case "confluence-page": return confluencePageShortDisplayId(resourceId);
  }
}

/**
 * The un-disambiguated label for one agent key. Never use this AS a
 * herdr-facing label — that must always go through `resolveDisplayLabels`'s
 * own collision resolution. Exported for two things: this module's own
 * tests exercising each provider's combination rule in isolation, and
 * `HerdrHerd.labelFor` (src/agents/herd.ts), which uses it purely to find
 * WHICH other already-running agents share a spawning key's own collision
 * group (never to label anything directly) — see that call site's own doc
 * comment (FACTORY-95 review fix) for why.
 */
export function baseDisplayLabel(agentKey: string): string {
  const decoded = decodeAnyAgentKey(agentKey);
  if (!decoded) return agentKey; // legacy/bare id — unchanged, pre-FACTORY-95 behaviour
  if (decoded.kind === "query") return decoded.ruleId;
  const shortId = shortDisplayId(decoded.resourceProvider, decoded.ruleId, decoded.resourceId);
  if (decoded.resourceProvider === "filesystem" && decoded.ruleId === MANAGED_SESSIONS_RULE_ID) return shortId;
  return `${decoded.ruleId} · ${shortId}`;
}

/**
 * Deterministic 6-hex-char suffix derived from the FULL agent key alone —
 * never from position, discovery order, or any other context — so it
 * reproduces identically whether computed at spawn time or at
 * relabel-in-place time, and across daemon restarts (FACTORY-90's own
 * "must be stable" requirement). Same "hash the exact key" mechanism
 * `nameFor` (src/agents/herd.ts) already uses for herdr's 32-char agent name
 * limit — a different consumer, the same reasoning.
 *
 * FACTORY-118 reuses this SAME function (not a second copy) for the
 * on-disk workspace DIRECTORY name's own collision suffix
 * (`src/agents/workspace.ts`'s `workspaceDirFor`) — the ticket's own
 * instruction is "reuse FACTORY-90's ... deterministic, logged collision
 * handling", and a directory's suffix and a label's suffix for the SAME key
 * are thus always byte-identical, which is a feature (an operator who
 * memorizes one recognizes the other) not a requirement this ticket had to
 * add. Exported for that reuse; still never a second, independent id source
 * — see this module's own top comment.
 */
export function collisionSuffix(agentKey: string): string {
  return createHash("sha256").update(agentKey).digest("hex").slice(0, 6);
}

/**
 * Resolves display labels for a SET of agent keys at once, deterministically
 * disambiguating any collision (FACTORY-90 requirement 2) — e.g. the same
 * `<parent>:<name>` reached under two different roots, or two query-level
 * rules from different providers that happen to share a rule id.
 *
 * Two keys whose `baseDisplayLabel` agrees keep ONE bare label between
 * them — the lexicographically SMALLEST agent key of the group, a tie-break
 * independent of call order, discovery order, or spawn order — and every
 * OTHER colliding key gets a `-<hash>` suffix derived from ITS OWN full key
 * (`collisionSuffix`).
 *
 * DETERMINISM ACROSS BOTH PATHS: pass the same set of currently-relevant
 * agent keys from the spawn path (this agent's own key plus every OTHER
 * currently-running key — `HerdrHerd.labelFor`, via `byIssue()`) and from
 * the relabel-in-place path (every currently-running owned key —
 * `HerdrHerd.relabelOwnedWorkspaces`) and this function reproduces the
 * identical mapping for any key present in both calls — the "same agent ->
 * same label both ways" requirement. It does NOT guarantee a label never
 * changes over time: adding or removing a colliding resource can shift the
 * tie-break for the keys in that group, which is exactly why
 * relabel-in-place must be (and is) safe to re-run.
 *
 * Every collision logs exactly ONE warning line naming every key in the
 * group — never once per key — so a fleet with one 5-way collision doesn't
 * spam 5 near-identical lines.
 */
export function resolveDisplayLabels(agentKeys: readonly string[], log?: (line: string) => void): Map<string, string> {
  const sorted = [...new Set(agentKeys)].sort();
  const groups = new Map<string, string[]>();
  for (const key of sorted) {
    const label = baseDisplayLabel(key);
    const g = groups.get(label);
    if (g) g.push(key);
    else groups.set(label, [key]);
  }
  const out = new Map<string, string>();
  for (const [label, keys] of groups) {
    if (keys.length === 1) { out.set(keys[0]!, label); continue; }
    log?.(`WARNING: [display-label] ${keys.length} agents collide on label ${JSON.stringify(label)}, disambiguating: ${keys.join(", ")}`);
    out.set(keys[0]!, label);
    for (const key of keys.slice(1)) out.set(key, `${label}-${collisionSuffix(key)}`);
  }
  return out;
}

/**
 * The herdr metadata field name butchr writes the full agent key under
 * (FACTORY-90's "preserve the full machine key as metadata" requirement),
 * and the `source` every such write is tagged with. Both are stable, chosen
 * once here so `HerdrHerd`'s two write sites (spawn, relabel-in-place) and
 * any future reader agree byte-for-byte.
 */
export const FULL_AGENT_KEY_METADATA_FIELD = "agentKey";
export const METADATA_SOURCE = "butchr";
