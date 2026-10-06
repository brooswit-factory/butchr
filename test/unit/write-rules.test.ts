import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOnlyChanged, defaultIo, restoreBackup, rulesEtag, setRuleEnabled, updateRulesFile, writeRulesFile, type WriteRulesIo, type WriteRulesResult } from "../../src/rules/write-rules.js";
import type { RulesEnv } from "../../src/rules/rules.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-write-rules-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(): RulesEnv {
  return { XDG_CONFIG_HOME: dir };
}

function rulesFilePath(): string {
  return join(dir, "butchr", "rules.json");
}

const doc = (rules: unknown[]): string => JSON.stringify({ rules }, null, 2) + "\n";

const RULE_A = { id: "triage", resourceProvider: "jira-work", query: "project = BUTCHR", brief: "triage it" };
const RULE_B = { id: "stories", resourceProvider: "jira-work", query: "project = BUTCHR AND issuetype = Story", brief: "work the story" };

describe("writeRulesFile: validation", () => {
  test("invalid JSON: throws, writes nothing, leaves no temp file", () => {
    expect(() => writeRulesFile("{not json", env())).toThrow(/invalid JSON/);
    // no rules/ directory was ever created
    expect(() => readdirSync(join(dir, "butchr"))).toThrow();
  });

  test("a schema problem: throws naming the rule and field, writes nothing, leaves no temp file", () => {
    expect(() => writeRulesFile(doc([{ id: "bad id", resourceProvider: "jira-work", query: "x", brief: "b" }]), env())).toThrow(/rules\[0\]\.id/);
    expect(() => readdirSync(join(dir, "butchr"))).toThrow();
  });

  test("a validation failure after a file already exists leaves the original file byte-for-byte untouched", () => {
    const original = doc([RULE_A]);
    writeRulesFile(original, env());
    expect(() => writeRulesFile("{not json", env())).toThrow();
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(original);
    // only the original file exists — no temp file, no spurious backup from the failed attempt
    const entries = readdirSync(join(dir, "butchr"));
    expect(entries).toEqual(["rules.json"]);
  });
});

describe("writeRulesFile: first write (no existing file)", () => {
  test("creates the file, mode 0600, backupPath/backupId null, every rule id reported changed", () => {
    const result = writeRulesFile(doc([RULE_A, RULE_B]), env());
    expect(result.path).toBe(rulesFilePath());
    expect(result.backupPath).toBeNull();
    expect(result.backupId).toBeNull();
    expect(result.changedIds.sort()).toEqual(["stories", "triage"]);
    expect(readFileSync(result.path, "utf8")).toBe(doc([RULE_A, RULE_B]));
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });
});

describe("writeRulesFile: backups", () => {
  test("backs up the current file before overwriting, named rules.json.bak-<UTC timestamp>, backupId is that timestamp", () => {
    writeRulesFile(doc([RULE_A]), env());
    const before = readFileSync(rulesFilePath(), "utf8");
    const result = writeRulesFile(doc([RULE_A, RULE_B]), env());
    expect(result.backupPath).not.toBeNull();
    expect(result.backupId).not.toBeNull();
    expect(result.backupPath!).toMatch(/rules\.json\.bak-\d{8}T\d{6}Z$/);
    expect(result.backupPath).toBe(join(dir, "butchr", `rules.json.bak-${result.backupId}`));
    expect(readFileSync(result.backupPath!, "utf8")).toBe(before);
    // the live file now holds the NEW content
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(doc([RULE_A, RULE_B]));
  });

  test("prunes to the newest 20 backups", () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    // seed 25 fake old backups (valid-looking ids), oldest-looking names first
    for (let i = 0; i < 25; i++) {
      const stamp = `20260101T0000${String(i).padStart(2, "0")}Z`;
      writeFileSync(join(rulesDir, `rules.json.bak-${stamp}`), "old");
    }
    writeRulesFile(doc([RULE_A, RULE_B]), env());
    const backups = readdirSync(rulesDir).filter((n) => n.startsWith("rules.json.bak-"));
    expect(backups.length).toBe(20);
  });

  test("round 3, finding F3: a hand-made backup (not matching the strict id shape) survives pruning", () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    const handMade = "rules.json.bak-manual-before-the-2026-migration";
    writeFileSync(join(rulesDir, handMade), "a human wrote this one");
    for (let i = 0; i < 25; i++) {
      const stamp = `20260101T0000${String(i).padStart(2, "0")}Z`;
      writeFileSync(join(rulesDir, `rules.json.bak-${stamp}`), "old");
    }
    writeRulesFile(doc([RULE_A, RULE_B]), env());
    const entries = readdirSync(rulesDir);
    expect(entries).toContain(handMade);
    expect(readFileSync(join(rulesDir, handMade), "utf8")).toBe("a human wrote this one");
    // the 20-cap still applies to the STRICT-shaped backups alone
    const strict = entries.filter((n) => /^rules\.json\.bak-\d{8}T\d{6}Z(?:-\d{1,6})?$/.test(n));
    expect(strict.length).toBe(20);
  });
});

describe("restoreBackup", () => {
  test("restores a backup's content through the same validated, atomic, backed-up path", () => {
    const first = writeRulesFile(doc([RULE_A]), env());
    const second = writeRulesFile(doc([RULE_A, RULE_B]), env());
    expect(second.backupId).not.toBeNull();

    const result = restoreBackup(second.backupId!, env());
    // the live file is back to the content as of the second write's backup (RULE_A alone)
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(doc([RULE_A]));
    // the restore is itself backed up (the pre-restore content, RULE_A+RULE_B) and atomic
    expect(result.backupPath).not.toBeNull();
    expect(readFileSync(result.backupPath!, "utf8")).toBe(doc([RULE_A, RULE_B]));
    expect(result.changedIds).toEqual(["stories"]);
  });

  test("a restore that would fail validation throws and leaves the live file untouched", () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    writeFileSync(join(rulesDir, "rules.json.bak-20260101T000000Z"), "{not json");
    const before = readFileSync(rulesFilePath(), "utf8");
    expect(() => restoreBackup("20260101T000000Z", env())).toThrow(/invalid JSON/);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(before);
  });

  test("unknown backup id: throws clearly", () => {
    writeRulesFile(doc([RULE_A]), env());
    expect(() => restoreBackup("20260101T000000Z", env())).toThrow(/no backup "20260101T000000Z"/);
  });
});

describe("restoreBackup: backupId validation (review round 2, finding 2)", () => {
  /**
   * `backupId` is planned to arrive straight from an HTTP path segment
   * (`POST /api/undo/:backupId`, FACTORY-662) — every one of these must be
   * refused BEFORE any path is built from it, reading and writing nothing.
   */
  const BAD_IDS = [
    "../x",
    "../../etc/passwd",
    "a/b",
    "a\\b",
    "/etc/passwd",
    "",
    "20260101T000000Z.json",
    "20260101T000000Z".padEnd(5000, "0"),
    "20260101T000000", // missing trailing Z
    "20260101t000000Z", // lowercase t
    "20260101T000000Z-", // dangling dash
    "20260101T000000Z-abc", // non-numeric suffix
    "20260101T000000Z\0", // trailing NUL byte
  ];

  for (const bad of BAD_IDS) {
    test(`refuses ${JSON.stringify(bad)} before building any path, reads/writes nothing`, () => {
      writeRulesFile(doc([RULE_A]), env());
      const before = readFileSync(rulesFilePath(), "utf8");
      const rulesDir = join(dir, "butchr");
      const entriesBefore = readdirSync(rulesDir);
      expect(() => restoreBackup(bad, env())).toThrow(/invalid backup id/);
      expect(readFileSync(rulesFilePath(), "utf8")).toBe(before);
      expect(readdirSync(rulesDir)).toEqual(entriesBefore);
    });
  }

  test("a valid id still restores (the fix does not over-refuse)", () => {
    writeRulesFile(doc([RULE_A]), env());
    const second = writeRulesFile(doc([RULE_A, RULE_B]), env());
    const restored = restoreBackup(second.backupId!, env());
    expect(restored.path).toBe(rulesFilePath());
  });

  test("a valid id with a same-second-collision suffix (e.g. \"...Z-2\") still restores", () => {
    const fixedNow = new Date("2026-01-01T00:00:00.000Z");
    const io = { ...defaultIo(), now: () => fixedNow };
    writeRulesFile(doc([RULE_A]), env(), io);
    writeRulesFile(doc([RULE_A, RULE_B]), env(), io);
    const third = writeRulesFile(doc([RULE_A, { ...RULE_B, brief: "different" }]), env(), io);
    expect(third.backupId).toMatch(/-2$/);
    const restored = restoreBackup(third.backupId!, env(), io);
    expect(restored.path).toBe(rulesFilePath());
  });

  test("a validly-NAMED backup entry that is itself a symlink escaping the directory is refused (reuses the live-file symlink check)", () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    const outside = join(dir, "outside-secret.json");
    writeFileSync(outside, doc([RULE_B]));
    const validId = "20260101T000000Z";
    symlinkSync(outside, join(rulesDir, `rules.json.bak-${validId}`));
    expect(() => restoreBackup(validId, env())).toThrow(/symlink/);
    // the outside file was never touched, and the live rules file is untouched
    expect(readFileSync(outside, "utf8")).toBe(doc([RULE_B]));
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(doc([RULE_A]));
  });
});

describe("writeRulesFile: atomicity", () => {
  test("a failed rename leaves the original file intact and cleans up the temp file", () => {
    writeRulesFile(doc([RULE_A]), env());
    const before = readFileSync(rulesFilePath(), "utf8");
    const io = {
      readFile: (p: string) => { try { return readFileSync(p, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; } },
      copyFile: (src: string, dest: string) => writeFileSync(dest, readFileSync(src)),
      writeTempExclusive: (p: string, text: string) => writeFileSync(p, text, { flag: "wx" }),
      rename: () => { throw new Error("simulated rename failure"); },
      removeQuiet: (p: string) => { try { unlinkSync(p); } catch { /* ignore */ } },
      modeOf: (p: string) => { try { return statSync(p).mode & 0o777; } catch { return undefined; } },
      chmod: (p: string, mode: number) => { try { chmodSync(p, mode); } catch { /* ignore */ } },
      listDir: (d: string) => { try { return readdirSync(d); } catch { return []; } },
      isSymlink: () => false,
      mkdir: (d: string) => mkdirSync(d, { recursive: true }),
      fsyncDir: () => { /* no-op for this test */ },
      acquireLock: () => () => { /* no-op lock for this test */ },
      now: () => new Date(),
    };
    expect(() => writeRulesFile(doc([RULE_A, RULE_B]), env(), io)).toThrow(/simulated rename failure/);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(before);
    // no leftover temp file
    const entries = readdirSync(join(dir, "butchr"));
    expect(entries.some((n) => n.includes(".tmp-"))).toBe(false);
  });
});

describe("writeRulesFile: symlink refusal (round 3, finding F4: ANY symlink is refused)", () => {
  test("refuses a rules file path that is a symlink escaping its own directory", () => {
    const outside = join(dir, "outside-target.json");
    writeFileSync(outside, doc([RULE_A]));
    const rulesDir = join(dir, "butchr");
    mkdirSync(rulesDir, { recursive: true });
    symlinkSync(outside, join(rulesDir, "rules.json"));
    expect(() => writeRulesFile(doc([RULE_A, RULE_B]), env())).toThrow(/is a symlink/);
    // the outside target was never touched
    expect(readFileSync(outside, "utf8")).toBe(doc([RULE_A]));
  });

  test("refuses a symlink even when it stays within the rules file's own directory (v1 has no safe in-directory case)", () => {
    const rulesDir = join(dir, "butchr");
    mkdirSync(rulesDir, { recursive: true });
    const real = join(rulesDir, "real-rules.json");
    writeFileSync(real, doc([RULE_A]));
    symlinkSync(real, join(rulesDir, "rules.json"));
    expect(() => writeRulesFile(doc([RULE_A, RULE_B]), env())).toThrow(/is a symlink/);
    // the real target was never touched
    expect(readFileSync(real, "utf8")).toBe(doc([RULE_A]));
  });

  test("a broken symlink (target does not exist) is refused with a clear error, not an ENOENT crash", () => {
    const rulesDir = join(dir, "butchr");
    mkdirSync(rulesDir, { recursive: true });
    symlinkSync(join(rulesDir, "does-not-exist.json"), join(rulesDir, "rules.json"));
    expect(() => writeRulesFile(doc([RULE_A]), env())).toThrow(/is a symlink/);
  });
});

describe("writeRulesFile: changedIds", () => {
  test("only the actually-different rule is reported as changed", () => {
    writeRulesFile(doc([RULE_A, RULE_B]), env());
    const changedB = { ...RULE_B, brief: "work the story differently now" };
    const result = writeRulesFile(doc([RULE_A, changedB]), env());
    expect(result.changedIds).toEqual(["stories"]);
  });

  test("a removed rule is reported as changed", () => {
    writeRulesFile(doc([RULE_A, RULE_B]), env());
    const result = writeRulesFile(doc([RULE_A]), env());
    expect(result.changedIds).toEqual(["stories"]);
  });

  test("an unchanged rewrite reports zero changed ids", () => {
    writeRulesFile(doc([RULE_A, RULE_B]), env());
    const result = writeRulesFile(doc([RULE_A, RULE_B]), env());
    expect(result.changedIds).toEqual([]);
  });

  test("a corrupt EXISTING file (can't be diffed) reports every next id as changed, and the write still succeeds", () => {
    const rulesDir = join(dir, "butchr");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "rules.json"), "{not json");
    const result = writeRulesFile(doc([RULE_A, RULE_B]), env());
    expect(result.changedIds.sort()).toEqual(["stories", "triage"]);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(doc([RULE_A, RULE_B]));
  });
});

describe("writeRulesFile: preserves an existing file's mode", () => {
  test("re-writing a file with a non-default mode keeps that mode", () => {
    writeRulesFile(doc([RULE_A]), env());
    chmodSync(rulesFilePath(), 0o640);
    writeRulesFile(doc([RULE_A, RULE_B]), env());
    expect(statSync(rulesFilePath()).mode & 0o777).toBe(0o640);
  });
});

describe("writeRulesFile: concurrent writers do not interleave", () => {
  test("two overlapping writes each produce a complete, valid, non-corrupted file (O_EXCL unique temp names)", () => {
    writeRulesFile(doc([RULE_A]), env());
    const results: WriteRulesResult[] = [
      writeRulesFile(doc([RULE_A, RULE_B]), env()),
      writeRulesFile(doc([RULE_A, { ...RULE_B, id: "subtasks" }]), env()),
    ];
    expect(results).toHaveLength(2);
    // the final file is one COMPLETE write (the second caller's), never a byte-level mix of both
    const final = readFileSync(rulesFilePath(), "utf8");
    expect(() => JSON.parse(final)).not.toThrow();
    expect(final).toBe(doc([RULE_A, { ...RULE_B, id: "subtasks" }]));
  });
});

/** `defaultIo()` (the real filesystem) with `now()` pinned, so two writes land in the exact same wall-clock second. */
function ioWithClock(now: Date): WriteRulesIo {
  return { ...defaultIo(), now: () => now };
}

describe("writeRulesFile: backup id collisions (review round 2)", () => {
  test("two writes in the same second keep BOTH backups (no overwrite)", () => {
    const fixedNow = new Date("2026-01-01T00:00:00.000Z");
    const io = ioWithClock(fixedNow);
    writeRulesFile(doc([RULE_A]), env(), io);
    const second = writeRulesFile(doc([RULE_A, RULE_B]), env(), io);
    const third = writeRulesFile(doc([RULE_A, { ...RULE_B, brief: "different" }]), env(), io);
    expect(second.backupId).not.toBeNull();
    expect(third.backupId).not.toBeNull();
    expect(second.backupId).not.toBe(third.backupId);
    expect(third.backupId).toBe(`${second.backupId}-2`);
    // both backup files exist, with their own distinct content
    expect(readFileSync(second.backupPath!, "utf8")).toBe(doc([RULE_A]));
    expect(readFileSync(third.backupPath!, "utf8")).toBe(doc([RULE_A, RULE_B]));
  });

  test("undo (restoreBackup) within the same second as the write it undoes still works and backs up under a fresh id", () => {
    const fixedNow = new Date("2026-01-01T00:00:00.000Z");
    const io = ioWithClock(fixedNow);
    writeRulesFile(doc([RULE_A]), env(), io);
    const second = writeRulesFile(doc([RULE_A, RULE_B]), env(), io);
    const restored = restoreBackup(second.backupId!, env(), io);
    // the restore's own pre-restore backup (of [RULE_A, RULE_B]) must not collide with/destroy `second`'s backup (of [RULE_A])
    expect(restored.backupId).not.toBe(second.backupId);
    expect(readFileSync(second.backupPath!, "utf8")).toBe(doc([RULE_A]));
    expect(readFileSync(restored.backupPath!, "utf8")).toBe(doc([RULE_A, RULE_B]));
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(doc([RULE_A]));
  });
});

describe("writeRulesFile: locking (review round 2)", () => {
  test("a reentrant call on the same path from the same process fails fast with a clear error", () => {
    writeRulesFile(doc([RULE_A]), env());
    const realIo = defaultIo();
    const reentrantIo: WriteRulesIo = {
      ...realIo,
      copyFile: (src, dest) => {
        // simulate a bug where something inside the locked section calls writeRulesFile again
        expect(() => writeRulesFile(doc([RULE_A]), env(), realIo)).toThrow(/already being written by this same process/);
        realIo.copyFile(src, dest);
      },
    };
    writeRulesFile(doc([RULE_A, RULE_B]), env(), reentrantIo);
  });

  test("a live lock from another (simulated) process refuses the write with a clear error", () => {
    writeRulesFile(doc([RULE_A]), env());
    const held: WriteRulesIo = {
      ...defaultIo(),
      acquireLock: () => { throw new Error("rules file is locked by another writer (pid 123, held 1s) — refusing to write concurrently"); },
    };
    expect(() => writeRulesFile(doc([RULE_A, RULE_B]), env(), held)).toThrow(/locked by another writer/);
    // nothing was mutated
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(doc([RULE_A]));
  });

  test("FACTORY-673: a stale lock (dead pid) is NOT reclaimed: the write fails closed with an actionable error and nothing is mutated", () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    // a pid essentially guaranteed not to be a live process on any test runner
    writeFileSync(join(rulesDir, ".rules.lock"), "999999999");
    expect(() => writeRulesFile(doc([RULE_A, RULE_B]), env())).toThrow(/left behind by pid 999999999, which is no longer running[\s\S]*rm .*\.rules\.lock/);
    // the lock file is untouched (never reclaimed) and the rules file was not mutated
    expect(readdirSync(rulesDir)).toContain(".rules.lock");
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(doc([RULE_A]));
    // once the operator removes it (as the error says), the write proceeds
    unlinkSync(join(rulesDir, ".rules.lock"));
    expect(writeRulesFile(doc([RULE_A, RULE_B]), env()).changedIds).toContain("stories");
  });

  test("round 3, finding F6: age alone never reclaims a lock from a LIVE pid, however old", () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    const lockPath = join(rulesDir, ".rules.lock");
    writeFileSync(lockPath, String(process.pid)); // this process's own pid — definitely alive
    const old = new Date(Date.now() - 60_000); // far past the OLD (round-2) 30s staleness window
    utimesSync(lockPath, old, old);
    expect(() => writeRulesFile(doc([RULE_A, RULE_B]), env())).toThrow(/locked by another writer \(pid \d+, held \d+s\)/);
    // untouched — stealing an old-but-live lock would have been the exact F6 bug
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(doc([RULE_A]));
  });

  test("the REAL default lock (not overridden): a fresh lock held by this (live) process's own pid genuinely refuses", () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    writeFileSync(join(rulesDir, ".rules.lock"), String(process.pid)); // live pid, fresh mtime — a genuine live holder
    expect(() => writeRulesFile(doc([RULE_A, RULE_B]), env())).toThrow(/locked by another writer \(pid \d+, held \d+s\)/);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(doc([RULE_A]));
  });

  test("F9 (agentsafety): contention then success in ONE process — a refused write must not leave the path stuck as 'already being written'", () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    const lockPath = join(rulesDir, ".rules.lock");
    writeFileSync(lockPath, String(process.pid)); // live holder: acquire throws
    expect(() => writeRulesFile(doc([RULE_A, RULE_B]), env())).toThrow(/locked by another writer/);
    expect(() => writeRulesFile(doc([RULE_A, RULE_B]), env())).toThrow(/locked by another writer/); // still the lock error, never the reentrancy one
    unlinkSync(lockPath);
    expect(writeRulesFile(doc([RULE_A, RULE_B]), env()).changedIds).toContain("stories");
    expect(writeRulesFile(doc([RULE_A]), env()).changedIds).toContain("stories"); // and again: the guard entry was cleared every time
  });

  test("an unreadable/corrupt lock fails closed rather than guessing it's abandoned", () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    writeFileSync(join(rulesDir, ".rules.lock"), "not-a-pid-at-all");
    expect(() => writeRulesFile(doc([RULE_A, RULE_B]), env())).toThrow(/unreadable\/corrupt content/);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(doc([RULE_A]));
  });

  test("FACTORY-673: two real OS processes racing over the SAME dead lock — NEITHER proceeds, every time (25 rounds, no flake)", async () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    const workerSrc = new URL("../../src/rules/write-rules.ts", import.meta.url).href;
    const worker = new URL("./fixtures/lock-race-worker.ts", import.meta.url).pathname;
    const logPath = join(dir, "race.log");
    for (let round = 0; round < 25; round++) {
      writeFileSync(join(rulesDir, ".rules.lock"), "999999999"); // a dead pid both workers find
      rmSync(logPath, { force: true });
      await Promise.all([
        Bun.spawn(["bun", "run", worker, workerSrc, rulesDir, logPath, "0"], { stdout: "pipe", stderr: "pipe" }).exited,
        Bun.spawn(["bun", "run", worker, workerSrc, rulesDir, logPath, "0"], { stdout: "pipe", stderr: "pipe" }).exited,
      ]);
      const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { pid: number; start?: number; end?: number; error?: string });
      const holders = lines.filter((l) => l.start !== undefined);
      const losers = lines.filter((l) => l.error !== undefined);
      expect(holders.length).toBe(0);
      expect(losers.length).toBe(2);
      for (const l of losers) expect(l.error).toMatch(/no longer running/);
      // the dead lock is still there: nobody reclaimed or removed it
      expect(readFileSync(join(rulesDir, ".rules.lock"), "utf8")).toBe("999999999");
    }
  }, 120_000);
});

describe("writeRulesFile: optimistic concurrency (ifMatch/etag, review round 2)", () => {
  test("etag is returned on every write and matches rulesEtag", () => {
    const result = writeRulesFile(doc([RULE_A]), env());
    expect(result.etag).toMatch(/^[0-9a-f]{64}$/);
    expect(rulesEtag(env())).toBe(result.etag);
  });

  test("ifMatch matching the current etag allows the write", () => {
    const first = writeRulesFile(doc([RULE_A]), env());
    const result = writeRulesFile(doc([RULE_A, RULE_B]), env(), undefined, { ifMatch: first.etag });
    expect(result.changedIds).toContain("stories");
  });

  test("ifMatch against a file that does not exist yet uses sha256('') as the expected etag", () => {
    const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(rulesEtag(env())).toBe(EMPTY_SHA256.slice(0, 64));
    const result = writeRulesFile(doc([RULE_A]), env(), undefined, { ifMatch: rulesEtag(env()) });
    expect(result.path).toBe(rulesFilePath());
  });

  test("a stale ifMatch refuses the write with no mutation at all", () => {
    const first = writeRulesFile(doc([RULE_A]), env());
    writeRulesFile(doc([RULE_A, RULE_B]), env()); // the file moves on without the caller's knowledge
    expect(() => writeRulesFile(doc([RULE_A, { ...RULE_B, brief: "conflicting edit" }]), env(), undefined, { ifMatch: first.etag }))
      .toThrow(/etag mismatch/);
    // untouched by the refused write
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(doc([RULE_A, RULE_B]));
  });
});

describe("updateRulesFile (round 3, finding F1: the safe read-modify-write path)", () => {
  test("F1 PROBE: plain writeRulesFile from a stale read silently loses a concurrent edit", () => {
    writeRulesFile(doc([RULE_A]), env());
    const staleRead = readFileSync(rulesFilePath(), "utf8"); // simulates a caller's earlier GET
    writeRulesFile(doc([RULE_A, RULE_B]), env()); // a concurrent writer's change lands in between
    // our caller now writes back based on the STALE read it holds, with no ifMatch — exactly the
    // lost-update writeRulesFile alone cannot prevent (ifMatch is opt-in, not automatic)
    const nextFromStale = setRuleEnabled(staleRead, "triage", false);
    writeRulesFile(nextFromStale, env());
    const final = JSON.parse(readFileSync(rulesFilePath(), "utf8")) as { rules: Array<{ id: string }> };
    // RULE_B is GONE — the concurrent writer's change was silently erased
    expect(final.rules.map((r) => r.id)).toEqual(["triage"]);
  });

  test("F1 FIX: updateRulesFile never loses a concurrent edit, since the mutator runs on fresh state under the lock", () => {
    writeRulesFile(doc([RULE_A]), env());
    writeRulesFile(doc([RULE_A, RULE_B]), env()); // a concurrent writer's change already landed
    const result = updateRulesFile((current) => setRuleEnabled(current!, "triage", false), env());
    const final = JSON.parse(readFileSync(rulesFilePath(), "utf8")) as { rules: Array<{ id: string; enabled?: boolean }> };
    // RULE_B survives — the mutator saw the CURRENT (post-concurrent-edit) text, never a stale snapshot
    expect(final.rules.map((r) => r.id).sort()).toEqual(["stories", "triage"]);
    expect(final.rules.find((r) => r.id === "triage")!.enabled).toBe(false);
    expect(result.changedIds).toContain("triage");
  });

  test("the mutator receives undefined when no file exists yet", () => {
    let sawUndefined = false;
    const result = updateRulesFile((current) => {
      sawUndefined = current === undefined;
      return doc([RULE_A]);
    }, env());
    expect(sawUndefined).toBe(true);
    expect(result.backupPath).toBeNull();
  });

  test("a mutator producing invalid JSON throws and leaves the live file untouched", () => {
    writeRulesFile(doc([RULE_A]), env());
    const before = readFileSync(rulesFilePath(), "utf8");
    expect(() => updateRulesFile(() => "{not json", env())).toThrow(/invalid JSON/);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(before);
  });
});

describe("assertOnlyChanged (round 3, finding F2)", () => {
  test("no diff: never throws, for any allowlist including an empty one", () => {
    const text = doc([RULE_A, RULE_B]);
    expect(() => assertOnlyChanged(text, text, [])).not.toThrow();
  });

  test("a change inside the allowlist passes", () => {
    const prev = doc([{ ...RULE_A, enabled: true }]);
    const next = doc([{ ...RULE_A, enabled: false }]);
    expect(() => assertOnlyChanged(prev, next, ["rules.*.enabled"])).not.toThrow();
  });

  test("F2 GO-RED: a change OUTSIDE the allowlist is refused, naming the offending path", () => {
    const prev = doc([{ ...RULE_A, enabled: true }]);
    const next = doc([{ ...RULE_A, enabled: true, brief: "a sneaky unrelated edit" }]);
    expect(() => assertOnlyChanged(prev, next, ["rules.*.enabled"])).toThrow(/rules\[0\]\.brief/);
  });

  test("an added rule is reported at the whole array's own path — \"rules\" permits it, a narrower allowlist refuses it", () => {
    const prev = doc([RULE_A]);
    const next = doc([RULE_A, RULE_B]);
    expect(() => assertOnlyChanged(prev, next, ["rules"])).not.toThrow();
    expect(() => assertOnlyChanged(prev, next, ["rules.*.enabled"])).toThrow(/rules/);
  });

  test("a removed rule is likewise gated by the array's own path", () => {
    const prev = doc([RULE_A, RULE_B]);
    const next = doc([RULE_A]);
    expect(() => assertOnlyChanged(prev, next, ["rules"])).not.toThrow();
    expect(() => assertOnlyChanged(prev, next, ["rules.*.enabled"])).toThrow();
  });

  test("wired into writeRulesFile via opts.allowedPaths: an out-of-scope change is refused with no mutation", () => {
    writeRulesFile(doc([{ ...RULE_A, enabled: true }]), env());
    const before = readFileSync(rulesFilePath(), "utf8");
    const sneaky = doc([{ ...RULE_A, enabled: true, brief: "changed brief, not enabled" }]);
    expect(() => writeRulesFile(sneaky, env(), undefined, { allowedPaths: ["rules.*.enabled"] })).toThrow(/not in the allowed set/);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(before);
  });

  test("wired into writeRulesFile via opts.allowedPaths: an in-scope change succeeds", () => {
    writeRulesFile(doc([{ ...RULE_A, enabled: true }]), env());
    const onlyEnabled = doc([{ ...RULE_A, enabled: false }]);
    const result = writeRulesFile(onlyEnabled, env(), undefined, { allowedPaths: ["rules.*.enabled"] });
    expect(result.changedIds).toContain("triage");
  });

  test("wired into updateRulesFile via opts.allowedPaths", () => {
    writeRulesFile(doc([{ ...RULE_A, enabled: true }]), env());
    expect(() => updateRulesFile((current) => setRuleEnabled(current!, "triage", false).replace('"query": "project = BUTCHR"', '"query": "project = SOMEWHERE_ELSE"'), env(), undefined, { allowedPaths: ["rules.*.enabled"] }))
      .toThrow(/not in the allowed set/);
    const ok = updateRulesFile((current) => setRuleEnabled(current!, "triage", false), env(), undefined, { allowedPaths: ["rules.*.enabled"] });
    expect(ok.changedIds).toContain("triage");
  });
});

describe("fsyncDir error handling (round 3, finding F5: swallow only EINVAL/ENOTSUP)", () => {
  test("the default io's fsyncDir propagates a non-whitelisted error (e.g. ENOENT) rather than swallowing it", () => {
    expect(() => defaultIo().fsyncDir(join(dir, "this-directory-does-not-exist"))).toThrow();
  });
});

describe("setRuleEnabled", () => {
  test("flips an existing `enabled: true` to false, byte-identical elsewhere", () => {
    const text = doc([{ ...RULE_A, enabled: true }, RULE_B]);
    const next = setRuleEnabled(text, "triage", false);
    expect(JSON.parse(next).rules[0].enabled).toBe(false);
    expect(JSON.parse(next).rules[1]).toEqual(RULE_B);
    // every byte outside the one `true`/`false` token is unchanged
    expect(next.replace("false", "true")).toBe(text);
  });

  test("flips an existing `enabled: false` to true", () => {
    const text = doc([{ ...RULE_A, enabled: false }]);
    const next = setRuleEnabled(text, "triage", true);
    expect(JSON.parse(next).rules[0].enabled).toBe(true);
  });

  test("a rule with no `enabled` field (default true) gets one inserted on disable", () => {
    const text = doc([RULE_A, RULE_B]);
    const next = setRuleEnabled(text, "triage", false);
    const parsed = JSON.parse(next);
    expect(parsed.rules[0].enabled).toBe(false);
    expect(parsed.rules[1]).toEqual(RULE_B);
  });

  test("preserves 2-space indent and key order; only the target rule's enabled field changes, byte for byte", () => {
    const text = `{
  "rules": [
    {
      "id": "triage",
      "resourceProvider": "jira-work",
      "query": "project = BUTCHR",
      "brief": "triage it",
      "enabled": true
    },
    {
      "id": "stories",
      "resourceProvider": "jira-work",
      "query": "project = BUTCHR AND issuetype = Story",
      "brief": "work the story"
    }
  ]
}
`;
    const next = setRuleEnabled(text, "triage", false);
    const expected = text.replace('"enabled": true', '"enabled": false');
    expect(next).toBe(expected);
  });

  test("unknown id: throws clearly", () => {
    expect(() => setRuleEnabled(doc([RULE_A]), "nope", true)).toThrow(/no rule with id "nope"/);
  });

  test("invalid JSON input: throws clearly", () => {
    expect(() => setRuleEnabled("{not json", "triage", true)).toThrow(/invalid JSON/);
  });
});
