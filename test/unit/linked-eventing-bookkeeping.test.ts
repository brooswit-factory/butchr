import { describe, expect, test } from "bun:test";
import type { IssueLink, JiraComment, JiraIssue } from "../../src/atlassian/types.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { NotifyReason } from "../../src/resources/types.js";
import { createLinkedEventingState, type LinkedEventingDeps, type LinkedEventingMatch } from "../../src/jira-watch/linked-eventing.js";

/**
 * FACTORY-865/FACTORY-866 (site 2): the parent/child linked-change path's
 * own `!commentChanged && isDaemonLabelOnlyDiff(...)` gate
 * (src/jira-watch/linked-eventing.ts) must apply the SAME bookkeeping-comment
 * filter the issue tier does — see test/unit/issue-bookkeeping-comment-suppression.test.ts
 * for that site. This file covers only what's NEW here: a bookkeeping
 * comment must not revive a daemon-label-only diff on a LINKED target
 * either. test/unit/linked-eventing-managed-links.test.ts's own "a new
 * comment landing in the SAME tick as an unrelated daemon-label move is NOT
 * swallowed" test (line ~329) already pins the REAL-comment contrast case
 * this file's own test mirrors — reused unchanged, never re-tested here.
 */

const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
  parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true, ...over }] })[0]!;

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key, status: "To Do", summary: `summary of ${key}`, issuetype: "Task", assignee: null, parent: null,
  updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over,
});

const match = (agentKey: string, r: Rule, i: JiraIssue): LinkedEventingMatch => ({ agentKey, rule: r, issue: i });
const linkedEvents = (n: NotifyReason) => (n as { linked: { events: readonly { target: string; kind: string; detail: string }[] } }).linked.events;

function fakeDeps(world: Record<string, JiraIssue>, commentsByKey: Record<string, JiraComment[]> = {}) {
  const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
  const deps: LinkedEventingDeps = {
    search: async (jql) => {
      const m = /^key in \((.*)\)$/.exec(jql);
      const keys = m ? m[1]!.split(",") : [];
      return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
    },
    notify: async (agent, about, reason) => { notified.push({ agent, about, reason }); },
    comments: async (key: string) => commentsByKey[key] ?? [],
  };
  return { deps, notified };
}

describe("FACTORY-865 site 2 criterion B: a bookkeeping [butchr:*] comment landing alongside a daemon-label-only move on a LINKED target stays suppressed", () => {
  test("a [butchr:parked]-style comment + an agent:* flip on the linked target -> no event at all", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" } as IssueLink] });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { labels: ["agent:working"], updated: "t1" }) };
    const commentsByKey: Record<string, JiraComment[]> = { "BUTCHR-2": [{ id: "c0", body: "a real human comment", created: "t0", authorEmail: null }] };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world, commentsByKey);
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed

    // Same tick: only a daemon-owned label changed AND a bookkeeping comment landed.
    world["BUTCHR-2"] = issue("BUTCHR-2", { labels: ["agent:blocked"], updated: "t2" });
    commentsByKey["BUTCHR-2"] = [
      { id: "c1", body: "[butchr:parked] X has been assigned and linked to this ticket", created: "t2", authorEmail: null },
      { id: "c0", body: "a real human comment", created: "t0", authorEmail: null },
    ];
    await state.runTick([m], deps);
    expect(notified).toHaveLength(0); // would have been 1 ("got a new comment") pre-fix
  });
});

describe("FACTORY-865 site 2 criterion D (representative): an allowlisted WAKE marker still moves the cursor on a LINKED target", () => {
  test("[butchr:blocked] landing alongside a daemon-label-only move on a linked target still delivers, named by the comment", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" } as IssueLink] });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { labels: ["agent:working"], updated: "t1" }) };
    const commentsByKey: Record<string, JiraComment[]> = { "BUTCHR-2": [{ id: "c0", body: "a real human comment", created: "t0", authorEmail: null }] };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world, commentsByKey);
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed

    world["BUTCHR-2"] = issue("BUTCHR-2", { labels: ["agent:blocked"], updated: "t2" });
    commentsByKey["BUTCHR-2"] = [
      { id: "c1", body: "[butchr:blocked] BUTCHR-2 is waiting on a decision", created: "t2", authorEmail: null },
      { id: "c0", body: "a real human comment", created: "t0", authorEmail: null },
    ];
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: "got a new comment" }]);
  });
});
