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
 * they can never run concurrently against the same pane set. A `fire()`
 * that arrives while a tick is already running does NOT drop the request:
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

  const tickDeps: PermissionAnswerLoopDeps = {
    ...deps,
    loggedSkips: deps.loggedSkips ?? new Set<string>(),
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
    void runPermissionAnswerTick(tickDeps).finally(() => {
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
        if (frame.data.agent_status === "blocked") fire();
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

  return {
    stop: () => {
      stopped = true;
      generation++;
      clearInterval(timer);
      currentSub?.close();
      currentSub = undefined;
    },
  };
}
