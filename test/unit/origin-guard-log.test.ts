import { describe, expect, test } from "bun:test";
import { createOriginGuardLogger, ORIGIN_GUARD_TAG } from "../../src/web/origin-guard-log.js";

function collector() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

describe("createOriginGuardLogger", () => {
  test("emits one line with the expected fields for a rejection with a present origin", () => {
    const { lines, log } = collector();
    let t = 0;
    const logger = createOriginGuardLogger({ now: () => t, log });
    logger.reject({ method: "GET", path: "/resources/for-url", origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", result: "origin not allowed" });
    expect(lines).toEqual([`${ORIGIN_GUARD_TAG} method=GET path=/resources/for-url origin=chrome-extension://abcdefghijklmnopabcdefghijklmnop result=origin not allowed`]);
  });

  test("an absent origin logs the literal 'absent', never null/empty", () => {
    const { lines, log } = collector();
    const logger = createOriginGuardLogger({ now: () => 0, log });
    logger.reject({ method: "GET", path: "/agents/x/pty", origin: null, result: "origin required" });
    // FACTORY-502 (a): `/agents/x/pty` is now normalized to the route
    // PATTERN before it's printed — see the dedicated route-pattern tests
    // below. This assertion's shape is otherwise unchanged.
    expect(lines).toEqual([`${ORIGIN_GUARD_TAG} method=GET path=/agents/:agentKey/pty origin=absent result=origin required`]);
  });

  test("each of the three rejection kinds emits exactly one line with its own result", () => {
    const { lines, log } = collector();
    let t = 0;
    const logger = createOriginGuardLogger({ now: () => t, log });
    logger.reject({ method: "GET", path: "/a", origin: null, result: "origin required" });
    t += 100;
    logger.reject({ method: "GET", path: "/b", origin: "chrome-extension://x", result: "origin not allowed" });
    t += 100;
    logger.reject({ method: "GET", path: "/c", origin: "chrome-extension://x", result: "allowlist empty" });
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("result=origin required");
    expect(lines[1]).toContain("result=origin not allowed");
    expect(lines[2]).toContain("result=allowlist empty");
  });

  test("a repeat of the same (method, path, origin, result) within the window is suppressed, and emits again after the window", () => {
    const { lines, log } = collector();
    let t = 0;
    const logger = createOriginGuardLogger({ now: () => t, log, windowMs: 60_000 });
    const r = { method: "GET", path: "/resources/for-url", origin: "chrome-extension://x", result: "origin not allowed" } as const;
    logger.reject(r);
    t += 1_000;
    logger.reject(r); // within the window — suppressed
    t += 1_000;
    logger.reject(r); // still within the window — suppressed
    expect(lines.length).toBe(1);
    t += 60_000; // now >= 60s since the first (and only) emitted line
    logger.reject(r);
    expect(lines.length).toBe(2);
  });

  test("distinct (method, path, origin, result) tuples are rate-limited independently", () => {
    const { lines, log } = collector();
    let t = 0;
    const logger = createOriginGuardLogger({ now: () => t, log });
    logger.reject({ method: "GET", path: "/resources/for-url", origin: "chrome-extension://x", result: "origin not allowed" });
    logger.reject({ method: "OPTIONS", path: "/resources/for-url", origin: "chrome-extension://x", result: "origin not allowed" });
    logger.reject({ method: "GET", path: "/agents/x/pty", origin: "chrome-extension://x", result: "origin not allowed" });
    logger.reject({ method: "GET", path: "/resources/for-url", origin: "chrome-extension://y", result: "origin not allowed" });
    logger.reject({ method: "GET", path: "/resources/for-url", origin: "chrome-extension://x", result: "allowlist empty" });
    expect(lines.length).toBe(5);
  });

  test("the dedupe map is bounded: an expired entry is pruned, not retained forever", () => {
    const { lines, log } = collector();
    let t = 0;
    // FACTORY-502 added a global per-window line cap (b) and a map-size cap
    // (c), both with defaults well under 500 — raised here so this test
    // keeps exercising what it always tested (pruning/expiry), independent
    // of those two new, separately-tested bounds.
    const logger = createOriginGuardLogger({ now: () => t, log, windowMs: 1_000, maxLinesPerWindow: 1_000, maxMapSize: 1_000 });
    // A flood of distinct origins (attacker-controlled) within one window...
    for (let i = 0; i < 500; i++) {
      logger.reject({ method: "GET", path: "/p", origin: `chrome-extension://${i}`, result: "origin not allowed" });
    }
    expect(lines.length).toBe(500);
    t += 2_000; // well past the window — every prior entry is now expired
    // ...and a fresh flood after the window all emit again, proving the
    // earlier entries were pruned rather than silently suppressing forever.
    for (let i = 0; i < 500; i++) {
      logger.reject({ method: "GET", path: "/p", origin: `chrome-extension://${i}`, result: "origin not allowed" });
    }
    expect(lines.length).toBe(1000);
  });

  test("FACTORY-502 (a): the PTY route dedupes on the route PATTERN, not the raw agent key — many distinct agent keys within a window produce exactly one line", () => {
    const { lines, log } = collector();
    let t = 0;
    const logger = createOriginGuardLogger({ now: () => t, log });
    for (let i = 0; i < 50; i++) {
      logger.reject({ method: "GET", path: `/agents/agent-${i}/pty`, origin: "chrome-extension://x", result: "origin not allowed" });
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe(`${ORIGIN_GUARD_TAG} method=GET path=/agents/:agentKey/pty origin=chrome-extension://x result=origin not allowed`);
    // The raw agent key must never reach the line — that's the flood vector
    // this criterion exists to close.
    expect(lines[0]).not.toContain("agent-0");
    expect(lines[0]).not.toContain("agent-49");
  });

  test("FACTORY-502 (a): a fixed route path with no dynamic segment is left unchanged by route-pattern normalization", () => {
    const { lines, log } = collector();
    const logger = createOriginGuardLogger({ now: () => 0, log });
    logger.reject({ method: "GET", path: "/resources/for-url", origin: null, result: "origin required" });
    expect(lines[0]).toContain("path=/resources/for-url");
  });

  test("FACTORY-502 (b): a global per-window line cap suppresses further DISTINCT rejections once reached, and a single suppressed=N line is emitted only once the window rolls over", () => {
    const { lines, log } = collector();
    let t = 0;
    const logger = createOriginGuardLogger({ now: () => t, log, windowMs: 1_000, maxLinesPerWindow: 5, maxMapSize: 1_000 });
    for (let i = 0; i < 10; i++) {
      logger.reject({ method: "GET", path: "/p", origin: `chrome-extension://${i}`, result: "origin not allowed" });
    }
    // Only the first 5 distinct rejections actually emit — the cap is
    // reached, but nothing about the suppressed line has been emitted yet:
    // the window hasn't rolled over.
    expect(lines.length).toBe(5);
    expect(lines.filter((l) => l.includes("suppressed=")).length).toBe(0);

    t += 1_000; // roll into the next window
    logger.reject({ method: "GET", path: "/p", origin: "chrome-extension://new", result: "origin not allowed" });
    // The prior window's suppressed count (5 dropped, of the 10 attempted)
    // is flushed as exactly one line, followed by the new window's own
    // first (uncapped) real line.
    expect(lines.length).toBe(7);
    expect(lines[5]).toBe(`${ORIGIN_GUARD_TAG} suppressed=5`);
    expect(lines[6]).toContain("origin=chrome-extension://new");
    expect(lines.filter((l) => l.includes("suppressed=")).length).toBe(1);
  });

  test("FACTORY-502 (b): the suppressed-line notice is itself rate-limited — never more than one per window even with repeated over-cap bursts", () => {
    const { lines, log } = collector();
    let t = 0;
    const logger = createOriginGuardLogger({ now: () => t, log, windowMs: 1_000, maxLinesPerWindow: 1, maxMapSize: 1_000 });
    // Window 1: 4 distinct rejections, 1 emitted, 3 suppressed.
    for (let i = 0; i < 4; i++) {
      logger.reject({ method: "GET", path: "/p", origin: `chrome-extension://w1-${i}`, result: "origin not allowed" });
    }
    t += 1_000; // -> window 2
    // Window 2: 4 more distinct rejections, 1 emitted, 3 suppressed. The
    // first call of window 2 also flushes window 1's suppressed=3 line.
    for (let i = 0; i < 4; i++) {
      logger.reject({ method: "GET", path: "/p", origin: `chrome-extension://w2-${i}`, result: "origin not allowed" });
    }
    t += 1_000; // -> window 3, flushing window 2's suppressed=3 line
    logger.reject({ method: "GET", path: "/p", origin: "chrome-extension://w3", result: "origin not allowed" });

    const suppressedLines = lines.filter((l) => l.includes("suppressed="));
    expect(suppressedLines).toEqual([`${ORIGIN_GUARD_TAG} suppressed=3`, `${ORIGIN_GUARD_TAG} suppressed=3`]);
  });

  test("FACTORY-502 (c): the dedupe map size is capped on insert — beyond the cap, further distinct keys are suppressed rather than growing the map", () => {
    const { lines, log } = collector();
    let t = 0;
    const logger = createOriginGuardLogger({ now: () => t, log, windowMs: 60_000, maxMapSize: 3, maxLinesPerWindow: 1_000 });
    for (let i = 0; i < 10; i++) {
      logger.reject({ method: "GET", path: "/p", origin: `chrome-extension://${i}`, result: "origin not allowed" });
    }
    // Only the first 3 distinct keys ever get a map slot (and a line) —
    // the remaining 7 are suppressed for lack of room, proving the map
    // never grew past its cap even though every request carried a distinct
    // key.
    expect(lines.length).toBe(3);

    t += 60_000; // past the window — the 3 held entries are now expired, and this call's own window roll flushes the 7 suppressed above
    logger.reject({ method: "GET", path: "/p", origin: "chrome-extension://10", result: "origin not allowed" });
    expect(lines.length).toBe(5);
    expect(lines[3]).toBe(`${ORIGIN_GUARD_TAG} suppressed=7`);
    // Pruning freed the map, so this fresh distinct key now has room and emits.
    expect(lines[4]).toContain("origin=chrome-extension://10");
  });

  test("FACTORY-502 (d): a live key is never re-`set` — repeating it inside the window does not extend its own dedupe TTL", () => {
    const { lines, log } = collector();
    let t = 0;
    const logger = createOriginGuardLogger({ now: () => t, log, windowMs: 1_000 });
    const r = { method: "GET", path: "/p", origin: "chrome-extension://x", result: "origin not allowed" } as const;
    logger.reject(r); // t=0: emits, recorded lastEmittedAt=0
    t += 200;
    logger.reject(r); // live (200<1000): suppressed — if this incorrectly re-`set`, lastEmittedAt would become 200
    t += 799;
    logger.reject(r); // t=999, live (999<1000): suppressed
    t += 1; // t=1000
    logger.reject(r);
    // If the repeats above had re-`set` this key, its recorded time would
    // be 999 and t=1000 would still be within the window (1000-999=1<1000),
    // staying suppressed. It emits here ONLY if lastEmittedAt is still the
    // ORIGINAL t=0 — proving the live-key branch never re-`set`.
    expect(lines.length).toBe(2);
  });

  test("FACTORY-502 (d): the early-exit prune stops at the first unexpired entry without over- or under-pruning a live entry behind it", () => {
    const { lines, log } = collector();
    let t = 0;
    const logger = createOriginGuardLogger({ now: () => t, log, windowMs: 1_000 });
    logger.reject({ method: "GET", path: "/a", origin: "chrome-extension://x", result: "origin not allowed" }); // t=0, key A
    t += 500;
    logger.reject({ method: "GET", path: "/b", origin: "chrome-extension://x", result: "origin not allowed" }); // t=500, key B
    t += 499;
    // t=999: A is still live (999<1000) — repeating it must hit the
    // no-re-`set` branch above, not extend its position/TTL.
    logger.reject({ method: "GET", path: "/a", origin: "chrome-extension://x", result: "origin not allowed" });
    expect(lines.length).toBe(2); // suppressed repeat of A — no 3rd line yet

    t += 2; // t=1001: A (recorded at 0) is now expired (1001>=1000); B (recorded at 500) is not (501<1000)
    logger.reject({ method: "GET", path: "/c", origin: "chrome-extension://x", result: "origin not allowed" }); // t=1001, key C — triggers the prune
    expect(lines.length).toBe(3); // C emits; prune ran but didn't touch B

    // A was pruned: repeating it now is a brand-new key and emits again.
    logger.reject({ method: "GET", path: "/a", origin: "chrome-extension://x", result: "origin not allowed" });
    expect(lines.length).toBe(4);

    // B was NOT pruned (the early exit correctly stopped at it, unexpired):
    // repeating it now is still a live-key suppression, not a fresh emit.
    logger.reject({ method: "GET", path: "/b", origin: "chrome-extension://x", result: "origin not allowed" });
    expect(lines.length).toBe(4);
  });

  test("query strings never reach the line: this module only ever sees `path`, and logs it verbatim", () => {
    const { lines, log } = collector();
    const logger = createOriginGuardLogger({ now: () => 0, log });
    logger.reject({ method: "GET", path: "/resources/for-url", origin: null, result: "origin required" });
    expect(lines[0]).not.toContain("?");
    expect(lines[0]).not.toContain("url=https");
  });

  test("defaults to Date.now and console.error when no deps are given", () => {
    const original = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => { calls.push(args); };
    try {
      const logger = createOriginGuardLogger();
      logger.reject({ method: "GET", path: "/x", origin: null, result: "origin required" });
      expect(calls.length).toBe(1);
      expect(calls[0]?.[0]).toContain(ORIGIN_GUARD_TAG);
    } finally {
      console.error = original;
    }
  });
});
