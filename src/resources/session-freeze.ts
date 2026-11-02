/**
 * BUTCHR-454 — the reusable freeze/unfreeze CORE for a managed-session
 * definition: no argv/stdout in here (`src/cli/session-cli.ts` is the thin
 * layer on top), because a later task exposes the same operation through
 * `freeze_session`/`unfreeze_session` MCP tools (BUTCHR-394 comment 24391,
 * proposal 5) — those tools authorize the caller, then call straight into
 * `freezeSessionDefinition`/`unfreezeSessionDefinition` below, unchanged.
 *
 * TWO independent freeze gates, per BUTCHR-394's own decided design
 * (comment 24391/24396):
 *
 * 1. The STORE — `@brooswit/drovr-events`' `instanceFreezeStore`, keyed
 *    `butchr:<agentKey>` (exactly what `HerdrHerd.frozen()`,
 *    `src/agents/herd.ts`, already reads every reconcile poll). This is the
 *    gate that actually stops a RUNNING agent — `reconcileNow`
 *    (`src/daemon/loop.ts`) drops a frozen id from `desired` before both its
 *    spawn and its stop decision, unconditionally, regardless of the
 *    definition's own `execution`/`role` — an explicit freeze wins over
 *    persistence/sentinel status with no special case needed there.
 * 2. The MANIFEST — the definition file's own `frozen: true` field, already
 *    read by `searchSessionDefinitions` (`src/rules/session-definition-
 *    type.ts`) to exclude a definition from the eligible set entirely.
 *
 * WHY BOTH: the store key is derived from the definition's FILE PATH
 * (`sessionAgentKey` below, same codec `searchSessionDefinitions` uses to
 * build a match's `agentKey`) — renaming or moving a manifest changes its
 * key and would silently drop store-only freeze state. The manifest flag
 * survives a rename because `searchSessionDefinitions` reads it from
 * whatever file is AT the (possibly new) path, independent of any store
 * key. This is what lets a frozen persistent definition (the 10 CNDLX-45
 * MUD players) stay frozen through an archive/restore move (BUTCHR-394 T2)
 * even though that changes the store key entirely.
 *
 * ORDER MATTERS, per BUTCHR-394's own decision, so a crash/interrupt
 * between the two writes fails towards "still frozen" rather than
 * "silently staffed":
 * - freeze:   (1) store.set(true)  FIRST, then (2) manifest `frozen: true`.
 * - unfreeze: (1) manifest cleared FIRST, then (2) store.set(false).
 * Both are idempotent — calling either when only one gate (or neither, or
 * both) already matches the target state still ends with both gates in the
 * target state.
 */
import { readFile } from "node:fs/promises";
import { freezeStateRoot, instanceFreezeStore, InstanceFreezeStore } from "@brooswit/drovr-events";
import { encodeAgentKey } from "../rules/agent-key.js";
import { MANAGED_SESSIONS_RULE_ID } from "../rules/session-definition-type.js";
import { writeFileAtomic } from "./atomic-write.js";

export { freezeStateRoot, InstanceFreezeStore };

/** The filesystem agent key `searchSessionDefinitions` would build for this definition path — identical codec, so the freeze store key below is derived exactly the way the reconcile loop resolves it. */
export function sessionAgentKey(path: string): string {
  return encodeAgentKey({ resourceProvider: "filesystem", ruleId: MANAGED_SESSIONS_RULE_ID, resourceId: path });
}

/** `instanceFreezeStore`'s own key shape (`herd.ts`: `` `butchr:${id}` ``), applied to a definition's own agent key. */
export const sessionFreezeStoreKey = (path: string): string => `butchr:${sessionAgentKey(path)}`;

/** The slice of `InstanceFreezeStore` this module needs — narrow, so a test can inject an in-memory fake instead of touching real disk under `freezeStateRoot()`. */
export interface SessionFreezeStore {
  read(instanceId: string): Promise<{ frozen: boolean }>;
  set(instanceId: string, frozen: boolean): Promise<unknown>;
}

export interface SessionFreezeIo {
  /** Defaults to the real `instanceFreezeStore` (root `freezeStateRoot()`, honours `DROVR_CONTROL_HOME`) — the SAME store/root the daemon's own `HerdrHerd.frozen()` reads. A test passes `new InstanceFreezeStore(tmpRoot)` instead. */
  store: SessionFreezeStore;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

export const defaultSessionFreezeIo = (): SessionFreezeIo => ({
  store: instanceFreezeStore,
  readFile: (p) => readFile(p, "utf8"),
  writeFile: writeFileAtomic,
});

export interface FreezeGates {
  manifestFrozen: boolean;
  storeFrozen: boolean;
}

/**
 * Store-unreadable fails CLOSED (reported frozen) — the same discipline
 * `HerdrHerd.frozen()` already applies ("Unreadable freeze state fails
 * closed"), so a transient read error never LOOKS like "eligible to run"
 * from this CLI's own `list`/`show`.
 */
export async function readStoreFrozen(store: Pick<SessionFreezeStore, "read">, path: string): Promise<boolean> {
  try {
    return (await store.read(sessionFreezeStoreKey(path))).frozen;
  } catch {
    return true;
  }
}

/** Both gates for one definition path — `manifestFrozen` reads the RAW JSON `frozen` field directly (never the fully-parsed/defaulted `SessionDefinition`), so this still answers for a file that is otherwise invalid in some other field. */
export async function readFreezeGates(io: Pick<SessionFreezeIo, "store" | "readFile">, path: string): Promise<FreezeGates> {
  const [manifestFrozen, storeFrozen] = await Promise.all([readManifestFrozen(io, path), readStoreFrozen(io.store, path)]);
  return { manifestFrozen, storeFrozen };
}

async function readManifestFrozen(io: Pick<SessionFreezeIo, "readFile">, path: string): Promise<boolean> {
  const doc: unknown = JSON.parse(await io.readFile(path));
  return typeof doc === "object" && doc !== null && (doc as Record<string, unknown>).frozen === true;
}

/** Rewrites ONLY the `frozen` field, preserving every other field byte-for-byte in VALUE (re-serialized, not a text patch) — never the normalized/defaulted `SessionDefinition` (which would expand `~` in `workingDirectory` and materialize every optional field's default). Atomic (temp file + rename, same directory) via `writeFileAtomic`. */
async function rewriteManifestFrozen(io: Pick<SessionFreezeIo, "readFile" | "writeFile">, path: string, frozen: boolean): Promise<void> {
  const raw = await io.readFile(path);
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path}: invalid JSON, cannot rewrite: ${(e as Error).message}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error(`${path}: must be a JSON object`);
  const next = { ...(doc as Record<string, unknown>), frozen };
  await io.writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** Idempotent: safe to call whether the manifest/store were already frozen, only one was, or neither was — ends with BOTH gates open. */
export async function freezeSessionDefinition(io: SessionFreezeIo, path: string): Promise<FreezeGates> {
  await io.store.set(sessionFreezeStoreKey(path), true);
  await rewriteManifestFrozen(io, path, true);
  return { manifestFrozen: true, storeFrozen: true };
}

/** Idempotent, same as `freezeSessionDefinition` — ends with BOTH gates closed regardless of starting state. */
export async function unfreezeSessionDefinition(io: SessionFreezeIo, path: string): Promise<FreezeGates> {
  await rewriteManifestFrozen(io, path, false);
  await io.store.set(sessionFreezeStoreKey(path), false);
  return { manifestFrozen: false, storeFrozen: false };
}
