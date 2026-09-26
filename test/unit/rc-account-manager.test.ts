import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { RocketChatHttpError, type RocketChatClient } from "../../src/resources/rocketchat.js";
import { fakeStore, fakeRcClient, baseAccountManagerDeps as baseDeps } from "../fixtures/rocketchat-fakes.js";

const AGENT = "jira-work:triage:BUTCHR-1";
const AGENT2 = "jira-work:triage:BUTCHR-2";

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

  test("create-if-missing creates exactly once and mints a token to a 0600 file, never returning the value itself", async () => {
    const { client, calls } = fakeRcClient();
    const store = fakeStore();
    const manager = createAccountManager(baseDeps({ client, store }));
    const r = await manager.ensureAccount(AGENT, "temporary");
    expect(r).toMatchObject({ ok: true, policy: "temporary", created: true, rotated: true });
    if (!r.ok || r.policy === "none") throw new Error("unreached");
    expect(r.username).toBe(rcUsernameFor(AGENT));
    expect("token" in r).toBe(false); // BUTCHR-412: never returned — only the 0600 file's path is
    expect(typeof r.tokenFile).toBe("string");
    expect(readFileSync(r.tokenFile, "utf8").trim().length).toBeGreaterThan(0);
    expect(statSync(r.tokenFile).mode & 0o777).toBe(0o600);
    expect(calls.filter((c) => c.method === "createUser")).toHaveLength(1);
    expect(await store.get(AGENT)).toMatchObject({ agentKey: AGENT, rcUserId: r.rcUserId, username: r.username, policy: "temporary", tokenFile: r.tokenFile });
  });

  // BUTCHR-412 review round 3, non-blocking finding: the token directory
  // itself (not just each file inside it) should be 0700 — otherwise every
  // managed account NAME is listable by another local user even though each
  // token's contents stay unreadable.
  test("the token directory is created at 0700 when this call actually creates it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-rc-tokendir-"));
    try {
      const tokenDir = join(dir, "nested", "tokens");
      const { client } = fakeRcClient();
      const manager = createAccountManager(baseDeps({ client, store: fakeStore(), tokenDir }));
      await manager.ensureAccount(AGENT, "temporary");
      expect(statSync(tokenDir).mode & 0o777).toBe(0o700);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

  // BUTCHR-412 item 3 (BUTCHR-391 comment 24007): the ORIGINAL contract
  // (every ensureAccount revokes-then-reissues) conflicts with Nexus/rocketr
  // having registered the token once — a routine re-ensure must reuse it.
  describe("token rotation (BUTCHR-412 item 3)", () => {
    test("a second ensureAccount for the SAME agent with a still-valid token file reuses it untouched — no revoke, no regenerate", async () => {
      const { client, calls } = fakeRcClient();
      const store = fakeStore();
      const manager = createAccountManager(baseDeps({ client, store }));
      const first = await manager.ensureAccount(AGENT, "temporary");
      if (!first.ok || first.policy === "none") throw new Error("unreached");
      expect(first.rotated).toBe(true);
      const tokenBefore = readFileSync(first.tokenFile, "utf8");
      calls.length = 0;

      const second = await manager.ensureAccount(AGENT, "temporary");
      expect(second).toMatchObject({ ok: true, created: false, rotated: false, tokenFile: first.tokenFile });
      expect(calls.filter((c) => c.method === "revokeManagedToken" || c.method === "generateManagedToken")).toHaveLength(0);
      expect(readFileSync(first.tokenFile, "utf8")).toBe(tokenBefore); // byte-identical — never rewritten
    });

    test("a MISSING token file (deleted out-of-band) triggers a fresh mint rather than silently reusing nothing", async () => {
      const { client, calls } = fakeRcClient();
      const store = fakeStore();
      const manager = createAccountManager(baseDeps({ client, store }));
      const first = await manager.ensureAccount(AGENT, "temporary");
      if (!first.ok || first.policy === "none") throw new Error("unreached");
      rmSync(first.tokenFile);
      calls.length = 0;

      const second = await manager.ensureAccount(AGENT, "temporary");
      expect(second).toMatchObject({ ok: true, created: false, rotated: true });
      expect(calls.filter((c) => c.method === "generateManagedToken")).toHaveLength(1);
      if (!second.ok || second.policy === "none") throw new Error("unreached");
      expect(readFileSync(second.tokenFile, "utf8").trim().length).toBeGreaterThan(0);
    });

    test("an EMPTY (corrupted) token file is treated exactly like a missing one — fresh mint, never trusted as valid", async () => {
      const { client, calls } = fakeRcClient();
      const store = fakeStore();
      const manager = createAccountManager(baseDeps({ client, store }));
      const first = await manager.ensureAccount(AGENT, "temporary");
      if (!first.ok || first.policy === "none") throw new Error("unreached");
      writeFileSync(first.tokenFile, "");
      calls.length = 0;

      const second = await manager.ensureAccount(AGENT, "temporary");
      expect(second).toMatchObject({ ok: true, rotated: true });
      expect(calls.filter((c) => c.method === "generateManagedToken")).toHaveLength(1);
    });

    test("a PERMANENT account's adopt-on-every-start also reuses a still-valid token, never rotating a token Nexus already registered", async () => {
      const { client, calls } = fakeRcClient();
      const store = fakeStore();
      const manager = createAccountManager(baseDeps({ client, store }));
      const first = await manager.ensureAccount(AGENT, "permanent");
      if (!first.ok || first.policy === "none") throw new Error("unreached");
      for (let i = 0; i < 3; i++) {
        calls.length = 0;
        const r = await manager.ensureAccount(AGENT, "permanent");
        expect(r).toMatchObject({ ok: true, created: false, rotated: false, tokenFile: first.tokenFile });
        // A read-only liveness check (getUserByUsername) is still made — see
        // the "STALE persisted record" test above for why — but never a
        // token-rotating call (revoke/generate).
        expect(calls.map((c) => c.method)).toEqual(["getUserByUsername"]);
      }
    });
  });

  // BUTCHR-412 item 5 (BUTCHR-391 comment 23999): a separate, tighter cap on
  // concurrently-existing TEMPORARY accounts alone.
  describe("temporary-account cap (BUTCHR-412 item 5)", () => {
    test("withholds a NEW temporary account once the cap is reached, logging why, without touching the RC client", async () => {
      const { client, calls } = fakeRcClient();
      const store = fakeStore([
        { agentKey: "jira-work:triage:T-1", rcUserId: "u1", username: rcUsernameFor("jira-work:triage:T-1"), policy: "temporary", createdAt: "t" },
        { agentKey: "jira-work:triage:T-2", rcUserId: "u2", username: rcUsernameFor("jira-work:triage:T-2"), policy: "temporary", createdAt: "t" },
      ]);
      const manager = createAccountManager(baseDeps({ client, store, tempAccountCapThreshold: 2 }));
      const r = await manager.ensureAccount(AGENT, "temporary");
      expect(r).toEqual({ ok: false, reason: "temporary-cap-reached", message: expect.stringContaining("2") });
      expect(calls.filter((c) => c.method === "createUser")).toHaveLength(0);
    });

    test("never withholds a PERMANENT account, even once the temporary cap is reached", async () => {
      const { client, calls } = fakeRcClient();
      const store = fakeStore([
        { agentKey: "jira-work:triage:T-1", rcUserId: "u1", username: rcUsernameFor("jira-work:triage:T-1"), policy: "temporary", createdAt: "t" },
      ]);
      const manager = createAccountManager(baseDeps({ client, store, tempAccountCapThreshold: 1 }));
      const r = await manager.ensureAccount(AGENT, "permanent");
      expect(r).toMatchObject({ ok: true, created: true });
      void calls;
    });

    test("a PERMANENT account already on record never counts against the temporary cap", async () => {
      const { client } = fakeRcClient();
      const store = fakeStore([
        { agentKey: "jira-work:triage:P-1", rcUserId: "u1", username: rcUsernameFor("jira-work:triage:P-1"), policy: "permanent", createdAt: "t" },
      ]);
      const manager = createAccountManager(baseDeps({ client, store, tempAccountCapThreshold: 1 }));
      const r = await manager.ensureAccount(AGENT, "temporary");
      expect(r).toMatchObject({ ok: true, created: true }); // only 0 temporary accounts exist so far — the 1 permanent one doesn't count
    });

    test("below the cap, a temporary account is created normally", async () => {
      const { client } = fakeRcClient();
      const manager = createAccountManager(baseDeps({ client, store: fakeStore(), tempAccountCapThreshold: 5 }));
      const r = await manager.ensureAccount(AGENT, "temporary");
      expect(r).toMatchObject({ ok: true, created: true });
    });

    test("never checked on an ADOPT/REUSE path — only when actually about to create a new user", async () => {
      const { client, calls } = fakeRcClient();
      const store = fakeStore();
      const manager = createAccountManager(baseDeps({ client, store, tempAccountCapThreshold: 1 }));
      const first = await manager.ensureAccount(AGENT, "temporary");
      expect(first).toMatchObject({ ok: true, created: true });
      calls.length = 0;
      // Cap is now "reached" (1 of 1), but re-ensuring the SAME agent adopts its own existing record — never refused.
      const second = await manager.ensureAccount(AGENT, "temporary");
      expect(second).toMatchObject({ ok: true, created: false });
    });

    // BUTCHR-412 review round 3, blocking finding: `reconcileNow` runs
    // `ensure` for every admitted agent under one `Promise.all` — DIFFERENT
    // agent keys, so `ensureAccount`'s own per-key lock does nothing here.
    // The cap check must be atomic across concurrent calls for different
    // keys, not merely correct for one call at a time.
    describe("concurrency (BUTCHR-412 review round 3)", () => {
      test("12 concurrent NEW temporary ensures against a cap of 8 create exactly 8, refuse exactly 4 — never overshoots", async () => {
        const { client, calls } = fakeRcClient();
        const store = fakeStore();
        const manager = createAccountManager(baseDeps({ client, store, tempAccountCapThreshold: 8 }));
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) => manager.ensureAccount(`jira-work:triage:T-${i}`, "temporary")),
        );
        const created = results.filter((r) => r.ok && r.policy !== "none" && r.created);
        const refused = results.filter((r) => !r.ok && r.reason === "temporary-cap-reached");
        expect(created).toHaveLength(8);
        expect(refused).toHaveLength(4);
        expect(calls.filter((c) => c.method === "createUser")).toHaveLength(8);
        expect((await store.list()).filter((r) => r.policy === "temporary")).toHaveLength(8); // never more than the cap, even transiently
      });

      test("a failed create/mint releases its reservation — a throw never leaks a slot", async () => {
        const store = fakeStore();
        let failNext = true;
        const flaky: RocketChatClient = {
          async getUserByUsername() { return null; },
          async countUsers() { return 0; },
          async createUser(input) {
            if (failNext) { failNext = false; throw new RocketChatHttpError(503, "user create"); }
            return { id: `id-${input.username}`, username: input.username, active: true };
          },
          async deleteUser() {},
          async generateManagedToken() { return "tok"; },
          async revokeManagedToken() {},
        };
        const manager = createAccountManager(baseDeps({ client: flaky, store, tempAccountCapThreshold: 1 }));
        await expect(manager.ensureAccount("jira-work:triage:FAIL", "temporary")).rejects.toBeInstanceOf(RocketChatHttpError);
        // The failed attempt's reservation must have been released — a
        // second call (still under the SAME cap of 1) succeeds.
        const second = await manager.ensureAccount("jira-work:triage:OK", "temporary");
        expect(second).toMatchObject({ ok: true, created: true });
      });

      test("concurrent PERMANENT ensures are never refused by the temporary limit, even while temporary ensures are simultaneously at their own cap", async () => {
        const { client } = fakeRcClient();
        const store = fakeStore();
        const manager = createAccountManager(baseDeps({ client, store, tempAccountCapThreshold: 2 }));
        const results = await Promise.all([
          ...Array.from({ length: 4 }, (_, i) => manager.ensureAccount(`jira-work:triage:TMP-${i}`, "temporary")),
          ...Array.from({ length: 4 }, (_, i) => manager.ensureAccount(`jira-work:triage:PERM-${i}`, "permanent")),
        ]);
        const permanentResults = results.slice(4);
        expect(permanentResults.every((r) => r.ok && r.policy !== "none" && r.created)).toBe(true);
        const temporaryCreated = results.slice(0, 4).filter((r) => r.ok && r.policy !== "none" && r.created);
        expect(temporaryCreated).toHaveLength(2); // the temporary cap still holds, independently
      });

      // BUTCHR-412 review round 3: "the same window exists for the RC-wide
      // userCapThreshold check ... cover both."
      test("12 concurrent ensures (mixed temporary/permanent) against the RC-WIDE cap of 8 create exactly 8 total, never overshoot", async () => {
        // `countUsers()` here reflects `byUsername.size` LIVE (no override) —
        // same as a real RC server, whose own user count is immediately
        // consistent with a `createUser` that already completed on it. The
        // race this guards against is concurrent READS racing each other
        // BEFORE any of them has created anything yet (every concurrent
        // caller seeing the SAME pre-creation count) — not RC itself being
        // stale, which no in-process reservation could fix anyway.
        const { client, calls } = fakeRcClient();
        const store = fakeStore();
        const manager = createAccountManager(baseDeps({ client, store, userCapThreshold: 8, tempAccountCapThreshold: 100 }));
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) => manager.ensureAccount(`jira-work:triage:U-${i}`, i % 2 === 0 ? "temporary" : "permanent")),
        );
        const created = results.filter((r) => r.ok && r.policy !== "none" && r.created);
        const refused = results.filter((r) => !r.ok && r.reason === "cap-reached");
        expect(created).toHaveLength(8);
        expect(refused).toHaveLength(4);
        expect(calls.filter((c) => c.method === "createUser")).toHaveLength(8);
      });
    });
  });
});

describe("manifestEntries (BUTCHR-412, Nexus hand-off)", () => {
  test("lists every managed account with a token file, never a token VALUE", async () => {
    const { client } = fakeRcClient();
    const store = fakeStore();
    const manager = createAccountManager(baseDeps({ client, store }));
    const a = await manager.ensureAccount(AGENT, "temporary");
    const b = await manager.ensureAccount(AGENT2, "permanent");
    if (!a.ok || a.policy === "none" || !b.ok || b.policy === "none") throw new Error("unreached");

    const entries = await manager.manifestEntries();
    expect(entries.sort((x, y) => x.account.localeCompare(y.account))).toEqual(
      [{ account: a.username, tokenFile: a.tokenFile }, { account: b.username, tokenFile: b.tokenFile }].sort((x, y) => x.account.localeCompare(y.account)),
    );
    for (const e of entries) expect(JSON.stringify(e)).not.toMatch(/tok-/); // no fake-client token value leaks in
  });

  test("empty store -> empty manifest", async () => {
    const manager = createAccountManager(baseDeps({ store: fakeStore() }));
    expect(await manager.manifestEntries()).toEqual([]);
  });

  test('policy "none" never appears (ensureAccount("none") never touches the store)', async () => {
    const manager = createAccountManager(baseDeps({ store: fakeStore() }));
    await manager.ensureAccount(AGENT, "none");
    expect(await manager.manifestEntries()).toEqual([]);
  });
});

describe("releaseAccount", () => {
  async function provision(policy: "temporary" | "permanent") {
    const { client, calls, removeUserExternally } = fakeRcClient();
    const store = fakeStore();
    const manager = createAccountManager(baseDeps({ client, store }));
    const ensured = await manager.ensureAccount(AGENT, policy);
    if (!ensured.ok || ensured.policy === "none") throw new Error("unreached");
    return { manager, client, calls, store, removeUserExternally, rcUserId: ensured.rcUserId, username: ensured.username, tokenFile: ensured.tokenFile };
  }

  test("no managed account on record is a no-op that says so", async () => {
    const manager = createAccountManager(baseDeps({ store: fakeStore() }));
    expect(await manager.releaseAccount(AGENT, "stop")).toMatchObject({ ok: true, released: false, note: expect.stringContaining("no managed") });
  });

  test("temporary: stop/archive delete the user and clean up its managed token (RC token AND the local 0600 file)", async () => {
    for (const reason of ["stop", "archive"] as const) {
      const { manager, client, calls, store, rcUserId, tokenFile } = await provision("temporary");
      const revokesBefore = calls.filter((c) => c.method === "revokeManagedToken").length; // ensureAccount already issued one best-effort revoke+generate
      expect(existsSync(tokenFile)).toBe(true);
      const r = await manager.releaseAccount(AGENT, reason);
      expect(r).toEqual({ ok: true, released: true });
      expect(calls.filter((c) => c.method === "revokeManagedToken")).toHaveLength(revokesBefore + 1);
      expect(calls.filter((c) => c.method === "deleteUser" && c.args[0] === rcUserId)).toHaveLength(1);
      expect(await store.get(AGENT)).toBeNull();
      expect(await client.getUserByUsername(rcUsernameFor(AGENT))).toBeNull();
      expect(existsSync(tokenFile)).toBe(false); // the orphaned token file is cleaned up too, not just the store record
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
