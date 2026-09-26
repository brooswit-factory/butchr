/**
 * FACTORY-57 (implementing FACTORY-56, epic FACTORY-55): the `github-pr`
 * provider's resource identity.
 *
 * AMBIGUITY WITH `github-issue-ref.ts`, HANDLED DELIBERATELY: a GitHub pull
 * request and a GitHub issue share ONE per-repo number counter (a PR *is* an
 * issue, under GitHub's own data model, with extra fields) — so the bare
 * identity shape `owner/repo#number` is byte-for-byte identical for both,
 * and a string like `acme/widgets#12` alone cannot say which kind it names.
 * This module therefore does not reinvent that shape: `GithubPrRef` is
 * `GithubIssueRef` by another name, and every function here delegates
 * straight to `github-issue-ref.ts`'s own parse/format logic (unchanged by
 * this ticket — see that module's own header) rather than duplicating or
 * subtly diverging from it. The two are disambiguated one level up, never
 * here:
 *   - In a canonical `ResourceRef` string, the `github-issue:`/`github-pr:`
 *     PROVIDER PREFIX carries the distinction (`resource-ref.ts`) — nothing
 *     about the payload after the colon needs to.
 *   - In a GitHub web URL, the PATH carries it (`/issues/<n>` vs
 *     `/pull/<n>`) — `githubIssueRefFromUrl`/`githubPrRefFromUrl` (both
 *     already defined in `github-issue-ref.ts`, the latter since BUTCHR-429)
 *     are already mutually exclusive by construction.
 *   - Against GitHub's own REST API, the two are simply never the same live
 *     object under the same numeric identity read two ways: number 12 in a
 *     repo is either the issue or the PR, never both, so `GET /issues/12`
 *     and `GET /pulls/12` never both succeed for the same number pointing
 *     at genuinely different content — `github-pr.ts`'s client reads
 *     `/pulls/<n>` specifically, which 404s outright for a plain issue
 *     number, the same "wrong endpoint refuses" guarantee `github-issue.ts`
 *     gets from checking the reverse case's `pull_request` field.
 *
 * NEVER CHANGES HOW AN EXISTING `github-issue` REF PARSES: this module adds
 * new exports; it edits nothing in `github-issue-ref.ts` itself.
 */
import {
  formatGithubIssueRef,
  githubPrRefFromUrl as parseGithubPrRefFromUrl,
  isGithubIssueRef,
  parseGithubIssueRef,
  type GithubIssueRef,
} from "./github-issue-ref.js";

/** Same shape as `GithubIssueRef` — see this module's own header for why. */
export type GithubPrRef = GithubIssueRef;

/** True only for the canonical form `formatGithubPrRef` produces (identical charset rules to `isGithubIssueRef`). */
export const isGithubPrRef = (id: string): boolean => isGithubIssueRef(id);

export const formatGithubPrRef = (ref: GithubPrRef): string => formatGithubIssueRef(ref);

/** Inverse of `formatGithubPrRef`; `null` for anything not in canonical form (including uppercase). */
export const parseGithubPrRef = (id: string): GithubPrRef | null => parseGithubIssueRef(id);

/**
 * The pull request an `https://github.com/<owner>/<repo>/pull/<n>` web URL
 * names, or `null` for anything else (including an `/issues/<n>` URL) — a
 * thin, intent-documenting re-export of `github-issue-ref.ts`'s own
 * `githubPrRefFromUrl` (defined there since BUTCHR-429, alongside the issue
 * URL parser it is the deliberate twin of) so `github-pr`-specific code
 * never has to reach into `github-issue-ref.ts` directly to get it.
 */
export const githubPrRefFromUrl = parseGithubPrRefFromUrl;
