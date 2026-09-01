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
  /**
   * REPLACE `description` and/or `summary` — full-body replace of whichever
   * field(s) are supplied, never an append. Writes ONLY the field(s) passed
   * (same discipline `assign` above already documents for itself) — a
   * caller that wants to touch just one of the two must not see the other
   * disturbed. `correct_worker` (src/tools/relationship.ts) is the only
   * caller, and it always archives the CURRENT text as a comment before
   * calling this — this op itself does no archiving and no ownership check;
   * it is a dumb single write.
   */
  correctText(key: string, p: { description?: string; summary?: string }): Promise<unknown>;
  /** `parentId` nests the page under it; omitted, Confluence lands it under the space's own default (the SD homepage today). */
  createPage(p: { spaceId: string; title: string; body: string; parentId?: string }): Promise<unknown>;
  getPage(id: string): Promise<unknown>;
  /** Full-body replace. The op reads the page's current version internally and PUTs version.number + 1 — callers never hand-roll optimistic locking. */
  updatePage(p: { id: string; body: string; title?: string }): Promise<unknown>;
  /** Raw CQL search (CQL construction lives in the tool layer, defs.ts). */
  searchPages(cql: string, limit: number): Promise<unknown>;
  listSpaces(): Promise<unknown>;

  /**
   * Read a Jira PROJECT entity property (e.g. the `butchr` property carrying
   * this project's Confluence space + root doc). Rejects when the property
   * is missing or the project doesn't exist — callers turn that into a named
   * refusal rather than resolving to a guess (see src/tools/docs.ts).
   */
  getProjectProperty(projectKey: string, propertyKey: string): Promise<unknown>;

  /**
   * Read one remote issue link by its `globalId`. Resolves `null` when no
   * such link exists — the real impl converts Jira's 404 into `null` so
   * every caller has one "not found" shape instead of a try/catch each.
   */
  getRemoteLink(key: string, globalId: string): Promise<{ id?: number; relationship?: string; object?: { title?: string; url?: string } } | null>;

  /**
   * Create-or-update a remote issue link by `globalId` (idempotent: the same
   * `globalId` always resolves to the same link id, and the latest call's
   * `object` wins).
   */
  upsertRemoteLink(key: string, globalId: string, relationship: string, object: { title: string; url: string }): Promise<unknown>;

  /**
   * One page of a parent page's DIRECT children (a real Confluence v2 read,
   * cursor-paginated) — see src/tools/docs.ts for why this must never be
   * answered from a CQL search. `cursor` continues a prior page; `nextCursor`
   * is `undefined` once the caller has reached the end.
   */
  getChildPages(parentId: string, cursor?: string): Promise<{ results: Array<{ id: string; title?: string }>; nextCursor?: string }>;

  /** A page's label names, direct read (not CQL — same reasoning as getChildPages). */
  getPageLabels(pageId: string): Promise<string[]>;

  /**
   * Create a Confluence page WITH a label, atomically in one call. A
   * deliberately SEPARATE op from `createPage` (see atlassian-real.ts for
   * why) so that no existing caller of `createPage`/`confluence_create_page`
   * changes behavior. `spaceKey` (not `spaceId`) because the underlying v1
   * content API takes the space's key, not its numeric id.
   */
  createPageWithLabel(p: { spaceKey: string; parentId: string; title: string; body: string; label: string }): Promise<{ id: string; title: string; url: string }>;

  /**
   * Read-modify-write: unions `labels` into the issue's CURRENT label set and
   * writes the result back. NEVER removes an existing label — there is no
   * other way to set a label on an issue that already exists (labels can
   * otherwise only be set at creation), and a naive replace would silently
   * destroy whatever labels the ticket already carried (src/tools/relationship.ts,
   * shelve_worker).
   */
  addLabels(key: string, labels: readonly string[]): Promise<unknown>;

  /**
   * Delete a Jira issue outright — `new_worker`'s compensating rollback for a
   * ticket it just created a moment ago, when the Implements link or the
   * disposition write that must immediately follow it fails (src/tools/
   * relationship.ts). MEASURED against this daemon's own credential
   * (BUTCHR-35, 2026-08-31): `GET .../mypermissions?projectKey=BUTCHR&
   * permissions=DELETE_ISSUES` → 200, `{"havePermission":false}`; a live
   * create-then-delete round trip on a throwaway Epic → `DELETE
   * .../issue/BUTCHR-36` → 403, `{"errorMessages":["You do not have
   * permission to delete issues in this project."]}`. Called anyway — the
   * refusal is a PROJECT PERMISSION, not an API limitation, so granting
   * `Delete Issues` on this daemon's Atlassian account upgrades
   * `new_worker`'s rollback to fully working with NO CODE CHANGE. Every
   * caller of this op must already handle it failing.
   */
  deleteIssue(key: string): Promise<unknown>;
}
