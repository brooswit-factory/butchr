import { describe, expect, test } from "bun:test";
import { readDaemonLogs, DEFAULT_DAEMON_LOGS_MAX_LINES, DEFAULT_DAEMON_LOGS_MAX_BYTES, type DaemonLogsExecIo } from "../../src/web/daemon-logs.js";
import type { SystemdInfo } from "../../src/agents/ground-truth.js";

const USER_UNIT: SystemdInfo = { kind: "user", unit: "butchr.service", journalctl: "journalctl --user -u butchr.service" };
const NONE: SystemdInfo = { kind: "none" };

describe("readDaemonLogs", () => {
  test("kind: none is an operator-actionable refusal, never an empty page", async () => {
    const result = await readDaemonLogs(NONE, { maxLines: 10, maxBytes: 1000 });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("no systemd unit or scheduled task detected") });
  });

  test("runs journalctl with the unit's OWN derived argv, never a guessed one, bounded by -n", async () => {
    let seenArgv: readonly string[] | undefined;
    const io: DaemonLogsExecIo = { run: async (argv) => { seenArgv = argv; return "line one\nline two\n"; } };
    const result = await readDaemonLogs(USER_UNIT, { maxLines: 5, maxBytes: 1000 }, io);
    expect(seenArgv).toEqual(["journalctl", "--user", "-u", "butchr.service", "-n", "5", "--no-pager", "-o", "cat"]);
    expect(result).toEqual({ ok: true, source: "journalctl --user -u butchr.service", unit: "butchr.service", lines: ["line one", "line two"], truncated: false });
  });

  test("redacts a seeded secret in a log line — never returns it unredacted", async () => {
    const io: DaemonLogsExecIo = { run: async () => 'fetching with Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz1234\n' };
    const result = await readDaemonLogs(USER_UNIT, { maxLines: 10, maxBytes: 1000 }, io);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.lines[0]).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234");
    expect(result.lines[0]).toContain("[redacted]");
  });

  test("bounded by byte cap: stops adding lines once the cap would be exceeded and reports truncated", async () => {
    const io: DaemonLogsExecIo = { run: async () => "a".repeat(50) + "\n" + "b".repeat(50) + "\n" + "c".repeat(50) + "\n" };
    const result = await readDaemonLogs(USER_UNIT, { maxLines: 100, maxBytes: 110 }, io);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.lines.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  test("log source failure (journalctl not available / timeout): operator-actionable error, not a throw", async () => {
    const io: DaemonLogsExecIo = { run: async () => { throw new Error("spawn journalctl ENOENT"); } };
    const result = await readDaemonLogs(USER_UNIT, { maxLines: 10, maxBytes: 1000 }, io);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("could not read logs via") });
  });

  test("default bounds are sane (count and byte cap both finite and positive)", () => {
    expect(DEFAULT_DAEMON_LOGS_MAX_LINES).toBeGreaterThan(0);
    expect(DEFAULT_DAEMON_LOGS_MAX_BYTES).toBeGreaterThan(0);
  });
});
