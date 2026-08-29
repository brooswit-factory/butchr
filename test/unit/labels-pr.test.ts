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
      { match: /pulls\/5$/, respond: () => ({ state: "open", merged: false }) },
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
      { match: /pulls\/5$/, respond: () => ({ state: "open", merged: false }) },
      { match: /pulls\/5\/reviews/, respond: () => [{ user: { login: "bob" }, state: "APPROVED" }] },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBe("approved");
  });
  test("merged -> pr:merged, and never polls that PR again", async () => {
    let pullCalls = 0;
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: searchHit("acme", "widgets", 5) },
      { match: /pulls\/5$/, respond: () => { pullCalls++; return { state: "closed", merged: true }; } },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme"] });
    expect(await tracker.stateFor("KAN-1")).toBe("merged");
    expect(await tracker.stateFor("KAN-1")).toBe("merged");
    expect(await tracker.stateFor("KAN-1")).toBe("merged");
    expect(pullCalls).toBe(1); // terminal: only the first call actually hits the network
  });
  test("closed unmerged is treated as no PR, and allows rediscovery", async () => {
    let searchCalls = 0;
    const { fetchImpl } = fakeFetch([
      { match: /search\/issues/, respond: () => { searchCalls++; return searchHit("acme", "widgets", 5)(); } },
      { match: /pulls\/5$/, respond: () => ({ state: "closed", merged: false }) },
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
      { match: /pulls\/9$/, respond: () => ({ state: "open", merged: false }) },
      { match: /pulls\/9\/reviews/, respond: () => [] },
    ]);
    const tracker = new PrTracker({ fetchImpl, orgs: ["acme", "other"] });
    expect(await tracker.stateFor("KAN-1")).toBe("open");
    expect(calls.some((u) => u.includes("acme"))).toBe(true);
    expect(calls.some((u) => u.includes("other"))).toBe(true);
  });
});
