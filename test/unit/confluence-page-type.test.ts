import { describe, expect, test } from "bun:test";
import {
  confluencePageShortDisplayId,
  createConfluencePageResourceType,
  createConfluencePageTypeEventRules,
  MAX_CHILD_PAGES,
  ownsConfluencePageAgent,
  searchConfluencePageRules,
  specForConfluencePage,
  specForConfluencePageQuery,
  type ConfluencePageMatch,
  type ConfluencePageResourceDeps,
} from "../../src/rules/confluence-page-type.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";
import type { ConfluencePageSnapshot } from "../../src/resources/confluence-page.js";
import type { Rule } from "../../src/rules/rules.js";
import { runResourceLoop } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";
import type { NotifyReason } from "../../src/resources/types.js";

function rule(over: Partial<Rule> & { id: string; query: string }): Rule {
  return { enabled: true, resourceProvider: "confluence-page", brief: "Work this child page.", execution: "swarm", account: "none", role: "worker", ...over };
}

function page(over: Partial<ConfluencePageSnapshot> & { id: string }): ConfluencePageSnapshot {
  return { version: 1, commentIds: [], ...over };
}

describe("searchConfluencePageRules — discovery: real child-page enumeration", () => {
  test("one rule, one page of children: each child becomes a match keyed by the real encoded agent key", async () => {
    const r = rule({ id: "docs", query: JSON.stringify({ ancestor: "100" }) });
    const deps: Pick<ConfluencePageResourceDeps, "rules" | "getChildPages" | "getPageVersions" | "getPageComments"> = {
      rules: [r],
      getChildPages: async (parentId) => {
        expect(parentId).toBe("100");
        return { results: [{ id: "200", title: "A" }, { id: "201", title: "B" }] };
      },
      getPageVersions: async (ids) => Object.fromEntries(ids.map((id) => [id, 1])),
      getPageComments: async () => ({ results: [] }),
    };
    const matches = await searchConfluencePageRules(deps);
    expect(matches.length).toBe(2);
    expect(matches.map((m) => m.agentKey).sort()).toEqual([
      encodeAgentKey({ resourceProvider: "confluence-page", ruleId: "docs", resourceId: "200" }),
      encodeAgentKey({ resourceProvider: "confluence-page", ruleId: "docs", resourceId: "201" }),
    ].sort());
    expect(matches.find((m) => m.page.id === "200")?.page.title).toBe("A");
  });

  test("pagination: getChildPages is paged to exhaustion via nextCursor, never just the first page", async () => {
    const r = rule({ id: "docs", query: JSON.stringify({ ancestor: "100" }) });
    const calls: Array<string | undefined> = [];
    const deps: Pick<ConfluencePageResourceDeps, "rules" | "getChildPages" | "getPageVersions" | "getPageComments"> = {
      rules: [r],
      getChildPages: async (_parentId, cursor) => {
        calls.push(cursor);
        if (!cursor) return { results: [{ id: "1" }], nextCursor: "c2" };
        if (cursor === "c2") return { results: [{ id: "2" }], nextCursor: "c3" };
        return { results: [{ id: "3" }] }; // no nextCursor: done
      },
      getPageVersions: async (ids) => Object.fromEntries(ids.map((id) => [id, 1])),
      getPageComments: async () => ({ results: [] }),
    };
    const matches = await searchConfluencePageRules(deps);
    expect(calls).toEqual([undefined, "c2", "c3"]);
    expect(matches.map((m) => m.page.id).sort()).toEqual(["1", "2", "3"]);
  });

  test("crossing MAX_CHILD_PAGES rejects the whole rule's poll, never a truncated list", async () => {
    const r = rule({ id: "docs", query: JSON.stringify({ ancestor: "100" }) });
    const deps: Pick<ConfluencePageResourceDeps, "rules" | "getChildPages" | "getPageVersions" | "getPageComments"> = {
      rules: [r],
      getChildPages: async (_parentId, cursor) => {
        const n = cursor ? Number(cursor) : 0;
        return { results: [{ id: `p${n}` }], nextCursor: String(n + 1) };
      },
      getPageVersions: async (ids) => Object.fromEntries(ids.map((id) => [id, 1])),
      getPageComments: async () => ({ results: [] }),
    };
    await expect(searchConfluencePageRules(deps)).rejects.toThrow(new RegExp(`over ${MAX_CHILD_PAGES} child pages`));
  });

  test("a child page missing from getPageVersions' response is dropped, not fatal", async () => {
    const r = rule({ id: "docs", query: JSON.stringify({ ancestor: "100" }) });
    const deps: Pick<ConfluencePageResourceDeps, "rules" | "getChildPages" | "getPageVersions" | "getPageComments"> = {
      rules: [r],
      getChildPages: async () => ({ results: [{ id: "200" }, { id: "201" }] }),
      getPageVersions: async () => ({ "200": 1 }), // 201 missing: unreadable this tick
      getPageComments: async () => ({ results: [] }),
    };
    const matches = await searchConfluencePageRules(deps);
    expect(matches.map((m) => m.page.id)).toEqual(["200"]);
  });

  test("a child page whose getPageComments call throws is dropped, not fatal, and does not affect sibling pages", async () => {
    const r = rule({ id: "docs", query: JSON.stringify({ ancestor: "100" }) });
    const deps: Pick<ConfluencePageResourceDeps, "rules" | "getChildPages" | "getPageVersions" | "getPageComments"> = {
      rules: [r],
      getChildPages: async () => ({ results: [{ id: "200" }, { id: "201" }] }),
      getPageVersions: async (ids) => Object.fromEntries(ids.map((id) => [id, 1])),
      getPageComments: async (id) => {
        if (id === "201") throw new Error("boom");
        return { results: [] };
      },
    };
    const matches = await searchConfluencePageRules(deps);
    expect(matches.map((m) => m.page.id)).toEqual(["200"]);
  });

  test("a disabled rule, or a rule of another provider, is never searched", async () => {
    const enabledOther = rule({ id: "other", resourceProvider: "jira-work" as Rule["resourceProvider"], query: "q" });
    const disabled = rule({ id: "disabled", query: JSON.stringify({ ancestor: "999" }), enabled: false });
    let called = false;
    const deps: Pick<ConfluencePageResourceDeps, "rules" | "getChildPages" | "getPageVersions" | "getPageComments"> = {
      rules: [enabledOther, disabled],
      getChildPages: async () => { called = true; return { results: [] }; },
      getPageVersions: async () => ({}),
      getPageComments: async () => ({ results: [] }),
    };
    const matches = await searchConfluencePageRules(deps);
    expect(matches).toEqual([]);
    expect(called).toBe(false);
  });

  test("two rules naming the same child page produce two distinct agent keys, never colliding", async () => {
    const r1 = rule({ id: "rule1", query: JSON.stringify({ ancestor: "100" }) });
    const r2 = rule({ id: "rule2", query: JSON.stringify({ ancestor: "200" }) });
    const deps: Pick<ConfluencePageResourceDeps, "rules" | "getChildPages" | "getPageVersions" | "getPageComments"> = {
      rules: [r1, r2],
      getChildPages: async () => ({ results: [{ id: "500" }] }), // same child under both ancestors
      getPageVersions: async (ids) => Object.fromEntries(ids.map((id) => [id, 1])),
      getPageComments: async () => ({ results: [] }),
    };
    const matches = await searchConfluencePageRules(deps);
    expect(matches.length).toBe(2);
    expect(new Set(matches.map((m) => m.agentKey)).size).toBe(2);
  });
});

describe("resource id shape — the matched child's own bare numeric Confluence page id", () => {
  test("encodeAgentKey accepts a confluence-page resource id and round-trips it", () => {
    const key = encodeAgentKey({ resourceProvider: "confluence-page", ruleId: "docs", resourceId: "123456" });
    expect(key).toBe("confluence-page:docs:123456");
  });

  test("a non-numeric resourceId is rejected by encodeAgentKey (the same contract isConfluencePageResourceId enforces everywhere else)", () => {
    expect(() => encodeAgentKey({ resourceProvider: "confluence-page", ruleId: "docs", resourceId: "not-a-page-id" })).toThrow();
  });
});

describe("ownsConfluencePageAgent / confluencePageShortDisplayId", () => {
  test("recognises a resource key and a query-level key for this provider, and no other provider's", () => {
    expect(ownsConfluencePageAgent(encodeAgentKey({ resourceProvider: "confluence-page", ruleId: "docs", resourceId: "1" }))).toBe(true);
    expect(ownsConfluencePageAgent(encodeQueryAgentKey({ resourceProvider: "confluence-page", ruleId: "docs" }))).toBe(true);
    expect(ownsConfluencePageAgent(encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/a" }))).toBe(false);
  });

  test("the short display id is the bare page id, unchanged", () => {
    expect(confluencePageShortDisplayId("123456")).toBe("123456");
  });
});

describe("brief mechanism (design decision (b)): spec.brief is always the rule's own fixed text, never the page's content", () => {
  test("specForConfluencePage never substitutes the page's own title/content into brief", () => {
    const r = rule({ id: "docs", query: JSON.stringify({ ancestor: "100" }) });
    const match: ConfluencePageMatch = { agentKey: "confluence-page:docs:200", rule: r, page: page({ id: "200", title: "Some real page title" }) };
    const spec = specForConfluencePage(match);
    expect(spec.brief).toBe(r.brief);
    expect(spec.brief).not.toContain("Some real page title");
    expect(spec.resource).toBe("200");
    expect(spec.issuetype).toBe("confluence-page");
    expect(spec.summary).toBe("Some real page title");
  });

  test("specForConfluencePageQuery (singleton/persistent) also uses the rule's own brief, with no single resource", () => {
    const r = rule({ id: "docs", query: JSON.stringify({ ancestor: "100" }), execution: "persistent" });
    const key = encodeQueryAgentKey({ resourceProvider: "confluence-page", ruleId: "docs" });
    const spec = specForConfluencePageQuery(r, key);
    expect(spec.brief).toBe(r.brief);
    expect(spec.resource).toBeUndefined();
  });
});

describe("createConfluencePageTypeEventRules — swarm add/remove/edit diff, reusing diffConfluencePage", () => {
  const r = rule({ id: "docs", query: JSON.stringify({ ancestor: "100" }) });
  const unit = (p: ConfluencePageSnapshot) => ({ kind: "resource" as const, match: { agentKey: `confluence-page:docs:${p.id}`, rule: r, page: p } });

  test("a page entering the primary set is NOT itself a notification (spawn already says it)", async () => {
    const rules = createConfluencePageTypeEventRules();
    const result = await rules.poll({ primary: [], related: [] }, { primary: [unit(page({ id: "1" }))], related: [] });
    expect(result.changedPrimary).toEqual([]);
  });

  test("a page leaving the primary set is NOT itself a notification (stop already says it)", async () => {
    const rules = createConfluencePageTypeEventRules();
    const result = await rules.poll({ primary: [unit(page({ id: "1" }))], related: [] }, { primary: [], related: [] });
    expect(result.changedPrimary).toEqual([]);
  });

  test("a page that stays matched and whose version bumps notifies with confluencePageEdit", async () => {
    const rules = createConfluencePageTypeEventRules();
    const prev = { primary: [unit(page({ id: "1", version: 1 }))], related: [] };
    const next = { primary: [unit(page({ id: "1", version: 2 }))], related: [] };
    const result = await rules.poll(prev, next);
    const key = "confluence-page:docs:1";
    expect(result.changedPrimary).toEqual([key]);
    expect(await result.decide(key, key, "primary")).toEqual({ deliver: true, reason: { confluencePageEdit: { from: 1, to: 2 } } });
  });

  test("a page that stays matched and gains a footer comment notifies with confluencePageComment", async () => {
    const rules = createConfluencePageTypeEventRules();
    const prev = { primary: [unit(page({ id: "1", commentIds: ["c1"] }))], related: [] };
    const next = { primary: [unit(page({ id: "1", commentIds: ["c1", "c2"] }))], related: [] };
    const result = await rules.poll(prev, next);
    const key = "confluence-page:docs:1";
    expect(await result.decide(key, key, "primary")).toEqual({ deliver: true, reason: { confluencePageComment: { ids: ["c2"] } } });
  });

  test("decide refuses for a watcher that is not the resource's own key, on the primary space", async () => {
    const rules = createConfluencePageTypeEventRules();
    const prev = { primary: [unit(page({ id: "1", version: 1 }))], related: [] };
    const next = { primary: [unit(page({ id: "1", version: 2 }))], related: [] };
    const result = await rules.poll(prev, next);
    expect(await result.decide("confluence-page:docs:1", "someone-else", "primary")).toEqual({ deliver: false });
  });

  test("related space (singleton/persistent query agent's own scope): appeared/disappeared, plus the same edit/comment diff for a page that stays in scope", async () => {
    const rules = createConfluencePageTypeEventRules();
    const watcher = "confluence-page:docs:%40query";
    const relatedUnit = (p: ConfluencePageSnapshot) => ({ issue: unit(p), watchers: [watcher] });
    const key = "confluence-page:docs:1";

    const appearedResult = await rules.poll({ primary: [], related: [] }, { primary: [], related: [relatedUnit(page({ id: "1" }))] });
    expect(appearedResult.changedRelated).toEqual([key]);
    expect(await appearedResult.decide(key, watcher, "related")).toEqual({ deliver: true, reason: { appeared: true } });

    const disappearedResult = await rules.poll({ primary: [], related: [relatedUnit(page({ id: "1" }))] }, { primary: [], related: [] });
    expect(disappearedResult.changedRelated).toEqual([key]);
    expect(await disappearedResult.decide(key, watcher, "related")).toEqual({ deliver: true, reason: { disappeared: true } });

    const editResult = await rules.poll(
      { primary: [], related: [relatedUnit(page({ id: "1", version: 1 }))] },
      { primary: [], related: [relatedUnit(page({ id: "1", version: 2 }))] },
    );
    expect(await editResult.decide(key, watcher, "related")).toEqual({ deliver: true, reason: { confluencePageEdit: { from: 1, to: 2 } } });
  });

  test("related decide refuses for a non-watcher", async () => {
    const rules = createConfluencePageTypeEventRules();
    const watcher = "confluence-page:docs:%40query";
    const relatedUnit = (p: ConfluencePageSnapshot) => ({ issue: unit(p), watchers: [watcher] });
    const result = await rules.poll({ primary: [], related: [] }, { primary: [], related: [relatedUnit(page({ id: "1" }))] });
    expect(await result.decide("confluence-page:docs:1", "not-the-watcher", "related")).toEqual({ deliver: false });
  });
});

/**
 * DoD #2 proof: a rule pointed at a test ancestor yields one agent per child
 * page and drops the agent when a child page is removed, run through the
 * REAL, unmodified `runResourceLoop` (src/daemon/loop.ts) — the same
 * technique test/unit/confluence-page-resource-type.test.ts already
 * established for FACTORY-997's own standalone-page ResourceType.
 */
describe("createConfluencePageResourceType — end-to-end: add/remove a child page drives real spawn/stop (DoD #2)", () => {
  function fakeHerd(): Herd {
    const running = new Set<string>();
    return {
      async runningIssues() { return [...running]; },
      async staleIssues() { return []; },
      async spawn(sp) { running.add(sp.key); },
      async stop(i) { running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return { delivered: true }; },
      async resumeInPlace() { return "unresumable" as const; },
    };
  }

  test("a new child page spawns its own agent; removing it stops that agent", async () => {
    const r = rule({ id: "docs", query: JSON.stringify({ ancestor: "100" }) });
    let childIds = ["200"];
    const resourceType = createConfluencePageResourceType({
      rules: [r],
      getChildPages: async () => ({ results: childIds.map((id) => ({ id })) }),
      getPageVersions: async (ids) => Object.fromEntries(ids.map((id) => [id, 1])),
      getPageComments: async () => ({ results: [] }),
    });
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string; reason: NotifyReason | undefined }> = [];
    const stop = runResourceLoop(resourceType, {
      herd,
      ownsId: ownsConfluencePageAgent,
      notify: (issue, about, reason) => { notified.push({ issue, about, reason }); },
      intervalMs: 10,
    });
    const key = "confluence-page:docs:200";
    await new Promise((res) => setTimeout(res, 25));
    expect(await herd.runningIssues()).toContain(key);

    childIds = [];
    await new Promise((res) => setTimeout(res, 40));
    stop();
    expect(await herd.runningIssues()).not.toContain(key);
  });

  test("a child page's version bump wakes its own agent, end to end", async () => {
    const r = rule({ id: "docs", query: JSON.stringify({ ancestor: "100" }) });
    let version = 1;
    const resourceType = createConfluencePageResourceType({
      rules: [r],
      getChildPages: async () => ({ results: [{ id: "300" }] }),
      getPageVersions: async (ids) => Object.fromEntries(ids.map((id) => [id, version])),
      getPageComments: async () => ({ results: [] }),
    });
    const notified: Array<{ issue: string; about: string; reason: NotifyReason | undefined }> = [];
    const stop = runResourceLoop(resourceType, {
      herd: fakeHerd(),
      ownsId: ownsConfluencePageAgent,
      notify: (issue, about, reason) => { notified.push({ issue, about, reason }); },
      intervalMs: 10,
    });
    await new Promise((res) => setTimeout(res, 25));
    expect(notified).toEqual([]);
    version = 2;
    await new Promise((res) => setTimeout(res, 40));
    stop();
    const key = "confluence-page:docs:300";
    expect(notified.some((n) => n.about === key && n.reason && "confluencePageEdit" in n.reason)).toBe(true);
  });
});
