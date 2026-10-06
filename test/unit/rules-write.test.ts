import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rulesEtag } from "../../src/rules/write-rules.js";
import type { RulesEnv } from "../../src/rules/rules.js";
import { writeRuleEnabled, writeRuleFields, writeUndo, planRuleWrite, type RulesWriteDeps } from "../../src/rules/rules-write.js";
import { PLACEHOLDER_QUERY, ENABLE_SCOPE_CEILING, type RuleFieldPatch } from "../../src/rules/rules-write-registry.js";

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

/** The realistic flow: ask `planRuleWrite` for the hash an apply call must echo. Throws if the plan itself was refused — every call site here expects a successful plan. */
async function planHashFor(id: string, patch: RuleFieldPatch, confirm: boolean, scopeOf: (id: string) => Promise<number>, deps: RulesWriteDeps): Promise<string> {
  const plan = await planRuleWrite(id, patch, confirm, scopeOf, deps);
  if (!plan.ok) throw new Error(`expected a successful plan, got: ${plan.error}`);
  return plan.planHash;
}

describe("writeRuleEnabled", () => {
  test("refuses a non-ui- rule id, writes nothing", async () => {
    const text = seed([MANAGERS_RULE]);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("managers", false, etag, false, "irrelevant-hash", noScope, { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(403);
      expect(outcome.error).toMatch(/ui-/);
    }
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("refuses a stale ifMatch, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const outcome = await writeRuleEnabled("ui-first-rule", true, "stale-etag", false, "irrelevant-hash", async () => 1, { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("refuses enabling while query is still the placeholder, writes nothing", async () => {
    const rule = { ...UI_RULE, query: PLACEHOLDER_QUERY };
    const text = seed([rule]);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, false, "irrelevant-hash", async () => 1, { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(403);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("refuses enabling above the scope ceiling without confirm, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, false, "irrelevant-hash", async () => ENABLE_SCOPE_CEILING + 1, { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("accepts enabling above the ceiling WITH confirm: true and a fresh planHash — writes, returns a backup id and etag", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const scopeOf = async () => ENABLE_SCOPE_CEILING + 1;
    const planHash = await planHashFor("ui-first-rule", { enabled: true }, true, scopeOf, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, true, planHash, scopeOf, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.changedIds).toEqual(["ui-first-rule"]);
      const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
      expect(nextDoc.rules[0].enabled).toBe(true);
    }
  });

  test("B3: a disable without confirm is refused, writes nothing, even with a correct planHash", async () => {
    seed([{ ...UI_RULE, enabled: true }]);
    const deps = { env: env() };
    const planHash = await planHashFor("ui-first-rule", { enabled: false }, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", false, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
  });

  test("a disable WITH confirm and a fresh planHash writes a backup", async () => {
    seed([{ ...UI_RULE, enabled: true }]);
    const deps = { env: env() };
    const planHash = await planHashFor("ui-first-rule", { enabled: false }, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", false, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.backupId).not.toBeNull();
    const entries = readdirSync(join(dir, "butchr"));
    expect(entries.some((e) => e.includes(".bak-"))).toBe(true);
  });

  test("B3: a stale planHash (file changed since the plan) is refused, writes nothing", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const planHash = await planHashFor("ui-first-rule", { enabled: true }, false, noScope, deps);
    // the file changes after the plan was computed (another write landed)
    const etag1 = rulesEtag(env());
    const edit = writeRuleFields("ui-first-rule", { query: "project = CHANGED" }, etag1, false, await planHashFor("ui-first-rule", { query: "project = CHANGED" }, false, noScope, deps), deps);
    expect(edit.ok).toBe(true);
    const etag2 = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag2, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
  });

  test("a write that would touch a FIXED field is impossible through this path: enabling never changes query/execution/etc.", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const planHash = await planHashFor("ui-first-rule", { enabled: true }, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].query).toBe(UI_RULE.query);
    expect(nextDoc.rules[0].brief).toBe(UI_RULE.brief);
  });
});

describe("allowlist is per-index, never a wildcard (agentsafety 2026-10-05 17:0x PDT re-check)", () => {
  test("the SAME ui- rule at a DIFFERENT array index still writes correctly (allowlist tracks the fresh index, not a stale one)", async () => {
    // `managers` occupies index 0 here, `ui-first-rule` index 1 — a
    // wildcard allowlist would also (wrongly) have permitted touching
    // `managers`; a hardcoded index 0 would (wrongly) have refused this
    // perfectly legitimate write to index 1.
    seed([MANAGERS_RULE, UI_RULE]);
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = writeRuleFields("ui-first-rule", patch, etag, false, planHash, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0]).toEqual(MANAGERS_RULE); // completely untouched
    expect(nextDoc.rules[1].query).toBe("project = NEW");
  });

  test("agentPreferences leaf-only scoping: a crafted agentPreferences entry with an extra key (harness) is refused, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const deps = { env: env() };
    const patch = { agentPreferences: [{ model: "opus", harness: "codex" } as any] };
    // validateRuleFieldPatch would normally reject this before it ever
    // reaches writeRuleFields — this exercises the allowlist itself as a
    // second, independent gate by calling applyRuleFieldPatch's own
    // caller directly with a patch shape the HTTP-layer validator would
    // have already blocked, proving the allowlist does not silently trust
    // the HTTP layer alone. A REAL planHash (planning this same patch
    // succeeds — the plan stage doesn't enforce the allowlist) so the
    // allowlist's own refusal, not a stale-plan refusal, is what's tested.
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = writeRuleFields("ui-first-rule", patch, etag, false, planHash, deps);
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
    const outcome = writeRuleFields("managers", { query: "project = X" }, etag, false, "irrelevant-hash", { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(403);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("refuses a stale ifMatch, writes nothing", () => {
    const text = seed([UI_RULE]);
    const outcome = writeRuleFields("ui-first-rule", { query: "project = X" }, "stale", false, "irrelevant-hash", { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("edits query, preserving every other field byte-for-byte (value-wise)", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = writeRuleFields("ui-first-rule", patch, etag, false, planHash, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].query).toBe("project = NEW");
    expect(nextDoc.rules[0].brief).toBe(UI_RULE.brief);
    expect(nextDoc.rules[0].enabled).toBe(UI_RULE.enabled);
  });

  test("edits agentPreferences[0].model only, leaving harness untouched (rule stays disabled: no confirm needed)", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch = { agentPreferences: [{ model: "opus" }] };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = writeRuleFields("ui-first-rule", patch, etag, false, planHash, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].agentPreferences[0].model).toBe("opus");
    expect(nextDoc.rules[0].agentPreferences[0].harness).toBe("claude");
  });

  test("agentPreferences length mismatch (an attempted add) is refused, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const deps = { env: env() };
    const patch = { agentPreferences: [{ model: "opus" }, { model: "haiku" }] };
    const etag = rulesEtag(env());
    // The plan itself would also throw on this (applyRuleFieldPatch runs
    // the same validation) — pass an arbitrary hash, the length-mismatch
    // error fires before the hash is ever compared.
    const outcome = writeRuleFields("ui-first-rule", patch, etag, false, "irrelevant-hash", deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(400);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("B3: editing query on an ALREADY-ENABLED rule without confirm is refused (restart), writes nothing", async () => {
    seed([{ ...UI_RULE, enabled: true }]);
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = writeRuleFields("ui-first-rule", patch, etag, false, planHash, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
  });

  test("B3: editing query on an already-enabled rule WITH confirm succeeds", async () => {
    seed([{ ...UI_RULE, enabled: true }]);
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = writeRuleFields("ui-first-rule", patch, etag, true, planHash, deps);
    expect(outcome.ok).toBe(true);
  });

  test("B3: a planHash from a DIFFERENT patch is refused (tampered/stale plan), writes nothing", async () => {
    const text = seed([UI_RULE]);
    const deps = { env: env() };
    const planHash = await planHashFor("ui-first-rule", { query: "project = A" }, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = writeRuleFields("ui-first-rule", { query: "project = B" }, etag, false, planHash, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });
});

describe("writeUndo (B2: only the last UI write's own backup, at its own resulting etag)", () => {
  test("no UI write has happened yet through this deps object: undo is refused even for a real backup id", () => {
    seed([UI_RULE]);
    const outcome = writeUndo("20261005T000000Z", { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(403);
  });

  test("undoing the LAST UI write, with the file unchanged since, restores byte-for-byte and clears the tracked write", async () => {
    const original = seed([UI_RULE]);
    const deps = { env: env() };
    const patch = { query: "project = CHANGED" };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const edited = writeRuleFields("ui-first-rule", patch, etag, false, planHash, deps);
    expect(edited.ok).toBe(true);
    if (!edited.ok || !edited.backupId) throw new Error("expected a backup id");
    const undone = writeUndo(edited.backupId, deps);
    expect(undone.ok).toBe(true);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(original);
    // the tracked write is now cleared — undoing again (even the same id) is refused
    const second = writeUndo(edited.backupId, deps);
    expect(second.ok).toBe(false);
  });

  test("B2: a backup id that is NOT the last UI write's own is refused, even if it genuinely exists on disk", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch1 = { query: "project = FIRST" };
    const hash1 = await planHashFor("ui-first-rule", patch1, false, noScope, deps);
    const etag1 = rulesEtag(env());
    const first = writeRuleFields("ui-first-rule", patch1, etag1, false, hash1, deps);
    expect(first.ok).toBe(true);
    const firstBackupId = first.ok ? first.backupId : null;

    const patch2 = { query: "project = SECOND" };
    const hash2 = await planHashFor("ui-first-rule", patch2, false, noScope, deps);
    const etag2 = rulesEtag(env());
    const second = writeRuleFields("ui-first-rule", patch2, etag2, false, hash2, deps);
    expect(second.ok).toBe(true);

    // firstBackupId genuinely exists on disk, but it is NOT the tracked
    // last-write's own id any more (second overwrote the tracker) — refused.
    if (!firstBackupId) throw new Error("expected a backup id from the first write");
    const outcome = writeUndo(firstBackupId, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(403);
  });

  test("B2: an admin's hand edit between the UI write and the undo (etag now differs) refuses the undo", async () => {
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch = { query: "project = CHANGED" };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const edited = writeRuleFields("ui-first-rule", patch, etag, false, planHash, deps);
    expect(edited.ok).toBe(true);
    if (!edited.ok || !edited.backupId) throw new Error("expected a backup id");

    // An admin hand-edits the file directly (not through this write path)
    // after the UI write landed.
    const handEdited = doc([{ ...UI_RULE, query: "project = CHANGED", id: "managers" }]);
    writeFileSync(rulesFilePath(), handEdited);

    const outcome = writeUndo(edited.backupId, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
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

  test("disabling an enabled rule: stopped=1, requiresConfirm (B3), no scope lookup needed", async () => {
    seed([{ ...UI_RULE, enabled: true }]);
    let scopeCalled = false;
    const plan = await planRuleWrite("ui-first-rule", { enabled: false }, false, async () => { scopeCalled = true; return 1; }, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) { expect(plan.stopped).toBe(1); expect(plan.spawned).toBe(0); expect(plan.requiresConfirm).toBe(true); }
    expect(scopeCalled).toBe(false);
  });

  test("disabling WITH confirm: requiresConfirm is false", async () => {
    seed([{ ...UI_RULE, enabled: true }]);
    const plan = await planRuleWrite("ui-first-rule", { enabled: false }, true, noScope, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.requiresConfirm).toBe(false);
  });

  test("editing query on an already-enabled rule: restarted=1, requiresConfirm (B3)", async () => {
    seed([{ ...UI_RULE, enabled: true }]);
    const plan = await planRuleWrite("ui-first-rule", { query: "project = NEW" }, false, noScope, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) { expect(plan.restarted).toBe(1); expect(plan.requiresConfirm).toBe(true); }
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

  test("the SAME patch against the SAME file state always hashes identically (apply can verify it)", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    const a = await planRuleWrite("ui-first-rule", patch, false, noScope, deps);
    const b = await planRuleWrite("ui-first-rule", patch, false, noScope, deps);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.planHash).toBe(b.planHash);
  });
});
