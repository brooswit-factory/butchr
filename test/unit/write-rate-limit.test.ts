import { describe, expect, test } from "bun:test";
import { createWriteRateLimiter, DEFAULT_WRITE_RATE_LIMIT_MAX, DEFAULT_WRITE_RATE_LIMIT_WINDOW_MS } from "../../src/web/write-rate-limit.js";

describe("createWriteRateLimiter", () => {
  test("the first `max` attempts in a window are allowed, the next is refused with a positive Retry-After", () => {
    let now = 0;
    const check = createWriteRateLimiter({ windowMs: 10_000, max: 3, now: () => now });
    expect(check("client-a")).toEqual({ ok: true });
    expect(check("client-a")).toEqual({ ok: true });
    expect(check("client-a")).toEqual({ ok: true });
    const refused = check("client-a");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("a refused attempt does not itself extend the window — it is never counted as a new attempt", () => {
    let now = 0;
    const check = createWriteRateLimiter({ windowMs: 10_000, max: 1, now: () => now });
    expect(check("a").ok).toBe(true);
    now += 1_000;
    expect(check("a").ok).toBe(false); // refused, not counted
    now += 1_000;
    expect(check("a").ok).toBe(false); // still refused — window hasn't moved
    now += 8_001; // the ORIGINAL attempt (at t=0) has now aged out of the 10s window
    expect(check("a").ok).toBe(true);
  });

  test("after the window elapses, the budget resets", () => {
    let now = 0;
    const check = createWriteRateLimiter({ windowMs: 1_000, max: 1, now: () => now });
    expect(check("a").ok).toBe(true);
    expect(check("a").ok).toBe(false);
    now += 1_000;
    expect(check("a").ok).toBe(true);
  });

  test("PER-CLIENT, NOT GLOBAL: one client exhausting its budget never 429s a different client", () => {
    let now = 0;
    const check = createWriteRateLimiter({ windowMs: 10_000, max: 1, now: () => now });
    expect(check("client-a").ok).toBe(true);
    expect(check("client-a").ok).toBe(false); // client-a is now exhausted
    expect(check("client-b").ok).toBe(true); // client-b has its own, untouched budget
    expect(check("client-b").ok).toBe(false);
    expect(check("client-c").ok).toBe(true); // a third, still-untouched client
  });

  test("defaults: 10 writes per 60s window when not overridden", () => {
    expect(DEFAULT_WRITE_RATE_LIMIT_MAX).toBe(10);
    expect(DEFAULT_WRITE_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    let now = 0;
    const check = createWriteRateLimiter({ now: () => now });
    for (let i = 0; i < DEFAULT_WRITE_RATE_LIMIT_MAX; i++) expect(check("x").ok).toBe(true);
    expect(check("x").ok).toBe(false);
  });

  test("a plan-then-apply pair (2 attempts) never trips the default budget", () => {
    const check = createWriteRateLimiter();
    expect(check("client").ok).toBe(true); // plan
    expect(check("client").ok).toBe(true); // apply, moments later
  });
});
