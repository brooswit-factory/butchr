import { describe, expect, test } from "bun:test";
import {
  buildQueryAgentInventory, loadRulesFileState, ruleHasLiveAgent, ruleStaffingReason,
  type RulesFileState,
} from "../../src/agents/query-agent-inventory.js";
import type { Rule } from "../../src/rules/rules.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";
import {
  createDashboardFeed, initialDashboardSnapshot,
  type AdmissionView, type AgentDashboardRow, type DashboardResponse, type WithheldDashboardRow,
} from "../../src/agents/dashboard.js";
import { createAdmissionController } from "../../src/agents/admission.js";
import { StatusFloorTracker } from "../../src/agents/status-floor.js";

// ---- fixtures --------------------------------------------------------

function rule(over: Partial<Rule> & Pick<Rule, "id" | "resourceProvider">): Rule {
  return { enabled: true, query: "q", brief: "b", execution: "swarm", role: "worker", ...over };
}

// FACTORY-340: every source a rule in THIS file's fixtures can be covered by
// (jira-work -> "issue", plus github-issue/jira-idea/filesystem verbatim —
// see `RULE_ADMISSION_SOURCE`, ../../src/agents/query-agent-inventory.ts),
// declared and reported this poll — a real healthy daemon's admission view,
// not an empty one. Declaring these HONESTLY (rather than leaving `sources`
// empty, which after this ticket's fix now reads as "absent from the
// census" -> COULD NOT CHECK for every rule below) keeps every test that
// isn't specifically about an unavailable/absent admission source exercising
// the plain "no matching resources" / "admission cap" paths it always meant
// to exercise. The declined/never-reported/absent cases below build their
// own `AdmissionView` deliberately instead of using this one.
const allCoveredSourcesReported: AdmissionView = {
  cap: 10, residency: 0, sentinels: 0,
  sources: ["issue", "github-issue", "jira-idea", "filesystem"].map((source) => ({ source, census: { checked: true, confirmedAt: new Date(0).toISOString() } })),
};
const floor = { sinceMs: 0, since: new Date(0).toISOString(), humanDuration: "0s", exact: true };

function checkedDashboard(rows: DashboardResponse["rows"] = []): DashboardResponse {
  return { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: allCoveredSourcesReported };
}
function uncheckedDashboard(): DashboardResponse {
  return { checked: false, declinedAt: new Date(0).toISOString(), rows: [], admission: allCoveredSourcesReported };
}
function agentRow(resourceKey: string): AgentDashboardRow {
  return { kind: "agent", resourceKey, tier: { kind: "project" }, agentStatus: "working", pane: "p1", timeInStatus: floor, confirmedAt: new Date(0).toISOString() };
}
function withheldRow(resourceKey: string, source = "issue"): WithheldDashboardRow {
  return { kind: "withheld", resourceKey, tier: { kind: "project" }, source, waiting: floor, confirmedAt: new Date(0).toISOString(), agentFields: { applicable: false, reason: "no agent: withheld by the admission cap" } };
}

const noConfigReason = () => null;

// ---- ruleStaffingReason ------------------------------------------------

describe("ruleStaffingReason — the real, computed vocabulary (FACTORY-72)", () => {
  test("a disabled rule reports staffed:false, reason:'disabled', regardless of everything else", () => {
    const r = rule({ id: "project-managers", resourceProvider: "jira-work", enabled: false });
    const result = ruleStaffingReason(r, { configReason: "should never be reached", live: new Set([`jira-work:${r.id}`]), withheld: new Set(), dashboardChecked: true, admissionSourceCensus: undefined });
    expect(result).toEqual({ staffed: false, reason: "disabled" });
  });

  test("a missing-token/config reason (reused verbatim from the caller's own githubIssueStaffing/zendeskTicketStaffing) wins over live/withheld state", () => {
    const r = rule({ id: "gh-triage", resourceProvider: "github-issue" });
    const reason = "github-issue rules not staffed (gh-triage): set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS";
    const result = ruleStaffingReason(r, { configReason: reason, live: new Set(), withheld: new Set(), dashboardChecked: true, admissionSourceCensus: undefined });
    expect(result).toEqual({ staffed: false, reason });
  });

  test("a live agent (an ordinary swarm per-resource match) reports staffed:true, reason:null", () => {
    const r = rule({ id: "my-ideas", resourceProvider: "jira-idea" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(["jira-idea:my-ideas"]), withheld: new Set(), dashboardChecked: true, admissionSourceCensus: undefined });
    expect(result).toEqual({ staffed: true, reason: null });
  });

  test("a live query-level agent (singleton/persistent) also reports staffed:true — the live-key set carries no 'kind' distinction, by design", () => {
    const r = rule({ id: "director", resourceProvider: "filesystem", execution: "persistent" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(["filesystem:director"]), withheld: new Set(), dashboardChecked: true, admissionSourceCensus: undefined });
    expect(result.staffed).toBe(true);
  });

  test("a matched-but-withheld resource reports the admission-cap reason", () => {
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(), withheld: new Set(["jira-work:task"]), dashboardChecked: true, admissionSourceCensus: undefined });
    expect(result.staffed).toBe(false);
    expect(result.reason).toContain("admission cap");
  });

  test("FACTORY-132: when the agent census is unavailable, reports staffed:null (could-not-check) rather than a false 'not staffed'", () => {
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(), withheld: new Set(), dashboardChecked: false, admissionSourceCensus: undefined });
    expect(result.staffed).toBeNull();
    expect(result.reason).toContain("census unavailable");
    expect(result.reason).not.toBeNull();
  });

  test("a genuine, observed zero for a swarm rule is worded as 'no matching resources'", () => {
    const r = rule({ id: "task", resourceProvider: "jira-work", execution: "swarm" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(), withheld: new Set(), dashboardChecked: true, admissionSourceCensus: undefined });
    expect(result.reason).toBe("no matching resources this poll");
  });

  test("a genuine, observed zero for a persistent rule is worded differently — 'no matches' is not quite the right claim for a query-level agent", () => {
    const r = rule({ id: "director", resourceProvider: "filesystem", execution: "persistent" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(), withheld: new Set(), dashboardChecked: true, admissionSourceCensus: undefined });
    expect(result.reason).toBe("no live agent observed for this rule this poll");
  });

  // FACTORY-340: `admissionSourceCensus: { source, absent: true }` — the
  // rule's own covering admission source was never even DECLARED this poll,
  // as distinct from `{ source, census: { checked: false, ... } }` (declared
  // but declined/never-reported, FACTORY-136's own case). The epic reviewer
  // found this reachable in a real daemon for `github-pr` specifically (no
  // `config.github`) — this test isolates the general safety argument (ANY
  // provider, no config-reason of its own) from that one provider's specific
  // fix (see the config-reason test above it and app.test.ts's own FACTORY-
  // 340 end-to-end test for the github-pr-specific path, which now exits
  // earlier via `configReason` instead). Fails if `ruleStaffingReason`'s
  // `"absent" in deps.admissionSourceCensus` branch is reverted: `staffed`
  // would read `false` with the misleading "no matching resources this
  // poll" instead of `null` naming the absent source.
  test("FACTORY-340: an admission source ABSENT from the census (never declared, not merely unchecked) reports staffed:null naming the source, never a false 'no matching resources'", () => {
    const r = rule({ id: "review-prs", resourceProvider: "github-pr" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(), withheld: new Set(), dashboardChecked: true, admissionSourceCensus: { source: "github-pr", absent: true } });
    expect(result.staffed).toBeNull();
    expect(result.reason).not.toBeNull();
    expect(result.reason).toContain("census unavailable");
    expect(result.reason).toContain("github-pr");
    expect(result.reason).not.toBe("no matching resources this poll");
    expect(result.reason).not.toContain("UNSTAFFED");
  });
});

// ---- ruleHasLiveAgent (FACTORY-932, pinning FACTORY-731's own doc comment) --

describe("ruleHasLiveAgent — DELETE /api/rules/:id's own live-agent refusal check (FACTORY-932)", () => {
  test("a live row whose decoded key names this ruleId: true", () => {
    const rows = [agentRow(encodeAgentKey({ resourceProvider: "jira-work", ruleId: "managers", resourceId: "KAN-1" }))];
    expect(ruleHasLiveAgent("managers", rows)).toBe(true);
  });

  test("a live query-level (persistent) row also counts: true — this check has no 'kind' distinction of its own, same as ruleStaffingReason's live set", () => {
    const rows = [agentRow(encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "director" }))];
    expect(ruleHasLiveAgent("director", rows)).toBe(true);
  });

  test("no row at all: false", () => {
    expect(ruleHasLiveAgent("managers", [])).toBe(false);
  });

  test("a row naming a DIFFERENT ruleId: false — never matched loosely by resourceProvider alone", () => {
    const rows = [agentRow(encodeAgentKey({ resourceProvider: "jira-work", ruleId: "other-rule", resourceId: "KAN-1" }))];
    expect(ruleHasLiveAgent("managers", rows)).toBe(false);
  });

  // The doc comment's own explicit carve-out: a withheld row is matched but
  // NOT live (held back by the fleet-wide admission cap) — this check only
  // ever asks "is an agent actually RUNNING against this rule right now",
  // so it must skip a withheld row even when its decoded ruleId matches,
  // same as `liveAndWithheldRuleKeys` keeps `live`/`withheld` as two
  // disjoint sets rather than folding a withheld match into "has an agent".
  test("a withheld row (kind: 'withheld') naming this ruleId is skipped: false — matched-but-withheld is not 'live'", () => {
    const rows = [withheldRow(encodeAgentKey({ resourceProvider: "jira-work", ruleId: "managers", resourceId: "KAN-1" }))];
    expect(ruleHasLiveAgent("managers", rows)).toBe(false);
  });

  // THE DOCUMENTED RACE ITSELF, pinned rather than papered over: `rows` is
  // a snapshot from the daemon's own periodic poll (`createDashboardFeed`),
  // not a live, synchronous census. An agent that was spawned for this rule
  // AFTER the snapshot `rows` was taken has no row in it yet, so this
  // function reads it as "no live agent" — a false NEGATIVE, exactly the
  // "could let a delete through while an agent is, in fact, about to start
  // running" window the function's own doc comment names and accepts. This
  // is not distinguishable, from inside `ruleHasLiveAgent`'s own signature,
  // from the ordinary "genuinely no agent" case directly above — which is
  // the whole point: the signal is a last-poll snapshot, never authoritative
  // for "right now", and the test above and this one are deliberately
  // identical in shape to pin that.
  test("a stale/empty snapshot reads as 'no live agent' even when an agent could have been spawned for this rule since the last poll — the documented one-poll-interval false-negative race, not a bug to fix here", () => {
    const staleSnapshotTakenBeforeTheAgentSpawned: ReturnType<typeof agentRow>[] = [];
    expect(ruleHasLiveAgent("managers", staleSnapshotTakenBeforeTheAgentSpawned)).toBe(false);
  });

  test("a row for one ruleId plus a withheld row for another: only the genuinely live one counts", () => {
    const rows = [
      agentRow(encodeAgentKey({ resourceProvider: "jira-work", ruleId: "managers", resourceId: "KAN-1" })),
      withheldRow(encodeAgentKey({ resourceProvider: "jira-work", ruleId: "watchers", resourceId: "KAN-2" })),
    ];
    expect(ruleHasLiveAgent("managers", rows)).toBe(true);
    expect(ruleHasLiveAgent("watchers", rows)).toBe(false);
  });
});

// ---- loadRulesFileState (rules-file load/parse errors) -----------------

describe("loadRulesFileState — a malformed rules file alongside a good one (FACTORY-72 DoD)", () => {
  const env = { BUTCHR_RULES_FILE: "/config/rules.json" };

  test("a malformed rules file (invalid JSON) is captured as an error, never thrown, never swallowed", () => {
    const state = loadRulesFileState(env, () => "not json at all");
    expect(state.rules).toEqual([]);
    expect(state.error).not.toBeNull();
    expect(state.error!.path).toBe("/config/rules.json");
    expect(state.error!.message).toContain("invalid JSON");
  });

  test("a malformed rules file (schema violation) is captured as an error with the real validation message", () => {
    const state = loadRulesFileState(env, () => JSON.stringify({ rules: [{ id: "x", resourceProvider: "not-a-provider", query: "q", brief: "b" }] }));
    expect(state.rules).toEqual([]);
    expect(state.error).not.toBeNull();
    expect(state.error!.message).toContain("resourceProvider must be one of");
  });

  test("a good rules file alongside it loads cleanly, error: null — the same function, two independent outcomes", () => {
    const state = loadRulesFileState(env, () => JSON.stringify({ rules: [{ id: "my-ideas", resourceProvider: "jira-idea", query: "q", brief: "A real brief sentence." }] }));
    expect(state.error).toBeNull();
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]!.id).toBe("my-ideas");
  });
});

// ---- buildQueryAgentInventory: rules -----------------------------------

describe("buildQueryAgentInventory — rules section (FACTORY-72)", () => {
  test("the config set the epic names: disabled project-managers/mud-manager, a staffed my-ideas rule", async () => {
    const rules = [
      rule({ id: "project-managers", resourceProvider: "jira-work", enabled: false }),
      rule({ id: "mud-manager", resourceProvider: "filesystem", enabled: false }),
      rule({ id: "my-ideas", resourceProvider: "jira-idea" }),
    ];
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules, error: null },
      dashboard: checkedDashboard([agentRow(encodeAgentKey({ resourceProvider: "jira-idea", ruleId: "my-ideas", resourceId: "IDEAS-1" }))]),
      configReasonFor: noConfigReason,
    });
    const byId = new Map(inventory.rules.map((r) => [r.id, r]));
    expect(byId.get("project-managers")).toMatchObject({ enabled: false, staffed: false, reason: "disabled" });
    expect(byId.get("mud-manager")).toMatchObject({ enabled: false, staffed: false, reason: "disabled" });
    expect(byId.get("my-ideas")).toMatchObject({ enabled: true, staffed: true, reason: null });
  });

  test("agentPreferences (harness/model/effort — the rule-level tier stand-in), linkedEventing and mcpServerNames are copied field-by-field, never a spread of the raw Rule", async () => {
    const r = rule({
      id: "triage", resourceProvider: "jira-work",
      agentPreferences: [{ harness: "claude", model: "opus", effort: "high" }, { harness: "codex" }],
      linkedEventing: true,
      mcpServers: [{ name: "chat", type: "http", url: "https://mcp.internal/chat", headersEnvVar: "CHAT_SECRET_ENV", channel: true }],
    });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
    });
    const entry = inventory.rules[0]!;
    // Ranked order preserved; model/effort survive per-entry, absent where the rule never set one.
    expect(entry.agentPreferences).toEqual([{ harness: "claude", model: "opus", effort: "high" }, { harness: "codex" }]);
    expect(entry.linkedEventing).toBe(true);
    expect(entry.mcpServerNames).toEqual(["chat"]);
    expect(JSON.stringify(entry)).not.toContain("CHAT_SECRET_ENV");
    expect(JSON.stringify(entry)).not.toContain("mcp.internal");
  });

  test("the correlation identifier is (resourceProvider, id) — decodeAnyAgentKey on a spawned agent's key yields exactly this pair, for both a resource key and a query-level key", async () => {
    const swarmRule = rule({ id: "task", resourceProvider: "jira-work" });
    const persistentRule = rule({ id: "director", resourceProvider: "filesystem", execution: "persistent" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [swarmRule, persistentRule], error: null },
      dashboard: checkedDashboard([
        agentRow(encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "KAN-1" })),
        agentRow(encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "director" })),
      ]),
      configReasonFor: noConfigReason,
    });
    expect(inventory.rules.find((r) => r.id === "task")!.staffed).toBe(true);
    expect(inventory.rules.find((r) => r.id === "director")!.staffed).toBe(true);
  });

  test("FACTORY-407 (DoD 4): two DIFFERENT swarm rules matching the SAME resource are each staffed correctly by their OWN agent — never guessed from the shared resource id, which would be genuinely ambiguous", async () => {
    // The agent-key codec's own header: several rules may match one resource.
    // Each rule's own agent for that resource carries a key with THAT rule's
    // own ruleId baked in (never re-derived from the bare resource alone), so
    // two rules matching "KAN-1" resolve to two distinct, correctly-attributed
    // agents — no ambiguity, because correlation never goes through the bare
    // resource id at all.
    const ruleA = rule({ id: "triage", resourceProvider: "jira-work" });
    const ruleB = rule({ id: "watch", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [ruleA, ruleB], error: null },
      dashboard: checkedDashboard([
        agentRow(encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "KAN-1" })),
        // "watch" has NO agent for KAN-1 this poll — only "triage" does.
      ]),
      configReasonFor: noConfigReason,
    });
    expect(inventory.rules.find((r) => r.id === "triage")).toMatchObject({ staffed: true, reason: null });
    expect(inventory.rules.find((r) => r.id === "watch")).toMatchObject({ staffed: false, reason: "no matching resources this poll" });
  });

  test("a withheld row (admission cap) reaches all the way through the full buildQueryAgentInventory path, not just ruleStaffingReason in isolation", async () => {
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: checkedDashboard([withheldRow(encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "KAN-1" }))]),
      configReasonFor: noConfigReason,
    });
    expect(inventory.rules[0]).toMatchObject({ staffed: false, reason: "admission cap: matched resource(s) currently withheld by the fleet-wide agent cap" });
  });

  test("FACTORY-132: while the agent census is unavailable, every enabled rule reports staffed:null (could-not-check) end to end", async () => {
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: uncheckedDashboard(),
      configReasonFor: noConfigReason,
    });
    expect(inventory.rules[0]!.staffed).toBeNull();
    expect(inventory.rules[0]!.reason).toContain("census unavailable");
  });

  test("a rules-file load error surfaces in top-level errors, and rules is empty — never a daemon crash", async () => {
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [], error: { path: "/rules.json", message: "/rules.json: invalid JSON: Unexpected token o in JSON at position 1" } },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
    });
    expect(inventory.rules).toEqual([]);
    expect(inventory.errors).toEqual([{ path: "/rules.json", message: "/rules.json: invalid JSON: Unexpected token o in JSON at position 1" }]);
  });

  test("no secret ever appears anywhere in the serialized inventory — a fake env value inside a rule's MCP server binding, and a fake token inside a malformed rules file", async () => {
    const FAKE_TOKEN = "ghp_FAKESECRETTOKENabcdef1234567890";
    const FAKE_ENV_VALUE = "SUPER_SECRET_ENV_VALUE_998877";
    const rules = [rule({
      id: "bound-rule", resourceProvider: "jira-work",
      mcpServers: [{ name: "chat", type: "http", url: "https://mcp.internal/chat", headersEnvVar: FAKE_ENV_VALUE, channel: true }],
    })];
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules, error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
    });
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain(FAKE_ENV_VALUE);
    expect(inventory.rules[0]!.mcpServerNames).toEqual(["chat"]);
    // A malformed rules file whose raw content embeds a fake token: its error is
    // present (never swallowed), names the bad field, and never echoes the value.
    const malformedJson = JSON.stringify({
      rules: [{ id: "x", resourceProvider: "jira-work", query: "q", brief: "A real brief sentence.", unexpectedSecretField: FAKE_TOKEN }],
    });
    const broken = await buildQueryAgentInventory({
      rulesFile: loadRulesFileState({ BUTCHR_RULES_FILE: "/config/rules.json" }, () => malformedJson),
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
    });
    expect(broken.errors).toHaveLength(1);
    expect(broken.errors[0]!.message).toContain("unexpectedSecretField");
    expect(JSON.stringify(broken)).not.toContain(FAKE_TOKEN);
  });
});

// ---- buildQueryAgentInventory: resolved model/effort (FACTORY-120) -----

describe("buildQueryAgentInventory — resolved model/effort (FACTORY-120)", () => {
  test("a rule agentPreferences entry expressed via modelPower/effortPower, loaded through the REAL rules-file parse path, shows the resolved model/effort in the inventory", async () => {
    const rulesJson = JSON.stringify({
      rules: [
        {
          id: "power-rule", resourceProvider: "jira-work", query: "q", brief: "A real brief sentence.",
          agentPreferences: [{ harness: "claude", modelPower: 95, effortPower: 10 }],
        },
      ],
    });
    const rulesFile = loadRulesFileState({ BUTCHR_RULES_FILE: "/config/rules.json" }, () => rulesJson);
    expect(rulesFile.error).toBeNull(); // sanity: the fixture itself parses cleanly.
    const inventory = await buildQueryAgentInventory({
      rulesFile,
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
    });
    const entry = inventory.rules.find((r) => r.id === "power-rule")!;
    // Resolved ONCE at rules-load time (parsePreferences, src/rules/rules.ts) — this module
    // copies the already-resolved value verbatim; the raw modelPower/effortPower are dropped
    // there and never reach this inventory (out of scope for FACTORY-120, see the ticket).
    // Literal spot-check from power-scale.ts's own tables: modelPower 95 -> "fable" (85-100
    // band), effortPower 10 -> "low" (0-19 band).
    expect(entry.agentPreferences).toEqual([{ harness: "claude", model: "fable", effort: "low" }]);
  });
});

// ---- FACTORY-132: the census-unavailable tri-state, through a REAL --------
// createDashboardFeed (never a hand-assembled DashboardResponse) — AC5's own
// "real production code paths" requirement. `checkedDashboard`/
// `uncheckedDashboard` above stay for the OTHER describe blocks' own,
// already-passing coverage of `ruleStaffingReason` in isolation; this block
// additionally drives the real feed end to end.

/** Same harmless admission fixture as dashboard.test.ts's own `noWithholding()` — this block only exercises the agent.list()/census axis, never admission withholding. */
function noWithholding() {
  return createAdmissionController({ cap: 1_000_000, residency: async () => [] });
}

/**
 * FACTORY-340: `sources: ["issue", "jira-idea"]` declared up front (every
 * covering source a rule in this block's own tests uses — jira-work rules
 * resolve to "issue", jira-idea rules to "jira-idea", see
 * `RULE_ADMISSION_SOURCE`), and `admission` returned alongside `feed` so a
 * test can call `admission.admit(...)` for its rule's own covering source —
 * exactly what the real per-provider loop in `src/daemon/index.ts` does
 * every poll. Without an explicit `admit()` call, a source stays
 * `{checked: false, reason: "never-reported"}` forever, which (correctly,
 * after this ticket's fix) reads as COULD NOT CHECK rather than a genuine
 * zero — so a test that wants a genuine "no matching resources this poll"
 * outcome must report its source itself, same as a real daemon would.
 */
function realFeed(now: () => number) {
  const admission = createAdmissionController({ cap: 1_000_000, residency: async () => [], sources: ["issue", "jira-idea"], now });
  const feed = createDashboardFeed({ now, issueMeta: () => undefined, tracker: new StatusFloorTracker(now), withheldTracker: new StatusFloorTracker(now), admission: () => admission.census() });
  return { feed, admission };
}

describe("buildQueryAgentInventory — the census-unavailable tri-state through a REAL createDashboardFeed (FACTORY-132)", () => {
  test("before any poll has ever run, an enabled rule with no match reports staffed:null, reason mentioning 'census unavailable' — never UNSTAFFED", async () => {
    const { feed: f } = realFeed(() => 0);
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: f.snapshot(),
      configReasonFor: noConfigReason,
    });
    expect(inventory.rules[0]!.staffed).toBeNull();
    expect(inventory.rules[0]!.reason).toContain("census unavailable");
    expect(JSON.stringify(inventory)).not.toContain("UNSTAFFED");
  });

  test("a poll that fails AFTER an earlier good poll ALSO reports staffed:null for a rule with no match, with the IDENTICAL reason text as never-polled-at-all — the 'true in both cases' requirement", async () => {
    let now = 1000;
    const { feed: f, admission } = realFeed(() => now);
    const r = rule({ id: "task", resourceProvider: "jira-work" }); // never matches any agent below

    await admission.admit([], [], "issue"); // the "issue" admission source itself also reports zero, same as a real daemon poll — BEFORE f.poll(), since `feed.snapshot()` only re-reads `admission.census()` at poll time, not live
    await f.poll(async () => ({ agents: [] })); // a genuine, observed zero
    const observedZero = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: f.snapshot(),
      configReasonFor: noConfigReason,
    });
    expect(observedZero.rules[0]).toMatchObject({ staffed: false, reason: "no matching resources this poll" });

    now = 5000;
    await expect(f.poll(async () => { throw new Error("agent.list: connection closed"); })).rejects.toThrow("agent.list: connection closed");
    expect(f.snapshot().checked).toBe(false); // the most recent poll failed

    const staleInventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: f.snapshot(),
      configReasonFor: noConfigReason,
    });
    expect(staleInventory.rules[0]!.staffed).toBeNull();
    const staleReason = staleInventory.rules[0]!.reason;
    expect(staleReason).toContain("census unavailable");

    const neverPolled = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: initialDashboardSnapshot(() => 0, noWithholding().census()),
      configReasonFor: noConfigReason,
    });
    // The exact wording this ticket's own DoD requires: identical whether
    // this daemon has never polled at all, or its most recent poll failed
    // after an earlier success — both are "the most recent poll did not
    // succeed", the one true claim covering both shapes.
    expect(neverPolled.rules[0]!.reason).toBe(staleReason);
  });

  test("a rule whose live agent row is carried forward STALE after a failed poll still reads staffed:true — 'agent wins' is unaffected by the tri-state change (the epic's own documented nuance, not a bug)", async () => {
    let now = 1000;
    const { feed: f } = realFeed(() => now);
    const r = rule({ id: "my-ideas", resourceProvider: "jira-idea" });
    const liveKey = encodeAgentKey({ resourceProvider: "jira-idea", ruleId: "my-ideas", resourceId: "IDEAS-1" });

    await f.poll(async () => ({ agents: [{ agent_key: liveKey, agent_status: "working", pane_id: "p1" }] }));
    const staffedNow = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: f.snapshot(),
      configReasonFor: noConfigReason,
    });
    expect(staffedNow.rules[0]).toMatchObject({ staffed: true, reason: null });

    now = 5000;
    await expect(f.poll(async () => { throw new Error("boom"); })).rejects.toThrow();
    expect(f.snapshot().checked).toBe(false);
    expect(f.snapshot().rows).toHaveLength(1); // carried forward, byte-identical

    const staleButStillLinked = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: f.snapshot(),
      configReasonFor: noConfigReason,
    });
    // NOT staffed:null — a matching live (if stale) row wins over an
    // unavailable census, exactly as AC3 documents for the render layer.
    expect(staleButStillLinked.rules[0]).toMatchObject({ staffed: true, reason: null });
  });

  test("after a successful poll following a failure, the same no-match rule transitions from staffed:null back to a known state — proving the discriminator is the real census flag, not an always-on message", async () => {
    let now = 1000;
    const { feed: f, admission } = realFeed(() => now);
    const r = rule({ id: "task", resourceProvider: "jira-work" });

    now = 5000;
    await expect(f.poll(async () => { throw new Error("boom"); })).rejects.toThrow();
    const unknown = await buildQueryAgentInventory({ rulesFile: { path: "/rules.json", rules: [r], error: null }, dashboard: f.snapshot(), configReasonFor: noConfigReason });
    expect(unknown.rules[0]!.staffed).toBeNull();

    now = 9000;
    await admission.admit([], [], "issue"); // the "issue" admission source itself also reports zero, same as a real daemon poll — BEFORE f.poll(), since `feed.snapshot()` only re-reads `admission.census()` at poll time, not live
    await f.poll(async () => ({ agents: [] })); // recovers — a genuine, observed zero
    const recovered = await buildQueryAgentInventory({ rulesFile: { path: "/rules.json", rules: [r], error: null }, dashboard: f.snapshot(), configReasonFor: noConfigReason });
    expect(recovered.rules[0]).toMatchObject({ staffed: false, reason: "no matching resources this poll" });
  });

  test("FACTORY-407 (DoD 2): a matched-but-withheld resource reaches staffed:false/'admission cap' end to end through the REAL admission controller + createDashboardFeed — never just a hand-built WithheldDashboardRow", async () => {
    // The admission census's own withheld-key shape is verified here rather
    // than assumed: `admission.admit()` is called with the SAME full
    // agent-key shape `unitAgentKey` (src/rules/execution.ts) produces for a
    // real rule loop's candidates — proving `updateWithheldRows` and
    // `liveAndWithheldRuleKeys` actually line up on that shape now, not just
    // in a fixture that happens to typecheck.
    const now = 1000;
    const admission = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue"], now: () => now });
    const feed = createDashboardFeed({ now: () => now, issueMeta: () => undefined, tracker: new StatusFloorTracker(() => now), withheldTracker: new StatusFloorTracker(() => now), admission: () => admission.census() });
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const candidate = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "KAN-9" });

    await admission.admit([candidate], [], "issue"); // cap 0 -> withheld
    await feed.poll(async () => ({ agents: [] }));
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: feed.snapshot(),
      configReasonFor: noConfigReason,
    });
    expect(inventory.rules[0]).toMatchObject({ staffed: false, reason: "admission cap: matched resource(s) currently withheld by the fleet-wide agent cap" });
  });

  test("AC4 control: a disabled rule stays 'disabled' even while the agent census is unavailable — a config fact, not a census fact", () => {
    const r = rule({ id: "project-managers", resourceProvider: "jira-work", enabled: false });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(), withheld: new Set(), dashboardChecked: false, admissionSourceCensus: undefined });
    expect(result).toEqual({ staffed: false, reason: "disabled" });
  });

  test("AC4 control: a provider config-reason rule keeps that reason even while the agent census is unavailable — a config fact, not a census fact", () => {
    const r = rule({ id: "gh-triage", resourceProvider: "github-issue" });
    const reason = "github-issue rules not staffed (gh-triage): set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS";
    const result = ruleStaffingReason(r, { configReason: reason, live: new Set(), withheld: new Set(), dashboardChecked: false, admissionSourceCensus: undefined });
    expect(result).toEqual({ staffed: false, reason });
  });
});

// ---- FACTORY-136: the admission-source-unavailable tri-state, through -----
// REAL createDashboardFeed + createAdmissionController (never a hand-built
// AdmissionView) — same "real production code paths" bar the FACTORY-132
// block above already sets, extended to the SECOND census this ticket closes
// the gap for. Each test here fails if the `admissionSourceCensus` branch in
// `ruleStaffingReason` is reverted: `staffed` would read `false` with reason
// "no matching resources this poll" instead of `null` naming the source.

describe("buildQueryAgentInventory — the admission-source-unavailable tri-state through REAL createDashboardFeed + createAdmissionController (FACTORY-136)", () => {
  function feedWithAdmission(now: () => number, sources: readonly string[], residency: () => Promise<readonly string[]> = async () => []) {
    const admission = createAdmissionController({ cap: 1_000_000, residency, sources, now });
    const feed = createDashboardFeed({ now, issueMeta: () => undefined, tracker: new StatusFloorTracker(now), withheldTracker: new StatusFloorTracker(now), admission: () => admission.census() });
    return { admission, feed };
  }

  test("(a) a DECLINED admission source (residency threw) covering the rule's provider reports staffed:null, naming the source and 'census-threw' — never the observed-zero wording", async () => {
    const now = () => 0;
    const { admission, feed } = feedWithAdmission(now, ["issue"], async () => { throw new Error("herdr down"); });
    await admission.admit(["I1"], [], "issue"); // fail-safe: records a decline, withholds nothing new
    await feed.poll(async () => ({ agents: [] }));
    expect(feed.snapshot().checked).toBe(true); // the AGENT census (agent.list()) is fine — only the admission source is down

    const r = rule({ id: "task", resourceProvider: "jira-work" }); // "jira-work" -> admission source "issue"
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: feed.snapshot(),
      configReasonFor: noConfigReason,
    });
    expect(inventory.rules[0]!.staffed).toBeNull();
    expect(inventory.rules[0]!.reason).toContain("census unavailable");
    expect(inventory.rules[0]!.reason).toContain("issue");
    expect(inventory.rules[0]!.reason).toContain("census-threw");
    expect(JSON.stringify(inventory)).not.toContain("UNSTAFFED");
    expect(inventory.rules[0]!.reason).not.toBe("no matching resources this poll");
  });

  test("(b) a NEVER-REPORTED admission source (declared at construction, admit() never called for it) covering the rule's provider reports staffed:null, naming 'never-reported'", async () => {
    const { feed } = feedWithAdmission(() => 0, ["issue"]);
    await feed.poll(async () => ({ agents: [] })); // agent census succeeds; the "issue" admission bucket never reports
    expect(feed.snapshot().checked).toBe(true);
    const bucket = feed.snapshot().admission.sources.find((s) => s.source === "issue");
    if (!bucket || bucket.census.checked) throw new Error("expected the issue source to still read never-reported");
    expect(bucket.census.reason).toBe("never-reported");

    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: feed.snapshot(),
      configReasonFor: noConfigReason,
    });
    expect(inventory.rules[0]!.staffed).toBeNull();
    expect(inventory.rules[0]!.reason).toContain("census unavailable");
    expect(inventory.rules[0]!.reason).toContain("never-reported");
  });

  // FACTORY-340: DISTINCT from (b) — this source was never even DECLARED at
  // admission-controller construction (not in `sources` at all), the real
  // `github-pr`-without-`config.github` shape (`src/daemon/index.ts` omits
  // `ADMISSION_SOURCE_GITHUB_PR` from its `sources:` list entirely in that
  // case). Drives this through `admissionSourceCensusFor` itself (via a real
  // `AdmissionView`), not a hand-built `RuleStaffingDeps` — fails if that
  // function's "absent" branch is reverted to returning bare `undefined`
  // (which `ruleStaffingReason` treats as "no problem", collapsing back to
  // the original UNSTAFFED defect this ticket fixes).
  test("(e) FACTORY-340: an admission source entirely ABSENT (never declared) covering the rule's provider reports staffed:null, naming the source as not present in the census", async () => {
    const { feed } = feedWithAdmission(() => 0, ["issue"]); // "github-pr" never declared
    await feed.poll(async () => ({ agents: [] }));
    expect(feed.snapshot().checked).toBe(true);
    expect(feed.snapshot().admission.sources.find((s) => s.source === "github-pr")).toBeUndefined();

    const r = rule({ id: "review-prs", resourceProvider: "github-pr" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: feed.snapshot(),
      configReasonFor: noConfigReason,
    });
    expect(inventory.rules[0]!.staffed).toBeNull();
    expect(inventory.rules[0]!.reason).toContain("census unavailable");
    expect(inventory.rules[0]!.reason).toContain("github-pr");
    expect(JSON.stringify(inventory)).not.toContain("UNSTAFFED");
    expect(inventory.rules[0]!.reason).not.toBe("no matching resources this poll");
  });

  test("(c) control: a rule whose covering admission source DID report this poll keeps today's behaviour exactly — a genuine observed zero, UNSTAFFED-worded, never null", async () => {
    const now = () => 0;
    const { admission, feed } = feedWithAdmission(now, ["issue"]);
    await admission.admit(["I1"], [], "issue"); // the "issue" source reports — census.checked becomes true
    await feed.poll(async () => ({ agents: [] }));
    const bucket = feed.snapshot().admission.sources.find((s) => s.source === "issue");
    if (!bucket || !bucket.census.checked) throw new Error("expected the issue source to read checked:true");

    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: feed.snapshot(),
      configReasonFor: noConfigReason,
    });
    expect(inventory.rules[0]).toMatchObject({ staffed: false, reason: "no matching resources this poll" });
  });

  test("(d) a withheld row present for the rule STILL wins even though its covering admission source is unchecked THIS poll — 'admission cap' wins over the new could-not-check branch, same 'agent/withheld wins' contract BUTCHR-332 already established", async () => {
    let now = 0;
    let issueBroken = false;
    const admission = createAdmissionController({
      cap: 0, // saturated — anything named is withheld, isolating this test from admission arithmetic
      residency: async () => { if (issueBroken) throw new Error("herdr down"); return []; },
      sources: ["issue"],
      now: () => now,
    });
    const feed = createDashboardFeed({
      now: () => now,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => now),
      withheldTracker: new StatusFloorTracker(() => now),
      admission: () => admission.census(),
    });

    const withheldKey = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "PROJ-1" });
    await admission.admit([withheldKey], [], "issue");
    await feed.poll(async () => ({ agents: [] }));
    expect(feed.snapshot().rows.some((row) => row.kind === "withheld" && row.resourceKey === withheldKey)).toBe(true);

    // The "issue" source now declines — its prior withheld row must carry forward byte-identical (BUTCHR-332's own contract) rather than being dropped.
    issueBroken = true;
    now = 5000;
    await admission.admit([withheldKey], [], "issue"); // fail-safe: records a decline, withholds nothing new
    await feed.poll(async () => ({ agents: [] }));
    const bucket = feed.snapshot().admission.sources.find((s) => s.source === "issue");
    if (!bucket || bucket.census.checked) throw new Error("expected the issue source to have declined this poll");
    expect(feed.snapshot().rows.some((row) => row.kind === "withheld" && row.resourceKey === withheldKey)).toBe(true);

    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: feed.snapshot(),
      configReasonFor: noConfigReason,
    });
    expect(inventory.rules[0]!.staffed).toBe(false);
    expect(inventory.rules[0]!.reason).toContain("admission cap");
  });
});
