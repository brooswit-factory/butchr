import { watch, type Stop } from "@brooswit/sundry";
import type { JiraIssue, JiraComment } from "../atlassian/types.js";
import { planReconcile } from "../reconcile/plan.js";
import type { Herd, SpawnSpec } from "../agents/herd.js";
import type { ResourceType, RelatedResource } from "../resources/types.js";
import { createIssueEventRules, ISSUE_ACTIVATION, ISSUE_SPAWN_CONFIG, issueIdOf } from "../resources/issue.js";
export type { NotifyReason } from "../resources/types.js";
import type { NotifyReason } from "../resources/types.js";

/**
 * A ticket watched on behalf of active issues via the Implements chain (see
 * src/jira-watch/routes.ts). This is `RelatedResource<T>`
 * (src/resources/types.ts) defaulted to `T = JiraIssue` — the shape every
 * existing caller (src/agents/parked.ts, and this file's own issue-tier
 * wiring below) already depends on; a second resource type would use
 * `RelatedResource<ItsShape>` directly instead of this alias.
 */
export type RelatedIssue<T = JiraIssue> = RelatedResource<T>;

export interface LoopDeps {
  /** Fetch the assigned issues (active + recently changed) each poll. */
  search: () => Promise<JiraIssue[]>;
  /**
   * Fetch tickets related to the active set via the Implements chain (see
   * src/jira-watch/routes.ts), with the active keys that watch each. Related
   * tickets are watched regardless of assignee, so a hierarchy can span
   * credentials (and machines): a boss hears about its implementer's
   * progress even when another daemon staffs it.
   */
  related?: (active: readonly string[]) => Promise<RelatedIssue[]>;
  herd: Herd;
  /**
   * Nudge the agent working `issue`; `about` is the ticket that changed (not
   * always its own). `reason`, when present, names WHY beyond the default
   * "your ticket changed" — see `NotifyReason`.
   */
  notify: (issue: string, about: string, reason?: NotifyReason) => void | Promise<void>;
  /**
   * Called once per respawned agent, right after it's back up. Jira knowledge
   * (the [butchr:respawn] notice) lives OUTSIDE loop.ts — this is the seam
   * src/daemon/index.ts wires it through.
   */
  onRespawn?: (issue: string, reason: string, observedArgv: string[]) => void | Promise<void>;
  /** Reconcile daemon-owned (agent:*, pr:*) labels on this poll's `issues`. */
  syncLabels?: (issues: readonly JiraIssue[]) => Promise<ReadonlySet<string>>;
  /**
   * Whether a ping to `watcher` about `key` (now at `updated`) should be
   * swallowed as an echo of a write THIS daemon made — see the own-write
   * ledger, src/jira-watch/own-writes.ts. Consulted at both notify sites (an
   * issue's own agent, and each watcher of a related ticket), with the
   * notified agent passed as `watcher`. Default: suppress nothing, so
   * existing tests and other callers keep working.
   */
  suppress?: (key: string, updated: string, watcher: string) => boolean;
  /**
   * Recent comments on a ticket, newest first — used to check for a foreign
   * comment invisible to the status/summary/updated fields alone: on the
   * label-only daemon-namespaced diff branch (a cross-daemon label echo, see
   * isDaemonLabelOnlyDiff), on a DAEMON_WRITER ledger hit that also changed a
   * daemon label (see daemonLabelsChanged, KAN-828), and to seed a key's
   * comment-cursor baseline on its first sighting each poll. Optional;
   * omitted, none of those ever suppress (never guess without the ability to
   * look) and seeding never records a baseline.
   */
  comments?: (key: string) => Promise<readonly JiraComment[]>;
  /** Free-text daemon log line, e.g. the storm guard's suppression WARNING. Optional; omitted, that line is simply never emitted. */
  log?: (line: string) => void;
  intervalMs: number;
  onError?: (error: unknown) => void;
  /**
   * Called once a poll cycle (search + reconcile + related + label sync) has
   * completed successfully — the positive heartbeat `/health` liveness is
   * built on (see src/daemon/health.ts). Deliberately NOT the same signal as
   * `onError`: `onError` only fires when the fetch stage rejects, which
   * misses a loop that dies silently (BUTCHR-18/BUTCHR-6) — liveness must
   * come from the absence of a success, not the presence of an error.
   */
  onPollSuccess?: () => void;
  /**
   * BUTCHR-24: run the parked-ticket detector (src/agents/parked.ts) over
   * this poll's already-fetched (issues, related) snapshot. Called from
   * inside the observe function below, NOT from `watch()`'s `onChange`
   * callback, because this is fetch-stage work operating on the snapshot
   * `observe()` just produced — it belongs alongside `syncLabels` above, not
   * downstream in the diff/notify stage.
   *
   * BUTCHR-57 UPDATE: the reason this placement used to be load-bearing no
   * longer applies IN THIS LOOP. `@brooswit/sundry`'s `watch()` by DEFAULT
   * only invokes `onChange` when the polled snapshot's hash differs from the
   * previous one — documented in the published package's
   * `dist/watch/watcher.d.ts` ("call `onChange(next, prev)` whenever the
   * hash of its return value changes") and confirmed against the compiled
   * implementation in `dist/index.js`, whose internal `observe()` returns
   * early via `if (h !== prevHash)` before ever calling `onChange`. THIS loop
   * no longer relies on that default: the `hash` option passed to `watch()`
   * below (see `notifyTick`) forces `observe()`'s `h !== prevHash` branch to
   * always be taken, so `onChange` now runs on every poll tick regardless of
   * whether anything changed. A detector wired into `onChange` here would no
   * longer silently stop firing on a quiet poll. That does not make
   * `checkParked` a candidate to move, though: it still belongs in the fetch
   * stage on its own merits (it consumes the same freshly-fetched snapshot
   * as `syncLabels`, before any diffing happens), so it stays here. Optional;
   * omitted, parked-ticket detection simply never runs. The detector itself
   * never throws (see parked.ts), but this call is awaited inside the same
   * try-implicit observe function as `syncLabels` above, so a change to that
   * guarantee can never silently take the success heartbeat below down with
   * it.
   */
  checkParked?: (issues: readonly JiraIssue[], related: readonly RelatedIssue[]) => Promise<void>;
  /**
   * BUTCHR-57: called once per poll when the NOTIFY stage (the `onChange`
   * callback below — changed-key diffing, suppression checks, `deps.notify`
   * sends) concludes without throwing, including the zero-nudges case where
   * nothing needed sending. This is the positive heartbeat the notify
   * component of `/health` is built on — see src/daemon/health.ts and the
   * `hash` override below for why it fires every poll rather than only when
   * `@brooswit/sundry`'s `watch()` would naturally invoke `onChange`.
   * Deliberately NOT derived from `onError`: `watch()` never awaits
   * `onChange`'s returned promise (confirmed against
   * `node_modules/@brooswit/sundry/dist/index.js`'s `observe()`, which calls
   * `onChange(next, prev)` synchronously and never touches the promise it
   * returns), so a rejecting notify stage would otherwise be an unhandled
   * rejection invisible to both `onError` and any heartbeat built on it.
   * Optional; omitted, the notify component simply never records success.
   */
  onNotifySuccess?: () => void;
}

/** How many polls a just-respawned issue is shielded from a further respawn. */
const RESPAWN_SUPPRESS_POLLS = 5;

/**
 * Per-issue respawn cooldown, threaded explicitly through `ReconcileOptions`
 * (no module-level mutable state) — `startLoop` creates ONE instance that
 * persists across polls, while a direct `reconcileNow` call (existing tests
 * included) defaults to a fresh instance every time, i.e. never suppressed.
 *
 * Rule implemented: a respawn for `issue` at poll P starts a window running
 * through poll `P + RESPAWN_SUPPRESS_POLLS - 1`; `issue` found stale again at
 * any poll inside that window is suppressed (no stop, no spawn, no
 * `onRespawn`) rather than respawned again. This guarantees in particular
 * that two consecutive polls never both respawn the same issue — that's just
 * the P+1 case of the same window. A poll at `P + RESPAWN_SUPPRESS_POLLS` or
 * later is outside the window: a normal respawn, opening its own new window.
 */
export class RespawnGuard {
  private poll = 0;
  private lastRespawnAt = new Map<string, number>();

  /** Advance to the next poll and return its number — call ONCE per reconcileNow(). */
  nextPoll(): number {
    return ++this.poll;
  }

  /** Whether `issue`, found stale at `poll`, should actually be respawned now. Records the respawn (opening a fresh window) when true. */
  admit(issue: string, poll: number): boolean {
    const last = this.lastRespawnAt.get(issue);
    if (last !== undefined && poll - last < RESPAWN_SUPPRESS_POLLS) return false;
    this.lastRespawnAt.set(issue, poll);
    return true;
  }

  /** The poll at/after which `issue` is next eligible for a respawn — for the suppression WARNING's "until …". */
  eligibleAgainAt(issue: string): number {
    return (this.lastRespawnAt.get(issue) ?? 0) + RESPAWN_SUPPRESS_POLLS;
  }
}

export interface ReconcileOptions {
  onRespawn?: (issue: string, reason: string, observedArgv: string[]) => void | Promise<void>;
  /** Storm-guard state; see RespawnGuard. Defaults to a fresh (never-suppressing) instance. */
  guard?: RespawnGuard;
  /** Called, with the exact line to log, when the storm guard suppresses a would-be respawn. */
  onSuppressed?: (issue: string, message: string) => void;
  /**
   * BUTCHR-66/83: resource ids currently `"asleep"` — see `planReconcile`'s
   * `atRest` param, which this is threaded straight through to. Defaults to
   * empty, so a caller with no asleep-capable resource type (every existing
   * one) is unaffected.
   */
  atRest?: Iterable<string>;
}

/**
 * Bring the herd in line with the desired active set: spawn the missing, stop
 * the rest, and replace any stale agent (running, but its process argv lacks
 * butchr's spawn flags) with a fresh one — treated as stop-then-spawn, so
 * buildWorkspace rewrites its CLAUDE.md/brief.md/mcp.json exactly as a normal
 * spawn would. A repeat respawn of the same issue within RESPAWN_SUPPRESS_POLLS
 * polls is suppressed by `opts.guard` instead — see RespawnGuard.
 *
 * Generic over resource id already (an opaque string key + SpawnSpec) —
 * nothing here is issue-shaped, so this needed no change for BUTCHR-69.
 */
export async function reconcileNow(herd: Herd, desired: ReadonlyMap<string, SpawnSpec>, opts: ReconcileOptions = {}): Promise<void> {
  const guard = opts.guard ?? new RespawnGuard();
  const poll = guard.nextPoll();
  const stale = await herd.staleIssues();
  const staleByIssue = new Map(stale.map((s) => [s.issue, s]));
  const plan = planReconcile(desired.keys(), await herd.runningIssues(), staleByIssue.keys(), opts.atRest ?? []);
  // Concurrent, not serial (PR #68 review): HerdrHerd.spawn() now waits out
  // KICKOFF_VERIFY_MS (KAN-804/807) before returning, so a serial loop over a
  // burst of N new spawns (e.g. several stories activating in one poll)
  // would stall this ENTIRE poll — label sync and every ticket's
  // notifications included — for N times that wait. Each issue's spawn is
  // independent (its own workspace directory, its own pane), so nothing
  // requires them to run one after another.
  await Promise.all(plan.spawn.map((issue) => herd.spawn(desired.get(issue)!)));
  for (const issue of plan.stop) await herd.stop(issue);
  for (const issue of plan.respawn) {
    const info = staleByIssue.get(issue)!;
    if (!guard.admit(issue, poll)) {
      const until = guard.eligibleAgainAt(issue);
      opts.onSuppressed?.(
        issue,
        `WARNING: [reconcile] ${issue} respawned again within ${RESPAWN_SUPPRESS_POLLS} polls — suppressing further respawns until poll ${until}`,
      );
      continue;
    }
    await herd.stop(issue);
    await herd.spawn(desired.get(issue)!);
    if (opts.onRespawn) await opts.onRespawn(issue, info.reason, info.observedArgv);
  }
}

/**
 * The desired active set as spawn specs, keyed by resource id — generic over
 * `ResourceType<T>.activation`/`.spawnConfig`/`.discovery.idOf` (BUTCHR-69).
 * The issue tier's own call site (`runResourceLoop` below, via `startLoop`'s
 * compatibility shim) is `desiredFrom(issues, someIssueResourceType)`; a
 * second resource type calls this with its own instance, unchanged.
 *
 * BUTCHR-66/83: only a `"active"` verdict is desired. An `"asleep"` resource
 * is deliberately excluded here, same as `"inactive"` — this is what makes
 * `spawn = desired − running` and `respawn = stale ∩ desired ∩ running`
 * automatically correct for sleep (see `planReconcile`'s doc comment for the
 * one case that is NOT automatic: `stop`, which needs `atRestFrom` below).
 */
export const desiredFrom = <T>(items: readonly T[], resourceType: Pick<ResourceType<T>, "activation" | "spawnConfig" | "discovery">): Map<string, SpawnSpec> => {
  const out = new Map<string, SpawnSpec>();
  for (const item of items) {
    if (resourceType.activation.verdictFor(item) !== "active") continue;
    out.set(resourceType.discovery.idOf(item), resourceType.spawnConfig.specFor(item));
  }
  return out;
};

/**
 * The at-rest set (BUTCHR-66/83): resource ids whose verdict is `"asleep"` —
 * fed to `planReconcile`'s `atRest` param (via `reconcileNow`'s `opts.atRest`)
 * so `stop = running − desired` does not also catch a currently-running
 * asleep resource (the mid-exit race — see `ReconcileOptions.atRest`'s doc
 * comment). Sibling to `desiredFrom`, over the same `(items, resourceType)`
 * shape, so a resource type that never sleeps (e.g. the issue tier) simply
 * always produces an empty set here.
 */
export const atRestFrom = <T>(items: readonly T[], resourceType: Pick<ResourceType<T>, "activation" | "discovery">): Set<string> => {
  const out = new Set<string>();
  for (const item of items) {
    if (resourceType.activation.verdictFor(item) === "asleep") out.add(resourceType.discovery.idOf(item));
  }
  return out;
};

interface Snapshot<T> {
  issues: T[];
  related: RelatedResource<T>[];
}

/**
 * BUTCHR-91/BUTCHR-68: the mutual-eviction hazard, closed by construction.
 * `HerdrHerd` (src/agents/herd.ts) maps EVERY `butchr-*` agent into one flat
 * namespace, with no resource-type scoping at all — `herd.runningIssues()`
 * for the issue tier and for a second resource type sharing the same `Herd`
 * returns the IDENTICAL list. `reconcileNow`'s `stop = running - desired -
 * atRest` (`src/reconcile/plan.ts`) then reads a running agent of the OTHER
 * type as "running but not desired" and stops it — proven live, in both
 * directions, before this fix existed (see BUTCHR-91's ticket history).
 *
 * FIX: wrap the herd handed to `reconcileNow` so `runningIssues()`/
 * `staleIssues()` are scoped to ids `ownsId` recognizes as belonging to
 * THIS loop's own resource type, before `planReconcile` ever sees them — a
 * foreign agent is simply invisible to this loop's reconcile step, so it
 * can never appear in `stop` or `respawn`. Deliberately NOT applied to
 * `spawn`/`stop`/`nudge`/`paneFor` themselves: those are always called with
 * a SPECIFIC id this loop's own discovery/desired set already produced,
 * never an enumeration over the shared namespace, so they were never the
 * vector for this hazard.
 */
export function scopedHerd(herd: Herd, ownsId: (id: string) => boolean): Herd {
  // BUTCHR-91 review fix: NOT `{ ...herd, runningIssues: ..., staleIssues: ... }`.
  // In production `herd` is a `HerdrHerd` CLASS INSTANCE — its methods
  // (spawn/stop/nudge/paneFor) live on the prototype, which object spread
  // does not copy (spread copies only the instance's own enumerable
  // properties, e.g. `herdr`/`mcpUrl`/`wait` — measured: `{...new
  // HerdrHerd(...)}.spawn` is `undefined`). Every `Herd` in this codebase's
  // tests is a plain object literal, where methods ARE own enumerable
  // properties, so the spread "works" there and ONLY there — the test
  // suite and the type checker (which models the declared `Herd` interface,
  // not runtime enumerability) both certified a path that throws
  // `herd.spawn is not a function` on the first real poll that needs to
  // spawn or stop anything, for BOTH loops, swallowed by `onError` into a
  // `loop error:` line — the daemon looks healthy while silently staffing
  // nothing. Explicit delegation avoids this entirely, and is strictly
  // safer besides: an object literal typed `Herd` fails to COMPILE if
  // `Herd` ever gains a member, where the spread would have silently kept
  // dropping it.
  return {
    runningIssues: async () => (await herd.runningIssues()).filter(ownsId),
    staleIssues: async () => (await herd.staleIssues()).filter((s) => ownsId(s.issue)),
    spawn: (spec) => herd.spawn(spec),
    stop: (issue) => herd.stop(issue),
    paneFor: (issue) => herd.paneFor(issue),
    nudge: (issue, text) => herd.nudge(issue, text),
  };
}

/** What `runResourceLoop` needs beyond the resource type itself — every field here is already fully generic (no `T`-shaped logic anywhere). */
export interface GenericLoopDeps<T> {
  herd: Herd;
  /**
   * BUTCHR-91/BUTCHR-68: which opaque ids (as `herd.runningIssues()`/
   * `staleIssues()` report them) belong to THIS resource type, among a herd
   * namespace shared by every resource type running against the same
   * `Herd` instance — see `scopedHerd` above for the hazard this closes.
   * REQUIRED, deliberately not defaulted to "everything": a resource type
   * that forgets to scope itself is exactly the failure this ticket exists
   * to prevent, so the type system forces every caller — this one included
   * — to make the decision explicitly rather than inherit a permissive
   * default. A THIRD resource type must supply a predicate provably
   * disjoint from every other type's (see `src/resources/id.ts`'s
   * `isIssueKey`/`isProjectId` — mutually exclusive by construction, via
   * disjoint regexes, not a runtime `&&` patched on afterward) — reusing an
   * existing predicate, or an equally-disjoint id shape of its own, not
   * "whatever's left over".
   */
  ownsId: (id: string) => boolean;
  notify: (issue: string, about: string, reason?: NotifyReason) => void | Promise<void>;
  onRespawn?: (issue: string, reason: string, observedArgv: string[]) => void | Promise<void>;
  syncLabels?: (issues: readonly T[]) => Promise<ReadonlySet<string>>;
  checkParked?: (issues: readonly T[], related: readonly RelatedResource<T>[]) => Promise<void>;
  log?: (line: string) => void;
  intervalMs: number;
  onError?: (error: unknown) => void;
  onPollSuccess?: () => void;
  /**
   * BUTCHR-57: called once per poll when the NOTIFY stage concludes without
   * throwing, including the zero-nudges case — the positive heartbeat the
   * notify component of `/health` is built on (see `onNotifySuccess` on
   * `LoopDeps` above for the full reasoning; `startLoop` threads that field
   * straight through to this one). Optional; omitted, the notify component
   * simply never records success.
   */
  onNotifySuccess?: () => void;
}

/**
 * The daemon's core loop, generic over an opaque resource type `T`
 * (BUTCHR-64/BUTCHR-69 — "the loop and reconciler are generic over resource
 * id, not over issue keys"). Every poll: discover this poll's resources,
 * reconcile the herd (idempotent — this is the periodic controller, correct
 * after a restart), and discover the related set. On any change between
 * polls — as the resource type ITSELF decides "changed" means, per the
 * epic's opaque-snapshot ruling on BUTCHR-69 (`resourceType.eventRules.poll`
 * is handed the plain (prev, next) snapshots and answers both "what changed"
 * and "is it worth pushing", including any suppression) — nudge each
 * affected agent.
 *
 * What stays HERE, and only here, is the type-agnostic mechanism: per-poll
 * memoization of `eventRules.poll` itself, the `sent` dedupe, delivery, and
 * fail-open discipline around `syncLabels`/`checkParked`. Adding a second
 * resource type means writing its own `ResourceType<T>` and calling this
 * function with it — nothing below changes.
 *
 * `startLoop` (below) is this same function, applied to `ResourceType<JiraIssue>`
 * built from `LoopDeps`' own fields — the issue tier's own call site, kept
 * under its historical name/shape for every existing caller and test.
 */
export function runResourceLoop<T>(resourceType: ResourceType<T>, deps: GenericLoopDeps<T>): Stop {
  // Persists across polls: the respawn storm guard (see RespawnGuard). One
  // instance for the whole loop's lifetime — NOT module-level state — so it
  // survives across polls without leaking between independent
  // runResourceLoop calls (e.g. separate tests).
  const respawnGuard = new RespawnGuard();
  // BUTCHR-57: a monotonic counter used as `watch()`'s `hash` option below,
  // forcing `onChange` (the notify stage) to run on EVERY poll rather than
  // only when the fetched Snapshot's content-hash differs from last time.
  // Without this, a quiet fleet (nothing changed in Jira for hours) would
  // never invoke `onChange` at all, and the notify component of `/health`
  // (see `onNotifySuccess` on `LoopDeps`) would have no way to distinguish
  // "healthy and idle" from "stuck" — this is why `checkParked`'s own doc
  // comment above now flags that `onChange` is no longer change-gated in
  // THIS loop. `checkParked` itself is unaffected and stays in the fetch
  // stage regardless (see that comment) — the notify stage's own job
  // (diffing `prev`/`next` and sending nudges) is what genuinely belongs in
  // `onChange`, so the fix here is to make `onChange` unconditional rather
  // than move work out of it. `prev`/`next` stay correct either way:
  // `watch()`'s own baseline tracking (`prevValue`) is untouched by this —
  // only the change-detection hash is forced to always differ, so
  // `observe()`'s `h !== prevHash` branch is always taken (confirmed against
  // `@brooswit/sundry`'s compiled `observe()`) and it still passes the REAL
  // previous/current snapshots.
  let notifyTick = 0;

  return watch<Snapshot<T>>(
    async () => {
      const issues = await resourceType.discovery.search();
      const desired = desiredFrom(issues, resourceType);
      // Two separate passes over `issues`, each re-calling `verdictFor` per
      // item — deliberately not refactored into one pass. They can never
      // disagree about a given item (never both include, or both exclude,
      // its id) BECAUSE `verdictFor` is synchronous and pure over `T`: two
      // calls with the same resource object, in the same tick, always
      // return the same verdict. An async or side-effecting `verdictFor`
      // would not have that guarantee — this is the concrete cost of ever
      // relaxing that constraint.
      const atRest = atRestFrom(issues, resourceType);
      await reconcileNow(scopedHerd(deps.herd, deps.ownsId), desired, {
        ...(deps.onRespawn ? { onRespawn: deps.onRespawn } : {}),
        guard: respawnGuard,
        ...(deps.log ? { onSuppressed: (_issue: string, message: string) => deps.log!(message) } : {}),
        atRest,
      });
      const related = resourceType.discovery.related ? await resourceType.discovery.related([...desired.keys()]) : [];
      if (deps.syncLabels) await deps.syncLabels(issues);
      // A detector failure must never take down the poll — caught HERE too
      // (belt and suspenders on top of parked.ts's own internal try/catch):
      // a rejection reaching this point would otherwise fail the whole `fn`
      // this poll, skipping `onPollSuccess` below and reporting the poll
      // loop unhealthy over what is, at worst, one failed Jira comment call.
      if (deps.checkParked) {
        try {
          await deps.checkParked(issues, related);
        } catch (e) {
          deps.log?.(`WARNING: [parked] checkParked threw: ${(e as Error)?.message ?? e}`);
        }
      }
      deps.onPollSuccess?.();
      return { issues, related };
    },
    async (next, prev) => {
      // BUTCHR-57: the whole notify stage is wrapped so its returned promise
      // can never reject — `watch()` does not await `onChange` (mechanic A
      // above), so a rejection here would otherwise be a silent unhandled
      // promise rejection, invisible to both `deps.onError` (that seam only
      // ever sees a rejection from the FETCH stage, the first `watch()`
      // argument) and to `/health`. A failure is instead logged loudly on
      // the house `deps.log`/`console.error` seam, in the neighbouring
      // `WARNING: [tag] ... threw: ...` style, and `onNotifySuccess` is
      // simply not called — leaving the notify health component to go stale
      // rather than reporting a false success. Per mechanic C, a failed pass
      // here has already lost this poll's diff forever (`watch()` advances
      // its baseline before calling `onChange`), so there is nothing left to
      // retry — the goal here is only to make that failure loud, not silent.
      try {
        const sent = new Set<string>();
        const send = async (issue: string, about: string, reason?: NotifyReason) => {
          const id = `${issue}|${about}`;
          if (sent.has(id)) return;
          sent.add(id);
          await deps.notify(issue, about, reason);
        };

        const evPoll = await resourceType.eventRules.poll(
          { primary: prev.issues, related: prev.related },
          { primary: next.issues, related: next.related },
        );

        // Primary (assigned) resources: notify the resource's own agent only.
        // Parent/membership is not an event to listen for — a boss hears
        // change only through the related (Implements) chain below.
        for (const key of evPoll.changedPrimary) {
          const verdict = await evPoll.decide(key, key, "primary");
          if (verdict.deliver) await send(key, key, verdict.reason);
        }
        // Related work: notify every watcher of what changed.
        const watchersOf = (k: string) =>
          next.related.find((r) => resourceType.discovery.idOf(r.issue) === k)?.watchers
          ?? prev.related.find((r) => resourceType.discovery.idOf(r.issue) === k)?.watchers
          ?? [];
        for (const key of evPoll.changedRelated) {
          for (const w of watchersOf(key)) {
            const verdict = await evPoll.decide(key, w, "related");
            if (verdict.deliver) await send(w, key, verdict.reason);
          }
        }
        deps.onNotifySuccess?.();
      } catch (e) {
        deps.log?.(`  WARNING: [notify] stage threw: ${(e as Error)?.message ?? e}`);
      }
    },
    deps.intervalMs,
    {
      ...(deps.onError ? { onError: deps.onError } : {}),
      hash: () => String(notifyTick++),
    },
  );
}

/**
 * The issue tier's own entry point — `runResourceLoop` applied to
 * `ResourceType<JiraIssue>`, built entirely from `LoopDeps`' own
 * already-provided functions (`search`/`related` as given — no JQL or
 * Implements-chain fetching of its own; that lives in
 * src/resources/issue.ts's `createIssueResourceType`, which is what
 * src/daemon/index.ts wires up in production). Kept under this name and
 * shape for every existing caller and test (test/unit/loop.test.ts,
 * app.test.ts, herd.test.ts, idle-dialog.test.ts) — this is a pure adapter,
 * not a second implementation: the actual suppression-stack logic lives once,
 * in `createIssueEventRules` (src/resources/issue.ts), and both this
 * function and `createIssueResourceType` call it.
 */
export function startLoop(deps: LoopDeps): Stop {
  const resourceType: ResourceType<JiraIssue> = {
    discovery: {
      idOf: issueIdOf,
      search: deps.search,
      related: deps.related ?? (async () => []),
    },
    activation: ISSUE_ACTIVATION,
    eventRules: createIssueEventRules({
      ...(deps.suppress ? { suppress: deps.suppress } : {}),
      ...(deps.comments ? { comments: deps.comments } : {}),
    }),
    spawnConfig: ISSUE_SPAWN_CONFIG,
  };
  return runResourceLoop(resourceType, {
    herd: deps.herd,
    // BUTCHR-91/BUTCHR-68: `startLoop` is never the production dual-loop
    // wiring (src/daemon/index.ts calls `runResourceLoop` directly, with
    // its own real `isIssueKey`/`isProjectId` scoping — see that file) — it
    // is kept solely as a single-resource-type adapter for existing
    // callers/tests (this function's own doc comment). The mutual-eviction
    // hazard `ownsId` exists to close cannot arise here: nothing else ever
    // shares `deps.herd` with a `startLoop`-driven loop. Own everything,
    // matching every pre-`ownsId` caller's behavior exactly — MEASURED:
    // this codebase's existing test suite (loop.test.ts and others) widely
    // uses bare, non-Jira-shaped ids ("A", "B", ...) that `isIssueKey`
    // itself would reject, so hardcoding the real predicate here would
    // silently break `stop`/`respawn` for every one of those fixtures
    // rather than the mutual-eviction bug it exists to fix.
    ownsId: () => true,
    notify: deps.notify,
    ...(deps.onRespawn ? { onRespawn: deps.onRespawn } : {}),
    ...(deps.syncLabels ? { syncLabels: deps.syncLabels } : {}),
    ...(deps.checkParked ? { checkParked: deps.checkParked } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    intervalMs: deps.intervalMs,
    ...(deps.onError ? { onError: deps.onError } : {}),
    ...(deps.onPollSuccess ? { onPollSuccess: deps.onPollSuccess } : {}),
    ...(deps.onNotifySuccess ? { onNotifySuccess: deps.onNotifySuccess } : {}),
  });
}
