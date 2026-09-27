/**
 * FACTORY-134 (task 1/2 of story FACTORY-22): the Catamorbius SSE client —
 * connection lifecycle, resume, liveness watchdog, reconnect backoff, and a
 * reachability probe. NO DAEMON WIRING: nothing in this repo constructs or
 * starts this client outside its own tests — task 2 (FACTORY-137) does that.
 *
 * See docs/catamorbius-push.md for the verified wire contract this client is
 * built against (source: the gateway's own README, commit
 * d147fbe292b721711300a9fac0c50e0e23b7163a of brooswit-factory/catamorbius —
 * re-verify at your own checkout) and for the full reasoning behind every
 * decision only summarized here.
 *
 * NO NEW RUNTIME DEPENDENCY: the gateway's README suggests the `eventsource`
 * package for header support, but this repo has no existing streaming/SSE
 * code and the wire format is narrow (see sse-parser.ts's own header) — a
 * small parser over `fetch` is simpler than adapting a general EventSource
 * polyfill to inject an `Authorization` header, and avoids a dependency
 * whose own reconnect/backoff logic this client would have to fight or
 * duplicate anyway (this ticket's resume/backoff/watchdog semantics are
 * specific to what task 2 needs).
 *
 * STATE MACHINE:
 *   idle          — never started, or stopped.
 *   connecting    — the FIRST connection attempt this `start()` call makes.
 *   live          — a connection is open and the gateway has responded 200
 *                   (events may or may not have arrived yet — SSE has no
 *                   distinct "handshake complete" frame besides the initial
 *                   "retry:" line, and a live-only stream with nothing new
 *                   to send is a normal, not-yet-eventful state).
 *   reconnecting  — a RETRY after having been live at least once this
 *                   `start()` call (the backoff delay is in progress, or a
 *                   reconnect attempt is in flight).
 *   unauthorized  — the gateway returned 401. TERMINAL for this `start()`
 *                   call: no further attempts are scheduled ("never hammer
 *                   the gateway" — a bad token does not get less bad by
 *                   retrying). Recovery is `stop()` then a fresh `start()`.
 *   unavailable   — the gateway returned 503 (its own "not configured for
 *                   this, by ITS OWN admission" signal — no tokens
 *                   configured server-side). Same terminal treatment as
 *                   `unauthorized`, for the same reason.
 *
 * RESYNC REQUIRED (`onResyncRequired`) fires, DISTINCT from every state
 * transition above, exactly twice:
 *   - "cursor-dropped": the gateway returned 400 for our `Last-Event-ID` (a
 *     cursor it now considers invalid — the README documents this as a
 *     genuine possibility, not just a client bug). This client's own
 *     response is defined as: drop the remembered cursor (no
 *     `Last-Event-ID` on the next attempt, so gateway resumes live-only)
 *     and reconnect. `onResyncRequired` additionally tells whatever's
 *     driving this client (task 2) that "resume" alone has not recovered
 *     full continuity, and an authoritative catch-up may be needed.
 *   - "seq-went-backwards": the first event delivered after a reconnect
 *     carries a `seq` LOWER than the cursor we resumed from — the
 *     gateway's own durability doc names this possible (a log reset).
 *     Detected once, against the RESUME cursor only, not on every event —
 *     the gateway's own contract already guarantees `seq` is strictly
 *     increasing WITHIN one connection, so a running per-event check would
 *     be redundant with what the gateway itself already promises.
 *
 * BACKOFF: exponential (`backoffBaseMs * 2^attempt`, capped at
 * `backoffCapMs`) with FULL jitter (`random() * delay`, so the actual wait
 * is uniformly distributed in `[0, delay]` — spreads reconnect storms
 * across a fleet of clients rather than herding them onto the same
 * schedule), then floored at the most recent "retry:" hint the gateway
 * itself sent (never LOWER than what the server asked for, even if that's
 * above this attempt's own computed delay). `attempt` resets to 0 once a
 * connection has been continuously live for `STABLE_PERIOD_MS` (defined
 * below as `backoffCapMs` itself: a connection that outlives the worst-case
 * backoff delay is treated as healthy, a value with no further external
 * tunable per this ticket's own Definition of done #4 tunable list).
 *
 * INJECTED, NEVER GLOBAL: `fetch`, the clock (`now`), timers
 * (`setTimeout`/`clearTimeout`), and randomness (`random`, for jitter) all
 * come from `CatamorbiusClientDeps` — no real timer, no real network call,
 * and no real `Math.random()` in this module's own tests (see
 * client.test.ts's fake deps and its in-process fake SSE server).
 *
 * SECRET HANDLING: the bearer token is passed in at construction and used
 * ONLY as an `Authorization` header value — never logged, never embedded in
 * a URL, never included in any string this module builds for `state`,
 * `onResyncRequired`, or a `probe()` result. `probe()`'s failure `reason`
 * is built from the HTTP status or `Error#message` of the `/healthz`
 * request; the token is never part of the `/healthz` request at all
 * (`GET /healthz` is documented as unauthenticated).
 */
import { createSseParser } from "./sse-parser.js";

export type CatamorbiusClientState = "idle" | "connecting" | "live" | "reconnecting" | "unauthorized" | "unavailable";

export type ResyncReason = "cursor-dropped" | "seq-went-backwards";

export interface DeliveredCatamorbiusEvent {
  seq: number;
  /** The full CloudEvents JSON envelope, parsed. */
  event: unknown;
}

export type ProbeResult = { ok: true; seq: number } | { ok: false; reason: string };

export interface CatamorbiusClientFilters {
  /** Prefix match, same semantics as the gateway's own `type` store filter. */
  type?: string;
  source?: string;
  subject?: string;
}

/** Minimal subset of the DOM `fetch` signature this client needs — real `fetch` satisfies it as-is. */
export type FetchLike = (input: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}>;

export interface CatamorbiusClientDeps {
  fetch: FetchLike;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Returns a float in `[0, 1)` — `Math.random`'s own contract. Injected so a backoff test can assert an exact delay. */
  random: () => number;
}

export interface CatamorbiusClientOptions {
  baseUrl: string;
  /** Bearer token — see this module's header for the secret-handling contract. */
  token: string;
  watchdogMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  probeTimeoutMs: number;
  filters?: CatamorbiusClientFilters;
  deps: CatamorbiusClientDeps;
}

export interface CatamorbiusClient {
  start(): void;
  /** Aborts any in-flight request, cancels the stream reader, and clears every pending timer. Idempotent. */
  stop(): void;
  readonly state: CatamorbiusClientState;
  onStateChange(listener: (state: CatamorbiusClientState) => void): () => void;
  onEvent(listener: (delivered: DeliveredCatamorbiusEvent) => void): () => void;
  onResyncRequired(listener: (reason: ResyncReason) => void): () => void;
  readonly lastSeq: number | null;
  probe(): Promise<ProbeResult>;
}

function buildEventsUrl(baseUrl: string, filters: CatamorbiusClientFilters | undefined): string {
  const url = new URL(`${baseUrl}/events`);
  if (filters?.type) url.searchParams.set("type", filters.type);
  if (filters?.source) url.searchParams.set("source", filters.source);
  if (filters?.subject) url.searchParams.set("subject", filters.subject);
  return url.toString();
}

export function createCatamorbiusClient(opts: CatamorbiusClientOptions): CatamorbiusClient {
  const { baseUrl, token, watchdogMs, backoffBaseMs, backoffCapMs, probeTimeoutMs, filters, deps } = opts;
  const STABLE_PERIOD_MS = backoffCapMs;

  let state: CatamorbiusClientState = "idle";
  let stopped = true;
  let lastSeq: number | null = null;
  let attempt = 0;
  let liveSince: number | null = null;
  let serverRetryHintMs: number | undefined;
  let watchdogHandle: unknown;
  let reconnectHandle: unknown;
  let abortController: AbortController | undefined;
  let everLive = false;
  // Bumped by every start()/stop(): the review-caught bug this closes is stop() aborting an
  // in-flight connectOnce() while start() immediately clears `stopped` again, letting the OLD
  // attempt's own `if (stopped) return` checks pass and spawn a SECOND, independent connect
  // chain. Every async continuation below checks its own captured `myGen` against this instead
  // of the shared `stopped` flag, so a stop()-then-start() during any in-flight step (the fetch
  // itself, a pending read, a scheduled reconnect) always bails out the stale chain.
  let generation = 0;

  const stateListeners = new Set<(state: CatamorbiusClientState) => void>();
  const eventListeners = new Set<(delivered: DeliveredCatamorbiusEvent) => void>();
  const resyncListeners = new Set<(reason: ResyncReason) => void>();

  // Every listener call is isolated: a throwing consumer must never unwind into this module's
  // OWN control flow (the SSE read loop, in particular) — that would abort a perfectly healthy
  // connection and force a reconnect after `lastSeq` has already advanced past the very event
  // the listener failed to handle, silently losing it. Swallowed deliberately, the same way a
  // DOM EventTarget isolates one listener's throw from its other listeners and from the
  // dispatching code — there is no injected error sink in this ticket's own config surface, and
  // adding one is a caller-facing API decision left to task 2, which owns the actual listeners.
  function notify<T>(listeners: Set<(arg: T) => void>, arg: T): void {
    for (const l of listeners) {
      try {
        l(arg);
      } catch {
        // isolated — see this function's own header
      }
    }
  }

  function setState(next: CatamorbiusClientState): void {
    if (state === next) return;
    state = next;
    notify(stateListeners, state);
  }

  function emitResync(reason: ResyncReason): void {
    notify(resyncListeners, reason);
  }

  // Raw mechanics, unconditional — used ONLY by the public `stop()`, which by the time it runs
  // has already bumped `generation` and must clear whatever is currently armed regardless of
  // which (now-stale) generation armed it.
  function clearWatchdogRaw(): void {
    if (watchdogHandle !== undefined) {
      deps.clearTimeout(watchdogHandle);
      watchdogHandle = undefined;
    }
  }
  function armWatchdogRaw(): void {
    clearWatchdogRaw();
    watchdogHandle = deps.setTimeout(() => {
      // No bytes (event OR heartbeat) within the window: presume dead and
      // reconnect. Aborting the in-flight request is what actually frees
      // the stalled connection; connectOnce's own catch handles the abort.
      abortController?.abort();
    }, watchdogMs);
  }

  // Generation-guarded wrappers for everything INSIDE a connect attempt. `watchdogHandle` is one
  // variable shared by the whole client, and a stale attempt's own `catch`/`finally` still runs
  // (and, before this fix, still called the raw clear/arm) even after its generation has moved
  // on — which could cancel the timer a NEWER attempt had just armed, or arm one on the new
  // attempt's behalf using a delay computed for the stale one. Gen-guarding here, not just at
  // each call SITE, means a stale continuation's clear/arm calls are unconditionally inert rather
  // than relying on every call site remembering to check first (a review-caught bug: the
  // generation check existed at the top of `connectOnce` and inside `scheduleReconnect`, but not
  // here, so a stale attempt could still reach clearWatchdog() before its own generation check).
  function clearWatchdog(myGen: number): void {
    if (myGen !== generation) return;
    clearWatchdogRaw();
  }
  function armWatchdog(myGen: number): void {
    if (myGen !== generation) return;
    armWatchdogRaw();
  }

  function clearReconnectTimer(): void {
    if (reconnectHandle !== undefined) {
      deps.clearTimeout(reconnectHandle);
      reconnectHandle = undefined;
    }
  }

  function nextBackoffDelay(): number {
    if (liveSince !== null && deps.now() - liveSince >= STABLE_PERIOD_MS) attempt = 0;
    const exp = Math.min(backoffCapMs, backoffBaseMs * 2 ** attempt);
    attempt += 1;
    const jittered = deps.random() * exp;
    return serverRetryHintMs !== undefined ? Math.max(jittered, serverRetryHintMs) : jittered;
  }

  function scheduleReconnect(myGen: number): void {
    if (myGen !== generation) return;
    const delay = nextBackoffDelay();
    setState("reconnecting");
    reconnectHandle = deps.setTimeout(() => {
      reconnectHandle = undefined;
      void connectOnce(myGen);
    }, delay);
  }

  async function connectOnce(myGen: number): Promise<void> {
    if (myGen !== generation) return;
    setState(everLive ? "reconnecting" : "connecting");
    const controller = new AbortController();
    abortController = controller;
    liveSince = null;

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const resumeFrom = lastSeq;
    if (resumeFrom !== null) headers["Last-Event-ID"] = String(resumeFrom);

    // Armed for the connect phase itself, not just once live: a gateway that accepts the TCP
    // connection but never sends response headers (or hangs before a body arrives) is just as
    // "dead" per this ticket's own "no bytes for a window" rule as a silent already-live stream —
    // nothing before this point exempted the connecting/reconnecting phase from that rule.
    armWatchdog(myGen);

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await deps.fetch(buildEventsUrl(baseUrl, filters), { headers, signal: controller.signal });
    } catch {
      clearWatchdog(myGen);
      if (myGen !== generation) return;
      scheduleReconnect(myGen);
      return;
    }
    if (myGen !== generation) {
      clearWatchdog(myGen);
      return;
    }

    if (res.status === 401) {
      clearWatchdog(myGen);
      setState("unauthorized");
      return;
    }
    if (res.status === 503) {
      clearWatchdog(myGen);
      setState("unavailable");
      return;
    }
    if (res.status === 400) {
      clearWatchdog(myGen);
      lastSeq = null; // drop the cursor — next attempt is live-only
      emitResync("cursor-dropped");
      scheduleReconnect(myGen);
      return;
    }
    if (!res.ok || !res.body) {
      clearWatchdog(myGen);
      scheduleReconnect(myGen);
      return;
    }

    everLive = true;
    setState("live");
    liveSince = deps.now();
    armWatchdog(myGen); // fresh window for the live phase, independent of whatever remained from connecting

    let resyncCheckedThisConnection = false;
    const parser = createSseParser({
      onMessage(msg) {
        if (msg.event === undefined) return; // control-only record (e.g. a lone retry field's record never reaches here anyway)
        if (msg.id === undefined) return; // malformed: an event frame with no id is dropped, never delivered
        const seq = Number(msg.id);
        if (!Number.isFinite(seq)) return; // malformed id: dropped, never delivered
        if (!resyncCheckedThisConnection) {
          resyncCheckedThisConnection = true;
          if (resumeFrom !== null && seq < resumeFrom) emitResync("seq-went-backwards");
        }
        lastSeq = seq;
        let parsedEvent: unknown;
        try {
          parsedEvent = JSON.parse(msg.data);
        } catch {
          return; // malformed data JSON: dropped, never delivered
        }
        notify(eventListeners, { seq, event: parsedEvent });
      },
      onRetry(ms) {
        serverRetryHintMs = ms;
      },
      onComment() {
        // Heartbeats (and any other comment) arrive here; the watchdog is
        // already reset per raw chunk in the read loop below, which covers
        // comment bytes too (a comment need not complete a "record" to
        // count as liveness — any bytes at all do, per this ticket).
      },
    });

    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (myGen !== generation) {
          try {
            await reader.cancel();
          } catch {
            // already cancelled/errored — nothing further to do
          }
          return;
        }
        if (done) break;
        armWatchdog(myGen);
        parser.push(value);
      }
      parser.end();
    } catch {
      // Read failed (network error, or our own watchdog-triggered abort) — fall through to reconnect below.
    } finally {
      clearWatchdog(myGen);
    }
    if (myGen !== generation) return;
    scheduleReconnect(myGen);
  }

  return {
    start(): void {
      if (!stopped) return; // already running
      stopped = false;
      generation += 1;
      const myGen = generation;
      attempt = 0;
      everLive = false;
      void connectOnce(myGen);
    },
    stop(): void {
      stopped = true;
      generation += 1; // invalidates any in-flight connectOnce/scheduleReconnect chain, however far along
      clearWatchdogRaw(); // unconditional: generation has already moved past whatever armed this
      clearReconnectTimer();
      abortController?.abort();
      setState("idle");
    },
    get state() {
      return state;
    },
    get lastSeq() {
      return lastSeq;
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onResyncRequired(listener) {
      resyncListeners.add(listener);
      return () => resyncListeners.delete(listener);
    },
    async probe(): Promise<ProbeResult> {
      const controller = new AbortController();
      const timeoutHandle = deps.setTimeout(() => controller.abort(), probeTimeoutMs);
      try {
        const res = await deps.fetch(`${baseUrl}/healthz`, { headers: {}, signal: controller.signal });
        if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
        const body = (await res.json()) as { ok?: unknown; seq?: unknown };
        if (body.ok !== true || typeof body.seq !== "number") return { ok: false, reason: "malformed /healthz response" };
        return { ok: true, seq: body.seq };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      } finally {
        deps.clearTimeout(timeoutHandle);
      }
    },
  };
}
