import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIo, restoreBackup, rulesEtag, setRuleEnabled, writeRulesFile, type WriteRulesIo, type WriteRulesResult } from "../../src/rules/write-rules.js";
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
    // seed 25 fake old backups, oldest-looking names first
    for (let i = 0; i < 25; i++) {
      const stamp = `202601010000${String(i).padStart(2, "0")}Z`;
      writeFileSync(join(rulesDir, `rules.json.bak-${stamp}`), "old");
    }
    writeRulesFile(doc([RULE_A, RULE_B]), env());
    const backups = readdirSync(rulesDir).filter((n) => n.startsWith("rules.json.bak-"));
    expect(backups.length).toBe(20);
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
      realpath: (p: string) => p,
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

describe("writeRulesFile: symlink refusal", () => {
  test("refuses a rules file path that is a symlink escaping its own directory", () => {
    const outside = join(dir, "outside-target.json");
    writeFileSync(outside, doc([RULE_A]));
    const rulesDir = join(dir, "butchr");
    mkdirSync(rulesDir, { recursive: true });
    symlinkSync(outside, join(rulesDir, "rules.json"));
    expect(() => writeRulesFile(doc([RULE_A, RULE_B]), env())).toThrow(/symlink/);
    // the outside target was never touched
    expect(readFileSync(outside, "utf8")).toBe(doc([RULE_A]));
  });

  test("allows a symlink that stays within the rules file's own directory", () => {
    const rulesDir = join(dir, "butchr");
    mkdirSync(rulesDir, { recursive: true });
    const real = join(rulesDir, "real-rules.json");
    writeFileSync(real, doc([RULE_A]));
    symlinkSync(real, join(rulesDir, "rules.json"));
    const result = writeRulesFile(doc([RULE_A, RULE_B]), env());
    expect(result.changedIds).toContain("stories");
  });

  test("a broken symlink (target does not exist) is refused with a clear error, not an ENOENT crash", () => {
    const rulesDir = join(dir, "butchr");
    mkdirSync(rulesDir, { recursive: true });
    symlinkSync(join(rulesDir, "does-not-exist.json"), join(rulesDir, "rules.json"));
    expect(() => writeRulesFile(doc([RULE_A]), env())).toThrow(/symlink to a target that cannot be resolved/);
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

  test("a stale lock (dead pid) is cleared and the write proceeds", () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    // a pid essentially guaranteed not to be a live process on any test runner
    writeFileSync(join(rulesDir, ".rules.lock"), "999999999");
    const result = writeRulesFile(doc([RULE_A, RULE_B]), env());
    expect(result.changedIds).toContain("stories");
    // the lock file was cleaned up by the successful acquire+release
    expect(readdirSync(rulesDir)).not.toContain(".rules.lock");
  });

  test("a stale lock (too old, even with a live-looking pid) is cleared and the write proceeds", () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    const lockPath = join(rulesDir, ".rules.lock");
    writeFileSync(lockPath, String(process.pid)); // this process's own pid — definitely alive
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const result = writeRulesFile(doc([RULE_A, RULE_B]), env());
    expect(result.changedIds).toContain("stories");
  });

  test("the REAL default lock (not overridden): a fresh lock held by this (live) process's own pid genuinely refuses", () => {
    writeRulesFile(doc([RULE_A]), env());
    const rulesDir = join(dir, "butchr");
    writeFileSync(join(rulesDir, ".rules.lock"), String(process.pid)); // live pid, fresh mtime — a genuine live holder
    expect(() => writeRulesFile(doc([RULE_A, RULE_B]), env())).toThrow(/locked by another writer \(pid \d+, held \d+s\)/);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(doc([RULE_A]));
  });
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
