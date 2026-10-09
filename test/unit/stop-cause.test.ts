import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  workspaceStopCause, persistIntentionalStop, clearStopCause,
  recordIntentionalStop, clearIntentionalStop, classifyStop,
} from "../../src/agents/stop-cause.js";
import { EXEMPT_LABEL } from "../../src/agents/parked.js";

describe("FACTORY-849/FACTORY-852: workspaceStopCause / persistIntentionalStop / clearStopCause — modelled on workspaceSessionId's own ENOENT discipline", () => {
  test("persistIntentionalStop writes what workspaceStopCause reads back", () => {
    const root = mkdtempSync(join(tmpdir(), "bw-stop-cause-"));
    try {
      persistIntentionalStop(root, "stand_down", 12345);
      expect(workspaceStopCause(root)).toEqual({ reason: "stand_down", at: 12345 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspaceStopCause is undefined for a workspace with no record at all — never throws", () => {
    const root = mkdtempSync(join(tmpdir(), "bw-stop-cause-missing-"));
    try {
      expect(workspaceStopCause(join(root, "does-not-exist"))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a later write REPLACES the earlier record outright (overwrite, not append) — one half of 'supersede'", () => {
    const root = mkdtempSync(join(tmpdir(), "bw-stop-cause-replace-"));
    try {
      persistIntentionalStop(root, "stand_down", 1);
      persistIntentionalStop(root, "shelve_worker", 2);
      expect(workspaceStopCause(root)).toEqual({ reason: "shelve_worker", at: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clearStopCause removes a persisted record — workspaceStopCause falls back to undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "bw-stop-cause-clear-"));
    try {
      persistIntentionalStop(root, "finish_worker", 1);
      expect(workspaceStopCause(root)).not.toBeUndefined();
      clearStopCause(root);
      expect(workspaceStopCause(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clearStopCause on a workspace with no record at all never throws (nothing to remove is not an error)", () => {
    const root = mkdtempSync(join(tmpdir(), "bw-stop-cause-clear-noop-"));
    try {
      expect(() => clearStopCause(root)).not.toThrow();
      expect(workspaceStopCause(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("FACTORY-849/FACTORY-852: recordIntentionalStop / clearIntentionalStop — fan-out across every rule-matched workspace, mirroring rewriteWorkspaceBriefSummary's own technique", () => {
  test("writes the record into EVERY rule workspace for the resource, leaves an unrelated resource's workspace untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "bw-record-fanout-"));
    try {
      const dirs = ["task", "review"].map((rule) => join(root, "jira-work", rule, "KAN-9"));
      for (const dir of dirs) mkdirSync(dir, { recursive: true });
      mkdirSync(join(root, "jira-work", "task", "KAN-10"), { recursive: true });

      recordIntentionalStop("KAN-9", "submit_to_boss", root);

      expect(workspaceStopCause(dirs[0]!)?.reason).toBe("submit_to_boss");
      expect(workspaceStopCause(dirs[1]!)?.reason).toBe("submit_to_boss");
      expect(workspaceStopCause(join(root, "jira-work", "task", "KAN-10"))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no on-disk workspace for the resource: a silent no-op, never throws", () => {
    const root = mkdtempSync(join(tmpdir(), "bw-record-fanout-none-"));
    try {
      expect(() => recordIntentionalStop("KAN-11", "finish_worker", root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clearIntentionalStop clears every rule workspace's record for the resource", () => {
    const root = mkdtempSync(join(tmpdir(), "bw-clear-fanout-"));
    try {
      const dirs = ["task", "review"].map((rule) => join(root, "jira-work", rule, "KAN-12"));
      for (const dir of dirs) mkdirSync(dir, { recursive: true });
      recordIntentionalStop("KAN-12", "shelve_worker", root);
      expect(workspaceStopCause(dirs[0]!)).not.toBeUndefined();

      clearIntentionalStop("KAN-12", root);

      expect(workspaceStopCause(dirs[0]!)).toBeUndefined();
      expect(workspaceStopCause(dirs[1]!)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("FACTORY-849/FACTORY-852: classifyStop — pure, total over (stopCause, ticketStatus, ticketLabels); unknown -> unintended", () => {
  const base = { stopCause: undefined, ticketStatus: "In Progress", ticketLabels: [] as readonly string[] };

  test("any recorded stop-cause record is intentional, regardless of its specific reason", () => {
    for (const reason of ["stand_down", "submit_to_boss", "finish_without_a_boss", "finish_worker", "shelve_worker"] as const) {
      expect(classifyStop({ ...base, stopCause: { reason, at: 1 } })).toBe("intentional");
    }
  });

  test("a Done ticket is intentional even with no recorded marker at all", () => {
    expect(classifyStop({ ...base, ticketStatus: "Done" })).toBe("intentional");
  });

  test("a ticket carrying the shelved-exemption label is intentional even with no recorded marker and a non-Done status", () => {
    expect(classifyStop({ ...base, ticketLabels: [EXEMPT_LABEL] })).toBe("intentional");
  });

  test("no marker, not Done, no shelved label: unintended — the pane-vanished case", () => {
    expect(classifyStop(base)).toBe("unintended");
  });

  test("no marker, a non-Done/non-shelved status and labels: unintended — the undeterminable case resolves toward unintended, per FACTORY-843", () => {
    expect(classifyStop({ stopCause: undefined, ticketStatus: "To Do", ticketLabels: ["some-other-label"] })).toBe("unintended");
  });

  test("a non-Done status with the shelved label still OR's to intentional (any one condition suffices)", () => {
    expect(classifyStop({ stopCause: undefined, ticketStatus: "In Progress", ticketLabels: [EXEMPT_LABEL, "other"] })).toBe("intentional");
  });
});
