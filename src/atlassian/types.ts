export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  issuetype: string;
  assignee: string | null;
  parent: string | null;
  updated: string;
  labels: string[];
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
}
