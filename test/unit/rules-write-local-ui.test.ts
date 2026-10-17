/**
 * local/ui — the rule fields the dashboard's inline editor made editable:
 * `execution`, `resumeOnRespawn`, `resumeContextCutoff`, `brief` (PUT and
 * create), plus `GET /api/rules/:id/details` and the catalog's
 * built-in brief list.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import type { RulesEnv } from "../../src/rules/rules.js";
import { computeLocalPlanCounts, createRule, createScopeCache, isSwarmSwitch, planRuleCreate, planRuleWrite, writeRuleFields, type RulesWriteDeps } from "../../src/rules/rules-write.js";
import { createRulesPreviewer } from "../../src/web/rules-preview.js";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { Rule } from "../../src/rules/rules.js";
import { applyRuleFieldPatch, buildFieldsAllowedPaths } from "../../src/rules/rules-write-apply.js";
import { BRIEF_MAX_LENGTH, ENABLE_SCOPE_CEILING, validateRuleCreateInput, validateRuleFieldPatch, type RuleFieldPatch } from "../../src/rules/rules-write-registry.js";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { buildRulesApiResponse } from "../../src/web/rules-api.js";
import type { RuleInventoryEntry } from "../../src/agents/query-agent-inventory.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-local-ui-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const env = (): RulesEnv => ({ XDG_CONFIG_HOME: dir });
const rulesFile = () => join(dir, "butchr", "rules.json");
const deps = (): RulesWriteDeps => ({ env: env() });
const readRules = () => (JSON.parse(readFileSync(rulesFile(), "utf8")) as { rules: Record<string, unknown>[] }).rules;

function seed(rules: unknown[]): void {
  mkdirSync(join(dir, "butchr"), { recursive: true });
  writeFileSync(rulesFile(), JSON.stringify({ rules }, null, 2) + "\n");
}

const SINGLETON_ON = { id: "triage", resourceProvider: "jira-work", query: "project = A", brief: "@builtin:task", enabled: true, execution: "singleton" };
const SWARM_OFF = { id: "quiet", resourceProvider: "jira-work", query: "project = B", brief: "do it", enabled: false };

async function planned(id: string, patch: RuleFieldPatch, scope = 0) {
  const plan = await planRuleWrite(id, patch, false, async () => scope, deps());
  if (!plan.ok) throw new Error(plan.error);
  return plan;
}

describe("validateRuleFieldPatch — the new fields", () => {
  test("accepts valid values, including a null cutoff (back to the default)", () => {
    const r = validateRuleFieldPatch({ execution: "persistent", resumeOnRespawn: false, resumeContextCutoff: null, brief: "@builtin:bug" });
    expect(r).toEqual({ ok: true, patch: { execution: "persistent", resumeOnRespawn: false, resumeContextCutoff: null, brief: "@builtin:bug" } });
    expect(validateRuleFieldPatch({ resumeContextCutoff: 40000, brief: "custom text for {{KEY}}" })).toMatchObject({ ok: true });
  });

  test.each([
    [{ execution: "herd" }, "execution must be one of"],
    // The legacy Rocket.Chat key is refused like any other unknown field.
    [{ account: "none" }, 'unknown field "account"'],
    [{ resumeOnRespawn: "yes" }, "resumeOnRespawn must be a boolean"],
    [{ resumeContextCutoff: 0 }, "resumeContextCutoff must be a positive integer"],
    [{ resumeContextCutoff: 1.5 }, "resumeContextCutoff must be a positive integer"],
    [{ brief: "   " }, "brief must be a non-empty string"],
    [{ brief: "x".repeat(BRIEF_MAX_LENGTH + 1) }, "brief must be a non-empty string"],
    [{ brief: "@builtin:stroy" }, "unknown built-in brief"],
  ])("rejects %j", (body, message) => {
    const r = validateRuleFieldPatch(body);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain(message);
  });
});

describe("validateRuleCreateInput — the new fields", () => {
  const base = { id: "new-one", resourceProvider: "jira-work", query: "project = C" };

  test("accepts them", () => {
    expect(validateRuleCreateInput({ ...base, brief: "hello", execution: "singleton", resumeOnRespawn: true, resumeContextCutoff: 5 })).toEqual({
      ok: true,
      input: { ...base, brief: "hello", execution: "singleton", resumeOnRespawn: true, resumeContextCutoff: 5 },
    } as never);
  });

  test.each([
    [{ brief: "" }, "brief"],
    [{ execution: "x" }, "execution"],
    [{ account: "none" }, 'unknown field "account"'],
    [{ resumeOnRespawn: 1 }, "resumeOnRespawn"],
    [{ resumeContextCutoff: null }, "resumeContextCutoff"],
    [{ stalledMinutes: 0 }, "stalledMinutes"],
    [{ stalledMinutes: null }, "stalledMinutes"],
    [{ notifyDeliveryMode: "email" }, "notifyDeliveryMode"],
    [{ notifyDeliveryMode: null }, "notifyDeliveryMode"],
  ])("rejects %j", (extra, field) => {
    const r = validateRuleCreateInput({ ...base, ...extra });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain(field);
  });

  test("accepts a stall threshold and a notification delivery mode", () => {
    expect(validateRuleCreateInput({ ...base, stalledMinutes: 2.5, notifyDeliveryMode: "prompt" })).toEqual({ ok: true, input: { ...base, stalledMinutes: 2.5, notifyDeliveryMode: "prompt" } } as never);
  });
});

describe("applying and planning", () => {
  test("applyRuleFieldPatch sets each field, and a null cutoff removes the key", () => {
    const text = JSON.stringify({ rules: [{ ...SWARM_OFF, resumeContextCutoff: 9 }] });
    const next = JSON.parse(applyRuleFieldPatch(text, "quiet", { execution: "singleton", resumeOnRespawn: false, resumeContextCutoff: null, brief: "new" })).rules[0];
    expect(next).toMatchObject({ execution: "singleton", resumeOnRespawn: false, brief: "new" });
    expect("resumeContextCutoff" in next).toBe(false);
    expect(buildFieldsAllowedPaths(text, "quiet", { execution: "singleton", brief: "new" })).toEqual(["rules.0.execution", "rules.0.brief"]);
  });

  test("brief/execution changes restart an enabled rule's agent; resume settings never do", () => {
    expect(computeLocalPlanCounts(true, { brief: "x" }).restarted).toBe(1);
    expect(computeLocalPlanCounts(true, { execution: "persistent" }).restarted).toBe(1);
    expect(computeLocalPlanCounts(true, { resumeOnRespawn: false, resumeContextCutoff: 3 }).restarted).toBe(0);
    expect(computeLocalPlanCounts(false, { brief: "x" }).restarted).toBe(0);
  });

  test("isSwarmSwitch only for an enabled, non-swarm rule moving to swarm", () => {
    expect(isSwarmSwitch(SINGLETON_ON, { execution: "swarm" })).toBe(true);
    expect(isSwarmSwitch({ ...SINGLETON_ON, enabled: false }, { execution: "swarm" })).toBe(false);
    expect(isSwarmSwitch(SWARM_OFF, { execution: "swarm" })).toBe(false);
    expect(isSwarmSwitch(SINGLETON_ON, { execution: "persistent" })).toBe(false);
  });

  test("switching an enabled rule to swarm is planned like enabling a swarm rule", async () => {
    seed([SINGLETON_ON]);
    const plan = await planned("triage", { execution: "swarm" }, 4);
    expect(plan).toMatchObject({ requiresConfirm: true, confirmReason: "swarm-enable", scope: 4, restarted: 1 });
    const big = await planned("triage", { execution: "swarm" }, ENABLE_SCOPE_CEILING + 1);
    expect(big.confirmReason).toBe("scope-ceiling");
  });

  test("a brief change on an enabled rule needs the stop-restart confirm; on a disabled rule it needs none", async () => {
    seed([SINGLETON_ON, SWARM_OFF]);
    expect(await planned("triage", { brief: "@builtin:bug" })).toMatchObject({ requiresConfirm: true, confirmReason: "stop-restart" });
    expect(await planned("quiet", { brief: "@builtin:bug" })).toMatchObject({ requiresConfirm: false });
  });
});

describe("writeRuleFields — the new fields", () => {
  test("a swarm switch is refused without confirm and written with it", async () => {
    seed([SINGLETON_ON]);
    const scopeOf = async () => 3;
    const plan = await planRuleWrite("triage", { execution: "swarm" }, false, scopeOf, deps());
    if (!plan.ok) throw new Error(plan.error);
    const refused = await writeRuleFields("triage", { execution: "swarm" }, plan.etag, false, plan.planHash, scopeOf, deps());
    expect(refused.ok).toBe(false);
    const written = await writeRuleFields("triage", { execution: "swarm" }, plan.etag, true, plan.planHash, scopeOf, deps());
    expect(written.ok).toBe(true);
    expect(readRules()[0]?.execution).toBe("swarm");
  });

  test("config-only fields write without confirm, and the brief is written verbatim", async () => {
    seed([SWARM_OFF]);
    const patch: RuleFieldPatch = { resumeOnRespawn: false, resumeContextCutoff: 12, brief: "Fix {{KEY}}: {{SUMMARY}}" };
    const plan = await planned("quiet", patch);
    const written = await writeRuleFields("quiet", patch, plan.etag, false, plan.planHash, async () => 0, deps());
    expect(written.ok).toBe(true);
    expect(readRules()[0]).toMatchObject({ resumeOnRespawn: false, resumeContextCutoff: 12, brief: "Fix {{KEY}}: {{SUMMARY}}" });
  });
});

describe("createRule — the new fields", () => {
  test("a create body's brief/execution/resume settings land in the file; absent ones keep the defaults; no account key is written", async () => {
    seed([]);
    const input = { id: "made", resourceProvider: "jira-work" as const, query: "project = Z", brief: "@builtin:story", execution: "persistent" as const, resumeOnRespawn: false, resumeContextCutoff: 7 };
    const scopeOf = async () => 0;
    const plan = await planRuleCreate(input, true, scopeOf, deps());
    if (!plan.ok) throw new Error(plan.error);
    expect((await createRule(input, true, plan.planHash, scopeOf, deps())).ok).toBe(true);
    const plain = { id: "plain", resourceProvider: "jira-work" as const, query: "project = Y" };
    const plan2 = await planRuleCreate(plain, true, scopeOf, deps());
    if (!plan2.ok) throw new Error(plan2.error);
    expect((await createRule(plain, true, plan2.planHash, scopeOf, deps())).ok).toBe(true);
    const [made, other] = readRules();
    expect(made).toMatchObject({ brief: "@builtin:story", execution: "persistent", resumeOnRespawn: false, resumeContextCutoff: 7, enabled: false });
    expect(other).toMatchObject({ brief: "@builtin:task", execution: "swarm" });
    expect("account" in made! || "account" in other!).toBe(false);
  });

  test("a create body's stall threshold and notification delivery land in the file; absent, neither key is written", async () => {
    seed([]);
    const scopeOf = async () => 0;
    const input = { id: "noisy", resourceProvider: "jira-work" as const, query: "project = Z", stalledMinutes: 25, notifyDeliveryMode: "prompt" as const };
    const plan = await planRuleCreate(input, true, scopeOf, deps());
    if (!plan.ok) throw new Error(plan.error);
    expect((await createRule(input, true, plan.planHash, scopeOf, deps())).ok).toBe(true);
    const plain = { id: "plain", resourceProvider: "jira-work" as const, query: "project = Y" };
    const plan2 = await planRuleCreate(plain, true, scopeOf, deps());
    if (!plan2.ok) throw new Error(plan2.error);
    expect((await createRule(plain, true, plan2.planHash, scopeOf, deps())).ok).toBe(true);
    const [made, other] = readRules();
    expect(made).toMatchObject({ stalledMinutes: 25, notifyDeliveryMode: "prompt", enabled: false });
    expect("stalledMinutes" in other! || "notifyDeliveryMode" in other!).toBe(false);
  });
});

describe("GET /api/rules/:id/details and the catalog's built-in briefs", () => {
  const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;
  const baseDeps = (overrides: Partial<ViewDeps>): ViewDeps => {
    const unused = () => {
      throw new Error("unused in this test");
    };
    return { state: unused, open: unused, openPane: unused, health: unused, dashboard: unused, header: unused, resourceLink: unused, configInventory: unused, ...overrides } as ViewDeps;
  };
  const fileState = async () => ({
    path: "x",
    rules: [{ id: "triage", brief: "Full brief for {{KEY}}", execution: "singleton", mcpServers: [{ name: "x", type: "http", url: "http://x", authToken: "shh" }] }] as never,
    error: null,
    mtime: null,
    fileEtag: "e",
  });

  async function withServer(overrides: Partial<ViewDeps>, run: (base: string, headers: Record<string, string>) => Promise<void>) {
    const guard = { port: 0 };
    const app = liveView(fakeMcp, baseDeps({ dashboardOriginGuard: guard, peerUidCheck: () => true, ...overrides }));
    app.listen(0);
    const port = app.server?.port ?? 0;
    guard.port = port;
    try {
      await run(`http://127.0.0.1:${port}`, { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` });
    } finally {
      await app.stop(true);
    }
  }

  test("returns the full brief and the redacted fields behind the same guards as GET /api/rules", async () => {
    await withServer({ rulesFileState: fileState }, async (base, headers) => {
      const ok = await fetch(`${base}/api/rules/triage/details`, { headers });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(await ok.json()).toEqual({
        id: "triage",
        brief: "Full brief for {{KEY}}",
        fields: { id: "triage", execution: "singleton", mcpServers: [{ name: "x", type: "http", url: "http://x", authToken: "[redacted]" }] },
      });
      expect((await fetch(`${base}/api/rules/nope/details`, { headers })).status).toBe(404);
      // Elysia decodes the id once already; a double-encoded escape is what makes this route's own decode throw.
      expect((await fetch(`${base}/api/rules/%25A/details`, { headers })).status).toBe(400);
      expect((await fetch(`${base}/api/rules/triage/details`, { headers: { host: headers.host! } })).status).toBe(403);
    });
  });

  test("is disabled (503) without its deps, and refuses a failed peer check", async () => {
    const app = liveView(fakeMcp, baseDeps({}));
    expect((await app.handle(new Request("http://local/api/rules/triage/details"))).status).toBe(503);
    await withServer({}, async (base, headers) => {
      expect((await fetch(`${base}/api/rules/triage/details`, { headers })).status).toBe(503);
    });
    await withServer({ peerUidCheck: () => false, rulesFileState: fileState }, async (base, headers) => {
      expect((await fetch(`${base}/api/rules/triage/details`, { headers })).status).toBe(403);
    });
    const noPeer = liveView(fakeMcp, baseDeps({ dashboardOriginGuard: { port: 7719 } }));
    expect((await noPeer.handle(new Request("http://local/api/rules/triage/details", { headers: { origin: "http://127.0.0.1:7719", host: "127.0.0.1:7719" } }))).status).toBe(503);
  });

  test("the catalog lists built-in briefs when configured, and leaves the key out otherwise", async () => {
    await withServer({ rulesCatalog: () => [], builtinBriefs: () => [{ name: "task", text: "# task" }] }, async (base, headers) => {
      const body = (await (await fetch(`${base}/api/rules/catalog`, { headers })).json()) as { briefs: unknown };
      expect(body.briefs).toEqual([{ name: "task", text: "# task" }]);
    });
    await withServer({ rulesCatalog: () => [] }, async (base, headers) => {
      const body = (await (await fetch(`${base}/api/rules/catalog`, { headers })).json()) as Record<string, unknown>;
      expect("briefs" in body).toBe(false);
    });
  });
});

describe("measuring a new rule's scope (create dry run)", () => {
  const issue = (key: string): JiraIssue => ({ key, summary: `summary for ${key}`, status: "To Do", issuetype: "Task", assignee: null, parent: null, updated: "2026-01-01", labels: [] });

  test("the previewer measures a not-yet-saved Jira rule when given its provider; a saved rule still wins", async () => {
    const searched: string[] = [];
    const saved = { id: "triage", enabled: false, resourceProvider: "jira-work", query: "project = SAVED", brief: "b", execution: "swarm", role: "worker" } as Rule;
    const preview = createRulesPreviewer({ rules: () => [saved], search: async (jql) => (searched.push(jql), [issue("A-1"), issue("A-2")]), maxAgents: 10, rateLimitMs: 0 });
    expect(await preview("brand-new", "project = NEW")).toMatchObject({ ok: false, status: 404 });
    expect(await preview("brand-new", "project = NEW", "jira-work")).toMatchObject({ ok: true, total: 2 });
    expect(searched.some((q) => q.includes("project = NEW"))).toBe(true);
    expect(await preview("brand-new", "is:open", "github-issue")).toMatchObject({ ok: false, status: 400 });
    const before = searched.length;
    await preview("triage", "project = SAVED", "github-issue");
    expect(searched.length).toBe(before + 1);
  });

  test("planRuleCreate hands the provider to scopeOf, and the scope cache keys on it", async () => {
    seed([]);
    const calls: unknown[][] = [];
    const scopeOf = createScopeCache(async (...args: unknown[]) => {
      calls.push(args);
      return 4;
    });
    const plan = await planRuleCreate({ id: "new-one", resourceProvider: "jira-work", query: "project = Q" }, false, scopeOf, deps());
    expect(plan.ok && plan.scope).toBe(4);
    await planRuleCreate({ id: "new-one", resourceProvider: "jira-work", query: "project = Q" }, false, scopeOf, deps());
    await planRuleCreate({ id: "new-one", resourceProvider: "jira-idea", query: "project = Q" }, false, scopeOf, deps());
    expect(calls).toEqual([
      ["new-one", "project = Q", "jira-work"],
      ["new-one", "project = Q", "jira-idea"],
    ]);
    // Existing call sites, with no provider, still call through with just (id, query).
    await scopeOf("triage", "project = A");
    expect(calls[2]).toEqual(["triage", "project = A"]);
  });
});

describe("linked-change eventing fields", () => {
  test("PUT accepts the switches and counts, and null clears a count", () => {
    expect(validateRuleFieldPatch({ linkedEventing: true, linkedRemoteLinks: false, maxLinkedItems: 4, linkedPollIntervalMs: null })).toEqual({
      ok: true,
      patch: { linkedEventing: true, linkedRemoteLinks: false, maxLinkedItems: 4, linkedPollIntervalMs: null },
    });
  });

  test("FACTORY-252: maxLinkedTurnsPerHour went with the hourly cap, so a PUT or a create carrying it is refused", () => {
    const put = validateRuleFieldPatch({ maxLinkedTurnsPerHour: 4 });
    expect(put.ok ? "" : put.error).toContain('unknown field "maxLinkedTurnsPerHour"');
    const create = validateRuleCreateInput({ id: "linky", resourceProvider: "jira-work", query: "project = C", maxLinkedTurnsPerHour: 4 });
    expect(create.ok).toBe(false);
  });

  test.each([
    [{ linkedEventing: "yes" }, "linkedEventing must be a boolean"],
    [{ linkedDescriptionLinks: null }, "linkedDescriptionLinks must be a boolean"],
    [{ maxLinkedItems: 0 }, "maxLinkedItems must be a positive integer"],
    [{ linkedPollIntervalMs: 1.5 }, "linkedPollIntervalMs must be a positive integer"],
  ])("PUT rejects %j", (body, message) => {
    const r = validateRuleFieldPatch(body);
    expect(r.ok ? "" : r.error).toContain(message);
  });

  test("create accepts them, but not a null count", () => {
    const base = { id: "linky", resourceProvider: "jira-work", query: "project = C" };
    expect(validateRuleCreateInput({ ...base, linkedEventing: true, maxLinkedItems: 10 })).toEqual({ ok: true, input: { ...base, linkedEventing: true, maxLinkedItems: 10 } } as never);
    const r = validateRuleCreateInput({ ...base, maxLinkedItems: null });
    expect(r.ok ? "" : r.error).toContain("maxLinkedItems must be a positive integer");
  });

  test("applying sets the switches, a null count removes its key, and none of it restarts an agent", () => {
    const text = JSON.stringify({ rules: [{ ...SWARM_OFF, maxLinkedItems: 9, linkedPollIntervalMs: 60000 }] });
    const next = JSON.parse(applyRuleFieldPatch(text, "quiet", { linkedEventing: true, linkedDescriptionLinks: true, maxLinkedItems: null, linkedPollIntervalMs: 30000 })).rules[0];
    expect(next).toMatchObject({ linkedEventing: true, linkedDescriptionLinks: true, linkedPollIntervalMs: 30000 });
    expect("maxLinkedItems" in next).toBe(false);
    expect(computeLocalPlanCounts(true, { linkedEventing: true, linkedPollIntervalMs: 30000 }).restarted).toBe(0);
  });

  test("an enabled rule's linked settings write without confirm; a create writes them too", async () => {
    seed([SINGLETON_ON]);
    const patch: RuleFieldPatch = { linkedEventing: true, linkedRemoteLinks: true, maxLinkedItems: 5 };
    const plan = await planned("triage", patch);
    expect((await writeRuleFields("triage", patch, plan.etag, false, plan.planHash, async () => 0, deps())).ok).toBe(true);
    const input = { id: "linky", resourceProvider: "jira-work" as const, query: "project = Z", linkedEventing: true, linkedPollIntervalMs: 120000 };
    const createPlan = await planRuleCreate(input, true, async () => 0, deps());
    if (!createPlan.ok) throw new Error(createPlan.error);
    expect((await createRule(input, true, createPlan.planHash, async () => 0, deps())).ok).toBe(true);
    const [triage, linky] = readRules();
    expect(triage).toMatchObject({ linkedEventing: true, linkedRemoteLinks: true, maxLinkedItems: 5, enabled: true });
    expect(linky).toMatchObject({ linkedEventing: true, linkedPollIntervalMs: 120000, enabled: false });
  });

  test("the rules list carries a knob only when the rule sets it", () => {
    const base = { id: "triage", enabled: true, resourceProvider: "jira-work", query: "project = A", brief: "b", execution: "swarm", role: "worker" } as Rule;
    const entry: RuleInventoryEntry = { kind: "rule", id: "triage", resourceProvider: "jira-work", query: "project = A", enabled: true, execution: "swarm", role: "worker", agentPreferences: [], linkedEventing: true, mcpServerNames: [], staffed: true, reason: null };
    const build = (rule: Rule) => buildRulesApiResponse({ rulesFile: { path: "/rules.json", rules: [rule], error: null }, mtime: null, sourceEtag: "e", fileEtag: "e", ruleInventory: [entry] }).rules[0]!;
    const plain = build(base);
    for (const k of ["linkedPollIntervalMs", "maxLinkedItems", "linkedRemoteLinks", "linkedDescriptionLinks"]) expect(plain).not.toHaveProperty(k);
    expect(build({ ...base, linkedEventing: true, maxLinkedItems: 4, linkedRemoteLinks: false } as Rule)).toMatchObject({ linkedEventing: true, maxLinkedItems: 4, linkedRemoteLinks: false });
  });
});
