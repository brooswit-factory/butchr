import { watch, type Stop } from "@brooswit/sundry";
import type { JiraIssue, JiraComment } from "../atlassian/types.js";
import { planReconcile } from "../reconcile/plan.js";
import type { Herd, SpawnSpec } from "../agents/herd.js";
import type { ResourceType, RelatedResource } from "../resources/types.js";
import { createIssueEventRules, ISSUE_ACTIVATION, ISSUE_SPAWN_CONFIG, issueIdOf } from "../resources/issue.js";
import type { ReconcileFailure } from "../agents/reconcile-failure.js";
export type { ReconcileFailure, ReconcileStage } from "../agents/reconcile-failure.js";
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
  /**
   * BUTCHR-95/123: bounds `atRest` in time. Given the ids that are BOTH
   * `atRest` (above) AND currently running (computed here, since this is
   * where both sets already are), decide which of them have been
   * resting-and-running continuously for longer than a stated bound and are
   * therefore no longer protected — see src/agents/frozen-asleep.ts for the
   * speak-first-then-report contract this must honour (it only ever
   * returns an id here after an audible complaint has been posted on that
   * resource's own channel, or found already posted from a prior process's
   * lifetime; never on a bare timeout). Every id this returns is removed
   * from the `atRest` set actually handed to `planReconcile` below, so it
   * falls into `stop` — never `respawn`, since `respawn` intersects
   * `desired`, which an asleep resource is never in by construction (see
   * that module's own doc comment for why this asymmetry is the fix, not
   * half of one). Optional; omitted, `atRest` protects indefinitely — the
   * original, unbounded behaviour every existing caller already has.
   */
  checkFrozenAsleep?: (restingRunning: readonly string[]) => Promise<ReadonlySet<string>>;
  /**
   * BUTCHR-141: audible-only crash-loop detection. Called BEFORE the spawn
   * loop below runs, with this poll's `plan.spawn` and `desired.keys()` —
   * see src/agents/crash-loop.ts for the full mechanism (the candidate set,
   * the pruning trap, the threshold/window reasoning, and the fleet-wide
   * confident-zero guard). Its return value is `void` and is NEVER consulted
   * here: unlike `checkFrozenAsleep` above, this hook must not change
   * `plan.spawn`/`herd.spawn` in any way — it only observes and speaks.
   * Optional; omitted, no crash-loop detection runs (every caller before
   * this ticket, and any caller with nothing to report through).
   */
  checkCrashLoop?: (spawning: readonly string[], desired: readonly string[]) => Promise<void>;
  /**
   * BUTCHR-147: audible-only isolated-failure detection. Called ONCE per
   * poll, AFTER the spawn/stop/respawn stages below have all been attempted
   * (isolated — see this function's own doc comment), with the set of
   * per-resource failures this poll actually produced and `desired.keys()`
   * (for pruning — see src/agents/reconcile-failure.ts). Its return value is
   * `void` and is NEVER consulted: like `checkCrashLoop`, it only observes
   * and speaks, never gates or retries anything itself — every failed
   * resource is retried again next poll exactly as before regardless of
   * what this hook does. Optional; omitted, no isolated-failure detection
   * runs (every caller before this ticket, and any caller with nothing to
   * report through).
   */
  checkReconcileFailure?: (failures: readonly ReconcileFailure[], desired: readonly string[], running: readonly string[]) => Promise<void>;
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
 *
 * BUTCHR-147 — FAULT ISOLATION, PER RESOURCE: a rejecting `herd.spawn`,
 * `herd.stop`, or the `herd.stop`/`herd.spawn` pair inside one `respawn`
 * iteration is caught and recorded (never re-thrown) so it can never abort
 * this function or affect any OTHER resource's spawn/stop/respawn this same
 * poll — measured, before this fix, via `Promise.all` rejecting on the
 * first rejecting `herd.spawn` and aborting `stop`/`respawn` for the entire
 * fleet (see this ticket's own probe). Only `herd.staleIssues()` and
 * `herd.runningIssues()` above are DELIBERATELY left unwrapped: a rejection
 * there means the poll has no valid snapshot to reconcile against at all, so
 * it must still fail this function and propagate (see `checkReconcileFailure`'s
 * own doc comment, and this ticket's own report for why this is a genuinely
 * different failure than an isolated herd.spawn/stop/respawn rejection).
 *
 * `/health` DECISION (BUTCHR-147 §6), STATED HERE BECAUSE THIS IS THE SITE
 * THAT CHANGED IT: before this ticket, ANY rejecting herd.spawn/stop/respawn
 * threw out of this function, which propagated out of the poll's fetch stage
 * and skipped `onPollSuccess` — so a single failing resource degraded the
 * poll-loop `/health` component BY ACCIDENT, and misleadingly: the daemon was
 * alive and correctly reconciling every OTHER resource the whole time. This
 * is a DELIBERATE REVERSAL: an isolated per-resource failure no longer
 * throws out of `reconcileNow` at all, so it no longer prevents
 * `onPollSuccess` (src/daemon/loop.ts's `runResourceLoop`) from firing.
 * `/health`'s poll-loop component now reports exactly what it claims to be a
 * liveness signal for — whether the poll loop itself is alive — and no
 * longer doubles as a misdirected per-resource error signal. The per-resource
 * fact instead surfaces on that resource's OWN channel via
 * `checkReconcileFailure` above, which is where an operator can actually act
 * on it (see src/agents/reconcile-failure.ts). A genuinely daemon-level
 * failure (herd.staleIssues()/runningIssues() rejecting, above) still
 * throws, still skips `onPollSuccess`, and still degrades `/health` — that
 * case is untouched by this reversal.
 */
export async function reconcileNow(herd: Herd, desired: ReadonlyMap<string, SpawnSpec>, opts: ReconcileOptions = {}): Promise<void> {
  const guard = opts.guard ?? new RespawnGuard();
  const poll = guard.nextPoll();
  const stale = await herd.staleIssues();
  const staleByIssue = new Map(stale.map((s) => [s.issue, s]));
  const running = await herd.runningIssues();
  // BUTCHR-95/123: bound `atRest` in time, BEFORE it reaches `planReconcile`
  // below — the reconciler, per the epic's ruling that the timing state must
  // live here or in the loop, never inside `Activation.verdictFor` (which
  // stays synchronous and pure). `running` is captured once, above, and
  // reused for both this check and `planReconcile` itself — a resource type
  // with no `checkFrozenAsleep` (every one before this ticket) pays for
  // nothing extra: the branch below is skipped whenever `atRest` (or its
  // intersection with `running`) is empty, and `atRest` defaults to empty.
  let atRest = new Set(opts.atRest ?? []);
  if (opts.checkFrozenAsleep && atRest.size) {
    const runningSet = new Set(running);
    const restingRunning = [...atRest].filter((id) => runningSet.has(id));
    if (restingRunning.length) {
      const frozen = await opts.checkFrozenAsleep(restingRunning);
      if (frozen.size) atRest = new Set([...atRest].filter((id) => !frozen.has(id)));
    }
  }
  const plan = planReconcile(desired.keys(), running, staleByIssue.keys(), atRest);
  // BUTCHR-141: crash-loop detection runs BEFORE the spawn loop below, and
  // never affects `plan` or gates a spawn — see ReconcileOptions.checkCrashLoop's
  // own doc comment and src/agents/crash-loop.ts for why. `[...desired.keys()]`
  // (not `plan.spawn`) is what the detector prunes its own tracking against —
  // the pruning trap that module's top comment names.
  if (opts.checkCrashLoop) await opts.checkCrashLoop(plan.spawn, [...desired.keys()]);
  // Concurrent, not serial (PR #68 review): HerdrHerd.spawn() now waits out
  // KICKOFF_VERIFY_MS (KAN-804/807) before returning, so a serial loop over a
  // burst of N new spawns (e.g. several stories activating in one poll)
  // would stall this ENTIRE poll — label sync and every ticket's
  // notifications included — for N times that wait. Each issue's spawn is
  // independent (its own workspace directory, its own pane), so nothing
  // requires them to run one after another.
  //
  // BUTCHR-147: each mapped async function catches its OWN rejection — the
  // outer `Promise.all` therefore never rejects on a bad spawn, unlike
  // before this ticket. One resource's `workspace.create`/`agent.start`
  // failure is recorded into `failures` and never touches any other
  // resource's spawn this same `Promise.all`.
  const failures: ReconcileFailure[] = [];
  await Promise.all(plan.spawn.map(async (issue) => {
    try {
      await herd.spawn(desired.get(issue)!);
    } catch (e) {
      failures.push({ id: issue, stage: "spawn", error: e });
    }
  }));
  // BUTCHR-147: sequential, same as before (stop has no documented wait to
  // parallelize against) — but each iteration's rejection is now caught so
  // one bad `herd.stop` no longer aborts the REST of this loop (every other
  // resource still gets stopped this poll) or the `respawn` loop below.
  for (const issue of plan.stop) {
    try {
      await herd.stop(issue);
    } catch (e) {
      failures.push({ id: issue, stage: "stop", error: e });
    }
  }
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
    // BUTCHR-147 §7: `guard.admit` above already recorded this respawn
    // BEFORE `stop` runs (RespawnGuard's own contract, untouched by this
    // ticket — see this function's own report for why a failed respawn does
    // NOT need to release the guard slot: a resource left stopped-and-not-
    // respawned below is no longer `running`, so it can never again satisfy
    // `stale ∩ desired ∩ running` — the guard's own condition for firing —
    // until it is freshly spawned and found stale again; it falls into the
    // ORDINARY `spawn` list on the very next poll instead, unaffected by
    // this guard window at all).
    try {
      await herd.stop(issue);
      await herd.spawn(desired.get(issue)!);
    } catch (e) {
      // BUTCHR-147 §7: isolated — every OTHER resource's respawn this poll
      // is unaffected. If `stop` succeeded but `spawn` then threw, `issue`
      // is now stopped and not respawned — left unattended until the next
      // poll's ORDINARY `spawn` list picks it up (see the guard comment
      // above), same one-poll delay this resource would have had anyway
      // under the OLD (whole-poll-aborting) behaviour, since polling is
      // periodic regardless. `opts.onRespawn` is deliberately NOT called
      // here (see immediately below): the herd-level respawn itself failed,
      // so there is nothing to notify about.
      failures.push({ id: issue, stage: "respawn", error: e });
      continue;
    }
    // BUTCHR-147 §7: only reached when BOTH herd.stop and herd.spawn above
    // succeeded — `opts.onRespawn` (the daemon's `[butchr:respawn]` Jira
    // notice, wired in src/daemon/index.ts) must not fire for a respawn
    // whose herd-level half failed. Deliberately left OUTSIDE the try/catch
    // above, unchanged from before this ticket: `onRespawn` is a caller-
    // supplied NOTIFICATION hook, not a herd operation, and this ticket's
    // isolation scope is herd.spawn/stop/respawn specifically (its own
    // title) — production wiring already guarantees this callback never
    // throws (see daemon/index.ts's own `.catch` around its Jira comment).
    if (opts.onRespawn) await opts.onRespawn(issue, info.reason, info.observedArgv);
  }
  // BUTCHR-147: called once per poll, after every isolated spawn/stop/respawn
  // attempt above — never gates or delays anything (see ReconcileOptions.checkReconcileFailure's own doc comment).
  // REVIEW FIX (PR #204 round 1): `running` (captured once, above, same
  // array `planReconcile` itself used) is now passed alongside `desired` —
  // the detector's own pruning needs BOTH to safely track a `plan.stop`
  // failure, which is never in `desired` (see reconcile-failure.ts's
  // `ReconcileFailureDetector.check` doc comment for the full reasoning).
  //
  // NOT double-wrapped in a try/catch here (PR #204 review, non-blocking):
  // deliberately consistent with `checkCrashLoop` immediately above, not
  // with `checkParked`'s belt-and-suspenders wrap in `runResourceLoop`
  // below — a real disagreement between two call sites in this same file,
  // called out explicitly by the reviewer. The choice made here: this
  // detector's OWN "never throws" contract (`check`'s internal try/catch,
  // src/agents/reconcile-failure.ts) is exactly as load-bearing as
  // `checkCrashLoop`'s equivalent guarantee at the call site directly
  // above, which has never been double-wrapped either — a second wrapper
  // HERE would add no guarantee beyond what `check`'s own try/catch already
  // gives, only a duplicate of it. `checkParked`'s extra wrap is not doing
  // the same job: it exists because that hook runs several calls further
  // into the SAME fetch-stage function, so a regression to ITS "never
  // throws" contract would otherwise take `onPollSuccess` down with it in a
  // way harder to trace back to the actual offender. If `check`'s own
  // try/catch here is ever removed or narrowed, this call site becomes
  // exactly that same hazard and should be wrapped too.
  if (opts.checkReconcileFailure) await opts.checkReconcileFailure(failures, [...desired.keys()], running);
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
  /** BUTCHR-95/123: see `ReconcileOptions.checkFrozenAsleep`'s doc comment — threaded straight through to `reconcileNow` below. Optional; omitted, `atRest` protects indefinitely (every resource type before this ticket). */
  checkFrozenAsleep?: (restingRunning: readonly string[]) => Promise<ReadonlySet<string>>;
  /** BUTCHR-141: see `ReconcileOptions.checkCrashLoop`'s doc comment — threaded straight through to `reconcileNow` below. Wired into BOTH the issue and project loops (src/daemon/index.ts), each with its own detector instance — a crash loop has no `atRest`-style single-tier restriction. Optional; omitted, no crash-loop detection runs. */
  checkCrashLoop?: (spawning: readonly string[], desired: readonly string[]) => Promise<void>;
  /** BUTCHR-147: see `ReconcileOptions.checkReconcileFailure`'s doc comment — threaded straight through to `reconcileNow` below. Wired into BOTH the issue and project loops (src/daemon/index.ts), each with its own detector instance, same reasoning as `checkCrashLoop` above. Optional; omitted, no isolated-failure detection runs. */
  checkReconcileFailure?: (failures: readonly ReconcileFailure[], desired: readonly string[], running: readonly string[]) => Promise<void>;
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
        ...(deps.checkFrozenAsleep ? { checkFrozenAsleep: deps.checkFrozenAsleep } : {}),
        ...(deps.checkCrashLoop ? { checkCrashLoop: deps.checkCrashLoop } : {}),
        ...(deps.checkReconcileFailure ? { checkReconcileFailure: deps.checkReconcileFailure } : {}),
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
