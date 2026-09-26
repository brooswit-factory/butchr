import type { AgentCapacityRole } from "./admission.js";
import { decodeAnyAgentKey } from "../rules/agent-key.js";
import { isIssueKey, isProjectId } from "../resources/id.js";

/**
 * BUTCHR-422 (Brooswit, 2026-09-25; interim until query-based resources
 * replace these tiers): the fleet agent cap counts only LEAF work — Task
 * and Sub-task agents. Project agents, and Epic, Story and Bug agents, are
 * never counted toward `maxAgents` and never withheld.
 *
 * FACTORY-39 (FACTORY-37) moved Bug from the counted set to here: a Bug is
 * now a BOSS, the same tier as an Epic — it idles while its Stories run,
 * exactly like an Epic idles while its Stories run, so it must be exempt
 * from the cap the same way, or an idling Bug could hold a slot and cause
 * admission to withhold it at the cap. BUTCHR-422's original listing of Bug
 * as leaf work was correct only while a Bug fixed the code itself; it no
 * longer does.
 *
 * Built on BUTCHR-398's capacity role instead of a second admission
 * mechanism: an uncounted agent is classified `"sentinel"`, which admission
 * already leaves out of residency and never withholds. Keyed on the agent's
 * kind and its issue's type — NOT on a rule-file flag — so it applies to
 * every deployed daemon's existing rules with no config change.
 */
export const UNCOUNTED_ISSUE_TYPES: ReadonlySet<string> = new Set(["epic", "story", "bug"]);

const isUncountedIssueType = (issuetype: string | undefined): boolean =>
  issuetype !== undefined && UNCOUNTED_ISSUE_TYPES.has(issuetype.trim().toLowerCase());

/**
 * The capacity role of one running or candidate agent id.
 *
 * - A project-tier agent (its id is a bare project key, e.g. `BUTCHR`) →
 *   `"sentinel"`.
 * - An agent for a Jira issue whose type is Epic, Story or Bug → `"sentinel"`.
 *   This covers `jira-work` rule agents (`jira-work:<rule>:<KEY>`) and bare
 *   issue-key agents. The type comes from `issuetypeOf`, the daemon's own
 *   record of what its latest searches returned for that key.
 * - A `jira-project` rule agent (free-form Jira project resource, BUTCHR-425)
 *   → always `"sentinel"`, regardless of its rule's own `role` field. These
 *   are operator-directed project managers, not admission-capped workers —
 *   Codey runs dozens of them, and none may consume `BUTCHR_MAX_AGENTS`.
 *   Checked unconditionally (never falls through to `ruleRoleOf`) so a rule
 *   file that omits `role` entirely (every live `jira-project` rule does —
 *   see the deploy-hazard regression test) still never counts as a worker.
 * - Everything else keeps its rule's role (BUTCHR-398), via `ruleRoleOf`,
 *   defaulting to `"worker"`.
 *
 * Fails safe: an issue whose type is not (yet) known keeps its rule role or
 * `"worker"`. An agent is only released from the cap on positive evidence,
 * never by guessing.
 */
export function capacityRoleFor(
  id: string,
  ruleRoleOf: (id: string) => AgentCapacityRole | undefined,
  issuetypeOf: (issueKey: string) => string | undefined,
): AgentCapacityRole {
  if (isProjectId(id)) return "sentinel";
  if (isIssueKey(id)) return isUncountedIssueType(issuetypeOf(id)) ? "sentinel" : (ruleRoleOf(id) ?? "worker");
  const decoded = decodeAnyAgentKey(id);
  if (decoded?.resourceProvider === "jira-project") return "sentinel";
  if (decoded?.kind === "resource" && decoded.resourceProvider === "jira-work" && isUncountedIssueType(issuetypeOf(decoded.resourceId))) return "sentinel";
  return ruleRoleOf(id) ?? "worker";
}
