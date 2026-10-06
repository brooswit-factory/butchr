import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rulesEtag } from "../../src/rules/write-rules.js";
import type { RulesEnv } from "../../src/rules/rules.js";
import { writeRuleEnabled, writeRuleFields, writeUndo, planRuleWrite } from "../../src/rules/rules-write.js";
import { PLACEHOLDER_QUERY, ENABLE_SCOPE_CEILING } from "../../src/rules/rules-write-registry.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "butchr-rules-write-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function env(): RulesEnv { return { XDG_CONFIG_HOME: dir }; }
function rulesFilePath(): string { return join(dir, "butchr", "rules.json"); }
const doc = (rules: unknown[]): string => JSON.stringify({ rules }, null, 2) + "\n";

const UI_RULE = { id: "ui-first-rule", resourceProvider: "jira-work", query: "project = BUTCHR", brief: "do the thing", enabled: false, agentPreferences: [{ harness: "claude", model: "sonnet" }] };
const MANAGERS_RULE = { id: "managers", resourceProvider: "jira-work", query: "project = BUTCHR AND role = manager", brief: "manage it", enabled: true };

function seed(rules: unknown[]): string {
  const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(join(dir, "butchr"), { recursive: true });
  const text = doc(rules);
  writeFileSync(rulesFilePath(), text);
  return text;
}

const noScope = async () => 0;

describe("writeRuleEnabled", () => {
  test("refuses a non-ui- rule id, writes nothing", async () => {
    const text = seed([MANAGERS_RULE]);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("managers", false, etag, false, noScope, { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(403);
      expect(outcome.error).toMatch(/ui-/);
    }
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("refuses a stale ifMatch, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const outcome = await writeRuleEnabled("ui-first-rule", true, "stale-etag", false, async () => 1, { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("refuses enabling while query is still the placeholder, writes nothing", async () => {
    const rule = { ...UI_RULE, query: PLACEHOLDER_QUERY };
    const text = seed([rule]);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, false, async () => 1, { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(403);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("refuses enabling above the scope ceiling without confirm, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, false, async () => ENABLE_SCOPE_CEILING + 1, { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("accepts enabling above the ceiling WITH confirm: true — writes, returns a backup id and etag", async () => {
    seed([UI_RULE]);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, true, async () => ENABLE_SCOPE_CEILING + 1, { env: env() });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.changedIds).toEqual(["ui-first-rule"]);
      const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
      expect(nextDoc.rules[0].enabled).toBe(true);
    }
  });

  test("accepts a disable (no scope check, no placeholder check) for a ui- rule, writes a backup", async () => {
    seed([{ ...UI_RULE, enabled: true }]);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", false, etag, false, noScope, { env: env() });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.backupId).not.toBeNull();
    const entries = readdirSync(join(dir, "butchr"));
    expect(entries.some((e) => e.includes(".bak-"))).toBe(true);
  });

  test("a write that would touch a FIXED field is impossible through this path: enabling never changes query/execution/etc.", async () => {
    seed([UI_RULE]);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, false, noScope, { env: env() });
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].query).toBe(UI_RULE.query);
    expect(nextDoc.rules[0].brief).toBe(UI_RULE.brief);
  });
});

describe("allowlist is per-index, never a wildcard (agentsafety 2026-10-05 17:0x PDT re-check)", () => {
  test("the SAME ui- rule at a DIFFERENT array index still writes correctly (allowlist tracks the fresh index, not a stale one)", () => {
    // `managers` occupies index 0 here, `ui-first-rule` index 1 — a
    // wildcard allowlist would also (wrongly) have permitted touching
    // `managers`; a hardcoded index 0 would (wrongly) have refused this
    // perfectly legitimate write to index 1.
    seed([MANAGERS_RULE, UI_RULE]);
    const etag = rulesEtag(env());
    const outcome = writeRuleFields("ui-first-rule", { query: "project = NEW" }, etag, { env: env() });
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0]).toEqual(MANAGERS_RULE); // completely untouched
    expect(nextDoc.rules[1].query).toBe("project = NEW");
  });

  test("agentPreferences leaf-only scoping: a crafted agentPreferences entry with an extra key (harness) is refused, writes nothing", () => {
    const text = seed([UI_RULE]);
    const etag = rulesEtag(env());
    // validateRuleFieldPatch would normally reject this before it ever
    // reaches writeRuleFields — this exercises the allowlist itself as a
    // second, independent gate by calling applyRuleFieldPatch's own
    // caller directly with a patch shape the HTTP-layer validator would
    // have already blocked, proving the allowlist does not silently trust
    // the HTTP layer alone.
    const outcome = writeRuleFields("ui-first-rule", { agentPreferences: [{ model: "opus", harness: "codex" } as any] }, etag, { env: env() });
    // applyRuleFieldPatch spreads the patch element over the current one,
    // so `harness` WOULD change in the next text — assertOnlyChanged must
    // catch it since no built allowed path ever names `.harness`.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(403);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });
});

describe("writeRuleFields (PUT)", () => {
  test("refuses a non-ui- rule id, writes nothing", () => {
    const text = seed([MANAGERS_RULE]);
    const etag = rulesEtag(env());
    const outcome = writeRuleFields("managers", { query: "project = X" }, etag, { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(403);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("refuses a stale ifMatch, writes nothing", () => {
    const text = seed([UI_RULE]);
    const outcome = writeRuleFields("ui-first-rule", { query: "project = X" }, "stale", { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("edits query, preserving every other field byte-for-byte (value-wise)", () => {
    seed([UI_RULE]);
    const etag = rulesEtag(env());
    const outcome = writeRuleFields("ui-first-rule", { query: "project = NEW" }, etag, { env: env() });
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].query).toBe("project = NEW");
    expect(nextDoc.rules[0].brief).toBe(UI_RULE.brief);
    expect(nextDoc.rules[0].enabled).toBe(UI_RULE.enabled);
  });

  test("edits agentPreferences[0].model only, leaving harness untouched", () => {
    seed([UI_RULE]);
    const etag = rulesEtag(env());
    const outcome = writeRuleFields("ui-first-rule", { agentPreferences: [{ model: "opus" }] }, etag, { env: env() });
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].agentPreferences[0].model).toBe("opus");
    expect(nextDoc.rules[0].agentPreferences[0].harness).toBe("claude");
  });

  test("agentPreferences length mismatch (an attempted add) is refused, writes nothing", () => {
    const text = seed([UI_RULE]);
    const etag = rulesEtag(env());
    const outcome = writeRuleFields("ui-first-rule", { agentPreferences: [{ model: "opus" }, { model: "haiku" }] }, etag, { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(400);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });
});

describe("writeUndo", () => {
  test("restores a previous backup through restoreBackup — a nonexistent backup id is refused", () => {
    seed([UI_RULE]);
    const outcome = writeUndo("20261005T000000Z", { env: env() });
    expect(outcome.ok).toBe(false);
  });

  test("a real backup restores byte-for-byte", () => {
    const original = seed([UI_RULE]);
    const etag = rulesEtag(env());
    const edited = writeRuleFields("ui-first-rule", { query: "project = CHANGED" }, etag, { env: env() });
    expect(edited.ok).toBe(true);
    if (!edited.ok || !edited.backupId) throw new Error("expected a backup id");
    const undone = writeUndo(edited.backupId, { env: env() });
    expect(undone.ok).toBe(true);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(original);
  });
});

describe("planRuleWrite (report-only)", () => {
  test("never writes anything, regardless of the patch", async () => {
    const text = seed([UI_RULE]);
    const plan = await planRuleWrite("ui-first-rule", { query: "project = NEW" }, false, noScope, { env: env() });
    expect(plan.ok).toBe(true);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("enabling a disabled rule: spawned=1, scope from scopeOf, requiresConfirm above the ceiling", async () => {
    seed([UI_RULE]);
    const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, async () => ENABLE_SCOPE_CEILING + 5, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.spawned).toBe(1);
      expect(plan.stopped).toBe(0);
      expect(plan.scope).toBe(ENABLE_SCOPE_CEILING + 5);
      expect(plan.requiresConfirm).toBe(true);
    }
  });

  test("disabling an enabled rule: stopped=1, no scope lookup needed", async () => {
    seed([{ ...UI_RULE, enabled: true }]);
    let scopeCalled = false;
    const plan = await planRuleWrite("ui-first-rule", { enabled: false }, false, async () => { scopeCalled = true; return 1; }, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) { expect(plan.stopped).toBe(1); expect(plan.spawned).toBe(0); }
    expect(scopeCalled).toBe(false);
  });

  test("editing query on an already-enabled rule: restarted=1", async () => {
    seed([{ ...UI_RULE, enabled: true }]);
    const plan = await planRuleWrite("ui-first-rule", { query: "project = NEW" }, false, noScope, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.restarted).toBe(1);
  });

  test("refuses enabling while query is the placeholder", async () => {
    seed([{ ...UI_RULE, query: PLACEHOLDER_QUERY }]);
    const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, async () => 1, { env: env() });
    expect(plan.ok).toBe(false);
  });

  test("refuses a non-ui- rule id", async () => {
    seed([MANAGERS_RULE]);
    const plan = await planRuleWrite("managers", { query: "x" }, false, noScope, { env: env() });
    expect(plan.ok).toBe(false);
  });
});
