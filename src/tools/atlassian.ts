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
   * The same read as `getProjectProperty`, with ONE difference: a genuine
   * NOT-FOUND (the property doesn't exist) resolves `null` instead of
   * rejecting — the same "one not-found shape instead of a try/catch each"
   * convention `getRemoteLink` already established below. Any OTHER
   * rejection (rate limit, timeout, permission change, …) still rejects —
   * this op narrows what counts as "not found", it does not swallow
   * everything.
   *
   * BUTCHR-67/BUTCHR-81's own reason for adding this alongside
   * `getProjectProperty` rather than changing that op's existing
   * throw-always contract: `src/tools/docs.ts`'s `projectRootDoc` already
   * depends on `getProjectProperty` throwing on ANY failure (it converts
   * every rejection into one "unreadable, refusing" error, by design,
   * regardless of cause) — narrowing that op's contract would be an
   * unaudited behaviour change to an existing, already-tested consumer.
   * `src/resources/project.ts`'s discovery is the one caller that actually
   * needs to tell "genuinely no property" (an activation answer — ineligible)
   * apart from "couldn't read it this poll" (must NOT be treated as an
   * activation answer at all — MEASURED, BUTCHR-81 2026-09-01: conflating
   * the two let one transient read failure demote a project to `inactive`,
   * which stops a running agent rather than merely skipping a wake), so
   * this op exists for that caller specifically rather than reshaping a
   * shared one.
   */
  getProjectPropertyOrNull(projectKey: string, propertyKey: string): Promise<unknown | null>;

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
   * Read-modify-write: the inverse of `addLabels` — removes `labels` from the
   * issue's CURRENT label set and writes the remainder back (there is no
   * subtractive endpoint; `editIssue`'s `fields.labels` always takes the
   * FULL desired array, same as `addLabels`). Removing a label the issue
   * does not carry is a no-op, not an error. A caller that already knows the
   * label isn't present (from a fetch it already made for another reason)
   * should skip calling this entirely rather than pay for a no-op write —
   * see `startWorker`/`finishWorker` in src/tools/relationship.ts, which do
   * exactly that with `assertOwnWorker`'s own fetch.
   */
  removeLabels(key: string, labels: readonly string[]): Promise<unknown>;

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

  /**
   * WHERE A RESOURCE SPEAKS, the write half (BUTCHR-62's naming, ruled on
   * BUTCHR-71): a Confluence FOOTER comment on a page — NOT an inline
   * comment (a separate Confluence concept/endpoint) and NOT a page-body
   * edit. `body` is storage-format XHTML, same representation the other
   * page ops already use (`createPage`/`updatePage`) — a caller passing
   * plain text must wrap it itself (e.g. `<p>…</p>`), same convention as
   * `confluence_create_page`.
   *
   * This is the PROJECT tier's counterpart to `addComment`: an issue speaks
   * on its own ticket (`addComment`), a project speaks on its own root doc
   * (this op) — see `src/tools/speak.ts`, the seam that dispatches between
   * the two. First built for `report_to_boss`/`ask_boss` from a project
   * caller (BUTCHR-71); `getPageComments` below is the read half, built
   * alongside it for BUTCHR-67's "root doc received a comment" wake event,
   * per the epic's explicit instruction to take both halves of one API
   * family rather than let two stories build two disagreeing ones.
   *
   * MEASURED live against this fleet's credential (BUTCHR-62, 2026-09-01):
   * `POST /wiki/api/v2/footer-comments` with `{pageId, body: {representation:
   * "storage", value}}` -> HTTP 201. Also measured: posting a comment does
   * NOT bump the page's own `version.number` (5 before, 5 after) — a
   * genuinely separate write surface from `updatePage`, not a variant of it.
   */
  commentOnPage(pageId: string, body: string): Promise<unknown>;

  /**
   * WHERE A RESOURCE SPEAKS, the read half — see `commentOnPage`. Lists a
   * page's FOOTER comments (not inline). MEASURED live: `GET
   * /wiki/api/v2/pages/{id}/footer-comments` -> HTTP 200. Not consumed by
   * anything in THIS ticket (report_to_boss/ask_boss only need the write
   * half) — built for BUTCHR-67, which needs it for the "the project's root
   * doc received a comment" wake event and will consume this rather than
   * building a second reader.
   */
  getPageComments(pageId: string): Promise<{ results: Array<{ id: string; body: string }> }>;

  /**
   * BUTCHR-67's DISCOVERY read: live Jira projects. NOT a second client —
   * added here per BUTCHR-62's instruction that a capability neither
   * existing client has gets ONE new method on this surface (the same way
   * `commentOnPage`/`getPageComments` were added for BUTCHR-71).
   *
   * MEASURED live (2026-09-01, this daemon's own credential): `GET
   * /rest/api/3/project/search?status=live` omits each project's `lead` key
   * ENTIRELY unless `expand=lead` is also requested — not `null`, ABSENT
   * (`"lead" in project` is false) — the ticket that specified this
   * endpoint did not mention `expand`. That distinction is load-bearing: a
   * filter reading `project.lead?.accountId` against an absent field
   * evaluates to `undefined` for every project and silently matches ZERO —
   * the exact same observable result a correctly-working filter given a
   * WRONG account id also produces. A "wrong id -> zero" control alone
   * cannot tell those two apart; it must be paired with a
   * "right id -> exactly the projects it leads" proof (both present in
   * src/resources/project.ts's own tests). The real impl always requests
   * `expand: "lead"` for exactly this reason.
   *
   * ALSO MEASURED: `leadAccountId` as a query param is silently ignored —
   * `status=live&leadAccountId=<bogus>` returns the SAME 9 projects as the
   * unfiltered call. So this op does no server-side lead filtering at all;
   * the caller (src/resources/project.ts) filters `values[].lead.accountId`
   * client side, deliberately, per that measurement.
   */
  searchProjects(status: "live" | "archived" | "deleted"): Promise<{ values: Array<{ key: string; name: string; lead?: { accountId?: string } }> }>;

  /**
   * The account this credential runs as — BUTCHR-67's answer to "the
   * configured user" for DISCOVERY's lead filter (`GET /rest/api/3/myself`).
   * Resolved live rather than hardcoded: MEASURED, this workspace's own
   * credential and its reviewer's each resolve to a DIFFERENT accountId
   * (the epic's tiers deliberately run as separate accounts) — a config
   * knob or a copied literal would be wrong on whichever daemon didn't
   * supply it.
   */
  getMyself(): Promise<{ accountId: string }>;

  /**
   * Full-value REPLACE of a Jira project entity property (there is no
   * partial/merge endpoint — same shape as `addLabels`/`removeLabels`'s
   * read-modify-write necessity, but here the read-modify-write lives in
   * the CALLER, src/resources/project.ts, not in this op, because the
   * caller already holds the just-read current value before deciding what
   * to merge). MEASURED live (2026-09-01, this daemon's own credential,
   * scratch key `butchr-81-probe` on the BUTCHR project, deleted after):
   * `PUT /rest/api/3/project/{key}/properties/{key}` -> HTTP 201, readable
   * back immediately, `DELETE` -> HTTP 204. Notably this succeeded on a
   * project this credential does NOT lead (BUTCHR is led by a different
   * fleet account) — property write is gated on Jira's Administer
   * Jira/Administer Projects permission, not on project leadership, so this
   * is NOT assumed to be available to every credential that might one day
   * run the project tier; re-verify on whichever one actually deploys this.
   *
   * BUTCHR-67's own use: the project resource type's WAKE WATERMARKS (last
   * root-doc version / comment id / per-epic comment id acted on) live
   * inside the existing `butchr` property's `wake` sub-key, written back
   * through this op — see src/resources/project.ts's `advanceProjectWatermark`.
   * Deliberately NOT a new page-body marker or a new property key: the
   * `butchr` property is already the project's one canonical durable-state
   * read discovery performs every poll, and `wake` is additive to the
   * existing `space`/`rootDoc`/`repos`/`archiveProject`/`scaffolded` fields
   * (never overwritten wholesale) precisely because those are owned by the
   * external scaffolding tool that provisions a project, not by this
   * daemon.
   */
  setProjectProperty(projectKey: string, propertyKey: string, value: unknown): Promise<unknown>;

  /**
   * BUTCHR-67's rule-1 poll, BATCHED: every eligible project's root-doc
   * version in ONE call rather than one `getPage` per project. MEASURED
   * live (BUTCHR-67 story, 2026-09-01): `GET /wiki/api/v2/pages?id=A&id=B&id=C`
   * -> HTTP 200 with each page's `version.number` populated — a real batching
   * win, unlike footer comments (see `getPageComments`'s doc comment for the
   * MEASURED trap: a batch-shaped footer-comments call returns a plausible,
   * WRONG count with no error — never batch that read, only this one).
   * Returns a plain id->version map; a ROOT DOC id this call doesn't return
   * a version for (e.g. deleted) is simply absent from the map, never a
   * thrown error — callers must treat absence as "unknown", not "version 0".
   */
  getPageVersions(pageIds: readonly string[]): Promise<Record<string, number>>;
}
