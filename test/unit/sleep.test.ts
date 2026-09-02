import { describe, expect, test } from "bun:test";
import { planReconcile, ACTIVE_STATUSES } from "../../src/reconcile/plan.js";
import { desiredFrom, atRestFrom, runResourceLoop } from "../../src/daemon/loop.js";
import { ISSUE_ACTIVATION } from "../../src/resources/issue.js";
import type { Herd } from "../../src/agents/herd.js";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { ResourceType } from "../../src/resources/types.js";

/**
 * BUTCHR-66/83 — sleep as a third `Activation<T>` verdict ("active" |
 * "asleep" | "inactive"), and the reconciler/wake-mechanism consequences of
 * that widening. See src/resources/types.ts's `ActivationVerdict` doc
 * comment for the semantics being proven here, and
 * test/unit/resource-type-second-instance.test.ts (BUTCHR-64/69) for the
 * `Widget`-fixture shape this file's `Sleeper` fixture follows — test-only,
 * living with the tests, not in production wiring, and deliberately NOT the
 * project resource type (BUTCHR-67, out of scope here).
 *
 * Every check below states its failure condition before the assertion, per
 * the ticket's own standard: a check whose failure you cannot describe is
 * decoration.
 */

function fakeHerd(initial: string[] = [], stale: Array<{ issue: string; reason: string; observedArgv: string[] }> = []): Herd & { spawned: string[]; stopped: string[]; running: Set<string> } {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [];
  return {
    running, spawned, stopped,
    async runningIssues() { return [...running]; },
    async staleIssues() { return stale.filter((s) => running.has(s.issue)); },
    async spawn(sp) { spawned.push(sp.key); running.add(sp.key); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
  };
}

const iss = (key: string, status: string): JiraIssue => ({ key, status, summary: "s", issuetype: "Task", assignee: "a", parent: null, updated: "t", labels: [] });

describe("planReconcile: the mid-exit race (BUTCHR-66/83, acceptance criterion 2/evidence-2)", () => {
  test("an asleep resource that IS still running (mid-exit) is never stopped, even though it's excluded from desired and flagged stale", () => {
    // THE RACE THIS CONSTRUCTS: a woken agent's last two acts are advance its
    // watermark, then exit. Between those two acts the resource reads
    // "asleep" WHILE ITS AGENT IS STILL RUNNING. Built directly here — S1 is
    // simultaneously: excluded from `desired` (asleep, so not wanted),
    // present in `running` (the agent hasn't exited yet), and flagged
    // `stale` (a poll landing in this exact window could easily also see a
    // stale-argv agent) — the precise intersection that window produces.
    // FAILS if `stop` (or `respawn`) contains "S1".
    const plan = planReconcile(["OTHER"], ["S1", "OTHER"], ["S1"], ["S1"]);
    expect(plan.stop).not.toContain("S1");
    expect(plan.respawn).not.toContain("S1");
    expect(plan.spawn).not.toContain("S1");
  });

  test("negative control: without the atRest exclusion, the naive stop = running - desired DOES catch it", () => {
    // Demonstrates the exact bug this fix prevents, not just the good
    // behaviour: the SAME inputs, minus `atRest`, reproduce the failure the
    // design calls out — an asleep-but-still-running resource gets stopped.
    // If this ever stops failing, `planReconcile`'s default has silently
    // changed and the positive test above is no longer proving what it
    // claims to.
    const plan = planReconcile(["OTHER"], ["S1", "OTHER"]);
    expect(plan.stop).toContain("S1");
  });
});

/** A resource with nothing issue-shaped about it — same spirit as BUTCHR-64/69's `Widget` fixture, but carrying its own `awake` field so a test can flip it between polls to model a wake. */
interface Sleeper {
  id: string;
  awake: boolean;
}

function sleeperResourceType(snapshots: readonly Sleeper[][]): ResourceType<Sleeper> {
  let call = -1;
  return {
    discovery: {
      idOf: (r) => r.id,
      search: async () => {
        call++;
        return [...snapshots[Math.min(call, snapshots.length - 1)]!];
      },
    },
    // Sleep as a third verdict, computed PURELY from the resource itself —
    // no event, diff, or reason parameter exists on this seam (BUTCHR-66/83
    // criterion 4/design ruling 3: verdictFor is synchronous and pure over T).
    activation: { verdictFor: (r) => (r.awake ? "active" : "asleep") },
    eventRules: {
      async poll() {
        return { changedPrimary: [], changedRelated: [], async decide() { return { deliver: false }; } };
      },
    },
    spawnConfig: { specFor: (r) => ({ key: r.id, issuetype: "sleeper", summary: r.id, parent: null }) },
  };
}

describe("rest is rest (BUTCHR-66/83 acceptance criterion 2, evidence-1)", () => {
  test("a sleeping resource — with no running agent, and even flagged stale by the herd — produces zero spawn/stop/respawn across many polls, and the poll/notify heartbeats keep firing", async () => {
    // FAILS if herd.spawn is called even once, or if stop/respawn is
    // produced at all — asleep means LEAVE ALONE in both directions.
    // S1 starts RUNNING (simulating an already-woken agent still mid-work)
    // AND is reported STALE by the herd every poll, which is exactly the
    // combination that would trip both the reconciler's stop path and the
    // respawn path if sleep were not excluded from both.
    const herd = fakeHerd(["S1"], [{ issue: "S1", reason: "argv lacks --x", observedArgv: [] }]);
    const resourceType = sleeperResourceType([[{ id: "S1", awake: false }]]);
    let pollSuccesses = 0;
    let notifySuccesses = 0;
    let respawns = 0;
    const stop = runResourceLoop(resourceType, {
      herd,
      notify: () => {},
      intervalMs: 10,
      onPollSuccess: () => { pollSuccesses++; },
      onNotifySuccess: () => { notifySuccesses++; },
      onRespawn: () => { respawns++; },
    });
    await new Promise((r) => setTimeout(r, 65));
    stop();
    expect(herd.spawned).toEqual([]);
    expect(herd.stopped).toEqual([]);
    expect(respawns).toBe(0);
    // Detector 11 (/health, src/daemon/health.ts): BUTCHR-57 built
    // onPollSuccess/onNotifySuccess as POSITIVE heartbeats, independent of
    // whether anything changed. A wholly-sleeping fleet must still read
    // healthy — FAILS if either stayed at 0, which would mean sleep silently
    // stalls the heartbeat instead of just the reconciler.
    expect(pollSuccesses).toBeGreaterThan(1);
    expect(notifySuccesses).toBeGreaterThan(1);
  });
});

describe("a woken agent derives its reason from the resource alone (BUTCHR-66/83 criterion 4, evidence-3)", () => {
  test("verdictFor is called with exactly the resource discovery returned — no event, diff, or reason ever passed in — and the wake (and its SpawnSpec) is driven purely by the resource's own field flipping between polls", async () => {
    // FAILS if verdictFor is ever invoked with more than one argument (a
    // payload smuggled in), or if the spawn that follows a wake needs
    // anything beyond the CURRENT poll's resource object to happen.
    const seenArgs: unknown[][] = [];
    const snapshots: Sleeper[][] = [
      [{ id: "S1", awake: false }], // poll 1: asleep — no spawn
      [{ id: "S1", awake: true }],  // poll 2+: the SAME id, now awake — nothing external told the loop why; the resource's own field did
    ];
    let call = -1;
    const resourceType: ResourceType<Sleeper> = {
      discovery: {
        idOf: (r) => r.id,
        search: async () => {
          call++;
          return [...snapshots[Math.min(call, snapshots.length - 1)]!];
        },
      },
      activation: {
        verdictFor: (...args: unknown[]) => {
          seenArgs.push(args);
          const r = args[0] as Sleeper;
          return r.awake ? "active" : "asleep";
        },
      },
      eventRules: { async poll() { return { changedPrimary: [], changedRelated: [], async decide() { return { deliver: false }; } }; } },
      spawnConfig: { specFor: (r) => ({ key: r.id, issuetype: "sleeper", summary: r.id, parent: null }) },
    };
    const herd = fakeHerd();
    const stop = runResourceLoop(resourceType, { herd, notify: () => {}, intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(herd.spawned).toContain("S1"); // it did wake and spawn
    expect(seenArgs.length).toBeGreaterThan(0);
    for (const args of seenArgs) {
      expect(args.length).toBe(1); // exactly the resource — no second (event/diff/reason) argument
      expect(args[0]).toMatchObject({ id: "S1" }); // and it's the raw resource discovery.search() returned, not a derived payload
    }
  });
});

describe("the lost-wake proof (BUTCHR-66/83 criterion 4, evidence-4)", () => {
  test("a wake whose spawn never actually starts an agent (crash, swallowed kickoff) is retried on the very next poll — because the watermark is only ever advanced by the agent itself, never by the daemon at spawn time", async () => {
    // FAILS if a dropped spawn is not re-attempted — which would mean the
    // wake reason had to survive IN something other than the resource's own
    // state (i.e. it was a payload after all).
    const spawnAttempts: string[] = [];
    const herd: Herd = {
      async runningIssues() { return []; }, // deliberately NEVER reflects a spawn — models a swallowed kickoff / crash-before-registering
      async staleIssues() { return []; },
      async spawn(sp) { spawnAttempts.push(sp.key); },
      async stop() {},
      async paneFor() { return null; },
      async nudge() { return { delivered: true }; },
    };
    // The resource wakes on poll 1 and STAYS awake (its own watermark can
    // only be advanced by the agent that never got to run) — exactly the
    // "unfinished business is still visible" property the ticket names.
    const resourceType = sleeperResourceType([[{ id: "S1", awake: true }]]);
    const stop = runResourceLoop(resourceType, { herd, notify: () => {}, intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 45));
    stop();
    expect(new Set(spawnAttempts)).toEqual(new Set(["S1"])); // never a different/wrong id
    expect(spawnAttempts.length).toBeGreaterThan(1); // FAILS here if the lost spawn was only ever attempted once
  });
});

describe("ISSUE_ACTIVATION cannot return asleep (BUTCHR-66/83 acceptance criterion 1/3, structural proof)", () => {
  test("every ACTIVE_STATUSES member, and a representative sample of non-active statuses, all resolve to active/inactive — never asleep", () => {
    // FAILS if verdictFor ever returns "asleep" for any status — the whole
    // point is that this is unreachable, not merely untested.
    const statuses = [...ACTIVE_STATUSES, "To Do", "Done", "Backlog", "", "Some Future Status Nobody Has Invented Yet"];
    for (const status of statuses) {
      const verdict = ISSUE_ACTIVATION.verdictFor(iss("KAN-1", status));
      expect(verdict).not.toBe("asleep");
      expect(["active", "inactive"]).toContain(verdict);
    }
  });

  test("agrees exactly with the unchanged isActive(status)/ACTIVE_STATUSES predicate — no fork", () => {
    // Pins BUTCHR-66/83's explicit non-negotiable: ISSUE_ACTIVATION
    // delegates to the SHARED src/reconcile/plan.ts predicate rather than
    // forking it (that predicate also backs the labels layer). FAILS if
    // this ever diverges from ACTIVE_STATUSES membership.
    for (const status of ["In Progress", "In Review", "To Do", "Done"]) {
      const expectActive = (ACTIVE_STATUSES as ReadonlySet<string>).has(status);
      expect(ISSUE_ACTIVATION.verdictFor(iss("KAN-1", status))).toBe(expectActive ? "active" : "inactive");
    }
  });
});

describe("desiredFrom / atRestFrom (BUTCHR-66/83 acceptance criterion 1, the reconciler detector)", () => {
  test("desiredFrom excludes both asleep and inactive; atRestFrom contains only asleep", () => {
    const items: Sleeper[] = [{ id: "AWAKE", awake: true }, { id: "REST", awake: false }];
    const rt = sleeperResourceType([items]);
    const desired = desiredFrom(items, rt);
    const atRest = atRestFrom(items, rt);
    expect([...desired.keys()]).toEqual(["AWAKE"]);
    expect([...atRest]).toEqual(["REST"]);
  });
});
