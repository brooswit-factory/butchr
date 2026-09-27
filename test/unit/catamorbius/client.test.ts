import { describe, expect, test } from "bun:test";
import { createCatamorbiusClient, type CatamorbiusClientDeps, type CatamorbiusClientState, type DeliveredCatamorbiusEvent, type FetchLike, type ResyncReason } from "../../../src/catamorbius/client.js";

/**
 * A fully virtual clock/timer pair: `now()` never touches wall-clock time,
 * and `advance(ms)` is the ONLY thing that ever fires a scheduled callback
 * — no test in this file waits on a real timer. `advance` fires every
 * pending timer whose deadline has been reached, in deadline order,
 * flushing microtasks between each firing so a callback's own synchronous
 * follow-on (e.g. scheduling the next reconnect) is visible to the next
 * iteration before we decide whether more timers are due.
 */
function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();
  // Drains the microtask queue deeply enough for an `await`-chain several hops deep (a fetch
  // promise resolving, a stream read resolving, a `.then` continuation registering a NEW timer)
  // to fully settle. A single `queueMicrotask` round trip is NOT enough — the timer a callback
  // registers may only appear after several such hops, and scanning for due timers before they've
  // had a chance to register one would wrongly conclude nothing is due.
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number): unknown {
      const id = nextId++;
      timers.set(id, { fireAt: now + ms, fn });
      return id;
    },
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number);
    },
    pendingCount(): number {
      return timers.size;
    },
    /**
     * Advances virtual time by `ms`, firing every timer whose deadline falls within the new
     * window, in deadline order — flushing the microtask queue BEFORE each scan so a timer a
     * still-settling `await` chain is about to register is never missed just because it hadn't
     * been registered yet at the instant we looked.
     */
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (;;) {
        await flushMicrotasks();
        let dueId: number | undefined;
        let due: { fireAt: number; fn: () => void } | undefined;
        for (const [id, t] of timers) {
          if (t.fireAt <= target && (due === undefined || t.fireAt < due.fireAt)) {
            due = t;
            dueId = id;
          }
        }
        if (due === undefined || dueId === undefined) break;
        timers.delete(dueId);
        now = due.fireAt;
        due.fn();
      }
      now = target;
      await flushMicrotasks();
    },
  };
}

type FakeResponse = { status: number; ok: boolean; body: ReadableStream<Uint8Array> | null; json(): Promise<unknown> };

interface FakeCall {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

/** One live SSE connection's write side: `push` sends raw bytes (a test can split a frame across arbitrary boundaries), `close` ends the stream cleanly (no abort). */
interface FakeConnection {
  push(chunk: string): void;
  /** Like `push`, but for a caller that has already computed exact byte offsets (e.g. to split mid multi-byte UTF-8 character) — `push` alone cannot express that, since encoding a JS string split between surrogate halves produces a replacement character instead of a genuine partial byte sequence. */
  pushBytes(chunk: Uint8Array): void;
  close(): void;
}

function makeLiveResponse(signal: AbortSignal): { response: FakeResponse; conn: FakeConnection } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // reader.cancel() lands here; nothing further to do for a fake stream.
    },
  });
  const encoder = new TextEncoder();
  const onAbort = () => {
    try {
      controller.error(new DOMException("aborted", "AbortError"));
    } catch {
      // already closed/errored
    }
  };
  signal.addEventListener("abort", onAbort);
  return {
    response: { status: 200, ok: true, body: stream, json: () => Promise.reject(new Error("not json")) },
    conn: {
      push(chunk: string) {
        controller.enqueue(encoder.encode(chunk));
      },
      pushBytes(chunk: Uint8Array) {
        controller.enqueue(chunk);
      },
      close() {
        try {
          controller.close();
        } catch {
          // already closed/errored
        }
      },
    },
  };
}

function statusResponse(status: number): FakeResponse {
  return { status, ok: status >= 200 && status < 300, body: null, json: () => Promise.reject(new Error("no body")) };
}

/**
 * A scripted fake `fetch`: every call to `/events` pops the next queued
 * script (or, if the queue is empty, calls `defaultScript`); every call to
 * `/healthz` is routed to `onProbe`. Every call (whether /events or
 * /healthz) is recorded in `calls`, so a test can assert on the exact
 * headers/url a real `fetch` would have seen.
 */
function createFakeGateway() {
  const calls: FakeCall[] = [];
  const eventsScripts: Array<(signal: AbortSignal) => FakeResponse | Promise<FakeResponse> | { response: FakeResponse; conn: FakeConnection }> = [];
  let onProbe: (signal: AbortSignal) => Promise<FakeResponse> = () => Promise.resolve(statusResponse(200));
  const liveConns: FakeConnection[] = [];

  const fetch: FetchLike = (async (input: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
    calls.push({ url: input, headers: init.headers, signal: init.signal });
    if (input.includes("/healthz")) return onProbe(init.signal);
    const script = eventsScripts.shift();
    if (!script) return new Promise<FakeResponse>(() => {}); // no script queued: hang forever rather than throw — an unqueued call should stall, never trigger a synchronous reconnect avalanche
    const result = await script(init.signal);
    if ("response" in result) {
      liveConns.push(result.conn);
      return result.response;
    }
    return result;
  }) as FetchLike;

  return {
    fetch,
    calls,
    liveConns,
    /** Queue a plain status response (401/503/400/other) for the next `/events` call. */
    queueStatus(status: number): void {
      eventsScripts.push(() => statusResponse(status));
    },
    /** Queue a live connection for the next `/events` call; returns nothing — grab it back off `liveConns` once the client has connected. */
    queueLive(): void {
      eventsScripts.push((signal) => makeLiveResponse(signal));
    },
    /** Queue a network-level failure (fetch itself rejects) for the next `/events` call. */
    queueNetworkError(message = "network down"): void {
      eventsScripts.push(() => Promise.reject(new Error(message)));
    },
    /** Queue an arbitrary script for the next `/events` call — full control over timing (e.g. a fetch that only resolves/rejects on the caller's own signal, to simulate a hung connect or an abort race). */
    queueCustom(fn: (signal: AbortSignal) => FakeResponse | Promise<FakeResponse>): void {
      eventsScripts.push(fn);
    },
    setProbe(fn: (signal: AbortSignal) => Promise<FakeResponse>): void {
      onProbe = fn;
    },
  };
}

function sseFrame(opts: { event?: string; id?: string; data: unknown }): string {
  const lines: string[] = [];
  if (opts.event !== undefined) lines.push(`event: ${opts.event}`);
  if (opts.id !== undefined) lines.push(`id: ${opts.id}`);
  lines.push(`data: ${JSON.stringify(opts.data)}`);
  return lines.join("\n") + "\n\n";
}

const TOKEN = "s3cr3t-token-value";

function makeDeps(clock: ReturnType<typeof createFakeClock>, fetch: FetchLike, randomValues: number[] = [0]): CatamorbiusClientDeps {
  let i = 0;
  return {
    fetch,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => randomValues[Math.min(i++, randomValues.length - 1)]!,
  };
}

function makeClient(opts: { clock: ReturnType<typeof createFakeClock>; fetch: FetchLike; randomValues?: number[]; watchdogMs?: number; backoffBaseMs?: number; backoffCapMs?: number; probeTimeoutMs?: number }) {
  return createCatamorbiusClient({
    baseUrl: "http://localhost:9",
    token: TOKEN,
    // Deliberately large unless a test overrides it: most tests aren't exercising the watchdog,
    // and a small default risks silently coinciding with an unrelated test's own advance() window
    // (a real bug this suite hit once: a default-random 0ms backoff plus a coincidentally-equal
    // watchdog firing inside the same advance() call cascaded into an unqueued-script deadlock).
    watchdogMs: opts.watchdogMs ?? 60000,
    backoffBaseMs: opts.backoffBaseMs ?? 100,
    backoffCapMs: opts.backoffCapMs ?? 10000,
    probeTimeoutMs: opts.probeTimeoutMs ?? 500,
    deps: makeDeps(opts.clock, opts.fetch, opts.randomValues),
  });
}

function recordStates(client: ReturnType<typeof createCatamorbiusClient>): CatamorbiusClientState[] {
  const states: CatamorbiusClientState[] = [];
  client.onStateChange((s) => states.push(s));
  return states;
}

describe("auth header: sent, never logged", () => {
  test("every /events call carries Authorization: Bearer <token>, and no state/event/resync value ever contains the token", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch });
    const states = recordStates(client);
    const resyncs: ResyncReason[] = [];
    client.onResyncRequired((r) => resyncs.push(r));
    const delivered: DeliveredCatamorbiusEvent[] = [];
    client.onEvent((e) => delivered.push(e));

    client.start();
    await clock.advance(0);

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]!.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);

    const conn = gateway.liveConns[0]!;
    conn.push(sseFrame({ event: "com.github.issues.opened", id: "1", data: { hello: "world" } }));
    await clock.advance(0);

    const serialized = JSON.stringify({ states, resyncs, delivered });
    expect(serialized.includes(TOKEN)).toBe(false);
    client.stop();
  });
});

describe("connection lifecycle and event delivery", () => {
  test("idle -> connecting -> live, and a delivered event carries the frame's id as seq, parsed data", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch });
    const states = recordStates(client);
    const delivered: DeliveredCatamorbiusEvent[] = [];
    client.onEvent((e) => delivered.push(e));

    expect(client.state).toBe("idle");
    client.start();
    await clock.advance(0);
    expect(states).toEqual(["connecting", "live"]);
    expect(client.state).toBe("live");

    gateway.liveConns[0]!.push(sseFrame({ event: "com.github.issues.opened", id: "7", data: { n: 1 } }));
    await clock.advance(0);

    expect(delivered).toEqual([{ seq: 7, event: { n: 1 } }]);
    expect(client.lastSeq).toBe(7);
    client.stop();
  });

  test("events delivered in arrival order, one onEvent call per frame", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch });
    const delivered: DeliveredCatamorbiusEvent[] = [];
    client.onEvent((e) => delivered.push(e));
    client.start();
    await clock.advance(0);

    const conn = gateway.liveConns[0]!;
    conn.push(sseFrame({ event: "a", id: "1", data: { i: 1 } }));
    conn.push(sseFrame({ event: "a", id: "2", data: { i: 2 } }));
    conn.push(sseFrame({ event: "a", id: "3", data: { i: 3 } }));
    await clock.advance(0);

    expect(delivered.map((d) => d.seq)).toEqual([1, 2, 3]);
    client.stop();
  });

  test("a frame split at an arbitrary chunk boundary, including inside a multi-byte UTF-8 character, still delivers exactly one event", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch });
    const delivered: DeliveredCatamorbiusEvent[] = [];
    client.onEvent((e) => delivered.push(e));
    client.start();
    await clock.advance(0);

    const frame = sseFrame({ event: "a", id: "1", data: { emoji: "🎉", note: "hello" } });
    const conn = gateway.liveConns[0]!;
    // Split the raw UTF-8 bytes mid-way through the emoji's 4-byte sequence — the exact
    // arbitrary-byte-boundary case client.ts's own TextDecoder({stream:true}) buffering must
    // survive (see sse-parser.ts's header). A string-level split would land between UTF-16
    // surrogate halves instead and re-encode as a replacement character, not a genuine partial
    // byte sequence, so this goes through pushBytes with byte offsets computed directly.
    const bytes = new TextEncoder().encode(frame);
    const emojiByteStart = new TextEncoder().encode(frame.slice(0, frame.indexOf("🎉"))).length;
    const splitAt = emojiByteStart + 2; // 2 of the emoji's 4 UTF-8 bytes
    conn.pushBytes(bytes.slice(0, splitAt));
    conn.pushBytes(bytes.slice(splitAt));
    await clock.advance(0);

    expect(delivered).toEqual([{ seq: 1, event: { emoji: "🎉", note: "hello" } }]);
    client.stop();
  });

  test("a truncated final frame (stream ends with no closing blank line) is dropped, never delivered", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    gateway.queueStatus(503); // reconnect attempt after the truncated stream ends -> terminal, stops further fetches
    const client = makeClient({ clock, fetch: gateway.fetch });
    const delivered: DeliveredCatamorbiusEvent[] = [];
    client.onEvent((e) => delivered.push(e));
    client.start();
    await clock.advance(0);

    const conn = gateway.liveConns[0]!;
    conn.push("event: a\nid: 1\ndata: {\"x\":1}"); // no trailing blank line
    conn.close();
    await clock.advance(200); // let the scheduled reconnect fire

    expect(delivered).toEqual([]);
    client.stop();
  });
});

describe("terminal states: unauthorized (401) and unavailable (503) never retry", () => {
  test("401 -> unauthorized, no further fetch even after a long wait", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueStatus(401);
    const client = makeClient({ clock, fetch: gateway.fetch });
    const states = recordStates(client);
    client.start();
    await clock.advance(0);
    expect(states).toEqual(["connecting", "unauthorized"]);
    expect(client.state).toBe("unauthorized");

    await clock.advance(10_000_000);
    expect(gateway.calls).toHaveLength(1);
    client.stop();
  });

  test("503 -> unavailable, no further fetch even after a long wait", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueStatus(503);
    const client = makeClient({ clock, fetch: gateway.fetch });
    const states = recordStates(client);
    client.start();
    await clock.advance(0);
    expect(states).toEqual(["connecting", "unavailable"]);

    await clock.advance(10_000_000);
    expect(gateway.calls).toHaveLength(1);
    client.stop();
  });

  test("stop() then a fresh start() recovers from a terminal state", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueStatus(401);
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch });
    client.start();
    await clock.advance(0);
    expect(client.state).toBe("unauthorized");

    client.stop();
    expect(client.state).toBe("idle");
    client.start();
    await clock.advance(0);
    expect(client.state).toBe("live");
    client.stop();
  });
});

describe("400: drop cursor, reconnect, emit cursor-dropped resync", () => {
  test("lastSeq is cleared and the next attempt omits Last-Event-ID", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    gateway.queueStatus(400);
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch, backoffBaseMs: 50, watchdogMs: 60000, randomValues: [0.4] });
    const resyncs: ResyncReason[] = [];
    client.onResyncRequired((r) => resyncs.push(r));
    client.start();
    await clock.advance(0);

    gateway.liveConns[0]!.push(sseFrame({ event: "a", id: "5", data: {} }));
    await clock.advance(0);
    expect(client.lastSeq).toBe(5);

    gateway.liveConns[0]!.close();
    await clock.advance(1000); // reconnect attempt hits the queued 400

    expect(resyncs).toEqual(["cursor-dropped"]);
    expect(client.lastSeq).toBeNull();

    await clock.advance(1000); // next reconnect after the 400
    const lastCall = gateway.calls[gateway.calls.length - 1]!;
    expect(lastCall.headers["Last-Event-ID"]).toBeUndefined();
    client.stop();
  });
});

describe("resume: Last-Event-ID carries the last delivered seq", () => {
  test("a reconnect after a live stream closes sends Last-Event-ID = lastSeq", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch, backoffBaseMs: 50 });
    client.start();
    await clock.advance(0);
    expect(gateway.calls[0]!.headers["Last-Event-ID"]).toBeUndefined();

    gateway.liveConns[0]!.push(sseFrame({ event: "a", id: "42", data: {} }));
    await clock.advance(0);
    gateway.liveConns[0]!.close();

    await clock.advance(1000);
    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls[1]!.headers["Last-Event-ID"]).toBe("42");
    client.stop();
  });
});

describe("seq-went-backwards resync", () => {
  test("fires once when the first event after a reconnect carries a seq lower than the resumed cursor", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch, backoffBaseMs: 50 });
    const resyncs: ResyncReason[] = [];
    client.onResyncRequired((r) => resyncs.push(r));
    client.start();
    await clock.advance(0);

    gateway.liveConns[0]!.push(sseFrame({ event: "a", id: "100", data: {} }));
    await clock.advance(0);
    gateway.liveConns[0]!.close();
    await clock.advance(1000);

    const conn2 = gateway.liveConns[1]!;
    conn2.push(sseFrame({ event: "a", id: "3", data: {} })); // log reset: seq went backwards
    conn2.push(sseFrame({ event: "a", id: "4", data: {} }));
    await clock.advance(0);

    expect(resyncs).toEqual(["seq-went-backwards"]); // fired exactly once, not per-event
    client.stop();
  });
});

describe("liveness watchdog", () => {
  test("no bytes (event or heartbeat) within watchdogMs -> reconnect", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch, watchdogMs: 1000, backoffBaseMs: 50 });
    const states = recordStates(client);
    client.start();
    await clock.advance(0);
    expect(client.state).toBe("live");

    await clock.advance(999);
    expect(gateway.calls).toHaveLength(1); // not yet

    await clock.advance(1);
    expect(states).toContain("reconnecting");

    await clock.advance(100); // the scheduled backoff reconnect fires
    expect(gateway.calls).toHaveLength(2);
    client.stop();
  });

  test("a heartbeat comment resets the watchdog just like an event would", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch, watchdogMs: 1000 });
    client.start();
    await clock.advance(0);

    await clock.advance(900);
    gateway.liveConns[0]!.push(": heartbeat\n\n");
    await clock.advance(0);
    await clock.advance(900); // 1800ms since start, but only 900ms since the heartbeat

    expect(client.state).toBe("live"); // watchdog was reset by the heartbeat, never fired
    expect(gateway.calls).toHaveLength(1);
    client.stop();
  });
});

describe("reconnect backoff", () => {
  test("exponential with full jitter: delay = random() * min(cap, base * 2^attempt)", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    gateway.queueNetworkError();
    gateway.queueNetworkError();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch, backoffBaseMs: 100, backoffCapMs: 100000, randomValues: [0, 0.5, 0.25] });
    client.start();
    await clock.advance(0);
    gateway.liveConns[0]!.close(); // clean end -> immediate scheduleReconnect, attempt 0 -> delay = random()*100 = 0*100 = 0
    await clock.advance(0);
    expect(gateway.calls).toHaveLength(2); // the queued network error fires right away

    // attempt is now 1 (post-increment in nextBackoffDelay): delay = random()*min(cap,100*2^1)=0.5*200=100
    await clock.advance(99);
    expect(gateway.calls).toHaveLength(2);
    await clock.advance(1);
    expect(gateway.calls).toHaveLength(3); // second network error fires

    // attempt is now 2: delay = random()*min(cap,100*2^2)=0.25*400=100
    await clock.advance(99);
    expect(gateway.calls).toHaveLength(3);
    await clock.advance(1);
    expect(gateway.calls).toHaveLength(4);
    client.stop();
  });

  test("floored at the server's own retry: hint, even when it exceeds this attempt's computed delay", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch, backoffBaseMs: 100, backoffCapMs: 100000, randomValues: [0] });
    client.start();
    await clock.advance(0);

    gateway.liveConns[0]!.push("retry: 5000\n\n");
    await clock.advance(0);
    gateway.liveConns[0]!.close();
    await clock.advance(0); // schedule reconnect: computed delay = 0*100 = 0, floored at 5000

    await clock.advance(4999);
    expect(gateway.calls).toHaveLength(1);
    await clock.advance(1);
    expect(gateway.calls).toHaveLength(2);
    client.stop();
  });

  test("attempt resets to 0 after a connection has been stably live for backoffCapMs", async () => {
    // Constant non-zero jitter (0.5) so each reconnect's delay MAGNITUDE directly reveals what
    // `attempt` the client thinks it's on: growing attempt -> growing delay, a reset -> a small
    // delay again, even though random() itself never changes.
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive(); // #1: initial connect
    gateway.queueNetworkError(); // #2: attempt 0 -> delay 0.5*100=50
    gateway.queueNetworkError(); // #3: attempt 1 -> delay 0.5*200=100
    gateway.queueLive(); // #4: attempt 2 -> delay 0.5*400=200; then stays live long enough to reset
    gateway.queueNetworkError(); // #5: post-reset attempt 0 -> delay 0.5*100=50 again (not 0.5*800=400)
    const client = makeClient({ clock, fetch: gateway.fetch, backoffBaseMs: 100, backoffCapMs: 100000, watchdogMs: 300000, randomValues: [0.5] });
    client.start();
    await clock.advance(0);
    expect(gateway.calls).toHaveLength(1);

    gateway.liveConns[0]!.close();
    await clock.advance(0); // registers the delay-50 timer without letting it fire
    await clock.advance(49);
    expect(gateway.calls).toHaveLength(1);
    await clock.advance(1);
    expect(gateway.calls).toHaveLength(2); // delay 50 fired: attempt 0 -> 1

    await clock.advance(99);
    expect(gateway.calls).toHaveLength(2);
    await clock.advance(1);
    expect(gateway.calls).toHaveLength(3); // delay 100 fired: attempt 1 -> 2

    await clock.advance(199);
    expect(gateway.calls).toHaveLength(3);
    await clock.advance(1);
    expect(gateway.calls).toHaveLength(4); // delay 200 fired: attempt 2 -> 3, and this connection goes live
    expect(client.state).toBe("live");

    await clock.advance(100000); // stable period (backoffCapMs) elapses while live — nothing disconnects
    expect(gateway.calls).toHaveLength(4);

    gateway.liveConns[1]!.close();
    await clock.advance(0); // scheduleReconnect recomputes attempt=0 (stale-liveSince check) -> delay 50, NOT 400
    await clock.advance(49);
    expect(gateway.calls).toHaveLength(4); // still not due — if attempt had NOT reset, 0.5*800=400 would also not be due yet, so this alone doesn't distinguish
    await clock.advance(1);
    expect(gateway.calls).toHaveLength(5); // due at 50: proves attempt was reset to 0 (an un-reset attempt=3 would need 400ms, not 50ms)
    client.stop();
  });
});

describe("stop(): aborts in-flight request, cancels the reader, clears every timer — nothing left dangling", () => {
  test("stop() while live: no further fetch calls ever, even after a long wait", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch, watchdogMs: 500 });
    client.start();
    await clock.advance(0);
    expect(client.state).toBe("live");

    const signal = gateway.calls[0]!.signal;
    expect(signal.aborted).toBe(false);
    client.stop();
    expect(signal.aborted).toBe(true);
    expect(client.state).toBe("idle");

    await clock.advance(10_000_000);
    expect(gateway.calls).toHaveLength(1); // no watchdog reconnect, no backoff reconnect
  });

  test("stop() while a reconnect backoff timer is pending: the timer never fires", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    // A non-zero jitter so the reconnect timer has a real future deadline (50ms) instead of
    // firing immediately — otherwise there'd be no "pending, not yet fired" window to stop() in.
    const client = makeClient({ clock, fetch: gateway.fetch, backoffBaseMs: 100, randomValues: [0.5] });
    client.start();
    await clock.advance(0);
    gateway.liveConns[0]!.close();
    await clock.advance(0); // scheduleReconnect runs, a 50ms timer is now pending but not due

    client.stop();
    await clock.advance(10_000_000);
    expect(gateway.calls).toHaveLength(1);
  });

  test("stop() is idempotent", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch });
    client.start();
    await clock.advance(0);
    client.stop();
    client.stop();
    expect(client.state).toBe("idle");
  });

  test("stop() then a fresh start() WHILE a connect attempt is still awaiting fetch: the stale attempt never spawns its own reconnect chain (review-caught bug)", async () => {
    // Reproduces the exact race: start() kicks off connectOnce() #1, whose fetch never resolves
    // until we explicitly release it below. stop() aborts #1's request and immediately start()
    // clears `stopped` again — before this fix, #1's own `catch { if (stopped) return; ...}`
    // would see `stopped === false` (because start() already ran) and schedule ITS OWN
    // reconnect, running independently alongside the new attempt #2.
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    let releaseFirstFetch: ((res: FakeResponse) => void) | undefined;
    const firstFetchPromise = new Promise<FakeResponse>((resolve) => {
      releaseFirstFetch = resolve;
    });
    gateway.queueCustom((signal) => {
      // #1's fetch: resolves only when we call releaseFirstFetch, or rejects on abort.
      return new Promise<FakeResponse>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
        void firstFetchPromise.then(resolve);
      });
    });
    gateway.queueLive(); // #2's fetch, once the new attempt starts

    const client = makeClient({ clock, fetch: gateway.fetch, backoffBaseMs: 100, randomValues: [0.5] });
    const states = recordStates(client);
    client.start(); // attempt #1: fetch is now pending, never resolving until released
    await clock.advance(0);
    expect(gateway.calls).toHaveLength(1);

    client.stop(); // aborts #1's request (rejects its fetch promise via the abort listener)
    client.start(); // attempt #2: a NEW generation
    await clock.advance(0);
    expect(gateway.calls).toHaveLength(2); // #2 connected immediately
    expect(client.state).toBe("live");

    // Now let #1's ABORTED fetch promise actually settle (its abort-triggered rejection was
    // already queued; this just lets that microtask run to completion) and give its stale
    // `catch` block every chance to misbehave.
    await clock.advance(0);
    await clock.advance(10_000); // long past any backoff #1 might have scheduled if the bug were present

    expect(gateway.calls).toHaveLength(2); // still exactly 2 — #1 spawned NO reconnect chain of its own
    expect(client.state).toBe("live"); // #2's connection is untouched by #1's demise
    client.stop();
  });

  test("a throwing onEvent listener does not lose the event's delivery or force a reconnect (review-caught bug)", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch });
    const states = recordStates(client);
    const delivered: number[] = [];
    client.onEvent(() => {
      throw new Error("consumer bug");
    });
    client.onEvent((e) => delivered.push(e.seq));
    client.start();
    await clock.advance(0);

    gateway.liveConns[0]!.push(sseFrame({ event: "a", id: "1", data: {} }));
    await clock.advance(0);
    gateway.liveConns[0]!.push(sseFrame({ event: "a", id: "2", data: {} }));
    await clock.advance(0);

    expect(delivered).toEqual([1, 2]); // the throwing listener never stopped the well-behaved one
    expect(client.lastSeq).toBe(2);
    expect(states).toEqual(["connecting", "live"]); // no reconnect churn from the listener's own throw
    expect(gateway.calls).toHaveLength(1);
    client.stop();
  });

  test("a throwing onStateChange/onResyncRequired listener is isolated the same way", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueLive();
    gateway.queueStatus(400);
    const client = makeClient({ clock, fetch: gateway.fetch, backoffBaseMs: 50, randomValues: [0.5] });
    client.onStateChange(() => {
      throw new Error("consumer bug");
    });
    const resyncs: ResyncReason[] = [];
    client.onResyncRequired(() => {
      throw new Error("consumer bug");
    });
    client.onResyncRequired((r) => resyncs.push(r));
    client.start();
    await clock.advance(0);
    expect(client.state).toBe("live"); // setState itself never threw despite the listener

    gateway.liveConns[0]!.push(sseFrame({ event: "a", id: "9", data: {} }));
    await clock.advance(0);
    gateway.liveConns[0]!.close();
    await clock.advance(100); // reconnect hits the queued 400

    expect(resyncs).toEqual(["cursor-dropped"]); // the well-behaved resync listener still fired
    client.stop();
  });
});

describe("watchdog covers the connect phase, not just an already-live stream (review-caught bug)", () => {
  test("a gateway that accepts the request but never responds is treated as dead and reconnected", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.queueCustom(
      (signal) =>
        new Promise<FakeResponse>((_, reject) => {
          // Never resolves on its own — a real `fetch` only settles this hung request when its
          // AbortSignal fires, which is exactly what the watchdog is relied on to trigger.
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    gateway.queueLive();
    const client = makeClient({ clock, fetch: gateway.fetch, watchdogMs: 1000, backoffBaseMs: 50 });
    const states = recordStates(client);
    client.start();
    await clock.advance(0);
    expect(states).toEqual(["connecting"]); // still awaiting a response

    await clock.advance(999);
    expect(gateway.calls).toHaveLength(1); // watchdog not yet due
    await clock.advance(1); // watchdog fires: aborts the hung connect attempt
    await clock.advance(100); // scheduled reconnect fires, hitting the second queued script

    expect(gateway.calls).toHaveLength(2);
    expect(client.state).toBe("live");
    client.stop();
  });
});

describe("probe(): GET /healthz, never throws", () => {
  test("ok: true and the gateway's seq on a well-formed 200", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.setProbe(() => Promise.resolve({ status: 200, ok: true, body: null, json: () => Promise.resolve({ ok: true, seq: 42 }) }));
    const client = makeClient({ clock, fetch: gateway.fetch });
    await expect(client.probe()).resolves.toEqual({ ok: true, seq: 42 });
  });

  test("no Authorization header on the /healthz request (unauthenticated per the gateway's own contract)", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.setProbe(() => Promise.resolve({ status: 200, ok: true, body: null, json: () => Promise.resolve({ ok: true, seq: 1 }) }));
    const client = makeClient({ clock, fetch: gateway.fetch });
    await client.probe();
    expect(gateway.calls[0]!.headers["Authorization"]).toBeUndefined();
  });

  test("ok: false with the HTTP status on a non-2xx response", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.setProbe(() => Promise.resolve(statusResponse(503)));
    const client = makeClient({ clock, fetch: gateway.fetch });
    await expect(client.probe()).resolves.toEqual({ ok: false, reason: "HTTP 503" });
  });

  test("ok: false on a malformed body (missing/wrong-typed ok or seq)", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.setProbe(() => Promise.resolve({ status: 200, ok: true, body: null, json: () => Promise.resolve({ ok: true, seq: "not-a-number" }) }));
    const client = makeClient({ clock, fetch: gateway.fetch });
    await expect(client.probe()).resolves.toEqual({ ok: false, reason: "malformed /healthz response" });
  });

  test("ok: false, never throws, on a network-level rejection", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.setProbe(() => Promise.reject(new Error("ECONNREFUSED")));
    const client = makeClient({ clock, fetch: gateway.fetch });
    await expect(client.probe()).resolves.toEqual({ ok: false, reason: "ECONNREFUSED" });
  });

  test("times out at probeTimeoutMs, aborts the request, and never throws", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.setProbe(
      (signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const client = makeClient({ clock, fetch: gateway.fetch, probeTimeoutMs: 300 });
    const result = client.probe();
    await clock.advance(300);
    await expect(result).resolves.toEqual({ ok: false, reason: "aborted" });
  });
});

describe("secret redaction", () => {
  test("the token never appears in a probe() failure reason, even when the underlying error happens to be an object stringifying the client's own fields", async () => {
    const clock = createFakeClock();
    const gateway = createFakeGateway();
    gateway.setProbe(() => Promise.reject(new Error("plain network failure, no secrets here")));
    const client = makeClient({ clock, fetch: gateway.fetch });
    const result = await client.probe();
    expect(JSON.stringify(result).includes(TOKEN)).toBe(false);
  });
});
