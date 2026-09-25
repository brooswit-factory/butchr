import type { AgentCapacityRole } from "./admission.js";
import { decodeAnyAgentKey } from "../rules/agent-key.js";
import { isIssueKey, isProjectId } from "../resources/id.js";

/**
 * BUTCHR-422 (Brooswit, 2026-09-25; interim until query-based resources
 * replace these tiers): the fleet agent cap counts only LEAF work — Task,
 * Sub-task and Bug agents. Project agents, and Epic and Story agents, are
 * never counted toward `maxAgents` and never withheld.
 *
 * Built on BUTCHR-398's capacity role instead of a second admission
 * mechanism: an uncounted agent is classified `"sentinel"`, which admission
 * already leaves out of residency and never withholds. Keyed on the agent's
 * kind and its issue's type — NOT on a rule-file flag — so it applies to
 * every deployed daemon's existing rules with no config change.
 */
export const UNCOUNTED_ISSUE_TYPES: ReadonlySet<string> = new Set(["epic", "story"]);

const isUncountedIssueType = (issuetype: string | undefined): boolean =>
  issuetype !== undefined && UNCOUNTED_ISSUE_TYPES.has(issuetype.trim().toLowerCase());

/**
 * The capacity role of one running or candidate agent id.
 *
 * - A project-tier agent (its id is a bare project key, e.g. `BUTCHR`) →
 *   `"sentinel"`.
 * - An agent for a Jira issue whose type is Epic or Story → `"sentinel"`.
 *   This covers `jira-work` rule agents (`jira-work:<rule>:<KEY>`) and bare
 *   issue-key agents. The type comes from `issuetypeOf`, the daemon's own
 *   record of what its latest searches returned for that key.
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
  if (decoded?.kind === "resource" && decoded.resourceProvider === "jira-work" && isUncountedIssueType(issuetypeOf(decoded.resourceId))) return "sentinel";
  return ruleRoleOf(id) ?? "worker";
}
