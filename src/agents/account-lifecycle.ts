/**
 * Wires `AccountManager.ensureAccount`/`releaseAccount` (`../accounts/manager.ts`,
 * BUTCHR-410) into the generic reconciler (`../daemon/loop.ts`'s `reconcileNow`,
 * BUTCHR-412) — the follow-up `docs/rocketchat-accounts.md` names explicitly.
 * Deliberately provider-agnostic: nothing here imports `Rule`, Jira, GitHub,
 * Zendesk, or any ticket-writing seam — `policyOf`/`notify` are the two
 * injection points that let each provider loop (src/daemon/index.ts) supply
 * its own rule lookup and its own best-effort audible-refusal route.
 *
 * WHERE `ensure` IS CALLED, AND WHY THAT MAKES THE TOKEN-ROTATION CONTRACT
 * SAFE: `reconcileNow` calls `ensure` for exactly two id sets — `admitted`
 * (this poll's `plan.spawn`, after BUTCHR-287's residency filter already
 * removed every already-resident candidate) and `plan.respawn` (stale-argv,
 * about to be stopped and replaced) — NEVER for an id that is currently
 * running and healthy. `docs/rocketchat-accounts.md`'s rotation contract
 * ("every `ensureAccount` call invalidates whatever managed token that agent
 * held before") is exactly what `ensure`'s two call sites need: a fresh
 * token is exactly what a NEW launch (first spawn or a respawn's
 * replacement) needs, and neither call site is ever reached for an
 * already-running agent.
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
import type { AccountPolicy } from "../rules/rules.js";
import type { SpawnSpec } from "./workspace.js";

/** `reconcileNow` only ever needs these two of `ReleaseReason` — see that type's own doc comment for `archive`/`daemon-restart`, neither of which any reconcile call site produces. */
export type ReconcileReleaseReason = Extract<ReleaseReason, "stop" | "respawn">;

export interface AccountLifecycleHooks {
  /**
   * Called for exactly the ids about to be spawned (never an already-running
   * one — see this module's own top comment). Resolves to the `SpawnSpec` to
   * actually hand to `herd.spawn` — augmented with fresh Rocket.Chat
   * connection material when this id's rule wants an account — or `null` to
   * WITHHOLD the spawn entirely this poll: `ensureAccount`'s own refusal (no
   * RC configured, the user-cap guardrail, a non-managed username collision)
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
}

export interface AccountLifecycleDeps {
  manager: AccountManager;
  /** This agent id's rule's account policy. `"none"` for anything unrecognised (a legacy/bare id, or a rule since removed) — same fail-safe discipline as `AdmissionControllerDeps.roleOf` (src/agents/admission.ts): an id this daemon cannot identify must never provision an account for itself. */
  policyOf: (id: string) => AccountPolicy;
  /** Rocket.Chat's own base URL — embedded in the connection material handed to a launcher (without it, `rcUserId`/`token` alone are useless: nothing to send them to). `undefined` when RC is not configured; `ensure` then hands back the spec un-augmented for any launch that would otherwise have gotten connection material — which cannot actually happen, since a `null` `client` (see `../accounts/manager.ts`) already refuses every non-`"none"` `ensureAccount` call before this would matter. */
  url?: string;
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

  async function attemptRelease(id: string, reason: ReconcileReleaseReason): Promise<void> {
    const result = await deps.manager.releaseAccount(id, reason);
    if (!result.ok) log(`WARNING: [account] ${id}: release (${reason}) refused (${result.reason}) — ${result.message}`);
    else if (result.released) log(`[account] ${id}: Rocket.Chat account released (${reason})`);
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
      if (!deps.url) return spec; // unreachable in practice — see this Deps field's own doc comment — but never silently drop a real ok:true result over it.
      log(`[account] ${spec.key}: Rocket.Chat account ${result.created ? "created" : "adopted"} (${result.username})`);
      return { ...spec, rocketchat: { url: deps.url, rcUserId: result.rcUserId, username: result.username, token: result.token } };
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
  };
}
