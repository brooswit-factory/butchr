/**
 * The Rocket.Chat account lifecycle manager (BUTCHR-395/S4): a pure module
 * over an INJECTED `RocketChatClient` (`../resources/rocketchat.ts`) and an
 * injected `AccountStore`, implementing the policies `docs/rocketchat-accounts.md`
 * and `docs/execution-modes.md`'s `account` field describe. Standalone by
 * design — nothing here reads `Rule`, the herd, or the reconciler; a
 * follow-up task wires `ensureAccount`/`releaseAccount` into agent
 * start/stop. See that doc for the full contract, the identity mapping, the
 * persistence location, and the guardrail's exact refusal shape.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { workspaceRoot } from "../agents/workspace.js";
import { isRcUserNotFoundError, type RocketChatClient } from "../resources/rocketchat.js";
import type { AccountPolicy } from "../rules/rules.js";
import { isManagedUsername, rcUsernameFor } from "./identity.js";

export type { AccountPolicy };

/**
 * Why `releaseAccount` is called. `respawn` and `daemon-restart` must NEVER
 * unprovision a temporary account — both are the SAME agent identity coming
 * back, not it stopping; only `stop` and `archive` (BUTCHR-394's own entry
 * point) ever unprovision.
 */
export type ReleaseReason = "stop" | "archive" | "respawn" | "daemon-restart";

export interface AccountRecord {
  agentKey: string;
  rcUserId: string;
  username: string;
  policy: AccountPolicy;
  /** ISO timestamp of first creation; preserved across every later `ensureAccount` call for the same agent. */
  createdAt: string;
}

/** Injectable persistence — see `createFileAccountStore` for the default, workspace-root-anchored implementation and why it lives there. */
export interface AccountStore {
  get(agentKey: string): Promise<AccountRecord | null>;
  set(record: AccountRecord): Promise<void>;
  delete(agentKey: string): Promise<void>;
  /** Every currently-recorded managed account — the input `reconcileOrphans` filters. */
  list(): Promise<AccountRecord[]>;
}

export type AccountRefusalReason = "rc-not-configured" | "cap-reached" | "not-managed";

export interface AccountRefusal {
  ok: false;
  reason: AccountRefusalReason;
  message: string;
}

export type EnsureAccountResult =
  | { ok: true; policy: "none" }
  | { ok: true; policy: "temporary" | "permanent"; rcUserId: string; username: string; token: string; created: boolean }
  | AccountRefusal;

export type ReleaseAccountResult =
  | { ok: true; released: true }
  | { ok: true; released: false; note: string }
  | AccountRefusal;

export interface AccountManagerDeps {
  /** `null` means Rocket.Chat is not configured on this daemon — every `account !== "none"` call refuses loudly instead of throwing. */
  client: RocketChatClient | null;
  store: AccountStore;
  /** The 50-user guardrail threshold; see `docs/rocketchat-accounts.md` for the default and why it sits below 50. */
  userCapThreshold: number;
  now?: () => string;
  /** Injectable for deterministic tests; RC requires a password at creation even though login never uses it (see the doc). */
  randomPassword?: () => string;
}

export interface AccountManager {
  /** Idempotent create-if-missing. `policy: "none"` never touches the store or the client. Race-safe per agent key within this process; see the doc for the cross-process backstop. */
  ensureAccount(agentKey: string, policy: AccountPolicy): Promise<EnsureAccountResult>;
  /** `temporary` unprovisions on `stop`/`archive` only; `permanent`/`none` are a no-op that says so; `respawn`/`daemon-restart` never unprovision anything. */
  releaseAccount(agentKey: string, reason: ReleaseReason): Promise<ReleaseAccountResult>;
  /** Every managed account whose `agentExists(agentKey)` reads false — a pure listing, no deletion (the follow-up task and S5 own the sweep itself). */
  reconcileOrphans(agentExists: (agentKey: string) => boolean | Promise<boolean>): Promise<AccountRecord[]>;
}

const defaultNow = () => new Date().toISOString();
const defaultPassword = () => randomBytes(24).toString("base64url");
/** RFC 2606 reserves `.invalid` for exactly this: an address that must never resolve or receive mail. RC requires an email at creation; nothing here ever sends to it. */
const MANAGED_EMAIL_DOMAIN = "butchr.invalid";

const RC_NOT_CONFIGURED = (policy: AccountPolicy): AccountRefusal => ({
  ok: false,
  reason: "rc-not-configured",
  message: `account policy "${policy}" needs Rocket.Chat, but this daemon has no RC config (ROCKETCHAT_URL/ROCKETCHAT_ADMIN_USER_ID/ROCKETCHAT_ADMIN_TOKEN_FILE) — set it, or the rule's account policy back to "none"`,
});

const isUsernameTakenError = (e: unknown): boolean => e instanceof Error && /already in use|username is already/i.test(e.message);

/** Serializes calls sharing the same key onto one chain; calls for different keys run independently. This is the in-process half of race-safety — RC's own username-uniqueness constraint (caught in `ensureAccount`) is the cross-process backstop. */
function makeKeyedLock() {
  const chains = new Map<string, Promise<unknown>>();
  return function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = chains.get(key) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    chains.set(key, next.then(() => undefined, () => undefined));
    return next;
  };
}

export function createAccountManager(deps: AccountManagerDeps): AccountManager {
  const now = deps.now ?? defaultNow;
  const randomPassword = deps.randomPassword ?? defaultPassword;
  const withLock = makeKeyedLock();

  return {
    ensureAccount(agentKey, policy) {
      if (policy === "none") return Promise.resolve({ ok: true, policy: "none" });
      return withLock(agentKey, async (): Promise<EnsureAccountResult> => {
        const client = deps.client;
        if (!client) return RC_NOT_CONFIGURED(policy);
        const username = rcUsernameFor(agentKey);

        /**
         * `trustRecord: false` is used exactly once, recursively, when the
         * persisted record turns out to be STALE (its RC user is gone —
         * deleted out-of-band, or a prior `releaseAccount` deleted the RC
         * user but was interrupted before it could clear the record). RC is
         * the source of truth (docs/rocketchat-accounts.md): rather than
         * fail this and every future `ensureAccount` for this agent forever
         * (BUTCHR-410 review finding 1), drop the stale record and resolve
         * fresh — the second pass never trusts a record, so it terminates
         * after at most one retry.
         */
        const attempt = async (trustRecord: boolean): Promise<EnsureAccountResult> => {
          const existingRecord = trustRecord ? await deps.store.get(agentKey) : null;
          let user = existingRecord ? { id: existingRecord.rcUserId, username: existingRecord.username } : await client.getUserByUsername(username);
          let created = false;

          if (!user) {
            const count = await client.countUsers();
            if (count >= deps.userCapThreshold) {
              return { ok: false, reason: "cap-reached", message: `Rocket.Chat has ${count} users, at or over the configured guardrail threshold (${deps.userCapThreshold}) — refusing to create another; raise the threshold (below the real 50-user allowance) or free up accounts first` };
            }
            try {
              const created_ = await client.createUser({ username, name: username, email: `${username}@${MANAGED_EMAIL_DOMAIN}`, password: randomPassword() });
              user = { id: created_.id, username: created_.username };
              created = true;
            } catch (e) {
              if (!isUsernameTakenError(e)) throw e;
              // Lost the create race to a concurrent ensureAccount (this process or another) — adopt what it made rather than erroring or duplicating.
              const found = await client.getUserByUsername(username);
              if (!found) throw e;
              user = { id: found.id, username: found.username };
            }
          }

          if (!isManagedUsername(user.username)) return { ok: false, reason: "not-managed", message: `Rocket.Chat username ${JSON.stringify(user.username)} for ${agentKey} carries no butchr-managed marker; refusing to adopt it` };

          try {
            // Best-effort revoke before issuing a fresh one: a fresh user has nothing to revoke (revokeManagedToken already treats "no such token" as success, not an error).
            await client.revokeManagedToken(user.id);
            const token = await client.generateManagedToken(user.id);
            const record: AccountRecord = { agentKey, rcUserId: user.id, username: user.username, policy, createdAt: existingRecord?.createdAt ?? now() };
            await deps.store.set(record);
            return { ok: true, policy, rcUserId: user.id, username: user.username, token, created };
          } catch (e) {
            if (existingRecord && isRcUserNotFoundError(e)) {
              await deps.store.delete(agentKey);
              return attempt(false);
            }
            throw e;
          }
        };

        return attempt(true);
      });
    },

    releaseAccount(agentKey, reason) {
      return withLock(agentKey, async (): Promise<ReleaseAccountResult> => {
        const record = await deps.store.get(agentKey);
        if (!record) return { ok: true, released: false, note: `no managed Rocket.Chat account is on record for ${agentKey}` };
        if (record.policy !== "temporary") return { ok: true, released: false, note: `policy "${record.policy}" retains its Rocket.Chat account across ${reason}` };
        if (reason === "respawn" || reason === "daemon-restart") return { ok: true, released: false, note: `reason "${reason}" never unprovisions a temporary account — it is the same agent identity coming back, not it stopping` };

        const client = deps.client;
        if (!client) return RC_NOT_CONFIGURED(record.policy);
        if (!isManagedUsername(record.username) || record.username !== rcUsernameFor(agentKey)) {
          return { ok: false, reason: "not-managed", message: `refusing to unprovision ${JSON.stringify(record.username)} for ${agentKey}: it does not carry butchr's own managed-account marker for this agent` };
        }

        try {
          await client.revokeManagedToken(record.rcUserId);
          await client.deleteUser(record.rcUserId);
        } catch (e) {
          // Idempotent release (BUTCHR-410 review finding 2): stop/archive
          // can legitimately be called again for an agent whose RC user is
          // already gone (this call's own earlier attempt succeeded but was
          // interrupted before the record was cleared, or something else
          // removed it) — treat "already gone" as "already released", not a
          // failure that leaves an un-clearable record behind forever.
          if (!isRcUserNotFoundError(e)) throw e;
        }
        await deps.store.delete(agentKey);
        return { ok: true, released: true };
      });
    },

    async reconcileOrphans(agentExists) {
      const all = await deps.store.list();
      const orphans: AccountRecord[] = [];
      for (const record of all) if (!(await agentExists(record.agentKey))) orphans.push(record);
      return orphans;
    },
  };
}

/**
 * The default, durable `AccountStore`: one JSON file at the workspace root
 * (NOT inside any per-agent workspace directory — `buildWorkspace`
 * (`../agents/workspace.ts`) rewrites CLAUDE.md/brief.md/mcp.json/
 * ENVIRONMENT.md on every spawn and a per-resource workspace directory may
 * not exist yet the first time an agent is ensured). A flat, root-anchored
 * file survives stop, respawn and daemon restart exactly because nothing
 * else in this codebase ever touches it, and makes `reconcileOrphans` a
 * single read rather than a walk of every agent's workspace directory.
 */
export function createFileAccountStore(path: string = join(workspaceRoot(), ".butchr-rc-accounts.json")): AccountStore {
  /**
   * ONLY a missing file (ENOENT) reads as empty. A review finding
   * (BUTCHR-410, blocking #3) on this module's first pass: swallowing every
   * read error — a truncated write, disk corruption, anything — as "empty"
   * meant the very next `set` call would silently rewrite the file with
   * just that one record, forgetting every other managed account (a real
   * RC seat leak against the 50-user cap, and a `reconcileOrphans` that
   * would then report every one of them as an orphan). Any other read or
   * parse failure THROWS instead, loud, so an operator notices a corrupt
   * store rather than watching it quietly forget accounts.
   */
  const load = (): Record<string, AccountRecord> => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`Rocket.Chat account store ${path} could not be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    try {
      return JSON.parse(text) as Record<string, AccountRecord>;
    } catch (e) {
      throw new Error(`Rocket.Chat account store ${path} holds invalid JSON — refusing to treat a corrupt file as empty, which would silently forget every recorded account: ${(e as Error).message}`);
    }
  };
  /** Write-to-temp-then-rename: a reader (this process or another) never observes a partially-written file, even if the process dies mid-write. */
  const save = (data: Record<string, AccountRecord>): void => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    try {
      renameSync(tmp, path);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      throw e;
    }
  };
  return {
    async get(agentKey) { return load()[agentKey] ?? null; },
    async set(record) { const data = load(); data[record.agentKey] = record; save(data); },
    async delete(agentKey) { const data = load(); delete data[agentKey]; save(data); },
    async list() { return Object.values(load()); },
  };
}
