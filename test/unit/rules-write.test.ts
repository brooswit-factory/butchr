import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rulesEtag, updateRulesFile } from "../../src/rules/write-rules.js";
import { loadRules, type RulesEnv } from "../../src/rules/rules.js";
import { capacityRoleFor } from "../../src/agents/capacity-role.js";
import { writeRuleEnabled, writeRuleFields, writeUndo, planRuleWrite, buildPlanHash, createScopeCache, type RulesWriteDeps } from "../../src/rules/rules-write.js";
import { buildFieldsAllowedPaths } from "../../src/rules/rules-write-apply.js";
import { PLACEHOLDER_QUERY, ENABLE_SCOPE_CEILING, type RuleFieldPatch } from "../../src/rules/rules-write-registry.js";
import { createRulesPreviewer, DEFAULT_PREVIEW_RATE_LIMIT_MS } from "../../src/web/rules-preview.js";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { Rule } from "../../src/rules/rules.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "butchr-rules-write-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function env(): RulesEnv { return { XDG_CONFIG_HOME: dir }; }
function rulesFilePath(): string { return join(dir, "butchr", "rules.json"); }
const doc = (rules: unknown[]): string => JSON.stringify({ rules }, null, 2) + "\n";

// FACTORY-685 (item 2): `execution` defaults to `"swarm"` when omitted, which
// would now make EVERY enable in this file subject to the new "any swarm
// enable needs confirm" gate — orthogonal to what these fixtures exist to
// test (stale etags, placeholders, allowlist scoping, N1 caching, etc., not
// item 2 itself). Pinned to `"singleton"` explicitly so this file's many
// pre-existing enable/disable scenarios keep testing what they always tested;
// item 2's own dedicated coverage below builds its own explicitly-`"swarm"`
// fixtures.
const UI_RULE = { id: "ui-first-rule", resourceProvider: "jira-work", query: "project = BUTCHR", brief: "do the thing", enabled: false, execution: "singleton", agentPreferences: [{ harness: "claude", model: "sonnet" }] };
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
  // FACTORY-730: the route-level `ui-`-prefix guard is retired — a write to
  // ANY existing rule id (an operator's real `managers` rule, not only a
  // seeded `ui-`-prefixed one) is now accepted, same as the field allowlist
  // already enforced for a `ui-` rule.
  test("FACTORY-730: accepts a non-ui- rule id (e.g. managers), writes it", async () => {
    seed([MANAGERS_RULE]);
    const deps = { env: env() };
    const planHash = await planHashFor("managers", { enabled: false }, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("managers", false, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.changedIds).toEqual(["managers"]);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].enabled).toBe(false);
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
    // FACTORY-730: any query change now requires confirm (dry-run scope).
    const edit = await writeRuleFields("ui-first-rule", { query: "project = CHANGED" }, etag1, true, await planHashFor("ui-first-rule", { query: "project = CHANGED" }, true, noScope, deps), noScope, deps);
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
    // FACTORY-730 (review round 2): any query change now requires confirm
    // (dry-run scope) — unrelated to what THIS test means to prove (index
    // tracking), so it just supplies it.
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0]).toEqual(MANAGERS_RULE); // completely untouched
    expect(nextDoc.rules[1].query).toBe("project = NEW");
  });

  // FACTORY-729: `harness` is now a DELIBERATELY editable leaf (see
  // `EDITABLE_AGENT_PREFERENCE_LEAVES`'s own doc comment,
  // `rules-write-registry.ts`) — the crafted-extra-key scenario this test
  // originally exercised with `harness` now legitimately succeeds (see the
  // test just below). `EDITABLE_AGENT_PREFERENCE_LEAVES` now covers EVERY
  // real `AgentPreference` field (`harness`/`model`/`effort`/`modelPower`/
  // `effortPower`), so there is no longer a SCHEMA-VALID preference leaf
  // left for `assertOnlyChanged`'s own allowlist to be the one catching —
  // a made-up key (`nickname`, no `AgentPreference` field is ever named
  // this) is caught one layer EARLIER instead, by `loadRules`'s own
  // `parseRules` schema validation (`updateRulesFile`'s re-validate-before-
  // commit step, `write-rules.ts`) — a 400, not a 403. Still "refused,
  // writes nothing": defense in depth is intact, just via the schema gate
  // now that the allowlist gate has nothing left to independently catch at
  // THIS sub-object (it still would, for a future `AgentPreference` field
  // that's schema-valid but deliberately not made editable).
  test("agentPreferences leaf-only scoping: a crafted agentPreferences entry with an unknown field (nickname) is refused by schema validation, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const deps = { env: env() };
    const patch = { agentPreferences: [{ model: "opus", nickname: "bob" } as any] };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(400);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  // FACTORY-729: the NEW leaf-only-scoping proof for `harness`, mirroring
  // the pre-existing `model`/`effort`/etc. coverage this `describe` block
  // already has for the array-index-tracking case above — `harness` alone
  // (no `model`/`effort` in the same patch) is accepted by the allowlist.
  test("agentPreferences leaf-only scoping: harness alone is now a legitimately editable leaf", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch = { agentPreferences: [{ harness: "codex" } as any] };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].agentPreferences[0].harness).toBe("codex");
  });
});

describe("writeRuleFields (PUT)", () => {
  // FACTORY-730: see `writeRuleEnabled`'s own identically-named test above.
  test("FACTORY-730: accepts a non-ui- rule id (e.g. managers), writes it", async () => {
    seed([MANAGERS_RULE]);
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    const planHash = await planHashFor("managers", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("managers", patch, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].query).toBe("project = NEW");
  });

  // FACTORY-730 (review round 2, blocking finding — AC3): a query edit must
  // be refused WITHOUT confirm, regardless of whether the rule is currently
  // enabled or disabled — the gap the review found was specifically the
  // DISABLED case (zero blast radius by every OTHER gate, so nothing
  // previously required a look at what the new query would match).
  test("FACTORY-730 (review): a query edit to a DISABLED non-ui- rule without confirm is refused, writes nothing", async () => {
    const text = seed([{ ...MANAGERS_RULE, enabled: false }]);
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    const scope = async () => 7;
    const planHash = await planHashFor("managers", patch, false, scope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("managers", patch, etag, false, planHash, scope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(409);
      expect(outcome.error).toMatch(/match 7 ticket/);
      expect(outcome.error).toMatch(/confirm/);
    }
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("FACTORY-730 (review): the SAME disabled-rule query edit WITH confirm: true succeeds", async () => {
    seed([{ ...MANAGERS_RULE, enabled: false }]);
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    const scope = async () => 7;
    const planHash = await planHashFor("managers", patch, true, scope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("managers", patch, etag, true, planHash, scope, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].query).toBe("project = NEW");
  });

  // The ENABLED case already trips the pre-existing stop/restart gate
  // (`requireConfirmForBlastRadius`) — this proves the NEW query-change gate
  // doesn't somehow skip itself just because another gate already applies
  // (both must agree the write is refused without confirm).
  test("FACTORY-730 (review): a query edit to an ENABLED non-ui- rule without confirm is refused, writes nothing", async () => {
    const text = seed([{ ...MANAGERS_RULE, enabled: true, execution: "singleton" }]);
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    const scope = async () => 7;
    const planHash = await planHashFor("managers", patch, false, scope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("managers", patch, etag, false, planHash, scope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("FACTORY-730 (review): an unmeasurable new-query scope refuses closed (503), even with confirm: true", async () => {
    seed([{ ...MANAGERS_RULE, enabled: false }]);
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    const unmeasurable = async () => Number.POSITIVE_INFINITY;
    const outcome = await writeRuleFields("managers", patch, "irrelevant-etag", true, "irrelevant-hash", unmeasurable, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(503);
      expect(outcome.error).toMatch(/previewer is unavailable/);
    }
  });

  // FACTORY-730 (story's own review-bar comment, item 3): the fixed
  // template fields stay refused for a NON-`ui-` rule too — same precedent
  // as this file's own `"a write that would touch a FIXED field is
  // impossible through this path"` test (`writeRuleEnabled`, above), just
  // against an operator's real rule instead of the seeded template, and
  // via `writeRuleFields` instead of `writeRuleEnabled`. `RuleFieldPatch`'s
  // own TYPE (`rules-write-registry.ts`) names `execution`/`account`/`role`/
  // `mcpServers`/`mcpConfigFile`/`brief` nowhere, and `applyRuleFieldPatch`
  // only ever copies an explicitly-named field onto the next document — so
  // a legitimate `query`-only edit through this path leaves every one of
  // them byte-for-byte untouched, for a non-`ui-` rule exactly as it always
  // did for `ui-first-rule`.
  test("FACTORY-730: fixed template fields (execution/account/role/brief) stay untouched by a write to a non-ui- rule", async () => {
    // `account`/`role` kept to their real schema's valid values (`rules.ts`'s
    // own `AccountPolicy`/`AgentRole`) — `mcpServers`/`mcpConfigFile` are
    // deliberately NOT exercised here (each carries its own much stricter
    // sub-schema — an absolute path, `jira-project`-only, a structured
    // server-binding shape — unrelated to what this test means to prove)
    // and are already covered as "never in `RuleFieldPatch`'s own type" by
    // this file's header comment and `rules-write-apply.ts`'s own explicit,
    // field-by-field copy.
    const real = { ...MANAGERS_RULE, execution: "swarm", account: "none", role: "worker" };
    seed([real]);
    const deps = { env: env() };
    const patch = { query: "project = CHANGED" };
    const planHash = await planHashFor("managers", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("managers", patch, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].query).toBe("project = CHANGED");
    expect(nextDoc.rules[0].execution).toBe("swarm");
    expect(nextDoc.rules[0].account).toBe("none");
    expect(nextDoc.rules[0].role).toBe("worker");
    expect(nextDoc.rules[0].brief).toBe(real.brief);
  });

  // FACTORY-730: the OTHER half of "two independent gates" (now one gate):
  // `assertOnlyChanged`'s per-index default-deny diff check still refuses a
  // change outside the allowlist for an arbitrary non-`ui-` rule at an
  // arbitrary array index — not only the seeded rule at index 0. Crafts the
  // next document text directly (bypassing `RuleFieldPatch`'s own type and
  // `applyRuleFieldPatch`'s explicit field copying) to prove the DIFF gate
  // itself, not just that the typed path never offers this field.
  test("FACTORY-730: assertOnlyChanged refuses an out-of-allowlist change for an arbitrary non-ui- rule at an arbitrary index", () => {
    const text = seed([UI_RULE, MANAGERS_RULE]); // managers occupies index 1
    expect(() =>
      updateRulesFile(
        (currentText) => {
          // A validly-typed value ("singleton" is a real `ExecutionMode`) —
          // this must be refused for being OUTSIDE the allowlist, not for
          // failing schema validation (a separate, earlier gate this test
          // does not mean to exercise).
          const parsed = JSON.parse(currentText ?? "{}");
          parsed.rules[1] = { ...parsed.rules[1], execution: "singleton" };
          return JSON.stringify(parsed, null, 2) + "\n";
        },
        env(),
        undefined,
        { get allowedPaths() { return buildFieldsAllowedPaths(text, "managers", { query: "irrelevant" }); } },
      ),
    ).toThrow(/is not in the allowed set/);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("refuses a stale ifMatch, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const outcome = await writeRuleFields("ui-first-rule", { query: "project = X" }, "stale", false, "irrelevant-hash", noScope, { env: env() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("edits query, preserving every other field byte-for-byte (value-wise)", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    // FACTORY-730: any query change now requires confirm (dry-run scope).
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
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
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, planHash, noScope, deps);
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
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, "irrelevant-hash", noScope, deps);
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
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
  });

  test("B3: editing query on an already-enabled rule WITH confirm succeeds", async () => {
    seed([{ ...UI_RULE, enabled: true }]);
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
  });

  test("B3: a planHash from a DIFFERENT patch is refused (tampered/stale plan), writes nothing", async () => {
    const text = seed([UI_RULE]);
    const deps = { env: env() };
    const planHash = await planHashFor("ui-first-rule", { query: "project = A" }, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", { query: "project = B" }, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("edits permissionMode: default + agentPreferences[0].harness, no confirm needed (never risky, rule stays disabled)", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch: RuleFieldPatch = { permissionMode: "default", agentPreferences: [{ harness: "codex" }] };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].permissionMode).toBe("default");
    expect(nextDoc.rules[0].agentPreferences[0].harness).toBe("codex");
  });

  test("FACTORY-846: edits idlePokeMinutes/idlePokeMessage/idlePokeEnabled, no confirm needed (never risky)", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch: RuleFieldPatch = { idlePokeMinutes: 45, idlePokeMessage: "go check your ticket", idlePokeEnabled: false };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].idlePokeMinutes).toBe(45);
    expect(nextDoc.rules[0].idlePokeMessage).toBe("go check your ticket");
    expect(nextDoc.rules[0].idlePokeEnabled).toBe(false);
  });
});

describe("FACTORY-729: permissionMode bypassPermissions/auto and lizardMode:true are never defaults — require confirm", () => {
  test("setting permissionMode: bypassPermissions without confirm is refused, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const deps = { env: env() };
    const patch: RuleFieldPatch = { permissionMode: "bypassPermissions" };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("setting permissionMode: auto WITH confirm succeeds", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch: RuleFieldPatch = { permissionMode: "auto" };
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
  });

  test("setting lizardMode: true without confirm is refused, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const deps = { env: env() };
    const patch: RuleFieldPatch = { lizardMode: true };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("setting lizardMode: true WITH confirm succeeds", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch: RuleFieldPatch = { lizardMode: true };
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
  });

  test("setting lizardMode: false (an explicit opt-out) needs no confirm", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch: RuleFieldPatch = { lizardMode: false };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
  });

  // FACTORY-817: `role: "sentinel"` joins this gate — see `isRiskyFieldPatch`'s own doc comment (`src/rules/rules-write.ts`).
  test("setting role: sentinel without confirm is refused, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const deps = { env: env() };
    const patch: RuleFieldPatch = { role: "sentinel" };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("setting role: sentinel WITH confirm succeeds", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch: RuleFieldPatch = { role: "sentinel" };
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].role).toBe("sentinel");
  });

  test("setting role: worker (the default, an explicit opt-in) needs no confirm", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch: RuleFieldPatch = { role: "worker" };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
  });

  test("planRuleWrite: requiresConfirm with confirmReason \"capacity-sentinel\" for role: sentinel alone", async () => {
    seed([UI_RULE]);
    const plan = await planRuleWrite("ui-first-rule", { role: "sentinel" }, false, noScope, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.requiresConfirm).toBe(true);
      expect(plan.confirmReason).toBe("capacity-sentinel");
    }
  });

  // FACTORY-817 criterion 4: the write must be what the ENGINE reads, not
  // just what the stored row says — `loadRules` is the same parse the
  // daemon runs at startup/reload, and `capacityRoleFor` (fed a
  // `ruleRoleOf` built off its `rules`, mirroring `src/daemon/index.ts`'s
  // own `ruleRoleOfAgent`) is the exact function the admission controller
  // calls. Asserting through both, not just `nextDoc.rules[0].role`, is
  // what tells this apart from a write that merely LOOKS right in the file.
  test("round-trip through loadRules + capacityRoleFor: writing role: sentinel is what the engine's own reader sees", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const patch: RuleFieldPatch = { role: "sentinel" };
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);

    const loaded = loadRules(env());
    const ruleRoleOf = (id: string) => loaded.rules.find((r) => r.id === "ui-first-rule")?.role;
    expect(capacityRoleFor("jira-work:ui-first-rule:BUTCHR-1", ruleRoleOf)).toBe("sentinel");
  });

  test("round-trip through loadRules + capacityRoleFor: an UNSET role reads as the engine's own \"worker\" default", async () => {
    seed([UI_RULE]);
    const loaded = loadRules(env());
    const rule = loaded.rules.find((r) => r.id === "ui-first-rule")!;
    expect(rule.role).toBe("worker");
    const ruleRoleOf = (id: string) => loaded.rules.find((r) => r.id === "ui-first-rule")?.role;
    expect(capacityRoleFor("jira-work:ui-first-rule:BUTCHR-1", ruleRoleOf)).toBe("worker");
  });

  test("planRuleWrite: requiresConfirm with confirmReason \"risky-permission\" for permissionMode: bypassPermissions alone", async () => {
    seed([UI_RULE]);
    const plan = await planRuleWrite("ui-first-rule", { permissionMode: "bypassPermissions" }, false, noScope, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.requiresConfirm).toBe(true);
      expect(plan.confirmReason).toBe("risky-permission");
    }
  });

  test("planRuleWrite: confirm: true already satisfies the gate — requiresConfirm is false, no confirmReason", async () => {
    seed([UI_RULE]);
    const plan = await planRuleWrite("ui-first-rule", { lizardMode: true }, true, noScope, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.requiresConfirm).toBe(false);
      expect(plan.confirmReason).toBeUndefined();
    }
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
    // FACTORY-730: any query change now requires confirm (dry-run scope).
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const edited = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
    expect(edited.ok).toBe(true);
    if (!edited.ok || !edited.backupId) throw new Error("expected a backup id");
    const undone = writeUndo(edited.backupId, deps);
    expect(undone.ok).toBe(true);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(original);
    // the tracked write is now cleared — undoing again (even the same id) is refused
    const second = writeUndo(edited.backupId, deps);
    expect(second.ok).toBe(false);
  });

  // FACTORY-730 (story's own review-bar comment, item 4): the SAME
  // end-to-end undo proof, against a non-`ui-` rule — undo restores the
  // previous rules file content byte-for-byte for an operator's real rule
  // exactly as it always did for the seeded template.
  test("FACTORY-730: undoing an edit to a non-ui- rule restores byte-for-byte", async () => {
    const original = seed([MANAGERS_RULE]);
    const deps = { env: env() };
    const patch = { query: "project = CHANGED" };
    const planHash = await planHashFor("managers", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const edited = await writeRuleFields("managers", patch, etag, true, planHash, noScope, deps);
    expect(edited.ok).toBe(true);
    if (!edited.ok || !edited.backupId) throw new Error("expected a backup id");
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].query).toBe("project = CHANGED");
    const undone = writeUndo(edited.backupId, deps);
    expect(undone.ok).toBe(true);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(original);
  });

  test("B2: a backup id that is NOT the last UI write's own is refused, even if it genuinely exists on disk", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    // FACTORY-730: any query change now requires confirm (dry-run scope).
    const patch1 = { query: "project = FIRST" };
    const hash1 = await planHashFor("ui-first-rule", patch1, true, noScope, deps);
    const etag1 = rulesEtag(env());
    const first = await writeRuleFields("ui-first-rule", patch1, etag1, true, hash1, noScope, deps);
    expect(first.ok).toBe(true);
    const firstBackupId = first.ok ? first.backupId : null;

    const patch2 = { query: "project = SECOND" };
    const hash2 = await planHashFor("ui-first-rule", patch2, true, noScope, deps);
    const etag2 = rulesEtag(env());
    const second = await writeRuleFields("ui-first-rule", patch2, etag2, true, hash2, noScope, deps);
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
    // FACTORY-730: any query change now requires confirm (dry-run scope).
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const edited = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
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

  // FACTORY-730 (review round 2, blocking finding — AC3): a changed `query`
  // is dry-run against its OWN NEW text, never the rule's CURRENT (still on
  // disk) query — the review's own repro was that `scope` stayed `null`
  // (never evaluated at all) for a field PUT; this proves it's now
  // evaluated, and against the right text.
  test("FACTORY-730 (review): a query edit's scope reflects the NEW query text, not the rule's current one, even for a DISABLED rule (zero blast radius by every other gate)", async () => {
    seed([{ ...UI_RULE, enabled: false, query: "project = OLD" }]);
    let seenQuery: string | undefined;
    const scope = async (_id: string, queryText: string) => { seenQuery = queryText; return 7; };
    const plan = await planRuleWrite("ui-first-rule", { query: "project = NEW" }, false, scope, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.scope).toBe(7);
      expect(plan.spawned).toBe(0);
      expect(plan.stopped).toBe(0);
      expect(plan.restarted).toBe(0);
      expect(plan.requiresConfirm).toBe(true);
      expect(plan.confirmReason).toBe("query-change");
    }
    expect(seenQuery).toBe("project = NEW");
  });

  test("FACTORY-730 (review): confirm: true already satisfies the query-change gate — requiresConfirm is false", async () => {
    seed([{ ...UI_RULE, enabled: false, query: "project = OLD" }]);
    const plan = await planRuleWrite("ui-first-rule", { query: "project = NEW" }, true, async () => 7, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.scope).toBe(7);
      expect(plan.requiresConfirm).toBe(false);
      expect(plan.confirmReason).toBeUndefined();
    }
  });

  test("FACTORY-730 (review): no query change (patch.query absent, or equal to the current one) never evaluates scope — scope stays null", async () => {
    seed([{ ...UI_RULE, enabled: false, query: "project = OLD" }]);
    let called = false;
    const scope = async () => { called = true; return 7; };
    const noChange = await planRuleWrite("ui-first-rule", { permissionMode: "default" }, false, scope, { env: env() });
    expect(noChange.ok).toBe(true);
    if (noChange.ok) expect(noChange.scope).toBeNull();
    const sameQuery = await planRuleWrite("ui-first-rule", { query: "project = OLD" }, false, scope, { env: env() });
    expect(sameQuery.ok).toBe(true);
    if (sameQuery.ok) expect(sameQuery.scope).toBeNull();
    expect(called).toBe(false);
  });

  test("FACTORY-730 (review): an unmeasurable new-query scope reports scopeUnmeasurable, requiresConfirm true, confirmReason 'unmeasurable-scope'", async () => {
    seed([{ ...UI_RULE, enabled: false, query: "project = OLD" }]);
    const unmeasurable = async () => Number.POSITIVE_INFINITY;
    const plan = await planRuleWrite("ui-first-rule", { query: "project = NEW" }, false, unmeasurable, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.scope).toBeNull();
      expect(plan.scopeUnmeasurable).toBe(true);
      expect(plan.requiresConfirm).toBe(true);
      expect(plan.confirmReason).toBe("unmeasurable-scope");
    }
  });

  test("refuses enabling while query is the placeholder", async () => {
    seed([{ ...UI_RULE, query: PLACEHOLDER_QUERY }]);
    const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, async () => 1, { env: env() });
    expect(plan.ok).toBe(false);
  });

  // FACTORY-730: planning (and, per the other tests in this file, applying)
  // a write to a non-`ui-` rule id is accepted — the route-level prefix
  // gate is retired. `managers` is seeded `enabled: true`, so a `query`
  // edit restarts it (`restarted=1`), which is exactly why this plan
  // reports `requiresConfirm: true` rather than refusing outright — the
  // id itself is no longer the reason anything is gated.
  test("FACTORY-730: accepts a non-ui- rule id — a query edit restarts it, same as any other rule", async () => {
    seed([MANAGERS_RULE]);
    const plan = await planRuleWrite("managers", { query: "x" }, false, noScope, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.restarted).toBe(1);
      expect(plan.requiresConfirm).toBe(true);
    }
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

describe("STALE-FILE REFUSAL (agentsafety second pass): daemon's loaded etag vs the file on disk", () => {
  test("writeRuleEnabled refuses when getSourceEtag() differs from a fresh file read, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const deps: RulesWriteDeps = { env: env(), getSourceEtag: () => "stale-sha-not-matching-the-real-file" };
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, false, "irrelevant-hash", noScope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) { expect(outcome.status).toBe(409); expect(outcome.error).toMatch(/reload first/); }
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("writeRuleFields refuses when getSourceEtag() differs from a fresh file read, writes nothing", async () => {
    const text = seed([UI_RULE]);
    const deps: RulesWriteDeps = { env: env(), getSourceEtag: () => "stale-sha" };
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", { query: "project = NEW" }, etag, false, "irrelevant-hash", noScope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("planRuleWrite refuses when getSourceEtag() differs from a fresh file read", async () => {
    seed([UI_RULE]);
    const deps: RulesWriteDeps = { env: env(), getSourceEtag: () => "stale-sha" };
    const plan = await planRuleWrite("ui-first-rule", { query: "x" }, false, noScope, deps);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.status).toBe(409);
  });

  test("a matching getSourceEtag() (the daemon's view agrees with the file) proceeds normally", async () => {
    seed([UI_RULE]);
    const deps: RulesWriteDeps = { env: env(), getSourceEtag: () => rulesEtag(env()) };
    const patch = { query: "project = NEW" };
    // FACTORY-730: any query change now requires confirm (dry-run scope).
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
  });

  test("getSourceEtag absent (not injected): the check is skipped, never a false refusal", async () => {
    seed([UI_RULE]);
    const deps: RulesWriteDeps = { env: env() };
    const patch = { query: "project = NEW" };
    // FACTORY-730: any query change now requires confirm (dry-run scope).
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
  });
});

describe("B5a: reload is wired for real (not a stub) — see src/daemon/index.ts's own rulesWriteDeps.reload", () => {
  test("a successful write's reload() result is surfaced verbatim in the outcome", async () => {
    seed([UI_RULE]);
    const deps: RulesWriteDeps = { env: env(), reload: () => ({ applied: true, problems: [] }) };
    const patch = { query: "project = NEW" };
    // FACTORY-730: any query change now requires confirm (dry-run scope).
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.reload).toEqual({ applied: true, problems: [] });
  });

  test("a reload that reports problems still surfaces them (the write itself already succeeded)", async () => {
    seed([UI_RULE]);
    const deps: RulesWriteDeps = { env: env(), reload: () => ({ applied: false, problems: ["simulated reload failure"] }) };
    const patch = { query: "project = NEW" };
    // FACTORY-730: any query change now requires confirm (dry-run scope).
    const planHash = await planHashFor("ui-first-rule", patch, true, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, true, planHash, noScope, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.reload).toEqual({ applied: false, problems: ["simulated reload failure"] });
  });
});

describe("B5c: scope ceiling is evaluated on an enabled COPY, even for a currently-disabled rule", () => {
  test("planRuleWrite's scope lookup for enabling a DISABLED rule still calls scopeOf (the real previewer would force enabled:true itself)", async () => {
    seed([UI_RULE]); // UI_RULE.enabled === false
    let scopeOfCalledWith: string | undefined;
    const scope = async (id: string) => { scopeOfCalledWith = id; return ENABLE_SCOPE_CEILING + 40; };
    const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, scope, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) { expect(plan.scope).toBe(ENABLE_SCOPE_CEILING + 40); expect(plan.requiresConfirm).toBe(true); }
    expect(scopeOfCalledWith).toBe("ui-first-rule");
  });

  test("writeRuleEnabled's own pre-lock scope check also fires for a currently-disabled rule being enabled", async () => {
    seed([UI_RULE]);
    const deps = { env: env() };
    const scope = async () => ENABLE_SCOPE_CEILING + 40;
    const planHash = await planHashFor("ui-first-rule", { enabled: true }, false, scope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, false, planHash, scope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
  });
});

describe("FACTORY-685 (item 2, agentsafety F1): confirm on ANY enable of a swarm rule, not only above the ceiling", () => {
  const SWARM_RULE = { id: "ui-first-rule", resourceProvider: "jira-work", query: "project = BUTCHR", brief: "do the thing", enabled: false, execution: "swarm" };

  test("GO-RED: enabling a swarm rule at a tiny scope (well under the 25-ticket ceiling), with no confirm, is refused 409 — writes nothing", async () => {
    const text = seed([SWARM_RULE]);
    const deps = { env: env() };
    const planHash = await planHashFor("ui-first-rule", { enabled: true }, false, async () => 3, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, false, planHash, async () => 3, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(409);
      expect(outcome.error).toMatch(/staff up to 3 ticket/);
      expect(outcome.error).toMatch(/confirm/);
    }
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("the SAME enable, WITH confirm: true and a fresh planHash, succeeds", async () => {
    seed([SWARM_RULE]);
    const deps = { env: env() };
    const scope = async () => 3;
    const planHash = await planHashFor("ui-first-rule", { enabled: true }, true, scope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, true, planHash, scope, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].enabled).toBe(true);
  });

  test("a SINGLETON rule's enable at the same tiny scope needs NO confirm — this gate is swarm-specific", async () => {
    seed([{ ...SWARM_RULE, execution: "singleton" }]);
    const deps = { env: env() };
    const scope = async () => 3;
    const planHash = await planHashFor("ui-first-rule", { enabled: true }, false, scope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, false, planHash, scope, deps);
    expect(outcome.ok).toBe(true);
  });

  test("disabling a swarm rule is unaffected by this gate (it only applies to ENABLING)", async () => {
    seed([{ ...SWARM_RULE, enabled: true }]);
    const deps = { env: env() };
    const planHash = await planHashFor("ui-first-rule", { enabled: false }, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", false, etag, false, planHash, noScope, deps);
    // disabling still needs confirm for its OWN reason (B3, stop > 0) — the point here is just that this is the stop-restart gate, not a second swarm-enable refusal double-counted.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).not.toMatch(/staff up to/);
  });

  test("the unmeasurable-scope guard still fires FIRST, unconditionally — a swarm enable with no real scope number refuses 503, not 409, even with confirm: true", async () => {
    seed([SWARM_RULE]);
    const deps = { env: env() };
    const unmeasurable = async () => Number.POSITIVE_INFINITY;
    const outcome = await writeRuleEnabled("ui-first-rule", true, "irrelevant-etag", true, "irrelevant-hash", unmeasurable, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(503);
      expect(outcome.error).toMatch(/previewer is unavailable/);
    }
  });

  describe("planRuleWrite reports requiresConfirm + confirmReason for a swarm enable", () => {
    test("a swarm enable under the ceiling: requiresConfirm true, confirmReason 'swarm-enable'", async () => {
      seed([SWARM_RULE]);
      const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, async () => 3, { env: env() });
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.scope).toBe(3);
        expect(plan.requiresConfirm).toBe(true);
        expect(plan.confirmReason).toBe("swarm-enable");
      }
    });

    test("a swarm enable OVER the ceiling: confirmReason is the more specific 'scope-ceiling', not 'swarm-enable'", async () => {
      seed([SWARM_RULE]);
      const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, async () => ENABLE_SCOPE_CEILING + 1, { env: env() });
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.requiresConfirm).toBe(true);
        expect(plan.confirmReason).toBe("scope-ceiling");
      }
    });

    test("confirm: true already supplied: requiresConfirm is false, and confirmReason is absent", async () => {
      seed([SWARM_RULE]);
      const plan = await planRuleWrite("ui-first-rule", { enabled: true }, true, async () => 3, { env: env() });
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.requiresConfirm).toBe(false);
        expect(plan.confirmReason).toBeUndefined();
      }
    });

    test("a singleton enable at the same scope: no confirm needed, no confirmReason", async () => {
      seed([{ ...SWARM_RULE, execution: "singleton" }]);
      const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, async () => 3, { env: env() });
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.requiresConfirm).toBe(false);
        expect(plan.confirmReason).toBeUndefined();
      }
    });

    test("an unmeasurable scope on a swarm enable: confirmReason is 'unmeasurable-scope', not 'swarm-enable'", async () => {
      seed([SWARM_RULE]);
      const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, async () => Number.POSITIVE_INFINITY, { env: env() });
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.requiresConfirm).toBe(true);
        expect(plan.confirmReason).toBe("unmeasurable-scope");
      }
    });

    test("a disable needing confirm (stop-restart): confirmReason is 'stop-restart'", async () => {
      seed([{ ...SWARM_RULE, enabled: true }]);
      const plan = await planRuleWrite("ui-first-rule", { enabled: false }, false, noScope, { env: env() });
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.requiresConfirm).toBe(true);
        expect(plan.confirmReason).toBe("stop-restart");
      }
    });
  });
});

describe("FACTORY-687: a rule that OMITS `execution` is still a swarm rule for the item-2 gate (absent = swarm, matching loadRules)", () => {
  // Deliberately omits `execution` entirely — unlike SWARM_RULE above, which sets it explicitly.
  // Every rule in docs/rules.example.json has this exact shape.
  const NO_EXECUTION_RULE = { id: "ui-first-rule", resourceProvider: "jira-work", query: "project = BUTCHR", brief: "do the thing", enabled: false };

  test("GO-RED: enabling with no confirm is refused 409 — writes nothing — even though `execution` is absent, not literally \"swarm\"", async () => {
    const text = seed([NO_EXECUTION_RULE]);
    const deps = { env: env() };
    const planHash = await planHashFor("ui-first-rule", { enabled: true }, false, async () => 3, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, false, planHash, async () => 3, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(409);
      expect(outcome.error).toMatch(/staff up to 3 ticket/);
      expect(outcome.error).toMatch(/confirm/);
    }
    expect(readFileSync(rulesFilePath(), "utf8")).toBe(text);
  });

  test("the SAME enable, WITH confirm: true and a fresh planHash, succeeds", async () => {
    seed([NO_EXECUTION_RULE]);
    const deps = { env: env() };
    const scope = async () => 3;
    const planHash = await planHashFor("ui-first-rule", { enabled: true }, true, scope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, true, planHash, scope, deps);
    expect(outcome.ok).toBe(true);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].enabled).toBe(true);
  });

  test("planRuleWrite reports requiresConfirm:true, confirmReason 'swarm-enable' for a rule that omits `execution`", async () => {
    seed([NO_EXECUTION_RULE]);
    const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, async () => 3, { env: env() });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.scope).toBe(3);
      expect(plan.requiresConfirm).toBe(true);
      expect(plan.confirmReason).toBe("swarm-enable");
    }
  });
});

describe("STALE-LOCK ERROR is passed through verbatim, naming the lock file", () => {
  test("a crashed writer's leftover .rules.lock refuses with the exact path and rm instruction, status 503", async () => {
    seed([UI_RULE]);
    const rulesDir = join(dir, "butchr");
    const lockPath = join(rulesDir, ".rules.lock");
    writeFileSync(lockPath, "999999999"); // a dead pid — nothing on this host runs as it
    const deps = { env: env() };
    const patch = { query: "project = NEW" };
    const planHash = await planHashFor("ui-first-rule", patch, false, noScope, deps);
    const etag = rulesEtag(env());
    const outcome = await writeRuleFields("ui-first-rule", patch, etag, false, planHash, noScope, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(503);
      expect(outcome.error).toContain(lockPath);
      expect(outcome.error).toContain(`rm ${lockPath}`);
    }
  });
});

describe("N1 (FACTORY-678): plan-then-apply does not trip the previewer's own 2s rate limit", () => {
  const issue = (key: string): JiraIssue => ({
    key, summary: `summary for ${key}`, status: "To Do", issuetype: "Task", assignee: null, parent: null, updated: "2026-01-01", labels: [],
  });

  function previewRule(overrides: Partial<Rule> = {}): Rule {
    return {
      id: "ui-first-rule",
      enabled: false,
      resourceProvider: "jira-work",
      query: "project = BUTCHR",
      brief: "do the thing",
      execution: "swarm",
      account: "none",
      role: "worker",
      ...overrides,
    } as Rule;
  }

  /** Wires `scopeOf` exactly as `src/daemon/index.ts` does: a real `createRulesPreviewer` (default `rateLimitMs`), wrapped in `createScopeCache` (also at its own real default TTL unless `cacheDeps` says otherwise). */
  function realScopeOf(rule: Rule, issues: JiraIssue[], cacheDeps?: Parameters<typeof createScopeCache>[1]) {
    const previewer = createRulesPreviewer({ rules: () => [rule], search: async () => issues, maxAgents: 50 });
    return createScopeCache(async (id: string): Promise<number> => {
      const r = await previewer(id);
      return r.ok ? r.total : Number.POSITIVE_INFINITY;
    }, cacheDeps);
  }

  test("GO-RED CONTROL: without the cache, the previewer's own rate limit fails the back-to-back apply — proves the mechanism, not a harness bug", async () => {
    const rule = previewRule();
    seed([rule]);
    const deps = { env: env() };
    // The uncached shape `src/daemon/index.ts` had BEFORE this fix: a
    // fresh `scopeOf` closure with no cache in front of it at all.
    const previewer = createRulesPreviewer({ rules: () => [rule], search: async () => [issue("F-1")], maxAgents: 50 });
    const uncachedScopeOf = async (id: string): Promise<number> => {
      const r = await previewer(id);
      return r.ok ? r.total : Number.POSITIVE_INFINITY;
    };
    const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, uncachedScopeOf, deps);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected a successful plan");
    expect(plan.scope).toBe(1);
    const etag = rulesEtag(env());
    // No artificial wait — the second `scopeOf` call below lands well
    // inside the previewer's own DEFAULT_PREVIEW_RATE_LIMIT_MS window.
    const apply = await writeRuleEnabled("ui-first-rule", true, etag, false, plan.planHash, uncachedScopeOf, deps);
    expect(apply.ok).toBe(false);
    if (!apply.ok) {
      // Review round 1 (PR #651) finding 1 hardened the unmeasurable-scope
      // guard to fire BEFORE the ceiling check and unconditionally (not
      // just when `!confirm`) — so the uncached second call hitting the
      // previewer's own rate limit and failing safe to an unbounded scope
      // is now refused 503 "previewer is unavailable", not 409 "above the
      // ceiling". The mechanism this test exists to prove (the uncached
      // second call racing the previewer's own rate limit, and the write
      // being refused rather than silently landing) still holds — only the
      // specific status/message changed, because a stronger guard now
      // catches it first.
      expect(apply.status).toBe(503);
      expect(apply.error).not.toContain("Infinity");
      expect(apply.error).not.toContain("NaN");
      expect(apply.error).toMatch(/previewer is unavailable/);
    }
  });

  test("HEADLINE: with the shared scope cache (exactly as src/daemon/index.ts wires it), plan then apply back-to-back succeeds — no wait, real default rateLimitMs", async () => {
    const rule = previewRule();
    seed([rule]);
    const deps = { env: env() };
    const scopeOf = realScopeOf(rule, [issue("F-1")]);
    // confirm: true throughout — `rule` (`previewRule()`) is execution:
    // "swarm", so FACTORY-685 (item 2) now requires it on ANY enable,
    // independent of this test's own subject (the scope cache, not item 2's
    // gate — see that describe block below for item 2's own coverage).
    const plan = await planRuleWrite("ui-first-rule", { enabled: true }, true, scopeOf, deps);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected a successful plan");
    expect(plan.scope).toBe(1);
    expect(plan.requiresConfirm).toBe(false); // confirm: true already satisfies every gate that would otherwise apply
    const etag = rulesEtag(env());
    const apply = await writeRuleEnabled("ui-first-rule", true, etag, true, plan.planHash, scopeOf, deps);
    expect(apply.ok).toBe(true);
    if (apply.ok) expect(apply.changedIds).toEqual(["ui-first-rule"]);
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].enabled).toBe(true);
  });

  test("adding scope to the hash invalidates every in-flight plan computed before this fix (old 2-arg shape never matches the new 3-arg one)", async () => {
    const rule = previewRule();
    seed([rule]);
    const counts = { spawned: 1, stopped: 0, restarted: 0 };
    // Simulates a plan hash computed by code that never bound scope in —
    // i.e. the OLD `buildPlanHash(nextText, counts)` shape. There is no
    // 2-arg overload any more, so the closest a caller could reconstruct
    // it is passing `undefined`/some other scope — which must NOT equal
    // the real, bound hash.
    const nextText = JSON.stringify({ rules: [{ ...rule, enabled: true }] }, null, 2) + "\n";
    const oldStyleHash = buildPlanHash(nextText, counts, null); // old behavior: as if scope were never bound
    const realHash = buildPlanHash(nextText, counts, 1); // the real evaluated scope
    expect(oldStyleHash).not.toBe(realHash);
  });

  test("a disabled rule's scope is still evaluated as if enabled (B5c) even through the cache", async () => {
    const rule = previewRule({ enabled: false });
    seed([rule]);
    const deps = { env: env() };
    const issues = Array.from({ length: 3 }, (_, i) => issue(`F-${i}`));
    const scopeOf = realScopeOf(rule, issues);
    const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, scopeOf, deps);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.scope).toBe(3);
  });

  test("confirm: true cannot land a write whose scope was never bound: a tampered planHash (built against a DIFFERENT scope than the real one) is refused even with confirm", async () => {
    const rule = previewRule();
    seed([rule]);
    const deps = { env: env() };
    const scopeOf = realScopeOf(rule, [issue("F-1")]); // real scope will be 1
    const nextText = JSON.stringify({ rules: [{ ...rule, enabled: true }] }, null, 2) + "\n";
    const counts = { spawned: 1, stopped: 0, restarted: 0 };
    const tamperedHash = buildPlanHash(nextText, counts, ENABLE_SCOPE_CEILING + 999); // claims a scope that was never measured
    const etag = rulesEtag(env());
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, true, tamperedHash, scopeOf, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
  });

  test("a genuinely unavailable previewer (not a rate-limit refusal) still fails CLOSED through the cache — the ceiling check still trips", async () => {
    const rule = previewRule();
    seed([rule]);
    const deps = { env: env() };
    const previewer = createRulesPreviewer({ rules: () => [rule], search: async () => { throw new Error("Jira is down"); }, maxAgents: 50 });
    const scopeOf = createScopeCache(async (id: string): Promise<number> => {
      const r = await previewer(id);
      return r.ok ? r.total : Number.POSITIVE_INFINITY;
    });
    const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, scopeOf, deps);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.requiresConfirm).toBe(true);
      // Review round 1 (PR #651) finding 1: an unmeasurable scope must
      // NOT collapse into the same `scope: null` the "no spawn evaluated"
      // case already uses — assert on the PARSED SERIALIZED body (what a
      // real HTTP client, e.g. PR #650, actually receives), not the
      // in-process object.
      const wire = JSON.parse(JSON.stringify(plan));
      expect(wire.scope).toBeNull();
      expect(wire.scopeUnmeasurable).toBe(true);
    }
    // ...and the serialized response body never contains the literal "Infinity"
    expect(JSON.stringify(plan)).not.toContain("Infinity");
    expect(JSON.stringify(plan)).not.toContain("NaN");
  });

  test("REGRESSION (review round 1, PR #651 finding 1): confirm: true cannot land a write whose scope was UNMEASURABLE — fails closed unconditionally, not just when !confirm", async () => {
    const rule = previewRule();
    seed([rule]);
    const deps = { env: env() };
    const previewer = createRulesPreviewer({ rules: () => [rule], search: async () => { throw new Error("Jira is down"); }, maxAgents: 50 });
    const scopeOf = createScopeCache(async (id: string): Promise<number> => {
      const r = await previewer(id);
      return r.ok ? r.total : Number.POSITIVE_INFINITY;
    });
    const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, scopeOf, deps);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected a successful plan");
    const etag = rulesEtag(env());
    // The old (pre-fix) shape: `if (scope > CEILING && !confirm)` would
    // have let `confirm: true` bypass the only check standing between an
    // unmeasurable scope and an accepted write. Assert it is refused
    // EVEN WITH `confirm: true`.
    const outcome = await writeRuleEnabled("ui-first-rule", true, etag, true, plan.planHash, scopeOf, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(503);
      expect(outcome.error).toMatch(/previewer is unavailable/);
      expect(outcome.error).not.toContain("Infinity");
      expect(outcome.error).not.toContain("NaN");
    }
    const nextDoc = JSON.parse(readFileSync(rulesFilePath(), "utf8"));
    expect(nextDoc.rules[0].enabled).toBe(false); // nothing written
  });

  test("no Infinity/NaN ever appears in a SERIALIZED error body (Infinity does not survive JSON.stringify — assert on the wire format, not the in-process object)", async () => {
    const rule = previewRule();
    seed([rule]);
    const deps = { env: env() };
    const previewer = createRulesPreviewer({ rules: () => [rule], search: async () => { throw new Error("Jira is down"); }, maxAgents: 50 });
    const scopeOf = createScopeCache(async (id: string): Promise<number> => {
      const r = await previewer(id);
      return r.ok ? r.total : Number.POSITIVE_INFINITY;
    });
    // confirm: false, so the pre-lock ceiling check throws with an error string.
    const outcome = await writeRuleEnabled("ui-first-rule", true, "irrelevant-etag", false, "irrelevant-hash", scopeOf, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(JSON.stringify({ error: outcome.error })).not.toContain("Infinity");
      expect(outcome.error).not.toContain("Infinity");
      expect(outcome.error).not.toContain("NaN");
    }
  });

  test("the scope cache expires after its TTL: a call after the TTL elapses hits the previewer again (fresh clock, no real timers)", async () => {
    let now = 0;
    let calls = 0;
    const underlying = async (_id: string): Promise<number> => { calls++; return calls; };
    const cached = createScopeCache(underlying, { ttlMs: 10_000, now: () => now });
    expect(await cached("ui-first-rule", "project = BUTCHR")).toBe(1);
    now += 5_000; // within TTL
    expect(await cached("ui-first-rule", "project = BUTCHR")).toBe(1); // cache hit, no new call
    expect(calls).toBe(1);
    now += 6_000; // now 11s since the first call — TTL elapsed
    expect(await cached("ui-first-rule", "project = BUTCHR")).toBe(2);
    expect(calls).toBe(2);
  });

  test("the scope cache is per-rule-id: a cached value for one rule never leaks to a different rule", async () => {
    let now = 0;
    const underlying = async (id: string): Promise<number> => (id === "a" ? 1 : 2);
    const cached = createScopeCache(underlying, { ttlMs: 10_000, now: () => now });
    expect(await cached("a", "query a")).toBe(1);
    expect(await cached("b", "query b")).toBe(2);
  });

  describe("N4 (FACTORY-685, agentsafety audit #50): keyed by rule id + query hash, invalidated on write/reload", () => {
    test("GO-RED CONTROL: keyed by id alone, a widened query within the TTL still answers with the STALE scope — proves the mechanism the fix closes", async () => {
      // The OLD (pre-fix) shape: a cache keyed by id alone, ignoring the query entirely.
      let now = 0;
      let answer = 3;
      const oldStyleCache = new Map<string, { scope: number; at: number }>();
      const oldStyleCachedScopeOf = async (id: string): Promise<number> => {
        const cached = oldStyleCache.get(id);
        if (cached !== undefined && now - cached.at < 10_000) return cached.scope;
        const scope = answer;
        oldStyleCache.set(id, { scope, at: now });
        return scope;
      };
      expect(await oldStyleCachedScopeOf("ui-first-rule")).toBe(3);
      answer = 40; // the query widened
      now += 2_300; // well within the 10s TTL
      expect(await oldStyleCachedScopeOf("ui-first-rule")).toBe(3); // STALE — the bug
    });

    test("a widened query within the TTL gets its OWN cache entry — never the stale scope from the old query", async () => {
      let now = 0;
      const scopeByQuery = new Map<string, number>([["project = A", 3], ["project = B", 40]]);
      let calls = 0;
      const liveQuery = { current: "project = A" };
      const realUnderlying = async (_id: string): Promise<number> => { calls++; return scopeByQuery.get(liveQuery.current)!; };
      const realCached = createScopeCache(realUnderlying, { ttlMs: 10_000, now: () => now });
      expect(await realCached("ui-first-rule", liveQuery.current)).toBe(3);
      expect(calls).toBe(1);
      now += 2_300; // within TTL
      liveQuery.current = "project = B"; // the query widened — this is the repro
      expect(await realCached("ui-first-rule", liveQuery.current)).toBe(40); // fresh call, NOT the stale 3
      expect(calls).toBe(2);
      // The ORIGINAL query, still within ITS OWN TTL window, still answers from its own cache entry.
      expect(await realCached("ui-first-rule", "project = A")).toBe(3);
      expect(calls).toBe(2); // no third underlying call — the original entry is still live
    });

    test("end-to-end repro (the ticket's own acceptance test): plan on a 3-ticket query, widen to 40, plan again WITHIN the TTL — scope is 40, and ceiling/confirm logic applies to 40", async () => {
      const rule = { id: "ui-first-rule", enabled: false, resourceProvider: "jira-work" as const, query: "project = A", brief: "do the thing", execution: "swarm" as const, account: "none" as const, role: "worker" as const };
      seed([rule]);
      const deps = { env: env() };
      let now = 0;
      const previewer = async (_id: string): Promise<number> => { const { readFileSync: rfs } = require("node:fs") as typeof import("node:fs"); const text = rfs(rulesFilePath(), "utf8"); const q = JSON.parse(text).rules[0].query as string; return q === "project = A" ? 3 : 40; };
      const scopeOf = createScopeCache(previewer, { ttlMs: 10_000, now: () => now });

      const plan1 = await planRuleWrite("ui-first-rule", { enabled: true }, false, scopeOf, deps);
      expect(plan1.ok).toBe(true);
      if (plan1.ok) { expect(plan1.scope).toBe(3); expect(plan1.requiresConfirm).toBe(true); } // swarm-enable gate, even at scope 3

      // Widen the query — a real write (through writeRuleFields would also
      // call `scopeOf.clear()` via `deps.reload`; here the query changes
      // WITHOUT any write at all, proving the fix is the cache KEY, not
      // just the invalidation-on-write belt-and-suspenders).
      const { writeFileSync: wfs } = require("node:fs") as typeof import("node:fs");
      wfs(rulesFilePath(), JSON.stringify({ rules: [{ ...rule, query: "project = B" }] }, null, 2) + "\n");

      now += 2_300; // well within the cache's 10s TTL
      const plan2 = await planRuleWrite("ui-first-rule", { enabled: true }, false, scopeOf, deps);
      expect(plan2.ok).toBe(true);
      if (plan2.ok) {
        expect(plan2.scope).toBe(40); // NOT the stale 3
        expect(plan2.requiresConfirm).toBe(true);
        expect(plan2.confirmReason).toBe("scope-ceiling"); // 40 > ENABLE_SCOPE_CEILING now applies too
      }
    });

    test("clear() drops every cached entry — the daemon wires this into every reload/write path (src/daemon/index.ts)", async () => {
      let now = 0;
      let calls = 0;
      const underlying = async (_id: string): Promise<number> => { calls++; return calls; };
      const cached = createScopeCache(underlying, { ttlMs: 10_000, now: () => now });
      expect(await cached("ui-first-rule", "project = A")).toBe(1);
      expect(calls).toBe(1);
      cached.clear();
      expect(await cached("ui-first-rule", "project = A")).toBe(2); // fresh call despite being well within the TTL
      expect(calls).toBe(2);
    });
  });
});
