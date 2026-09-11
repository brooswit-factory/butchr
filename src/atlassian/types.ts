export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  issuetype: string;
  assignee: string | null;
  /**
   * Jira's NATIVE `parent` field — NOT this fleet's boss/worker relationship,
   * which is carried entirely by an `Implements` issue link instead (see
   * `issuelinks` below, and BUTCHR-169's own registry entry,
   * src/workspace/registry.ts's `PARENT`, for why this distinction matters:
   * this field is empirically null for every issue in this project's
   * hierarchy — scripts/migrate-links.ts documents the migration away from
   * it). Kept only because `mapIssue` (src/atlassian/client.ts) has always
   * read it and nothing else in this codebase currently needs it removed.
   */
  parent: string | null;
  updated: string;
  labels: string[];
  /**
   * BUTCHR-169: this issue's links, when the caller asked `search()` for
   * them (see that method's `fields` param) — OPTIONAL, not because a real
   * issue can lack the field, but because most existing fixtures across this
   * codebase's test suite predate this field and legitimately don't care
   * about it; treat `undefined` the same as `[]` (unknown, not "definitely
   * none"). Same flattened `{type, otherEnd, key}` shape `AtlassianClient
   * #links` already returns for the single-issue endpoint — see that type's
   * own doc comment for the inward/outward direction convention, which this
   * field's values obey identically.
   */
  issuelinks?: readonly IssueLink[];
  /**
   * BUTCHR-307: whether this issue is currently "asleep" (stood down) —
   * SYNTHETIC, never present on the raw Jira API response and never set by
   * `mapIssue` (src/atlassian/client.ts). Only `createIssueResourceType`'s
   * `discovery.search()` (src/resources/issue.ts) stamps this, once per
   * poll, from the in-memory stand-down registry (src/agents/stand-down.ts)
   * — the same "carry the flag on `T` itself" shape `ProjectResource`
   * (this file's sibling in src/resources/project.ts) already uses for its
   * own watermark, chosen here over widening `T` to a wrapper struct because
   * every other consumer of `JiraIssue` in this codebase (labels, workspace
   * building, parked/abandoned detection, every existing test fixture) can
   * and does ignore an extra optional field with zero changes required,
   * where a wrapper struct would have forced type changes at every one of
   * those call sites for a flag none of them need. `ISSUE_ACTIVATION.verdictFor`
   * (src/resources/issue.ts) reads this directly — a plain, synchronous
   * field read, keeping that function pure over `T` as `runResourceLoop`'s
   * two-pass correctness argument requires (src/daemon/loop.ts).
   */
  asleep?: boolean;
}

export interface IssueLink {
  type: string;         // e.g. "Relates", "Blocks"
  /**
   * The OTHER issue's role in the link, not this issue's. Jira's issueLinks
   * payload names the other end by ITS global role: on a boss issue (e.g. a
   * story), the linked implementer (a task) appears as `outwardIssue`;
   * symmetrically, on the implementer, the boss appears as `inwardIssue`.
   * Evidence (link id 10595, created via jira_link_issues(from=KAN-757,
   * to=KAN-759), i.e. KAN-757 implements KAN-759): GET .../KAN-759 (the boss)
   * returns {"outwardIssue":{"key":"KAN-757"}}; GET .../KAN-757 (the
   * implementer) returns {"inwardIssue":{"key":"KAN-759"}}. So `otherEnd:
   * "outward"` means the other end is the IMPLEMENTER side of the link.
   */
  otherEnd: "inward" | "outward";
  key: string;          // the OTHER issue's key
  /**
   * BUTCHR-200: the OTHER issue's status, when the payload carried it —
   * OPTIONAL, `undefined` meaning UNKNOWN, never "confirmed none", the same
   * discipline `JiraIssue.issuelinks` above already uses one level up.
   * MEASURED (BUTCHR-192, `GET /rest/api/3/search/jql` with the exact field
   * projection `AtlassianClient#search` uses): Jira hydrates
   * `{issuetype, priority, status, summary}` on both `inwardIssue` and
   * `outwardIssue` stubs — `labels` is NEVER among them, in either
   * direction, even when the far end demonstrably carries one (two live
   * samples, one with a non-empty `labels` on the far end) — so a consumer
   * that needs a label off the other end of a link cannot get it from this
   * stub and must fetch that issue directly. A caller reading a Done boss's
   * status off its own worker's inward stub (src/agents/abandoned.ts) is the
   * reason this field exists; every other existing consumer (`parked.ts`,
   * `jira-watch/routes.ts`'s `watchedKeys`, `resources/issue.ts`'s boss-key
   * lookup) reads only `type`/`otherEnd`/`key` and is unaffected by its
   * addition.
   */
  status?: string;
}

export interface JiraComment {
  id: string;
  body: string;      // ADF flattened to plain text
  created: string;
  /** The commenting account's email, or null if Jira didn't return one (e.g. a deactivated/anonymized user). */
  authorEmail: string | null;
}
