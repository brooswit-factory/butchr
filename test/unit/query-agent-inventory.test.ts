import { describe, expect, test } from "bun:test";
import {
  buildQueryAgentInventory, loadRulesFileState, ruleStaffingReason,
  type RulesFileState,
} from "../../src/agents/query-agent-inventory.js";
import type { Rule } from "../../src/rules/rules.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";
import type { AdmissionView, AgentDashboardRow, DashboardResponse, WithheldDashboardRow } from "../../src/agents/dashboard.js";
import type { FilesystemQuery } from "../../src/resources/filesystem-query.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";
import type { SessionFreezeStore } from "../../src/resources/session-freeze.js";
import { sessionAgentKey } from "../../src/resources/session-freeze.js";

// ---- fixtures --------------------------------------------------------

function rule(over: Partial<Rule> & Pick<Rule, "id" | "resourceProvider">): Rule {
  return { enabled: true, query: "q", brief: "b", execution: "swarm", account: "none", role: "worker", ...over };
}

const noAdmissionView: AdmissionView = { cap: 10, residency: 0, sentinels: 0, sources: [] };
const floor = { sinceMs: 0, since: new Date(0).toISOString(), humanDuration: "0s", exact: true };

function checkedDashboard(rows: DashboardResponse["rows"] = []): DashboardResponse {
  return { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: noAdmissionView };
}
function uncheckedDashboard(): DashboardResponse {
  return { checked: false, declinedAt: new Date(0).toISOString(), rows: [], admission: noAdmissionView };
}
function agentRow(resourceKey: string): AgentDashboardRow {
  return { kind: "agent", resourceKey, tier: { kind: "project" }, agentStatus: "working", pane: "p1", timeInStatus: floor, confirmedAt: new Date(0).toISOString() };
}
function withheldRow(resourceKey: string, source = "issue"): WithheldDashboardRow {
  return { kind: "withheld", resourceKey, tier: { kind: "project" }, source, waiting: floor, confirmedAt: new Date(0).toISOString(), agentFields: { applicable: false, reason: "no agent: withheld by the admission cap" } };
}

const noRulesFile: RulesFileState = { path: "/rules.json", rules: [], error: null };
const noConfigReason = () => null;

function res(path: string, over: Partial<FilesystemResource> = {}): FilesystemResource {
  return { path, kind: "file", name: path.split("/").pop()!, size: 10, mtimeMs: 1000, ...over };
}

function fakeSessionDefinitions(byDir: Record<string, Record<string, string>>, frozenAgentKeys: Set<string> = new Set()) {
  const list = async (q: FilesystemQuery): Promise<FilesystemResource[]> => Object.keys(byDir[q.root] ?? {}).map((p) => res(p));
  const read = async (path: string): Promise<string> => {
    for (const files of Object.values(byDir)) if (path in files) return files[path]!;
    throw Object.assign(new Error(`ENOENT: no such file ${path}`), { code: "ENOENT" });
  };
  const store: SessionFreezeStore = {
    async read(id) { return { frozen: frozenAgentKeys.has(id) }; },
    async set(id, f) { if (f) frozenAgentKeys.add(id); else frozenAgentKeys.delete(id); },
  };
  return { activeDir: "/defs", archiveDir: "/defs-archive", list, read, store };
}

const goodDefinition = (over: Record<string, unknown> = {}) => JSON.stringify({
  workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default", ...over,
});

// ---- ruleStaffingReason ------------------------------------------------

describe("ruleStaffingReason — the real, computed vocabulary (FACTORY-72)", () => {
  test("a disabled rule reports staffed:false, reason:'disabled', regardless of everything else", () => {
    const r = rule({ id: "project-managers", resourceProvider: "jira-work", enabled: false });
    const result = ruleStaffingReason(r, { configReason: "should never be reached", live: new Set([`jira-work:${r.id}`]), withheld: new Set(), dashboardChecked: true });
    expect(result).toEqual({ staffed: false, reason: "disabled" });
  });

  test("a missing-token/config reason (reused verbatim from the caller's own githubIssueStaffing/zendeskTicketStaffing) wins over live/withheld state", () => {
    const r = rule({ id: "gh-triage", resourceProvider: "github-issue" });
    const reason = "github-issue rules not staffed (gh-triage): set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS";
    const result = ruleStaffingReason(r, { configReason: reason, live: new Set(), withheld: new Set(), dashboardChecked: true });
    expect(result).toEqual({ staffed: false, reason });
  });

  test("a live agent (an ordinary swarm per-resource match) reports staffed:true, reason:null", () => {
    const r = rule({ id: "my-ideas", resourceProvider: "jira-idea" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(["jira-idea:my-ideas"]), withheld: new Set(), dashboardChecked: true });
    expect(result).toEqual({ staffed: true, reason: null });
  });

  test("a live query-level agent (singleton/persistent) also reports staffed:true — the live-key set carries no 'kind' distinction, by design", () => {
    const r = rule({ id: "director", resourceProvider: "filesystem", execution: "persistent" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(["filesystem:director"]), withheld: new Set(), dashboardChecked: true });
    expect(result.staffed).toBe(true);
  });

  test("a matched-but-withheld resource reports the admission-cap reason", () => {
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(), withheld: new Set(["jira-work:task"]), dashboardChecked: true });
    expect(result.staffed).toBe(false);
    expect(result.reason).toContain("admission cap");
  });

  test("before the first successful poll, reports 'not yet observed' rather than a false 'no matches'", () => {
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(), withheld: new Set(), dashboardChecked: false });
    expect(result.staffed).toBe(false);
    expect(result.reason).toContain("not yet observed");
  });

  test("a genuine, observed zero for a swarm rule is worded as 'no matching resources'", () => {
    const r = rule({ id: "task", resourceProvider: "jira-work", execution: "swarm" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(), withheld: new Set(), dashboardChecked: true });
    expect(result.reason).toBe("no matching resources this poll");
  });

  test("a genuine, observed zero for a persistent rule is worded differently — 'no matches' is not quite the right claim for a query-level agent", () => {
    const r = rule({ id: "director", resourceProvider: "filesystem", execution: "persistent" });
    const result = ruleStaffingReason(r, { configReason: null, live: new Set(), withheld: new Set(), dashboardChecked: true });
    expect(result.reason).toBe("no live agent observed for this rule this poll");
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
      sessionDefinitions: fakeSessionDefinitions({}),
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
      mcpServers: [{ name: "rocketr", type: "http", url: "https://mcp.internal/rocketr", headersEnvVar: "ROCKETR_SECRET_ENV", accountHeader: "x-rocketr-account", channel: true }],
    });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: fakeSessionDefinitions({}),
    });
    const entry = inventory.rules[0]!;
    // Ranked order preserved; model/effort survive per-entry, absent where the rule never set one.
    expect(entry.agentPreferences).toEqual([{ harness: "claude", model: "opus", effort: "high" }, { harness: "codex" }]);
    expect(entry.linkedEventing).toBe(true);
    expect(entry.mcpServerNames).toEqual(["rocketr"]);
    expect(JSON.stringify(entry)).not.toContain("ROCKETR_SECRET_ENV");
    expect(JSON.stringify(entry)).not.toContain("x-rocketr-account");
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
      sessionDefinitions: fakeSessionDefinitions({}),
    });
    expect(inventory.rules.find((r) => r.id === "task")!.staffed).toBe(true);
    expect(inventory.rules.find((r) => r.id === "director")!.staffed).toBe(true);
  });

  test("a withheld row (admission cap) reaches all the way through the full buildQueryAgentInventory path, not just ruleStaffingReason in isolation", async () => {
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: checkedDashboard([withheldRow(encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "KAN-1" }))]),
      configReasonFor: noConfigReason,
      sessionDefinitions: fakeSessionDefinitions({}),
    });
    expect(inventory.rules[0]).toMatchObject({ staffed: false, reason: "admission cap: matched resource(s) currently withheld by the fleet-wide agent cap" });
  });

  test("before this daemon's first successful poll, every enabled rule reports 'not yet observed' end to end", async () => {
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: uncheckedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: fakeSessionDefinitions({}),
    });
    expect(inventory.rules[0]).toMatchObject({ staffed: false, reason: "not yet observed: no successful agent-list poll since this daemon started" });
  });

  test("a rules-file load error surfaces in top-level errors, and rules is empty — never a daemon crash", async () => {
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [], error: { path: "/rules.json", message: "/rules.json: invalid JSON: Unexpected token o in JSON at position 1" } },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: fakeSessionDefinitions({}),
    });
    expect(inventory.rules).toEqual([]);
    expect(inventory.errors).toEqual([{ path: "/rules.json", message: "/rules.json: invalid JSON: Unexpected token o in JSON at position 1" }]);
  });
});

// ---- buildQueryAgentInventory: session definitions ----------------------

describe("buildQueryAgentInventory — session-definitions section (FACTORY-72)", () => {
  test("frozen (manifest) and archived state are both real, computed booleans, and the correlation identifier matches sessionAgentKey", async () => {
    const activeDir = "/defs";
    const archiveDir = "/defs-archive";
    const deps = fakeSessionDefinitions({
      [activeDir]: { "/defs/live.json": goodDefinition() },
      [archiveDir]: { "/defs-archive/old.json": goodDefinition({ frozen: true }) },
    });
    const inventory = await buildQueryAgentInventory({
      rulesFile: noRulesFile,
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir },
    });
    const live = inventory.sessionDefinitions.find((e) => e.name === "live.json")!;
    const archived = inventory.sessionDefinitions.find((e) => e.name === "old.json")!;
    expect(live.archived).toBe(false);
    expect(live.manifestFrozen).toBe(false);
    expect(live.agentKey).toBe(sessionAgentKey("/defs/live.json"));
    expect(archived.archived).toBe(true);
    expect(archived.manifestFrozen).toBe(true);
    // BUTCHR-455's own identity rule: an archived definition's agent key is derived from its ACTIVE path (where it would be restored to), not its current archive path.
    expect(archived.agentKey).toBe(sessionAgentKey("/defs/old.json"));
  });

  test("an invalid (malformed) definition file is listed with its problems AND surfaces in top-level errors, without hiding a good file alongside it", async () => {
    const activeDir = "/defs";
    const deps = fakeSessionDefinitions({
      [activeDir]: {
        "/defs/good.json": goodDefinition(),
        "/defs/bad.json": "not json",
      },
    });
    const inventory = await buildQueryAgentInventory({
      rulesFile: noRulesFile,
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir: "/defs-archive" },
    });
    const good = inventory.sessionDefinitions.find((e) => e.name === "good.json")!;
    const bad = inventory.sessionDefinitions.find((e) => e.name === "bad.json")!;
    expect(good.valid).toBe(true);
    expect(bad.valid).toBe(false);
    expect(inventory.errors).toEqual([{ path: "/defs/bad.json", message: bad.problems.join("\n") }]);
  });

  test("no secret ever appears anywhere in the serialized inventory — a fake token, header value and env value, including inside MCP server config and inside a malformed file", async () => {
    const FAKE_TOKEN = "ghp_FAKESECRETTOKENabcdef1234567890";
    const FAKE_HEADER_VALUE = "Bearer super-secret-header-value-xyz";
    const FAKE_ENV_VALUE = "SUPER_SECRET_ENV_VALUE_998877";
    const activeDir = "/defs";
    const deps = fakeSessionDefinitions({
      [activeDir]: {
        // A valid definition binding an MCP server — only its NAME may ever surface.
        "/defs/bound.json": goodDefinition({
          mcpServers: [{ name: "rocketr", type: "http", url: "https://mcp.internal/rocketr", headersEnvVar: "ROCKETR_HEADERS_ENV", accountHeader: "x-rocketr-account", channel: true }],
        }),
        // A malformed definition whose raw, invalid content directly embeds fake secret-shaped strings —
        // proves the validator's error message never echoes a VALUE, only field names.
        "/defs/malformed.json": JSON.stringify({
          workingDirectory: "/repo", brief: "b", vendor: "claude", tier: "tier1", permissionMode: "default",
          unexpectedSecretField: FAKE_TOKEN,
          mcpServers: [{ name: "x", type: "http", url: `https://example.invalid/${FAKE_HEADER_VALUE}`, headersEnvVar: FAKE_ENV_VALUE, channel: "not-a-boolean" }],
        }),
      },
    });
    const rules = [rule({
      id: "bound-rule", resourceProvider: "jira-work",
      mcpServers: [{ name: "rocketr", type: "http", url: "https://mcp.internal/rocketr", headersEnvVar: FAKE_ENV_VALUE, accountHeader: FAKE_HEADER_VALUE, channel: true }],
    })];
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules, error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir: "/defs-archive" },
    });
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain(FAKE_HEADER_VALUE);
    expect(serialized).not.toContain(FAKE_ENV_VALUE);
    // Sanity: the malformed file's own problem list IS present (never swallowed) — just secret-free.
    const malformed = inventory.sessionDefinitions.find((e) => e.name === "malformed.json")!;
    expect(malformed.valid).toBe(false);
    expect(malformed.problems.length).toBeGreaterThan(0);
    expect(malformed.problems.some((p) => p.includes("unexpectedSecretField"))).toBe(true);
  });

  test("a misconfigured archive directory (inside the active one) is reported as one error, and never crashes the endpoint", async () => {
    const activeDir = "/defs";
    const deps = fakeSessionDefinitions({ [activeDir]: { "/defs/a.json": goodDefinition() } });
    const inventory = await buildQueryAgentInventory({
      rulesFile: noRulesFile,
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir: "/defs/nested-archive" },
    });
    expect(inventory.errors.some((e) => e.path === "/defs/nested-archive")).toBe(true);
    // The active directory's own good entry still comes through — one bad directory must not hide it.
    expect(inventory.sessionDefinitions.some((e) => e.name === "a.json" && e.valid)).toBe(true);
  });
});
