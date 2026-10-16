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

  const stateListeners = new Set<(state: CatamorbiusClientState) => void>();
  const eventListeners = new Set<(delivered: DeliveredCatamorbiusEvent) => void>();
  const resyncListeners = new Set<(reason: ResyncReason) => void>();

  function setState(next: CatamorbiusClientState): void {
    if (state === next) return;
    state = next;
    for (const l of stateListeners) l(state);
  }

  function emitResync(reason: ResyncReason): void {
    for (const l of resyncListeners) l(reason);
  }

  function clearWatchdog(): void {
    if (watchdogHandle !== undefined) {
      deps.clearTimeout(watchdogHandle);
      watchdogHandle = undefined;
    }
  }

  function armWatchdog(): void {
    clearWatchdog();
    watchdogHandle = deps.setTimeout(() => {
      // No bytes (event OR heartbeat) within the window: presume dead and
      // reconnect. Aborting the in-flight request is what actually frees
      // the stalled connection; connectOnce's own catch handles the abort.
      abortController?.abort();
    }, watchdogMs);
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

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = nextBackoffDelay();
    setState("reconnecting");
    reconnectHandle = deps.setTimeout(() => {
      reconnectHandle = undefined;
      void connectOnce();
    }, delay);
  }

  async function connectOnce(): Promise<void> {
    if (stopped) return;
    setState(everLive ? "reconnecting" : "connecting");
    const controller = new AbortController();
    abortController = controller;
    liveSince = null;

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const resumeFrom = lastSeq;
    if (resumeFrom !== null) headers["Last-Event-ID"] = String(resumeFrom);

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await deps.fetch(buildEventsUrl(baseUrl, filters), { headers, signal: controller.signal });
    } catch {
      if (stopped) return;
      scheduleReconnect();
      return;
    }
    if (stopped) return;

    if (res.status === 401) {
      setState("unauthorized");
      return;
    }
    if (res.status === 503) {
      setState("unavailable");
      return;
    }
    if (res.status === 400) {
      lastSeq = null; // drop the cursor — next attempt is live-only
      emitResync("cursor-dropped");
      scheduleReconnect();
      return;
    }
    if (!res.ok || !res.body) {
      scheduleReconnect();
      return;
    }

    everLive = true;
    setState("live");
    liveSince = deps.now();
    armWatchdog();

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
        for (const l of eventListeners) l({ seq, event: parsedEvent });
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
        if (stopped) {
          try {
            await reader.cancel();
          } catch {
            // already cancelled/errored — nothing further to do
          }
          return;
        }
        if (done) break;
        armWatchdog();
        parser.push(value);
      }
      parser.end();
    } catch {
      // Read failed (network error, or our own watchdog-triggered abort) — fall through to reconnect below.
    } finally {
      clearWatchdog();
    }
    if (stopped) return;
    scheduleReconnect();
  }

  return {
    start(): void {
      if (!stopped) return; // already running
      stopped = false;
      attempt = 0;
      everLive = false;
      void connectOnce();
    },
    stop(): void {
      stopped = true;
      clearWatchdog();
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
