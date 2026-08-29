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
  createPage(p: { spaceId: string; title: string; body: string }): Promise<unknown>;
  getPage(id: string): Promise<unknown>;
  listSpaces(): Promise<unknown>;
}
