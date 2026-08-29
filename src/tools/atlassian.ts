/** What the tool layer needs from Atlassian. Faked in tests; real impl wraps jira.js/confluence.js. */
export interface AtlassianOps {
  getIssue(key: string): Promise<unknown>;
  search(jql: string, maxResults: number): Promise<unknown>;
  addComment(key: string, text: string): Promise<unknown>;
  linkIssues(from: string, to: string, type: string): Promise<unknown>;
  /** Transition by target status name (e.g. "In Review"). */
  transition(key: string, statusName: string): Promise<unknown>;
  createIssue(p: { projectKey: string; issuetype: string; summary: string; description?: string; parent?: string; labels?: string[]; assignee?: string; priority?: string }): Promise<unknown>;
  /** Set priority by name (e.g. "High"). */
  setPriority(key: string, priority: string): Promise<unknown>;
  /** Assign to an accountId. Never writes any other field. */
  assign(key: string, accountId: string): Promise<unknown>;
  /** `parentId` nests the page under it; omitted, Confluence lands it under the space's own default (the SD homepage today). */
  createPage(p: { spaceId: string; title: string; body: string; parentId?: string }): Promise<unknown>;
  getPage(id: string): Promise<unknown>;
  /** Full-body replace. The op reads the page's current version internally and PUTs version.number + 1 — callers never hand-roll optimistic locking. */
  updatePage(p: { id: string; body: string; title?: string }): Promise<unknown>;
  /** Raw CQL search (CQL construction lives in the tool layer, defs.ts). */
  searchPages(cql: string, limit: number): Promise<unknown>;
  listSpaces(): Promise<unknown>;
}
