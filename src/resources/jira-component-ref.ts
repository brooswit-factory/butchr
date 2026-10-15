/**
 * FACTORY-990 (implementing story FACTORY-986, epic FACTORY-984): the
 * `jira-component` provider's resource identity, dependency-free so the
 * agent key codec (src/rules/agent-key.ts) can import it without loading
 * the Jira client — same discipline as every other `*-ref.ts` leaf module
 * (jira-project-ref.ts, zendesk-ticket-ref.ts, github-issue-ref.ts).
 *
 * A component is `<PROJECT>:<id>`: a component id is only unique within one
 * Jira project, so the project key is part of the identity (same reasoning
 * as `zendesk-ticket-ref.ts`'s `<subdomain>#<id>`). CRITICALLY, `id` is
 * Jira's own internal component id (the stable field the REST API calls
 * `id`), never the component's `name` — a component can be renamed in Jira
 * without its id changing, and this ref's whole point is to survive that
 * rename unchanged (FACTORY-986 scope item (b)). The project segment
 * case-folds to uppercase, same rationale as `jira-project-ref.ts`.
 *
 * THIS STORY IS SCAFFOLDING ONLY (FACTORY-986/FACTORY-990): no selector, no
 * JQL, no rule wiring, no spawn — see `../rules/jira-component-type.ts` for
 * the one bit of identity plumbing ("does this agent key belong to this
 * provider") a later story's rule engine will build on, and that file's own
 * header for why it stops there.
 */
import { isProjectId } from "./id.js";

/** A Jira component's internal id: digits only (Jira's own REST shape), never empty, no leading zero. */
const COMPONENT_ID_RE = /^[1-9][0-9]*$/;

export interface JiraComponentRef {
  /** The Jira project key the component belongs to (uppercased canonical form). */
  project: string;
  /** Jira's own internal component id — THE stable key; never the component's (renameable) name. */
  id: string;
}

export const isJiraComponentId = (id: string): boolean => COMPONENT_ID_RE.test(id);

/** True only for the canonical form `formatJiraComponentRef` produces. */
export function isJiraComponentRef(id: string): boolean {
  return parseJiraComponentRef(id) !== null;
}

export function formatJiraComponentRef(ref: JiraComponentRef): string {
  const id = `${ref.project.toUpperCase()}:${ref.id}`;
  if (!isJiraComponentRef(id)) throw new Error(`invalid jira-component reference: ${JSON.stringify(id)}`);
  return id;
}

/**
 * Inverse of `formatJiraComponentRef`; `null` for anything not in canonical
 * form. The project segment case-folds to uppercase (so `"butchr:10000"`
 * parses the same as `"BUTCHR:10000"`), matching `parseJiraProjectRef`'s own
 * case-folding rationale; the component id segment does not case-fold (it
 * is already digits-only).
 */
export function parseJiraComponentRef(id: string): JiraComponentRef | null {
  const m = /^([^:]+):([^:]+)$/.exec(id);
  if (!m) return null;
  const [, rawProject, componentId] = m as unknown as [string, string, string];
  const project = rawProject.toUpperCase();
  if (!isProjectId(project) || !isJiraComponentId(componentId)) return null;
  return { project, id: componentId };
}
