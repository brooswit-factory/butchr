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
 */
import { describe, expect, test } from "bun:test";
import { reconcileNow } from "../../src/daemon/loop.js";
import { createAccountManager } from "../../src/accounts/manager.js";
import { createAccountLifecycle } from "../../src/agents/account-lifecycle.js";
import { encodeAgentKey, encodeQueryAgentKey, decodeAnyAgentKey } from "../../src/rules/agent-key.js";
import type { AccountPolicy, ExecutionMode } from "../../src/rules/rules.js";
import { fakeStore, fakeRcClient, fakeManifestPublisher, baseAccountManagerDeps } from "../fixtures/rocketchat-fakes.js";
import { rcUsernameFor } from "../../src/accounts/identity.js";
import type { Herd, SpawnSpec } from "../../src/agents/herd.js";

interface TestRule { id: string; execution: ExecutionMode; account: AccountPolicy }

const EXECUTIONS: readonly ExecutionMode[] = ["swarm", "singleton", "persistent"];
const POLICIES: readonly AccountPolicy[] = ["none", "temporary", "permanent"];

/** One rule per (execution, account) cell — 9 total, mirroring what a real rules.json would declare. */
const RULES: TestRule[] = EXECUTIONS.flatMap((execution) => POLICIES.map((account) => ({ id: `${execution}-${account}`, execution, account })));

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

describe("BUTCHR-412: the 3x3 execution x account matrix, through the real reconciler with a fake RC", () => {
  test("every cell independently: temporary provisions on spawn and unprovisions on stop; permanent provisions and is retained; none never touches RC — regardless of execution mode", async () => {
    const store = fakeStore();
    const { client, calls } = fakeRcClient();
    const manager = createAccountManager(baseAccountManagerDeps({ client, store, now: () => "2026-09-24T00:00:00.000Z", randomPassword: () => "fixed" }));
    const policyOf = (id: string): AccountPolicy => {
      const decoded = decodeAnyAgentKey(id);
      const rule = RULES.find((r) => r.id === decoded?.ruleId);
      return rule?.account ?? "none";
    };
    const account = createAccountLifecycle({ manager, policyOf, manifestPublisher: fakeManifestPublisher() });
    const herd = fakeHerd();
    const specFor = (rule: TestRule): SpawnSpec => ({ key: keyFor(rule), issuetype: "task", summary: rule.id, parent: null });

    // Poll 1: every rule's agent is desired (this is a swarm rule's matched
    // ticket, or a singleton/persistent rule's query agent at N>=1 or N=0
    // respectively — `reconcileNow` treats all three identically here, since
    // execution mode is already resolved into "this id is in `desired`" by
    // the time it reaches the reconciler; see docs/execution-modes.md).
    const desired1 = new Map(RULES.map((r) => [keyFor(r), specFor(r)]));
    await reconcileNow(herd, desired1, { account });

    for (const rule of RULES) {
      const key = keyFor(rule);
      const spawnedSpec = herd.spawnedSpecs.get(key);
      expect(spawnedSpec).toBeDefined();
      if (rule.account === "none") {
        expect(spawnedSpec!.rocketchatAccount).toBeUndefined();
      } else {
        expect(spawnedSpec!.rocketchatAccount).toBe(rcUsernameFor(key));
        expect(await store.get(key)).toMatchObject({ policy: rule.account });
      }
    }
    // Exactly the 6 temporary+permanent rules created a Rocket.Chat user — never the 3 "none" ones.
    expect(calls.filter((c) => c.method === "createUser")).toHaveLength(6);

    // Poll 2: NOTHING is desired any more (every swarm ticket left its
    // query; every singleton dropped to zero matches; every persistent rule
    // was frozen via enabled:false) — all 9 agents fall into plan.stop.
    await reconcileNow(herd, new Map(), { account });

    for (const rule of RULES) {
      const key = keyFor(rule);
      const record = await store.get(key);
      if (rule.account === "temporary") {
        expect(record).toBeNull(); // unprovisioned
      } else if (rule.account === "permanent") {
        expect(record).not.toBeNull(); // retained
      } else {
        expect(record).toBeNull(); // never had one
      }
    }
    expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(3); // exactly the 3 temporary rules, one per execution mode
  });

  test("respawn never unprovisions a temporary account, for every execution mode alike", async () => {
    for (const execution of EXECUTIONS) {
      const rule: TestRule = { id: `${execution}-respawn`, execution, account: "temporary" };
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
