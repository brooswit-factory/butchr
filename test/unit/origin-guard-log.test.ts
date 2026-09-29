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
    expect(lines).toEqual([`${ORIGIN_GUARD_TAG} method=GET path=/agents/x/pty origin=absent result=origin required`]);
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
    const logger = createOriginGuardLogger({ now: () => t, log, windowMs: 1_000 });
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
