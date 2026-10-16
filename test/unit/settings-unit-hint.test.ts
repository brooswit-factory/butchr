import { describe, expect, test } from "bun:test";
import { parseSystemctlShow, createCachedUnitHint } from "../../src/web/settings-unit-hint.js";
import type { UnitHint } from "../../src/web/settings-api.js";

describe("parseSystemctlShow", () => {
  test("parses DropInPaths and EnvironmentFiles, space-separated", () => {
    const out = "DropInPaths=/etc/systemd/user/butchr.service.d/10-override.conf\nEnvironmentFiles=/home/user/.config/butchr/butchr.env (ignore_errors=no)\n";
    const hint = parseSystemctlShow(out);
    expect(hint.dropInPaths).toEqual(["/etc/systemd/user/butchr.service.d/10-override.conf"]);
    expect(hint.environmentFiles[0]).toContain("butchr.env");
  });

  test("empty values: empty arrays, never undefined/null entries", () => {
    const hint = parseSystemctlShow("DropInPaths=\nEnvironmentFiles=\n");
    expect(hint.dropInPaths).toEqual([]);
    expect(hint.environmentFiles).toEqual([]);
  });

  test("multiple drop-in paths on one line", () => {
    const hint = parseSystemctlShow("DropInPaths=/a/10.conf /b/20.conf\n");
    expect(hint.dropInPaths).toEqual(["/a/10.conf", "/b/20.conf"]);
  });

  test("unrecognized keys are ignored", () => {
    const hint = parseSystemctlShow("SomeOtherKey=whatever\nDropInPaths=/a.conf\n");
    expect(hint.dropInPaths).toEqual(["/a.conf"]);
    expect(hint.environmentFiles).toEqual([]);
  });
});

// FACTORY-694 item 6: every `GET /api/settings` call used to spawn a fresh
// `systemctl` child — these tests prove the cache actually suppresses that.
describe("createCachedUnitHint", () => {
  const HINT: UnitHint = { dropInPaths: ["/a.conf"], environmentFiles: [] };

  test("a second call within the TTL reuses the cached value — no second read", async () => {
    let calls = 0;
    let now = 0;
    const cached = createCachedUnitHint(async () => { calls++; return HINT; }, 30_000, () => now);
    const first = await cached();
    now += 10_000;
    const second = await cached();
    expect(first).toEqual(HINT);
    expect(second).toEqual(HINT);
    expect(calls).toBe(1);
  });

  test("a call after the TTL has elapsed re-reads", async () => {
    let calls = 0;
    let now = 0;
    const cached = createCachedUnitHint(async () => { calls++; return HINT; }, 30_000, () => now);
    await cached();
    now += 30_001;
    await cached();
    expect(calls).toBe(2);
  });

  test("a failed read (undefined) is cached too — not re-spawned on every request within the TTL", async () => {
    let calls = 0;
    let now = 0;
    const cached = createCachedUnitHint(async () => { calls++; return undefined; }, 30_000, () => now);
    const first = await cached();
    now += 5_000;
    const second = await cached();
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("concurrent calls during a cache miss share the SAME in-flight read — one spawn, not one per caller", async () => {
    let calls = 0;
    let resolveRead: ((v: UnitHint) => void) | undefined;
    const cached = createCachedUnitHint(() => new Promise<UnitHint | undefined>((resolve) => { calls++; resolveRead = resolve; }), 30_000, () => 0);
    const p1 = cached();
    const p2 = cached();
    const p3 = cached();
    expect(calls).toBe(1);
    resolveRead!(HINT);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual(HINT);
    expect(r2).toEqual(HINT);
    expect(r3).toEqual(HINT);
  });
});
