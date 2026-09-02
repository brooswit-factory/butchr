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
}

export interface JiraComment {
  id: string;
  body: string;      // ADF flattened to plain text
  created: string;
  /** The commenting account's email, or null if Jira didn't return one (e.g. a deactivated/anonymized user). */
  authorEmail: string | null;
}
