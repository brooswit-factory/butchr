import { describe, expect, test } from "bun:test";
import { recordAuditEvent, type AuditWriteEvent } from "../../src/web/audit-log.js";

const EVENT: Omit<AuditWriteEvent, "diffSummary"> & { diffSummary: string } = {
  time: "2026-10-05T18:00:00.000Z",
  route: "POST /api/rules/:id/enabled",
  action: "enabled=true",
  ids: ["ui-first-rule"],
  diffSummary: "enabled=true",
  origin: "http://127.0.0.1:7718",
  uid: 1000,
  outcome: "accepted",
};

describe("recordAuditEvent", () => {
  test("appends exactly one JSON line, parseable, with every field", () => {
    const lines: string[] = [];
    recordAuditEvent(EVENT, { append: (l) => lines.push(l), host: "servyboi", log: () => {} });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(lines[0]!.trimEnd());
    expect(parsed).toEqual(EVENT);
  });

  test("a rejected event carries its reason", () => {
    const lines: string[] = [];
    recordAuditEvent({ ...EVENT, outcome: "rejected", reason: "stale etag" }, { append: (l) => lines.push(l), host: "servyboi", log: () => {} });
    const parsed = JSON.parse(lines[0]!.trimEnd());
    expect(parsed.outcome).toBe("rejected");
    expect(parsed.reason).toBe("stale etag");
  });

  test("never throws when append itself throws — fails open, logs a WARNING", () => {
    const logged: string[] = [];
    expect(() => recordAuditEvent(EVENT, { append: () => { throw new Error("disk full"); }, host: "servyboi", log: (l) => logged.push(l) })).not.toThrow();
    expect(logged.some((l) => l.includes("WARNING") && l.includes("disk full"))).toBe(true);
  });

  test("no postAlert configured: logs once, never throws, never calls anything", () => {
    const lines: string[] = [];
    expect(() => recordAuditEvent(EVENT, { append: (l) => lines.push(l), host: "servyboi", log: () => {} })).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  test("postAlert configured: called fire-and-forget with a line naming the outcome, route, action, ids", async () => {
    let posted: string | undefined;
    recordAuditEvent(EVENT, {
      append: () => {},
      postAlert: async (text) => { posted = text; },
      host: "servyboi",
      log: () => {},
    });
    await Promise.resolve(); // let the fire-and-forget microtask run
    expect(posted).toBeDefined();
    expect(posted).toContain("ACCEPTED");
    expect(posted).toContain("servyboi");
    expect(posted).toContain("POST /api/rules/:id/enabled");
    expect(posted).toContain("ui-first-rule");
  });

  test("a failing postAlert never throws back into the caller", async () => {
    const logged: string[] = [];
    expect(() => recordAuditEvent(EVENT, {
      append: () => {},
      postAlert: async () => { throw new Error("rocketchat unreachable"); },
      host: "servyboi",
      log: (l) => logged.push(l),
    })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(logged.some((l) => l.includes("WARNING") && l.includes("rocketchat unreachable"))).toBe(true);
  });

  test("diffSummary with an embedded newline is flattened to one JSON line", () => {
    const lines: string[] = [];
    recordAuditEvent({ ...EVENT, diffSummary: "line one\nline two" }, { append: (l) => lines.push(l), host: "servyboi", log: () => {} });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.split("\n")).toHaveLength(2); // one content line + the trailing newline's own split artifact
  });
});
