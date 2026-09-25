import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isManagedUsername, rcUsernameFor, RC_MANAGED_PREFIX, RC_USERNAME_MAX } from "../../src/accounts/identity.js";
import {
  createAccountManager,
  createFileAccountStore,
  type AccountRecord,
  type AccountStore,
  type AccountManagerDeps,
} from "../../src/accounts/manager.js";
import { RocketChatApiError, RocketChatHttpError, type RocketChatClient, type RocketChatUser } from "../../src/resources/rocketchat.js";

const AGENT = "jira-work:triage:BUTCHR-1";
const AGENT2 = "jira-work:triage:BUTCHR-2";

function fakeStore(initial: AccountRecord[] = []): AccountStore & { data: Map<string, AccountRecord> } {
  const data = new Map(initial.map((r) => [r.agentKey, r]));
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(r) { data.set(r.agentKey, r); },
    async delete(k) { data.delete(k); },
    async list() { return [...data.values()]; },
  };
}

type FakeCall = { method: string; args: unknown[] };

function fakeRcClient(seed: RocketChatUser[] = []) {
  const byUsername = new Map(seed.map((u) => [u.username, u]));
  const byId = new Map(seed.map((u) => [u.id, u]));
  let nextId = seed.length + 1;
  const calls: FakeCall[] = [];
  let countOverride: number | null = null;
  const client: RocketChatClient = {
    async getUserByUsername(username) { calls.push({ method: "getUserByUsername", args: [username] }); return byUsername.get(username) ?? null; },
    async countUsers() { calls.push({ method: "countUsers", args: [] }); return countOverride ?? byUsername.size; },
    async createUser(input) {
      calls.push({ method: "createUser", args: [input] });
      if (byUsername.has(input.username)) throw new Error("Username is already in use");
      const u: RocketChatUser = { id: `id-${nextId++}`, username: input.username, active: true };
      byUsername.set(u.username, u);
      byId.set(u.id, u);
      return u;
    },
    async deleteUser(userId) {
      calls.push({ method: "deleteUser", args: [userId] });
      if (!byId.has(userId)) throw new RocketChatApiError("user delete", "User not found.");
      const u = byId.get(userId)!;
      byUsername.delete(u.username);
      byId.delete(userId);
    },
    async generateManagedToken(userId) {
      calls.push({ method: "generateManagedToken", args: [userId] });
      if (!byId.has(userId)) throw new RocketChatApiError("token generate", "User not found.");
      return `tok-${userId}`;
    },
    async revokeManagedToken(userId) {
      calls.push({ method: "revokeManagedToken", args: [userId] });
      if (!byId.has(userId)) throw new RocketChatApiError("token revoke", "User not found.");
    },
  };
  return {
    client, calls, byUsername,
    setCountOverride: (n: number) => { countOverride = n; },
    /** Simulates the RC user vanishing out-of-band (deleted by another admin, or a previous release that got interrupted) — bypasses `deleteUser` so it never appears in `calls`. */
    removeUserExternally: (id: string) => { const u = byId.get(id); if (u) { byUsername.delete(u.username); byId.delete(id); } },
  };
}

const baseDeps = (over: Partial<AccountManagerDeps> = {}): AccountManagerDeps => ({
  client: fakeRcClient().client,
  store: fakeStore(),
  userCapThreshold: 45,
  now: () => "2026-09-24T00:00:00.000Z",
  randomPassword: () => "fixed-password",
  ...over,
});

describe("Rocket.Chat username identity", () => {
  test("deterministic, RC-safe, length-bounded, and marked with the managed prefix", () => {
    const u = rcUsernameFor(AGENT);
    expect(u).toBe(rcUsernameFor(AGENT));
    expect(u.startsWith(RC_MANAGED_PREFIX)).toBe(true);
    expect(u.length).toBeLessThanOrEqual(RC_USERNAME_MAX);
    expect(/^[A-Za-z0-9._-]+$/.test(u)).toBe(true);
    expect(isManagedUsername(u)).toBe(true);
    expect(isManagedUsername("some.human")).toBe(false);
    expect(isManagedUsername("candlestix_legacy")).toBe(false);
  });

  test("collision-proof even when sanitization alone would make two different keys identical", () => {
    const a = rcUsernameFor("jira-work:foo-bar:x");
    const b = rcUsernameFor("jira-work:foo:bar-x");
    expect(a).not.toBe(b);
  });

  test("truncates a very long key while staying under the bound and collision-proof", () => {
    const long1 = `jira-work:triage:${"X".repeat(200)}A`;
    const long2 = `jira-work:triage:${"X".repeat(200)}B`;
    const u1 = rcUsernameFor(long1);
    const u2 = rcUsernameFor(long2);
    expect(u1.length).toBeLessThanOrEqual(RC_USERNAME_MAX);
    expect(u2.length).toBeLessThanOrEqual(RC_USERNAME_MAX);
    expect(u1).not.toBe(u2);
  });
});

describe("ensureAccount", () => {
  test('policy "none" is a no-op that never touches the client or the store', async () => {
    const store = fakeStore();
    const { client, calls } = fakeRcClient();
    const manager = createAccountManager(baseDeps({ client, store }));
    expect(await manager.ensureAccount(AGENT, "none")).toEqual({ ok: true, policy: "none" });
    expect(calls).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  test('temporary or permanent with no RC client configured refuses loudly, never throws', async () => {
    const manager = createAccountManager(baseDeps({ client: null }));
    for (const policy of ["temporary", "permanent"] as const) {
      const r = await manager.ensureAccount(AGENT, policy);
      expect(r).toMatchObject({ ok: false, reason: "rc-not-configured" });
    }
  });

  test("create-if-missing creates exactly once and returns usable connection material", async () => {
    const { client, calls } = fakeRcClient();
    const store = fakeStore();
    const manager = createAccountManager(baseDeps({ client, store }));
    const r = await manager.ensureAccount(AGENT, "temporary");
    expect(r).toMatchObject({ ok: true, policy: "temporary", created: true });
    if (!r.ok || r.policy === "none") throw new Error("unreached");
    expect(r.username).toBe(rcUsernameFor(AGENT));
    expect(typeof r.token).toBe("string");
    expect(calls.filter((c) => c.method === "createUser")).toHaveLength(1);
    expect(await store.get(AGENT)).toMatchObject({ agentKey: AGENT, rcUserId: r.rcUserId, username: r.username, policy: "temporary" });
  });

  test("second and concurrent ensure calls for the same agent create no duplicate", async () => {
    const { client, calls } = fakeRcClient();
    const store = fakeStore();
    const manager = createAccountManager(baseDeps({ client, store }));

    const first = await manager.ensureAccount(AGENT, "temporary");
    const second = await manager.ensureAccount(AGENT, "temporary");
    expect(calls.filter((c) => c.method === "createUser")).toHaveLength(1);
    if (!first.ok || first.policy === "none" || !second.ok || second.policy === "none") throw new Error("unreached");
    expect(second.created).toBe(false);
    expect(second.rcUserId).toBe(first.rcUserId);

    const { client: c2, calls: calls2 } = fakeRcClient();
    const manager2 = createAccountManager(baseDeps({ client: c2, store: fakeStore() }));
    const [a, b] = await Promise.all([manager2.ensureAccount(AGENT2, "temporary"), manager2.ensureAccount(AGENT2, "temporary")]);
    expect(calls2.filter((c) => c.method === "createUser")).toHaveLength(1);
    expect([a, b].filter((r) => r.ok && r.policy !== "none" && r.created)).toHaveLength(1);
  });

  test("a concurrent create that loses the race to RC's own uniqueness constraint adopts instead of erroring", async () => {
    const username = rcUsernameFor(AGENT);
    const { client, calls } = fakeRcClient([{ id: "won-the-race", username, active: true }]);
    const manager = createAccountManager(baseDeps({ client, store: fakeStore() }));
    const r = await manager.ensureAccount(AGENT, "temporary");
    expect(r).toMatchObject({ ok: true, created: false, rcUserId: "won-the-race" });
    expect(calls.filter((c) => c.method === "createUser")).toHaveLength(0);
  });

  test("an existing Rocket.Chat user is adopted (permanent) and never recreated", async () => {
    const username = rcUsernameFor(AGENT);
    const { client, calls } = fakeRcClient([{ id: "existing-1", username, active: true }]);
    const manager = createAccountManager(baseDeps({ client, store: fakeStore() }));
    const r = await manager.ensureAccount(AGENT, "permanent");
    expect(r).toMatchObject({ ok: true, policy: "permanent", created: false, rcUserId: "existing-1", username });
    expect(calls.filter((c) => c.method === "createUser")).toHaveLength(0);
    expect(calls.filter((c) => c.method === "getUserByUsername")).toHaveLength(1);
  });

  test("a lost persistence record falls back to the deterministic username lookup instead of recreating", async () => {
    const username = rcUsernameFor(AGENT);
    const { client, calls } = fakeRcClient([{ id: "recovered-1", username, active: true }]);
    const store = fakeStore(); // empty — simulates a wiped/lost record
    const manager = createAccountManager(baseDeps({ client, store }));
    const r = await manager.ensureAccount(AGENT, "permanent");
    expect(r).toMatchObject({ ok: true, created: false, rcUserId: "recovered-1" });
    expect(calls.filter((c) => c.method === "createUser")).toHaveLength(0);
    expect(await store.get(AGENT)).toMatchObject({ rcUserId: "recovered-1", username });
  });

  test("a STALE persisted record (RC user deleted out-of-band) is dropped and re-resolved instead of failing forever", async () => {
    const { client, calls, removeUserExternally } = fakeRcClient();
    const store = fakeStore();
    const manager = createAccountManager(baseDeps({ client, store }));

    const first = await manager.ensureAccount(AGENT, "permanent");
    if (!first.ok || first.policy === "none") throw new Error("unreached");
    removeUserExternally(first.rcUserId); // RC is now the source of truth: this user is simply gone

    const second = await manager.ensureAccount(AGENT, "permanent");
    expect(second).toMatchObject({ ok: true, created: true });
    if (!second.ok || second.policy === "none") throw new Error("unreached");
    expect(second.rcUserId).not.toBe(first.rcUserId);
    expect(await store.get(AGENT)).toMatchObject({ rcUserId: second.rcUserId });
    // Exactly one retry, not a loop: two creates total across both ensureAccount calls, not three-plus.
    expect(calls.filter((c) => c.method === "createUser")).toHaveLength(2);

    // A THIRD call is now a plain, un-stale adoption — no further drop/retry needed.
    const third = await manager.ensureAccount(AGENT, "permanent");
    expect(third).toMatchObject({ ok: true, created: false, rcUserId: second.rcUserId });
  });

  test("a real failure issuing the token for a FRESHLY created user propagates — never mistaken for a stale-record recovery", async () => {
    const flaky: RocketChatClient = {
      async getUserByUsername() { return null; },
      async countUsers() { return 0; },
      async createUser(input) { return { id: "fresh-1", username: input.username, active: true }; },
      async deleteUser() {},
      async generateManagedToken() { return "x"; },
      async revokeManagedToken() { throw new RocketChatHttpError(503, "token revoke"); },
    };
    const manager = createAccountManager(baseDeps({ client: flaky, store: fakeStore() }));
    // No existingRecord in this path (a fresh create), so this must NOT be treated as a stale-record retry.
    await expect(manager.ensureAccount(AGENT, "temporary")).rejects.toBeInstanceOf(RocketChatHttpError);
  });

  test("the 50-user guardrail refuses before the threshold is hit and creates nothing", async () => {
    const { client, calls, setCountOverride } = fakeRcClient();
    setCountOverride(45);
    const manager = createAccountManager(baseDeps({ client, store: fakeStore(), userCapThreshold: 45 }));
    const r = await manager.ensureAccount(AGENT, "temporary");
    expect(r).toEqual({ ok: false, reason: "cap-reached", message: expect.stringContaining("45") });
    expect(calls.filter((c) => c.method === "createUser")).toHaveLength(0);

    setCountOverride(44);
    const r2 = await manager.ensureAccount(AGENT, "temporary");
    expect(r2).toMatchObject({ ok: true, created: true });
  });

  test("Rocket.Chat unavailable (5xx) is surfaced as a typed error, never a silent success", async () => {
    const failingClient: RocketChatClient = {
      async getUserByUsername() { return null; },
      async countUsers() { return 0; },
      async createUser() { throw new RocketChatHttpError(503, "user create"); },
      async deleteUser() {},
      async generateManagedToken() { return "x"; },
      async revokeManagedToken() {},
    };
    const manager = createAccountManager(baseDeps({ client: failingClient, store: fakeStore() }));
    await expect(manager.ensureAccount(AGENT, "temporary")).rejects.toBeInstanceOf(RocketChatHttpError);
  });

  test("a uniqueness failure with no adoptable user behind it surfaces the original error, never swallowed", async () => {
    const inexplicable: RocketChatClient = {
      async getUserByUsername() { return null; }, // genuinely gone — not merely a race we can recover from
      async countUsers() { return 0; },
      async createUser() { throw new Error("Username is already in use"); },
      async deleteUser() {},
      async generateManagedToken() { return "x"; },
      async revokeManagedToken() {},
    };
    const manager = createAccountManager(baseDeps({ client: inexplicable, store: fakeStore() }));
    await expect(manager.ensureAccount(AGENT, "temporary")).rejects.toThrow("Username is already in use");
  });

  test("refuses to adopt a Rocket.Chat user whose username carries no managed marker", async () => {
    const { client } = fakeRcClient();
    // A store record was corrupted/hand-edited to point at a human account.
    const store = fakeStore([{ agentKey: AGENT, rcUserId: "human-1", username: "not.managed", policy: "permanent", createdAt: "t" }]);
    const manager = createAccountManager(baseDeps({ client, store }));
    const r = await manager.ensureAccount(AGENT, "permanent");
    expect(r).toMatchObject({ ok: false, reason: "not-managed" });
  });
});

describe("releaseAccount", () => {
  async function provision(policy: "temporary" | "permanent") {
    const { client, calls, removeUserExternally } = fakeRcClient();
    const store = fakeStore();
    const manager = createAccountManager(baseDeps({ client, store }));
    const ensured = await manager.ensureAccount(AGENT, policy);
    if (!ensured.ok || ensured.policy === "none") throw new Error("unreached");
    return { manager, client, calls, store, removeUserExternally, rcUserId: ensured.rcUserId, username: ensured.username };
  }

  test("no managed account on record is a no-op that says so", async () => {
    const manager = createAccountManager(baseDeps({ store: fakeStore() }));
    expect(await manager.releaseAccount(AGENT, "stop")).toMatchObject({ ok: true, released: false, note: expect.stringContaining("no managed") });
  });

  test("temporary: stop/archive delete the user and clean up its managed token", async () => {
    for (const reason of ["stop", "archive"] as const) {
      const { manager, client, calls, store, rcUserId } = await provision("temporary");
      const revokesBefore = calls.filter((c) => c.method === "revokeManagedToken").length; // ensureAccount already issued one best-effort revoke+generate
      const r = await manager.releaseAccount(AGENT, reason);
      expect(r).toEqual({ ok: true, released: true });
      expect(calls.filter((c) => c.method === "revokeManagedToken")).toHaveLength(revokesBefore + 1);
      expect(calls.filter((c) => c.method === "deleteUser" && c.args[0] === rcUserId)).toHaveLength(1);
      expect(await store.get(AGENT)).toBeNull();
      expect(await client.getUserByUsername(rcUsernameFor(AGENT))).toBeNull();
    }
  });

  test("temporary: respawn and daemon-restart never unprovision", async () => {
    for (const reason of ["respawn", "daemon-restart"] as const) {
      const { manager, calls, store } = await provision("temporary");
      const r = await manager.releaseAccount(AGENT, reason);
      expect(r).toMatchObject({ ok: true, released: false });
      if (r.ok && !r.released) expect(r.note).toContain(reason);
      expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(0);
      expect(await store.get(AGENT)).not.toBeNull();
    }
  });

  test("permanent is retained across every reason, stop/archive included", async () => {
    for (const reason of ["stop", "archive", "respawn", "daemon-restart"] as const) {
      const { manager, calls, store } = await provision("permanent");
      const r = await manager.releaseAccount(AGENT, reason);
      expect(r).toMatchObject({ ok: true, released: false });
      expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(0);
      expect(await store.get(AGENT)).not.toBeNull();
    }
  });

  test("temporary: after release, the agent's return re-provisions (recreates)", async () => {
    const { manager, client, calls, store } = await provision("temporary");
    await manager.releaseAccount(AGENT, "stop");
    const second = await manager.ensureAccount(AGENT, "temporary");
    expect(second).toMatchObject({ ok: true, created: true });
    expect(calls.filter((c) => c.method === "createUser")).toHaveLength(2);
    expect(await store.get(AGENT)).not.toBeNull();
    void client;
  });

  test("temporary: release is idempotent when the RC user is already gone (interrupted prior release, or removed out-of-band)", async () => {
    const { manager, calls, store, removeUserExternally, rcUserId } = await provision("temporary");
    removeUserExternally(rcUserId);
    const r = await manager.releaseAccount(AGENT, "stop");
    expect(r).toEqual({ ok: true, released: true });
    expect(await store.get(AGENT)).toBeNull();
    // A second release call (stop/archive can legitimately repeat) is ALSO a clean no-op, not a throw.
    const again = await manager.releaseAccount(AGENT, "stop");
    expect(again).toMatchObject({ ok: true, released: false, note: expect.stringContaining("no managed") });
    void calls;
  });

  test("no RC client configured refuses release loudly instead of throwing", async () => {
    const store = fakeStore([{ agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "temporary", createdAt: "t" }]);
    const manager = createAccountManager(baseDeps({ client: null, store }));
    expect(await manager.releaseAccount(AGENT, "stop")).toMatchObject({ ok: false, reason: "rc-not-configured" });
  });

  test("refuses to delete a non-butchr-managed user even if a temporary record points at one", async () => {
    const { client, calls } = fakeRcClient([{ id: "human-1", username: "not.managed", active: true }]);
    const store = fakeStore([{ agentKey: AGENT, rcUserId: "human-1", username: "not.managed", policy: "temporary", createdAt: "t" }]);
    const manager = createAccountManager(baseDeps({ client, store }));
    const r = await manager.releaseAccount(AGENT, "stop");
    expect(r).toMatchObject({ ok: false, reason: "not-managed" });
    expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(0);
    expect(await store.get(AGENT)).not.toBeNull();
  });

  test("refuses when the record's username no longer matches the deterministic derivation for this agent key", async () => {
    const { client, calls } = fakeRcClient([{ id: "x-1", username: "butchr_stale_deadbeef00", active: true }]);
    const store = fakeStore([{ agentKey: AGENT, rcUserId: "x-1", username: "butchr_stale_deadbeef00", policy: "temporary", createdAt: "t" }]);
    const manager = createAccountManager(baseDeps({ client, store }));
    const r = await manager.releaseAccount(AGENT, "stop");
    expect(r).toMatchObject({ ok: false, reason: "not-managed" });
    expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(0);
  });
});

describe("reconcileOrphans", () => {
  test("lists only managed accounts whose agent no longer exists, without deleting anything", async () => {
    const store = fakeStore([
      { agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "temporary", createdAt: "t" },
      { agentKey: AGENT2, rcUserId: "u2", username: rcUsernameFor(AGENT2), policy: "permanent", createdAt: "t" },
    ]);
    const manager = createAccountManager(baseDeps({ store }));
    const orphans = await manager.reconcileOrphans(async (key) => key === AGENT2);
    expect(orphans.map((r) => r.agentKey)).toEqual([AGENT]);
    expect(await store.list()).toHaveLength(2); // read-only: nothing removed
  });
});

describe("createFileAccountStore", () => {
  test("persists records to a JSON file at the given path, surviving a fresh store instance over the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-rc-store-"));
    try {
      const path = join(dir, "accounts.json");
      const store1 = createFileAccountStore(path);
      await store1.set({ agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "temporary", createdAt: "t" });
      expect(JSON.parse(readFileSync(path, "utf8"))[AGENT]).toMatchObject({ rcUserId: "u1" });

      const store2 = createFileAccountStore(path);
      expect(await store2.get(AGENT)).toMatchObject({ rcUserId: "u1" });
      expect(await store2.list()).toHaveLength(1);
      await store2.delete(AGENT);
      expect(await store2.get(AGENT)).toBeNull();
      expect(await store1.list()).toEqual([]); // re-read from disk, not cached in memory
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a MISSING file (ENOENT) starts as an empty store rather than throwing", async () => {
    const store = createFileAccountStore(join(tmpdir(), `butchr-rc-store-missing-${Date.now()}`, "accounts.json"));
    expect(await store.list()).toEqual([]);
    expect(await store.get(AGENT)).toBeNull();
  });

  // BUTCHR-410 review, blocking finding 3 — an intended behaviour change from
  // this module's first pass: a CORRUPT file used to be silently read as
  // empty, so the very next `set` would rewrite it with only that one
  // record, forgetting every other managed account. It now throws loudly
  // instead, on every read path (`get`/`list`/`set`/`delete` all load first).
  test("a CORRUPT (unparseable) file throws loudly instead of being read as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-rc-store-corrupt-"));
    try {
      const path = join(dir, "accounts.json");
      writeFileSync(path, '{"jira-work:triage:BUTCHR-1": { "rcUserId": "u1", truncated mid');
      const store = createFileAccountStore(path);
      await expect(store.list()).rejects.toThrow(/invalid JSON/);
      await expect(store.get(AGENT)).rejects.toThrow(/invalid JSON/);
      // Critically: a corrupt file must never be silently overwritten by a `set` either.
      await expect(store.set({ agentKey: AGENT2, rcUserId: "u2", username: rcUsernameFor(AGENT2), policy: "temporary", createdAt: "t" })).rejects.toThrow(/invalid JSON/);
      expect(readFileSync(path, "utf8")).toContain("truncated mid"); // untouched
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("writes are atomic (temp file + rename): no leftover temp file, and content is never partially written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-rc-store-atomic-"));
    try {
      const path = join(dir, "accounts.json");
      const store = createFileAccountStore(path);
      await store.set({ agentKey: AGENT, rcUserId: "u1", username: rcUsernameFor(AGENT), policy: "temporary", createdAt: "t" });
      await store.set({ agentKey: AGENT2, rcUserId: "u2", username: rcUsernameFor(AGENT2), policy: "permanent", createdAt: "t" });
      const entries = readdirSync(dir);
      expect(entries).toEqual(["accounts.json"]); // no .tmp-* left behind
      expect(await store.list()).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
