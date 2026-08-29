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
  direction: "inward" | "outward";
  key: string;          // the OTHER issue's key
}

export interface JiraComment {
  id: string;
  body: string;      // ADF flattened to plain text
  created: string;
}
