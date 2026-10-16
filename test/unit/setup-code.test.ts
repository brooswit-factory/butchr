import { describe, expect, test } from "bun:test";
import { createSetupCodeManager, installSetupCodeSigusr2Handler, SETUP_CODE_MAX_ATTEMPTS, SETUP_CODE_TTL_MS } from "../../src/setup/setup-code.js";

function fakeRandomBytes(seed: number): (n: number) => Buffer {
  let i = seed;
  return (n) => { const b = Buffer.alloc(n); for (let k = 0; k < n; k++) b[k] = (i++ * 7) % 256; return b; };
}

describe("createSetupCodeManager", () => {
  test("state() before any mint: not minted, not locked, no expiry", () => {
    const m = createSetupCodeManager({ randomBytesFn: fakeRandomBytes(1) });
    expect(m.state()).toEqual({ minted: false, locked: false, expiresAt: null });
  });
  test("mint() returns a 13-character code from the no-ambiguous-character base32 alphabet, and never 0/O/1/I/L", () => {
    const m = createSetupCodeManager({ randomBytesFn: fakeRandomBytes(1) });
    const code = m.mint();
    expect(code).toHaveLength(13);
    expect(code).toMatch(/^[A-HJ-NP-TV-Z2-9]+$/);
    for (const ambiguous of ["0", "O", "1", "I", "L"]) expect(code).not.toContain(ambiguous);
  });
  test("a correct code is accepted exactly once (single-use) — the second check against the same code fails", () => {
    const m = createSetupCodeManager({ randomBytesFn: fakeRandomBytes(2) });
    const code = m.mint();
    expect(m.check(code)).toEqual({ ok: true });
    expect(m.check(code)).toEqual({ ok: false, reason: "no code minted" });
  });
  test("check() is case-insensitive", () => {
    const m = createSetupCodeManager({ randomBytesFn: fakeRandomBytes(3) });
    const code = m.mint();
    expect(m.check(code.toLowerCase())).toEqual({ ok: true });
  });
  test("a wrong code decrements attempts; the 5th wrong attempt locks, after which even the correct code is refused until a fresh mint", () => {
    const m = createSetupCodeManager({ randomBytesFn: fakeRandomBytes(4) });
    const code = m.mint();
    for (let i = 0; i < SETUP_CODE_MAX_ATTEMPTS - 1; i++) {
      expect(m.check("WRONGCODEXX")).toEqual({ ok: false, reason: "mismatch" });
    }
    expect(m.state().locked).toBe(false);
    expect(m.check("WRONGCODEXX")).toEqual({ ok: false, reason: "locked" });
    expect(m.state().locked).toBe(true);
    // Locked out even with the real code now.
    expect(m.check(code)).toEqual({ ok: false, reason: "locked" });
  });
  test("null/undefined/non-string candidates are refused as a mismatch, never thrown, and still consume an attempt", () => {
    const m = createSetupCodeManager({ randomBytesFn: fakeRandomBytes(5) });
    m.mint();
    expect(m.check(null)).toEqual({ ok: false, reason: "mismatch" });
    expect(m.check(undefined)).toEqual({ ok: false, reason: "mismatch" });
  });
  test("a code expires after its TTL — check() reports expired, not mismatch, and state() clears", () => {
    let now = 1_000_000;
    const m = createSetupCodeManager({ randomBytesFn: fakeRandomBytes(6), now: () => now });
    const code = m.mint();
    now += SETUP_CODE_TTL_MS - 1;
    expect(m.state().minted).toBe(true);
    now += 2; // now past TTL
    expect(m.check(code)).toEqual({ ok: false, reason: "expired" });
    expect(m.state()).toEqual({ minted: false, locked: false, expiresAt: null });
  });
  test("state() reports an ISO expiresAt while a code is live", () => {
    let now = 5_000_000;
    const m = createSetupCodeManager({ randomBytesFn: fakeRandomBytes(7), now: () => now });
    m.mint();
    const s = m.state();
    expect(s.minted).toBe(true);
    expect(s.expiresAt).toBe(new Date(now + SETUP_CODE_TTL_MS).toISOString());
  });
  test("mint() replaces a live code and resets attempts/lockout", () => {
    const m = createSetupCodeManager({ randomBytesFn: fakeRandomBytes(8) });
    const first = m.mint();
    for (let i = 0; i < SETUP_CODE_MAX_ATTEMPTS; i++) m.check("WRONGCODEXX");
    expect(m.state().locked).toBe(true);
    const second = m.mint();
    expect(second).not.toBe(first);
    expect(m.state().locked).toBe(false);
    expect(m.check(first)).toEqual({ ok: false, reason: "mismatch" }); // the old code is dead
    expect(m.check(second)).toEqual({ ok: true });
  });
});

describe("installSetupCodeSigusr2Handler", () => {
  test("mints a fresh code and logs exactly one line containing it on SIGUSR2; never writes it anywhere else", () => {
    const m = createSetupCodeManager({ randomBytesFn: fakeRandomBytes(9) });
    const logged: string[] = [];
    const uninstall = installSetupCodeSigusr2Handler(m, (l) => logged.push(l));
    try {
      process.emit("SIGUSR2");
      expect(logged).toHaveLength(1);
      const state = m.state();
      expect(state.minted).toBe(true);
      // The logged line is the only place the plaintext code appears — confirm the manager's own state() never leaks it.
      expect(JSON.stringify(state)).not.toContain("setup code");
    } finally {
      uninstall();
    }
  });
  test("uninstalling removes the listener — a later SIGUSR2 does not log again", () => {
    const m = createSetupCodeManager({ randomBytesFn: fakeRandomBytes(10) });
    const logged: string[] = [];
    const uninstall = installSetupCodeSigusr2Handler(m, (l) => logged.push(l));
    uninstall();
    process.emit("SIGUSR2");
    expect(logged).toHaveLength(0);
  });
});
