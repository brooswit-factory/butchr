import type { PrLookup } from "./plan.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GithubDeps {
  fetchImpl: FetchLike;
  /** GitHub token, if configured (pr:* is skipped entirely when absent — see config.ts). */
  token?: string;
  /** Org logins to search; an unscoped search would span all of GitHub. */
  orgs: readonly string[];
  /** Injectable clock, so tests can drive negative-cache backoff and throttle timing without sleeping. Defaults to Date.now. */
  now?: () => number;
  /** Diagnostic line sink: a non-OK search response (KAN-824 item 4) and the per-poll search-count summary (item 5). Matches how sync.ts/stalled.ts are wired. */
  log?: (line: string) => void;
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

/**
 * "unavailable" (a non-OK response) is kept distinct from a genuine miss —
 * there is no such thing as a genuine miss here, only "got the payload" or
 * "could not look" (KAN-832/837 site 2). Callers must not treat the two the
 * same: a candidate confirmation during discovery skips the candidate either
 * way, but the WARM path (an already-cached ref) must surface "unavailable"
 * as "unknown", not as evidence the PR is gone.
 */
async function fetchPull(deps: GithubDeps, ref: PrRef): Promise<PullPayload | "unavailable"> {
  const res = await deps.fetchImpl(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, { headers: ghHeaders(deps.token) });
  if (!res.ok) return "unavailable";
  return (await res.json()) as PullPayload;
}

/** How many of a search's top hits to check for an exact head-ref match, per org, before giving up on it — GitHub's best-match sort gives no ordering guarantee between a ticket's own PR and a prefix-colliding one (e.g. a task's `KAN-790-ownwrites` branch vs. the story's own `KAN-790`), so the first hit alone isn't enough, but an unranked org-wide result set could in principle be large and each candidate costs a pulls fetch. */
const DISCOVER_CANDIDATES = 5;

/**
 * BACKOFF_MS[i] is the delay before a key with (i+1) consecutive misses may
 * be searched again, doubling 15s -> 30s -> 60s -> 120s and holding at the
 * cap thereafter (KAN-824). 120s, not the ~5min the epic first suggested,
 * because the cap IS the worst-case pr:none -> pr:open discovery latency,
 * and pr:open is the label that wakes the PR's author (KAN-819). At the cap,
 * 6 PR-less non-epic tickets x 2 orgs issue 12 searches per 120s round =
 * 6 searches/min steady state against a 30/min bucket — 5x headroom, and it
 * holds without assuming this daemon owns the whole bucket (the bucket is
 * per GitHub user, shared with `gh` and possibly a second daemon).
 */
const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000];

/**
 * How many search rounds apart the merged-search sweep reruns for a key,
 * after its first cold round. The merged search exists for exactly one
 * thing — KAN-814's restart-durability case, an already-merged PR whose
 * in-memory `merged` Set was lost on restart — so the first cold round must
 * still run it (a fresh process has no other way to learn a key is already
 * merged), but every round after that is pure waste unless a PR was both
 * opened and merged since the last sweep. Accepted edge: a PR opened and
 * merged entirely between two merged sweeps is picked up by the NEXT sweep,
 * not instantly — acceptable because the open->merged transition without an
 * intervening open poll is rare, and the sweep still runs at most 20 rounds
 * (a few minutes at the 120s cap) apart.
 */
const MERGED_SWEEP_EVERY_ROUNDS = 20;

/** Absent or unparseable X-RateLimit-Reset on a non-OK search response falls back to this fixed throttle (KAN-824 item 4). */
const THROTTLE_FALLBACK_MS = 60_000;

function parseIntHeader(v: string | null): number | undefined {
  if (v == null || v.trim() === "") return undefined; // Number("") is 0, not "absent" — guard it explicitly
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface SearchOutcome {
  found?: { ref: PrRef; pull: PullPayload };
  /**
   * A non-OK response was hit on one org's search. The caller must stop —
   * no further orgs or statuses are tried this round, this is not a miss
   * (the negative-cache backoff must not advance), and it must not be
   * latched as "no PR" (a 403 is not evidence of anything about the key).
   */
  nonOk?: { status: number; remaining: number | undefined; resetEpochSec: number | undefined };
}

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
 *
 * A non-OK response from any org aborts the whole call immediately (KAN-824
 * item 4: "back off rather than burn the rest of the window") — it does not
 * try the remaining orgs, and the caller must not treat it as a miss.
 */
async function discoverStatus(deps: GithubDeps, key: string, status: "open" | "merged", onSearch: (res: Response) => void): Promise<SearchOutcome> {
  for (const org of deps.orgs) {
    const q = new URLSearchParams({ q: `is:pr is:${status} head:${key} org:${org}` });
    const res = await deps.fetchImpl(`https://api.github.com/search/issues?${q}`, { headers: ghHeaders(deps.token) });
    onSearch(res);
    if (!res.ok) {
      return {
        nonOk: {
          status: res.status,
          remaining: parseIntHeader(res.headers.get("x-ratelimit-remaining")),
          resetEpochSec: parseIntHeader(res.headers.get("x-ratelimit-reset")),
        },
      };
    }
    const body = (await res.json()) as { items?: Array<{ number: number; repository_url: string }> };
    for (const item of body.items?.slice(0, DISCOVER_CANDIDATES) ?? []) {
      const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(item.repository_url);
      if (!m) continue;
      const ref: PrRef = { owner: m[1]!, repo: m[2]!, number: item.number };
      const pull = await fetchPull(deps, ref);
      if (pull === "unavailable" || pull.head.ref !== key) continue; // couldn't confirm this candidate, or it's a prefix collision: not this ticket's PR
      return { found: { ref, pull } };
    }
  }
  return {};
}

/**
 * "unavailable" is kept distinct from "no reviews" (KAN-832/837 site 3): an
 * empty array legitimately means "open, unreviewed", but a non-OK response
 * means we don't know that — falling through to `reviewState([]) === "open"`
 * would silently DOWNGRADE a possibly-approved PR. The caller must return
 * "unknown" here rather than treat the two the same.
 */
async function fetchReviews(deps: GithubDeps, ref: PrRef): Promise<Review[] | "unavailable"> {
  const res = await deps.fetchImpl(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, { headers: ghHeaders(deps.token) });
  if (!res.ok) return "unavailable";
  return (await res.json()) as Review[];
}

interface KeyState {
  /** Consecutive miss count for this key — indexes BACKOFF_MS (capped at its last entry). */
  misses: number;
  /** Epoch ms; this key is not searched again before this. */
  nextSearchAt: number;
  /** Completed cold search rounds for this key, this process — drives the merged-sweep cadence. */
  rounds: number;
}

/**
 * Discovers the PR whose head branch is EXACTLY a ticket key (the fleet's
 * branch convention), then polls it directly once found — caching
 * owner/repo/number so discovery (an org-wide search) runs at most once per
 * key while it's warm. `gh` and GraphQL are unavailable to the daemon; this
 * is REST only.
 *
 * A cold cache (no ref cached, key not yet known merged) searches OPEN PRs
 * first; if that finds nothing, it searches MERGED PRs too — but only on the
 * key's first cold round and then every MERGED_SWEEP_EVERY_ROUNDS rounds
 * (see that constant) rather than every round, and only when the open search
 * came back OK with no match (never after a non-OK response). This is what
 * makes pr:merged durable across a daemon restart: the `merged` Set below is
 * in-memory only and is lost on restart, but a merge is a fact GitHub itself
 * remembers, so re-discovering it there (rather than trusting the ticket's
 * own current pr:merged label as "sticky") can't latch a wrong state the way
 * the prefix-match bug did — it's re-verified against GitHub every time the
 * cache is cold, not merely re-asserted from prior output.
 *
 * A key with no PR is search load forever unless bounded (KAN-824): a MISS
 * (both searches that ran came back OK with no exact match) opens a
 * negative-cache backoff window (BACKOFF_MS) before the key is searched
 * again, cleared the instant the key is discovered. A non-OK response is
 * never a miss and never advances the backoff — instead it sets a
 * tracker-wide throttle (`throttledUntil`) during which NO key is searched,
 * so a 403 costs zero further searches and self-heals at GitHub's own reset
 * instead of burning the rest of the window.
 */
export class PrTracker {
  private readonly cache = new Map<string, PrRef>();
  private readonly merged = new Set<string>();
  private readonly keyState = new Map<string, KeyState>();
  /** Last-logged non-OK status per key, so a PERMANENT throttle logs once instead of once per poll (the `loggedFailure` pattern in src/labels/sync.ts); a status that actually changes for that key still gets its own line. */
  private readonly loggedStatus = new Map<string, number>();
  /** Tracker-wide: while now() < this, stateFor issues no searches for any key. */
  private throttledUntil = 0;
  private searchesThisPoll = 0;
  private lastRemaining: number | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: GithubDeps) {
    this.now = deps.now ?? Date.now;
  }

  private readonly onSearch = (res: Response): void => {
    this.searchesThisPoll++;
    const remaining = parseIntHeader(res.headers.get("x-ratelimit-remaining"));
    if (remaining !== undefined) this.lastRemaining = remaining;
  };

  private handleNonOk(key: string, outcome: NonNullable<SearchOutcome["nonOk"]>, now: number): void {
    const resetMs = outcome.resetEpochSec != null ? outcome.resetEpochSec * 1000 : undefined;
    // A forward floor, not a bare `?? fallback`: X-RateLimit-Reset is GitHub's absolute epoch
    // second, `now()` is the local clock, and a reset at or before `now` (clock skew, a 0/empty
    // header) must still degrade to the fixed fallback — trusting it unconditionally would set
    // an already-expired throttle, i.e. no throttle at all, silently (KAN-824 review, PR #83).
    this.throttledUntil = resetMs != null && resetMs > now ? resetMs : now + THROTTLE_FALLBACK_MS;
    if (this.loggedStatus.get(key) === outcome.status) return; // same key, same status: already logged
    this.loggedStatus.set(key, outcome.status);
    const remainingPart = outcome.remaining != null ? `remaining=${outcome.remaining}` : "remaining=absent";
    const resetPart = resetMs != null ? `reset=${new Date(resetMs).toISOString()}` : "reset=absent";
    this.deps.log?.(`[pr] ${key} search ${outcome.status}: ${remainingPart} ${resetPart}`);
  }

  async stateFor(key: string): Promise<PrLookup> {
    if (this.merged.has(key)) return "merged"; // terminal: no further requests for this key, ever
    let ref = this.cache.get(key);
    let pull: PullPayload | "unavailable";
    if (ref) {
      // WARM path (KAN-832/837 site 2): a 403/429/5xx/network blip on this
      // already-discovered PR's direct fetch is "could not look", not "gone" —
      // the cached ref stays valid and must NOT be evicted, so the next poll
      // resolves without re-searching.
      pull = await fetchPull(this.deps, ref);
    } else {
      const now = this.now();
      if (now < this.throttledUntil) return "unknown"; // tracker-wide throttle: no searches at all
      const ks = this.keyState.get(key);
      if (ks && now < ks.nextSearchAt) return "unknown"; // this key's own backoff hasn't elapsed

      const runMerged = !ks || ks.rounds === 0 || ks.rounds % MERGED_SWEEP_EVERY_ROUNDS === 0;

      const openOutcome = await discoverStatus(this.deps, key, "open", this.onSearch);
      if (openOutcome.nonOk) {
        this.handleNonOk(key, openOutcome.nonOk, now);
        return "unknown";
      }
      let found = openOutcome.found;
      if (!found && runMerged) {
        const mergedOutcome = await discoverStatus(this.deps, key, "merged", this.onSearch);
        if (mergedOutcome.nonOk) {
          this.handleNonOk(key, mergedOutcome.nonOk, now);
          return "unknown";
        }
        found = mergedOutcome.found;
      }

      if (!found) {
        // Genuine miss: both searches that ran came back OK with no exact match —
        // this IS evidence of absence, unlike every "unknown" return above.
        const misses = (ks?.misses ?? 0) + 1;
        const rounds = (ks?.rounds ?? 0) + 1;
        const delay = BACKOFF_MS[Math.min(misses - 1, BACKOFF_MS.length - 1)]!;
        this.keyState.set(key, { misses, rounds, nextSearchAt: now + delay });
        return null;
      }
      this.keyState.delete(key); // discovered: negative-cache state cleared
      ref = found.ref;
      pull = found.pull;
      this.cache.set(key, ref);
    }
    if (pull === "unavailable") return "unknown"; // site 2: cached ref left in place, see comment above
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
    // site 3: a could-not-fetch here would otherwise fall through to
    // reviewState([]) === "open", an active downgrade of a possibly-approved
    // PR. "unknown" preserves whatever is on the ticket instead.
    if (reviews === "unavailable") return "unknown";
    return reviewState(reviews);
  }

  /**
   * Poll boundary (KAN-824 item 5): logs and resets the searches issued
   * since the last call, so at rest (zero searches this poll) the journal
   * stays quiet and `journalctl --user -u butchr.service` shows the rate in
   * a minute instead of requiring it to be inferred. `remaining` is the
   * last-seen X-RateLimit-Remaining across any search this poll (from any
   * key, ok or non-ok), "?" if this process has never seen the header.
   */
  endPoll(): void {
    if (this.searchesThisPoll > 0) {
      this.deps.log?.(`[pr] searches=${this.searchesThisPoll} remaining=${this.lastRemaining ?? "?"}`);
    }
    this.searchesThisPoll = 0;
  }
}
