import { describe, expect, test } from "bun:test";
import { createLabelSync, type LabelWriter } from "../../src/labels/sync.js";
import { createStalledCheck } from "../../src/agents/stalled.js";
import { createStallRemediator } from "../../src/agents/stall-remediation.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

const iss = (key: string, status: string, labels: string[]): JiraIssue =>
  ({ key, status, summary: "s", issuetype: "Task", assignee: "a", parent: null, updated: "t", labels });

function fakeJira(): LabelWriter & { calls: Array<{ key: string; add: string[]; remove: string[] }> } {
  const calls: Array<{ key: string; add: string[]; remove: string[] }> = [];
  return {
    calls,
    async updateLabels(key, ops) { calls.push({ key, add: [...(ops.add ?? [])], remove: [...(ops.remove ?? [])] }); },
  };
}

function fakeJiraFailingFor(badKey: string): LabelWriter & { calls: Array<{ key: string; add: string[]; remove: string[] }> } {
  const calls: Array<{ key: string; add: string[]; remove: string[] }> = [];
  return {
    calls,
    async updateLabels(key, ops) {
      if (key === badKey) throw new Error("403 forbidden");
      calls.push({ key, add: [...(ops.add ?? [])], remove: [...(ops.remove ?? [])] });
    },
  };
}

describe("createLabelSync", () => {
  test("working -> idle -> blocked -> none: each confirmed transition is exactly one Jira update", async () => {
    const jira = fakeJira();
    const agentStatus = { current: "working" as string | null };
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map(agentStatus.current ? [["KAN-1", agentStatus.current]] : []) });

    // the very first observation for a ticket applies immediately — nothing to flicker against yet
    let issue = iss("KAN-1", "In Progress", []);
    await sync([issue]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:working"], remove: [] }]);

    jira.calls.length = 0;
    agentStatus.current = "idle";
    issue = iss("KAN-1", "In Progress", ["agent:working"]);
    await sync([issue]); // 1st poll of "idle" vs applied "working": unconfirmed candidate, no write
    expect(jira.calls).toEqual([]);
    await sync([issue]); // 2nd consecutive poll of "idle": confirmed
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: ["agent:working"] }]);

    jira.calls.length = 0;
    agentStatus.current = "blocked";
    issue = iss("KAN-1", "In Progress", ["agent:idle"]);
    await sync([issue]);
    expect(jira.calls).toEqual([]);
    await sync([issue]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:blocked"], remove: ["agent:idle"] }]);

    jira.calls.length = 0;
    agentStatus.current = null;
    issue = iss("KAN-1", "In Progress", ["agent:blocked"]);
    await sync([issue]);
    expect(jira.calls).toEqual([]);
    await sync([issue]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:none"], remove: ["agent:blocked"] }]);
  });

  test("herdr's agent_status flickering within the stabilization window produces zero label churn", async () => {
    const jira = fakeJira();
    // never the same value twice in a row: working, blocked, working, blocked, working
    const statuses: Array<string | null> = ["working", "blocked", "working", "blocked", "working"];
    let i = 0;
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", statuses[Math.min(i++, statuses.length - 1)]!]]) });

    const issue = iss("KAN-1", "In Progress", ["agent:working"]); // already applied: working
    for (let p = 0; p < statuses.length; p++) await sync([issue]);
    expect(jira.calls).toEqual([]); // every candidate reverted before confirming — zero writes
  });

  test("a genuinely stable transition (new status held for 2 consecutive polls) still produces exactly one add/remove pair", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "blocked"]]) });
    const issue = iss("KAN-1", "In Progress", ["agent:working"]);
    await sync([issue]); // poll 1 of "blocked": unconfirmed
    expect(jira.calls).toEqual([]);
    await sync([issue]); // poll 2 of "blocked": confirmed
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:blocked"], remove: ["agent:working"] }]);
    jira.calls.length = 0;
    await sync([iss("KAN-1", "In Progress", ["agent:blocked"])]); // now matches applied: no further writes
    expect(jira.calls).toEqual([]);
  });

  test("human labels are never added or removed, and survive reconciliation", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]) });
    const issue = iss("KAN-1", "In Progress", ["agent:working", "urgent", "needs-design"]);
    await sync([issue]); // unconfirmed candidate
    expect(jira.calls).toEqual([]);
    await sync([issue]); // confirmed
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: ["agent:working"] }]);
    for (const c of jira.calls) {
      expect(c.add).not.toContain("urgent");
      expect(c.remove).not.toContain("urgent");
      expect(c.remove).not.toContain("needs-design");
    }
  });

  test("no-change poll -> zero Jira writes", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "working"]]) });
    await sync([iss("KAN-1", "In Progress", ["agent:working"])]);
    await sync([iss("KAN-1", "In Progress", ["agent:working"])]);
    expect(jira.calls).toEqual([]);
  });

  test("a ticket that leaves the active set (disappears from the feed) has all agent:* removed", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "working"]]) });
    await sync([iss("KAN-1", "In Progress", [])]); // establishes tracked state: agent:working
    jira.calls.length = 0;
    await sync([]); // KAN-1 no longer active/visible
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:working"] }]);
    jira.calls.length = 0;
    await sync([]); // already cleared, and no longer tracked -> nothing more happens
    expect(jira.calls).toEqual([]);
  });

  test("a ticket's human labels are never re-added when it disappears from the feed (regression)", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]) });
    await sync([iss("KAN-1", "In Progress", ["needs-design", "p1"])]); // establishes agent:idle alongside human labels
    jira.calls.length = 0;
    await sync([]); // KAN-1 disappears from the feed
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:idle"] }]); // never re-adds needs-design/p1
  });

  test("a ticket seen directly with a non-active status (not merely disappeared) also has agent:* cleared", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "working"]]) });
    await sync([iss("KAN-1", "In Progress", [])]);
    jira.calls.length = 0;
    await sync([iss("KAN-1", "Done", ["agent:working"])]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:working"] }]);
  });

  test("pr:* is independently reconciled and untouched by the active-leave cleanup", async () => {
    const jira = fakeJira();
    let pr: "open" | "approved" | "merged" | null = "approved";
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "working"]]),
      prState: async () => pr,
    });
    await sync([iss("KAN-1", "In Progress", [])]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:working", "pr:approved"], remove: [] }]);
    jira.calls.length = 0;
    await sync([]); // leaves active status
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:working"] }]); // pr:approved kept
  });

  test("restart durability: an active ticket already carrying pr:merged, whose PR is confirmed merged again after a cold-cache rediscovery, gets zero label writes (no remove/re-add cycle)", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "working"]]),
      prState: async () => "merged", // fresh PrTracker after a restart, cold-cache merged-search rediscovers the same PR
    });
    await sync([iss("KAN-1", "In Progress", ["agent:working", "pr:merged"])]);
    expect(jira.calls).toEqual([]);
  });

  // KAN-832/837 case 8, end-to-end: an "unknown" lookup on a ticket already carrying pr:merged
  // must issue ZERO updateLabels calls — the re-emitted pr:merged diffs to no-op against Jira's
  // current state, same as the existing "restart durability" case above, but from "unknown"
  // rather than a re-confirmed "merged".
  test("an 'unknown' lookup on a ticket carrying pr:merged issues zero updateLabels calls", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "working"]]),
      prState: async () => "unknown", // e.g. tracker-wide throttle mid-poll
    });
    await sync([iss("KAN-1", "In Progress", ["agent:working", "pr:merged"])]);
    expect(jira.calls).toEqual([]);
  });

  // KAN-832/837 sharpening (epic comment on this ticket): cases 2 and 9 are the load-bearing
  // guard against a fix that never removes pr:* at all — assert the actual `remove:` Jira call,
  // not merely that stateFor returned null, so a suite-passing "always preserve" mutation fails.
  test("a genuine null prState (confirmed no PR / closed-unmerged) actually strips an existing pr:* label — case 2/9 guard", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "working"]]),
      prState: async () => null, // a confirmed miss or a closed-unmerged PR — genuine evidence of absence
    });
    await sync([iss("KAN-1", "In Progress", ["agent:working", "pr:approved"])]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["pr:approved"] }]);
  });

  test("an Epic never triggers pr:* discovery (KAN-824): prState is never called for issuetype Epic", async () => {
    const jira = fakeJira();
    let called = false;
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "working"]]),
      prState: async () => { called = true; throw new Error("must not be called for an Epic"); },
    });
    const issue = { ...iss("KAN-1", "In Progress", []), issuetype: "Epic" };
    await sync([issue]);
    expect(called).toBe(false);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:working"], remove: [] }]); // no pr:* label added, no throw
  });

  test("onPollEnd fires once per syncLabels run when supplied (KAN-824 poll boundary for PrTracker.endPoll)", async () => {
    const jira = fakeJira();
    let pollEnds = 0;
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"]]),
      onPollEnd: () => { pollEnds++; },
    });
    await sync([iss("KAN-1", "In Progress", [])]);
    await sync([iss("KAN-1", "In Progress", ["agent:idle"])]);
    expect(pollEnds).toBe(2);
  });

  test("pr:* disabled (no prState dep) never adds a pr:* label, agent:* unaffected", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]) });
    await sync([iss("KAN-1", "In Progress", ["pr:open"])]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: ["pr:open"] }]);
  });

  test("returns the set of keys written this poll", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"], ["KAN-2", "idle"]]) });
    const written = await sync([iss("KAN-1", "In Progress", []), iss("KAN-2", "In Progress", ["agent:idle"])]);
    expect([...written]).toEqual(["KAN-1"]);
  });

  test("onWrite fires once with the written keys; not at all when nothing was written", async () => {
    const jira = fakeJira();
    const onWriteCalls: string[][] = [];
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"], ["KAN-2", "idle"]]),
      onWrite: (keys) => onWriteCalls.push([...keys]),
    });
    await sync([iss("KAN-1", "In Progress", []), iss("KAN-2", "In Progress", ["agent:idle"])]);
    expect(onWriteCalls).toEqual([["KAN-1"]]);
    onWriteCalls.length = 0;
    await sync([iss("KAN-1", "In Progress", ["agent:idle"]), iss("KAN-2", "In Progress", ["agent:idle"])]); // no-op poll
    expect(onWriteCalls).toEqual([]);
  });

  test("done maps to agent:idle, not agent:working (herdr's done = sitting at its prompt)", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "done"]]) });
    await sync([iss("KAN-1", "In Progress", [])]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: [] }]);
  });

  test("a persistently failing write for one issue is isolated: other issues still get written, one log line, no throw", async () => {
    const jira = fakeJiraFailingFor("KAN-BAD");
    const logs: string[] = [];
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-BAD", "idle"], ["KAN-GOOD", "idle"]]),
      log: (line) => logs.push(line),
    });
    const written = await sync([iss("KAN-BAD", "In Progress", []), iss("KAN-GOOD", "In Progress", [])]);
    expect(jira.calls).toEqual([{ key: "KAN-GOOD", add: ["agent:idle"], remove: [] }]);
    expect([...written]).toEqual(["KAN-GOOD"]);
    expect(logs.some((l) => l.includes("KAN-BAD") && l.includes("write failed") && l.includes("403 forbidden"))).toBe(true);
  });

  test("a failed write is not recorded as applied: the key is retried, not treated as already-labeled", async () => {
    const failing = { on: true };
    const calls: Array<{ key: string; add: string[]; remove: string[] }> = [];
    const jira: LabelWriter = {
      async updateLabels(key, ops) {
        if (failing.on) throw new Error("timeout");
        calls.push({ key, add: [...(ops.add ?? [])], remove: [...(ops.remove ?? [])] });
      },
    };
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]), log: () => {} });
    await sync([iss("KAN-1", "In Progress", [])]); // write fails; not recorded in lastLabels
    failing.on = false;
    await sync([iss("KAN-1", "In Progress", [])]); // retried from the same starting labels, now succeeds
    expect(calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: [] }]);
  });

  test("stalled: takes precedence over idle, goes through the SAME 2-poll stabilizer as any other agent:* value", async () => {
    const jira = fakeJira();
    let stalledNow = false;
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"]]),
      stalled: { check: async () => stalledNow, forget: () => {} },
    });
    const issue = iss("KAN-1", "In Progress", []);
    await sync([issue]); // establishes agent:idle (first observation, no flip to confirm)
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: [] }]);

    jira.calls.length = 0;
    stalledNow = true;
    const issue2 = iss("KAN-1", "In Progress", ["agent:idle"]);
    await sync([issue2]); // 1st poll of "stalled" vs applied "idle": unconfirmed
    expect(jira.calls).toEqual([]);
    await sync([issue2]); // 2nd consecutive poll: confirmed
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:stalled"], remove: ["agent:idle"] }]);
  });

  test("stalled is never applied when the observed status isn't idle, even if the check reports true", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "working"]]),
      stalled: { check: async () => true, forget: () => {} },
    });
    await sync([iss("KAN-1", "In Progress", [])]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:working"], remove: [] }]);
  });

  test("the stalled log line fires immediately (unlike the label, not delayed by the stabilizer)", async () => {
    const jira = fakeJira();
    const logs: string[] = [];
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"]]),
      stalled: { check: async () => true, forget: () => {} },
      log: (l) => logs.push(l),
    });
    await sync([iss("KAN-1", "In Progress", ["agent:idle"])]); // label write still suppressed (1st poll)
    expect(jira.calls).toEqual([]);
    expect(logs.some((l) => l.includes("KAN-1") && l.includes("stalled"))).toBe(true);
  });

  // BUTCHR-210 (2026-09-02 second becalming, ~7.5h): existence alone isn't
  // enough on this per-poll line either — an operator must be able to tell
  // a 4-minute stall from an all-night one at a glance.
  test("the stalled log line includes elapsed minutes when the stalled dep exposes them", async () => {
    const jira = fakeJira();
    const logs: string[] = [];
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"]]),
      stalled: { check: async () => true, forget: () => {}, elapsedMinutes: () => 450 },
      log: (l) => logs.push(l),
    });
    await sync([iss("KAN-1", "In Progress", ["agent:idle"])]);
    expect(logs.some((l) => l.includes("KAN-1") && l.includes("stalled") && l.includes("450m"))).toBe(true);
  });

  test("the stalled log line omits elapsed minutes gracefully when the stalled dep doesn't expose them (existing fixtures unaffected)", async () => {
    const jira = fakeJira();
    const logs: string[] = [];
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"]]),
      stalled: { check: async () => true, forget: () => {} },
      log: (l) => logs.push(l),
    });
    await sync([iss("KAN-1", "In Progress", ["agent:idle"])]);
    const line = logs.find((l) => l.includes("KAN-1") && l.includes("stalled"));
    expect(line).toBeDefined();
    expect(line).not.toContain("undefined");
    expect(line).not.toMatch(/\(\d+m\)/);
  });

  test("a stalled check that could not verify (null) never writes agent:stalled onto a ticket that wasn't already labelled stalled, even across two consecutive polls", async () => {
    const jira = fakeJira();
    const logs: string[] = [];
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"]]),
      stalled: { check: async () => null, forget: () => {} },
      log: (l) => logs.push(l),
    });
    const issue = iss("KAN-1", "In Progress", ["agent:idle"]);
    await sync([issue]);
    await sync([issue]); // two consecutive polls — would be enough to confirm a real candidate
    expect(jira.calls).toEqual([]); // never wrote agent:stalled
    expect(logs.some((l) => l.includes("WARNING") && l.includes("KAN-1") && l.includes("could not verify"))).toBe(true);
  });

  test("REGRESSION: a stalled check that could not verify (null) never STRIPS an already-applied agent:stalled label, even across two consecutive polls", async () => {
    // Naively falling a `null` result through to the OBSERVED status ("idle" —
    // `check` only fetches comments once the idle/done streak already
    // qualifies) makes the candidate "idle" regardless of what's actually
    // applied. For a ticket that already carries agent:stalled from earlier
    // successful polls, that "idle" candidate goes through the SAME 2-poll
    // stabilizer any real transition uses and gets CONFIRMED on the second
    // consecutive null poll — silently erasing a true stalled signal on
    // exactly the sustained-degradation case this ticket cares about. The
    // fix must leave the applied label untouched instead of falling through
    // to `observed`.
    const jira = fakeJira();
    const logs: string[] = [];
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"]]),
      stalled: { check: async () => null, forget: () => {} },
      log: (l) => logs.push(l),
    });
    const issue = iss("KAN-1", "In Progress", ["agent:stalled"]);
    await sync([issue]);
    await sync([issue]); // two consecutive null polls — would be enough to confirm a flip to idle
    expect(jira.calls).toEqual([]); // agent:stalled was never removed
    expect(logs.some((l) => l.includes("WARNING") && l.includes("KAN-1") && l.includes("could not verify"))).toBe(true);
  });

  test("leaving the active set forgets the stalled tracker's state for that ticket", async () => {
    const jira = fakeJira();
    const forgotten: string[] = [];
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"]]),
      stalled: { check: async () => false, forget: (k) => forgotten.push(k) },
    });
    await sync([iss("KAN-1", "In Progress", [])]);
    await sync([]); // KAN-1 leaves the active set
    expect(forgotten).toEqual(["KAN-1"]);
  });

  test("a permanently failing write logs 'write failed' exactly once, not once per poll; a change in reason logs again", async () => {
    const jira: LabelWriter = {
      async updateLabels() { throw new Error("403 forbidden"); },
    };
    const logs: string[] = [];
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]), log: (l) => logs.push(l) });
    await sync([iss("KAN-1", "In Progress", [])]);
    await sync([iss("KAN-1", "In Progress", [])]);
    await sync([iss("KAN-1", "In Progress", [])]);
    expect(logs.filter((l) => l.includes("KAN-1") && l.includes("write failed")).length).toBe(1);
  });

  test("a failing write on the disappearance-cleanup path is retried on a later poll instead of being dropped", async () => {
    const failing = { on: false };
    const calls: Array<{ key: string; add: string[]; remove: string[] }> = [];
    const jira: LabelWriter = {
      async updateLabels(key, ops) {
        if (failing.on) throw new Error("503 unavailable");
        calls.push({ key, add: [...(ops.add ?? [])], remove: [...(ops.remove ?? [])] });
      },
    };
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]), log: () => {} });
    await sync([iss("KAN-1", "In Progress", [])]); // establishes agent:idle
    calls.length = 0;
    failing.on = true;
    await sync([]); // disappears; cleanup write fails
    expect(calls).toEqual([]);
    failing.on = false;
    await sync([]); // still gone; cleanup retried, now succeeds
    expect(calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:idle"] }]);
  });

  // BUTCHR-179: syncLabels is the worked example (promoted to the STANDARD
  // a coverage consumer must match) of correctly distinguishing all three
  // stalled.check() outcomes. These tests are the CONSUMER half of that
  // ticket: they prove `deps.coverage` is fed the right verb for each of
  // the three states, not a naive `x === true`/`!x` collapse that would
  // silently merge "not found" and "could not check" (or "found" and "not
  // found") into the same bucket one line below the fix that removed the
  // original collapse.
  describe("coverage recording (BUTCHR-179)", () => {
    function fakeCoverage() {
      const calls: Array<{ op: "checked" | "declined"; name: string }> = [];
      return { calls, recordChecked: (name: string) => calls.push({ op: "checked", name }), recordDeclined: (name: string) => calls.push({ op: "declined", name }) };
    }

    test("check() resolves true (found): recordChecked fires, recordDeclined never does", async () => {
      const coverage = fakeCoverage();
      const sync = createLabelSync({
        jira: fakeJira(),
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => true, forget: () => {} },
        coverage,
      });
      await sync([iss("KAN-1", "In Progress", ["agent:idle"])]);
      expect(coverage.calls).toEqual([{ op: "checked", name: "stalled" }]);
    });

    test("check() resolves false (checked, not found): recordChecked fires — this is NOT a decline", async () => {
      const coverage = fakeCoverage();
      const sync = createLabelSync({
        jira: fakeJira(),
        agentStatuses: async () => new Map([["KAN-1", "working"]]),
        stalled: { check: async () => false, forget: () => {} },
        coverage,
      });
      await sync([iss("KAN-1", "In Progress", [])]);
      expect(coverage.calls).toEqual([{ op: "checked", name: "stalled" }]);
    });

    test("check() resolves null (could not check): recordDeclined fires — the naive-collapse trap this criterion exists to catch", async () => {
      const coverage = fakeCoverage();
      const sync = createLabelSync({
        jira: fakeJira(),
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => null, forget: () => {} },
        coverage,
      });
      await sync([iss("KAN-1", "In Progress", ["agent:idle"])]);
      expect(coverage.calls).toEqual([{ op: "declined", name: "stalled" }]);
    });

    test("all three states across consecutive polls produce three DISTINCT verbs, in order — nothing collapses", async () => {
      const coverage = fakeCoverage();
      const results: Array<boolean | null> = [true, false, null];
      let i = 0;
      const sync = createLabelSync({
        jira: fakeJira(),
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => results[i++]!, forget: () => {} },
        coverage,
      });
      const issue = iss("KAN-1", "In Progress", ["agent:idle"]);
      await sync([issue]);
      await sync([issue]);
      await sync([issue]);
      expect(coverage.calls).toEqual([
        { op: "checked", name: "stalled" },
        { op: "checked", name: "stalled" },
        { op: "declined", name: "stalled" },
      ]);
    });

    test("no stalled checker configured (feature disabled): coverage is never touched — an absent detector must not claim coverage", async () => {
      const coverage = fakeCoverage();
      const sync = createLabelSync({
        jira: fakeJira(),
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        coverage,
        // no `stalled` dep at all
      });
      await sync([iss("KAN-1", "In Progress", [])]);
      expect(coverage.calls).toEqual([]);
    });

    test("omitting coverage entirely (existing callers/fixtures) does not throw — fully backward compatible", async () => {
      const sync = createLabelSync({
        jira: fakeJira(),
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => null, forget: () => {} },
      });
      await expect(sync([iss("KAN-1", "In Progress", ["agent:idle"])])).resolves.toBeInstanceOf(Set);
    });
  });

  // BUTCHR-221/BUTCHR-210: the stall remediator is wired as an OPTIONAL dep,
  // called with the ALREADY-APPLIED label (never this poll's just-stabilized
  // candidate) — see src/agents/stall-remediation.ts's own top comment for
  // why that gating specifically avoids the own-write ledger hazard.
  describe("stallRemediation wiring (BUTCHR-221/BUTCHR-210)", () => {
    function fakeRemediator() {
      const calls: Array<{ issue: string; labelApplied: boolean; stalledPollResult: boolean | null; realElapsedMinutes: number | null | undefined }> = [];
      const forgotten: string[] = [];
      return {
        calls,
        forgotten,
        check: async (issue: string, labelApplied: boolean, stalledPollResult: boolean | null, realElapsedMinutes?: number | null) => {
          calls.push({ issue, labelApplied, stalledPollResult, realElapsedMinutes });
          return { kind: "not-a-candidate" as const, issue };
        },
        forget: (issue: string) => forgotten.push(issue),
      };
    }

    test("called with labelApplied=false on the SAME poll the label first stabilizes to stalled (never more eagerly than one poll behind the write)", async () => {
      const jira = fakeJira();
      const rem = fakeRemediator();
      const sync = createLabelSync({
        jira,
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => true, forget: () => {} },
        stallRemediation: rem,
      });
      const issue = iss("KAN-1", "In Progress", ["agent:idle"]);
      await sync([issue]); // 1st confirming poll: label still applied="idle"
      await sync([issue]); // 2nd confirming poll: label WRITES to stalled this poll, but `applied` (read at the top) is still "idle"
      expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:stalled"], remove: ["agent:idle"] }]);
      expect(rem.calls.every((c) => c.labelApplied === false)).toBe(true);
    });

    test("called with labelApplied=true starting the poll AFTER the write lands — never the same poll", async () => {
      const jira = fakeJira();
      const rem = fakeRemediator();
      const sync = createLabelSync({
        jira,
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => true, forget: () => {} },
        stallRemediation: rem,
      });
      await sync([iss("KAN-1", "In Progress", ["agent:idle"])]); // unconfirmed
      await sync([iss("KAN-1", "In Progress", ["agent:idle"])]); // confirmed + written this poll — applied still "idle" going in
      rem.calls.length = 0;
      await sync([iss("KAN-1", "In Progress", ["agent:stalled"])]); // NOW applied="stalled", read fresh this poll
      expect(rem.calls).toEqual([{ issue: "KAN-1", labelApplied: true, stalledPollResult: true, realElapsedMinutes: null }]);
    });

    test("the raw stalled.check() three-state result is threaded through UNCOLLAPSED (true/false/null all distinct)", async () => {
      const jira = fakeJira();
      const rem = fakeRemediator();
      const results: Array<boolean | null> = [true, false, null];
      let i = 0;
      const sync = createLabelSync({
        jira,
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => results[i++]!, forget: () => {} },
        stallRemediation: rem,
      });
      const issue = iss("KAN-1", "In Progress", ["agent:idle"]);
      await sync([issue]);
      await sync([issue]);
      await sync([issue]);
      expect(rem.calls.map((c) => c.stalledPollResult)).toEqual([true, false, null]);
    });

    test("elapsedMinutes is passed through from the stalled dep when present", async () => {
      const jira = fakeJira();
      const rem = fakeRemediator();
      const sync = createLabelSync({
        jira,
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => true, forget: () => {}, elapsedMinutes: () => 42 },
        stallRemediation: rem,
      });
      await sync([iss("KAN-1", "In Progress", ["agent:idle"])]);
      expect(rem.calls[0]!.realElapsedMinutes).toBe(42);
    });

    test("elapsedMinutes defaults to null when the stalled dep omits it (existing fixtures unaffected)", async () => {
      const jira = fakeJira();
      const rem = fakeRemediator();
      const sync = createLabelSync({
        jira,
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => true, forget: () => {} },
        stallRemediation: rem,
      });
      await sync([iss("KAN-1", "In Progress", ["agent:idle"])]);
      expect(rem.calls[0]!.realElapsedMinutes).toBe(null);
    });

    test("forget is called on the inactive-status path", async () => {
      const jira = fakeJira();
      const rem = fakeRemediator();
      const sync = createLabelSync({
        jira,
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => false, forget: () => {} },
        stallRemediation: rem,
      });
      await sync([iss("KAN-1", "Done", ["agent:idle"])]);
      expect(rem.forgotten).toEqual(["KAN-1"]);
    });

    test("forget is called when a ticket disappears from the feed", async () => {
      const jira = fakeJira();
      const rem = fakeRemediator();
      const sync = createLabelSync({
        jira,
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => false, forget: () => {} },
        stallRemediation: rem,
      });
      await sync([iss("KAN-1", "In Progress", [])]);
      rem.forgotten.length = 0;
      await sync([]); // KAN-1 disappears
      expect(rem.forgotten).toEqual(["KAN-1"]);
    });

    test("omitting stallRemediation entirely (existing callers/fixtures) does not throw", async () => {
      const jira = fakeJira();
      const sync = createLabelSync({
        jira,
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => true, forget: () => {} },
      });
      await expect(sync([iss("KAN-1", "In Progress", ["agent:idle"])])).resolves.toBeInstanceOf(Set);
    });

    test("stallRemediation is never invoked while the ticket is inactive", async () => {
      const jira = fakeJira();
      const rem = fakeRemediator();
      const sync = createLabelSync({
        jira,
        agentStatuses: async () => new Map([["KAN-1", "idle"]]),
        stalled: { check: async () => true, forget: () => {} },
        stallRemediation: rem,
      });
      await sync([iss("KAN-1", "Done", ["agent:idle"])]);
      expect(rem.calls).toEqual([]);
    });
  });

  // BUTCHR-279: the whole path, real dependencies (createStalledCheck +
  // createStallRemediator, not stubs), driven poll-by-poll through
  // createLabelSync exactly as src/daemon/index.ts wires them. The tracker
  // qualifying is necessary but not sufficient evidence the remediator gets
  // its trigger — labelApplied only becomes true once the stabilizer has
  // confirmed agent:stalled AND a later poll reads it back from Jira, so this
  // proves the wiring, not just StalledTracker's own arithmetic (see
  // test/unit/stalled.test.ts for that).
  describe("BUTCHR-279: a post-work stall reaches the remediator end-to-end", () => {
    /** Replays jira.calls' diffs onto a locally-held label array, exactly as real Jira state would accumulate across polls. */
    function statefulIssue(key: string, status: string) {
      let labels: string[] = [];
      let seen = 0;
      return {
        current: () => labels,
        issue: () => iss(key, status, labels),
        absorb: (jira: { calls: Array<{ key: string; add: string[]; remove: string[] }> }) => {
          for (const call of jira.calls.slice(seen)) {
            if (call.key !== key) continue;
            labels = [...labels.filter((l) => !call.remove.includes(l)), ...call.add];
          }
          seen = jira.calls.length;
        },
      };
    }

    test("FIRES: worked, then idle/done continuously for the full window, zero daemon comments — reaches the remediator with labelApplied true", async () => {
      let now = 0;
      let agentState: string | null = "working";
      const jira = fakeJira();
      const posted: Array<{ issue: string; text: string }> = [];
      const stalled = createStalledCheck({ now: () => now, minutes: 10, comments: async () => [] });
      const stallRemediation = createStallRemediator({
        now: () => now,
        addComment: async (issue, text) => { posted.push({ issue, text }); },
        comments: async () => [],
      });
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map(agentState ? [["KAN-1", agentState]] : []), stalled, stallRemediation });
      const st = statefulIssue("KAN-1", "In Progress");

      // Poll 1: agent is working.
      await sync([st.issue()]); st.absorb(jira);
      expect(st.current()).toEqual(["agent:working"]);
      expect(posted).toEqual([]);

      // Poll 2 (t=5m): agent stops working — herdr now reports idle. Floor starts here.
      now = 5 * 60_000; agentState = "idle";
      await sync([st.issue()]); st.absorb(jira);
      expect(posted).toEqual([]); // agent:idle flip not even confirmed yet (stabilizer)

      // Poll 3 (t=10m): idle confirmed twice in a row — agent:idle is written.
      now = 10 * 60_000;
      await sync([st.issue()]); st.absorb(jira);
      expect(st.current()).toEqual(["agent:idle"]);
      expect(posted).toEqual([]);

      // Poll 4 (t=15m): 10 minutes of idle since the floor started (t=5m) — tracker
      // qualifies, but agent:stalled needs its own 2-poll stabilizer confirmation.
      now = 15 * 60_000;
      await sync([st.issue()]); st.absorb(jira);
      expect(st.current()).toEqual(["agent:idle"]); // not written yet — first confirmation
      expect(posted).toEqual([]);

      // Poll 5 (t=20m): agent:stalled confirmed and written — but `applied` was
      // read at the TOP of this poll (still "idle"), so the remediator does not
      // yet see labelApplied=true. Necessary-but-not-sufficient, demonstrated.
      now = 20 * 60_000;
      await sync([st.issue()]); st.absorb(jira);
      expect(st.current()).toEqual(["agent:stalled"]); // label IS applied in Jira now
      expect(posted).toEqual([]); // but the remediator has not acted yet

      // Poll 6 (t=25m): THIS poll reads agent:stalled back from Jira as `applied`
      // — only now does the remediator fire.
      now = 25 * 60_000;
      await sync([st.issue()]); st.absorb(jira);
      expect(st.current()).toEqual(["agent:stalled"]);
      expect(posted.length).toBe(1);
      expect(posted[0]!.issue).toBe("KAN-1");
      expect(posted[0]!.text).toContain("agent:stalled");
    });

    test("DOES NOT FIRE: worked, then disappeared entirely (sustained agent:none) — never labelled stalled, never reaches the remediator", async () => {
      let now = 0;
      let agentState: string | null = "working";
      const jira = fakeJira();
      const posted: Array<{ issue: string; text: string }> = [];
      const stalled = createStalledCheck({ now: () => now, minutes: 10, comments: async () => [] });
      const stallRemediation = createStallRemediator({
        now: () => now,
        addComment: async (issue, text) => { posted.push({ issue, text }); },
        comments: async () => [],
      });
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map(agentState ? [["KAN-1", agentState]] : []), stalled, stallRemediation });
      const st = statefulIssue("KAN-1", "In Progress");

      await sync([st.issue()]); st.absorb(jira); // working
      agentState = null; // agent disappears entirely

      // Many polls, sustained "none", well past the stall window in wall-clock terms.
      for (let i = 1; i <= 6; i++) {
        now = i * 30 * 60_000; // 30 minutes apart
        await sync([st.issue()]); st.absorb(jira);
      }

      expect(st.current()).toEqual(["agent:none"]); // never agent:stalled
      expect(posted).toEqual([]); // remediator never invoked with labelApplied=true
    });

    // BUTCHR-207's binding condition on this ticket's tradeoff, given the
    // same end-to-end treatment as the sustained-none case above: a
    // genuinely long `working`-reported run, turn-taking with a repeated
    // between-turn idle dip, must never write agent:stalled or reach the
    // remediator — asserted after EVERY poll across the run, not just at the
    // end, so a regression that only intermittently held the guard cannot
    // hide between assertions.
    test("DOES NOT FIRE: a healthy long-running agent, turn-taking between working and brief idle dips for hours, never becomes agent:stalled and never reaches the remediator", async () => {
      let now = 0;
      let agentState = "working";
      const jira = fakeJira();
      const posted: Array<{ issue: string; text: string }> = [];
      const stalled = createStalledCheck({ now: () => now, minutes: 10, comments: async () => [] });
      const stallRemediation = createStallRemediator({
        now: () => now,
        addComment: async (issue, text) => { posted.push({ issue, text }); },
        comments: async () => [],
      });
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", agentState]]), stalled, stallRemediation });
      const st = statefulIssue("KAN-1", "In Progress");

      const CYCLE_MS = 20 * 60_000; // 20-minute turn
      const DIP_MS = 5 * 60_000; // 5-minute idle dip between turns — under the 10-minute stall window
      for (let turn = 0; turn < 30; turn++) {
        const turnStart = turn * CYCLE_MS;

        now = turnStart; agentState = "working";
        await sync([st.issue()]); st.absorb(jira);
        expect(st.current()).not.toContain("agent:stalled");

        now = turnStart + (CYCLE_MS - DIP_MS); agentState = "idle";
        await sync([st.issue()]); st.absorb(jira);
        expect(st.current()).not.toContain("agent:stalled");

        now = turnStart + CYCLE_MS - 60_000; // 4 minutes into the dip — still well under the window
        await sync([st.issue()]); st.absorb(jira);
        expect(st.current()).not.toContain("agent:stalled");
      }

      // Total simulated span: 30 * 20min = 10 hours, ninety polls, never once
      // reaching agent:stalled and never once invoking the remediator.
      expect(posted).toEqual([]);
    });
  });

  // BUTCHR-289: the comments gate itself, driven end-to-end through the real
  // modules — DoD 5's explicit instruction to extend the BUTCHR-279 harness
  // "with a comment list containing a real agent report", not the
  // zero-comments shape that was never broken. `fakeCommentStore` is shared
  // between `stalled`'s and `stallRemediation`'s own `comments` deps (and
  // `addComment` writes into the SAME store), exactly as `AtlassianClient`
  // is one shared read/write surface in the real daemon.
  describe("BUTCHR-289: the kind×recency comments gate, end-to-end", () => {
    function statefulIssue(key: string, status: string) {
      let labels: string[] = [];
      let seen = 0;
      return {
        current: () => labels,
        issue: () => iss(key, status, labels),
        absorb: (jira: { calls: Array<{ key: string; add: string[]; remove: string[] }> }) => {
          for (const call of jira.calls.slice(seen)) {
            if (call.key !== key) continue;
            labels = [...labels.filter((l) => !call.remove.includes(l)), ...call.add];
          }
          seen = jira.calls.length;
        },
      };
    }

    /** A shared, in-memory comment store — the same shape AtlassianClient.comments returns, fed to both the detector and the remediator, mutated by addComment exactly as a real Jira ticket accumulates comments. */
    function fakeCommentStore() {
      const rows: Array<{ id: string; body: string; created: string }> = [];
      let n = 0;
      return {
        post: (body: string, at: number) => { rows.push({ id: `c${++n}`, body, created: new Date(at).toISOString() }); },
        read: async () => [...rows].reverse(), // newest-first, like AtlassianClient.comments' own orderBy: -created
      };
    }

    // DoD 1/5: the exact defect scenario, driven through the real modules —
    // an agent posts its own progress report (while still working), then
    // goes idle for the full window. Under the OLD authorEmail-based gate
    // this comment (same account as the daemon) would have disqualified the
    // ticket FOREVER, so the remediator would never fire. Under the new
    // kind×recency rule the report predates the idle streak and does not
    // disqualify — the mechanism is REACHABLE with a real report present,
    // not just the empty-comments shape the old FIRES test proved.
    test("FIRES even with a real agent progress report already on the ticket, posted before the idle streak began", async () => {
      let now = 0;
      let agentState: string | null = "working";
      const jira = fakeJira();
      const posted: Array<{ issue: string; text: string }> = [];
      const cs = fakeCommentStore();
      cs.post("[KAN-1] Finished this turn's work: implemented the fix, tests green. Going idle now.", 0);
      const stalled = createStalledCheck({ now: () => now, minutes: 10, comments: cs.read });
      const stallRemediation = createStallRemediator({
        now: () => now,
        addComment: async (issue, text) => { posted.push({ issue, text }); },
        comments: cs.read,
      });
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map(agentState ? [["KAN-1", agentState]] : []), stalled, stallRemediation });
      const st = statefulIssue("KAN-1", "In Progress");

      await sync([st.issue()]); st.absorb(jira); // t=0: working
      now = 5 * 60_000; agentState = "idle";
      await sync([st.issue()]); st.absorb(jira); // t=5: floor starts (report at t=0 predates this)
      now = 10 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=10: agent:idle written
      expect(st.current()).toEqual(["agent:idle"]);
      now = 15 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=15: tracker qualifies, stabilizer unconfirmed
      now = 20 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=20: agent:stalled written this poll
      now = 25 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=25: labelApplied true this poll — remediator fires
      expect(st.current()).toEqual(["agent:stalled"]);
      expect(posted.length).toBe(1);
      expect(posted[0]!.issue).toBe("KAN-1");
    });

    // DoD 4 / the "one consequence you must think about" callout: the wake
    // comment is `[butchr:stall]`-prefixed chatter, so it no longer
    // disqualifies the comments gate the way it used to under the old
    // authorship rule — the label is now STICKY (stays applied) rather than
    // self-clearing. Fails if: the label ever reverts away from
    // agent:stalled while the ticket is genuinely still idle (sticky claim),
    // OR if `posted.length` is ever anything but 1 (no-flood claim) across
    // many consecutive polls at the daemon's real ~15s cadence.
    test("NO FLOOD: once stalled, the label stays applied (sticky) across many consecutive polls, but exactly ONE wake comment is ever posted", async () => {
      let now = 0;
      let agentState: string | null = "working";
      const jira = fakeJira();
      const posted: Array<{ issue: string; text: string }> = [];
      const cs = fakeCommentStore();
      const stalled = createStalledCheck({ now: () => now, minutes: 10, comments: cs.read });
      const stallRemediation = createStallRemediator({
        now: () => now,
        addComment: async (issue, text) => { posted.push({ issue, text }); cs.post(text, now); },
        comments: cs.read,
      });
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map(agentState ? [["KAN-1", agentState]] : []), stalled, stallRemediation });
      const st = statefulIssue("KAN-1", "In Progress");

      await sync([st.issue()]); st.absorb(jira);
      now = 5 * 60_000; agentState = "idle";
      await sync([st.issue()]); st.absorb(jira);
      now = 10 * 60_000;
      await sync([st.issue()]); st.absorb(jira);
      now = 15 * 60_000;
      await sync([st.issue()]); st.absorb(jira);
      now = 20 * 60_000;
      await sync([st.issue()]); st.absorb(jira);
      now = 25 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // wake comment posted here
      expect(posted.length).toBe(1);
      expect(st.current()).toEqual(["agent:stalled"]);

      // The ticket remains genuinely idle, with only the wake comment (daemon
      // chatter) on it — 200 more polls at the daemon's real ~15s cadence.
      for (let i = 1; i <= 200; i++) {
        now = 25 * 60_000 + i * 15_000;
        await sync([st.issue()]); st.absorb(jira);
        expect(st.current()).toEqual(["agent:stalled"]); // sticky: never self-clears
      }
      expect(posted.length).toBe(1); // still exactly one wake comment
    });

    // The epic's added scenario (comment on this ticket after the original
    // DoD was written): a wake that WORKS — the agent takes a turn, goes
    // idle again, and genuinely re-stalls — must not produce a second wake
    // comment. The recurrence is stopped one layer down, in the
    // remediator's own evidence-based `findMarked` adoption (which outlives
    // the in-memory `spokenAt` latch StallRemediationTracker.forget drops
    // the moment `labelApplied` goes false) — not in this ticket's own
    // comments gate, which structurally CANNOT stop it: the agent's own
    // reply, posted while working, necessarily predates the next idle
    // streak (`idleSince` is only ever set by the first `idle` observation,
    // which comes after that reply), so it never disqualifies the new
    // streak — the ticket DOES become a candidate again, by design. This
    // test fails if `posted.length` is ever more than 1 at any point after
    // the re-stall — that would mean the adoption dedupe was not actually
    // reached through the real wiring, only provable in stall-remediation.ts's
    // own module-level tests (which hand-set labelApplied directly).
    test("re-stall after a successful wake posts at most one wake comment total (evidence-based adoption survives the episode boundary)", async () => {
      let now = 0;
      let agentState: string | null = "working";
      const jira = fakeJira();
      const posted: Array<{ issue: string; text: string }> = [];
      const cs = fakeCommentStore();
      const stalled = createStalledCheck({ now: () => now, minutes: 10, comments: cs.read });
      const stallRemediation = createStallRemediator({
        now: () => now,
        addComment: async (issue, text) => { posted.push({ issue, text }); cs.post(text, now); },
        comments: cs.read,
      });
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map(agentState ? [["KAN-1", agentState]] : []), stalled, stallRemediation });
      const st = statefulIssue("KAN-1", "In Progress");

      // --- Episode 1: work -> idle -> stall -> wake ---
      await sync([st.issue()]); st.absorb(jira); // t=0: working
      now = 5 * 60_000; agentState = "idle";
      await sync([st.issue()]); st.absorb(jira); // t=5
      now = 10 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=10: agent:idle written
      now = 15 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=15: tracker qualifies, stabilizer unconfirmed
      now = 20 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=20: agent:stalled written this poll
      now = 25 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=25: wake posted
      expect(posted.length).toBe(1);
      expect(st.current()).toEqual(["agent:stalled"]);

      // --- The wake works: the agent takes a turn ---
      now = 30 * 60_000; agentState = "working";
      await sync([st.issue()]); st.absorb(jira); // t=30: candidate "working" vs applied "stalled" — unconfirmed
      expect(st.current()).toEqual(["agent:stalled"]);
      now = 35 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=35: confirmed — agent:working written
      expect(st.current()).toEqual(["agent:working"]);
      expect(posted.length).toBe(1); // still just the original wake

      // The agent posts its own reply WHILE working — this necessarily
      // predates the next idle streak's `idleSince`.
      cs.post("[KAN-1] Still waiting on the external process. Going idle again.", 38 * 60_000);

      now = 40 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=40: applied freshly "working" — remediator's spokenAt is forgotten here
      expect(st.current()).toEqual(["agent:working"]);

      // --- The agent goes idle again: a genuinely NEW streak ---
      now = 45 * 60_000; agentState = "idle";
      await sync([st.issue()]); st.absorb(jira); // t=45: floor starts here — the reply (38min) predates it
      now = 50 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=50: agent:idle confirmed & written
      expect(st.current()).toEqual(["agent:idle"]);
      now = 55 * 60_000; // 10 min since the NEW floor (45min) — the ticket IS a candidate again
      await sync([st.issue()]); st.absorb(jira); // t=55: stabilizer unconfirmed (1st poll of "stalled")
      now = 60 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=60: agent:stalled confirmed & written this poll
      now = 65 * 60_000;
      await sync([st.issue()]); st.absorb(jira); // t=65: labelApplied true — remediator ADOPTS the existing wake comment
      expect(st.current()).toEqual(["agent:stalled"]);
      expect(posted.length).toBe(1); // exactly one wake comment across the WHOLE sequence, including the re-stall
    });
  });

  // BUTCHR-352: `withheld` reads THIS poll's admission census for the
  // withheld set (or the literal "unknown" when the census could not check)
  // and threads it into desiredLabels — end-to-end through the real Jira
  // diff, same style as the pr:* "unknown" tests above.
  describe("withheld (BUTCHR-352)", () => {
    test("no probe wired at all: admission:withheld is never emitted (today's exact pre-BUTCHR-352 behaviour)", async () => {
      const jira = fakeJira();
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map() });
      await sync([iss("KAN-1", "In Progress", [])]);
      expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:none"], remove: [] }]);
    });

    test("a key in the trusted withheld set gets agent:none PLUS admission:withheld, in one write", async () => {
      const jira = fakeJira();
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map(), withheld: () => new Set(["KAN-1"]) });
      await sync([iss("KAN-1", "In Progress", [])]);
      expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:none", "admission:withheld"], remove: [] }]);
    });

    test("a key NOT in the trusted withheld set gets agent:none alone", async () => {
      const jira = fakeJira();
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map(), withheld: () => new Set(["KAN-999"]) });
      await sync([iss("KAN-1", "In Progress", [])]);
      expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:none"], remove: [] }]);
    });

    // THE REGRESSION TRAP: a withheld key with a RUNNING agent must never
    // get admission:withheld — desiredLabels' own "only when label===none"
    // guard is what this pins end-to-end, through the real agentStatuses
    // wiring rather than a hand-built DesiredInput.
    test("a withheld key with a RUNNING agent gets its real agent:* label, never admission:withheld", async () => {
      const jira = fakeJira();
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "working"]]), withheld: () => new Set(["KAN-1"]) });
      await sync([iss("KAN-1", "In Progress", [])]);
      expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:working"], remove: [] }]);
    });

    // THE TWO-FLIPS-PER-EPISODE BOUND (BUTCHR-311's second correction): a
    // census decline ("unknown") mid-episode must cause ZERO Jira writes —
    // it re-emits the existing marker, which diffs to no-op.
    test('a "checked: false" (unknown) poll mid-episode causes ZERO Jira writes — holds the last TRUSTED marker', async () => {
      const jira = fakeJira();
      const withheldState = { mode: "withheld" as "withheld" | "unknown" | "clear" };
      const sync = createLabelSync({
        jira,
        agentStatuses: async () => new Map(),
        withheld: () => (withheldState.mode === "unknown" ? "unknown" : withheldState.mode === "withheld" ? new Set(["KAN-1"]) : new Set()),
      });
      // poll 1: confirmed withheld — ON, one write
      await sync([iss("KAN-1", "In Progress", [])]);
      expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:none", "admission:withheld"], remove: [] }]);
      jira.calls.length = 0;

      // poll 2 & 3: census declines (residency threw / untrusted zero) — re-emits the SAME marker, zero writes
      withheldState.mode = "unknown";
      await sync([iss("KAN-1", "In Progress", ["agent:none", "admission:withheld"])]);
      await sync([iss("KAN-1", "In Progress", ["agent:none", "admission:withheld"])]);
      expect(jira.calls).toEqual([]);

      // poll 4: confirmed NOT withheld — OFF, one write
      withheldState.mode = "clear";
      await sync([iss("KAN-1", "In Progress", ["agent:none", "admission:withheld"])]);
      expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["admission:withheld"] }]);
    });

    test("a genuinely confirmed-not-withheld poll (not \"unknown\") DOES clear an existing marker — the guard against KAN-814-style stickiness", async () => {
      const jira = fakeJira();
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map(), withheld: () => new Set() });
      await sync([iss("KAN-1", "In Progress", ["agent:none", "admission:withheld"])]);
      expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["admission:withheld"] }]);
    });

    // BUTCHR-352: admission:* is lifecycle-bound to active status the same
    // way agent:* is — leaving the active set clears BOTH in the same write.
    test("a withheld ticket leaving the active status set has admission:withheld cleared alongside agent:*", async () => {
      const jira = fakeJira();
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map(), withheld: () => new Set(["KAN-1"]) });
      await sync([iss("KAN-1", "In Progress", [])]);
      jira.calls.length = 0;
      await sync([iss("KAN-1", "Done", ["agent:none", "admission:withheld"])]);
      expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:none", "admission:withheld"] }]);
    });

    // Same disappearance-from-the-feed path agent:* already covers (the
    // `for (const key of [...lastLabels.keys()])` loop) — admission:* rides
    // along via isActiveStatusLabel (src/labels/plan.ts), not a second path.
    test("a withheld ticket disappearing from the feed entirely has admission:withheld cleared too", async () => {
      const jira = fakeJira();
      const sync = createLabelSync({ jira, agentStatuses: async () => new Map(), withheld: () => new Set(["KAN-1"]) });
      await sync([iss("KAN-1", "In Progress", [])]); // establishes agent:none + admission:withheld
      jira.calls.length = 0;
      await sync([]); // KAN-1 no longer active/visible
      expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:none", "admission:withheld"] }]);
    });
  });
});
