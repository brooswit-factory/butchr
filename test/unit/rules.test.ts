import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT_POLICIES, decodeAgentKey, decodeAnyAgentKey, decodeQueryAgentKey, encodeAgentKey, encodeQueryAgentKey,
  EXECUTION_MODES, formatUnresolvedRelationshipWarning, isResourceId, loadRules, parseRules, RESOURCE_PROVIDERS,
  RULE_ID_MAX, rulesPath, unresolvedRelationships, type Rule,
} from "../../src/rules/rules.js";
import { ownsRuleAgent } from "../../src/rules/resource-type.js";
import { ownsGithubIssueAgent } from "../../src/rules/github-issue-type.js";
import { ownsJiraIdeaAgent } from "../../src/rules/jira-idea-type.js";
import { ownsZendeskTicketAgent } from "../../src/rules/zendesk-ticket-type.js";
import { ownsJiraProjectAgent } from "../../src/rules/jira-project-type.js";
import { ownsFilesystemAgent } from "../../src/rules/filesystem-type.js";
import { legacyAgents } from "../../src/daemon/legacy-preflight.js";
import { agentIdOfWorkspacePath, workspaceDirFor } from "../../src/agents/workspace.js";

const minimal = { id: "triage", resourceProvider: "jira-work", query: "project = BUTCHR", brief: "triage it" };
const parsedMinimal = { ...minimal, enabled: true };

describe("rulesPath", () => {
  test("explicit override wins over XDG", () => {
    expect(rulesPath({ BUTCHR_RULES_FILE: " /etc/r.json ", XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/etc/r.json");
  });
  test("XDG_CONFIG_HOME, then HOME/.config; blanks count as unset", () => {
    expect(rulesPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/x/butchr/rules.json");
    expect(rulesPath({ BUTCHR_RULES_FILE: "  ", XDG_CONFIG_HOME: "", HOME: "/h" })).toBe("/h/.config/butchr/rules.json");
  });
});

describe("loadRules", () => {
  test("absent default file is zero rules, marked missing, and nothing is written", () => {
    const writes: string[] = [];
    const r = loadRules({ XDG_CONFIG_HOME: "/x" }, (p) => { writes.push(p); return undefined; });
    expect(r).toEqual({ path: "/x/butchr/rules.json", origin: "missing", rules: [] });
    expect(writes).toEqual(["/x/butchr/rules.json"]);
  });
  test("an explicit BUTCHR_RULES_FILE that does not exist is an error, never zero rules", () => {
    expect(() => loadRules({ BUTCHR_RULES_FILE: " /nope.json ", XDG_CONFIG_HOME: "/x" }, () => undefined)).toThrow("BUTCHR_RULES_FILE /nope.json does not exist");
    const dir = mkdtempSync(join(tmpdir(), "butchr-rules-"));
    try {
      expect(() => loadRules({ BUTCHR_RULES_FILE: join(dir, "missing.json") })).toThrow("does not exist");
      // A blank override is unset: the absent default is still zero rules.
      expect(loadRules({ BUTCHR_RULES_FILE: "  ", XDG_CONFIG_HOME: dir })).toMatchObject({ origin: "missing", rules: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("a present empty file is also zero rules", () => {
    expect(loadRules({ BUTCHR_RULES_FILE: "/r.json" }, () => '{"rules":[]}')).toEqual({ path: "/r.json", origin: "file", rules: [] });
  });
  test("default reader: absent file is missing, present file parses, a directory throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-rules-"));
    try {
      expect(loadRules({ XDG_CONFIG_HOME: dir })).toEqual({ path: join(dir, "butchr", "rules.json"), origin: "missing", rules: [] });
      mkdirSync(join(dir, "butchr"));
      writeFileSync(join(dir, "butchr", "rules.json"), JSON.stringify({ rules: [minimal] }));
      expect(loadRules({ XDG_CONFIG_HOME: dir })).toEqual({ path: join(dir, "butchr", "rules.json"), origin: "file", rules: [{ ...parsedMinimal, execution: "swarm", account: "none", role: "worker" } as never] });
      expect(() => loadRules({ BUTCHR_RULES_FILE: dir })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("invalid JSON names the file", () => {
    expect(() => loadRules({ BUTCHR_RULES_FILE: "/r.json" }, () => "{")).toThrow("/r.json: invalid JSON");
  });
});

describe("parseRules", () => {
  test("a @builtin:<type> brief must name a shipped brief; the type is case-insensitive", () => {
    expect(parseRules({ rules: [{ ...minimal, brief: "@builtin:bug" }, { ...minimal, id: "epics", brief: "@builtin:Epic" }] }).map((r) => r.brief)).toEqual(["@builtin:bug", "@builtin:Epic"]);
    expect(() => parseRules({ rules: [{ ...minimal, brief: "@builtin:stroy" }] })).toThrow('rules[0].brief names unknown built-in brief "stroy"');
  });
  test("accepts every optional setting and normalises", () => {
    const full = {
      ...minimal, enabled: false, query: " status = Open ",
      agentPreferences: [{ harness: "codex", model: " gpt-5 ", effort: "xhigh" }, { harness: "claude" }, { harness: "claude", model: "haiku" }],
      relationships: { childRule: "triage", inwardConnectionRules: ["other"] },
    };
    const other = { ...minimal, id: "other" };
    expect(parseRules({ rules: [full, other] })).toEqual([
      { ...full, query: "status = Open", execution: "swarm", account: "none", role: "worker", agentPreferences: [{ harness: "codex", model: "gpt-5", effort: "xhigh" }, { harness: "claude" }, { harness: "claude", model: "haiku" }] },
      { ...other, enabled: true, execution: "swarm", account: "none", role: "worker" },
    ] as never);
  });
  test("omitted optionals stay absent; enabled/execution/account/role default to true/swarm/none/worker", () => {
    const [r] = parseRules({ rules: [minimal] });
    expect(Object.keys(r!).sort()).toEqual(["account", "brief", "enabled", "execution", "id", "query", "resourceProvider", "role"]);
    expect(r!.enabled).toBe(true);
    expect(r!.execution).toBe("swarm");
    expect(r!.account).toBe("none");
    expect(r!.role).toBe("worker");
  });
  test("rejects a non-document", () => {
    for (const doc of [null, [], {}, { rules: {} }]) expect(() => parseRules(doc)).toThrow('"rules" array');
  });
  test("reports every problem at once", () => {
    let msg = "";
    try {
      parseRules({ rules: [
        "nope",
        { ...minimal, id: "Bad.Id", enabled: "yes", resourceProvider: "jira", query: " ", brief: 3, role: "manager", extra: 1 },
        { ...minimal, id: "prefs-bad", agentPreferences: [] },
        { ...minimal, id: "prefs-bad-2", agentPreferences: ["x", { harness: "gpt", model: "", effort: "extreme", provider: "claude" }, { harness: "claude" }, { harness: "claude" }] },
        { ...minimal, id: "rel-bad", relationships: "story" },
        { ...minimal, id: "rel-bad-2", relationships: { childRule: "Story", inwardConnectionRules: "x", reportsTo: "parent" } },
        { ...minimal, id: "rel-bad-3", relationships: { inwardConnectionRules: ["a", "a"] } },
        { ...minimal, id: "rel-dangling", relationships: { childRule: "missing", inwardConnectionRules: ["rel-bad", "gone"] } },
      ] }, "f.json");
    } catch (e) { msg = (e as Error).message; }
    for (const part of [
      "rules[0] must be an object", "rules[1].id", "rules[1].enabled", "rules[1].resourceProvider", "rules[1].query", "rules[1].brief",
      "rules[1].role must be one of worker, sentinel", 'rules[1] has unknown field "extra"',
      "rules[2].agentPreferences must be a non-empty array",
      "rules[3].agentPreferences[0] must be an object", "rules[3].agentPreferences[1].harness", "rules[3].agentPreferences[1].model",
      "rules[3].agentPreferences[1].effort", 'rules[3].agentPreferences[1] has unknown field "provider"', "rules[3].agentPreferences[3] repeats",
      "rules[4].relationships must be an object", "rules[5].relationships.childRule must be a rule id",
      "rules[5].relationships.inwardConnectionRules must be an array", 'rules[5].relationships has unknown field "reportsTo"',
      "rules[6].relationships.inwardConnectionRules has duplicates",
      'rules[7].relationships.childRule references unknown rule "missing"', 'rules[7].relationships.inwardConnectionRules references unknown rule "gone"',
    ]) expect(msg).toContain(`f.json: ${part}`);
    expect(msg).not.toContain(`unknown rule "rel-bad"`);
  });
  test("relationships may target a rule declared later, or a disabled one", () => {
    expect(parseRules({ rules: [{ ...minimal, relationships: { childRule: "later" } }, { ...minimal, id: "later", enabled: false }] })).toHaveLength(2);
  });
  test("duplicate ids are rejected; distinct rules may share a query", () => {
    expect(() => parseRules({ rules: [minimal, minimal] })).toThrow('rules[1].id "triage" is a duplicate');
    expect(parseRules({ rules: [minimal, { ...minimal, id: "review" }] })).toHaveLength(2);
  });
  test("rule id shape", () => {
    for (const id of ["a", "triage-2", "x".repeat(RULE_ID_MAX)]) expect(parseRules({ rules: [{ ...minimal, id }] })).toHaveLength(1);
    for (const id of ["", "-a", "a-", "a--b", "A", "a.b", "a_b", "a:b", "x".repeat(RULE_ID_MAX + 1), 7])
      expect(() => parseRules({ rules: [{ ...minimal, id }] })).toThrow(".id must be");
  });
});

describe("unresolvedRelationships", () => {
  const rule = (over: Partial<Rule>): Rule => ({ id: "x", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "swarm", account: "none", role: "worker", ...over });

  test("childRule naming an absent id is reported", () => {
    expect(unresolvedRelationships([rule({ id: "task", relationships: { childRule: "missing" } })]))
      .toEqual([{ ruleId: "task", field: "childRule", missingTarget: "missing" }]);
  });

  test("inwardConnectionRules naming an absent id is reported, separately from childRule", () => {
    expect(unresolvedRelationships([rule({ id: "task", relationships: { inwardConnectionRules: ["missing"] } })]))
      .toEqual([{ ruleId: "task", field: "inwardConnectionRules", missingTarget: "missing" }]);
  });

  test("of a list where one entry resolves and one doesn't, only the missing one is reported", () => {
    expect(unresolvedRelationships([
      rule({ id: "task", relationships: { inwardConnectionRules: ["story", "gone"] } }),
      rule({ id: "story" }),
    ])).toEqual([{ ruleId: "task", field: "inwardConnectionRules", missingTarget: "gone" }]);
  });

  test("negative: every relationship resolves to an id present in the same rules -> nothing reported", () => {
    expect(unresolvedRelationships([
      rule({ id: "task", relationships: { childRule: "story", inwardConnectionRules: ["story"] } }),
      rule({ id: "story" }),
    ])).toEqual([]);
  });

  test("a disabled SOURCE rule is not reported, even with a dangling reference", () => {
    expect(unresolvedRelationships([rule({ id: "task", enabled: false, relationships: { childRule: "missing" } })])).toEqual([]);
  });

  test("a disabled TARGET still counts as resolved — this check is existence-only, never enabled-ness", () => {
    expect(unresolvedRelationships([
      rule({ id: "task", relationships: { childRule: "story" } }),
      rule({ id: "story", enabled: false }),
    ])).toEqual([]);
  });

  test("only jira-work rules are reported — a jira-idea rule's inwardConnectionRules is out of scope here", () => {
    expect(unresolvedRelationships([rule({ id: "idea", resourceProvider: "jira-idea", relationships: { inwardConnectionRules: ["missing"] } })])).toEqual([]);
  });

  test("a rule with no relationships at all is skipped, not an error", () => {
    expect(unresolvedRelationships([rule({ id: "task" })])).toEqual([]);
  });
});

describe("formatUnresolvedRelationshipWarning", () => {
  test("names the source rule, the field, and the missing target", () => {
    const msg = formatUnresolvedRelationshipWarning({ ruleId: "task", field: "childRule", missingTarget: "story" });
    expect(msg).toContain('rule "task"');
    expect(msg).toContain("childRule");
    expect(msg).toContain('"story"');
  });
});

describe("execution and account (BUTCHR-397)", () => {
  test("both default when absent: swarm/none, exactly today's behaviour", () => {
    const [r] = parseRules({ rules: [minimal] });
    expect(r).toMatchObject({ execution: "swarm", account: "none" });
  });
  test("every valid value is accepted for every provider — the two fields are provider-generic", () => {
    for (const resourceProvider of RESOURCE_PROVIDERS) {
      for (const execution of EXECUTION_MODES) for (const account of ACCOUNT_POLICIES) {
        const base = resourceProvider === "github-issue" ? "is:issue label:x" : resourceProvider === "zendesk-ticket" ? "status:open" : resourceProvider === "jira-project" ? '{"keys":["BUTCHR"]}' : resourceProvider === "filesystem" ? JSON.stringify({ root: "/tmp", kind: "file" }) : minimal.query;
        const [r] = parseRules({ rules: [{ ...minimal, resourceProvider, query: base, execution, account }] });
        expect(r).toMatchObject({ resourceProvider, execution, account });
      }
    }
  });
  test("every combination of execution and account is independently valid (no forbidden pairing)", () => {
    for (const execution of EXECUTION_MODES) for (const account of ACCOUNT_POLICIES) {
      expect(parseRules({ rules: [{ ...minimal, execution, account }] })).toHaveLength(1);
    }
  });
  test("rejects a bad execution or account value, naming the rule and field", () => {
    expect(() => parseRules({ rules: [{ ...minimal, execution: "solo" }] }, "f.json")).toThrow("f.json: rules[0].execution must be one of swarm, singleton, persistent");
    expect(() => parseRules({ rules: [{ ...minimal, account: "forever" }] }, "f.json")).toThrow("f.json: rules[0].account must be one of none, temporary, permanent");
  });
  test("both bad at once are both reported", () => {
    let msg = "";
    try { parseRules({ rules: [{ ...minimal, execution: 7, account: "" }] }, "f.json"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("f.json: rules[0].execution must be one of");
    expect(msg).toContain("f.json: rules[0].account must be one of");
  });
  test("a pre-change rules document (no execution/account) loads unchanged, plus the two defaults, with byte-identical swarm agent keys", () => {
    // A realistic pre-BUTCHR-397 document: exactly what shipped with PRs #370/#372.
    const preChangeDoc = {
      rules: [
        { id: "triage", resourceProvider: "jira-work", query: "project = BUTCHR AND status = Open", brief: "Triage it." },
        {
          id: "epics", resourceProvider: "jira-work", query: "issuetype = Epic", brief: "@builtin:epic", enabled: true,
          agentPreferences: [{ harness: "claude", model: "opus" }],
          relationships: { childRule: "triage" },
        },
      ],
    };
    const rules = parseRules(preChangeDoc);
    expect(rules).toEqual([
      { id: "triage", enabled: true, resourceProvider: "jira-work", query: "project = BUTCHR AND status = Open", brief: "Triage it.", execution: "swarm", account: "none", role: "worker" },
      {
        id: "epics", enabled: true, resourceProvider: "jira-work", query: "issuetype = Epic", brief: "@builtin:epic", execution: "swarm", account: "none", role: "worker",
        agentPreferences: [{ harness: "claude", model: "opus" }], relationships: { childRule: "triage" },
      },
    ] as never);
    // The agent key a swarm rule's match produces is a pure function of (resourceProvider, ruleId, resourceId) —
    // execution/account are not inputs to encodeAgentKey at all, so today's keys cannot have moved (no migration, no workspace moves).
    for (const r of rules) expect(encodeAgentKey({ resourceProvider: r.resourceProvider, ruleId: r.id, resourceId: "BUTCHR-12" })).toBe(`${r.resourceProvider}:${r.id}:BUTCHR-12`);
  });
});

describe("role (BUTCHR-398 — fleet capacity: worker default, sentinel opt-out)", () => {
  test("defaults to worker when absent: today's behaviour, exactly", () => {
    const [r] = parseRules({ rules: [minimal] });
    expect(r).toMatchObject({ role: "worker" });
  });
  test("both values are accepted for every provider, independent of execution and account", () => {
    for (const resourceProvider of RESOURCE_PROVIDERS) {
      const base = resourceProvider === "github-issue" ? "is:issue label:x" : resourceProvider === "zendesk-ticket" ? "status:open" : resourceProvider === "jira-project" ? '{"keys":["BUTCHR"]}' : resourceProvider === "filesystem" ? JSON.stringify({ root: "/tmp", kind: "file" }) : minimal.query;
      for (const role of ["worker", "sentinel"] as const) for (const execution of EXECUTION_MODES) {
        const [r] = parseRules({ rules: [{ ...minimal, resourceProvider, query: base, role, execution }] });
        expect(r).toMatchObject({ resourceProvider, role, execution });
      }
    }
  });
  test("rejects a bad role value, naming the rule and field", () => {
    expect(() => parseRules({ rules: [{ ...minimal, role: "manager" }] }, "f.json")).toThrow("f.json: rules[0].role must be one of worker, sentinel");
  });
  test("a pre-change rules document (no role) loads unchanged, plus the worker default — no example/shipped rules file needs to opt in", () => {
    const preChangeDoc = { rules: [{ id: "triage", resourceProvider: "jira-work", query: "project = BUTCHR", brief: "Triage it." }] };
    expect(parseRules(preChangeDoc)).toEqual([
      { id: "triage", enabled: true, resourceProvider: "jira-work", query: "project = BUTCHR", brief: "Triage it.", execution: "swarm", account: "none", role: "worker" },
    ] as never);
  });
});

describe("mcpServers bindings (BUTCHR-411 — bind any MCP channel server to a rule)", () => {
  const mud = { name: "mud", type: "http", url: "https://mud.example/mcp", channel: true };

  test("absent means none — existing rules load unchanged with no new field", () => {
    const [r] = parseRules({ rules: [minimal] });
    expect(r!.mcpServers).toBeUndefined();
    expect(Object.keys(r!)).not.toContain("mcpServers");
  });

  test("a bound server is accepted, normalised, and independent of execution/account — the Candlestix mud-bridge shape (account: none, no RC)", () => {
    const [r] = parseRules({ rules: [{ ...minimal, account: "none", mcpServers: [mud] }] });
    expect(r!.mcpServers).toEqual([{ name: "mud", type: "http", url: "https://mud.example/mcp", channel: true }]);
    expect(r!.account).toBe("none");
  });

  test("a channel: false binding is accepted the same way — tools yes, channel no", () => {
    const [r] = parseRules({ rules: [{ ...minimal, mcpServers: [{ ...mud, channel: false }] }] });
    expect(r!.mcpServers).toEqual([{ name: "mud", type: "http", url: "https://mud.example/mcp", channel: false }]);
  });

  test("two channel servers on one rule both parse", () => {
    const [r] = parseRules({ rules: [{ ...minimal, mcpServers: [mud, { name: "second", type: "http", url: "https://second.example/mcp", channel: true }] }] });
    expect(r!.mcpServers).toHaveLength(2);
  });

  test("headersEnvVar names an env var; never a literal header value", () => {
    const [r] = parseRules({ rules: [{ ...minimal, mcpServers: [{ ...mud, headersEnvVar: " MUD_MCP_HEADERS " }] }] });
    expect(r!.mcpServers).toEqual([{ name: "mud", type: "http", url: "https://mud.example/mcp", headersEnvVar: "MUD_MCP_HEADERS", channel: true }]);
  });

  // BUTCHR-413 (CHANGES_REQUESTED review finding 1): the small, explicit
  // extension to this binding's own contract — a non-secret, per-agent
  // account-identifying header name, distinct from headersEnvVar's secret
  // env-var-name shape. See McpServerBinding.accountHeader's own doc
  // comment (src/rules/rules.ts) for why the two are not equally safe on
  // Codex argv.
  test("accountHeader names an HTTP header and coexists with headersEnvVar", () => {
    const [r] = parseRules({ rules: [{ ...minimal, mcpServers: [{ ...mud, headersEnvVar: "MUD_MCP_HEADERS", accountHeader: " x-rocketr-account " }] }] });
    expect(r!.mcpServers).toEqual([{ name: "mud", type: "http", url: "https://mud.example/mcp", headersEnvVar: "MUD_MCP_HEADERS", accountHeader: "x-rocketr-account", channel: true }]);
  });

  test("accountHeader alone, with no headersEnvVar at all, is accepted", () => {
    const [r] = parseRules({ rules: [{ ...minimal, mcpServers: [{ ...mud, accountHeader: "x-rocketr-account" }] }] });
    expect(r!.mcpServers).toEqual([{ name: "mud", type: "http", url: "https://mud.example/mcp", accountHeader: "x-rocketr-account", channel: true }]);
  });

  test("an invalid accountHeader (not an HTTP token) is rejected, naming the rule and field", () => {
    expect(() => parseRules({ rules: [{ ...minimal, mcpServers: [{ ...mud, accountHeader: "not a header" }] }] }, "f.json")).toThrow("f.json: rules[0].mcpServers[0].accountHeader must be an HTTP header name");
    expect(() => parseRules({ rules: [{ ...minimal, mcpServers: [{ ...mud, accountHeader: "" }] }] }, "f.json")).toThrow("f.json: rules[0].mcpServers[0].accountHeader must be an HTTP header name");
  });

  test("an empty array is rejected the same way agentPreferences is", () => {
    expect(() => parseRules({ rules: [{ ...minimal, mcpServers: [] }] }, "f.json")).toThrow("f.json: rules[0].mcpServers must be a non-empty array");
  });

  test("reports every malformed binding problem at once", () => {
    let msg = "";
    try {
      parseRules({ rules: [{ ...minimal, mcpServers: [
        "nope",
        { name: "", type: "http", url: "not a url", channel: "yes" },
        { name: "bad name!", type: "stdio", url: "ftp://x", channel: true, extra: 1 },
        { name: "butchr", type: "http", url: "https://x", channel: true },
        { name: "dup", type: "http", url: "https://x", channel: true },
        { name: "dup", type: "http", url: "https://y", channel: false },
        { name: "envbad", type: "http", url: "https://x", channel: true, headersEnvVar: "lower_case" },
      ] }] }, "f.json");
    } catch (e) { msg = (e as Error).message; }
    for (const part of [
      "rules[0].mcpServers[0] must be an object",
      "rules[0].mcpServers[1].name must be a non-empty name",
      "rules[0].mcpServers[1].url must be an absolute http(s) URL",
      "rules[0].mcpServers[1].channel must be a boolean",
      "rules[0].mcpServers[2].name must be a non-empty name",
      "rules[0].mcpServers[2].type must be one of http",
      "rules[0].mcpServers[2].url must be an absolute http(s) URL",
      'rules[0].mcpServers[2] has unknown field "extra"',
      'rules[0].mcpServers[3].name "butchr" is reserved',
      'rules[0].mcpServers[5].name "dup" is a duplicate',
      "rules[0].mcpServers[6].headersEnvVar must be an env var name",
    ]) expect(msg).toContain(`f.json: ${part}`);
  });

  test("url must be absolute http(s) — a relative path or another scheme is rejected", () => {
    for (const url of ["/relative", "ftp://x.example", "not-a-url", ""]) {
      expect(() => parseRules({ rules: [{ ...minimal, mcpServers: [{ ...mud, url }] }] })).toThrow(".mcpServers[0].url must be an absolute http(s) URL");
    }
  });

  test("mcpServers is rejected on the same terms as every other unknown-field-checked block", () => {
    expect(() => parseRules({ rules: [{ ...minimal, mcpServers: "nope" }] }, "f.json")).toThrow("f.json: rules[0].mcpServers must be a non-empty array");
  });
});

describe("linked-eventing knobs (BUTCHR-429/BUTCHR-436 — additive, default inert)", () => {
  test("all five are absent when omitted — unlike execution/account/role, there is no defaulted value", () => {
    const [r] = parseRules({ rules: [minimal] });
    expect(Object.keys(r!).sort()).toEqual(["account", "brief", "enabled", "execution", "id", "query", "resourceProvider", "role"]);
    expect(r!.linkedEventing).toBeUndefined();
    expect(r!.linkedPollIntervalMs).toBeUndefined();
    expect(r!.maxLinkedItems).toBeUndefined();
    expect(r!.maxLinkedTurnsPerHour).toBeUndefined();
    expect(r!.linkedRemoteLinks).toBeUndefined();
  });

  test("each is accepted when valid, independent of the others and of every other field", () => {
    const [r] = parseRules({ rules: [{ ...minimal, linkedEventing: true, linkedPollIntervalMs: 300_000, maxLinkedItems: 25, maxLinkedTurnsPerHour: 4, linkedRemoteLinks: true }] });
    expect(r).toMatchObject({ linkedEventing: true, linkedPollIntervalMs: 300_000, maxLinkedItems: 25, maxLinkedTurnsPerHour: 4, linkedRemoteLinks: true });
  });

  test("linkedEventing: false is accepted and kept (distinct from omitted, even though both are inert today)", () => {
    const [r] = parseRules({ rules: [{ ...minimal, linkedEventing: false }] });
    expect(r!.linkedEventing).toBe(false);
  });

  // BUTCHR-436: linkedRemoteLinks is NOT inert — a resource whose rule sets
  // it fetches remote links (src/jira-watch/linked-eventing.ts) — but its
  // OWN validation/plumbing is exactly this same additive, independently-
  // optional shape, so it is tested alongside its four siblings here rather
  // than in a separate describe block.
  test("linkedRemoteLinks: false is accepted and kept, distinct from omitted", () => {
    const [r] = parseRules({ rules: [{ ...minimal, linkedRemoteLinks: false }] });
    expect(r!.linkedRemoteLinks).toBe(false);
  });

  test("every valid value is accepted for every provider — provider-generic, like execution/account/role", () => {
    for (const resourceProvider of RESOURCE_PROVIDERS) {
      const base = resourceProvider === "github-issue" ? "is:issue label:x" : resourceProvider === "zendesk-ticket" ? "status:open" : resourceProvider === "jira-project" ? '{"keys":["BUTCHR"]}' : resourceProvider === "filesystem" ? JSON.stringify({ root: "/tmp", kind: "file" }) : minimal.query;
      const [r] = parseRules({ rules: [{ ...minimal, resourceProvider, query: base, linkedEventing: true, linkedPollIntervalMs: 1, maxLinkedItems: 1, maxLinkedTurnsPerHour: 1, linkedRemoteLinks: true }] });
      expect(r).toMatchObject({ resourceProvider, linkedEventing: true, linkedPollIntervalMs: 1, maxLinkedItems: 1, maxLinkedTurnsPerHour: 1, linkedRemoteLinks: true });
    }
  });

  test("rejects a non-boolean linkedEventing or linkedRemoteLinks", () => {
    expect(() => parseRules({ rules: [{ ...minimal, linkedEventing: "yes" }] }, "f.json")).toThrow("f.json: rules[0].linkedEventing must be a boolean");
    expect(() => parseRules({ rules: [{ ...minimal, linkedRemoteLinks: "yes" }] }, "f.json")).toThrow("f.json: rules[0].linkedRemoteLinks must be a boolean");
  });

  test("rejects a non-positive-integer for each numeric knob, naming the rule and field", () => {
    for (const field of ["linkedPollIntervalMs", "maxLinkedItems", "maxLinkedTurnsPerHour"] as const) {
      for (const bad of [0, -1, 1.5, "5", null]) {
        expect(() => parseRules({ rules: [{ ...minimal, [field]: bad }] }, "f.json")).toThrow(`f.json: rules[0].${field} must be a positive integer`);
      }
    }
  });

  test("all five bad at once are all reported together", () => {
    let msg = "";
    try { parseRules({ rules: [{ ...minimal, linkedEventing: 1, linkedPollIntervalMs: 0, maxLinkedItems: -5, maxLinkedTurnsPerHour: "many", linkedRemoteLinks: "no" }] }, "f.json"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("f.json: rules[0].linkedEventing must be a boolean");
    expect(msg).toContain("f.json: rules[0].linkedPollIntervalMs must be a positive integer");
    expect(msg).toContain("f.json: rules[0].maxLinkedItems must be a positive integer");
    expect(msg).toContain("f.json: rules[0].maxLinkedTurnsPerHour must be a positive integer");
    expect(msg).toContain("f.json: rules[0].linkedRemoteLinks must be a boolean");
  });

  test("a pre-change rules document (none of the five set) loads unchanged — no existing rules file needs to opt in", () => {
    const preChangeDoc = { rules: [{ id: "triage", resourceProvider: "jira-work", query: "project = BUTCHR", brief: "Triage it." }] };
    expect(parseRules(preChangeDoc)).toEqual([
      { id: "triage", enabled: true, resourceProvider: "jira-work", query: "project = BUTCHR", brief: "Triage it.", execution: "swarm", account: "none", role: "worker" },
    ] as never);
  });
});

describe("agent keys", () => {
  const parts = { resourceProvider: "jira-work" as const, ruleId: "triage", resourceId: "BUTCHR-12" };
  test("encodes provider, rule id and native resource id as separate components, and round-trips", () => {
    expect(encodeAgentKey(parts)).toBe("jira-work:triage:BUTCHR-12");
    expect(encodeAgentKey({ ...parts, resourceId: "MY_PROJ-7" })).toBe("jira-work:triage:MY_PROJ-7");
    expect(decodeAgentKey("jira-work:triage:BUTCHR-12")).toEqual(parts);
  });
  test("several rules on one resource, and one rule on many resources, get distinct keys", () => {
    const keys = new Set<string>();
    for (const ruleId of ["a", "a-b", "b", "ab"]) for (const resourceId of ["A-1", "AB-1", "A_B-1", "A-11"])
      keys.add(encodeAgentKey({ ...parts, ruleId, resourceId }));
    expect(keys.size).toBe(16);
  });
  test("refuses to encode invalid components, including project keys", () => {
    expect(() => encodeAgentKey({ ...parts, ruleId: "a:b" })).toThrow("rule id");
    expect(() => encodeAgentKey({ ...parts, resourceProvider: "jira" as never })).toThrow("resource provider");
    for (const resourceId of ["BUTCHR", "x-1", "X:1", "", "X-"]) expect(() => encodeAgentKey({ ...parts, resourceId })).toThrow("resource id");
  });
  test("decode rejects anything encode could not produce", () => {
    for (const key of [
      "BUTCHR-12", "BUTCHR", "", "jira-work:triage", "jira-work:triage:BUTCHR-12:x", "jira:triage:BUTCHR-12",
      "jira-work:Triage:BUTCHR-12", "jira-work:triage:BUTCHR", "jira-work:triage:%", // malformed escape
      "jira-work:tri%61ge:BUTCHR-12", // decodes validly but is not canonical
      "rule.triage.jira.BUTCHR-12", // the first slice's format
    ]) expect(decodeAgentKey(key)).toBeNull();
  });
});

describe("query-level agent keys (BUTCHR-397)", () => {
  const qparts = { resourceProvider: "jira-work" as const, ruleId: "triage" };

  test("encodes provider and rule id alone (no resource), and round-trips", () => {
    expect(encodeQueryAgentKey(qparts)).toBe("jira-work:triage:%40query");
    expect(decodeQueryAgentKey("jira-work:triage:%40query")).toEqual(qparts);
  });

  test("derived only from provider + rule id: same inputs always produce the same key, with no resource involved at all", () => {
    expect(encodeQueryAgentKey(qparts)).toBe(encodeQueryAgentKey({ ...qparts }));
    expect(encodeQueryAgentKey(qparts)).not.toContain("BUTCHR");
  });

  test("distinct rules, or distinct providers, get distinct query-level keys", () => {
    const keys = new Set<string>();
    for (const resourceProvider of RESOURCE_PROVIDERS) for (const ruleId of ["a", "a-b", "b", "ab"]) keys.add(encodeQueryAgentKey({ resourceProvider, ruleId }));
    expect(keys.size).toBe(RESOURCE_PROVIDERS.length * 4);
  });

  test("refuses to encode an invalid provider or rule id, same as encodeAgentKey", () => {
    expect(() => encodeQueryAgentKey({ ...qparts, ruleId: "a:b" })).toThrow("rule id");
    expect(() => encodeQueryAgentKey({ ...qparts, resourceProvider: "jira" as never })).toThrow("resource provider");
  });

  test("decodeQueryAgentKey rejects anything encodeQueryAgentKey could not have produced, including every per-resource key", () => {
    for (const key of [
      "jira-work:triage:BUTCHR-12", // a real per-resource key
      "jira-work:triage", "jira-work:triage:%40query:x", "jira:triage:%40query",
      "jira-work:Triage:%40query", "jira-work:triage:%40queries", "jira-work:triage:%40Query",
      "jira-work:triage:@query", // decodes to the right marker but is NOT the canonical (percent-escaped) encoding
      "jira-work:tri%61ge:%40query", // decodes validly but is not canonical
      "jira-work:triage:%", // malformed escape
      "", "BUTCHR-12",
    ]) expect(decodeQueryAgentKey(key)).toBeNull();
  });

  test("decodeAgentKey (per-resource) rejects every query-level key, and vice versa — the two never overlap", () => {
    for (const resourceProvider of RESOURCE_PROVIDERS) for (const ruleId of ["triage", "a-b"]) {
      const queryKey = encodeQueryAgentKey({ resourceProvider, ruleId });
      expect(decodeAgentKey(queryKey)).toBeNull();
      const resourceKey = encodeAgentKey({ resourceProvider, ruleId, resourceId: exampleResourceId(resourceProvider) });
      expect(decodeQueryAgentKey(resourceKey)).toBeNull();
    }
  });

  test("the query marker can never be mistaken for a real resource id, for any provider — the actual non-collision proof", () => {
    // This is what makes decodeAgentKey/decodeQueryAgentKey mutually exclusive by construction,
    // not by coincidence: encodeQueryAgentKey's marker fails isResourceId for every provider.
    for (const resourceProvider of RESOURCE_PROVIDERS) expect(isResourceId(resourceProvider, "@query")).toBe(false);
  });

  test("decodeAnyAgentKey recognises either shape, tagged, and null for neither", () => {
    expect(decodeAnyAgentKey("jira-work:triage:BUTCHR-12")).toEqual({ kind: "resource", resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-12" });
    expect(decodeAnyAgentKey("jira-work:triage:%40query")).toEqual({ kind: "query", resourceProvider: "jira-work", ruleId: "triage" });
    expect(decodeAnyAgentKey("jira-work:triage")).toBeNull();
    expect(decodeAnyAgentKey("not a key at all")).toBeNull();
  });

  test("restart-stability: encoding is a pure function of (provider, ruleId) alone, so the same rule always names the same one agent across restarts", () => {
    for (let i = 0; i < 5; i++) expect(encodeQueryAgentKey(qparts)).toBe("jira-work:triage:%40query");
  });

  test("every provider's ownership predicate recognises its own query-level agent, and no other provider's", () => {
    const owners: Record<(typeof RESOURCE_PROVIDERS)[number], (id: string) => boolean> = {
      "jira-work": ownsRuleAgent, "github-issue": ownsGithubIssueAgent, "jira-idea": ownsJiraIdeaAgent, "zendesk-ticket": ownsZendeskTicketAgent, "jira-project": ownsJiraProjectAgent, "filesystem": ownsFilesystemAgent,
    };
    for (const resourceProvider of RESOURCE_PROVIDERS) {
      const key = encodeQueryAgentKey({ resourceProvider, ruleId: "triage" });
      for (const [otherProvider, owns] of Object.entries(owners)) expect(owns(key)).toBe(otherProvider === resourceProvider);
    }
  });

  test("a query-level workspace is never flagged by the legacy-workspace startup preflight", () => {
    const root = "/w";
    for (const resourceProvider of RESOURCE_PROVIDERS) {
      const key = encodeQueryAgentKey({ resourceProvider, ruleId: "triage" });
      const cwd = workspaceDirFor(key, root);
      expect(agentIdOfWorkspacePath(cwd, root)).toBe(key);
      expect(legacyAgents([{ pane_id: "p1", cwd }], root)).toEqual([]);
    }
  });
});

function exampleResourceId(provider: (typeof RESOURCE_PROVIDERS)[number]): string {
  switch (provider) {
    case "jira-work": case "jira-idea": return "BUTCHR-12";
    case "github-issue": return "owner/repo#12";
    case "zendesk-ticket": return "acme#12";
    case "jira-project": return "BUTCHR";
    case "filesystem": return "/tmp/example.txt";
  }
}
