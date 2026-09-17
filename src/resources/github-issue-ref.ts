/**
 * The `github-issue` provider's resource identity, dependency-free so the
 * agent key codec (src/rules/agent-key.ts) can import it without loading the
 * GitHub client.
 *
 * An issue is `owner/repo#number`, with owner and repo LOWERCASED: GitHub
 * resolves owner and repo names case-insensitively, so two spellings of one
 * issue must never become two agents. A renamed or transferred repository is
 * a new identity — nothing here follows redirects.
 */

/** GitHub login: alphanumerics and single inner hyphens, at most 39 characters. */
const OWNER_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
/** Repository name: alphanumerics, `.`, `_`, `-`, at most 100 characters, never `.` or `..`. */
const REPO_RE = /^[a-z0-9._-]{1,100}$/;
const NUMBER_RE = /^[1-9][0-9]{0,9}$/;

export interface GithubIssueRef { owner: string; repo: string; number: number }

export const isGithubOwner = (owner: string): boolean => OWNER_RE.test(owner);
export const isGithubRepo = (repo: string): boolean => REPO_RE.test(repo) && repo !== "." && repo !== "..";

/** True only for the canonical form `formatGithubIssueRef` produces. */
export function isGithubIssueRef(id: string): boolean {
  return parseGithubIssueRef(id) !== null;
}

export function formatGithubIssueRef(ref: GithubIssueRef): string {
  const id = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
  if (!isGithubIssueRef(id)) throw new Error(`invalid GitHub issue reference: ${JSON.stringify(id)}`);
  return id;
}

/** Inverse of `formatGithubIssueRef`; `null` for anything not in canonical form (including uppercase). */
export function parseGithubIssueRef(id: string): GithubIssueRef | null {
  const m = /^([^/#]+)\/([^/#]+)#([^/#]+)$/.exec(id);
  if (!m) return null;
  const [, owner, repo, number] = m as unknown as [string, string, string, string];
  if (!isGithubOwner(owner) || !isGithubRepo(repo) || !NUMBER_RE.test(number)) return null;
  return { owner, repo, number: Number(number) };
}
