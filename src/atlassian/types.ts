export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  issuetype: string;
  assignee: string | null;
  parent: string | null;
  updated: string;
}

export interface IssueLink {
  type: string;         // e.g. "Relates", "Blocks"
  direction: "inward" | "outward";
  key: string;          // the OTHER issue's key
}
