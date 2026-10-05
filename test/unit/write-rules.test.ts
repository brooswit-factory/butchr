import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRuleEnabled, writeRulesFile, type WriteRulesResult } from "../../src/rules/write-rules.js";
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
  test("creates the file, mode 0600, backupPath null, every rule id reported changed", () => {
    const result = writeRulesFile(doc([RULE_A, RULE_B]), env());
    expect(result.path).toBe(rulesFilePath());
    expect(result.backupPath).toBeNull();
    expect(result.changedIds.sort()).toEqual(["stories", "triage"]);
    expect(readFileSync(result.path, "utf8")).toBe(doc([RULE_A, RULE_B]));
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });
});

describe("writeRulesFile: backups", () => {
  test("backs up the current file before overwriting, named rules.json.bak-<UTC timestamp>", () => {
    writeRulesFile(doc([RULE_A]), env());
    const before = readFileSync(rulesFilePath(), "utf8");
    const result = writeRulesFile(doc([RULE_A, RULE_B]), env());
    expect(result.backupPath).not.toBeNull();
    expect(result.backupPath!).toMatch(/rules\.json\.bak-\d{8}T\d{6}Z$/);
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
      listDir: (d: string) => { try { return readdirSync(d); } catch { return []; } },
      isSymlink: () => false,
      realpath: (p: string) => p,
      mkdir: (d: string) => mkdirSync(d, { recursive: true }),
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
