import { describe, expect, test } from "bun:test";
import type { JiraIssue } from "../../src/atlassian/types.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { NotifyReason } from "../../src/resources/types.js";
import { createLinkedEventingState, type LinkedEventingDeps, type LinkedEventingMatch } from "../../src/jira-watch/linked-eventing.js";
import type { FetchLike } from "../../src/labels/pr.js";

/**
 * BUTCHR-437 (epic BUTCHR-421, story 3/4): the three NEW pollers this story
 * adds — Confluence page, GitHub issue/PR, general webpage — driven through
 * `linked-eventing.ts`'s own `runTick`, the SAME coalescer/rate-cap/delivery
 * story 2 already built and tests in test/unit/linked-eventing.test.ts. This
 * file only covers what THIS story added: description-derived discovery
 * gated by `linkedDescriptionLinks`, the three pollers' change/unreadable/
 * no-change/transient outcomes, and the shared caps across every kind.
 */

const CONF_URL = "https://wroosbit.atlassian.net/wiki/spaces/BUTCHR/pages/12484678/Some+Page";
const GH_ISSUE_URL = "https://github.com/acme/widgets/issues/12";
const GH_PR_URL = "https://github.com/acme/widgets/pull/7";
const WEBPAGE_URL = "https://example.com/status";

const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
  parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true, linkedDescriptionLinks: true, ...over }] })[0]!;

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key, status: "To Do", summary: `summary of ${key}`, issuetype: "Task", assignee: null, parent: null,
  updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over,
});

const match = (agentKey: string, r: Rule, i: JiraIssue): LinkedEventingMatch => ({ agentKey, rule: r, issue: i });

/** A controllable Confluence version source — one page id -> current version, or a forced failure. */
function fakeConfluence(state: { value: number | "404" | "403" | "error" }) {
  const calls: string[] = [];
  const getVersion: NonNullable<LinkedEventingDeps["confluenceVersion"]> = async (pageId) => {
    calls.push(pageId);
    if (state.value === "404") return { ok: false, transient: false, httpStatus: 404 };
    if (state.value === "403") return { ok: false, transient: false, httpStatus: 403 };
    if (state.value === "error") return { ok: false, transient: true };
    return { ok: true, version: state.value };
  };
  return { getVersion, calls };
}

/** A controllable GitHub issue/PR source — a status code (200 with the current etag, 304-aware, 404/403/5xx), or a network throw. */
function fakeGithub(state: { status: number | "network-error"; etag?: string }) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(url);
    if (state.status === "network-error") throw new Error("ECONNRESET");
    const inm = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
    if (state.status === 200 && state.etag && inm === state.etag) return new Response(null, { status: 304 });
    return new Response("{}", { status: state.status, ...(state.etag ? { headers: { etag: state.etag } } : {}) });
  };
  return { deps: { fetchImpl, token: "tok" }, calls };
}

/** A controllable webpage source — a status code plus etag (200 with etag, 304-aware, 404/403/5xx), or a network throw. */
function fakeWebpage(state: { status: number | "network-error"; etag?: string }) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(url);
    if (state.status === "network-error") throw new Error("ECONNRESET");
    const inm = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
    if (state.status === 200 && state.etag && inm === state.etag) return new Response(null, { status: 304 });
    return new Response("body", { status: state.status, ...(state.etag ? { headers: { etag: state.etag } } : {}) });
  };
  return { deps: { fetchImpl, isBlockedHost: async () => false }, calls };
}

function fakeBase(opts: { now?: { value: number } } = {}) {
  const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
  const logs: string[] = [];
  const base: LinkedEventingDeps = {
    search: async () => [], // no Jira-kind targets in these tests unless overridden
    notify: async (agent, about, reason) => { notified.push({ agent, about, reason }); },
    log: (l) => logs.push(l),
    ...(opts.now ? { now: () => opts.now!.value } : {}),
  };
  return { base, notified, logs };
}

const linkedEvents = (n: NotifyReason) => (n as { linked: { events: readonly { target: string; kind: string; detail: string }[] } }).linked.events;

describe("BUTCHR-437: linkedDescriptionLinks knob gating", () => {
  test("absent/false runs none of the 3 pollers even with linkedEventing true — zero fetch calls", async () => {
    const owner = issue("BUTCHR-1", { description: `see ${CONF_URL} and ${GH_ISSUE_URL} and ${WEBPAGE_URL}` });
    const state = createLinkedEventingState();
    const { base, notified } = fakeBase();
    const conf = fakeConfluence({ value: 1 });
    const gh = fakeGithub({ status: 200, etag: '"a"' });
    const wp = fakeWebpage({ status: 200, etag: '"a"' });
    const r = rule({ linkedDescriptionLinks: false });
    const deps: LinkedEventingDeps = { ...base, confluenceVersion: conf.getVersion, github: gh.deps, webpage: wp.deps };

    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner)], deps);
    expect(conf.calls).toHaveLength(0);
    expect(gh.calls).toHaveLength(0);
    expect(wp.calls).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });
});

describe("BUTCHR-437: Confluence page poller", () => {
  const owner = issue("BUTCHR-1", { description: `spec: ${CONF_URL}` });

  test("full lifecycle: seed -> change -> notify, 404 -> unreadable line + stop notifying, recovery, transient error retries with no false line", async () => {
    const state = createLinkedEventingState();
    const { base, notified, logs } = fakeBase();
    const confState = { value: 1 as number | "404" | "403" | "error" };
    const conf = fakeConfluence(confState);
    const deps: LinkedEventingDeps = { ...base, confluenceVersion: conf.getVersion };
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed, version 1
    expect(notified).toHaveLength(0);

    confState.value = 2;
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: CONF_URL, kind: "confluence", detail: "version changed from 1 to 2" }]);

    // no-change tick: same version — zero notify
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);

    // transient error: retries, no notify, no unreadable line
    confState.value = "error";
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(logs.some((l) => l.includes("unreadable"))).toBe(false);

    // genuinely unreadable (404): explicit line, own notify
    confState.value = "404";
    await state.runTick([m], deps);
    expect(notified).toHaveLength(2);
    expect(linkedEvents(notified[1]!.reason)).toEqual([{ target: CONF_URL, kind: "confluence", detail: "unreadable (404)" }]);

    // stays unreadable: no further notify from this alone
    await state.runTick([m], deps);
    expect(notified).toHaveLength(2);

    // recovers, at a new version: one notify, transition line only (no stale "still unreadable" line once healthy)
    confState.value = 5;
    await state.runTick([m], deps);
    expect(notified).toHaveLength(3);
    expect(linkedEvents(notified[2]!.reason)).toEqual([{ target: CONF_URL, kind: "confluence", detail: "version changed from 2 to 5" }]);
  });

  test("an unresolvable Confluence URL (no /pages/<id>/ segment) is unreadable with no HTTP call", async () => {
    const noPageId = issue("BUTCHR-1", { description: "see https://wroosbit.atlassian.net/wiki/spaces/BUTCHR/overview" });
    const state = createLinkedEventingState();
    const { base, notified } = fakeBase();
    const conf = fakeConfluence({ value: 1 });
    const deps: LinkedEventingDeps = { ...base, confluenceVersion: conf.getVersion };
    const m = match("jira-work:task:BUTCHR-1", rule(), noPageId);

    await state.runTick([m], deps);
    expect(conf.calls).toHaveLength(0);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)[0]!.detail).toBe("unreadable");
  });
});

describe("BUTCHR-437: GitHub issue/PR poller", () => {
  test("GitHub issue: a real change (new ETag) produces exactly ONE notify; a matching conditional GET (304) produces zero", async () => {
    const owner = issue("BUTCHR-1", { description: `tracked in ${GH_ISSUE_URL}` });
    const state = createLinkedEventingState();
    const { base, notified } = fakeBase();
    const ghState: { status: number | "network-error"; etag?: string } = { status: 200, etag: '"v1"' };
    const gh = fakeGithub(ghState);
    const deps: LinkedEventingDeps = { ...base, github: gh.deps };
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed at v1
    expect(notified).toHaveLength(0);

    await state.runTick([m], deps); // still v1, and the second call sends If-None-Match — expect a 304, zero notify
    expect(notified).toHaveLength(0);
    expect(gh.calls).toHaveLength(2);

    ghState.etag = '"v2"';
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "acme/widgets#12", kind: "github-issue", detail: "updated" }]);
  });

  test("GitHub PR: 404 is unreadable and stops notifying further; a 403 is unreadable too; a 5xx and a network failure are transient (no notify, no false unreadable line)", async () => {
    const owner = issue("BUTCHR-1", { description: `PR: ${GH_PR_URL}` });
    const state = createLinkedEventingState();
    const { base, notified, logs } = fakeBase();
    const ghState: { status: number | "network-error"; etag?: string } = { status: 200, etag: '"v1"' };
    const gh = fakeGithub(ghState);
    const deps: LinkedEventingDeps = { ...base, github: gh.deps };
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    expect(notified).toHaveLength(0);

    ghState.status = 502;
    await state.runTick([m], deps);
    expect(notified).toHaveLength(0);
    expect(logs.some((l) => l.includes("unreadable"))).toBe(false);

    ghState.status = "network-error";
    await state.runTick([m], deps);
    expect(notified).toHaveLength(0);

    ghState.status = 404;
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "acme/widgets#7", kind: "github-pr", detail: "unreadable (404)" }]);

    await state.runTick([m], deps); // still 404 — no further notify from this alone
    expect(notified).toHaveLength(1);
  });
});

describe("BUTCHR-437: general webpage poller", () => {
  test("an ETag change produces exactly ONE notify; an unchanged ETag (304) produces zero", async () => {
    const owner = issue("BUTCHR-1", { description: `status page: ${WEBPAGE_URL}` });
    const state = createLinkedEventingState();
    const { base, notified } = fakeBase();
    const wpState: { status: number | "network-error"; etag?: string } = { status: 200, etag: '"a"' };
    const wp = fakeWebpage(wpState);
    const deps: LinkedEventingDeps = { ...base, webpage: wp.deps };
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    await state.runTick([m], deps); // 304 — no change
    expect(notified).toHaveLength(0);

    wpState.etag = '"b"';
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: WEBPAGE_URL, kind: "webpage", detail: "changed" }]);
  });

  test("a body-hash change (no ETag/Last-Modified offered) produces exactly ONE notify; an unreadable (404) target stops notifying until it recovers", async () => {
    const owner = issue("BUTCHR-1", { description: `status page: ${WEBPAGE_URL}` });
    const state = createLinkedEventingState();
    const { base, notified } = fakeBase();
    let body = "ok";
    let status: number = 200;
    const fetchImpl: FetchLike = async () => new Response(body, { status });
    const deps: LinkedEventingDeps = { ...base, webpage: { fetchImpl, isBlockedHost: async () => false } };
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    await state.runTick([m], deps); // unchanged body — zero notify
    expect(notified).toHaveLength(0);

    body = "degraded";
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: WEBPAGE_URL, kind: "webpage", detail: "changed" }]);

    status = 404;
    await state.runTick([m], deps);
    expect(notified).toHaveLength(2);
    expect(linkedEvents(notified[1]!.reason)[0]!.detail).toBe("unreadable (404)");
    await state.runTick([m], deps); // still 404
    expect(notified).toHaveLength(2);
  });
});

describe("BUTCHR-437: shared caps across every link kind", () => {
  test("maxLinkedItems applies uniformly across Jira + Confluence + GitHub kinds — the excess kind is never even fetched", async () => {
    const owner = issue("BUTCHR-1", {
      issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never,
      description: `${CONF_URL} and ${GH_ISSUE_URL}`,
    });
    const world = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { base, notified } = fakeBase();
    const search = async (jql: string) => {
      const m = /^key in \((.*)\)$/.exec(jql);
      const keys = m ? m[1]!.split(",") : [];
      return keys.map((k) => world[k as keyof typeof world]).filter((i): i is JiraIssue => Boolean(i));
    };
    const conf = fakeConfluence({ value: 1 });
    const gh = fakeGithub({ status: 200, etag: '"a"' });
    const r = rule({ maxLinkedItems: 2 });
    const deps: LinkedEventingDeps = { ...base, search, confluenceVersion: conf.getVersion, github: gh.deps };
    const m = match("jira-work:task:BUTCHR-1", r, owner);

    await state.runTick([m], deps); // seed
    expect(conf.calls).toHaveLength(1); // kept (2nd of 2)
    expect(gh.calls).toHaveLength(0); // capped out (3rd of 3) — never fetched at all
  });

  test("mixed-kind tick: a Jira change and a Confluence change in the SAME tick coalesce into exactly ONE notify, and the rate cap is shared across kinds", async () => {
    const owner = issue("BUTCHR-1", {
      issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never,
      description: `${CONF_URL}`,
    });
    const world = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const { base, notified, logs } = fakeBase({ now });
    const search = async (jql: string) => {
      const m = /^key in \((.*)\)$/.exec(jql);
      const keys = m ? m[1]!.split(",") : [];
      return keys.map((k) => world[k as keyof typeof world]).filter((i): i is JiraIssue => Boolean(i));
    };
    const confState = { value: 1 as number | "404" | "403" | "error" };
    const conf = fakeConfluence(confState);
    const r = rule({ maxLinkedTurnsPerHour: 1 });
    const deps: LinkedEventingDeps = { ...base, search, confluenceVersion: conf.getVersion };
    const m = match("jira-work:task:BUTCHR-1", r, owner);

    await state.runTick([m], deps); // seed both
    expect(notified).toHaveLength(0);

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    confState.value = 2;
    await state.runTick([m], deps); // both changed in the same tick — ONE coalesced notify, uses the one allowed turn
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason).map((e) => e.target).sort()).toEqual(["BUTCHR-2", CONF_URL]);

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "Done" });
    confState.value = 3;
    await state.runTick([m], deps); // rate-capped — dropped, not delivered
    expect(notified).toHaveLength(1);
    expect(logs.some((l) => l.includes("arm=rate-capped"))).toBe(true);

    now.value += 61 * 60_000; // roll the window
    await state.runTick([m], deps); // both still-outstanding changes re-detect and deliver together
    expect(notified).toHaveLength(2);
    expect(linkedEvents(notified[1]!.reason).map((e) => e.target).sort()).toEqual(["BUTCHR-2", CONF_URL]);
  });

  test("PR #401 review round 1: a hung webpage poll for one owner does not stall another owner's tick — the other owner still polls and notifies within the tick", async () => {
    const STUCK_URL = "https://stuck.example.com/slow";
    const stuckOwner = issue("BUTCHR-1", { description: `see ${STUCK_URL}` });
    const okOwner = issue("BUTCHR-2", { description: `spec: ${CONF_URL}` });
    const state = createLinkedEventingState();
    const { base, notified } = fakeBase();
    const confState = { value: 1 as number | "404" | "403" | "error" };
    const conf = fakeConfluence(confState);
    const fetchImpl: FetchLike = (url) => (url === STUCK_URL ? new Promise<Response>(() => {}) : Promise.resolve(new Response("x", { status: 200 })));
    const deps: LinkedEventingDeps = {
      ...base,
      confluenceVersion: conf.getVersion,
      webpage: { fetchImpl, isBlockedHost: async () => false, timeoutMs: 20 },
    };
    const mStuck = match("jira-work:task:BUTCHR-1", rule(), stuckOwner);
    const mOk = match("jira-work:task:BUTCHR-2", rule(), okOwner);

    await state.runTick([mStuck, mOk], deps); // seed both
    expect(notified).toHaveLength(0);

    confState.value = 2;
    const start = Date.now();
    await state.runTick([mStuck, mOk], deps);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000); // bounded — the stuck webpage item's own 20ms timeoutMs, not left hanging for the tick's duration
    expect(notified).toHaveLength(1); // BUTCHR-2's Confluence change still notified despite BUTCHR-1's stuck webpage item
    expect(notified[0]!.agent).toBe("jira-work:task:BUTCHR-2");
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: CONF_URL, kind: "confluence", detail: "version changed from 1 to 2" }]);
  });
});
