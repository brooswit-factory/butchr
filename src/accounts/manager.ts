/**
 * The Rocket.Chat account lifecycle manager (BUTCHR-395/S4, corrected design
 * BUTCHR-412/BUTCHR-391 comments 23997/23999/24003/24007): a pure module
 * over an INJECTED `RocketChatClient` (`../resources/rocketchat.ts`) and an
 * injected `AccountStore`, implementing the policies `docs/rocketchat-accounts.md`
 * and `docs/execution-modes.md`'s `account` field describe. Standalone by
 * design — nothing here reads `Rule`, the herd, or the reconciler;
 * `../agents/account-lifecycle.ts` wires `ensureAccount`/`releaseAccount`
 * into agent start/stop, and batches this module's `manifestEntries()` into
 * one Nexus publish per reconcile poll. See that doc for the full contract,
 * the identity mapping, the persistence location, and the guardrail's exact
 * refusal shape.
 *
 * CORRECTED CREDENTIAL DESIGN (BUTCHR-391 comment 24007 supersedes the
 * original ticket's "hand the agent a token file it reads itself"): an agent
 * never holds an RC credential. This module still mints and revokes the
 * managed Personal Access Token exactly as before, but the token itself is
 * now written ONLY to a 0600 file in a daemon-owned directory
 * (`AccountManagerDeps.tokenDir`, never any agent's own workspace) and never
 * returned to a caller — `EnsureAccountResult` carries `tokenFile` (a path)
 * where it used to carry `token` (a value). `manifestEntries()` is the read
 * path `account-lifecycle.ts` uses to hand Nexus the (account name, token
 * file path) pairs it registers with rocketr — see
 * `../accounts/nexus-manifest.ts`.
 *
 * TOKEN ROTATION, FIXED (BUTCHR-391 comment 24007 item 3): the ORIGINAL
 * contract — every `ensureAccount` call revokes and reissues the token,
 * unconditionally — conflicts with Nexus/rocketr having registered the
 * token once: a routine re-ensure (a respawn, a permanent account's adopt-on-
 * every-start) would silently invalidate what rocketr already has. Fixed
 * here: `ensureAccount` reuses an existing, still-present, non-empty token
 * file untouched (no RC token API calls at all) and only mints a fresh one
 * when there is no recorded token file yet, or the recorded one is missing/
 * unreadable/empty — see `tokenFileValid` below. `EnsureAccountResult.rotated`
 * tells `account-lifecycle.ts` which happened, so it can decide whether this
 * account needs to be (re-)announced to Nexus this batch.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { workspaceRoot } from "../agents/workspace.js";
import { isRcUserNotFoundError, type RocketChatClient } from "../resources/rocketchat.js";
import type { AccountPolicy } from "../rules/rules.js";
import { isManagedUsername, rcUsernameFor } from "./identity.js";
import type { NexusManifestEntry } from "./nexus-manifest.js";

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
  /**
   * BUTCHR-412: path to the 0600 file this account's current managed token
   * lives in (`AccountManagerDeps.tokenDir`) — never the token's own value.
   * Absent only for a record persisted by a pre-BUTCHR-412 build (defensive;
   * every record this module itself ever writes carries it) — treated
   * exactly like a missing/invalid file (see `tokenFileValid`), so such a
   * record just mints a fresh token and file on its next `ensureAccount`.
   */
  tokenFile?: string;
}

/** Injectable persistence — see `createFileAccountStore` for the default, workspace-root-anchored implementation and why it lives there. */
export interface AccountStore {
  get(agentKey: string): Promise<AccountRecord | null>;
  set(record: AccountRecord): Promise<void>;
  delete(agentKey: string): Promise<void>;
  /** Every currently-recorded managed account — the input `reconcileOrphans` filters. */
  list(): Promise<AccountRecord[]>;
}

export type AccountRefusalReason = "rc-not-configured" | "cap-reached" | "temporary-cap-reached" | "not-managed";

export interface AccountRefusal {
  ok: false;
  reason: AccountRefusalReason;
  message: string;
}

export type EnsureAccountResult =
  | { ok: true; policy: "none" }
  | { ok: true; policy: "temporary" | "permanent"; rcUserId: string; username: string; tokenFile: string; created: boolean; rotated: boolean }
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
  /**
   * BUTCHR-412 (BUTCHR-391 comment 23999): a SEPARATE, smaller cap on the
   * number of CONCURRENTLY EXISTING `temporary` accounts (never `permanent`
   * — see `EnsureAccountResult`'s own refusal shape below), because RC's
   * ~10 free seats (of 50) are shared with S5's own `butchr-test-*` cap (5)
   * and permanent accounts, which must never be starved by a busy swarm rule
   * churning through temporary ones. Checked ONLY when `ensureAccount` is
   * about to CREATE a new user for a `"temporary"` policy — never on an
   * adopt/reuse path, which creates nothing.
   */
  tempAccountCapThreshold: number;
  /**
   * BUTCHR-412: a daemon-owned directory this module writes each managed
   * account's 0600 token file into — never inside any agent's own workspace
   * directory (`../agents/workspace.ts`'s `workspaceDirFor`). Created
   * (recursively) on first write if absent.
   */
  tokenDir: string;
  /** BUTCHR-412 (naming convention, BUTCHR-391 comment 24003 item 7): overrides `RC_MANAGED_PREFIX` when set — see `../accounts/identity.ts`. */
  managedPrefix?: string;
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
  /**
   * Every currently-recorded managed account with a token file on record —
   * the (account name, token file path) pairs `../agents/account-lifecycle.ts`
   * batches into one `NexusManifestPublisher.publish()` call per reconcile
   * poll (BUTCHR-412, BUTCHR-391 comment 24007). Reads the SAME store
   * `ensureAccount`/`releaseAccount` maintain — never a second source of
   * truth, and never a token VALUE, only the path.
   */
  manifestEntries(): Promise<NexusManifestEntry[]>;
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

/** `path` names a token file this module itself is expected to have written — a missing, unreadable, or empty file all read as "no longer usable" and trigger a fresh mint, never a throw (a deleted/corrupted file must never wedge `ensureAccount`). */
function tokenFileValid(path: string): boolean {
  try {
    return readFileSync(path, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

/** Write-then-chmod, same belt-and-suspenders as `buildWorkspace`'s own credential-file writes (`src/agents/workspace.ts`): `writeFileSync`'s `mode` option only applies when the underlying `open()` call CREATES the file, so an explicit `chmodSync` covers the "this token file already existed" case too (a stale, invalid file being freshly re-minted). */
function writeTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** One file per managed account, named by its (already-unique, deterministic) RC username — never by agent key, so it stays stable across an agent key's own possible future renaming schemes and reads unambiguously on disk. */
const tokenFilePath = (tokenDir: string, username: string): string => join(tokenDir, `${username}.token`);

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
        const username = rcUsernameFor(agentKey, deps.managedPrefix);

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
            // BUTCHR-412 (BUTCHR-391 comment 23999): the seat cap above is
            // the whole-fleet guardrail; this is a SEPARATE, tighter limit
            // on concurrently-existing TEMPORARY accounts alone (never
            // permanent — see this method's own refusal reasons), checked
            // only on this same "about to create" path, never on an
            // adopt/reuse.
            if (policy === "temporary") {
              const tempCount = (await deps.store.list()).filter((r) => r.policy === "temporary").length;
              if (tempCount >= deps.tempAccountCapThreshold) {
                return { ok: false, reason: "temporary-cap-reached", message: `${tempCount} temporary Rocket.Chat accounts already exist, at or over the configured limit (${deps.tempAccountCapThreshold}) — withholding this one; it will be retried next poll rather than exceeding the limit or starving a permanent account's seat` };
              }
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

          if (!isManagedUsername(user.username, deps.managedPrefix)) return { ok: false, reason: "not-managed", message: `Rocket.Chat username ${JSON.stringify(user.username)} for ${agentKey} carries no butchr-managed marker; refusing to adopt it` };

          const tokenFile = tokenFilePath(deps.tokenDir, user.username);
          // BUTCHR-412: reuse a still-valid recorded token untouched — no RC
          // TOKEN api call at all (no revoke, no regenerate) — rather than
          // the original contract's unconditional revoke-then-reissue, which
          // would silently invalidate whatever Nexus/rocketr already
          // registered for a routine re-ensure (respawn, permanent
          // adopt-on-every-start, daemon restart). Only ever attempted when
          // this SAME agent already had a record AND that record's own
          // token file still reads back non-empty.
          //
          // STILL calls `getUserByUsername` — a READ, never a write — before
          // trusting it: the ORIGINAL contract's unconditional revoke call
          // was ALSO this module's only signal that the recorded RC user had
          // been deleted out-of-band (revoke against a gone user fails with
          // RC's "not found"), and removing that call without a replacement
          // would silently break stale-record recovery (a KEEP behaviour —
          // see docs/rocketchat-accounts.md) for exactly the "token file
          // still present, but RC user is gone" case. A read-only lookup
          // preserves the detection without ever touching (or risking
          // invalidating) the token itself.
          if (existingRecord?.tokenFile && tokenFileValid(existingRecord.tokenFile)) {
            const stillThere = await client.getUserByUsername(user.username);
            if (!stillThere) {
              try { unlinkSync(existingRecord.tokenFile); } catch { /* already gone, or never existed — either way, nothing to clean up */ }
              await deps.store.delete(agentKey);
              return attempt(false);
            }
            const record: AccountRecord = { agentKey, rcUserId: stillThere.id, username: stillThere.username, policy, createdAt: existingRecord.createdAt, tokenFile: existingRecord.tokenFile };
            await deps.store.set(record); // keeps `policy` in sync if the rule's own account policy changed since the last ensure (temporary <-> permanent)
            return { ok: true, policy, rcUserId: stillThere.id, username: stillThere.username, tokenFile: existingRecord.tokenFile, created, rotated: false };
          }

          try {
            // Best-effort revoke before issuing a fresh one: a fresh user has nothing to revoke (revokeManagedToken already treats "no such token" as success, not an error).
            await client.revokeManagedToken(user.id);
            const token = await client.generateManagedToken(user.id);
            writeTokenFile(tokenFile, token);
            const record: AccountRecord = { agentKey, rcUserId: user.id, username: user.username, policy, createdAt: existingRecord?.createdAt ?? now(), tokenFile };
            await deps.store.set(record);
            return { ok: true, policy, rcUserId: user.id, username: user.username, tokenFile, created, rotated: true };
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
        if (!isManagedUsername(record.username, deps.managedPrefix) || record.username !== rcUsernameFor(agentKey, deps.managedPrefix)) {
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
        // Best-effort cleanup of the now-orphaned token file — never fails
        // the release over it (a missing file is the common, expected case
        // on a second/idempotent release call).
        if (record.tokenFile) { try { unlinkSync(record.tokenFile); } catch { /* nothing to remove, or already gone */ } }
        return { ok: true, released: true };
      });
    },

    async reconcileOrphans(agentExists) {
      const all = await deps.store.list();
      const orphans: AccountRecord[] = [];
      for (const record of all) if (!(await agentExists(record.agentKey))) orphans.push(record);
      return orphans;
    },

    async manifestEntries() {
      const all = await deps.store.list();
      return all.filter((r): r is AccountRecord & { tokenFile: string } => Boolean(r.tokenFile)).map((r) => ({ account: r.username, tokenFile: r.tokenFile }));
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
