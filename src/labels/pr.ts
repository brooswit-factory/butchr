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

interface PullPayload {
  state: string;
  merged: boolean;
  head: { ref: string };
}

async function fetchPull(deps: GithubDeps, ref: PrRef): Promise<PullPayload | null> {
  const res = await deps.fetchImpl(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, { headers: ghHeaders(deps.token) });
  if (!res.ok) return null;
  return (await res.json()) as PullPayload;
}

/** How many of a search's top hits to check for an exact head-ref match, per org, before giving up on it — GitHub's best-match sort gives no ordering guarantee between a ticket's own PR and a prefix-colliding one (e.g. a task's `KAN-790-ownwrites` branch vs. the story's own `KAN-790`), so the first hit alone isn't enough, but an unranked org-wide result set could in principle be large and each candidate costs a pulls fetch. */
const DISCOVER_CANDIDATES = 5;

/**
 * Searches GitHub for a PR whose head branch is EXACTLY `key`, within
 * `status` ("open" or "merged"), across the configured orgs. GitHub's
 * `head:` search qualifier matches by PREFIX — the search result shape
 * doesn't even carry `head.ref` — so each of the top `DISCOVER_CANDIDATES`
 * hits is confirmed against its own pull payload, in order, until one's head
 * ref is an exact match. A prefix-colliding hit (e.g. `KAN-790-ownwrites` for
 * key `KAN-790`) is skipped without caching anything, so a later exact-match
 * PR on the same key stays discoverable on a subsequent poll even if this
 * org never turns one up. The validated pull is returned alongside the ref
 * so the caller can reuse it instead of re-fetching.
 */
async function discover(deps: GithubDeps, key: string, status: "open" | "merged"): Promise<{ ref: PrRef; pull: PullPayload } | null> {
  for (const org of deps.orgs) {
    const q = new URLSearchParams({ q: `is:pr is:${status} head:${key} org:${org}` });
    const res = await deps.fetchImpl(`https://api.github.com/search/issues?${q}`, { headers: ghHeaders(deps.token) });
    if (!res.ok) continue;
    const body = (await res.json()) as { items?: Array<{ number: number; repository_url: string }> };
    for (const item of body.items?.slice(0, DISCOVER_CANDIDATES) ?? []) {
      const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(item.repository_url);
      if (!m) continue;
      const ref: PrRef = { owner: m[1]!, repo: m[2]!, number: item.number };
      const pull = await fetchPull(deps, ref);
      if (!pull || pull.head.ref !== key) continue; // prefix collision: not this ticket's PR
      return { ref, pull };
    }
  }
  return null;
}

async function fetchReviews(deps: GithubDeps, ref: PrRef): Promise<Review[]> {
  const res = await deps.fetchImpl(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, { headers: ghHeaders(deps.token) });
  if (!res.ok) return [];
  return (await res.json()) as Review[];
}

/**
 * Discovers the PR whose head branch is EXACTLY a ticket key (the fleet's
 * branch convention), then polls it directly once found — caching
 * owner/repo/number so discovery (an org-wide search) runs at most once per
 * key. `gh` and GraphQL are unavailable to the daemon; this is REST only.
 *
 * A cold cache (no ref cached, key not yet known merged) searches OPEN PRs
 * first; if that finds nothing, it ALSO searches MERGED PRs before giving up.
 * This is what makes pr:merged durable across a daemon restart: the `merged`
 * Set below is in-memory only and is lost on restart, but a merge is a fact
 * GitHub itself remembers, so re-discovering it there (rather than trusting
 * the ticket's own current pr:merged label as "sticky") can't latch a wrong
 * state the way the prefix-match bug did — it's re-verified against GitHub
 * every time the cache is cold, not merely re-asserted from prior output.
 */
export class PrTracker {
  private readonly cache = new Map<string, PrRef>();
  private readonly merged = new Set<string>();

  constructor(private readonly deps: GithubDeps) {}

  async stateFor(key: string): Promise<PrState> {
    if (this.merged.has(key)) return "merged"; // terminal: no further requests for this key, ever
    let ref = this.cache.get(key);
    let pull: PullPayload | null;
    if (ref) {
      pull = await fetchPull(this.deps, ref);
    } else {
      const found = (await discover(this.deps, key, "open")) ?? (await discover(this.deps, key, "merged"));
      if (!found) return null;
      ref = found.ref;
      pull = found.pull;
      this.cache.set(key, ref);
    }
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
