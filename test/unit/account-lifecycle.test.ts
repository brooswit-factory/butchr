import { describe, expect, test } from "bun:test";
import { createAccountLifecycle } from "../../src/agents/account-lifecycle.js";
import { createAccountManager } from "../../src/accounts/manager.js";
import { rcUsernameFor } from "../../src/accounts/identity.js";
import { fakeStore, fakeRcClient, baseAccountManagerDeps } from "../fixtures/rocketchat-fakes.js";
import type { SpawnSpec } from "../../src/agents/workspace.js";
import type { AccountPolicy } from "../../src/rules/rules.js";
import type { AccountManager } from "../../src/accounts/manager.js";

const AGENT = "jira-work:triage:BUTCHR-1";
const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({ key: AGENT, issuetype: "task", summary: "s", parent: null, ...over });

function build(policy: AccountPolicy, over: Parameters<typeof baseAccountManagerDeps>[0] = {}, url = "https://chat.example.com") {
  const store = fakeStore();
  const { client, calls } = fakeRcClient();
  const manager = createAccountManager(baseAccountManagerDeps({ client, store, ...over }));
  const logs: string[] = [];
  const notified: Array<{ id: string; text: string }> = [];
  const hooks = createAccountLifecycle({
    manager,
    policyOf: () => policy,
    url,
    log: (l) => logs.push(l),
    notify: async (id, text) => { notified.push({ id, text }); },
  });
  return { hooks, manager, store, client, calls, logs, notified };
}

describe("createAccountLifecycle — ensure", () => {
  test('policy "none" hands the spec back untouched and never touches the manager', async () => {
    const { hooks, calls } = build("none");
    const s = spec();
    const out = await hooks.ensure(s);
    expect(out).toBe(s); // same object — never even shallow-copied
    expect(calls).toEqual([]);
  });

  test("temporary: success augments the spec with fresh connection material, never mutating the input", async () => {
    const { hooks } = build("temporary");
    const s = spec();
    const out = await hooks.ensure(s);
    expect(out).not.toBeNull();
    expect(out).not.toBe(s);
    expect(s.rocketchat).toBeUndefined();
    expect(out!.rocketchat).toMatchObject({ url: "https://chat.example.com", username: rcUsernameFor(AGENT) });
    expect(typeof out!.rocketchat!.token).toBe("string");
    expect(typeof out!.rocketchat!.rcUserId).toBe("string");
    // Every other field of the original spec survives untouched.
    expect(out).toMatchObject({ key: s.key, issuetype: s.issuetype, summary: s.summary, parent: s.parent });
  });

  test("permanent: adopts an existing account rather than recreating, and still returns connection material", async () => {
    const username = rcUsernameFor(AGENT);
    const store = fakeStore([{ agentKey: AGENT, rcUserId: "existing-1", username, policy: "permanent", createdAt: "t" }]);
    const { client } = fakeRcClient([{ id: "existing-1", username, active: true }]);
    const manager = createAccountManager(baseAccountManagerDeps({ client, store }));
    const hooks = createAccountLifecycle({ manager, policyOf: () => "permanent", url: "https://chat.example.com" });
    const out = await hooks.ensure(spec());
    expect(out?.rocketchat).toMatchObject({ rcUserId: "existing-1", username });
  });

  test("a refusal (cap-reached) withholds the spawn: returns null, logs, and notifies", async () => {
    const store = fakeStore();
    const { client, setCountOverride } = fakeRcClient();
    setCountOverride(1);
    const manager = createAccountManager(baseAccountManagerDeps({ client, store, userCapThreshold: 1 }));
    const logs: string[] = [];
    const notified: Array<{ id: string; text: string }> = [];
    const hooks = createAccountLifecycle({ manager, policyOf: () => "temporary", url: "https://chat.example.com", log: (l) => logs.push(l), notify: async (id, text) => { notified.push({ id, text }); } });
    const out = await hooks.ensure(spec());
    expect(out).toBeNull();
    expect(logs.some((l) => l.includes("WARNING") && l.includes("cap-reached"))).toBe(true);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.id).toBe(AGENT);
    expect(notified[0]!.text).toContain("cap-reached");
  });

  test("rc-not-configured (no client) withholds the spawn rather than starting the agent without its account", async () => {
    const store = fakeStore();
    const manager = createAccountManager(baseAccountManagerDeps({ client: null, store }));
    const hooks = createAccountLifecycle({ manager, policyOf: () => "temporary", url: "https://chat.example.com" });
    expect(await hooks.ensure(spec())).toBeNull();
  });

  test("a notify failure never turns a real withhold into a thrown error", async () => {
    const store = fakeStore();
    const manager = createAccountManager(baseAccountManagerDeps({ client: null, store }));
    const hooks = createAccountLifecycle({ manager, policyOf: () => "temporary", url: "https://chat.example.com", notify: async () => { throw new Error("comment API down"); } });
    await expect(hooks.ensure(spec())).resolves.toBeNull();
  });
});

describe("createAccountLifecycle — release", () => {
  test("always calls the manager, regardless of policyOf's CURRENT answer — the store record decides, not today's rule config", async () => {
    const { client } = fakeRcClient();
    const store = fakeStore();
    const manager = createAccountManager(baseAccountManagerDeps({ client, store }));
    const ensured = await manager.ensureAccount(AGENT, "temporary");
    if (!ensured.ok || ensured.policy === "none") throw new Error("unreached");
    // Rule since edited to "none" — release must still find and clean up the STORED record.
    const hooks = createAccountLifecycle({ manager, policyOf: () => "none", url: "https://chat.example.com" });
    await hooks.release(AGENT, "stop");
    expect(await store.get(AGENT)).toBeNull();
  });

  test('"respawn" is a documented no-op for a temporary account: the record survives', async () => {
    const { client } = fakeRcClient();
    const store = fakeStore();
    const manager = createAccountManager(baseAccountManagerDeps({ client, store }));
    await manager.ensureAccount(AGENT, "temporary");
    const hooks = createAccountLifecycle({ manager, policyOf: () => "temporary", url: "https://chat.example.com" });
    await hooks.release(AGENT, "respawn");
    expect(await store.get(AGENT)).not.toBeNull();
  });

  test("a release refusal (not-managed) logs a WARNING rather than throwing", async () => {
    const store = fakeStore([{ agentKey: AGENT, rcUserId: "human-1", username: "not.managed", policy: "temporary", createdAt: "t" }]);
    const { client } = fakeRcClient([{ id: "human-1", username: "not.managed", active: true }]);
    const manager = createAccountManager(baseAccountManagerDeps({ client, store }));
    const logs: string[] = [];
    const hooks = createAccountLifecycle({ manager, policyOf: () => "temporary", url: "https://chat.example.com", log: (l) => logs.push(l) });
    await hooks.release(AGENT, "stop");
    expect(logs.some((l) => l.includes("WARNING") && l.includes("not-managed"))).toBe(true);
  });

  test("no record on file is a silent no-op (no WARNING)", async () => {
    const manager = createAccountManager(baseAccountManagerDeps({ store: fakeStore() }));
    const logs: string[] = [];
    const hooks = createAccountLifecycle({ manager, policyOf: () => "none", url: "https://chat.example.com", log: (l) => logs.push(l) });
    await hooks.release(AGENT, "stop");
    expect(logs.some((l) => l.includes("WARNING"))).toBe(false);
  });
});

// BUTCHR-412 review round 1, blocking finding 2: a release that throws AFTER
// a successful herd.stop is otherwise never retried by anything (the id is
// no longer running, so it can never land in a future plan.stop on its
// own) — `release` must queue it, and `retryPendingReleases` must drain it.
describe("createAccountLifecycle — pending release retry (BUTCHR-412 review round 1)", () => {
  /** A hand-rolled manager whose releaseAccount can be told to throw N times before succeeding — a real createAccountManager's releaseAccount only throws on a genuine transport failure (RocketChatHttpError etc.), which is exactly what this simulates without needing a real fake RC client wired for it. */
  function flakyManager(throwsBeforeSucceeding: number): AccountManager & { releaseCalls: number } {
    let releaseCalls = 0;
    let thrown = 0;
    return {
      releaseCalls: 0,
      async ensureAccount(_key, policy) {
        if (policy === "none") return { ok: true, policy: "none" };
        return { ok: true, policy, rcUserId: "u1", username: "butchr_x", token: "tok", created: true };
      },
      async releaseAccount(_key, _reason) {
        releaseCalls++;
        this.releaseCalls = releaseCalls;
        if (thrown < throwsBeforeSucceeding) { thrown++; throw new Error("Rocket.Chat unreachable"); }
        return { ok: true, released: true };
      },
      async reconcileOrphans() { return []; },
    };
  }

  test("a release that throws is queued, never rethrown to the caller", async () => {
    const manager = flakyManager(1);
    const logs: string[] = [];
    const hooks = createAccountLifecycle({ manager, policyOf: () => "temporary", url: "https://chat.example.com", log: (l) => logs.push(l) });
    await expect(hooks.release(AGENT, "stop")).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("WARNING") && l.includes("queued for retry"))).toBe(true);
  });

  test("retryPendingReleases retries a queued release and stops retrying once it succeeds", async () => {
    const manager = flakyManager(2); // fails twice, succeeds on the third attempt
    const logs: string[] = [];
    const hooks = createAccountLifecycle({ manager, policyOf: () => "temporary", url: "https://chat.example.com", log: (l) => logs.push(l) });
    await hooks.release(AGENT, "stop"); // attempt 1: throws, queued
    expect(manager.releaseCalls).toBe(1);

    await hooks.retryPendingReleases(); // attempt 2: throws again, still queued
    expect(manager.releaseCalls).toBe(2);
    expect(logs.some((l) => l.includes("still queued"))).toBe(true);

    await hooks.retryPendingReleases(); // attempt 3: succeeds
    expect(manager.releaseCalls).toBe(3);
    expect(logs.some((l) => l.includes("Rocket.Chat account released (stop)"))).toBe(true);

    // Nothing left to retry — a further call makes no additional release attempt.
    await hooks.retryPendingReleases();
    expect(manager.releaseCalls).toBe(3);
  });

  test("retryPendingReleases with nothing queued is a cheap no-op", async () => {
    const manager = flakyManager(0);
    const hooks = createAccountLifecycle({ manager, policyOf: () => "temporary", url: "https://chat.example.com" });
    await expect(hooks.retryPendingReleases()).resolves.toBeUndefined();
    expect(manager.releaseCalls).toBe(0);
  });

  test("ensure cancels a queued release for the SAME id — the account is being actively reused, not actually stopping", async () => {
    const manager = flakyManager(100); // never succeeds on its own — proves the cancel, not a lucky retry
    const logs: string[] = [];
    const hooks = createAccountLifecycle({ manager, policyOf: () => "temporary", url: "https://chat.example.com", log: (l) => logs.push(l) });
    await hooks.release(AGENT, "stop"); // throws, queued
    expect(manager.releaseCalls).toBe(1);

    await hooks.ensure(spec());
    expect(logs.some((l) => l.includes("cancelling a queued release"))).toBe(true);

    // The cancelled release is never retried again.
    await hooks.retryPendingReleases();
    expect(manager.releaseCalls).toBe(1);
  });

  test("ensure for a DIFFERENT id does not disturb another id's queued release", async () => {
    const manager = flakyManager(1);
    const hooks = createAccountLifecycle({ manager, policyOf: () => "temporary", url: "https://chat.example.com" });
    await hooks.release(AGENT, "stop"); // throws, queued
    await hooks.ensure(spec({ key: "jira-work:triage:BUTCHR-2" }));
    await hooks.retryPendingReleases(); // AGENT's queued release still retried and succeeds
    expect(manager.releaseCalls).toBe(2);
  });
});
