import type { PrState } from "./plan.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GithubDeps {
  fetchImpl: FetchLike;
  /** GitHub token, if configured (pr:* is skipped entirely when absent — see config.ts). */
  token?: string;
  /** Org logins to search; an unscoped search would span all of GitHub. */
  orgs: readonly string[];
}

interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

interface Review {
  user?: { login?: string };
  state: string;
}

const ghHeaders = (token: string | undefined): Record<string, string> => ({
  accept: "application/vnd.github+json",
  "user-agent": "butchr",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

/**
 * A reviewer's LATEST review that is APPROVED or CHANGES_REQUESTED decides
 * their vote (COMMENTED/PENDING are ignored). Approved iff at least one
 * reviewer's latest vote is APPROVED and none is an outstanding
 * CHANGES_REQUESTED. This is the REST equivalent of `reviewDecision ==
 * APPROVED`, computed without GraphQL. Reviews arrive oldest-first, so a
 * later entry for the same reviewer always overwrites their vote. Pure.
 */
export function isApproved(reviews: readonly Review[]): boolean {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") continue;
    latest.set(r.user?.login ?? "", r.state);
  }
  const votes = [...latest.values()];
  return votes.includes("APPROVED") && !votes.includes("CHANGES_REQUESTED");
}

/**
 * Three-way outcome over the same latest-vote map as `isApproved`, so a
 * changes-requested review is no longer folded into "open" and invisible to
 * the author (KAN-819/823) — the same deadlock `isApproved` exists to avoid,
 * with the opposite sign. An outstanding CHANGES_REQUESTED wins over any
 * APPROVED (the reviewer must re-approve before the PR is mergeable);
 * otherwise "approved" if at least one reviewer's latest vote is one;
 * otherwise "open". Kept as a SIBLING to `isApproved`, not folded into it, so
 * `isApproved`'s existing boolean signature and its callers/tests are
 * untouched. Pure.
 */
export function reviewState(reviews: readonly Review[]): "approved" | "changes-requested" | "open" {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") continue;
    latest.set(r.user?.login ?? "", r.state);
  }
  const votes = [...latest.values()];
  if (votes.includes("CHANGES_REQUESTED")) return "changes-requested";
  if (votes.includes("APPROVED")) return "approved";
  return "open";
}

async function discover(deps: GithubDeps, key: string): Promise<PrRef | null> {
  for (const org of deps.orgs) {
    const q = new URLSearchParams({ q: `is:pr is:open head:${key} org:${org}` });
    const res = await deps.fetchImpl(`https://api.github.com/search/issues?${q}`, { headers: ghHeaders(deps.token) });
    if (!res.ok) continue;
    const body = (await res.json()) as { items?: Array<{ number: number; repository_url: string }> };
    const item = body.items?.[0];
    if (!item) continue;
    const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(item.repository_url);
    if (!m) continue;
    return { owner: m[1]!, repo: m[2]!, number: item.number };
  }
  return null;
}

async function fetchPull(deps: GithubDeps, ref: PrRef): Promise<{ state: string; merged: boolean } | null> {
  const res = await deps.fetchImpl(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, { headers: ghHeaders(deps.token) });
  if (!res.ok) return null;
  return (await res.json()) as { state: string; merged: boolean };
}

async function fetchReviews(deps: GithubDeps, ref: PrRef): Promise<Review[]> {
  const res = await deps.fetchImpl(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, { headers: ghHeaders(deps.token) });
  if (!res.ok) return [];
  return (await res.json()) as Review[];
}

/**
 * Discovers the open PR whose head branch is a ticket key (the fleet's branch
 * convention), then polls it directly once found — caching owner/repo/number
 * so discovery (an org-wide search) runs at most once per key. `gh` and
 * GraphQL are unavailable to the daemon; this is REST only.
 */
export class PrTracker {
  private readonly cache = new Map<string, PrRef>();
  private readonly merged = new Set<string>();

  constructor(private readonly deps: GithubDeps) {}

  async stateFor(key: string): Promise<PrState> {
    if (this.merged.has(key)) return "merged"; // terminal: no further requests for this key, ever
    let ref = this.cache.get(key);
    if (!ref) {
      const found = await discover(this.deps, key);
      if (!found) return null;
      ref = found;
      this.cache.set(key, ref);
    }
    const pull = await fetchPull(this.deps, ref);
    if (!pull) return null;
    if (pull.merged) {
      this.merged.add(key);
      this.cache.delete(key);
      return "merged";
    }
    if (pull.state === "closed") {
      this.cache.delete(key); // closed unmerged: no PR, allow rediscovery
      return null;
    }
    const reviews = await fetchReviews(this.deps, ref);
    return reviewState(reviews);
  }
}
