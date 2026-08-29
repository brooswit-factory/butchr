import { describe, expect, test } from "bun:test";
import { PrTracker, isApproved, reviewState } from "../../src/labels/pr.js";

function fakeFetch(handlers: Array<{ match: RegExp; respond: () => unknown | null }>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url);
    for (const h of handlers) {
      if (h.match.test(url)) {
        const body = h.respond();
        if (body === null) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

const searchHit = (owner: string, repo: string, number: number) => () => ({
  items: [{ number, repository_url: `https://api.github.com/repos/${owner}/${repo}` }],
});

const searchHits = (owner: string, repo: string, numbers: number[]) => () => ({
  items: numbers.map((number) => ({ number, repository_url: `https://api.github.com/repos/${owner}/${repo}` })),
});

const pull = (state: string, merged: boolean, headRef: string) => () => ({ state, merged, head: { ref: headRef } });

describe("isApproved", () => {
  test("at least one APPROVED and no outstanding CHANGES_REQUESTED", () => {
    expect(isApproved([{ user: { login: "a" }, state: "APPROVED" }])).toBe(true);
  });
  test("an outstanding CHANGES_REQUESTED from another reviewer blocks approval", () => {
    expect(isApproved([
      { user: { login: "a" }, state: "APPROVED" },
      { user: { login: "b" }, state: "CHANGES_REQUESTED" },
    ])).toBe(false);
  });
  test("the same reviewer's later APPROVED supersedes an earlier CHANGES_REQUESTED", () => {
    expect(isApproved([
      { user: { login: "a" }, state: "CHANGES_REQUESTED" },
      { user: { login: "a" }, state: "APPROVED" },
    ])).toBe(true);
  });
  test("COMMENTED/PENDING are ignored entirely", () => {
    expect(isApproved([{ user: { login: "a" }, state: "COMMENTED" }])).toBe(false);
    expect(isApproved([])).toBe(false);
  });
});

describe("reviewState", () => {
  test("no votes at all -> open", () => {
    expect(reviewState([])).toBe("open");
    expect(reviewState([{ user: { login: "a" }, state: "COMMENTED" }])).toBe("open");
  });
  test("at least one APPROVED, no outstanding CHANGES_REQUESTED -> approved", () => {
    expect(reviewState([{ user: { login: "a" }, state: "APPROVED" }])).toBe("approved");
  });
  test("an outstanding CHANGES_REQUESTED -> changes-requested, even alongside another reviewer's APPROVED", () => {
    expect(reviewState([
      { user: { login: "a" }, state: "APPROVED" },
      { user: { login: "b" }, state: "CHANGES_REQUESTED" },
    ])).toBe("changes-requested");
  });
  test("a reviewer who requested changes and later re-approves resolves to approved", () => {
    expect(reviewState([
      { user: { login: "a" }, state: "CHANGES_REQUESTED" },
      { user: { login: "a" }, state: "APPROVED" },
    ])).toBe("approved");
  });
});

describe("PrTracker", () => {
  test("discovers, then polls directly — the search runs once, not every call", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { match: /search\/issues/, respond: searchHit("acme", "widgets", 5) },
      { match: /pulls\/5$/, respond: pull("open", false, "KAN-1") },
      { match: /pulls\/5\/reviews/, respond: () => [] },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBe("open");
    expect(await tracker.stateFor("KAN-1")).toBe("open");
    expect(calls.filter((u) => u.includes("search/issues")).length).toBe(1);
    expect(calls.filter((u) => u.includes("pulls/5") && !u.includes("reviews")).length).toBe(2);
  });
  test("approved once reviews resolve to an approval", async () => {
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: searchHit("acme", "widgets", 5) },
      { match: /pulls\/5$/, respond: pull("open", false, "KAN-1") },
      { match: /pulls\/5\/reviews/, respond: () => [{ user: { login: "bob" }, state: "APPROVED" }] },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBe("approved");
  });
  test("an outstanding CHANGES_REQUESTED resolves to changes-requested (KAN-819/823), not open", async () => {
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: searchHit("acme", "widgets", 5) },
      { match: /pulls\/5$/, respond: pull("open", false, "KAN-1") },
      { match: /pulls\/5\/reviews/, respond: () => [{ user: { login: "bob" }, state: "CHANGES_REQUESTED" }] },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBe("changes-requested");
  });
  // The one interaction neither KAN-814 nor KAN-819 could test on its own: a
  // prefix-colliding search hit is rejected by KAN-814's exact-head-ref
  // validation, discovery falls through to the PR whose head really is the
  // key, and THAT PR's outstanding CHANGES_REQUESTED then resolves through
  // KAN-819's reviewState — so the author of the right PR hears the right
  // review outcome. Get either half wrong and this returns "open" or null.
  test("a prefix-colliding hit is skipped by exact-ref validation, and the exact-ref PR's outstanding CHANGES_REQUESTED still resolves (KAN-814 + KAN-819)", async () => {
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: () => ({ items: [
        { number: 7, repository_url: "https://api.github.com/repos/acme/widgets" }, // KAN-1-ownwrites: prefix collision
        { number: 5, repository_url: "https://api.github.com/repos/acme/widgets" }, // the real KAN-1
      ] }) },
      { match: /pulls\/7$/, respond: pull("open", false, "KAN-1-ownwrites") },
      { match: /pulls\/5$/, respond: pull("open", false, "KAN-1") },
      { match: /pulls\/5\/reviews/, respond: () => [{ user: { login: "bob" }, state: "CHANGES_REQUESTED" }] },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBe("changes-requested");
  });
  test("merged -> pr:merged, and never polls that PR again", async () => {
    let pullCalls = 0;
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: searchHit("acme", "widgets", 5) },
      { match: /pulls\/5$/, respond: () => { pullCalls++; return pull("closed", true, "KAN-1")(); } },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBe("merged");
    expect(await tracker.stateFor("KAN-1")).toBe("merged");
    expect(await tracker.stateFor("KAN-1")).toBe("merged");
    expect(pullCalls).toBe(1); // terminal: only the first call actually hits the network (discovery's own validation fetch is reused, not repeated)
  });
  test("closed unmerged is treated as no PR, and allows rediscovery", async () => {
    let searchCalls = 0;
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: () => { searchCalls++; return searchHit("acme", "widgets", 5)(); } },
      { match: /pulls\/5$/, respond: pull("closed", false, "KAN-1") },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBeNull();
    expect(await tracker.stateFor("KAN-1")).toBeNull();
    expect(searchCalls).toBe(2); // dropped from cache, re-searched
  });
  test("no PR found for the key -> null, orgs searched in order", async () => {
    const { fetchImpl, calls } = fakeFetch([
      // GitHub's search API returns 200 with an empty items array for "no match" — never a 404 —
      // so that's what a genuine miss looks like here (KAN-824: a non-OK response means something else entirely).
      { match: /org%3Aacme|org:acme/, respond: () => ({ items: [] }) },
      { match: /org%3Aother|org:other/, respond: searchHit("other", "widgets", 9) },
      { match: /pulls\/9$/, respond: pull("open", false, "KAN-1") },
      { match: /pulls\/9\/reviews/, respond: () => [] },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme", "other"] });
    expect(await tracker.stateFor("KAN-1")).toBe("open");
    expect(calls.some((u) => u.includes("acme"))).toBe(true);
    expect(calls.some((u) => u.includes("other"))).toBe(true);
  });

  test("a prefix-colliding head ref (KAN-790-ownwrites for key KAN-790) is not cached; a later exact match on the same key is still discoverable", async () => {
    let exact = false;
    let now = 0;
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: () => (exact ? searchHit("acme", "widgets", 70)() : searchHit("acme", "widgets", 66)()) },
      { match: /pulls\/66$/, respond: pull("open", false, "KAN-790-ownwrites") },
      { match: /pulls\/70$/, respond: pull("open", false, "KAN-790") },
      { match: /pulls\/70\/reviews/, respond: () => [] },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"], now: () => now });
    expect(await tracker.stateFor("KAN-790")).toBeNull(); // search hit is the task's PR (head KAN-790-ownwrites), not an exact match
    exact = true;
    now = 15_000; // past the KAN-824 negative-cache backoff opened by the miss above
    expect(await tracker.stateFor("KAN-790")).toBe("open"); // a later poll's exact-head PR is discoverable — nothing was poisoned
  });

  test("a prefix-colliding hit sorted FIRST in the same org's results doesn't shadow an exact-head hit sorted second (KAN-814 review, PR #77)", async () => {
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: searchHits("acme", "widgets", [66, 70]) }, // collision (66, head KAN-790-ownwrites) sorts before the exact match (70, head KAN-790)
      { match: /pulls\/66$/, respond: pull("open", false, "KAN-790-ownwrites") },
      { match: /pulls\/70$/, respond: pull("open", false, "KAN-790") },
      { match: /pulls\/70\/reviews/, respond: () => [] },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-790")).toBe("open"); // resolves #70's state, not null
  });

  test("cold cache: open search finds nothing, merged search finds an exact-head hit -> 'merged' (restart durability)", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { match: /is%3Aopen/, respond: () => ({ items: [] }) },
      { match: /is%3Amerged/, respond: searchHit("acme", "widgets", 66) },
      { match: /pulls\/66$/, respond: pull("closed", true, "KAN-1") },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBe("merged");
    expect(calls.filter((u) => u.includes("search/issues")).length).toBe(2); // open search tried first, then merged
  });

  test("a merged-search hit whose head ref is only a prefix collision still yields null, not a false merged", async () => {
    const { fetchImpl } = fakeFetch([
      { match: /is%3Aopen/, respond: () => ({ items: [] }) },
      { match: /is%3Amerged/, respond: searchHit("acme", "widgets", 66) },
      { match: /pulls\/66$/, respond: pull("closed", true, "KAN-790-ownwrites") },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-790")).toBeNull();
  });

  // KAN-832/837 case 2 — the guard against overshooting into KAN-814-style stickiness:
  // an OK search that genuinely finds nothing is evidence of absence, not "could not look".
  test("a confirmed no-PR search (OK, zero exact-head matches, both orgs) still yields null", async () => {
    const { fetchImpl } = fakeFetch([{ match: /search\/issues/, respond: () => ({ items: [] }) }]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBeNull();
  });

  // KAN-832/837 case 9: closed-unmerged is genuine evidence of absence, not "could not look" —
  // must still strip and still allow rediscovery (already covered by name above at "closed
  // unmerged is treated as no PR, and allows rediscovery"; this asserts the same shape returns
  // null specifically alongside a merged=true sibling to guard against a careless `pull.merged ||
  // pull.state === "closed"` collapse that would return "unknown" for closed-unmerged too).
  test("closed unmerged yields null, distinctly from merged (case 9 guard)", async () => {
    const { fetchImpl: closedFetch } = fakeFetch([
      { match: /search\/issues/, respond: searchHit("acme", "widgets", 5) },
      { match: /pulls\/5$/, respond: pull("closed", false, "KAN-1") },
    ]);
    const closedTracker = new PrTracker({ fetchImpl: closedFetch, orgs: ["acme"] });
    expect(await closedTracker.stateFor("KAN-1")).toBeNull();

    const { fetchImpl: mergedFetch } = fakeFetch([
      { match: /search\/issues/, respond: searchHit("acme", "widgets", 5) },
      { match: /pulls\/5$/, respond: pull("closed", true, "KAN-1") },
    ]);
    const mergedTracker = new PrTracker({ fetchImpl: mergedFetch, orgs: ["acme"] });
    expect(await mergedTracker.stateFor("KAN-1")).toBe("merged");
  });

  // KAN-832/837 case 3: the throttle set by ONE key's 403 is tracker-wide — a DIFFERENT cold key
  // polled while it holds must also see "unknown", not null (the fleet-wide spurious-strip case
  // that makes this ticket High).
  test("a 403 on key A's search makes key B's next stateFor return 'unknown' (not null) while the tracker-wide throttle holds", async () => {
    let now = 0;
    const statusFetch = async (url: string): Promise<Response> => {
      if (/search\/issues/.test(url)) return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "5" } });
      return new Response("not found", { status: 404 });
    };
    const tracker = new PrTracker({ fetchImpl: statusFetch, orgs: ["acme"], now: () => now });

    expect(await tracker.stateFor("KAN-A")).toBe("unknown"); // A's own search 403s
    expect(await tracker.stateFor("KAN-B")).toBe("unknown"); // B never searched at all — tracker-wide throttle
  });

  // KAN-832/837 case 4: a key still inside its own negative-cache backoff window (KAN-824) is
  // "could not look" too — no search ran for it this poll.
  test("a key inside its own negative-cache backoff window yields 'unknown', not null", async () => {
    let now = 0;
    const { fetchImpl } = fakeFetch([{ match: /search\/issues/, respond: () => ({ items: [] }) }]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"], now: () => now });

    expect(await tracker.stateFor("KAN-1")).toBeNull(); // round 1: genuine miss, opens the 15s backoff
    now = 5_000; // still inside the 15s backoff window
    expect(await tracker.stateFor("KAN-1")).toBe("unknown"); // no search ran this poll: could not look
  });

  // KAN-832/837 case 5 (WARM path, site 2): a 403 on an already-discovered PR's direct fetch must
  // not evict the cached ref — the ref is still valid, only our view of it failed this poll.
  test("a cached-ref key whose /pulls/N fetch 403s yields 'unknown', and the cached ref is not evicted", async () => {
    let pullAttempts = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      if (/search\/issues/.test(url)) return new Response(JSON.stringify({ items: [{ number: 5, repository_url: "https://api.github.com/repos/acme/widgets" }] }), { status: 200 });
      if (/pulls\/5\/reviews/.test(url)) return new Response(JSON.stringify([]), { status: 200 });
      if (/pulls\/5$/.test(url)) {
        pullAttempts++;
        if (pullAttempts === 1) return new Response(JSON.stringify({ state: "open", merged: false, head: { ref: "KAN-1" } }), { status: 200 }); // discovery's own validation fetch
        if (pullAttempts === 2) return new Response("{}", { status: 403 }); // warm poll: could not look
        return new Response(JSON.stringify({ state: "open", merged: false, head: { ref: "KAN-1" } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    const searchAttempts = { n: 0 };
    const countingFetch = async (url: string): Promise<Response> => {
      if (/search\/issues/.test(url)) searchAttempts.n++;
      return fetchImpl(url);
    };
    const tracker = new PrTracker({ fetchImpl: countingFetch, orgs: ["acme"] });

    expect(await tracker.stateFor("KAN-1")).toBe("open"); // discovers and caches the ref
    expect(await tracker.stateFor("KAN-1")).toBe("unknown"); // warm poll's /pulls/5 403s
    expect(await tracker.stateFor("KAN-1")).toBe("open"); // next poll's /pulls/5 succeeds — ref was never evicted
    expect(searchAttempts.n).toBe(1); // no re-search was ever triggered by the 403
  });

  // KAN-832/837 case 6 (site 3): a failed reviews fetch must not silently downgrade to "open" —
  // that would be an active downgrade of a possibly-approved PR.
  test("fetchReviews non-OK on an open PR yields 'unknown', not 'open'", async () => {
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: searchHit("acme", "widgets", 5) },
      { match: /pulls\/5$/, respond: pull("open", false, "KAN-1") },
    ]);
    // fakeFetch's default handler falls through to 404 for the reviews endpoint since no handler matches it.
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBe("unknown");
  });

  // KAN-832/837 review (PR #89): a fourth site the fix missed — discoverStatus collapsed
  // "couldn't confirm this candidate" (fetchPull came back "unavailable") and "genuine prefix
  // collision" into the same continue, so an unconfirmed sole candidate fell all the way through
  // to the miss branch: null (a real label stripped) AND the negative-cache backoff advanced,
  // violating KAN-824's "a non-OK is never a miss and never advances the backoff".
  test("a cold key's only search hit fails its /pulls/N confirmation (403): yields 'unknown', not null, and does NOT advance the negative-cache backoff", async () => {
    let now = 0;
    let openPullAttempts = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      if (/is%3Aopen/.test(url)) return new Response(JSON.stringify({ items: [{ number: 5, repository_url: "https://api.github.com/repos/acme/widgets" }] }), { status: 200 });
      if (/is%3Amerged/.test(url)) return new Response(JSON.stringify({ items: [] }), { status: 200 }); // merged search: clean miss, contributes nothing
      if (/pulls\/5$/.test(url)) {
        openPullAttempts++;
        return new Response("{}", { status: 403 }); // the open search's sole candidate can never be confirmed
      }
      return new Response("not found", { status: 404 });
    };
    const searchAttempts = { n: 0 };
    const countingFetch = async (url: string): Promise<Response> => {
      if (/search\/issues/.test(url)) searchAttempts.n++;
      return fetchImpl(url);
    };
    const tracker = new PrTracker({ fetchImpl: countingFetch, orgs: ["acme"], now: () => now });

    expect(await tracker.stateFor("KAN-1")).toBe("unknown"); // round 1: sole candidate unconfirmed, no exact match — could not look, not a miss
    expect(openPullAttempts).toBe(1);
    const searchesAfterRound1 = searchAttempts.n;

    now = 1_000; // well inside what a 15s miss-backoff would have been, had one wrongly opened
    await tracker.stateFor("KAN-1");
    expect(searchAttempts.n).toBeGreaterThan(searchesAfterRound1); // a new search WAS issued — backoff never advanced
  });

  // An unconfirmed candidate must not shadow a LATER candidate that does match — the taint only
  // matters when nothing matched at all.
  test("an unconfirmed candidate followed by a later exact match still yields the match, not 'unknown'", async () => {
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: searchHits("acme", "widgets", [6, 5]) },
      { match: /pulls\/6$/, respond: () => null }, // 404: candidate 6 unconfirmed
      { match: /pulls\/5$/, respond: pull("open", false, "KAN-1") },
      { match: /pulls\/5\/reviews/, respond: () => [] },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBe("open");
  });
});

// KAN-824: bound pr:* discovery to GitHub's 30/min search budget — negative
// cache with backoff, throttle-aware non-OK handling, per-poll search count.
describe("PrTracker — KAN-824 search budget", () => {
  const miss = () => ({ items: [] }); // GitHub's real "no match": 200 OK, empty items — never a 404.

  test("a missed key is NOT re-searched on the immediately following poll (15s backoff)", async () => {
    let now = 0;
    const { fetchImpl, calls } = fakeFetch([{ match: /search\/issues/, respond: miss }]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"], now: () => now });
    const searchCalls = () => calls.filter((u) => u.includes("search/issues")).length;

    await tracker.stateFor("KAN-1"); // round 1: miss -> backoff opens, next allowed at 15s
    const after1 = searchCalls();
    expect(after1).toBeGreaterThan(0);

    now = 5_000; // less than the 15s backoff
    await tracker.stateFor("KAN-1");
    expect(searchCalls()).toBe(after1); // no new search issued
  });

  test("backoff doubles 15s -> 30s -> 60s -> 120s and caps at 120s", async () => {
    let now = 0;
    const { fetchImpl, calls } = fakeFetch([{ match: /search\/issues/, respond: miss }]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"], now: () => now });
    const searchCalls = () => calls.filter((u) => u.includes("search/issues")).length;

    await tracker.stateFor("KAN-1"); // round 1 (miss) -> next allowed at 15s
    const c1 = searchCalls();

    now = 14_999;
    await tracker.stateFor("KAN-1");
    expect(searchCalls()).toBe(c1); // still backing off, just under 15s

    now = 15_000;
    await tracker.stateFor("KAN-1"); // round 2 (miss) -> next allowed at 45s (15+30)
    const c2 = searchCalls();
    expect(c2).toBeGreaterThan(c1);

    now = 44_999;
    await tracker.stateFor("KAN-1");
    expect(searchCalls()).toBe(c2);

    now = 45_000;
    await tracker.stateFor("KAN-1"); // round 3 (miss) -> next allowed at 105s (45+60)
    const c3 = searchCalls();
    expect(c3).toBeGreaterThan(c2);

    now = 104_999;
    await tracker.stateFor("KAN-1");
    expect(searchCalls()).toBe(c3);

    now = 105_000;
    await tracker.stateFor("KAN-1"); // round 4 (miss) -> next allowed at 225s (105+120, cap reached)
    const c4 = searchCalls();
    expect(c4).toBeGreaterThan(c3);

    now = 224_999;
    await tracker.stateFor("KAN-1");
    expect(searchCalls()).toBe(c4);

    now = 225_000;
    await tracker.stateFor("KAN-1"); // round 5 (miss) -> still capped at 120s -> next allowed at 345s
    const c5 = searchCalls();
    expect(c5).toBeGreaterThan(c4);

    now = 344_999;
    await tracker.stateFor("KAN-1");
    expect(searchCalls()).toBe(c5); // capped, not growing beyond 120s
  });

  test("the merged search runs on the first cold round for a key and NOT on the second", async () => {
    let now = 0;
    const { fetchImpl, calls } = fakeFetch([{ match: /search\/issues/, respond: miss }]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"], now: () => now });

    await tracker.stateFor("KAN-1"); // round 1: open AND merged (both miss)
    expect(calls.filter((u) => u.includes("is%3Aopen")).length).toBe(1);
    expect(calls.filter((u) => u.includes("is%3Amerged")).length).toBe(1);

    now = 15_000;
    await tracker.stateFor("KAN-1"); // round 2: open only, no merged sweep
    expect(calls.filter((u) => u.includes("is%3Aopen")).length).toBe(2);
    expect(calls.filter((u) => u.includes("is%3Amerged")).length).toBe(1); // unchanged
  });

  test("6 PR-less non-epic tickets at the 120s backoff cap issue 12 searches per 120s window (2 orgs each) = 6/min steady state", async () => {
    let now = 0;
    const { fetchImpl, calls } = fakeFetch([{ match: /search\/issues/, respond: miss }]);
    const keys = ["KAN-1", "KAN-2", "KAN-3", "KAN-4", "KAN-5", "KAN-6"];
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme", "other"], now: () => now });
    const searchCalls = () => calls.filter((u) => u.includes("search/issues")).length;

    // Drive every key through its 4 cold rounds (0, 15s, 45s, 105s) to reach the 120s cap.
    for (const t of [0, 15_000, 45_000, 105_000]) {
      now = t;
      for (const k of keys) await tracker.stateFor(k);
    }
    // Every key's next round is now at 105_000 + 120_000 = 225_000 — all in lockstep at the cap.
    const before = searchCalls();

    // A clean 120s window at the cap, polled at the daemon's real 15s cadence (8 polls).
    for (let poll = 0; poll < 8; poll++) {
      now = 225_000 + poll * 15_000;
      for (const k of keys) await tracker.stateFor(k);
    }
    const searched = searchCalls() - before;
    expect(searched).toBe(12); // 6 tickets x 2 orgs, exactly one round (open-only: round index 4, not a multiple of 20) falls inside the window
  });

  // The story ticket's original estimate for this test was 48 (4 rounds x 12, treating every
  // round as open-only). That undercounts: the FIRST cold round also runs the merged sweep
  // (KAN-814 restart durability), doubling that round's cost to 24 (12 open + 12 merged) for 6
  // tickets x 2 orgs. Correct hard upper bound for the four rounds inside the first 120s:
  // round 1 = 24 (open+merged), rounds 2-4 = 12 each (open only) = 24 + 12*3 = 60. Still a large
  // reduction from the 192 unconditional-every-15s-poll cost this replaces (192 = 8 polls x 6
  // tickets x 2 orgs x 2 open+merged — the ~96/min the ticket measured). Flagged on KAN-830.
  test("6 PR-less non-epic tickets from cold issue at most 60 searches in the first 120s (4 backoff rounds: round 1 also runs the merged sweep), vs. 192 before this change", async () => {
    let now = 0;
    const { fetchImpl, calls } = fakeFetch([{ match: /search\/issues/, respond: miss }]);
    const keys = ["KAN-1", "KAN-2", "KAN-3", "KAN-4", "KAN-5", "KAN-6"];
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme", "other"], now: () => now });

    for (let poll = 0; poll < 8; poll++) { // 8 polls at the daemon's real 15s cadence = the first 120s
      now = poll * 15_000;
      for (const k of keys) await tracker.stateFor(k);
    }
    const searched = calls.filter((u) => u.includes("search/issues")).length;
    expect(searched).toBeLessThanOrEqual(60); // hard upper bound, not an exact count — the merged-sweep policy can shift without breaking this
    expect(searched).toBeLessThan(192); // 192 = 8 polls x 6 tickets x 2 orgs x 2 (open+merged), unconditional, before this change
  });

  test("a 403 logs exactly once for that (key, status), does not poison the negative cache, suppresses further searches until the reset, and a search after the reset happens", async () => {
    let now = 0;
    const resetEpochSec = 5; // now=0 -> resetMs=5000
    let searchAttempts = 0;
    const statusFetch = async (url: string): Promise<Response> => {
      if (/search\/issues/.test(url)) {
        searchAttempts++;
        if (searchAttempts === 1) {
          return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpochSec) } });
        }
        return new Response(JSON.stringify({ items: [{ number: 5, repository_url: "https://api.github.com/repos/acme/widgets" }] }), { status: 200 });
      }
      if (/pulls\/5\/reviews/.test(url)) return new Response(JSON.stringify([]), { status: 200 });
      if (/pulls\/5$/.test(url)) return new Response(JSON.stringify({ state: "open", merged: false, head: { ref: "KAN-1" } }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const logs: string[] = [];
    const tracker = new PrTracker({ fetchImpl: statusFetch, orgs: ["acme"], now: () => now, log: (l) => logs.push(l) });

    expect(await tracker.stateFor("KAN-1")).toBe("unknown"); // throttled: cannot discover yet
    expect(logs.filter((l) => l.includes("KAN-1") && l.includes("403")).length).toBe(1);

    expect(await tracker.stateFor("KAN-1")).toBe("unknown"); // still throttled, same tick — no new search, no new log
    expect(searchAttempts).toBe(1);
    expect(logs.filter((l) => l.includes("KAN-1") && l.includes("403")).length).toBe(1);

    now = resetEpochSec * 1000 + 1; // past the reset
    expect(await tracker.stateFor("KAN-1")).toBe("open"); // negative cache was never poisoned: discovers normally
    expect(searchAttempts).toBe(2);
  });

  // KAN-824 review (PR #83): throttledUntil trusted X-RateLimit-Reset with no forward floor, so a
  // past reset (clock skew, or a reset right at a window boundary) silently disabled the throttle
  // entirely — the exact "silence in the journal is the defect" failure this ticket exists to fix,
  // reintroduced one layer up. Fixed by clamping to the 60s fallback whenever resetMs <= now.
  test("a 403 whose x-ratelimit-reset is in the PAST still suppresses the next poll's searches (a forward floor, not a bare fallback)", async () => {
    let now = 10_000;
    const pastResetEpochSec = 5; // resetMs = 5_000, already before `now` = 10_000
    let searchAttempts = 0;
    const statusFetch = async (url: string): Promise<Response> => {
      if (/search\/issues/.test(url)) {
        searchAttempts++;
        return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(pastResetEpochSec) } });
      }
      return new Response("not found", { status: 404 });
    };
    const tracker = new PrTracker({ fetchImpl: statusFetch, orgs: ["acme"], now: () => now });

    expect(await tracker.stateFor("KAN-1")).toBe("unknown"); // 403 with an already-past reset
    expect(searchAttempts).toBe(1);

    now = 10_001; // the very next poll — a bare `resetMs ?? fallback` would NOT be throttled here
    expect(await tracker.stateFor("KAN-1")).toBe("unknown");
    expect(searchAttempts).toBe(1); // still suppressed: no new search issued

    now = 10_000 + 60_000 - 1; // just before the 60s fallback throttle elapses
    expect(await tracker.stateFor("KAN-1")).toBe("unknown");
    expect(searchAttempts).toBe(1);

    now = 10_000 + 60_000; // fallback throttle elapsed: searches resume
    await tracker.stateFor("KAN-1");
    expect(searchAttempts).toBe(2);
  });

  // The nit that makes the above reachable in practice: Number("") is 0, and Number.isFinite(0) is
  // true, so an empty x-ratelimit-reset header used to parse as the number zero rather than absent.
  test("an empty x-ratelimit-reset header parses as absent, not zero — falls back to the 60s throttle instead of disabling it", async () => {
    let now = 10_000;
    let searchAttempts = 0;
    const statusFetch = async (url: string): Promise<Response> => {
      if (/search\/issues/.test(url)) {
        searchAttempts++;
        return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "" } });
      }
      return new Response("not found", { status: 404 });
    };
    const tracker = new PrTracker({ fetchImpl: statusFetch, orgs: ["acme"], now: () => now });

    expect(await tracker.stateFor("KAN-1")).toBe("unknown");
    expect(searchAttempts).toBe(1);

    now = 10_001; // an empty header must not act as resetMs=0, i.e. "already elapsed" — no new search
    expect(await tracker.stateFor("KAN-1")).toBe("unknown");
    expect(searchAttempts).toBe(1);
  });

  test("a 403 followed by a different status (500) for the same key logs a second line", async () => {
    let now = 0;
    let attempts = 0;
    const statusFetch = async (url: string): Promise<Response> => {
      if (/search\/issues/.test(url)) {
        attempts++;
        if (attempts === 1) return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" } });
        return new Response("{}", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    };
    const logs: string[] = [];
    const tracker = new PrTracker({ fetchImpl: statusFetch, orgs: ["acme"], now: () => now, log: (l) => logs.push(l) });

    await tracker.stateFor("KAN-1"); // 403
    expect(logs.filter((l) => l.includes("KAN-1")).length).toBe(1);

    now = 1_001; // past the 403's reset (1s)
    await tracker.stateFor("KAN-1"); // 500: a different status for the same key
    expect(logs.filter((l) => l.includes("KAN-1")).length).toBe(2);
  });

  test("[pr] searches=N remaining=R is emitted when N > 0 and NOT emitted on a poll with zero searches", async () => {
    const logs: string[] = [];
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: searchHit("acme", "widgets", 5) },
      { match: /pulls\/5$/, respond: pull("open", false, "KAN-1") },
      { match: /pulls\/5\/reviews/, respond: () => [] },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"], log: (l) => logs.push(l) });

    await tracker.stateFor("KAN-1"); // discovers via one search
    tracker.endPoll();
    expect(logs.some((l) => l.startsWith("[pr] searches=1 remaining="))).toBe(true);

    logs.length = 0;
    await tracker.stateFor("KAN-1"); // cached ref now: zero searches this poll
    tracker.endPoll();
    expect(logs.length).toBe(0);
  });
});
