/**
 * Reusable Rocket.Chat test doubles — a fake `AccountStore` and a fake
 * `RocketChatClient` — shared by every test that needs a fake RC without a
 * live server: `test/unit/rc-account-manager.test.ts` (the manager's own
 * unit tests) and `test/unit/account-lifecycle.test.ts`/
 * `test/unit/account-reconcile-matrix.test.ts` (BUTCHR-412's reconcile-layer
 * wiring, including the full {swarm,singleton,persistent} x
 * {none,temporary,permanent} matrix run through the real `reconcileNow`).
 * Extracted here, rather than duplicated per file, per that ticket's own DoD:
 * "make the harness reusable and say where it is" — this file is where it is.
 */
import { RocketChatApiError, type RocketChatClient, type RocketChatUser } from "../../src/resources/rocketchat.js";
import type { AccountManagerDeps, AccountRecord, AccountStore } from "../../src/accounts/manager.js";

export function fakeStore(initial: AccountRecord[] = []): AccountStore & { data: Map<string, AccountRecord> } {
  const data = new Map(initial.map((r) => [r.agentKey, r]));
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(r) { data.set(r.agentKey, r); },
    async delete(k) { data.delete(k); },
    async list() { return [...data.values()]; },
  };
}

export type FakeCall = { method: string; args: unknown[] };

export function fakeRcClient(seed: RocketChatUser[] = []) {
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

export const baseAccountManagerDeps = (over: Partial<AccountManagerDeps> = {}): AccountManagerDeps => ({
  client: fakeRcClient().client,
  store: fakeStore(),
  userCapThreshold: 45,
  now: () => "2026-09-24T00:00:00.000Z",
  randomPassword: () => "fixed-password",
  ...over,
});
