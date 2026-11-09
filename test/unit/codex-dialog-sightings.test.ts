import { describe, expect, test } from "bun:test";
import { CODEX_UNRECOGNISED_MARKER, createCodexDialogSightingsTracker } from "../../src/agents/codex-dialog-sightings.js";

function fakeDeps() {
  const lines: string[] = [];
  let t = 0;
  return { deps: { log: (line: string) => lines.push(line), now: () => t }, lines, advance: (ms: number) => { t += ms; } };
}

describe("createCodexDialogSightingsTracker (FACTORY-425/FACTORY-419)", () => {
  test("a brand-new fingerprint is counted once and logs a journal line", () => {
    const { deps, lines } = fakeDeps();
    const tracker = createCodexDialogSightingsTracker(deps);

    tracker.onScan([{ paneId: "p1", fingerprint: "fpA", excerpt: "some unrecognised screen" }]);

    expect(tracker.sightings()).toEqual([
      { fingerprint: "fpA", count: 1, excerpt: "some unrecognised screen", firstSeen: new Date(0).toISOString(), lastSeen: new Date(0).toISOString() },
    ]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toStartWith(CODEX_UNRECOGNISED_MARKER);
  });

  test("repeated polls of the SAME pane showing the SAME fingerprint count as ONE episode, not one per poll", () => {
    const { deps, lines } = fakeDeps();
    const tracker = createCodexDialogSightingsTracker(deps);

    tracker.onScan([{ paneId: "p1", fingerprint: "fpA", excerpt: "e1" }]);
    tracker.onScan([{ paneId: "p1", fingerprint: "fpA", excerpt: "e1" }]);
    tracker.onScan([{ paneId: "p1", fingerprint: "fpA", excerpt: "e1" }]);

    expect(tracker.sightings()).toEqual([expect.objectContaining({ fingerprint: "fpA", count: 1 })]);
    expect(lines.length).toBe(1); // only the first poll logged anything
  });

  test("the SAME fingerprint sighted on two DIFFERENT panes aggregates into one fingerprint's count", () => {
    const { deps } = fakeDeps();
    const tracker = createCodexDialogSightingsTracker(deps);

    tracker.onScan([
      { paneId: "p1", fingerprint: "fpA", excerpt: "e1" },
      { paneId: "p2", fingerprint: "fpA", excerpt: "e1-different-session" },
    ]);

    const sightings = tracker.sightings();
    expect(sightings.length).toBe(1);
    const [fpA] = sightings;
    expect(fpA?.fingerprint).toBe("fpA");
    expect(fpA?.count).toBe(2);
    // representative excerpt is whichever was seen FIRST, never overwritten by a later sighting
    expect(fpA?.excerpt).toBe("e1");
  });

  test("two DIFFERING fingerprints do NOT aggregate together", () => {
    const { deps } = fakeDeps();
    const tracker = createCodexDialogSightingsTracker(deps);

    tracker.onScan([
      { paneId: "p1", fingerprint: "fpA", excerpt: "e1" },
      { paneId: "p2", fingerprint: "fpB", excerpt: "e2" },
    ]);

    const sightings = tracker.sightings();
    expect(sightings.length).toBe(2);
    expect(sightings.find((s) => s.fingerprint === "fpA")).toEqual(expect.objectContaining({ count: 1 }));
    expect(sightings.find((s) => s.fingerprint === "fpB")).toEqual(expect.objectContaining({ count: 1 }));
  });

  test("a pane's fingerprint CHANGING mid-episode counts as a new sighting for the new fingerprint (and does not retroactively touch the old one's count)", () => {
    const { deps } = fakeDeps();
    const tracker = createCodexDialogSightingsTracker(deps);

    tracker.onScan([{ paneId: "p1", fingerprint: "fpA", excerpt: "e1" }]);
    tracker.onScan([{ paneId: "p1", fingerprint: "fpB", excerpt: "e2" }]);

    const sightings = tracker.sightings();
    expect(sightings.find((s) => s.fingerprint === "fpA")?.count).toBe(1);
    expect(sightings.find((s) => s.fingerprint === "fpB")?.count).toBe(1);
  });

  test("a pane's dialog clearing (dropping out of the scan) then the SAME fingerprint reappearing later is a NEW episode, not folded into the old one", () => {
    const { deps } = fakeDeps();
    const tracker = createCodexDialogSightingsTracker(deps);

    tracker.onScan([{ paneId: "p1", fingerprint: "fpA", excerpt: "e1" }]);
    tracker.onScan([]); // pane no longer showing an unrecognised dialog
    tracker.onScan([{ paneId: "p1", fingerprint: "fpA", excerpt: "e1" }]); // same shape, later episode

    expect(tracker.sightings()).toEqual([expect.objectContaining({ fingerprint: "fpA", count: 2 })]);
  });

  // FACTORY-1044: the live incident this ticket is about — a reviewer pane
  // (MINECRAFT-494) sat stuck ~13h on two GitHub tool-consent dialogs while
  // `/health` kept reporting "codex: 0 answered, 0 skipped, 2 unrecognised,
  // 0 failed". This module's own counting/escalation surface (FACTORY-425)
  // already turns repeated sightings of exactly this shape into a
  // persistent, non-zero `/health` field — this test pins that against the
  // real incident excerpt text rather than only an opaque placeholder.
  test("the incident's stuck-reviewer dialog, sighted repeatedly, accumulates a non-zero /health-surfaced count instead of looking healthy forever", () => {
    const { deps } = fakeDeps();
    const tracker = createCodexDialogSightingsTracker(deps);
    const excerpt = 'Allow GitHub to submit a pull request review?\n\naction: REQUEST_CHANGES\npull request: #4\ncommit: 36160c (obsolete head)';

    // The daemon's own poll loop calls onScan every 5s (src/daemon/index.ts);
    // simulate several polls while the pane sits stuck on the SAME dialog.
    for (let i = 0; i < 5; i++) tracker.onScan([{ paneId: "reviewer-pane", fingerprint: "fp-stale-pr-review", excerpt }]);

    const sightings = tracker.sightings();
    expect(sightings).toHaveLength(1);
    // Exactly the shape health.ts exposes as `codexUnrecognisedDialogSightings`.
    expect(sightings[0]).toMatchObject({ fingerprint: "fp-stale-pr-review", count: 1, excerpt });
  });

  test("lastSeen advances on a later episode but firstSeen and the representative excerpt never change", () => {
    const { deps, advance } = fakeDeps();
    const tracker = createCodexDialogSightingsTracker(deps);

    tracker.onScan([{ paneId: "p1", fingerprint: "fpA", excerpt: "original excerpt" }]);
    advance(60_000);
    tracker.onScan([]);
    tracker.onScan([{ paneId: "p1", fingerprint: "fpA", excerpt: "different-looking excerpt, same shape" }]);

    const s = tracker.sightings().find((x) => x.fingerprint === "fpA")!;
    expect(s.count).toBe(2);
    expect(s.excerpt).toBe("original excerpt");
    expect(s.firstSeen).toBe(new Date(0).toISOString());
    expect(s.lastSeen).toBe(new Date(60_000).toISOString());
  });
});
