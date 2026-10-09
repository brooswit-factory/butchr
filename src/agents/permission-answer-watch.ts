/**
 * FACTORY-98 (FACTORY-97): the event-driven fast path for the
 * permission-answer loop (`permission-answer-loop.ts`) — reacts to herdr's
 * own `pane.agent_status_changed` push events so a lizard-mode pane's
 * permission prompt is answered within about a second of appearing, instead
 * of waiting up to one whole sweep tick (20s; blocks up to 47s were observed
 * live — see FACTORY-97, the story this ticket implements).
 *
 * Investigated first, per FACTORY-97's own direction ("pick what is real,
 * not what is assumed"): `@brooswit/herdr-sdk`'s `events.subscribe`
 * (`HerdrClient.subscribe`, passed straight through by `DrovrClient.subscribe`
 * — see that method's own doc comment) is a real, long-lived push
 * connection. But `pane.agent_status_changed` is one of exactly three
 * subscription kinds (`generated/params.d.ts`'s `Subscription` union,
 * `SubscriptionEventKind`) that REQUIRE a specific `pane_id` filter — there
 * is no "any pane" wildcard, unlike the lifecycle events (`pane.created`,
 * `workspace.*`, …) elsewhere in that same union. So this module does not
 * replace `runPermissionAnswerTick`'s own periodic `agent.list()` scan — it
 * still needs that scan to learn WHICH panes are lizard-eligible before it
 * can ask herdr to push their status changes. What changes is WHEN an
 * already-known eligible pane gets answered: today, only on the next sweep
 * tick; with this wired in, within about a second of herdr reporting the
 * transition to `blocked`.
 *
 * Deliberately simple rather than fully reactive to fleet topology: the
 * subscribed pane-id set is rebuilt on the SAME cadence as the sweep
 * (`intervalMs`), fed by `PermissionAnswerLoopDeps.onEligiblePaneIds` —
 * called synchronously inside `runPermissionAnswerTick`'s own `agent.list()`
 * call, so noticing a topology change costs nothing extra (no second herdr
 * call). A pane that newly becomes eligible is therefore caught by the
 * ordinary sweep within one tick (≤`intervalMs`, unchanged from today) and
 * gets the fast, event-driven path from its second tick onward — not a
 * regression against today's baseline, which never had a fast path at all.
 *
 * One shared in-flight guard, with coalescing rather than dropping: an
 * event-triggered answer and the periodic sweep both funnel through the
 * exact same `runPermissionAnswerTick` call and the exact same `inFlight`
 * flag `startPermissionAnswerLoop` already uses for the sweep-only case —
 * they can never run concurrently against the same pane set. This
 * invariant also holds across a watchdog-forced restart (FACTORY-776): the
 * watchdog's own recovery bumps a tick-generation counter before clearing
 * `inFlight` and firing a fresh tick, so a wedged tick's eventual, late
 * `.finally()` — which `fire()`'s own closure captured BEFORE the
 * watchdog ever ran — sees it has been superseded and becomes a no-op
 * instead of clearing `inFlight` out from under whatever tick the
 * watchdog already started; see `fire()`'s own comment for the mechanics.
 * A `fire()` that arrives while a tick is already running does NOT drop the request:
 * it sets a `pending` flag, and the in-flight tick's own completion runs
 * exactly one more tick before going idle. This matters for the exact case
 * this ticket exists for — a tool-heavy agent whose OWN next tool call goes
 * `blocked` again while the current tick is still mid-approve/verify on the
 * previous one — dropping that event (the earlier design here) would have
 * left it to the 20s fallback, missing the story's own latency goal
 * whenever more than one prompt is in flight at a time. Coalescing instead
 * of queuing keeps the same bound `startPermissionAnswerLoop`'s "a slow tick
 * just makes the next firing a no-op" already relies on: at most one tick's
 * worth of eligible-pane screen reads is ever in flight at a time, however many
 * events arrive while it runs.
 */
import { runPermissionAnswerTick, type PermissionAnswerLoopDeps } from "./permission-answer-loop.js";

/**
 * A push frame this watcher understands — the shape common to
 * `@brooswit/herdr-sdk`'s `SubscriptionEventFrame` for
 * `pane.agent_status_changed` (`generated/events.d.ts`), restated narrow so
 * a fake iterator in tests never needs the full generated type — same spirit
 * as `permission-answer-loop.ts`'s own `PermissionAnswerClient`.
 */
export interface PermissionAnswerPushFrame {
  event: string;
  data: { pane_id: string; agent_status?: string | null };
}

/**
 * What this watcher needs out of a herdr push subscription — narrow on
 * purpose, matches `@brooswit/herdr-sdk`'s `Subscription` class shape
 * (`AsyncIterable` + `close()`) structurally, without importing it (that
 * class and the unrelated `Subscription` *filter-spec* type the caller
 * builds share a name in `@brooswit/herdr-sdk`'s own export surface — see
 * `startPermissionAnswerWatch`'s daemon-side wiring for how that's avoided).
 */
export interface PermissionAnswerSubscription extends AsyncIterable<PermissionAnswerPushFrame> {
  close(): void;
}

export interface PermissionAnswerWatchDeps extends PermissionAnswerLoopDeps {
  /**
   * Opens ONE push subscription filtered to exactly these pane ids'
   * `pane.agent_status_changed` events. Never called with an empty array —
   * `startPermissionAnswerWatch` simply has nothing open while no pane is
   * eligible. Called again (after `close()`ing the previous one) whenever
   * the eligible pane-id set changes, or after a prior subscription ends on
   * its own (herdr closed it, or it errored — a real socket can drop).
   */
  subscribe: (paneIds: readonly string[]) => Promise<PermissionAnswerSubscription>;
  /**
   * Delay before reopening a subscription that ended on its own. Default
   * 2000ms — comfortably below `intervalMs` in every real caller, so a
   * dropped connection is not usually left to the sweep alone for long, but
   * long enough not to hot-loop against a herdr that is rejecting connects.
   */
  resubscribeDelayMs?: number;
  /**
   * FACTORY-722 fix-scope item (d): a pane whose own `fastPathTriggers`
   * entry (the instant its `blocked` push frame was received) has sat
   * UNCONSUMED this long means no tick has scanned it since — the exact
   * "a never-settling herdr await stalls everything that serializes on it"
   * shape the wedge incident this ticket closes was named for, independent
   * of whatever root cause produced it this time. FACTORY-776 fixed the
   * two paths that used to strand an entry forever despite a perfectly
   * healthy tick loop: `runPermissionAnswerTick` now reaps a pane's entry
   * as soon as it is no longer in the current eligible set (covers both an
   * empty eligible set and a pane that simply left it), and otherwise
   * deletes it on every tick that scans it (answered, skipped, or failed —
   * see `PermissionAnswerLoopDeps.fastPathTriggers`'s own doc comment).
   * This comment used to claim NEITHER of those could ever happen; false,
   * now fixed.
   *
   * One path is DELIBERATELY NOT covered by that in-tick reap, and still
   * relies on THIS watchdog: a rejecting `agent.list()` call (a deadline,
   * not a hang) skips the reap and the consumption loop alike, since both
   * sit after the `await` that rejected — the tick never even learns an
   * eligible set to reap against. So a surviving entry past this threshold
   * means one of two things: a genuinely wedged tick (never reaches its
   * own `agent.list()`-returning scan at all — the hang this watchdog was
   * built for), OR a tick whose `agent.list()` keeps rejecting (settles
   * quickly, but with nothing to reap against). Either way, this watchdog
   * firing and clearing the entry is what bounds it: one trip for the
   * reject case (not unbounded re-tripping, since the trip itself clears
   * the entry this timer fired on), indefinite re-tripping only for a
   * genuinely wedged tick that never recovers on its own. Default 5
   * minutes (the incident's own evidence: FACTORY-722's wedge journal
   * measured panes blocked for tens of minutes before anyone noticed). `0`
   * disables the watchdog entirely (tests that don't want its timer
   * running).
   */
  watchdogThresholdMs?: number;
  /** How often the watchdog above checks. Default 30s — far below `watchdogThresholdMs`, so a trip is noticed promptly once the threshold passes, without re-checking so often it costs anything measurable. */
  watchdogCheckIntervalMs?: number;
  /**
   * Called once per watchdog trip (not once per stuck pane) — lets a caller
   * (the daemon's own ops-alert router) raise a loud, human-facing alert
   * alongside the `[watchdog] restarted permission-answer` journal line
   * `startPermissionAnswerWatch` always logs on a trip regardless. Never
   * awaited and never allowed to affect recovery: the trip's own forced
   * resubscribe/fire happens unconditionally, the same "never affects this
   * tick's own outcome" contract `onApproved`/`onAnswered` already hold
   * (permission-answer-loop.ts). Optional; omitted, nothing extra happens
   * beyond the journal line.
   */
  onWatchdogTripped?: (stuckPaneIds: readonly string[]) => void;
}

export interface PermissionAnswerWatchHandle {
  /** Stops the sweep timer and closes any open subscription. Idempotent. */
  stop(): void;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((id) => set.has(id));
}

/**
 * Wires the sweep (same shape as `startPermissionAnswerLoop`) together with
 * the event-driven fast path described above. `intervalMs`/`deps` otherwise
 * mean exactly what they mean for `startPermissionAnswerLoop` — this is a
 * superset, not a different policy: every pane `startPermissionAnswerLoop`
 * would answer, this answers too, on the same fallback cadence, plus faster
 * when herdr's push events are flowing.
 */
export function startPermissionAnswerWatch(deps: PermissionAnswerWatchDeps, intervalMs: number): PermissionAnswerWatchHandle {
  let inFlight = false;
  // A fire() while inFlight sets this instead of dropping the request; the
  // in-flight tick's own .finally runs exactly one more tick when it sees it
  // set, then clears it. A burst of N such requests during one tick still
  // costs at most one trailing tick, never N — the same "coalesce, don't
  // queue" shape `startPermissionAnswerLoop`'s own in-flight guard already
  // has for the sweep-only case, extended so an event's request to run is
  // remembered instead of discarded.
  let pending = false;
  let stopped = false;
  let currentPaneIds: readonly string[] = [];
  let currentSub: PermissionAnswerSubscription | undefined;
  // Bumped on every resubscribe/stop so a subscription opened for an
  // already-superseded pane-id set (or after stop()) never acts on frames it
  // reads, and never schedules its own reconnect.
  let generation = 0;
  // FACTORY-776 (b): a SEPARATE counter from `generation` above — that one
  // tracks subscription identity (bumped on every resubscribe, which the
  // ordinary eligible-pane-set churn triggers often and which has nothing to
  // do with tick identity); this one tracks which `fire()` call's tick is
  // the current one, bumped only when a NEW tick actually starts (inside
  // `fire()`) or when the watchdog forces a reset. Reusing `generation`
  // would make every ordinary resubscribe also invalidate an in-flight
  // tick's own `.finally()` — wrong, since a resubscribe alone never means
  // the tick itself was superseded.
  let tickGeneration = 0;

  // FACTORY-145: `pane_id -> the monotonic instant its own `blocked` push
  // frame was received`, consumed (deleted) by `runPermissionAnswerTick`
  // itself once it scans that pane — see `PermissionAnswerLoopDeps.fastPathTriggers`'s
  // own doc comment. Own map per watch instance, sharing `deps.now` with the
  // tick so both sides of a latency measurement use the same clock.
  const fastPathTriggers = deps.fastPathTriggers ?? new Map<string, number>();
  const now = deps.now ?? (() => performance.now());

  const tickDeps: PermissionAnswerLoopDeps = {
    ...deps,
    loggedSkips: deps.loggedSkips ?? new Set<string>(),
    fastPathTriggers,
    now,
    onEligiblePaneIds: (paneIds) => {
      deps.onEligiblePaneIds?.(paneIds);
      if (!sameIds(paneIds, currentPaneIds)) resubscribe(paneIds);
    },
  };
  const log = tickDeps.log ?? (() => {});

  const fire = () => {
    if (stopped) return;
    if (inFlight) { pending = true; return; }
    inFlight = true;
    const myTickGeneration = ++tickGeneration;
    void runPermissionAnswerTick(tickDeps).finally(() => {
      // FACTORY-776 (b): if the watchdog force-reset `tickGeneration` while
      // this tick was still in flight, a LATER tick is already running (or
      // about to) under a newer generation — this `.finally()` belongs to a
      // superseded tick and must not touch `inFlight`/`pending` at all,
      // or it would clear the flag out from under that later tick and let
      // a third one start concurrently with it (the exact bug this guard
      // exists to close).
      if (myTickGeneration !== tickGeneration) return;
      inFlight = false;
      if (pending && !stopped) { pending = false; fire(); }
    });
  };

  async function runSubscription(paneIds: readonly string[], gen: number): Promise<void> {
    let sub: PermissionAnswerSubscription;
    try {
      sub = await deps.subscribe(paneIds);
    } catch (e) {
      if (gen !== generation) return;
      log(`[permission-answer] watch subscribe failed: ${(e as Error)?.message ?? e}`);
      scheduleReconnect(paneIds, gen);
      return;
    }
    if (gen !== generation) { sub.close(); return; }
    currentSub = sub;
    try {
      for await (const frame of sub) {
        if (gen !== generation) break;
        if (frame.data.agent_status === "blocked") {
          // FACTORY-145: the trigger instant IS frame receipt, not whatever
          // instant herdr itself observed the transition — see
          // `AnswerLatency`'s own doc comment (permission-answer-loop.ts) for
          // why that's the honest thing to name it. Set only if absent: a
          // pane already carrying an unconsumed trigger (a second `blocked`
          // frame before the tick it caused has even run) keeps its
          // EARLIER instant, so latency is never understated by a later
          // frame overwriting it.
          if (!fastPathTriggers.has(frame.data.pane_id)) fastPathTriggers.set(frame.data.pane_id, now());
          fire();
        }
      }
    } catch (e) {
      if (gen === generation) log(`[permission-answer] watch subscription errored: ${(e as Error)?.message ?? e}`);
    }
    if (gen === generation) scheduleReconnect(paneIds, gen);
  }

  function scheduleReconnect(paneIds: readonly string[], gen: number): void {
    if (stopped || paneIds.length === 0) return;
    const t = setTimeout(() => {
      if (gen !== generation) return;
      void runSubscription(paneIds, gen);
    }, deps.resubscribeDelayMs ?? 2_000);
    t.unref?.();
  }

  function resubscribe(paneIds: readonly string[]): void {
    currentPaneIds = paneIds;
    currentSub?.close();
    currentSub = undefined;
    const gen = ++generation;
    if (paneIds.length > 0) void runSubscription(paneIds, gen);
  }

  // Fire once immediately (rather than waiting for the first interval tick)
  // so both the sweep's own baseline coverage and the subscription's initial
  // pane-id set are live right away, not up to intervalMs late.
  fire();
  const timer = setInterval(fire, intervalMs);
  timer.unref?.();

  // FACTORY-722 fix-scope item (d): independent of `fire`/the sweep timer
  // above — this runs even when a tick is wedged (the exact case it exists
  // to catch), checking `fastPathTriggers` for an entry no tick has
  // consumed in `watchdogThresholdMs`. `0` opts out entirely (no timer at
  // all, not merely a check that never trips) — a caller with no herdr
  // alert channel, or a test that doesn't want a background timer running
  // past its own assertions.
  const watchdogThresholdMs = deps.watchdogThresholdMs ?? 5 * 60_000;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  if (watchdogThresholdMs > 0) {
    watchdogTimer = setInterval(() => {
      if (stopped) return;
      const nowMs = now();
      const stuck = [...fastPathTriggers.entries()].filter(([, at]) => nowMs - at >= watchdogThresholdMs).map(([id]) => id);
      if (stuck.length === 0) return;
      log(`[watchdog] restarted permission-answer — ${stuck.length} pane(s) blocked with a push trigger unconsumed for over ${Math.round(watchdogThresholdMs / 1000)}s: ${stuck.join(", ")}`);
      try { deps.onWatchdogTripped?.(stuck); } catch { /* never allowed to affect recovery below */ }
      // FACTORY-776 (a): clear exactly the entries this trip fired on. A
      // trip means no tick has reached its own scan of that pane in over
      // `watchdogThresholdMs` (see `watchdogThresholdMs`'s own doc comment)
      // — leaving the entry in place would just re-trip every
      // `watchdogCheckIntervalMs` forever even once a fresh tick below gets
      // the loop healthy again, since nothing else ever revisits an entry
      // for a pane outside what that NEW tick's own eligible set happens to
      // be yet.
      for (const id of stuck) fastPathTriggers.delete(id);
      // FACTORY-776 (b): bump `tickGeneration` BEFORE clearing `inFlight` —
      // this makes the wedged tick's own eventual `.finally()` (captured
      // against the OLD generation) a no-op when it finally settles, so it
      // can never clear `inFlight` out from under the fresh tick `fire()`
      // starts below. See `fire()`'s own comment for the full mechanics.
      tickGeneration++;
      // Force recovery rather than merely reporting: a tick that has not
      // consumed a trigger in this long is not merely slow (the client-side
      // deadlines elsewhere in this ticket's fix bound every herdr call this
      // module makes well under a minute) — treat `inFlight` as wedged and
      // clear it so the NEXT `fire()` (below) can actually start a tick
      // instead of coalescing into a `pending` flag a dead tick's `.finally`
      // will never run to consume.
      inFlight = false;
      pending = false;
      resubscribe(currentPaneIds);
      fire();
    }, deps.watchdogCheckIntervalMs ?? 30_000);
    watchdogTimer.unref?.();
  }

  return {
    stop: () => {
      stopped = true;
      generation++;
      clearInterval(timer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      currentSub?.close();
      currentSub = undefined;
    },
  };
}
