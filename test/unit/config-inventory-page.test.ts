import { describe, expect, test } from "bun:test";
import { renderConfigInventory, type ConfigInventoryFetchResult, type RenderConfigInventoryOpts } from "../../src/web/config-inventory-page.js";
import { buildQueryAgentInventory, type QueryAgentInventory, type RuleInventoryEntry, type SessionDefinitionInventoryEntry } from "../../src/agents/query-agent-inventory.js";
import { agentRowAnchorId } from "../../src/agents/config-inventory-links.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";
import { sessionAgentKey, sessionFreezeStoreKey } from "../../src/resources/session-freeze.js";
import type { Rule } from "../../src/rules/rules.js";
import {
  createDashboardFeed,
  type AdmissionView, type AgentDashboardRow, type DashboardResponse, type DashboardRow, type WithheldDashboardRow,
} from "../../src/agents/dashboard.js";
import { createAdmissionController } from "../../src/agents/admission.js";
import { StatusFloorTracker } from "../../src/agents/status-floor.js";
import type { FilesystemQuery } from "../../src/resources/filesystem-query.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";
import type { SessionFreezeStore } from "../../src/resources/session-freeze.js";

// ---- fixtures, same shape as query-agent-inventory.test.ts's own — real
// producers, never a hand-built shape that merely happens to typecheck. ----

function rule(over: Partial<Rule> & Pick<Rule, "id" | "resourceProvider">): Rule {
  return { enabled: true, query: "q", brief: "b", execution: "swarm", account: "none", role: "worker", ...over };
}
// FACTORY-340: declare every source a rule in THIS file's fixtures is
// covered by (jira-work -> "issue", plus github-issue/jira-idea/filesystem
// verbatim — see `RULE_ADMISSION_SOURCE`, ../../src/agents/query-agent-
// inventory.ts) as reported this poll, same rationale as query-agent-
// inventory.test.ts's own `allCoveredSourcesReported` — an empty `sources`
// now reads as "absent from the census" -> COULD NOT CHECK for every rule
// below, which is not what these tests are about.
const allCoveredSourcesReported: AdmissionView = {
  cap: 10, residency: 0, sentinels: 0,
  sources: ["issue", "github-issue", "jira-idea", "filesystem"].map((source) => ({ source, census: { checked: true, confirmedAt: new Date(0).toISOString() } })),
};
const floor = { sinceMs: 0, since: new Date(0).toISOString(), humanDuration: "0s", exact: true };
function checkedDashboard(rows: DashboardResponse["rows"] = []): DashboardResponse {
  return { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: allCoveredSourcesReported };
}
/** FACTORY-132: the agent census is unavailable — `rows`, when given, models a STALE carry-forward (a poll failed after an earlier success), never a fresh one (the response-level `checked:false` is what the render layer must key on, not `rows.length`). */
function uncheckedDashboard(rows: DashboardResponse["rows"] = []): DashboardResponse {
  return { checked: false, declinedAt: new Date(0).toISOString(), rows, admission: allCoveredSourcesReported };
}
function agentRow(resourceKey: string): AgentDashboardRow {
  return { kind: "agent", resourceKey, tier: { kind: "project" }, agentStatus: "working", pane: "p1", timeInStatus: floor, confirmedAt: new Date(0).toISOString() };
}
const noConfigReason = () => null;
function res(path: string): FilesystemResource {
  return { path, kind: "file", name: path.split("/").pop()!, size: 10, mtimeMs: 1000 };
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
  return { list, read, store };
}
const goodDefinition = (over: Record<string, unknown> = {}) => JSON.stringify({
  workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default", ...over,
});

// FACTORY-132: `agentCensusChecked` defaults to `true` (the checked state) —
// every existing test in this file below models a checked census and never
// passes this option itself, so defaulting it keeps every pre-existing
// "no running agent" / "UNSTAFFED: disabled" assertion valid and UNMODIFIED,
// per this ticket's own instruction. Only the NEW describe block at the
// bottom of this file overrides it to `false`.
function opts(over: Partial<RenderConfigInventoryOpts> = {}): RenderConfigInventoryOpts {
  return { dashboardLinkHref: (key) => `/#${agentRowAnchorId(key)}`, agentCensusChecked: true, ...over };
}

function rowSlice(html: string, keyText: string, marker = 'class="key"'): string {
  const needle = `<span ${marker}>${keyText}</span>`;
  const start = html.indexOf(needle);
  if (start === -1) throw new Error(`expected to find a row keyed ${JSON.stringify(keyText)}`);
  const nextStart = html.indexOf(`<span ${marker}>`, start + needle.length);
  return html.slice(start, nextStart === -1 ? html.length : nextStart);
}

const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// ---- rules table -------------------------------------------------------

describe("renderConfigInventory — rules table (FACTORY-81 requirement 1)", () => {
  test("an enabled, staffed rule shows id/provider/query/execution/agentPreferences/linkedEventing and 'staffed', with no reason text", async () => {
    const r = rule({
      id: "my-ideas", resourceProvider: "jira-idea", query: "project = IDEAS", execution: "swarm",
      agentPreferences: [{ harness: "claude", model: "opus", effort: "high" }], linkedEventing: true,
    });
    const liveKey = encodeAgentKey({ resourceProvider: "jira-idea", ruleId: "my-ideas", resourceId: "IDEAS-1" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: checkedDashboard([agentRow(liveKey)]),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [agentRow(liveKey)], opts());
    const row = rowSlice(html, "my-ideas");
    expect(row).toContain("jira-idea");
    expect(row).toContain("project = IDEAS");
    expect(row).toContain("swarm");
    // FACTORY-120: format changed from the old compact "claude/opus/high (model/effort
    // stand in for tier)" slug (stale wording, predates FACTORY-74) to a resolved-value
    // label — still pinning the same harness/model/effort values, just spelled out.
    expect(row).toContain("claude — Model: opus · Effort: high");
    expect(row).toContain("linked-eventing: on");
    expect(row).toContain(">staffed<");
    expect(row).not.toContain("UNSTAFFED");
    // Cross-link forward to the live agent row.
    expect(row).toContain(`href="/#${agentRowAnchorId(liveKey)}"`);
    expect(row).toContain(liveKey);
  });

  test("a disabled rule is still visible, marked DISABLED, reason 'disabled', and shows no running agent", async () => {
    const r = rule({ id: "project-managers", resourceProvider: "jira-work", enabled: false });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    const row = rowSlice(html, "project-managers");
    expect(row).toContain("DISABLED");
    expect(row).toContain("UNSTAFFED: disabled");
    expect(row).toContain("no running agent");
  });

  test("an unstaffed-for-a-real-reason rule (provider config problem) shows that reason verbatim", async () => {
    const r = rule({ id: "gh-triage", resourceProvider: "github-issue" });
    const reason = "github-issue rules not staffed (gh-triage): set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS";
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: () => reason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    expect(rowSlice(html, "gh-triage")).toContain(reason);
  });

  test("a rule with no agentPreferences renders the em-dash placeholder, never an empty/missing cell", async () => {
    const r = rule({ id: "bare", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    expect(rowSlice(html, "bare")).toContain(">—<");
  });

  test("no rules configured renders a genuine empty finding, not a hollow table", async () => {
    const inventory: QueryAgentInventory = { rules: [], sessionDefinitions: [], errors: [] };
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    expect(html).toContain("no rules configured");
  });
});

// ---- session-definitions table ------------------------------------------

describe("renderConfigInventory — managed-session definitions table (FACTORY-81 requirement 2)", () => {
  test("a valid, active definition shows vendor/tier, permissionMode, execution, account, role, workingDirectory, mcpServerNames, both frozen states, and both controller lists", async () => {
    const activeDir = "/defs";
    const deps = fakeSessionDefinitions({
      [activeDir]: {
        "/defs/repo-a.json": goodDefinition({
          execution: "persistent", account: "temporary", role: "worker",
          mcpServers: [{ name: "rocketr", type: "http", url: "https://mcp.internal/x", headersEnvVar: "E", accountHeader: "H", channel: true }],
          freezeControllers: ["alice"], unfreezeControllers: ["bob"],
        }),
      },
    });
    const liveKey = sessionAgentKey("/defs/repo-a.json");
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [], error: null },
      dashboard: checkedDashboard([agentRow(liveKey)]),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [agentRow(liveKey)], opts());
    const row = rowSlice(html, "repo-a.json");
    expect(row).toContain("claude/tier1");
    expect(row).toContain("default"); // permissionMode
    expect(row).toContain("persistent");
    expect(row).toContain("temporary");
    expect(row).toContain("worker");
    expect(row).toContain("/repo/project");
    expect(row).toContain("rocketr");
    expect(row).toContain('<span class="manifestfrozen">manifestFrozen: <span class="off">false</span></span>');
    expect(row).toContain('<span class="storefrozen">storeFrozen: <span class="off">false</span></span>');
    expect(row).toContain("freeze: alice");
    expect(row).toContain("unfreeze: bob");
    expect(row).toContain(">active<");
    expect(row).not.toContain("ARCHIVED");
    expect(row).toContain(liveKey);
    // Never the raw url/headersEnvVar/accountHeader of an MCP binding.
    expect(row).not.toContain("mcp.internal");
    expect(row).not.toContain(">E<");
  });

  test("an archived definition is visible and clearly marked ARCHIVED", async () => {
    const activeDir = "/defs";
    const archiveDir = "/defs-archive";
    const deps = fakeSessionDefinitions({ [archiveDir]: { "/defs-archive/old.json": goodDefinition({ frozen: true }) } });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    const row = rowSlice(html, "old.json");
    expect(row).toContain("ARCHIVED");
    expect(row).toContain('<span class="manifestfrozen">manifestFrozen: <span class="known">true</span></span>');
  });

  test("an invalid definition shows INVALID plus every problem, and its content fields render not-applicable rather than a different layout", async () => {
    const activeDir = "/defs";
    const deps = fakeSessionDefinitions({ [activeDir]: { "/defs/bad.json": "not json at all" } });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    const row = rowSlice(html, "bad.json");
    expect(row).toContain("INVALID");
    const realProblems = inventory.sessionDefinitions.find((e) => e.name === "bad.json")!.problems;
    expect(realProblems.length).toBeGreaterThan(0);
    for (const p of realProblems) expect(row).toContain(escHtml(p));
    // Structurally-absent content fields read as not-applicable, never a crash or a blank cell with no marker.
    expect(row.match(/class="na"/g)?.length ?? 0).toBeGreaterThan(0);
  });

  test("a session definition with no running agent shows 'no running agent', never a broken/empty link", async () => {
    const activeDir = "/defs";
    const deps = fakeSessionDefinitions({ [activeDir]: { "/defs/idle.json": goodDefinition() } });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    expect(rowSlice(html, "idle.json")).toContain("no running agent");
  });

  test("no session definitions configured renders a genuine empty finding", () => {
    const inventory: QueryAgentInventory = { rules: [], sessionDefinitions: [], errors: [] };
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    expect(html).toContain("no managed-session definitions configured");
  });
});

// ---- cross-links, both directions ---------------------------------------

describe("renderConfigInventory — cross-links (FACTORY-81 requirement 3)", () => {
  test("a singleton/persistent rule's query-level agent still cross-links (kind:'query', not just kind:'resource')", async () => {
    const r = rule({ id: "director", resourceProvider: "filesystem", execution: "persistent" });
    const liveKey = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "director" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: checkedDashboard([agentRow(liveKey)]),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [agentRow(liveKey)], opts());
    expect(rowSlice(html, "director")).toContain(liveKey);
  });

  test("a withheld (admission-cap) row never counts as a running agent link, even though the rule's own reason mentions the admission cap", async () => {
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const withheldKey = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    const withheld: WithheldDashboardRow = { kind: "withheld", resourceKey: withheldKey, tier: { kind: "project" }, source: "issue", waiting: floor, confirmedAt: new Date(0).toISOString(), agentFields: { applicable: false, reason: "no agent: withheld by the admission cap" } };
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: checkedDashboard([withheld]),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    const row = rowSlice(renderConfigInventory({ ok: true, inventory }, [withheld], opts()), "task");
    expect(row).toContain("admission cap");
    expect(row).toContain("no running agent");
  });
});

// ---- errors ---------------------------------------------------------------

describe("renderConfigInventory — errors (FACTORY-81 requirement 4)", () => {
  test("every errors[] entry is displayed prominently, with its real path and message", async () => {
    const inventory: QueryAgentInventory = {
      rules: [], sessionDefinitions: [],
      errors: [{ path: "/config/rules.json", message: "invalid JSON: Unexpected token o" }, { path: "/defs/bad.json", message: "problem A\nproblem B" }],
    };
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    expect(html).toContain("/config/rules.json");
    expect(html).toContain("invalid JSON: Unexpected token o");
    expect(html).toContain("/defs/bad.json");
    expect(html).toContain("problem A");
  });

  test("no errors renders no error banner at all — never a hollow '0 errors'", () => {
    const inventory: QueryAgentInventory = { rules: [], sessionDefinitions: [], errors: [] };
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    expect(html).not.toContain("errors banner");
    expect(html).not.toContain("error(s)");
  });

  test("a failed fetch of /config-inventory itself is a loud banner, and renders NO rules/sessions tables at all — never an empty table read as 'no config'", () => {
    const result: ConfigInventoryFetchResult = { ok: false, error: "ECONNREFUSED" };
    const html = renderConfigInventory(result, [], opts());
    expect(html).toContain("COULD NOT CHECK");
    expect(html).toContain("ECONNREFUSED");
    expect(html).not.toContain('id="rules"');
    expect(html).not.toContain('id="sessions"');
    expect(html).not.toContain("no rules configured");
  });

  test("a genuinely empty inventory (fetch succeeded, nothing configured) is textually distinguishable from a fetch failure", () => {
    const empty = renderConfigInventory({ ok: true, inventory: { rules: [], sessionDefinitions: [], errors: [] } }, [], opts());
    const failed = renderConfigInventory({ ok: false, error: "boom" }, [], opts());
    expect(empty).not.toContain("COULD NOT CHECK");
    expect(failed).not.toContain("no rules configured");
  });
});

// ---- no secrets ------------------------------------------------------------

describe("renderConfigInventory — no secrets (FACTORY-81 requirement 5)", () => {
  test("an entry carrying an unexpected extra field with a secret-shaped value never surfaces it — only named fields are ever read", () => {
    const FAKE_SECRET = "ghp_FAKESECRETTOKENabcdef1234567890";
    const rulesWithExtra = [
      { kind: "rule", id: "x", resourceProvider: "jira-work", query: "q", enabled: true, execution: "swarm", account: "none", role: "worker", agentPreferences: [], linkedEventing: false, mcpServerNames: [], staffed: true, reason: null, unexpectedSecretField: FAKE_SECRET } as unknown as RuleInventoryEntry,
    ];
    const sessionsWithExtra = [
      { kind: "session-definition", name: "y.json", path: "/defs/y.json", agentKey: sessionAgentKey("/defs/y.json"), valid: true, problems: [], archived: false, vendor: "claude", tier: "tier1", unexpectedSecretField: FAKE_SECRET } as unknown as SessionDefinitionInventoryEntry,
    ];
    const inventory: QueryAgentInventory = { rules: rulesWithExtra, sessionDefinitions: sessionsWithExtra, errors: [] };
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    expect(html).not.toContain(FAKE_SECRET);
  });

  test("a future, unknown-shaped tier value (per FACTORY-74's own note) never hard-fails the render — it renders as whatever value is present", () => {
    const entry = {
      kind: "session-definition", name: "future.json", path: "/defs/future.json", valid: true, problems: [],
      archived: false, vendor: "claude", tier: 42, // FACTORY-74 may replace the tier enum with a 0-100 integer
    } as unknown as SessionDefinitionInventoryEntry;
    const inventory: QueryAgentInventory = { rules: [], sessionDefinitions: [entry], errors: [] };
    expect(() => renderConfigInventory({ ok: true, inventory }, [], opts())).not.toThrow();
    expect(renderConfigInventory({ ok: true, inventory }, [], opts())).toContain("claude/42");
  });
});

// ---- DashboardRow[] is used only for matching, never rendered directly ----

describe("renderConfigInventory — rows param is read-only input, not echoed", () => {
  test("an unrelated dashboard row (no matching config entry) never appears anywhere on the page", async () => {
    const unrelatedKey = encodeAgentKey({ resourceProvider: "github-issue", ruleId: "unrelated", resourceId: "acme/repo#1" });
    const inventory: QueryAgentInventory = { rules: [], sessionDefinitions: [], errors: [] };
    const rows: DashboardRow[] = [agentRow(unrelatedKey)];
    const html = renderConfigInventory({ ok: true, inventory }, rows, opts());
    expect(html).not.toContain(unrelatedKey);
  });
});

// ---- the epic's own verification scenario (FACTORY-81 Definition of Done) -
// 8 managed sessions (some frozen/archived/invalid), disabled
// project-managers/mud-manager rules, an enabled staffed my-ideas rule, a
// rule unstaffed for a provider-config reason, plus the load error the
// invalid session definition itself produces — end to end, through the real
// buildQueryAgentInventory, never a hand-assembled inventory literal.
describe("renderConfigInventory — the epic's own verification scenario, end to end (FACTORY-81 DoD)", () => {
  test("renders every rule and all 8 session definitions correctly, with the errors list and cross-links intact", async () => {
    const rules = [
      rule({ id: "project-managers", resourceProvider: "jira-work", enabled: false }),
      rule({ id: "mud-manager", resourceProvider: "filesystem", enabled: false }),
      rule({ id: "my-ideas", resourceProvider: "jira-idea" }),
      rule({ id: "gh-triage", resourceProvider: "github-issue" }),
    ];
    const myIdeasKey = encodeAgentKey({ resourceProvider: "jira-idea", ruleId: "my-ideas", resourceId: "IDEAS-1" });
    const activeDir = "/defs";
    const archiveDir = "/defs-archive";
    const frozenAgentKeys = new Set([sessionFreezeStoreKey("/defs/repo-c.json")]);
    const deps = fakeSessionDefinitions(
      {
        [activeDir]: {
          "/defs/repo-a.json": goodDefinition({ workingDirectory: "/repo/a" }),
          "/defs/repo-b.json": goodDefinition({ workingDirectory: "/repo/b", frozen: true }),
          "/defs/repo-c.json": goodDefinition({ workingDirectory: "/repo/c" }), // storeFrozen via frozenAgentKeys
          "/defs/repo-d.json": "not valid json at all", // the one load error
          "/defs/repo-g.json": goodDefinition({ workingDirectory: "/repo/g" }),
          "/defs/repo-h.json": goodDefinition({ workingDirectory: "/repo/h" }),
        },
        [archiveDir]: {
          "/defs-archive/old-e.json": goodDefinition({ workingDirectory: "/repo/e" }),
          "/defs-archive/old-f.json": goodDefinition({ workingDirectory: "/repo/f", frozen: true }),
        },
      },
      frozenAgentKeys,
    );
    const reason = "github-issue rules not staffed (gh-triage): set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS";
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules, error: null },
      dashboard: checkedDashboard([agentRow(myIdeasKey)]),
      configReasonFor: (r) => (r.resourceProvider === "github-issue" ? reason : null),
      sessionDefinitions: { ...deps, activeDir, archiveDir },
    });

    // Sanity on the scenario itself, before even rendering: 8 session
    // definitions, exactly one load error (the malformed repo-d.json).
    expect(inventory.sessionDefinitions).toHaveLength(8);
    expect(inventory.errors).toHaveLength(1);
    expect(inventory.errors[0]!.path).toBe("/defs/repo-d.json");

    const html = renderConfigInventory({ ok: true, inventory }, [agentRow(myIdeasKey)], opts());

    // Rules: both disabled rules visible; my-ideas staffed and linked to its live row; gh-triage's real reason.
    expect(rowSlice(html, "project-managers")).toContain("UNSTAFFED: disabled");
    expect(rowSlice(html, "mud-manager")).toContain("UNSTAFFED: disabled");
    const myIdeasRow = rowSlice(html, "my-ideas");
    expect(myIdeasRow).toContain(">staffed<");
    expect(myIdeasRow).toContain(myIdeasKey);
    expect(rowSlice(html, "gh-triage")).toContain(reason);

    // Sessions: active/frozen/store-frozen/archived/invalid, all visible and distinguishable.
    expect(rowSlice(html, "repo-a.json")).toContain('<span class="manifestfrozen">manifestFrozen: <span class="off">false</span></span>');
    expect(rowSlice(html, "repo-b.json")).toContain('<span class="manifestfrozen">manifestFrozen: <span class="known">true</span></span>');
    expect(rowSlice(html, "repo-c.json")).toContain('<span class="storefrozen">storeFrozen: <span class="known">true</span></span>');
    expect(rowSlice(html, "repo-d.json")).toContain("INVALID");
    expect(rowSlice(html, "old-e.json")).toContain("ARCHIVED");
    const oldF = rowSlice(html, "old-f.json");
    expect(oldF).toContain("ARCHIVED");
    expect(oldF).toContain('<span class="manifestfrozen">manifestFrozen: <span class="known">true</span></span>');
    expect(rowSlice(html, "repo-g.json")).toContain("/repo/g");
    expect(rowSlice(html, "repo-h.json")).toContain("/repo/h");

    // The one load error is shown prominently, with its real path.
    expect(html).toContain("1 configuration load/parse error(s)");
    expect(html).toContain("/defs/repo-d.json");
  });
});

// ---- resolved model/effort (FACTORY-120) -----------------------------------

describe("renderConfigInventory — resolved model/effort (FACTORY-120)", () => {
  test("a modelPower/effort (two-axis) definition shows the resolved model/effort labels, the raw values as secondary detail, and never the old 'vendor/?' placeholder", async () => {
    const activeDir = "/defs";
    const deps = fakeSessionDefinitions({
      [activeDir]: { "/defs/two-axis.json": goodDefinition({ tier: undefined, modelPower: 70, effort: 65 }) },
    });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    const row = rowSlice(html, "two-axis.json");
    // Literal values: CLAUDE_MODEL_POWER_TABLE's 60-84 band is "opus", EFFORT_TABLE's 60-79 band is "xhigh" (power-scale.ts).
    expect(row).toContain("Model: opus · Effort: xhigh");
    expect(row).toContain("raw: modelPower 70, effort 65");
    expect(row).not.toContain("claude/?");
  });

  test("a tier-based (deprecated) definition keeps its vendor/tier display, and additionally shows its resolved model plus the honest 'no effort set' wording — a known fact, never an em-dash", async () => {
    const activeDir = "/defs";
    const deps = fakeSessionDefinitions({
      [activeDir]: { "/defs/tier-based.json": goodDefinition({ tier: "tier4" }) },
    });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    const row = rowSlice(html, "tier-based.json");
    expect(row).toContain("claude/tier4"); // vendor/tier display, unchanged
    expect(row).toContain("Model: opus"); // literal spot-check: CLAUDE_TIER_MODEL.tier4 -> opus
    expect(row).toContain("no effort set");
  });

  test("an INVALID definition's resolved-model/effort span never shows a Model:/Effort: value — same not-applicable discipline as its other content fields, and no crash", async () => {
    const activeDir = "/defs";
    const deps = fakeSessionDefinitions({ [activeDir]: { "/defs/bad.json": "not json at all" } });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    const row = rowSlice(html, "bad.json");
    expect(row).toContain('<span class="resolvedagent">');
    expect(row).not.toContain("Model:");
    expect(row).not.toContain("Effort:");
  });

  test("a rule preference with a resolved model/effort renders labeled values, never the stale '(model/effort stand in for tier)' caption", async () => {
    const r = rule({ id: "labeled-pref", resourceProvider: "jira-work", agentPreferences: [{ harness: "codex", model: "gpt-6-astra", effort: "max" }] });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    const row = rowSlice(html, "labeled-pref");
    expect(row).toContain("codex — Model: gpt-6-astra · Effort: max");
    expect(html).not.toContain("stand in for tier");
  });

  test("a rule preference with no model/effort set (uses butchr's global config) renders 'default' for both — never blank, never a made-up value", async () => {
    const r = rule({ id: "bare-pref", resourceProvider: "jira-work", agentPreferences: [{ harness: "codex" }] });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: checkedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts());
    const row = rowSlice(html, "bare-pref");
    expect(row).toContain("codex — Model: default · Effort: default");
  });
});

// ---- FACTORY-132: agent-census-unavailable rendering (staffing + cross-links) ----

describe("renderConfigInventory — agent-census-unavailable rendering (FACTORY-132)", () => {
  test("an enabled rule with no match renders COULD NOT CHECK for BOTH the staffing cell and the cross-link area, never UNSTAFFED or 'no running agent'", async () => {
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: uncheckedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    expect(inventory.rules[0]!.staffed).toBeNull();
    expect(inventory.rules[0]!.reason).not.toBeNull();

    const html = renderConfigInventory({ ok: true, inventory }, [], opts({ agentCensusChecked: false }));
    const row = rowSlice(html, "task");
    expect(row.toUpperCase()).not.toContain("UNSTAFFED");
    expect(row).not.toContain("no running agent");
    // TWO independent COULD NOT CHECK renderings on this one row — the
    // staffing cell (`renderStaffed`) AND the cross-link area
    // (`renderAgentLinks`) — proving both halves of this ticket fired, not
    // just one masking the other's absence.
    expect(row.match(/COULD NOT CHECK/g)?.length ?? 0).toBe(2);
    expect(row).toMatch(/<span class="staffed cnc">COULD NOT CHECK/);
  });

  test("a session-definition row's cross-link area renders COULD NOT CHECK, never 'no running agent', when the census is unavailable", async () => {
    const activeDir = "/defs";
    const deps = fakeSessionDefinitions({ [activeDir]: { "/defs/idle.json": goodDefinition() } });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [], error: null },
      dashboard: uncheckedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts({ agentCensusChecked: false }));
    const row = rowSlice(html, "idle.json");
    expect(row).toContain("COULD NOT CHECK");
    expect(row).not.toContain("no running agent");
    expect(row).toMatch(/class="cnc"/);
  });

  test("a DISABLED rule's staffing cell stays 'UNSTAFFED: disabled' (a config fact, AC4) while its OWN cross-link area independently renders COULD NOT CHECK (AC3's flat rule) — the two axes are independent", async () => {
    const r = rule({ id: "project-managers", resourceProvider: "jira-work", enabled: false });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: uncheckedDashboard(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, [], opts({ agentCensusChecked: false }));
    const row = rowSlice(html, "project-managers");
    expect(row).toContain("UNSTAFFED: disabled");
    expect(row).not.toContain("no running agent");
    // Exactly ONE COULD NOT CHECK on this row — from the cross-link area
    // only; the staffing cell stays UNSTAFFED, unaffected by census state.
    expect(row.match(/COULD NOT CHECK/g)?.length ?? 0).toBe(1);
  });

  test("a rule whose live agent row is present (even if stale) still links and reads 'staffed', regardless of census state — AC3's first case, unaffected by this ticket", async () => {
    const r = rule({ id: "my-ideas", resourceProvider: "jira-idea" });
    const liveKey = encodeAgentKey({ resourceProvider: "jira-idea", ruleId: "my-ideas", resourceId: "IDEAS-1" });
    const staleRow = agentRow(liveKey);
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: uncheckedDashboard([staleRow]),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    expect(inventory.rules[0]).toMatchObject({ staffed: true, reason: null });

    const html = renderConfigInventory({ ok: true, inventory }, [staleRow], opts({ agentCensusChecked: false }));
    const row = rowSlice(html, "my-ideas");
    expect(row).toContain(">staffed<");
    expect(row).toContain(liveKey);
    expect(row).not.toContain("COULD NOT CHECK");
  });
});

// ---- FACTORY-132: end to end through a REAL createDashboardFeed (AC5) ----
// Never a hand-assembled DashboardResponse: a real feed's snapshot before
// any poll, and after a poll whose list() throws (including the
// failed-after-a-good-poll variant), fed into the real
// buildQueryAgentInventory, then the real renderConfigInventory — and the
// transition back to known states after a real successful poll, for BOTH a
// rule row and a session-definition row, pinning that the discriminator is
// the real census flag and not an always-on message.

/** Same harmless admission fixture as dashboard.test.ts's own `noWithholding()` — this block only exercises the agent.list()/census axis. */
function noWithholding() {
  return createAdmissionController({ cap: 1_000_000, residency: async () => [] });
}
function realFeed(now: () => number) {
  const admission = noWithholding();
  return createDashboardFeed({ now, issueMeta: () => undefined, tracker: new StatusFloorTracker(now), withheldTracker: new StatusFloorTracker(now), admission: () => admission.census() });
}

describe("renderConfigInventory — end to end through a REAL createDashboardFeed (FACTORY-132, AC5)", () => {
  test("before any poll: a rule row AND a session-definition row both render COULD NOT CHECK, never UNSTAFFED or 'no running agent'", async () => {
    const f = realFeed(() => 0);
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const activeDir = "/defs";
    const deps = fakeSessionDefinitions({ [activeDir]: { "/defs/idle.json": goodDefinition() } });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: f.snapshot(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir: "/defs-archive" },
    });
    expect(inventory.rules[0]!.staffed).toBeNull();

    const html = renderConfigInventory({ ok: true, inventory }, f.snapshot().rows, opts({ agentCensusChecked: f.snapshot().checked }));
    const ruleRow = rowSlice(html, "task");
    expect(ruleRow.toUpperCase()).not.toContain("UNSTAFFED");
    expect(ruleRow).not.toContain("no running agent");
    expect(ruleRow).toContain("COULD NOT CHECK");
    const sessionRow = rowSlice(html, "idle.json");
    expect(sessionRow).toContain("COULD NOT CHECK");
    expect(sessionRow).not.toContain("no running agent");
  });

  test("a poll that fails AFTER an earlier good poll renders the SAME COULD NOT CHECK page for a rule with no match — the stale-carry-forward case", async () => {
    let now = 1000;
    const f = realFeed(() => now);
    const r = rule({ id: "task", resourceProvider: "jira-work" });
    await f.poll(async () => ({ agents: [] }));

    now = 5000;
    await expect(f.poll(async () => { throw new Error("agent.list: boom"); })).rejects.toThrow("agent.list: boom");
    expect(f.snapshot().checked).toBe(false);

    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: f.snapshot(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    expect(inventory.rules[0]!.staffed).toBeNull();
    const html = renderConfigInventory({ ok: true, inventory }, f.snapshot().rows, opts({ agentCensusChecked: f.snapshot().checked }));
    const row = rowSlice(html, "task");
    expect(row).toContain("COULD NOT CHECK");
    expect(row.toUpperCase()).not.toContain("UNSTAFFED");
    expect(row).not.toContain("no running agent");
  });

  test("after a successful poll, a rule row AND a session-definition row both transition to known states — proving the discriminator is the real census flag, not an always-on message", async () => {
    const f = realFeed(() => 9000);
    const r = rule({ id: "my-ideas", resourceProvider: "jira-idea" });
    const liveKey = encodeAgentKey({ resourceProvider: "jira-idea", ruleId: "my-ideas", resourceId: "IDEAS-1" });
    const activeDir = "/defs";
    const deps = fakeSessionDefinitions({ [activeDir]: { "/defs/idle.json": goodDefinition() } });

    await f.poll(async () => ({ agents: [{ agent_key: liveKey, agent_status: "working", pane_id: "p1" }] }));
    expect(f.snapshot().checked).toBe(true);

    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: f.snapshot(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...deps, activeDir, archiveDir: "/defs-archive" },
    });
    expect(inventory.rules[0]).toMatchObject({ staffed: true, reason: null });

    const html = renderConfigInventory({ ok: true, inventory }, f.snapshot().rows, opts({ agentCensusChecked: f.snapshot().checked }));
    const ruleRow = rowSlice(html, "my-ideas");
    expect(ruleRow).toContain(">staffed<");
    expect(ruleRow).toContain(liveKey);
    expect(ruleRow).not.toContain("COULD NOT CHECK");

    // Genuinely no match for the session definition, but the census IS
    // available now — the pre-existing, unchanged "no running agent" wording.
    const sessionRow = rowSlice(html, "idle.json");
    expect(sessionRow).toContain("no running agent");
    expect(sessionRow).not.toContain("COULD NOT CHECK");
  });
});

// ---- FACTORY-136: the admission-source-unavailable tri-state renders -----
// through a REAL createDashboardFeed + createAdmissionController, same
// end-to-end bar as the FACTORY-132 block just above. `renderStaffed`
// (config-inventory-page.ts) requires NO code change for this: it already
// renders `staffed === null` as `COULD NOT CHECK: <reason>` generically, so
// this block pins that the reused tri-state actually reaches the page this
// way, rather than asserting it only at the `query-agent-inventory.ts` layer.

function feedWithAdmission(now: () => number, sources: readonly string[], residency: () => Promise<readonly string[]> = async () => []) {
  const admission = createAdmissionController({ cap: 1_000_000, residency, sources, now });
  const feed = createDashboardFeed({ now, issueMeta: () => undefined, tracker: new StatusFloorTracker(now), withheldTracker: new StatusFloorTracker(now), admission: () => admission.census() });
  return { admission, feed };
}

describe("renderConfigInventory — the admission-source-unavailable tri-state through a REAL createDashboardFeed + createAdmissionController (FACTORY-136)", () => {
  test("a never-reported admission source covering the rule's provider renders COULD NOT CHECK in the staffing cell, naming the source — the cross-link area (keyed on the AGENT census, not the admission census) is UNCHANGED, still 'no running agent'", async () => {
    const { feed } = feedWithAdmission(() => 0, ["issue"]);
    await feed.poll(async () => ({ agents: [] })); // agent.list() succeeds; the "issue" admission source never reports
    expect(feed.snapshot().checked).toBe(true);

    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: feed.snapshot(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    expect(inventory.rules[0]!.staffed).toBeNull();

    // agentCensusChecked reflects the AGENT census only (dashboard.checked),
    // which is true here — the admission census being down is a different,
    // narrower fact this option was never meant to carry.
    const html = renderConfigInventory({ ok: true, inventory }, feed.snapshot().rows, opts({ agentCensusChecked: feed.snapshot().checked }));
    const row = rowSlice(html, "task");
    expect(row).toMatch(/<span class="staffed cnc">COULD NOT CHECK/);
    expect(row).toContain("never-reported");
    expect(row.toUpperCase()).not.toContain("UNSTAFFED");
    // The cross-link area's own independent could-not-check axis is untouched
    // by this ticket — no live agent, agent census fine, so still "no running agent".
    expect(row).toContain("no running agent");
  });

  test("a declined admission source (residency threw) renders COULD NOT CHECK naming 'census-threw', distinct wording from the agent-census-unavailable case", async () => {
    const now = () => 0;
    const { admission, feed } = feedWithAdmission(now, ["issue"], async () => { throw new Error("herdr down"); });
    await admission.admit(["I1"], [], "issue");
    await feed.poll(async () => ({ agents: [] }));

    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: feed.snapshot(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, feed.snapshot().rows, opts({ agentCensusChecked: feed.snapshot().checked }));
    const row = rowSlice(html, "task");
    expect(row).toContain("COULD NOT CHECK");
    expect(row).toContain("census-threw");
  });

  test("control: once the covering admission source reports, the page reverts to the pre-existing UNSTAFFED wording exactly", async () => {
    const now = () => 0;
    const { admission, feed } = feedWithAdmission(now, ["issue"]);
    await admission.admit(["I1"], [], "issue");
    await feed.poll(async () => ({ agents: [] }));

    const r = rule({ id: "task", resourceProvider: "jira-work" });
    const inventory = await buildQueryAgentInventory({
      rulesFile: { path: "/rules.json", rules: [r], error: null },
      dashboard: feed.snapshot(),
      configReasonFor: noConfigReason,
      sessionDefinitions: { ...fakeSessionDefinitions({}), activeDir: "/defs", archiveDir: "/defs-archive" },
    });
    const html = renderConfigInventory({ ok: true, inventory }, feed.snapshot().rows, opts({ agentCensusChecked: feed.snapshot().checked }));
    const row = rowSlice(html, "task");
    expect(row).toContain("UNSTAFFED: no matching resources this poll");
    expect(row).not.toContain("COULD NOT CHECK");
  });
});
