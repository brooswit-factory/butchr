/**
 * FACTORY-7: the `jira-project` ResourceRef kind's identity — a bare Jira
 * project key. Reuses `isProjectId` (./id.ts), the same predicate the daemon
 * already uses to recognise a project id on the `x-issue` header (BUTCHR-62)
 * — NOT `src/resources/jira-project.ts`, which is a different concept
 * entirely (that module's `JiraProject`/`ProjectQuery` are the `jira-project`
 * RULE's discovery/query shape, for staffing one agent per matching project;
 * this module is only about a project's identity as a link TARGET or OWNER,
 * with no rule, agent, or live Jira call involved).
 *
 * Same case-folding rationale as `jira-work-item-ref.ts`: `PROJECT_ID_RE`
 * only matches already-uppercase input, so parsing upper-cases first.
 */
import { isProjectId } from "./id.js";

export interface JiraProjectRef {
  key: string;
}

export function isJiraProjectRef(key: string): boolean {
  return isProjectId(key);
}

export function parseJiraProjectRef(key: string): JiraProjectRef | null {
  const upper = key.toUpperCase();
  return isJiraProjectRef(upper) ? { key: upper } : null;
}

export function formatJiraProjectRef(ref: JiraProjectRef): string {
  const parsed = parseJiraProjectRef(ref.key);
  if (!parsed) throw new Error(`invalid jira-project reference: ${JSON.stringify(ref.key)}`);
  return parsed.key;
}
