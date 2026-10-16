import type { AgentCapacityRole } from "./admission.js";
import { decodeAnyAgentKey } from "../rules/agent-key.js";
import { isProjectId } from "../resources/id.js";

/**
 * FACTORY-757 (supersedes BUTCHR-422/FACTORY-39's issue-type hardcoding,
 * epic FACTORY-748): whether an agent counts toward `BUTCHR_MAX_AGENTS` is
 * decided SOLELY by its own rule's `role` field (via `ruleRoleOf`) — never
 * by the issue type of the ticket it is working. `role` already defaults
 * to `"worker"` (src/rules/rules.ts), so a rule silent on capacity is
 * counted: capacity is a per-query decision, made in the rules file, not a
 * Jira-issue-type special case layered on top of it. This is a deliberate
 * behaviour change for any `epics`/`stories`/`bugs`-shaped rule that relied
 * on the old hardcoding instead of setting `role: "sentinel"` itself — see
 * `docs/execution-modes.md`'s "Fleet capacity role" section.
 *
 * Two agent shapes are not rule-matched resources at all, so there is no
 * rule to ask for a `role` — both stay `"sentinel"` BY CONSTRUCTION, never
 * via `ruleRoleOf`, and this is the one piece of the old per-provider
 * special-casing that survives on purpose:
 * - A bare project-tier id (`isProjectId`, e.g. `BUTCHR`) — the project-wide
 *   agent, never produced by any rule's query match, so it has no rule to
 *   be driven by.
 * - Every `jira-project` agent (BUTCHR-425), regardless of its own rule's
 *   `role` — an operator-directed project manager, not an admission-capped
 *   worker; Codey runs dozens of them and none may ever consume
 *   `BUTCHR_MAX_AGENTS`. Keeping this as a construction-level exemption
 *   (rather than requiring every live `jira-project` rule to add
 *   `role: "sentinel"` itself) is what keeps this change migration-free,
 *   per this ticket's own definition of done.
 *
 * Everything else — every Jira work-item issue type (Epic, Story, Bug, Task,
 * Sub-task alike), every GitHub issue/PR, every Zendesk ticket, every
 * filesystem resource, every provider there is or ever will be — goes
 * through the exact same path: `ruleRoleOf(id) ?? "worker"`. No provider
 * branch, no issue-type lookup, one decision for every resource type.
 *
 * Fails safe: an id whose rule cannot be resolved (`ruleRoleOf` returns
 * `undefined` — a legacy/bare-issue agent, or a rule since removed) is a
 * worker. An agent is only ever released from the cap by its own rule's
 * explicit `role`, never by guessing from its ticket.
 */
export function capacityRoleFor(id: string, ruleRoleOf: (id: string) => AgentCapacityRole | undefined): AgentCapacityRole {
  if (isProjectId(id)) return "sentinel";
  if (decodeAnyAgentKey(id)?.resourceProvider === "jira-project") return "sentinel";
  return ruleRoleOf(id) ?? "worker";
}
