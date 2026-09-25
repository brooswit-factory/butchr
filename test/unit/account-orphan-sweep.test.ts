import { describe, expect, test } from "bun:test";
import { createAccountOrphanSweep } from "../../src/agents/account-orphan-sweep.js";
import { createAccountManager } from "../../src/accounts/manager.js";
import { fakeStore, fakeRcClient } from "../fixtures/rocketchat-fakes.js";
import type { AccountRecord } from "../../src/accounts/manager.js";
import { rcUsernameFor } from "../../src/accounts/identity.js";

const AGENT = "jira-work:triage:BUTCHR-1";
const AGENT2 = "jira-work:triage:BUTCHR-2";
const OLD_ENOUGH = "2020-01-01T00:00:00.000Z"; // any time comfortably more than MIN_RECORD_AGE_MS before the fixed `now` used below

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

function tickingNow(start: number) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function harness(records: AccountRecord[], residentSequence: Array<readonly string[] | Error>) {
  const store = fakeStore(records);
  const { client, calls } = fakeRcClient();
  const manager = createAccountManager({ client, store, userCapThreshold: 45, now: () => "2026-09-24T00:00:00.000Z", randomPassword: () => "fixed" });
  const released: string[] = [];
  const logs: string[] = [];
  let call = 0;
  const residentIssues = async (): Promise<readonly string[]> => {
    const next = residentSequence[Math.min(call, residentSequence.length - 1)]!;
    call++;
    if (next instanceof Error) throw next;
    return next;
  };
  const clock = tickingNow(NOW);
  const sweep = createAccountOrphanSweep({
    now: clock.now,
    reconcileOrphans: (agentExists) => manager.reconcileOrphans(agentExists),
    residentIssues,
    release: async (agentKey, reason) => { released.push(agentKey); await manager.releaseAccount(agentKey, reason); },
    log: (l) => logs.push(l),
  });
  return { sweep, store, calls, released, logs, clock };
}

describe("createAccountOrphanSweep (BUTCHR-412 review round 1, blocking finding 1)", () => {
  test("an agent that IS resident is never released, however many sweeps pass", async () => {
    const { sweep, store, released } = harness(
      [{ agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "temporary", createdAt: OLD_ENOUGH }],
      [[AGENT], [AGENT], [AGENT]],
    );
    await sweep.sweep();
    await sweep.sweep();
    await sweep.sweep();
    expect(released).toEqual([]);
    expect(await store.get(AGENT)).not.toBeNull();
  });

  // The ambiguous-pane/ONE-owned-pane-among-several-live shape itself is
  // pinned at the residency-census layer (test/unit/residency-census.test.ts:
  // aggregateVerdict(["dead","live","unknown"]) === "resident") — this
  // module only needs to prove it NEVER releases an id `residentIssues()`
  // reports, which is the whole point of using that check instead of
  // `runningIssues()`/`agent.list()` presence (see this module's own top
  // comment).
  test("an id residentIssues() reports (the ambiguous-pane / ANY-owned-pane-is-live case) is never released", async () => {
    const { sweep, store, released } = harness(
      [{ agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "temporary", createdAt: OLD_ENOUGH }],
      [[AGENT], [AGENT]],
    );
    await sweep.sweep();
    await sweep.sweep();
    expect(released).toEqual([]);
    expect(await store.get(AGENT)).not.toBeNull();
  });

  test("a mid-spawn agent (record younger than the minimum age) is never released even if absent from residentIssues() every sweep", async () => {
    const { sweep, store, released, clock } = harness(
      [{ agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "temporary", createdAt: new Date(NOW).toISOString() }], // created "now"
      [[], [], []],
    );
    await sweep.sweep();
    clock.advance(31 * 60_000); // a normal sweep interval later — still not 10 minutes old relative to record creation? advance past it below
    await sweep.sweep();
    // Record is now well past MIN_RECORD_AGE_MS but has only been absent (age-eligible) for one observation — not released yet.
    expect(released).toEqual([]);
    expect(await store.get(AGENT)).not.toBeNull();
  });

  test("a genuinely gone agent IS released, but only after the grace rule: two consecutive absent sweeps, both past the minimum record age", async () => {
    const { sweep, store, released } = harness(
      [{ agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "temporary", createdAt: OLD_ENOUGH }],
      [[], []],
    );
    await sweep.sweep();
    expect(released).toEqual([]); // first absent observation — not yet
    await sweep.sweep();
    expect(released).toEqual([AGENT]); // second consecutive absent observation — released
    expect(await store.get(AGENT)).toBeNull();
  });

  test("a permanent account is never touched, even after the grace rule confirms it absent from residentIssues()", async () => {
    const { sweep, store, released } = harness(
      [{ agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "permanent", createdAt: OLD_ENOUGH }],
      [[], []],
    );
    await sweep.sweep();
    await sweep.sweep();
    expect(released).toEqual([AGENT]); // the sweep DID attempt it (release is generic over policy)...
    expect(await store.get(AGENT)).not.toBeNull(); // ...but releaseAccount itself no-ops for permanent, so the record survives
  });

  test("a failing residentIssues() releases nothing this round and leaves any in-progress streak untouched, not reset", async () => {
    const { sweep, store, released, logs } = harness(
      [{ agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "temporary", createdAt: OLD_ENOUGH }],
      [[], new Error("herdr down"), []],
    );
    await sweep.sweep(); // observation 1: absent, streak=1
    await sweep.sweep(); // read failure — skipped, streak stays 1, nothing released
    expect(released).toEqual([]);
    expect(logs.some((l) => l.includes("WARNING") && l.includes("skipped this round"))).toBe(true);
    await sweep.sweep(); // observation 2 (continuing the streak, not restarting it) — released
    expect(released).toEqual([AGENT]);
    expect(await store.get(AGENT)).toBeNull();
  });

  test("an id that becomes resident again between sweeps has its streak pruned, and needs two FRESH absences before release", async () => {
    const { sweep, store, released } = harness(
      [{ agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "temporary", createdAt: OLD_ENOUGH }],
      [[], [AGENT], [], []],
    );
    await sweep.sweep(); // absent (streak=1)
    await sweep.sweep(); // resident again — pruned
    await sweep.sweep(); // absent (streak=1, fresh episode)
    expect(released).toEqual([]);
    await sweep.sweep(); // absent again (streak=2) — released
    expect(released).toEqual([AGENT]);
    expect(await store.get(AGENT)).toBeNull();
  });

  test("a failing reconcileOrphans() (store corruption etc.) releases nothing and is logged, never thrown", async () => {
    const store = fakeStore();
    // Force reconcileOrphans to reject by making the underlying store.list() throw.
    const brokenStore = { ...store, list: async () => { throw new Error("corrupt store"); } };
    const { client } = fakeRcClient();
    const manager = createAccountManager({ client, store: brokenStore, userCapThreshold: 45 });
    const logs: string[] = [];
    const sweep = createAccountOrphanSweep({
      now: () => NOW,
      reconcileOrphans: (agentExists) => manager.reconcileOrphans(agentExists),
      residentIssues: async () => [],
      release: async () => { throw new Error("should never be called"); },
      log: (l) => logs.push(l),
    });
    await expect(sweep.sweep()).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("WARNING") && l.includes("orphan sweep failed"))).toBe(true);
  });

  test("a release failure is logged and swallowed, never thrown out of sweep()", async () => {
    const store = fakeStore([{ agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "temporary", createdAt: OLD_ENOUGH }]);
    const { client } = fakeRcClient();
    const manager = createAccountManager({ client, store, userCapThreshold: 45 });
    const logs: string[] = [];
    const failingSweep = createAccountOrphanSweep({
      now: () => NOW,
      reconcileOrphans: (agentExists) => manager.reconcileOrphans(agentExists),
      residentIssues: async () => [],
      release: async () => { throw new Error("RC unreachable"); },
      log: (l) => logs.push(l),
    });
    await failingSweep.sweep(); // observation 1: absent, not yet at the grace threshold
    await expect(failingSweep.sweep()).resolves.toBeUndefined(); // observation 2: release attempted, throws — swallowed
    expect(logs.some((l) => l.includes("WARNING") && l.includes("orphan sweep release failed"))).toBe(true);
    expect(await store.get(AGENT)).not.toBeNull(); // release failed — record untouched, still on file
  });

  test("independent per-id streaks: one id's absence never advances another id's grace count", async () => {
    const { sweep, released } = harness(
      [
        { agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "temporary", createdAt: OLD_ENOUGH },
        { agentKey: AGENT2, rcUserId: "u2", username: rcUsernameFor(AGENT2), policy: "temporary", createdAt: OLD_ENOUGH },
      ],
      [[AGENT2], [AGENT2]], // AGENT always absent; AGENT2 always resident
    );
    await sweep.sweep();
    await sweep.sweep();
    expect(released).toEqual([AGENT]);
  });
});
