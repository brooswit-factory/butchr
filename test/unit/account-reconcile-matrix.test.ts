/**
 * BUTCHR-412's own DoD line: "the full 3x3 {swarm,singleton,persistent} x
 * {none,temporary,permanent} matrix exercised through the real reconciler
 * with a fake RC." `execution` (swarm/singleton/persistent) only changes
 * WHICH KEY SHAPE an agent gets (`encodeAgentKey` vs `encodeQueryAgentKey`,
 * `src/rules/agent-key.ts`) — the account layer (`src/agents/account-lifecycle.ts`,
 * wired into `reconcileNow`, `src/daemon/loop.ts`) never branches on
 * execution mode at all, so this test proves the 3x3 grid is genuinely 3
 * independent repetitions of the SAME 3-way account behaviour, not 9 special
 * cases. `test/fixtures/rocketchat-fakes.ts` is the reusable fake-RC harness
 * this exercises (see that file's own header) — a real `AccountManager`
 * (`src/accounts/manager.ts`) over a fake `RocketChatClient`/`AccountStore`,
 * never a hand-rolled stand-in.
 *
 * BUTCHR-464 extends this 3x3 with the third, independent BUTCHR-398 `role`
 * axis ({worker, sentinel}), making RULES a genuine 3x3x2 = 18-cell cross
 * product, generated (never hand-copied) below. `role` only changes WHETHER
 * an id counts toward the fleet-wide admission cap at all
 * (`src/agents/admission.ts`'s `roleOf`) — it is not read anywhere in the
 * account layer, so the account-behaviour half of each cell (asserted in the
 * first `describe` block below, same shape BUTCHR-412 already established)
 * is expected to be completely unaffected by it; the capacity half (the
 * second `describe` block) is where `role` actually matters. Every
 * `expect(...)`/count this file already had is KEPT — cardinalities that
 * were correct for 9 rules (e.g. "6 temporary+permanent rules") are updated
 * to their correct value for 18 (12), never removed or weakened.
 */
import { describe, expect, test } from "bun:test";
import { reconcileNow } from "../../src/daemon/loop.js";
import { createAccountManager } from "../../src/accounts/manager.js";
import { createAccountLifecycle } from "../../src/agents/account-lifecycle.js";
import { encodeAgentKey, encodeQueryAgentKey, decodeAnyAgentKey } from "../../src/rules/agent-key.js";
import type { AccountPolicy, AgentRole, ExecutionMode } from "../../src/rules/rules.js";
import { fakeStore, fakeRcClient, fakeManifestPublisher, baseAccountManagerDeps } from "../fixtures/rocketchat-fakes.js";
import { rcUsernameFor } from "../../src/accounts/identity.js";
import type { Herd, SpawnSpec } from "../../src/agents/herd.js";
import { createAdmissionController, type AgentCapacityRole } from "../../src/agents/admission.js";

interface TestRule { id: string; execution: ExecutionMode; account: AccountPolicy; role: AgentRole }

const EXECUTIONS: readonly ExecutionMode[] = ["swarm", "singleton", "persistent"];
const POLICIES: readonly AccountPolicy[] = ["none", "temporary", "permanent"];
const ROLES: readonly AgentRole[] = ["worker", "sentinel"];

/** One rule per (execution, account, role) cell — 3x3x2 = 18 total (BUTCHR-464), mirroring what a real rules.json would declare. */
const RULES: TestRule[] = EXECUTIONS.flatMap((execution) => POLICIES.flatMap((account) => ROLES.map((role) => ({ id: `${execution}-${account}-${role}`, execution, account, role }))));

/** Shared (id -> account policy) lookup, used by every test below — every RULES id is unique, so a global lookup is valid for both the combined-poll test and the isolated per-cell test alike. */
const policyOf = (id: string): AccountPolicy => {
  const decoded = decodeAnyAgentKey(id);
  const rule = RULES.find((r) => r.id === decoded?.ruleId);
  return rule?.account ?? "none";
};

/** Shared (id -> capacity role) lookup — BUTCHR-398's `AdmissionControllerDeps.roleOf` shape, same "unique id" reasoning as `policyOf` above. */
const roleOf = (id: string): AgentCapacityRole => {
  const decoded = decodeAnyAgentKey(id);
  const rule = RULES.find((r) => r.id === decoded?.ruleId);
  return rule?.role ?? "worker";
};

/** The one agent key each rule's agent runs under — a swarm rule's single matched ticket, or a singleton/persistent rule's one query-level agent. */
const keyFor = (rule: TestRule): string =>
  rule.execution === "swarm"
    ? encodeAgentKey({ resourceProvider: "jira-work", ruleId: rule.id, resourceId: "TCK-1" })
    : encodeQueryAgentKey({ resourceProvider: "jira-work", ruleId: rule.id });

function fakeHerd(): Herd & { running: Set<string>; spawnedSpecs: Map<string, SpawnSpec> } {
  const running = new Set<string>();
  const spawnedSpecs = new Map<string, SpawnSpec>();
  return {
    running, spawnedSpecs,
    async runningIssues() { return [...running]; },
    async staleIssues() { return []; },
    async spawn(spec) { spawnedSpecs.set(spec.key, spec); running.add(spec.key); },
    async stop(id) { running.delete(id); },
    async paneFor(id) { return running.has(id) ? `pane-${id}` : null; },
    async nudge() { return { delivered: true }; },
  };
}

describe("BUTCHR-412/BUTCHR-464: the 3x3x2 execution x account x role matrix, through the real reconciler with a fake RC", () => {
  test("every cell independently: temporary provisions on spawn and unprovisions on stop; permanent provisions and is retained; none never touches RC — regardless of execution mode OR role, and a sufficient cap admits every worker cell alongside every sentinel cell", async () => {
    const store = fakeStore();
    const { client, calls } = fakeRcClient();
    const manager = createAccountManager(baseAccountManagerDeps({ client, store, now: () => "2026-09-24T00:00:00.000Z", randomPassword: () => "fixed" }));
    const account = createAccountLifecycle({ manager, policyOf, manifestPublisher: fakeManifestPublisher() });
    const herd = fakeHerd();
    const specFor = (rule: TestRule): SpawnSpec => ({ key: keyFor(rule), issuetype: "task", summary: rule.id, parent: null });
    const workerCount = RULES.filter((r) => r.role === "worker").length; // 9
    const sentinelCount = RULES.length - workerCount; // 9
    // Cap set to EXACTLY the worker count: enough for every worker cell to
    // be admitted, with no headroom to spare — proves capacity behaviour
    // for the matrix as a whole, not just each cell's account behaviour:
    // if a sentinel consumed a worker slot (the bug BUTCHR-398 exists to
    // prevent), one worker cell below would come up un-spawned.
    const admissionCtrl = createAdmissionController({ cap: workerCount, residency: () => herd.runningIssues(), roleOf });

    // Poll 1: every rule's agent is desired (this is a swarm rule's matched
    // ticket, or a singleton/persistent rule's query agent at N>=1 or N=0
    // respectively — `reconcileNow` treats all three identically here, since
    // execution mode is already resolved into "this id is in `desired`" by
    // the time it reaches the reconciler; see docs/execution-modes.md).
    const desired1 = new Map(RULES.map((r) => [keyFor(r), specFor(r)]));
    await reconcileNow(herd, desired1, { account, admission: admissionCtrl.admit.bind(admissionCtrl) });

    for (const rule of RULES) {
      const key = keyFor(rule);
      const spawnedSpec = herd.spawnedSpecs.get(key);
      expect(spawnedSpec, `cell ${rule.id}: every worker fits exactly at cap=${workerCount} and every sentinel rides along uncapped, so this cell must have spawned`).toBeDefined();
      if (rule.account === "none") {
        expect(spawnedSpec!.rocketchatAccount, `cell ${rule.id}`).toBeUndefined();
      } else {
        expect(spawnedSpec!.rocketchatAccount, `cell ${rule.id}`).toBe(rcUsernameFor(key));
        expect(await store.get(key), `cell ${rule.id}`).toMatchObject({ policy: rule.account });
      }
    }
    // Exactly the 12 temporary+permanent rules (3 executions x 2 policies x 2 roles) created a Rocket.Chat user — never the 6 "none" ones.
    expect(calls.filter((c) => c.method === "createUser")).toHaveLength(12);
    // Capacity confirms the 9/9 split held exactly after this poll's spawns landed: no sentinel ate into the worker budget, and no worker snuck in as a sentinel (`admissionCtrl.snapshot()` itself reads the census taken BEFORE this poll's own spawns, so it is not the right read here — the herd's own post-spawn residency is).
    const residents = await herd.runningIssues();
    expect(residents.filter((id) => roleOf(id) === "worker")).toHaveLength(workerCount);
    expect(residents.filter((id) => roleOf(id) === "sentinel")).toHaveLength(sentinelCount);

    // Poll 2: NOTHING is desired any more (every swarm ticket left its
    // query; every singleton dropped to zero matches; every persistent rule
    // was frozen via enabled:false) — all 18 agents fall into plan.stop.
    await reconcileNow(herd, new Map(), { account, admission: admissionCtrl.admit.bind(admissionCtrl) });

    for (const rule of RULES) {
      const key = keyFor(rule);
      const record = await store.get(key);
      if (rule.account === "temporary") {
        expect(record, `cell ${rule.id}`).toBeNull(); // unprovisioned
      } else if (rule.account === "permanent") {
        expect(record, `cell ${rule.id}`).not.toBeNull(); // retained
      } else {
        expect(record, `cell ${rule.id}`).toBeNull(); // never had one
      }
    }
    expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(6); // exactly the 6 temporary rules (3 executions x 2 roles)
  });

  test("respawn never unprovisions a temporary account, for every execution mode alike", async () => {
    for (const execution of EXECUTIONS) {
      const rule: TestRule = { id: `${execution}-respawn`, execution, account: "temporary", role: "worker" };
      const key = keyFor(rule);
      const store = fakeStore();
      const { client, calls } = fakeRcClient();
      const manager = createAccountManager(baseAccountManagerDeps({ client, store }));
      const account = createAccountLifecycle({ manager, policyOf: () => "temporary", manifestPublisher: fakeManifestPublisher() });
      const herd: Herd = {
        async runningIssues() { return [key]; },
        async staleIssues() { return [{ issue: key, reason: "stale argv", observedArgv: [] }]; },
        async spawn() {},
        async stop() {},
        async paneFor() { return null; },
        async nudge() { return { delivered: true }; },
      };
      // A prior spawn already provisioned this agent's account.
      const first = await manager.ensureAccount(key, "temporary");
      if (!first.ok || first.policy === "none") throw new Error("unreached");
      expect(await store.get(key)).not.toBeNull();

      // A respawn (stale argv, same identity coming back) must ADOPT, never
      // recreate, and must never unprovision — the record survives, and no
      // deleteUser call is ever made.
      await reconcileNow(herd, new Map([[key, { key, issuetype: "task", summary: "s", parent: null }]]), { account });
      expect(await store.get(key)).not.toBeNull();
      expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(0);
      expect(calls.filter((c) => c.method === "createUser")).toHaveLength(1); // only the ORIGINAL ensureAccount call above — the respawn adopted
    }
  });

  // BUTCHR-412 review round 3, blocking finding, required test 2: the
  // 12-concurrent/cap-8 race, through the REAL reconciler (reconcileNow runs
  // every admitted agent's `ensure` under one `Promise.all` — exactly the
  // shape that exposed the bug).
  test("N agents admitted in ONE poll, temporary cap below N: exactly the cap is spawned, the rest withheld and logged, and a later poll picks up the withheld ones once a slot frees", async () => {
    const store = fakeStore();
    const { client } = fakeRcClient();
    const manager = createAccountManager(baseAccountManagerDeps({ client, store, tempAccountCapThreshold: 8 }));
    const logs: string[] = [];
    const account = createAccountLifecycle({ manager, policyOf: () => "temporary", manifestPublisher: fakeManifestPublisher(), log: (l) => logs.push(l) });
    const running = new Set<string>();
    const herd: Herd = {
      async runningIssues() { return [...running]; },
      async staleIssues() { return []; },
      async spawn(spec) { running.add(spec.key); },
      async stop(id) { running.delete(id); },
      async paneFor(id) { return running.has(id) ? `pane-${id}` : null; },
      async nudge() { return { delivered: true }; },
    };
    const ids = Array.from({ length: 12 }, (_, i) => `jira-work:triage:T-${i}`);
    const desired = new Map(ids.map((id) => [id, { key: id, issuetype: "task", summary: "s", parent: null }]));

    await reconcileNow(herd, desired, { account });
    expect(running.size).toBe(8);
    expect(logs.some((l) => l.includes("WARNING") && l.includes("temporary-cap-reached"))).toBe(true);
    const spawnedFirstPoll = [...running];
    const toFree = spawnedFirstPoll[0]!;

    // Poll 2: `toFree`'s rule no longer desires it (dropped out of `desired`)
    // — a genuine plan.stop. `reconcileNow`'s own spawn loop runs BEFORE its
    // stop loop within one poll, so THIS poll's spawn attempts still see the
    // cap exactly as full (toFree's account is not released until after);
    // its release lands at the very end of this poll.
    const desired2 = new Map(desired);
    desired2.delete(toFree);
    await reconcileNow(herd, desired2, { account });
    expect(running.has(toFree)).toBe(false);
    expect(running.size).toBe(7); // toFree stopped; nothing new admitted yet this same poll

    // Poll 3, same desired2: NOW the freed slot is visible to the spawn
    // loop, and exactly ONE of the still-withheld ids is admitted into it.
    await reconcileNow(herd, desired2, { account });
    expect(running.size).toBe(8); // still exactly at the cap: 7 originals + 1 newly admitted
    for (const id of spawnedFirstPoll.slice(1)) expect(running.has(id)).toBe(true); // the other 7 originals were never disturbed
  });
});

/**
 * BUTCHR-464: the capacity half of each of the SAME 18 cells above, taken to
 * the opposite extreme — cap:0. The combined-poll test above already proves
 * account behaviour is identical across every cell and that a SUFFICIENT cap
 * (exactly the worker count) admits every worker alongside every sentinel;
 * this proves the complementary claim per cell, in isolation, through the
 * same real `reconcileNow` + fake RC: with NO worker budget available at
 * all, a worker cell is withheld (never spawns, never touches the account
 * store, regardless of its own account policy) while a sentinel cell of the
 * SAME execution/account combination starts anyway and its account
 * behaviour proceeds exactly as it did at a sufficient cap — proving
 * capacity and account behaviour are independent axes for a sentinel just as
 * they already are for a worker. `test.each` (not a hand-rolled loop) so a
 * failing cell is named in the test's own title, not just inside an
 * assertion message.
 */
describe("BUTCHR-464: role capacity behaviour, per cell (fleet-wide cap fully saturated)", () => {
  test.each(RULES.map((r) => [r.id, r] as const))("cell %s: a worker is withheld and a sentinel starts, when the fleet-wide worker cap is 0", async (_id, rule) => {
    const key = keyFor(rule);
    const store = fakeStore();
    const { client } = fakeRcClient();
    const manager = createAccountManager(baseAccountManagerDeps({ client, store, now: () => "2026-09-24T00:00:00.000Z", randomPassword: () => "fixed" }));
    const account = createAccountLifecycle({ manager, policyOf, manifestPublisher: fakeManifestPublisher() });
    const herd = fakeHerd();
    // cap:0 with a cold-start census (nothing was ever trusted positive
    // before this first read, so a readable 0 is trusted immediately, not
    // the BUTCHR-282 implausible-zero shape — see admission.test.ts's own
    // "cold start" case): budget = 0 - 0 = 0 for every WORKER candidate.
    // Sentinels bypass the budget check entirely (src/agents/admission.ts).
    const admissionCtrl = createAdmissionController({ cap: 0, residency: () => herd.runningIssues(), roleOf });
    const spec: SpawnSpec = { key, issuetype: "task", summary: rule.id, parent: null };

    await reconcileNow(herd, new Map([[key, spec]]), { account, admission: admissionCtrl.admit.bind(admissionCtrl) });

    if (rule.role === "worker") {
      expect(herd.spawnedSpecs.get(key), `cell ${rule.id}: a worker must be withheld when the worker cap is 0`).toBeUndefined();
      expect(await store.get(key), `cell ${rule.id}: a withheld worker must never touch the account store, regardless of its own account policy`).toBeNull();
      return;
    }

    expect(herd.spawnedSpecs.get(key), `cell ${rule.id}: a sentinel must start even when the worker cap is 0`).toBeDefined();
    if (rule.account === "none") {
      expect(herd.spawnedSpecs.get(key)!.rocketchatAccount, `cell ${rule.id}`).toBeUndefined();
    } else {
      expect(herd.spawnedSpecs.get(key)!.rocketchatAccount, `cell ${rule.id}`).toBe(rcUsernameFor(key));
      expect(await store.get(key), `cell ${rule.id}`).toMatchObject({ policy: rule.account });
    }

    // Poll 2: this sentinel's agent stops — same account-lifecycle
    // assertion as the combined matrix test's own poll 2, now exercised at
    // cap:0 too.
    await reconcileNow(herd, new Map(), { account, admission: admissionCtrl.admit.bind(admissionCtrl) });
    const record = await store.get(key);
    if (rule.account === "temporary") expect(record, `cell ${rule.id}`).toBeNull();
    else if (rule.account === "permanent") expect(record, `cell ${rule.id}`).not.toBeNull();
    else expect(record, `cell ${rule.id}`).toBeNull();
  });
});
