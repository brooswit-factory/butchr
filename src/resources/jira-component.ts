/**
 * FACTORY-990 (implementing story FACTORY-986, epic FACTORY-984): the
 * `jira-component` resource shape — a Jira component carries the same
 * label/url/identity shape every other provider's own resource interface
 * does (compare `ZendeskTicket`, `GithubPr`, `FilesystemResource` in their
 * sibling modules): a canonical `ref` (this provider's resource id, see
 * `jira-component-ref.ts`), a mutable display `name`, and a people-facing
 * `url`. Resident-agent identity (workspace directory, agent key) is NOT a
 * bespoke field here — exactly like every other provider, it is derived
 * generically from `ref` by the SHARED `encodeAgentKey`/`workspaceDirFor`
 * machinery (src/rules/agent-key.ts, src/agents/workspace.ts) once a later
 * story wires a rule/discovery layer on top of this identity. Nothing here
 * adds a second, bespoke identity mechanism.
 *
 * DELIBERATELY NO QUERY/SELECTOR TYPE (unlike `jira-project.ts`'s own
 * `ProjectQuery`/`parseProjectQuery`): the selector (project/names query,
 * regex namePattern) and its validation are explicitly OUT of scope for
 * this story (FACTORY-986) — that is story 2's job. `mapJiraComponent`
 * below is a pure, dependency-free mapping from a raw Jira API shape to
 * this resource — no live client, no search, no I/O — so a test (or a
 * later story's real client) can construct a `JiraComponent` from a fake
 * or real Jira response without duplicating the canonical-id logic.
 */
import { formatJiraComponentRef } from "./jira-component-ref.js";

export interface JiraComponent {
  /** Canonical `<PROJECT>:<id>` — this provider's resource id (see `jira-component-ref.ts`). */
  ref: string;
  /** Jira's own internal component id — THE stable key; never changes when the component is renamed. */
  id: string;
  /** The Jira project key the component belongs to. */
  project: string;
  /** Mutable display name — renaming the component changes this field, never `id` or `ref`. */
  name: string;
  /** The agent-interface URL, for people — never an API URL. */
  url: string;
}

/** The shape a Jira component list/get response item carries (REST API: `{ id, name, ... }`), narrowed to the fields this module needs. */
export interface JiraComponentApiItem {
  id?: unknown;
  name?: unknown;
}

/**
 * Maps one raw API item into a `JiraComponent`, scoped to `project` (the
 * endpoint that lists a project's components is itself project-scoped, so
 * the project key is supplied by the caller, not read off the item) and
 * `url` (the people-facing link the caller already knows how to build —
 * never guessed here). Throws when Jira's own stable `id` or display `name`
 * is missing or malformed — same "never silently synthesize an identity"
 * discipline as `mapGithubIssue`/`mapComment` (github-issue.ts) use for
 * their own required fields.
 */
export function mapJiraComponent(item: JiraComponentApiItem, project: string, url: string): JiraComponent {
  if (typeof item.id !== "string" || !item.id) throw new Error(`Jira component for project ${JSON.stringify(project)} is missing its id`);
  if (typeof item.name !== "string") throw new Error(`Jira component ${JSON.stringify(item.id)} for project ${JSON.stringify(project)} is missing its name`);
  return { ref: formatJiraComponentRef({ project, id: item.id }), id: item.id, project: project.toUpperCase(), name: item.name, url };
}
