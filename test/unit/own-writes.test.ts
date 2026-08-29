import { describe, expect, test } from "bun:test";
import { createOwnWriteLedger, DAEMON_WRITER } from "../../src/jira-watch/own-writes.js";

describe("OwnWriteLedger", () => {
  test("an unknown key never suppresses", () => {
    const ledger = createOwnWriteLedger();
    expect(ledger.shouldSuppress("KAN-1", "t1", "KAN-1", 0)).toBe(false);
  });

  test("exact `updated` match suppresses for the recorded writer", () => {
    const ledger = createOwnWriteLedger();
    ledger.record("KAN-1", "t2", "KAN-1", 0);
    expect(ledger.shouldSuppress("KAN-1", "t2", "KAN-1", 1)).toBe(true);
  });

  test("a newer `updated` (no exact match) does not suppress", () => {
    const ledger = createOwnWriteLedger();
    ledger.record("KAN-1", "t2", "KAN-1", 0);
    expect(ledger.shouldSuppress("KAN-1", "t3", "KAN-1", 1)).toBe(false);
  });

  test("an agent write suppresses only the writer's own watcher, not others", () => {
    const ledger = createOwnWriteLedger();
    ledger.record("KAN-1", "t2", "KAN-1", 0);
    expect(ledger.shouldSuppress("KAN-1", "t2", "KAN-1", 1)).toBe(true);   // the writer itself
    expect(ledger.shouldSuppress("KAN-1", "t2", "BOSS", 1)).toBe(false);  // a watcher: still delivered
  });

  test("a daemon write suppresses every watcher, including the ticket's own agent", () => {
    const ledger = createOwnWriteLedger();
    ledger.record("KAN-1", "t2", DAEMON_WRITER, 0);
    expect(ledger.shouldSuppress("KAN-1", "t2", "KAN-1", 1)).toBe(true);
    expect(ledger.shouldSuppress("KAN-1", "t2", "BOSS", 1)).toBe(true);
  });

  test("expiry by TTL: an entry older than the TTL no longer suppresses", () => {
    const ledger = createOwnWriteLedger(100);
    ledger.record("KAN-1", "t2", "KAN-1", 0);
    expect(ledger.shouldSuppress("KAN-1", "t2", "KAN-1", 50)).toBe(true);   // within TTL
    expect(ledger.shouldSuppress("KAN-1", "t2", "KAN-1", 200)).toBe(false); // past TTL
  });

  test("a superseded entry (older than an observed `updated`) is dropped and never matches again", () => {
    const ledger = createOwnWriteLedger();
    ledger.record("KAN-1", "t2", "KAN-1", 0);
    // A real change moves `updated` to t3 — t2 can never be observed again.
    expect(ledger.shouldSuppress("KAN-1", "t3", "KAN-1", 1)).toBe(false);
    // The stale t2 entry must be gone, not merely unmatched this once.
    expect(ledger.shouldSuppress("KAN-1", "t2", "KAN-1", 2)).toBe(false);
  });

  test("several entries can be live for one key (two writes in a row); an entry is not consumed on first match", () => {
    const ledger = createOwnWriteLedger();
    ledger.record("KAN-1", "t2", "KAN-1", 0);
    ledger.record("KAN-1", "t3", "KAN-1", 0);
    // A single poll reports one `updated` value (here "t3", the ticket's
    // latest) to every watcher checking that poll — the entry matching it
    // must not be consumed by the first watcher's check.
    expect(ledger.shouldSuppress("KAN-1", "t3", "KAN-1", 1)).toBe(true);
    expect(ledger.shouldSuppress("KAN-1", "t3", "BOSS", 1)).toBe(false); // a different watcher: still not suppressed (not the writer)
    expect(ledger.shouldSuppress("KAN-1", "t3", "KAN-1", 1)).toBe(true); // not consumed by either prior check
  });

  test("prune drops entries past the TTL regardless of whether they were consulted", () => {
    const ledger = createOwnWriteLedger(100);
    ledger.record("KAN-1", "t2", "KAN-1", 0);
    ledger.prune(200);
    expect(ledger.shouldSuppress("KAN-1", "t2", "KAN-1", 200)).toBe(false);
  });
});
