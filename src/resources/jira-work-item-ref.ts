/**
 * FACTORY-7: the `jira-work-item` ResourceRef kind's identity — a bare Jira
 * issue key. Deliberately reuses `isIssueKey` (./id.ts) rather than a new
 * regex: that module already documents which of this codebase's two
 * disagreeing issue-key regexes is the "is this shaped like an issue key at
 * all" one (the permissive, EXPORTED `JIRA_KEY_RE`), and a link identity
 * question is exactly that question, not the daemon poll loop's narrower one.
 *
 * CASE-FOLDING, BY DESIGN: `isIssueKey`/`JIRA_KEY_RE` only ever matches an
 * already-uppercase key, so `parseJiraWorkItemRef` upper-cases its input
 * BEFORE validating — a lowercase or mixed-case key is accepted, not
 * rejected, and always canonicalizes to the same uppercase form. This is the
 * "case-folding Jira keys" dedup rule `docs/resource-links.md` decides on:
 * two spellings of one issue key must never become two links.
 */
import { isIssueKey } from "./id.js";

export interface JiraWorkItemRef {
  key: string;
}

/** True only for the canonical (uppercase) form `formatJiraWorkItemRef` produces. */
export function isJiraWorkItemRef(key: string): boolean {
  return isIssueKey(key);
}

/** Case-folds `key` and validates it; `null` for anything not shaped like a Jira issue key (never throws). */
export function parseJiraWorkItemRef(key: string): JiraWorkItemRef | null {
  const upper = key.toUpperCase();
  return isJiraWorkItemRef(upper) ? { key: upper } : null;
}

export function formatJiraWorkItemRef(ref: JiraWorkItemRef): string {
  const parsed = parseJiraWorkItemRef(ref.key);
  if (!parsed) throw new Error(`invalid jira-work-item reference: ${JSON.stringify(ref.key)}`);
  return parsed.key;
}
