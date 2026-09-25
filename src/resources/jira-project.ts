import { isProjectId } from './id.js';
export interface JiraProject { id: string; key: string; name: string; leadAccountId?: string; archived?: boolean; }
export interface ProjectQuery { leadAccountId?: string; keys?: string[]; query?: string; }
/** Project search is not JQL. Explicit JSON avoids pretending Jira supports issue operators here. */
export function parseProjectQuery(text: string): ProjectQuery {
  let q: any;
  try { q = JSON.parse(text); } catch { throw new Error('jira-project query must be a JSON object'); }
  if (!q || Array.isArray(q) || typeof q !== 'object') throw new Error('jira-project query must be an object');
  for (const key of Object.keys(q)) if (!['leadAccountId','keys','query'].includes(key)) throw new Error(`Unknown jira-project query field: ${key}`);
  if (q.leadAccountId !== undefined && (typeof q.leadAccountId !== 'string' || !q.leadAccountId.trim())) throw new Error('leadAccountId must be non-empty (or "me")');
  if (q.query !== undefined && (typeof q.query !== 'string' || !q.query.trim())) throw new Error('query must be non-empty');
  if (q.keys !== undefined && (!Array.isArray(q.keys) || !q.keys.length || q.keys.some((k: unknown) => typeof k !== 'string' || !isProjectId(k)))) throw new Error('keys must be a non-empty list of project keys');
  return q;
}
