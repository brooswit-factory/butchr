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
      { match: /org%3Aacme|org:acme/, respond: () => null },
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
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: () => (exact ? searchHit("acme", "widgets", 70)() : searchHit("acme", "widgets", 66)()) },
      { match: /pulls\/66$/, respond: pull("open", false, "KAN-790-ownwrites") },
      { match: /pulls\/70$/, respond: pull("open", false, "KAN-790") },
      { match: /pulls\/70\/reviews/, respond: () => [] },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-790")).toBeNull(); // search hit is the task's PR (head KAN-790-ownwrites), not an exact match
    exact = true;
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
      { match: /is%3Aopen/, respond: () => null },
      { match: /is%3Amerged/, respond: searchHit("acme", "widgets", 66) },
      { match: /pulls\/66$/, respond: pull("closed", true, "KAN-1") },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBe("merged");
    expect(calls.filter((u) => u.includes("search/issues")).length).toBe(2); // open search tried first, then merged
  });

  test("a merged-search hit whose head ref is only a prefix collision still yields null, not a false merged", async () => {
    const { fetchImpl } = fakeFetch([
      { match: /is%3Aopen/, respond: () => null },
      { match: /is%3Amerged/, respond: searchHit("acme", "widgets", 66) },
      { match: /pulls\/66$/, respond: pull("closed", true, "KAN-790-ownwrites") },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-790")).toBeNull();
  });
});
