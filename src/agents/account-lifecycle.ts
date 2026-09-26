/**
 * Wires `AccountManager.ensureAccount`/`releaseAccount` (`../accounts/manager.ts`,
 * BUTCHR-410) into the generic reconciler (`../daemon/loop.ts`'s `reconcileNow`,
 * BUTCHR-412) — the follow-up `docs/rocketchat-accounts.md` names explicitly.
 * Deliberately provider-agnostic: nothing here imports `Rule`, Jira, GitHub,
 * Zendesk, or any ticket-writing seam — `policyOf`/`notify` are the two
 * injection points that let each provider loop (src/daemon/index.ts) supply
 * its own rule lookup and its own best-effort audible-refusal route.
 *
 * WHERE `ensure` IS CALLED, AND WHY THAT MAKES REUSING AN EXISTING TOKEN
 * SAFE: `reconcileNow` calls `ensure` for exactly two id sets — `admitted`
 * (this poll's `plan.spawn`, after BUTCHR-287's residency filter already
 * removed every already-resident candidate) and `plan.respawn` (stale-argv,
 * about to be stopped and replaced) — NEVER for an id that is currently
 * running and healthy. `../accounts/manager.ts`'s corrected rotation
 * contract (reuse a still-valid recorded token untouched; mint fresh only
 * when there is none, or it is missing/invalid) means calling `ensure` again
 * for an agent whose account Nexus already registered is now SAFE — it no
 * longer implies "reissue and invalidate what rocketr has."
 *
 * NEXUS MANIFEST BATCHING (BUTCHR-412, BUTCHR-391 comment 24007 item
 * "batch provisioning"): a rocketr registration reconnects the whole fleet,
 * so this module publishes the Nexus hand-off manifest AT MOST ONCE PER
 * `publishBatch()` CALL — `reconcileNow` calls it exactly once, at the very
 * end of each poll, after every `ensure`/`release` this poll made (see
 * `../daemon/loop.ts`). `ensure` and `release` never publish directly; they
 * only mark `dirty` when the store actually changed in a way Nexus needs to
 * know about (a fresh token minted, or an account actually deleted) — an
 * adopt-with-a-still-valid-token `ensure`, or a no-op `release` (a retaining
 * policy, a `respawn`/`daemon-restart` reason, no record at all), never
 * marks `dirty` and so never triggers a registration on its own. Whether N
 * agents start in one poll or the periodic orphan sweep
 * (`./account-orphan-sweep.ts`, its own separate timer, calling
 * `publishBatch` itself after its own sweep) releases M accounts, each
 * BATCH still produces at most one manifest write.
 *
 * RECOVERING A FAILED `release` (BUTCHR-412 review, round 1, blocking finding
 * 2): `reconcileNow`'s stop loop calls `release` strictly AFTER `herd.stop`
 * already succeeded — by the time `release` runs, the agent is gone. If
 * `releaseAccount` then THROWS (a transient Rocket.Chat failure — RC's own
 * "no such user" is already caught and treated as success by the manager;
 * anything else propagates), the id is no longer `running`, so it can never
 * again appear in a future poll's `plan.stop` — there is no natural retry
 * path through the ordinary reconcile diff the way an ordinary spawn/stop
 * failure gets one. `release` below never lets that throw escape: it queues
 * `id` in an in-memory `pendingReleases` map instead, and `retryPendingReleases`
 * (called once per poll by `reconcileNow`, independent of `plan.stop`) keeps
 * retrying every queued id until the manager confirms it (a resolved result,
 * `ok` true or false — only a THROW re-queues). This is the FAST recovery
 * path (next poll, seconds to a minute). The daemon's periodic orphan sweep
 * (`./account-orphan-sweep.ts`) is the SLOW, crash-safe backstop for the
 * same failure mode if the daemon restarts before a queued retry succeeds
 * (the in-memory queue does not survive a restart, but the store's record
 * does, and the sweep finds it independently).
 *
 * `ensure` cancels a pending release for the SAME id before proceeding
 * (BUTCHR-412 review follow-up, not itself a review finding but the same
 * reasoning closes a hazard round 1 introduced): if `id` was stopped,
 * `release("stop")` failed transiently and is still queued, and the SAME
 * agent identity is then spawned again before that retry lands,
 * `ensureAccount` will correctly ADOPT the still-live RC user (it was never
 * actually deleted) — but a stale queued release must not go on to delete
 * out from under the now-running agent the moment its retry next succeeds.
 */
import type { AccountManager, ReleaseReason } from "../accounts/manager.js";
import type { NexusManifestPublisher } from "../accounts/nexus-manifest.js";
import type { AccountPolicy } from "../rules/rules.js";
import type { SpawnSpec } from "./workspace.js";

/** `reconcileNow` only ever needs these two of `ReleaseReason` — see that type's own doc comment for `archive`/`daemon-restart`, neither of which any reconcile call site produces. */
export type ReconcileReleaseReason = Extract<ReleaseReason, "stop" | "respawn">;

export interface AccountLifecycleHooks {
  /**
   * Called for exactly the ids about to be spawned (never an already-running
   * one — see this module's own top comment). Resolves to the `SpawnSpec` to
   * actually hand to `herd.spawn` — augmented with this agent's own
   * (non-secret) Rocket.Chat account NAME, `spec.rocketchatAccount`, when
   * this id's rule wants an account and `ensureAccount` provisioned one — or
   * `null` to WITHHOLD the spawn entirely this poll: `ensureAccount`'s own
   * refusal (no RC configured, either cap, a non-managed username collision)
   * must never be silently swallowed into an agent that starts without the
   * account its rule requires.
   */
  ensure(spec: SpawnSpec): Promise<SpawnSpec | null>;
  /**
   * Called once per stop — `"stop"` for a genuine `plan.stop` (the rule no
   * longer desires this agent: disabled, singleton/persistent's query
   * dropping out, a done ticket, a `stand_down`/`check_in`-driven exit — see
   * `docs/rocketchat-accounts.md`'s policy table for which of these actually
   * unprovision) and `"respawn"` for a stale-argv respawn's own interim stop
   * (a no-op for a temporary account: the same agent identity is coming
   * right back, not stopping). Always calls the manager — never
   * pre-filtered by this launch's CURRENT rule policy, because the STORE's
   * own record (not today's rule config) is what decides whether there is
   * anything to release; a rule edited to `"none"` after an account was
   * already provisioned must still release it. NEVER THROWS — see this
   * module's own top comment: a transient failure is queued for
   * `retryPendingReleases` instead of propagating.
   */
  release(id: string, reason: ReconcileReleaseReason): Promise<void>;
  /**
   * Retries every release `release` above could not complete because the
   * manager call itself threw. Call once per poll, independent of
   * `plan.stop` (a queued id is by definition no longer running, so it will
   * never appear in a future `plan.stop` on its own) — see this module's own
   * top comment for the full recovery design. Never throws: each retry
   * catches its own rejection, same fault isolation `reconcileNow`'s own
   * spawn/stop loop already gives every OTHER per-id failure.
   */
  retryPendingReleases(): Promise<void>;
  /**
   * Publishes the Nexus hand-off manifest ONCE, but only if something this
   * BATCH actually changed (see this module's own top comment) — never
   * throws (a publish failure is logged; the next batch that is still dirty
   * tries again, since `dirty` is only cleared on a SUCCESSFUL publish).
   */
  publishBatch(): Promise<void>;
}

export interface AccountLifecycleDeps {
  manager: AccountManager;
  /** This agent id's rule's account policy. `"none"` for anything unrecognised (a legacy/bare id, or a rule since removed) — same fail-safe discipline as `AdmissionControllerDeps.roleOf` (src/agents/admission.ts): an id this daemon cannot identify must never provision an account for itself. */
  policyOf: (id: string) => AccountPolicy;
  /** Writes the batched (account name, token file path) manifest Nexus reads to register accounts with rocketr — `../accounts/nexus-manifest.ts`. */
  manifestPublisher: NexusManifestPublisher;
  log?: (line: string) => void;
  /**
   * Best-effort audible refusal beyond the log line `ensure` always writes —
   * e.g. a Jira comment on the ticket. Optional; omitted, a refusal is only
   * ever visible in the journal. Never awaited into a failure of `ensure`
   * itself: a notification that fails to send must not ALSO turn a real
   * withhold into a thrown error.
   */
  notify?: (id: string, message: string) => Promise<void>;
}

export function createAccountLifecycle(deps: AccountLifecycleDeps): AccountLifecycleHooks {
  const log = (line: string) => deps.log?.(line);
  /** Ids whose `release` call threw and has not yet been confirmed (`ok` true or false) by a retry. Keyed by id; the value is the reason to retry with. */
  const pendingReleases = new Map<string, ReconcileReleaseReason>();
  /** Set by `ensure`/`release` whenever the store changed in a way Nexus needs to know about; cleared only once `publishBatch` actually succeeds. */
  let dirty = false;

  async function attemptRelease(id: string, reason: ReconcileReleaseReason): Promise<void> {
    const result = await deps.manager.releaseAccount(id, reason);
    if (!result.ok) log(`WARNING: [account] ${id}: release (${reason}) refused (${result.reason}) — ${result.message}`);
    else if (result.released) { log(`[account] ${id}: Rocket.Chat account released (${reason})`); dirty = true; }
  }

  return {
    async ensure(spec) {
      if (pendingReleases.delete(spec.key)) {
        log(`[account] ${spec.key}: cancelling a queued release — this agent is being spawned again before its earlier release retry landed`);
      }
      const policy = deps.policyOf(spec.key);
      const result = await deps.manager.ensureAccount(spec.key, policy);
      if (result.ok && result.policy === "none") return spec;
      if (!result.ok) {
        const message = `[account] ${spec.key}: account policy "${policy}" refused (${result.reason}) — ${result.message} — withholding this agent's spawn rather than starting it without the account its rule requires`;
        log(`WARNING: ${message}`);
        if (deps.notify) await deps.notify(spec.key, message).catch((e) => log(`WARNING: [account] refusal notice failed for ${spec.key}: ${(e as Error)?.message ?? e}`));
        return null;
      }
      // result.ok && policy is "temporary" | "permanent".
      if (result.rotated) { log(`[account] ${spec.key}: Rocket.Chat account ${result.created ? "created" : "adopted"} (${result.username}) — fresh token minted`); dirty = true; }
      else log(`[account] ${spec.key}: Rocket.Chat account ${result.username} — existing registered token reused`);
      return { ...spec, rocketchatAccount: result.username };
    },
    async release(id, reason) {
      try {
        await attemptRelease(id, reason);
        pendingReleases.delete(id); // confirmed one way or the other — nothing left to retry
      } catch (e) {
        pendingReleases.set(id, reason);
        log(`WARNING: [account] ${id}: release (${reason}) failed — ${(e as Error)?.message ?? e} — queued for retry next poll`);
      }
    },
    async retryPendingReleases() {
      for (const [id, reason] of [...pendingReleases]) {
        try {
          await attemptRelease(id, reason);
          pendingReleases.delete(id);
        } catch (e) {
          log(`WARNING: [account] ${id}: queued release (${reason}) retry failed — ${(e as Error)?.message ?? e} — still queued`);
        }
      }
    },
    async publishBatch() {
      if (!dirty) return;
      try {
        const entries = await deps.manager.manifestEntries();
        await deps.manifestPublisher.publish(entries);
        dirty = false;
        log(`[account] Nexus manifest published (${entries.length} account${entries.length === 1 ? "" : "s"})`);
      } catch (e) {
        log(`WARNING: [account] Nexus manifest publish failed — ${(e as Error)?.message ?? e} — still dirty, retried next batch`);
      }
    },
  };
}
