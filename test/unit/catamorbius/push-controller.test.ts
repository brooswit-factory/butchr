import { describe, expect, test } from "bun:test";
import type { CatamorbiusClient, CatamorbiusClientState, DeliveredCatamorbiusEvent, ResyncReason } from "../../../src/catamorbius/client.js";
import { createCatamorbiusPushController, type PushConsumer } from "../../../src/catamorbius/push-controller.js";
import type { CatamorbiusFullConfig } from "../../../src/catamorbius/push-config.js";

/** A fully scriptable fake `CatamorbiusClient` — the controller under test never sees a real connection. */
function fakeClient() {
  let state: CatamorbiusClientState = "idle";
  const stateListeners: Array<(s: CatamorbiusClientState) => void> = [];
  const eventListeners: Array<(d: DeliveredCatamorbiusEvent) => void> = [];
  const resyncListeners: Array<(r: ResyncReason) => void> = [];
  const client: CatamorbiusClient = {
    start: () => { setState("connecting"); },
    stop: () => { setState("idle"); },
    get state() { return state; },
    get lastSeq() { return null; },
    onStateChange: (l) => { stateListeners.push(l); return () => {}; },
    onEvent: (l) => { eventListeners.push(l); return () => {}; },
    onResyncRequired: (l) => { resyncListeners.push(l); return () => {}; },
    probe: async () => ({ ok: true, seq: 0 }),
  };
  function setState(s: CatamorbiusClientState): void {
    if (s === state) return;
    state = s;
    for (const l of stateListeners) l(s);
  }
  function emitEvent(d: DeliveredCatamorbiusEvent): void {
    for (const l of eventListeners) l(d);
  }
  function emitResync(r: ResyncReason): void {
    for (const l of resyncListeners) l(r);
  }
  return { client, setState, emitEvent, emitResync };
}

/** A controllable clock/timer pair so grace expiry is deterministic — same "injected, never global" contract every other timer in this codebase already follows. */
function fakeClock() {
  let now = 0;
  const scheduled: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { const id = nextId++; scheduled.push({ at: now + ms, fn, id }); return id; },
    clearTimeout: (id: unknown) => { const i = scheduled.findIndex((s) => s.id === id); if (i >= 0) scheduled.splice(i, 1); },
    random: () => 0.5,
    advance(ms: number): void {
      now += ms;
      for (;;) {
        const due = scheduled.filter((s) => s.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        scheduled.splice(scheduled.indexOf(due), 1);
        due.fn();
      }
    },
  };
}

function fakeConsumer(): PushConsumer & { dirtyMarks: string[]; resyncCount: number; passCount: number } {
  const dirtyMarks: string[] = [];
  let resyncCount = 0;
  let passCount = 0;
  return {
    dirtyMarks,
    get resyncCount() { return resyncCount; },
    get passCount() { return passCount; },
    markDirty: (k) => { dirtyMarks.push(k); },
    requestResync: () => { resyncCount += 1; },
    runDirtyPass: async () => { passCount += 1; },
  };
}

const config: CatamorbiusFullConfig = {
  catamorbius: { baseUrl: "http://x", token: "t", watchdogMs: 1000, backoffBaseMs: 1000, backoffCapMs: 1000, probeTimeoutMs: 1000 },
  push: { providers: ["jira", "github"], ttlMs: 600_000, ttlMsByProvider: {}, graceMs: 60_000, debounceMs: 2_000 },
};

describe("createCatamorbiusPushController: coverage", () => {
  test("not covering until live", () => {
    const { client } = fakeClient();
    const clock = fakeClock();
    const controller = createCatamorbiusPushController(config, { createClient: () => client, clientDeps: { fetch: (() => {}) as never, ...clock } });
    expect(controller.coverage.isCoveringNow()).toBe(false);
    controller.start();
    expect(controller.coverage.isCoveringNow()).toBe(false); // "connecting" is not covering
  });

  test("covering once live; reconnecting stays covered within grace, degrades after grace expires", () => {
    const { client, setState } = fakeClient();
    const clock = fakeClock();
    const controller = createCatamorbiusPushController(config, { createClient: () => client, clientDeps: { fetch: (() => {}) as never, ...clock } });
    controller.start();
    setState("live");
    expect(controller.coverage.isCoveringNow()).toBe(true);

    setState("reconnecting");
    expect(controller.coverage.isCoveringNow()).toBe(true); // within grace
    clock.advance(30_000);
    expect(controller.coverage.isCoveringNow()).toBe(true); // still within grace (60s default)
    clock.advance(31_000); // total 61s > 60s grace
    expect(controller.coverage.isCoveringNow()).toBe(false);
    expect(controller.stats().degrades).toBe(1);
  });

  test("unauthorized/unavailable are uncovered immediately, no grace", () => {
    const { client, setState } = fakeClient();
    const clock = fakeClock();
    const controller = createCatamorbiusPushController(config, { createClient: () => client, clientDeps: { fetch: (() => {}) as never, ...clock } });
    controller.start();
    setState("live");
    setState("unauthorized");
    expect(controller.coverage.isCoveringNow()).toBe(false);
  });

  test("isProviderEnabled reflects CATAMORBIUS_PROVIDERS", () => {
    const { client } = fakeClient();
    const clock = fakeClock();
    const controller = createCatamorbiusPushController(config, { createClient: () => client, clientDeps: { fetch: (() => {}) as never, ...clock } });
    expect(controller.coverage.isProviderEnabled("jira")).toBe(true);
    expect(controller.coverage.isProviderEnabled("github")).toBe(true);
  });
});

describe("createCatamorbiusPushController: dirty/resync broadcast", () => {
  test("a mapped event marks every registered consumer dirty and triggers a pass", async () => {
    const { client, setState, emitEvent } = fakeClient();
    const clock = fakeClock();
    const controller = createCatamorbiusPushController(config, { createClient: () => client, clientDeps: { fetch: (() => {}) as never, ...clock } });
    controller.start();
    setState("live");
    const consumer = fakeConsumer();
    controller.registerConsumer(consumer);
    emitEvent({ seq: 1, event: { id: "e1", source: "//jira/site", subject: "KAN-5" } });
    await Promise.resolve();
    expect(consumer.dirtyMarks).toEqual(["jira:KAN-5"]);
    expect(consumer.passCount).toBe(1);
    expect(controller.stats().notificationsReceived).toBe(1);
    expect(controller.stats().unmapped).toBe(0);
  });

  test("an unmapped event (no watch key) is counted, never marks anything dirty", async () => {
    const { client, setState, emitEvent } = fakeClient();
    const clock = fakeClock();
    const controller = createCatamorbiusPushController(config, { createClient: () => client, clientDeps: { fetch: (() => {}) as never, ...clock } });
    controller.start();
    setState("live");
    const consumer = fakeConsumer();
    controller.registerConsumer(consumer);
    emitEvent({ seq: 1, event: { id: "e1", source: "//github/acme", subject: "acme/widgets@main" } }); // a push event, no issue/PR
    await Promise.resolve();
    expect(consumer.dirtyMarks).toEqual([]);
    expect(controller.stats().unmapped).toBe(1);
  });

  test("D6: a duplicate CloudEvent id is deduped, never re-marks dirty", async () => {
    const { client, setState, emitEvent } = fakeClient();
    const clock = fakeClock();
    const controller = createCatamorbiusPushController(config, { createClient: () => client, clientDeps: { fetch: (() => {}) as never, ...clock } });
    controller.start();
    setState("live");
    const consumer = fakeConsumer();
    controller.registerConsumer(consumer);
    emitEvent({ seq: 1, event: { id: "e1", source: "//jira/site", subject: "KAN-5" } });
    emitEvent({ seq: 2, event: { id: "e1", source: "//jira/site", subject: "KAN-5" } }); // redelivered, same id
    await Promise.resolve();
    expect(consumer.dirtyMarks).toEqual(["jira:KAN-5"]);
    expect(controller.stats().deduped).toBe(1);
  });

  test("D6: a seq <= the last seen seq is deduped by the monotonic guard even with a different id", async () => {
    const { client, setState, emitEvent } = fakeClient();
    const clock = fakeClock();
    const controller = createCatamorbiusPushController(config, { createClient: () => client, clientDeps: { fetch: (() => {}) as never, ...clock } });
    controller.start();
    setState("live");
    const consumer = fakeConsumer();
    controller.registerConsumer(consumer);
    emitEvent({ seq: 5, event: { id: "e1", source: "//jira/site", subject: "KAN-5" } });
    emitEvent({ seq: 3, event: { id: "e2", source: "//jira/site", subject: "KAN-6" } }); // seq went backwards, different id
    await Promise.resolve();
    expect(consumer.dirtyMarks).toEqual(["jira:KAN-5"]);
    expect(controller.stats().deduped).toBe(1);
  });

  test("D5: a resync signal marks every consumer resync-pending and triggers a pass; resets the monotonic seq guard", async () => {
    const { client, setState, emitEvent, emitResync } = fakeClient();
    const clock = fakeClock();
    const controller = createCatamorbiusPushController(config, { createClient: () => client, clientDeps: { fetch: (() => {}) as never, ...clock } });
    controller.start();
    setState("live");
    const consumer = fakeConsumer();
    controller.registerConsumer(consumer);
    emitResync("cursor-dropped");
    await Promise.resolve();
    expect(consumer.resyncCount).toBe(1);
    expect(consumer.passCount).toBe(1);
    expect(controller.stats().resyncs).toBe(1);
    // guard reset: a lower seq right after a resync is NOT deduped
    emitEvent({ seq: 1, event: { id: "e1", source: "//jira/site", subject: "KAN-5" } });
    await Promise.resolve();
    expect(controller.stats().deduped).toBe(0);
  });

  test("D5: reconnecting-then-live (having been live before) also broadcasts resync; the FIRST ever live transition does not", async () => {
    const { client, setState } = fakeClient();
    const clock = fakeClock();
    const controller = createCatamorbiusPushController(config, { createClient: () => client, clientDeps: { fetch: (() => {}) as never, ...clock } });
    controller.start();
    const consumer = fakeConsumer();
    controller.registerConsumer(consumer);
    setState("live"); // first ever live transition — no resync expected
    expect(consumer.resyncCount).toBe(0);
    setState("reconnecting");
    setState("live"); // recovery — resync expected
    await Promise.resolve();
    expect(consumer.resyncCount).toBe(1);
  });

  test("unregistering a consumer stops delivery to it", async () => {
    const { client, setState, emitEvent } = fakeClient();
    const clock = fakeClock();
    const controller = createCatamorbiusPushController(config, { createClient: () => client, clientDeps: { fetch: (() => {}) as never, ...clock } });
    controller.start();
    setState("live");
    const consumer = fakeConsumer();
    const unregister = controller.registerConsumer(consumer);
    unregister();
    emitEvent({ seq: 1, event: { id: "e1", source: "//jira/site", subject: "KAN-5" } });
    await Promise.resolve();
    expect(consumer.dirtyMarks).toEqual([]);
  });
});

describe("createCatamorbiusPushController: stop()", () => {
  test("stop() calls the underlying client's stop and clears any pending grace timer", () => {
    const { client, setState } = fakeClient();
    const clock = fakeClock();
    const controller = createCatamorbiusPushController(config, { createClient: () => client, clientDeps: { fetch: (() => {}) as never, ...clock } });
    controller.start();
    setState("live");
    setState("reconnecting"); // arms the grace timer
    controller.stop(); // idle is itself a genuine coverage-loss transition: exactly one degrade
    expect(controller.clientState()).toBe("idle");
    expect(controller.stats().degrades).toBe(1);
    clock.advance(120_000); // if the grace timer weren't cleared, this would log a SECOND, stray degrade
    expect(controller.stats().degrades).toBe(1);
  });
});
