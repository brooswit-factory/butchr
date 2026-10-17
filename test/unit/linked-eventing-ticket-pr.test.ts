import { describe, expect, test } from "bun:test";
import type { JiraIssue } from "../../src/atlassian/types.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { NotifyReason } from "../../src/resources/types.js";
import {
  createLinkedEventingState,
  ticketPullRequestActivityDetail,
  ticketPullRequestItems,
  type LinkedEventingDeps,
  type LinkedEventingMatch,
} from "../../src/jira-watch/linked-eventing.js";
import { formatPullActivityFingerprint, parsePullActivityFingerprint, pollGithubPullActivity } from "../../src/jira-watch/external-poll.js";
import { linkedChangeNudge } from "../../src/agents/change-nudge.js";
import { createRuleResourceType } from "../../src/rules/resource-type.js";
import type { FetchLike } from "../../src/labels/pr.js";

/**
 * local/ui — a ticket's OWN pull request (found by GitHub PR discovery from
 * its branch name) watched through linked-change eventing, so a PR comment
 * or review wakes the ticket's agent: `ticketPullRequestItems`, the
 * activity-count poller (`pollGithubPullActivity`) and its comparison, the
 * notice wording, dedupe, removal tracking and the shared caps.
 */

const TARGET = "example-org/widgets#547";
const PR_URL = "https://github.com/example-org/widgets/pull/547";
const PR_REF = { owner: "example-org", repo: "widgets", number: 547 };

const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
  parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true, maxLinkedTurnsPerHour: 1000, ...over }] })[0]!;

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key, status: "In Progress", summary: `summary of ${key}`, issuetype: "Task", assignee: null, parent: null,
  updated: "2026-10-15T00:00:00.000+0000", labels: [], ...over,
});

const match = (r: Rule, i: JiraIssue): LinkedEventingMatch => ({ agentKey: `jira-work:task:${i.key}`, rule: r, issue: i });

/** A controllable GitHub PR: its activity counts, current ETag (304 when the request's If-None-Match matches), or a forced status. */
function fakePrApi(state: { comments: number; reviewComments: number; reviews: number; etag: string; status?: number; reviewsStatus?: number }) {
  const calls: Array<{ url: string; ifNoneMatch: string | undefined }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
    calls.push({ url, ifNoneMatch });
    if (url.includes("/reviews?")) {
      if (state.reviewsStatus && state.reviewsStatus !== 200) return new Response("x", { status: state.reviewsStatus });
      return new Response(JSON.stringify(Array.from({ length: state.reviews }, (_, id) => ({ id }))), { status: 200 });
    }
    if (state.status && state.status !== 200) return new Response("x", { status: state.status });
    if (ifNoneMatch === state.etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify({ comments: state.comments, review_comments: state.reviewComments }), { status: 200, headers: { etag: state.etag } });
  };
  return { deps: { fetchImpl, token: "tok" }, calls };
}

function fakeBase(opts: { now?: { value: number }; pr?: () => typeof PR_REF | undefined } = {}) {
  const notified: Array<{ agent: string; reason: NotifyReason }> = [];
  const logs: string[] = [];
  const searched: string[] = [];
  const base: LinkedEventingDeps = {
    search: async (jql) => { searched.push(jql); return []; },
    notify: async (agent, _about, reason) => { notified.push({ agent, reason }); },
    log: (l) => logs.push(l),
    ticketPullRequest: (key) => (key === "KAN-3020" ? (opts.pr ? opts.pr() : PR_REF) : undefined),
    ...(opts.now ? { now: () => opts.now!.value } : {}),
  };
  return { base, notified, logs, searched };
}

const linkedEvents = (n: NotifyReason) => (n as { linked: { events: readonly { target: string; kind: string; detail: string }[] } }).linked.events;
const prCalls = <T extends { url: string }>(calls: readonly T[]): T[] => calls.filter((c) => /pulls\/547$/.test(c.url));

describe("a ticket's own PR wakes its agent", () => {
  test("a new PR comment wakes the agent, naming the PR, with linkedDescriptionLinks off", async () => {
    const state = createLinkedEventingState();
    const { base, notified } = fakeBase();
    const s = { comments: 1, reviewComments: 0, reviews: 0, etag: '"a"' };
    const pr = fakePrApi(s);
    const deps: LinkedEventingDeps = { ...base, github: pr.deps };
    const m = match(rule({ linkedDescriptionLinks: false }), issue("KAN-3020"));

    await state.runTick([m], deps); // seed
    expect(notified).toHaveLength(0);

    Object.assign(s, { comments: 2, etag: '"b"' });
    pr.calls.length = 0;
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    const events = linkedEvents(notified[0]!.reason);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ target: TARGET, kind: "github-pr" });
    expect(events[0]!.detail).toBe(`this ticket's pull request ${PR_URL} got 1 new comment — read them with gh pr view ${PR_URL} --comments`);
    expect(prCalls(pr.calls)[0]!.ifNoneMatch).toBe('"a"'); // conditional on the seeded ETag
    expect(linkedChangeNudge("KAN-3020", events).split("\n")[0]).toBe("[butchr] KAN-3020: 1 linked item changed — re-read them.");
  });

  test("reviews and review comments are named; an ETag-only move (mergeability, a push) is carried forward silently", async () => {
    const state = createLinkedEventingState();
    const { base, notified } = fakeBase();
    const s = { comments: 0, reviewComments: 0, reviews: 0, etag: '"a"' };
    const pr = fakePrApi(s);
    const deps: LinkedEventingDeps = { ...base, github: pr.deps };
    const m = match(rule(), issue("KAN-3020"));

    await state.runTick([m], deps); // seed
    s.etag = '"b"'; // only the ETag moved
    await state.runTick([m], deps);
    expect(notified).toHaveLength(0);
    pr.calls.length = 0;
    await state.runTick([m], deps); // the carried-forward ETag answers 304
    expect(prCalls(pr.calls)[0]!.ifNoneMatch).toBe('"b"');
    expect(pr.calls.some((c) => c.url.includes("/reviews"))).toBe(false); // a 304 costs no reviews read
    expect(notified).toHaveLength(0);

    Object.assign(s, { reviewComments: 2, reviews: 1, etag: '"c"' });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)[0]!.detail).toBe(
      `this ticket's pull request ${PR_URL} got 2 new review comments and 1 new review — read them with gh pr view ${PR_URL} --comments; inline ones: gh api repos/example-org/widgets/pulls/547/comments`,
    );
  });

  test("without the ticketPullRequest dep (no GitHub configured) nothing is watched and GitHub is never called", async () => {
    const state = createLinkedEventingState();
    const { base, notified } = fakeBase();
    const { ticketPullRequest: _omitted, ...noPr } = base;
    const pr = fakePrApi({ comments: 0, reviewComments: 0, reviews: 0, etag: '"a"' });
    const m = match(rule(), issue("KAN-3020"));
    await state.runTick([m], { ...noPr, github: pr.deps });
    await state.runTick([m], { ...noPr, github: pr.deps });
    expect(pr.calls).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });

  test("nothing happens for a rule without linkedEventing, even with a discovered PR", async () => {
    const state = createLinkedEventingState();
    const { base } = fakeBase();
    const pr = fakePrApi({ comments: 0, reviewComments: 0, reviews: 0, etag: '"a"' });
    await state.runTick([match(rule({ linkedEventing: false }), issue("KAN-3020"))], { ...base, github: pr.deps });
    expect(pr.calls).toHaveLength(0);
  });

  test("the same PR in the description is watched once, as the ticket's PR", async () => {
    const state = createLinkedEventingState();
    const { base, notified } = fakeBase();
    const s = { comments: 0, reviewComments: 0, reviews: 0, etag: '"a"' };
    const pr = fakePrApi(s);
    const m = match(rule({ linkedDescriptionLinks: true }), issue("KAN-3020", { description: `PR: ${PR_URL}` }));
    const deps: LinkedEventingDeps = { ...base, github: pr.deps };

    await state.runTick([m], deps);
    expect(prCalls(pr.calls)).toHaveLength(1); // one poll of the PR, not two
    Object.assign(s, { comments: 1, etag: '"b"' });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    const events = linkedEvents(notified[0]!.reason);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toContain("got 1 new comment"); // the activity poller's wording, not the bare-ETag "updated"
  });

  test("the PR merging or closing (discovery drops it) isn't reported as no longer linked", async () => {
    const state = createLinkedEventingState();
    let current: typeof PR_REF | undefined = PR_REF;
    const { base, notified } = fakeBase({ pr: () => current });
    const pr = fakePrApi({ comments: 0, reviewComments: 0, reviews: 0, etag: '"a"' });
    const m = match(rule(), issue("KAN-3020"));
    await state.runTick([m], { ...base, github: pr.deps });
    current = undefined;
    await state.runTick([m], { ...base, github: pr.deps });
    expect(notified).toHaveLength(0);
  });

  test("the turn cap delays a burst rather than dropping it", async () => {
    const now = { value: 1_000_000 };
    const state = createLinkedEventingState();
    const { base, notified, logs } = fakeBase({ now });
    const s = { comments: 0, reviewComments: 0, reviews: 0, etag: '"a"' };
    const pr = fakePrApi(s);
    const deps: LinkedEventingDeps = { ...base, github: pr.deps };
    const m = match(rule({ maxLinkedTurnsPerHour: 1 }), issue("KAN-3020"));

    await state.runTick([m], deps); // seed
    Object.assign(s, { comments: 1, etag: '"b"' });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    Object.assign(s, { comments: 3, etag: '"c"' });
    now.value += 60_000;
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1); // capped: 1 per hour
    expect(logs.some((l) => l.includes("KAN-3020"))).toBe(true);
    now.value += 60 * 60_000;
    await state.runTick([m], deps);
    expect(notified).toHaveLength(2); // delivered once the window allows — nothing lost
    expect(linkedEvents(notified[1]!.reason)[0]!.detail).toContain("got 2 new comments");
  });

  test("the ticket's PR comes first, so the item cap never drops it", async () => {
    const state = createLinkedEventingState();
    const { base, searched } = fakeBase();
    const pr = fakePrApi({ comments: 0, reviewComments: 0, reviews: 0, etag: '"a"' });
    const owner = issue("KAN-3020", { issuelinks: [{ key: "KAN-3023", type: "Relates", direction: "outward" } as never] });
    await state.runTick([match(rule({ maxLinkedItems: 1 }), owner)], { ...base, github: pr.deps });
    expect(prCalls(pr.calls)).toHaveLength(1);
    expect(searched.some((jql) => jql.includes("KAN-3023"))).toBe(false); // the issuelink was the one capped away
    // Control: with room for both, the issuelink is searched too.
    await createLinkedEventingState().runTick([match(rule({ maxLinkedItems: 2 }), owner)], { ...base, github: pr.deps });
    expect(searched.some((jql) => jql.includes("KAN-3023"))).toBe(true);
  });
});

describe("wiring through the jira-work rule resource type", () => {
  test("createRuleResourceType passes ticketPullRequest to linked eventing: a PR comment notifies the ticket's agent", async () => {
    const owner = issue("KAN-3020");
    const s = { comments: 0, reviewComments: 0, reviews: 0, etag: '"a"' };
    const pr = fakePrApi(s);
    const notified: Array<{ agent: string; reason: NotifyReason }> = [];
    const type = createRuleResourceType({
      rules: [rule()],
      search: async (jql) => (jql.startsWith("key in (") ? [] : [owner]),
      notify: async (agent, _about, reason) => { notified.push({ agent, reason }); },
      github: pr.deps,
      ticketPullRequest: (key) => (key === "KAN-3020" ? PR_REF : undefined),
    });
    // `related()` is where the loop runs linked eventing, right after `search()` (src/daemon/loop.ts).
    const poll = async () => { await type.discovery.search(); await type.discovery.related!(["jira-work:task:KAN-3020"]); };
    await poll(); // seed
    expect(notified).toHaveLength(0);
    Object.assign(s, { comments: 1, etag: '"b"' });
    await poll();
    expect(notified.map((n) => n.agent)).toEqual(["jira-work:task:KAN-3020"]);
    expect(linkedEvents(notified[0]!.reason)[0]!.detail).toContain(`${PR_URL} got 1 new comment`);
  });
});

describe("ticketPullRequestItems", () => {
  test("one github-pr item marked as the ticket's PR, or nothing", () => {
    expect(ticketPullRequestItems("KAN-3020", () => PR_REF)).toEqual([{ kind: "github-pr", target: TARGET, origin: "ticket-pr" }]);
    expect(ticketPullRequestItems("KAN-3020", () => undefined)).toEqual([]);
    expect(ticketPullRequestItems("KAN-3020", undefined)).toEqual([]);
    expect(ticketPullRequestItems("KAN-3020", () => ({ owner: "bad owner", repo: "r", number: 1 }))).toEqual([]);
  });
});

describe("ticketPullRequestActivityDetail", () => {
  const fp = (comments: number, reviewComments: number, reviews: number, etag = '"x"') => formatPullActivityFingerprint({ comments, reviewComments, reviews, etag });
  test("null when no count rose, or when a fingerprint isn't an activity one", () => {
    expect(ticketPullRequestActivityDetail(TARGET, fp(1, 0, 0, '"a"'), fp(1, 0, 0, '"b"'))).toBeNull();
    expect(ticketPullRequestActivityDetail(TARGET, fp(2, 0, 0), fp(1, 0, 0))).toBeNull(); // a deletion doesn't wake anyone
    expect(ticketPullRequestActivityDetail(TARGET, '"bare-etag"', fp(3, 0, 0))).toBeNull(); // left by the bare-ETag poller: reseeded, not a change
  });
  test("names every kind of activity that rose", () => {
    expect(ticketPullRequestActivityDetail(TARGET, fp(0, 0, 0), fp(2, 1, 0))).toContain("got 2 new comments and 1 new review comment");
    expect(ticketPullRequestActivityDetail(TARGET, fp(0, 0, 0), fp(1, 1, 1))).toContain("got 1 new comment, 1 new review comment and 1 new review");
  });
});

describe("pollGithubPullActivity", () => {
  test("a 200 reads the counts and the reviews; the fingerprint round-trips", async () => {
    const pr = fakePrApi({ comments: 4, reviewComments: 2, reviews: 3, etag: '"e"' });
    const v = await pollGithubPullActivity(TARGET, null, pr.deps);
    expect(v.status).toBe("ok");
    expect(parsePullActivityFingerprint(v.status === "ok" ? v.fingerprint : "")).toEqual({ comments: 4, reviewComments: 2, reviews: 3, etag: '"e"' });
    expect(pr.calls.map((c) => c.url)).toEqual([`https://api.github.com/repos/example-org/widgets/pulls/547`, `https://api.github.com/repos/example-org/widgets/pulls/547/reviews?per_page=100`]);
  });
  test("conditional on the prior ETag: 304 is not-modified", async () => {
    const pr = fakePrApi({ comments: 0, reviewComments: 0, reviews: 0, etag: '"e"' });
    const prior = formatPullActivityFingerprint({ comments: 0, reviewComments: 0, reviews: 0, etag: '"e"' });
    expect(await pollGithubPullActivity(TARGET, prior, pr.deps)).toEqual({ status: "not-modified" });
  });
  test("404/403 are unreadable, a rate-limited 403 or 5xx is transient, and a failed reviews read is transient", async () => {
    expect(await pollGithubPullActivity(TARGET, null, fakePrApi({ comments: 0, reviewComments: 0, reviews: 0, etag: "", status: 404 }).deps)).toEqual({ status: "unreadable", httpStatus: 404 });
    expect(await pollGithubPullActivity(TARGET, null, fakePrApi({ comments: 0, reviewComments: 0, reviews: 0, etag: "", status: 502 }).deps)).toEqual({ status: "error" });
    const limited: FetchLike = async () => new Response("x", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    expect(await pollGithubPullActivity(TARGET, null, { fetchImpl: limited })).toEqual({ status: "error" });
    expect(await pollGithubPullActivity(TARGET, null, fakePrApi({ comments: 0, reviewComments: 0, reviews: 0, etag: '"e"', reviewsStatus: 500 }).deps)).toEqual({ status: "error" });
    const malformed: FetchLike = async () => new Response(JSON.stringify({ comments: "many" }), { status: 200 });
    expect(await pollGithubPullActivity(TARGET, null, { fetchImpl: malformed })).toEqual({ status: "error" });
    expect(await pollGithubPullActivity("not a ref", null, { fetchImpl: malformed })).toEqual({ status: "unreadable" });
  });
});
