import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, symlinkSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditLogger, fileAuditAppend, type AuditWriteEvent } from "../../src/web/audit-log.js";

const EVENT: Omit<AuditWriteEvent, "time"> = {
  route: "POST /api/rules/:id/enabled",
  action: "enabled=true",
  ids: ["ui-first-rule"],
  diffSummary: "enabled=true",
  origin: "http://127.0.0.1:7718",
  uid: 1000,
  outcome: "accepted",
};

describe("createAuditLogger", () => {
  test("accepted write: appends exactly one JSON line, parseable, with every field, and alerts immediately", async () => {
    const lines: string[] = [];
    let posted: string | undefined;
    const logger = createAuditLogger({ append: (l: string) => lines.push(l), postAlert: async (t: string) => { posted = t; }, host: "servyboi", log: () => {} });
    logger(EVENT);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(lines[0]!.trimEnd());
    expect(parsed).toMatchObject(EVENT);
    expect(typeof parsed.time).toBe("string");
    await Promise.resolve();
    expect(posted).toBeDefined();
    expect(posted).toContain("ACCEPTED");
  });

  test("a rejected event carries its reason", () => {
    const lines: string[] = [];
    const logger = createAuditLogger({ append: (l: string) => lines.push(l), host: "servyboi", log: () => {} });
    logger({ ...EVENT, outcome: "rejected", reason: "stale etag" });
    const parsed = JSON.parse(lines[0]!.trimEnd());
    expect(parsed.outcome).toBe("rejected");
    expect(parsed.reason).toBe("stale etag");
  });

  test("never throws when append itself throws — fails open, logs a WARNING", () => {
    const logged: string[] = [];
    const logger = createAuditLogger({ append: () => { throw new Error("disk full"); }, host: "servyboi", log: (l: string) => logged.push(l) });
    expect(() => logger(EVENT)).not.toThrow();
    expect(logged.some((l) => l.includes("WARNING") && l.includes("disk full"))).toBe(true);
  });

  test("no postAlert configured: logs once, never throws, never calls anything", () => {
    const lines: string[] = [];
    const logger = createAuditLogger({ append: (l: string) => lines.push(l), host: "servyboi", log: () => {} });
    expect(() => logger(EVENT)).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  test("a failing postAlert never throws back into the caller", async () => {
    const logged: string[] = [];
    const logger = createAuditLogger({ append: () => {}, postAlert: async () => { throw new Error("rocketchat unreachable"); }, host: "servyboi", log: (l: string) => logged.push(l) });
    expect(() => logger(EVENT)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(logged.some((l) => l.includes("WARNING") && l.includes("rocketchat unreachable"))).toBe(true);
  });

  test("diffSummary with an embedded newline is flattened to one JSON line", () => {
    const lines: string[] = [];
    const logger = createAuditLogger({ append: (l: string) => lines.push(l), host: "servyboi", log: () => {} });
    logger({ ...EVENT, diffSummary: "line one\nline two" });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.split("\n")).toHaveLength(2); // one content line + the trailing newline's own split artifact
  });

  test("B4 fix (2): a burst of REJECTED writes aggregates into ONE alert naming the count; every ACCEPTED write still alerts individually", async () => {
    const posted: string[] = [];
    const logger = createAuditLogger({
      append: () => {},
      postAlert: async (t: string) => { posted.push(t); },
      host: "servyboi",
      log: () => {},
      now: () => 0,
      rejectAggregateWindowMs: 20,
    });
    logger({ ...EVENT, outcome: "rejected", reason: "forged origin" });
    logger({ ...EVENT, outcome: "rejected", reason: "bad csrf" });
    logger({ ...EVENT, outcome: "rejected", reason: "bad csrf again" });
    logger({ ...EVENT, outcome: "accepted" }); // alerts immediately, independent of the pending rejection burst
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("ACCEPTED");
    await new Promise((r) => setTimeout(r, 40));
    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain("REJECTED x3");
    expect(posted[1]).toContain("bad csrf again"); // the LAST rejection's own detail
  });

  test("B4 fix (1): alert text neutralizes an @mention and defangs a link carried in a caller-controlled field", async () => {
    const posted: string[] = [];
    const logger = createAuditLogger({ append: () => {}, postAlert: async (t: string) => { posted.push(t); }, host: "servyboi", log: () => {} });
    logger({ ...EVENT, ids: ["@all see http://evil.example/steal"] });
    await Promise.resolve();
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toContain("@all");
    expect(posted[0]).not.toContain("http://evil.example");
  });
});

describe("fileAuditAppend (B4 fix (3): file/dir modes)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "butchr-audit-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("creates the parent directory at 0700 and the file at 0600", () => {
    const logDir = join(dir, "nested");
    const path = join(logDir, "audit.jsonl");
    const append = fileAuditAppend(path);
    append("line one\n");
    expect(statSync(logDir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("line one\n");
  });

  test("a pre-existing file at a looser mode is chmod'd to 0600 on the next append", () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "audit.jsonl");
    const { writeFileSync, chmodSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(path, "");
    chmodSync(path, 0o664);
    fileAuditAppend(path)("line\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("refuses to append through a symlinked path", () => {
    const real = join(dir, "real.jsonl");
    const link = join(dir, "link.jsonl");
    require("node:fs").writeFileSync(real, "");
    symlinkSync(real, link);
    expect(() => fileAuditAppend(link)("line\n")).toThrow(/symlink/);
  });

  test("appends accumulate across multiple calls", () => {
    const path = join(dir, "audit.jsonl");
    const append = fileAuditAppend(path);
    append("a\n");
    append("b\n");
    expect(readFileSync(path, "utf8")).toBe("a\nb\n");
  });
});
