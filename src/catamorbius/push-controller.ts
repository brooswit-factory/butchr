/**
 * FACTORY-137 (task 2/2 of story FACTORY-22): the daemon-level singleton
 * that owns the ONE Catamorbius client connection (D9) and turns its raw
 * events into the coverage/dirty/resync signals `src/jira-watch/
 * linked-eventing.ts` consumes as `LinkedEventingDeps.push`. Agents never
 * see this; no agent-facing MCP is added (ticket's own goal statement).
 *
 * WHY THIS LIVES OUTSIDE linked-eventing.ts: the client connection, and the
 * config that gates it, are daemon-wide facts — but baselines (and
 * therefore dirty/TTL state) are per `createLinkedEventingState()` INSTANCE
 * (D9's own text: "each call site registers as its own consumer... because
 * baselines are per instance"). This controller is the ONE thing every
 * instance shares; each instance keeps its OWN dirty/TTL/resync bookkeeping
 * (see linked-eventing.ts's own `push`-deps handling) and registers itself
 * here purely to receive dirty/resync broadcasts and to answer the daemon's
 * shutdown call.
 *
 * "LIVE AT LEAST ONCE IN THIS PROCESS" (ticket's own pre-start correction,
 * item B2): the client's own `state`/`everLive` reset on every `start()`,
 * so `everLiveInProcess` below is tracked from `onStateChange` and is NEVER
 * reset for the life of this controller instance — deliberately broader
 * than the client's own per-`start()`-call notion.
 */
import { createCatamorbiusClient, type CatamorbiusClient, type CatamorbiusClientDeps, type CatamorbiusClientState, type ResyncReason } from "./client.js";
import type { CatamorbiusCloudEvent } from "./mapping.js";
import { watchKeysForEvent, type WatchKey } from "./mapping.js";
import type { CatamorbiusFullConfig, CatamorbiusProvider } from "./push-config.js";

/** Every counter AC7 asks for that is genuinely connection-/stream-level, not per linked-eventing consumer — see this module's own header for why the split exists. */
export interface CatamorbiusPushStats {
  notificationsReceived: number;
  unmapped: number;
  deduped: number;
  degrades: number;
  resyncs: number;
  /** Review fix (PR #790, round 1): the client's own `notify()` helper (client.ts) swallows ANY throwing listener with no error sink — "a bug in your onEvent handler will be silent" is the ticket's own pre-start correction (item B2's closing note). Without this counter + the log in `client.onEvent` below, a bug here would drop a notification with zero observable trace. */
  handlerErrors: number;
}

/** The read-only, per-tick query surface `LinkedEventingDeps.push` (src/jira-watch/linked-eventing.ts) is typed against — deliberately NOTHING mutable here; dirty/resync delivery is push (via `registerConsumer`), not pull. */
export interface PushCoverageQuery {
  isProviderEnabled(provider: CatamorbiusProvider): boolean;
  /** D2(3)/D5: true iff the client is `live`, or `reconnecting` within the still-active grace window. */
  isCoveringNow(): boolean;
  ttlMsFor(provider: CatamorbiusProvider): number;
  /** D6: how long a consumer's `runDirtyPass()` should wait for more dirty marks before actually running a pass — see linked-eventing.ts's own `runDirtyPass` doc comment for where this is read. */
  debounceMs(): number;
}

/** What a `createLinkedEventingState()` instance implements to receive dirty/resync signals — see that module's own `LinkedEventingState.markDirty`/`requestResync`/`runDirtyPass` doc comments for the consumer side of this contract. */
export interface PushConsumer {
  markDirty(key: WatchKey): void;
  requestResync(): void;
  runDirtyPass(): Promise<void>;
}

export interface CatamorbiusPushControllerDeps {
  clientDeps: CatamorbiusClientDeps;
  log?: (line: string) => void;
  /** Test seam only — real callers never pass this; lets a test observe/short-circuit the client factory without touching the real SSE machinery. */
  createClient?: typeof createCatamorbiusClient;
}

export interface CatamorbiusPushController {
  start(): void;
  stop(): void;
  registerConsumer(consumer: PushConsumer): () => void;
  coverage: PushCoverageQuery;
  stats(): CatamorbiusPushStats;
  /** For tests/health only — never for behaviour decisions (use `coverage.isCoveringNow()`). */
  clientState(): CatamorbiusClientState;
}

/**
 * D6: transport dedupe — a bounded recent-CloudEvent-id set (semantic
 * dedupe, the actual correctness guarantee, is the diff itself; see D1) plus
 * a seq-monotonic guard reset on every resync signal (a cursor drop or a
 * seq-went-backwards genuinely breaks the "increasing" assumption, so the
 * guard must not then reject legitimate lower seqs from a fresh live-only
 * stream).
 */
const RECENT_EVENT_ID_CAPACITY = 2000;

function createRecentIdSet(capacity: number): { has(id: string): boolean; add(id: string): void } {
  const set = new Set<string>();
  const order: string[] = [];
  return {
    has: (id) => set.has(id),
    add(id) {
      if (set.has(id)) return;
      set.add(id);
      order.push(id);
      if (order.length > capacity) {
        const evict = order.shift();
        if (evict !== undefined) set.delete(evict);
      }
    },
  };
}

function isCatamorbiusCloudEvent(event: unknown): event is CatamorbiusCloudEvent & { id?: unknown } {
  return typeof event === "object" && event !== null && typeof (event as Record<string, unknown>).source === "string";
}

export function createCatamorbiusPushController(config: CatamorbiusFullConfig, deps: CatamorbiusPushControllerDeps): CatamorbiusPushController {
  const { catamorbius, push } = config;
  const log = deps.log ?? (() => {});
  const factory = deps.createClient ?? createCatamorbiusClient;
  const client: CatamorbiusClient = factory({
    baseUrl: catamorbius.baseUrl,
    token: catamorbius.token,
    watchdogMs: catamorbius.watchdogMs,
    backoffBaseMs: catamorbius.backoffBaseMs,
    backoffCapMs: catamorbius.backoffCapMs,
    probeTimeoutMs: catamorbius.probeTimeoutMs,
    deps: deps.clientDeps,
  });

  const enabledProviders = new Set<CatamorbiusProvider>(push.providers);
  const consumers = new Set<PushConsumer>();
  const recentIds = createRecentIdSet(RECENT_EVENT_ID_CAPACITY);
  let lastSeqSeen: number | null = null;

  const stats: CatamorbiusPushStats = { notificationsReceived: 0, unmapped: 0, deduped: 0, degrades: 0, resyncs: 0, handlerErrors: 0 };

  let everLiveInProcess = false;
  let graceDeadline: number | null = null; // set on entering "reconnecting"; cleared on "live" or on any terminal/idle state
  let graceTimerHandle: unknown;
  let wasCoveringForLog = false;

  function clearGraceTimer(): void {
    if (graceTimerHandle !== undefined) {
      deps.clientDeps.clearTimeout(graceTimerHandle);
      graceTimerHandle = undefined;
    }
  }

  /**
   * Review fix (PR #790, round 1): D2(3)/D5 both require "has been live at
   * least once in this process" BEFORE a `reconnecting` state can count as
   * covered — "Before the first live connection... targets are uncovered
   * immediately (no grace)" (D5's own text). The client's own state machine
   * does not honor that distinction: `scheduleReconnect` sets `reconnecting`
   * unconditionally, including after the FIRST connection attempt ever
   * fails (gateway unreachable at startup) — see client.ts's own
   * `connectOnce`/`scheduleReconnect`. Without the `everLiveInProcess` gate
   * below, a gateway that has never once answered would still grant grace
   * coverage to every already-seeded (baselined) target, silently
   * suppressing their normal polling fetches even though push has NEVER
   * actually worked this process.
   */
  function isCoveringNow(): boolean {
    if (!everLiveInProcess) return false;
    const state = client.state;
    if (state === "live") return true;
    if (state === "reconnecting") return graceDeadline !== null && deps.clientDeps.now() < graceDeadline;
    return false;
  }

  /** D5: "log ONE WARNING per state transition, never per retry" — the grace EXPIRY is a derived transition the client's own state machine never announces on its own (it stays "reconnecting" the whole time), so it is logged here, once, exactly when the grace timer actually fires — never by polling. */
  function logCoverageTransitionIfChanged(): void {
    const covering = isCoveringNow();
    if (covering === wasCoveringForLog) return;
    wasCoveringForLog = covering;
    if (!covering) {
      stats.degrades += 1;
      log(`  WARNING: [catamorbius] push coverage degraded (client state: ${client.state}); linked-eventing falls back to polling until the connection recovers`);
    }
  }

  function broadcastResync(): void {
    stats.resyncs += 1;
    for (const c of consumers) {
      c.requestResync();
      void c.runDirtyPass().catch((e) => log(`  WARNING: [catamorbius] on-demand pass (resync) threw: ${(e as Error)?.message ?? e}`));
    }
  }

  client.onStateChange((state) => {
    if (state === "reconnecting") {
      clearGraceTimer();
      graceDeadline = deps.clientDeps.now() + push.graceMs;
      graceTimerHandle = deps.clientDeps.setTimeout(() => {
        graceTimerHandle = undefined;
        logCoverageTransitionIfChanged();
      }, push.graceMs);
      return;
    }
    if (state === "live") {
      clearGraceTimer();
      graceDeadline = null;
      const isReconnectionRecovery = everLiveInProcess;
      everLiveInProcess = true;
      logCoverageTransitionIfChanged();
      // D5: "When the client is live again... mark every covered target
      // resync-pending" — deliberately NOT fired on the very first live
      // connection this process ever makes: there is nothing to reconcile
      // against yet, every baseline is about to be seeded fresh regardless.
      if (isReconnectionRecovery) broadcastResync();
      return;
    }
    // unauthorized / unavailable / idle: D5's "no grace" states.
    clearGraceTimer();
    graceDeadline = null;
    logCoverageTransitionIfChanged();
  });

  client.onResyncRequired((_reason: ResyncReason) => {
    lastSeqSeen = null; // see this module's own header on the dedupe guard
    broadcastResync();
  });

  // Review fix (PR #790, round 1): the client's own `notify()` helper
  // (client.ts) isolates each listener with a bare `try { l(arg) } catch {}`
  // — ANY throw in here (a bug in `watchKeysForEvent`, in the dedupe/mapping
  // logic below) is swallowed with ZERO trace, silently dropping the
  // notification it was handling. The pre-start correction's own closing
  // note calls this out explicitly: "Log inside your own handler and count
  // it in stats()." This outer try/catch, and `handlerErrors` above, are
  // that log/count — never rethrown (rethrowing here would just hand the
  // exception back to the client's swallow-and-ignore `notify`, gaining
  // nothing). Each consumer's own `markDirty` call is ADDITIONALLY isolated
  // individually below, so one bad consumer doesn't cost every OTHER
  // registered consumer this same event too.
  client.onEvent(({ seq, event }) => {
    try {
      stats.notificationsReceived += 1;
      if (lastSeqSeen !== null && seq <= lastSeqSeen) {
        stats.deduped += 1;
        return;
      }
      lastSeqSeen = seq;
      if (!isCatamorbiusCloudEvent(event)) {
        stats.unmapped += 1;
        return;
      }
      const id = typeof event.id === "string" ? event.id : undefined;
      if (id !== undefined) {
        if (recentIds.has(id)) {
          stats.deduped += 1;
          return;
        }
        recentIds.add(id);
      }
      const keys = watchKeysForEvent(event);
      if (keys.length === 0) {
        stats.unmapped += 1;
        return;
      }
      // Each consumer's own `markDirty` is isolated individually (not just
      // by the outer try/catch) — same reasoning as the client's own
      // per-listener isolation (client.ts's `notify` helper): one
      // misbehaving consumer must not cost every OTHER registered consumer
      // this same event too.
      for (const key of keys) {
        for (const c of consumers) {
          try {
            c.markDirty(key);
          } catch (e) {
            stats.handlerErrors += 1;
            log(`  WARNING: [catamorbius] a consumer's markDirty threw, that consumer's notification lost: ${(e as Error)?.message ?? e}`);
          }
        }
      }
      // D3/D6: debounce lives per-consumer (each `LinkedEventingState`'s own
      // `runDirtyPass` schedules itself) — see linked-eventing.ts's own
      // `markDirty` doc comment for why this controller does not also
      // maintain a second, redundant debounce timer here.
      for (const c of consumers) void c.runDirtyPass().catch((e) => log(`  WARNING: [catamorbius] on-demand pass threw: ${(e as Error)?.message ?? e}`));
    } catch (e) {
      stats.handlerErrors += 1;
      log(`  WARNING: [catamorbius] onEvent handler threw, notification lost: ${(e as Error)?.message ?? e}`);
    }
  });

  return {
    start(): void {
      client.start();
    },
    stop(): void {
      clearGraceTimer();
      client.stop();
    },
    registerConsumer(consumer: PushConsumer): () => void {
      consumers.add(consumer);
      return () => consumers.delete(consumer);
    },
    coverage: {
      isProviderEnabled: (provider) => enabledProviders.has(provider),
      isCoveringNow,
      ttlMsFor: (provider) => push.ttlMsByProvider[provider] ?? push.ttlMs,
      debounceMs: () => push.debounceMs,
    },
    stats: () => ({ ...stats }),
    clientState: () => client.state,
  };
}
