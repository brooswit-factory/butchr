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
  test("accepted write: appends exactly one JSON line, parseable, with every field, and logs the same line", () => {
    const lines: string[] = [];
    const logged: string[] = [];
    const logger = createAuditLogger({ append: (l: string) => lines.push(l), log: (l: string) => logged.push(l) });
    logger(EVENT);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(lines[0]!.trimEnd());
    expect(parsed).toMatchObject(EVENT);
    expect(typeof parsed.time).toBe("string");
    expect(logged).toEqual([`[butchr:audit] ${lines[0]!.trimEnd()}`]);
  });

  test("a rejected event carries its reason", () => {
    const lines: string[] = [];
    const logger = createAuditLogger({ append: (l: string) => lines.push(l), log: () => {} });
    logger({ ...EVENT, outcome: "rejected", reason: "stale etag" });
    const parsed = JSON.parse(lines[0]!.trimEnd());
    expect(parsed.outcome).toBe("rejected");
    expect(parsed.reason).toBe("stale etag");
  });

  test("every event in a burst of rejections gets its own line — nothing is aggregated away", () => {
    const lines: string[] = [];
    const logger = createAuditLogger({ append: (l: string) => lines.push(l), log: () => {} });
    for (let i = 0; i < 5; i++) logger({ ...EVENT, outcome: "rejected", reason: `r${i}` });
    expect(lines.map((l) => JSON.parse(l).reason)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  test("a connection test (kind: \"test\") is recorded with its kind", () => {
    const lines: string[] = [];
    const logger = createAuditLogger({ append: (l: string) => lines.push(l), log: () => {} });
    logger({ ...EVENT, kind: "test", outcome: "rejected", reason: "401" });
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "test", outcome: "rejected", reason: "401" });
  });

  test("never throws when append itself throws — fails open, logs a WARNING", () => {
    const logged: string[] = [];
    const logger = createAuditLogger({ append: () => { throw new Error("disk full"); }, log: (l: string) => logged.push(l) });
    expect(() => logger(EVENT)).not.toThrow();
    expect(logged.some((l) => l.includes("WARNING") && l.includes("disk full"))).toBe(true);
  });

  test("diffSummary with an embedded newline is flattened to one JSON line", () => {
    const lines: string[] = [];
    const logger = createAuditLogger({ append: (l: string) => lines.push(l), log: () => {} });
    logger({ ...EVENT, diffSummary: "line one\nline two" });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.split("\n")).toHaveLength(2); // one content line + the trailing newline's own split artifact
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
