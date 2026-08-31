import { describe, expect, test } from "bun:test";
import { findMarked, RateCap, HOUR_MS, type CommentRow } from "../../src/agents/escalation-helper.js";

describe("findMarked", () => {
  const row = (id: string, body: string): CommentRow => ({ id, body, created: "c" });

  test("finds a comment starting with the marker and containing every required substring", () => {
    const rows = [row("1", "some prose"), row("2", "[m] hello\nfingerprint: X\nstage: 1")];
    expect(findMarked(rows, "[m]", ["fingerprint: X", "stage: 1"])?.id).toBe("2");
  });

  test("a comment containing the marker but NOT at the start does not match", () => {
    const rows = [row("1", "quoting [m] fingerprint: X stage: 1")];
    expect(findMarked(rows, "[m]", ["fingerprint: X", "stage: 1"])).toBeNull();
  });

  test("requires EVERY substring — missing one is a miss", () => {
    const rows = [row("1", "[m] fingerprint: X")];
    expect(findMarked(rows, "[m]", ["fingerprint: X", "stage: 1"])).toBeNull();
  });

  test("a different fingerprint or stage tag does not match", () => {
    const rows = [row("1", "[m] fingerprint: X\nstage: 2")];
    expect(findMarked(rows, "[m]", ["fingerprint: X", "stage: 1"])).toBeNull();
    expect(findMarked(rows, "[m]", ["fingerprint: Y", "stage: 2"])).toBeNull();
  });

  test("no comments -> null", () => {
    expect(findMarked([], "[m]", ["x"])).toBeNull();
  });
});

describe("RateCap", () => {
  test("allows up to `max` posts per key within the window, then blocks", () => {
    const cap = new RateCap(3, HOUR_MS);
    let now = 0;
    expect(cap.allow("K", now)).toBe(true);
    cap.record("K", now);
    expect(cap.allow("K", now)).toBe(true);
    cap.record("K", now);
    expect(cap.allow("K", now)).toBe(true);
    cap.record("K", now);
    expect(cap.allow("K", now)).toBe(false); // 4th within the window: blocked
  });

  test("expired posts age out of the window and free up budget again", () => {
    const cap = new RateCap(1, HOUR_MS);
    let now = 0;
    expect(cap.allow("K", now)).toBe(true);
    cap.record("K", now);
    expect(cap.allow("K", now)).toBe(false);
    now = HOUR_MS; // exactly at the edge — no longer "within" the window
    expect(cap.allow("K", now)).toBe(true);
  });

  test("keys are independent", () => {
    const cap = new RateCap(1, HOUR_MS);
    cap.record("A", 0);
    expect(cap.allow("A", 0)).toBe(false);
    expect(cap.allow("B", 0)).toBe(true);
  });

  test("allow() alone (without record()) never consumes budget", () => {
    const cap = new RateCap(1, HOUR_MS);
    expect(cap.allow("K", 0)).toBe(true);
    expect(cap.allow("K", 0)).toBe(true);
    expect(cap.allow("K", 0)).toBe(true);
  });
});
