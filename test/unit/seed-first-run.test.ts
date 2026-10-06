import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFirstRunRules } from "../../src/rules/seed-first-run.js";
import { FIRST_RULE_ID } from "../../src/rules/rules-write-registry.js";
import { loadRules, type RulesEnv } from "../../src/rules/rules.js";
import { reloadRules } from "../../src/rules/reload.js";
import { createRulesHolder } from "../../src/rules/rules.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-seed-first-run-"));
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

describe("seedFirstRunRules — true first run", () => {
  test("seeds one disabled ui-first-rule template when nothing exists yet", () => {
    const outcome = seedFirstRunRules(env());
    expect(outcome.kind).toBe("seeded");
    const text = readFileSync(rulesFilePath(), "utf8");
    const { rules } = loadRules(env(), () => text);
    expect(rules).toHaveLength(1);
    const rule = rules[0]!;
    expect(rule.id).toBe(FIRST_RULE_ID);
    expect(rule.enabled).toBe(false);
    expect(rule.resourceProvider).toBe("jira-work");
    expect(rule.query).toBe("PLACEHOLDER_QUERY");
    expect(rule.execution).toBe("singleton");
    expect(rule.account).toBe("none");
    expect(rule.role).toBe("worker");
    expect(rule.permissionMode).toBe("default");
    expect(rule.lizardMode).toBe(true);
    expect(rule.agentPreferences).toEqual([{ harness: "claude", model: "sonnet", effort: "low" }]);
  });

  test("seeded text passes loadRules with every fixed field exactly as specified (no unknown fields, nothing dropped)", () => {
    seedFirstRunRules(env());
    const { rules, origin } = loadRules(env());
    expect(origin).toBe("file");
    expect(rules).toHaveLength(1);
  });

  test("is idempotent across two startups: the second call sees the file from the first and does not reseed or throw", () => {
    const first = seedFirstRunRules(env());
    expect(first.kind).toBe("seeded");
    const textAfterFirst = readFileSync(rulesFilePath(), "utf8");
    const second = seedFirstRunRules(env());
    expect(second.kind).toBe("not-first-run");
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(textAfterFirst);
  });

  test("dir is created mode 0700, file mode 0600", () => {
    seedFirstRunRules(env());
    const { statSync } = require("node:fs") as typeof import("node:fs");
    expect(statSync(join(dir, "butchr")).mode & 0o777).toBe(0o700);
    expect(statSync(rulesFilePath()).mode & 0o777).toBe(0o600);
  });
});

describe("seedFirstRunRules — no-clobber: an existing file (or symlink) is never replaced, and no seed happens", () => {
  test("an existing, valid file is left completely untouched", () => {
    mkdirSync(join(dir, "butchr"), { recursive: true });
    const existing = JSON.stringify({ rules: [{ id: "managers", resourceProvider: "jira-work", query: "project = X", brief: "b" }] }, null, 2);
    writeFileSync(rulesFilePath(), existing);
    const outcome = seedFirstRunRules(env());
    expect(outcome.kind).toBe("not-first-run");
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(existing);
  });

  test("an existing EMPTY file is left completely untouched (never replaced)", () => {
    mkdirSync(join(dir, "butchr"), { recursive: true });
    writeFileSync(rulesFilePath(), "");
    const outcome = seedFirstRunRules(env());
    expect(outcome.kind).toBe("not-first-run");
    expect(readFileSync(rulesFilePath(), "utf8")).toBe("");
  });

  test("an existing INVALID (unparseable) file is left completely untouched", () => {
    mkdirSync(join(dir, "butchr"), { recursive: true });
    writeFileSync(rulesFilePath(), "{ not json");
    const outcome = seedFirstRunRules(env());
    expect(outcome.kind).toBe("not-first-run");
    expect(readFileSync(rulesFilePath(), "utf8")).toBe("{ not json");
  });

  test("an existing symlink at the rules path is left completely untouched — no seed attempted through it", () => {
    mkdirSync(join(dir, "butchr"), { recursive: true });
    const real = join(dir, "real-rules.json");
    writeFileSync(real, "elsewhere");
    symlinkSync(real, rulesFilePath());
    const outcome = seedFirstRunRules(env());
    expect(outcome.kind).toBe("not-first-run");
    expect(readFileSync(real, "utf8")).toBe("elsewhere");
  });
});

describe("seedFirstRunRules — BUTCHR_RULES_FILE set: untouched by this module, explicit missing path still errors", () => {
  test("set-but-missing: seedFirstRunRules declines (not-first-run), and a subsequent loadRules still throws exactly as before this ticket", () => {
    const e: RulesEnv = { ...env(), BUTCHR_RULES_FILE: join(dir, "nope", "rules.json") };
    const outcome = seedFirstRunRules(e);
    expect(outcome.kind).toBe("not-first-run");
    expect(() => loadRules(e)).toThrow(/does not exist/);
  });

  test("set-and-present: seedFirstRunRules declines, the file is untouched", () => {
    const explicitPath = join(dir, "explicit-rules.json");
    const existing = JSON.stringify({ rules: [] });
    writeFileSync(explicitPath, existing);
    const e: RulesEnv = { ...env(), BUTCHR_RULES_FILE: explicitPath };
    const outcome = seedFirstRunRules(e);
    expect(outcome.kind).toBe("not-first-run");
    expect(readFileSync(explicitPath, "utf8")).toBe(existing);
  });
});

describe("seedFirstRunRules — prior state (.bak-*) means an established install, not a first run", () => {
  test("a .bak-* entry with no current rules file: no seed, reported as vanished-established-install", () => {
    mkdirSync(join(dir, "butchr"), { recursive: true });
    writeFileSync(join(dir, "butchr", "rules.json.bak-20261005T180000Z"), JSON.stringify({ rules: [] }));
    const outcome = seedFirstRunRules(env());
    expect(outcome.kind).toBe("vanished-established-install");
    if (outcome.kind === "vanished-established-install") expect(outcome.path).toBe(rulesFilePath());
    // still no rules.json written
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(rulesFilePath())).toBe(false);
  });

  test("a hand-made file that merely CONTAINS '.bak-' but doesn't match the backup shape does not count as prior state — still a true first run", () => {
    mkdirSync(join(dir, "butchr"), { recursive: true });
    writeFileSync(join(dir, "butchr", "notes.bak-for-later.txt"), "hello");
    const outcome = seedFirstRunRules(env());
    expect(outcome.kind).toBe("seeded");
  });
});

describe("seedFirstRunRules — seed failure warns and leaves the daemon with no rules, same as today", () => {
  test("a filesystem failure partway through the write reports seed-failed, not a thrown error, and a subsequent loadRules sees the ordinary missing-file state", () => {
    const { defaultIo } = require("../../src/rules/write-rules.js") as typeof import("../../src/rules/write-rules.js");
    const failingIo = { ...defaultIo(), writeTempExclusive: () => { throw new Error("simulated disk full"); } };
    const outcome = seedFirstRunRules(env(), failingIo);
    expect(outcome.kind).toBe("seed-failed");
    if (outcome.kind === "seed-failed") expect(outcome.error).toMatch(/simulated disk full/);
    const { origin, rules } = loadRules(env());
    expect(origin).toBe("missing");
    expect(rules).toEqual([]);
  });
});

describe("runtime delete does not recreate — nothing but the one startup call site ever seeds", () => {
  test("after a successful seed, deleting the file and running an ordinary reload (the SIGHUP path) does not bring it back", () => {
    seedFirstRunRules(env());
    const { unlinkSync } = require("node:fs") as typeof import("node:fs");
    unlinkSync(rulesFilePath());
    const holder = createRulesHolder([]);
    const result = reloadRules(holder, env());
    // an ordinary missing-file reload over an already-empty holder is accepted as valid zero rules —
    // `reloadRules` has no seeding concept of its own, so the file stays gone.
    expect(result.ok).toBe(true);
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(rulesFilePath())).toBe(false);
  });
});
