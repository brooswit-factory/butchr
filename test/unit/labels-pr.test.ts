import { describe, expect, test } from "bun:test";
import { PrTracker, isApproved } from "../../src/labels/pr.js";

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
