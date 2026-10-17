/**
 * local/ui — Review and save for the Rules page
 * (`dashboard-app/src/view-model/rules-save.ts`), run against the in-memory
 * fixtures API, which replays the real server's plan/confirm gates.
 */
import { describe, expect, test } from "bun:test";
import { createFixturesRulesApi, PLACEHOLDER_QUERY, RateLimitError, type RuleDto, type RulePlanResponse } from "../../dashboard-app/src/api/rules.js";
import { computeRuleChanges, initialDraftState, newDraftKey, rulesDraftReducer, type RulesDraftAction, type RulesDraftState } from "../../dashboard-app/src/view-model/rules-draft.js";
import { changeTitle, describeError, impactText, needsAttention, planDrift, reviewChanges, saveChanges, savedBriefs } from "../../dashboard-app/src/view-model/rules-save.js";

function rule(overrides: Partial<RuleDto> = {}): RuleDto {
  return {
    id: "triage",
    resourceProvider: "jira-work",
    query: "project = A",
    enabled: false,
    execution: "swarm",
    role: "worker",
    agentPreferences: [{ harness: "claude" }],
    permissionMode: null,
    lizardMode: null,
    resumeOnRespawn: null,
    resumeContextCutoff: null,
    idlePokeMinutes: null,
    idlePokeMessage: null,
    idlePokeEnabled: true,
    notifyDeliveryMode: null,
    staffed: false,
    reason: "disabled",
    ...overrides,
  };
}

const plan = (overrides: Partial<RulePlanResponse> = {}): RulePlanResponse => ({ planHash: "h", spawned: 0, stopped: 0, restarted: 0, etag: "e", requiresConfirm: false, ...overrides });

async function setup(rules: RuleDto[], actions: RulesDraftAction[], opts: Parameters<typeof createFixturesRulesApi>[0] = {}) {
  const api = createFixturesRulesApi({ initial: { rules, errors: [] }, latencyMs: 0, ...opts });
  const listed = await api.listRules();
  const state: RulesDraftState = actions.reduce(rulesDraftReducer, initialDraftState(listed.rules, listed.sourceEtag));
  return { api, state, etag: listed.sourceEtag };
}

describe("reviewChanges", () => {
  test("an edited rule's enable is reviewed against its new query: a placeholder rule given a real query and turned on can be saved, and the save doesn't drift", async () => {
    const { api, state, etag } = await setup(
      [rule({ query: PLACEHOLDER_QUERY })],
      [{ type: "edit", key: "triage", changes: { query: "project = B", enabled: true } }],
      { previews: { triage: { total: 4, tickets: [] } as never }, previewsByQuery: { "triage:project = B": { total: 4, tickets: [] } as never } },
    );
    const changes = computeRuleChanges(state);
    expect(changes.map((c) => c.kind)).toEqual(["update", "enable"]);
    const reviewed = await reviewChanges(api, changes);
    const enable = reviewed.find((r) => r.change.kind === "enable")!;
    expect(enable.error).toBeUndefined();
    expect(enable.plan?.scopeCount).toBe(4);
    const outcome = await saveChanges(api, reviewed, etag);
    expect(outcome.steps.map((s) => [s.change.kind, s.status, s.error ?? null])).toEqual([["update", "saved", null], ["enable", "saved", null]]);
    expect(outcome.allSaved).toBe(true);
  });

  test("dry-runs every step without writing anything", async () => {
    const { api, state } = await setup(
      [rule(), rule({ id: "old" })],
      [
        { type: "edit", key: "triage", changes: { query: "project = B", enabled: true } },
        { type: "remove", key: "old" },
        { type: "add", resourceProvider: "jira-work" },
        { type: "edit", key: newDraftKey(1), changes: { id: "fresh", query: "project = C" } },
      ],
      { previews: { triage: { ruleId: "triage", total: 3, tickets: [{ key: "A-1" }, { key: "A-2" }, { key: "A-3" }] }, fresh: { ruleId: "fresh", total: 7, tickets: [] } } },
    );
    const before = await api.listRules();
    const reviewed = await reviewChanges(api, computeRuleChanges(state));
    expect(reviewed.map((r) => r.change.kind)).toEqual(["delete", "update", "create", "enable"]);
    expect(reviewed[1]?.plan?.confirmReason).toBe("query-change");
    expect(reviewed[2]?.createPlan?.scope).toBe(7);
    expect(reviewed[3]?.plan?.confirmReason).toBe("swarm-enable");
    expect(reviewed[3]?.ticketKeys).toEqual(["A-1", "A-2", "A-3"]);
    expect((await api.listRules()).sourceEtag).toBe(before.sourceEtag);
  });

  test("a refused dry run is reported on its step instead of throwing", async () => {
    const { api, state } = await setup([rule()], [{ type: "add", resourceProvider: "jira-work" }, { type: "edit", key: newDraftKey(1), changes: { id: "triage", query: "q" } }]);
    const [only] = await reviewChanges(api, computeRuleChanges(state));
    expect(only?.error).toContain("already exists");
  });

  test("a failing plan call becomes that step's error; an aborted review stops early", async () => {
    const { state } = await setup([rule()], [{ type: "edit", key: "triage", changes: { lizardMode: true } }]);
    const failing = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0, failWith: "daemon unreachable" });
    expect((await reviewChanges(failing, computeRuleChanges(state)))[0]?.error).toBe("daemon unreachable");
    const controller = new AbortController();
    controller.abort();
    expect(await reviewChanges(failing, computeRuleChanges(state), controller.signal)).toEqual([]);
  });
});

describe("saveChanges", () => {
  test("performs every step in order, chaining etags, and reports created ids", async () => {
    const { api, state, etag } = await setup(
      [rule({ id: "a", enabled: true }), rule({ id: "b" })],
      [
        { type: "edit", key: "a", changes: { enabled: false } },
        { type: "edit", key: "b", changes: { query: "project = Z", lizardMode: true } },
        { type: "add", resourceProvider: "github-pr" },
        { type: "edit", key: newDraftKey(1), changes: { id: "prs", query: "is:open" } },
      ],
    );
    const reviewed = await reviewChanges(api, computeRuleChanges(state));
    const outcome = await saveChanges(api, reviewed, etag);
    expect(outcome.allSaved).toBe(true);
    expect(outcome.steps.map((s) => `${s.change.kind}:${s.status}`)).toEqual(["disable:saved", "update:saved", "create:saved"]);
    expect(outcome.created).toEqual({ [newDraftKey(1)]: "prs" });
    const after = await api.listRules();
    expect(outcome.etag).toBe(after.sourceEtag);
    expect(after.rules.map((r) => [r.id, r.enabled, r.query])).toEqual([
      ["a", false, "project = A"],
      ["b", false, "project = Z"],
      ["prs", false, "is:open"],
    ]);
    expect(after.rules[1]?.lizardMode).toBe(true);
  });

  test("a stale starting etag is refused by the first write and the rest are skipped", async () => {
    const { api, state } = await setup([rule({ id: "a" }), rule({ id: "b" })], [
      { type: "edit", key: "a", changes: { lizardMode: true } },
      { type: "edit", key: "b", changes: { lizardMode: true } },
    ]);
    const reviewed = await reviewChanges(api, computeRuleChanges(state));
    const outcome = await saveChanges(api, reviewed, "someone-elses-etag");
    expect(outcome.allSaved).toBe(false);
    expect(outcome.steps.map((s) => s.status)).toEqual(["failed", "skipped"]);
    expect(outcome.steps[0]?.error).toContain("etag mismatch");
  });

  test("stops before writing when a step now needs a confirmation the review didn't show", async () => {
    const { api, state, etag } = await setup([rule({ id: "a", enabled: true })], [{ type: "edit", key: "a", changes: { idlePokeEnabled: false } }]);
    // Reviewed as harmless; the fresh plan (the rule is enabled, so changing it restarts its agent) disagrees.
    const reviewed = [{ change: computeRuleChanges(state)[0]!, plan: plan() }];
    const fresh = await api.planRule("a", { query: "project = NEW" }, false);
    expect(fresh.requiresConfirm).toBe(true);
    const outcome = await saveChanges(api, [{ change: { kind: "update", key: "a", ruleId: "a", patch: { query: "project = NEW" } }, plan: reviewed[0]!.plan }], etag);
    expect(outcome.steps[0]?.status).toBe("failed");
    expect(outcome.steps[0]?.error).toContain("Review again");
    expect((await api.listRules()).rules[0]?.query).toBe("project = A");
  });

  test("a write-time refusal is reported with the server's message", async () => {
    const { api, state, etag } = await setup([rule({ id: "a" })], [{ type: "edit", key: "a", changes: { lizardMode: true } }], { nextWriteError: "rules file is locked by another writer" });
    const outcome = await saveChanges(api, await reviewChanges(api, computeRuleChanges(state)), etag);
    expect(outcome.steps[0]).toMatchObject({ status: "failed", error: "rules file is locked by another writer" });
  });

  test("deletes go through with confirm, and a refused create is a failed step", async () => {
    const { api, state, etag } = await setup([rule({ id: "gone" })], [{ type: "remove", key: "gone" }]);
    const outcome = await saveChanges(api, await reviewChanges(api, computeRuleChanges(state)), etag);
    expect(outcome.allSaved).toBe(true);
    expect((await api.listRules()).rules).toEqual([]);
    const second = await saveChanges(api, [{ change: { kind: "create", key: "draft-9", ruleId: "dup", draft: { id: "dup", resourceProvider: "jira-work", query: "q" } } }], outcome.etag);
    expect(second.allSaved).toBe(true);
    const third = await saveChanges(api, [{ change: { kind: "create", key: "draft-10", ruleId: "dup", draft: { id: "dup", resourceProvider: "jira-work", query: "q" } } }], second.etag);
    expect(third.steps[0]).toMatchObject({ status: "failed" });
    expect(third.steps[0]?.error).toContain("already exists");
  });
});

describe("planDrift", () => {
  test("flags new confirmations and bigger blast radius only", () => {
    expect(planDrift(plan(), plan())).toBeNull();
    expect(planDrift(undefined, plan({ requiresConfirm: true }))).toContain("confirmation");
    expect(planDrift(undefined, plan())).toBeNull();
    expect(planDrift(plan({ requiresConfirm: true, confirmReason: "query-change" }), plan({ requiresConfirm: true, confirmReason: "query-change" }))).toBeNull();
    expect(planDrift(plan({ requiresConfirm: true, confirmReason: "query-change" }), plan({ requiresConfirm: true, confirmReason: "stop-restart" }))).toContain("stop-restart");
    expect(planDrift(plan({ scopeCount: 3 }), plan({ scopeCount: 4 }))).toContain("more");
    expect(planDrift(plan({ stopped: 1 }), plan({ stopped: 1 }))).toBeNull();
  });
});

describe("display helpers", () => {
  const change = { kind: "update" as const, key: "a", ruleId: "a", patch: {} };

  test("changeTitle covers every kind", () => {
    expect(changeTitle({ kind: "create", key: "k", ruleId: "", draft: { id: "", resourceProvider: "jira-work", query: "" } })).toBe("Create new rule");
    expect(changeTitle(change)).toBe("Update a");
    expect(changeTitle({ kind: "enable", key: "a", ruleId: "a" })).toBe("Turn on a");
    expect(changeTitle({ kind: "disable", key: "a", ruleId: "a" })).toBe("Turn off a");
    expect(changeTitle({ kind: "delete", key: "a", ruleId: "a" })).toBe("Delete a");
  });

  test("impactText words each confirm reason and the agent counts", () => {
    expect(impactText({ change, plan: plan({ requiresConfirm: true, confirmReason: "query-change", scopeCount: 1 }) })).toBe("The new query matches 1 ticket.");
    expect(impactText({ change, plan: plan({ requiresConfirm: true, confirmReason: "swarm-enable", spawned: 1, scopeCount: 12 }), ticketKeys: Array.from({ length: 10 }, (_, i) => `A-${i}`) })).toContain("Staffs up to 12 tickets: A-0");
    expect(impactText({ change, plan: plan({ requiresConfirm: true, confirmReason: "risky-permission" }) })).toContain("permission prompts");
    expect(impactText({ change, plan: plan({ requiresConfirm: true, confirmReason: "capacity-sentinel" }) })).toContain("agent cap");
    expect(impactText({ change, plan: plan({ requiresConfirm: true, confirmReason: "unmeasurable-scope" }) })).toContain("couldn't measure");
    expect(impactText({ change, plan: plan({ requiresConfirm: true, confirmReason: "stop-restart", stopped: 1, restarted: 2 }) })).toBe("Stops 1 agent, restarts 2 agents.");
    expect(impactText({ change, plan: plan({ spawned: 2 }) })).toBe("Starts 2 agents.");
    expect(impactText({ change, plan: plan() })).toBeNull();
    expect(impactText({ change })).toBeNull();
    expect(impactText({ change, error: "nope" })).toBeNull();
    const create = { kind: "create" as const, key: "k", ruleId: "n", draft: { id: "n", resourceProvider: "jira-work" as const, query: "q" } };
    expect(impactText({ change: create, createPlan: { planHash: "h", spawned: 0, stopped: 0, restarted: 0, scope: 2, etag: "e", requiresConfirm: true } })).toContain("matches 2 tickets");
    expect(impactText({ change: create, createPlan: { planHash: "h", spawned: 0, stopped: 0, restarted: 0, scope: null, scopeUnmeasurable: true, etag: "e", requiresConfirm: true } })).toContain("couldn't measure");
    expect(impactText({ change: create })).toBeNull();
    expect(impactText({ change: { kind: "delete", key: "a", ruleId: "a" } })).toContain("backup");
  });

  test("needsAttention and describeError", () => {
    expect(needsAttention({ change, plan: plan({ requiresConfirm: true }) })).toBe(true);
    expect(needsAttention({ change, plan: plan() })).toBe(false);
    expect(describeError(new RateLimitError("slow down", 12))).toBe("Too many changes. Try again in 12s.");
    expect(describeError(new RateLimitError("slow down", undefined))).toBe("slow down");
    expect(describeError("plain")).toBe("plain");
  });
});

describe("savedBriefs", () => {
  test("collects briefs from saved updates and creates only", () => {
    const saved = savedBriefs({
      steps: [
        { change: { kind: "update", key: "a", ruleId: "a", patch: { brief: "new a" } }, status: "saved" },
        { change: { kind: "update", key: "b", ruleId: "b", patch: { lizardMode: true } }, status: "saved" },
        { change: { kind: "create", key: "draft-1", ruleId: "c", draft: { id: "c", resourceProvider: "jira-work", query: "q" } }, status: "saved" },
        { change: { kind: "create", key: "draft-2", ruleId: "d", draft: { id: "d", resourceProvider: "jira-work", query: "q", brief: "dd" } }, status: "saved" },
        { change: { kind: "update", key: "e", ruleId: "e", patch: { brief: "never written" } }, status: "failed" },
      ],
    });
    expect(saved).toEqual({ a: "new a", c: "@builtin:task", d: "dd" });
  });
});
