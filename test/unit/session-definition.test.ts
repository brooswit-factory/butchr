import { describe, expect, test } from "bun:test";
import {
  parseSessionDefinition, parseSessionDefinitionFile, sessionDefinitionProblems, sessionDefinitionsPath,
  tierToModel, effectiveAgent, SESSION_DEFINITION_VENDORS, SESSION_PERMISSION_MODES, SESSION_TIERS,
} from "../../src/resources/session-definition.js";

const HOME = "/home/tester";
const good = () => ({
  workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "auto",
});

describe("sessionDefinitionProblems", () => {
  test("a minimal valid definition has no problems", () => {
    expect(sessionDefinitionProblems(good(), "def")).toEqual([]);
  });
  test("execution/account/role/frozen are optional and default sensibly when validated via parseSessionDefinition", () => {
    expect(sessionDefinitionProblems(good(), "def")).toEqual([]);
    const parsed = parseSessionDefinition(good(), "def", HOME);
    expect(parsed.execution).toBe("swarm");
    expect(parsed.account).toBe("none");
    expect(parsed.role).toBe("worker");
    expect(parsed.frozen).toBe(false);
  });
  test("a non-object document is rejected", () => {
    expect(sessionDefinitionProblems("nope", "def")).toEqual(["def must be a JSON object"]);
    expect(sessionDefinitionProblems([], "def")).toEqual(["def must be a JSON object"]);
    expect(sessionDefinitionProblems(null, "def")).toEqual(["def must be a JSON object"]);
  });
  test("an unknown field is rejected", () => {
    expect(sessionDefinitionProblems({ ...good(), bogus: 1 }, "def")).toEqual(['def has unknown field "bogus"']);
  });
  test("workingDirectory: non-empty, absolute or ~-relative, canonical, no trailing slash", () => {
    const at = (workingDirectory: unknown) => sessionDefinitionProblems({ ...good(), workingDirectory }, "def", HOME);
    expect(at("")[0]).toContain("workingDirectory must be a non-empty string");
    expect(at(7)[0]).toContain("workingDirectory must be a non-empty string");
    expect(at("relative/path")[0]).toContain("must be absolute");
    expect(at("/a/")[0]).toContain("trailing slash");
    expect(at("~otheruser/x")[0]).toContain("~user is not supported");
    expect(at("~/work")).toEqual([]);
    expect(at("/")).toEqual([]);
  });
  test("brief: must be a non-empty string", () => {
    expect(sessionDefinitionProblems({ ...good(), brief: "" }, "def")).toEqual(['def.brief must be a non-empty string']);
    expect(sessionDefinitionProblems({ ...good(), brief: "   " }, "def")).toEqual(['def.brief must be a non-empty string']);
  });
  test("vendor: claude or codex only — not agy", () => {
    expect(SESSION_DEFINITION_VENDORS).toEqual(["claude", "codex"]);
    expect(sessionDefinitionProblems({ ...good(), vendor: "agy" }, "def")[0]).toContain("vendor must be one of claude, codex");
    expect(sessionDefinitionProblems({ ...good(), vendor: "gpt" }, "def")[0]).toContain("vendor must be one of");
  });
  test("tier: one of SESSION_TIERS", () => {
    for (const tier of SESSION_TIERS) expect(sessionDefinitionProblems({ ...good(), tier }, "def")).toEqual([]);
    expect(sessionDefinitionProblems({ ...good(), tier: "tier99" }, "def")[0]).toContain("tier must be one of");
  });
  // FACTORY-75: `tier` (deprecated) and `modelPower`+`effort` (the new
  // two-axis mechanism) are mutually exclusive ways to say the same thing.
  describe("modelPower/effort (FACTORY-75 two-axis mechanism) vs deprecated tier — mutual exclusivity", () => {
    const withoutTier = () => { const d: Record<string, unknown> = { ...good() }; delete d.tier; return d; };
    test("modelPower+effort alone (no tier) is valid", () => {
      expect(sessionDefinitionProblems({ ...withoutTier(), modelPower: 25, effort: 20 }, "def")).toEqual([]);
    });
    test("combining tier with modelPower/effort is rejected", () => {
      expect(sessionDefinitionProblems({ ...good(), modelPower: 25 }, "def")).toEqual(['def must not combine deprecated "tier" with "modelPower"/"effort" — use one or the other']);
      expect(sessionDefinitionProblems({ ...good(), effort: 20 }, "def")).toEqual(['def must not combine deprecated "tier" with "modelPower"/"effort" — use one or the other']);
      expect(sessionDefinitionProblems({ ...good(), modelPower: 25, effort: 20 }, "def")).toEqual(['def must not combine deprecated "tier" with "modelPower"/"effort" — use one or the other']);
    });
    test("neither tier nor modelPower/effort is rejected", () => {
      expect(sessionDefinitionProblems(withoutTier(), "def")).toEqual(['def must set either "tier" (deprecated) or both "modelPower" and "effort"']);
    });
    test("modelPower without effort (and vice versa) is rejected", () => {
      expect(sessionDefinitionProblems({ ...withoutTier(), modelPower: 25 }, "def")).toEqual(['def.effort is required when "tier" is absent']);
      expect(sessionDefinitionProblems({ ...withoutTier(), effort: 20 }, "def")).toEqual(['def.modelPower is required when "tier" is absent']);
    });
    test("modelPower/effort out of range or non-integer are rejected, collected alongside each other", () => {
      const problems = sessionDefinitionProblems({ ...withoutTier(), modelPower: 101, effort: -1 }, "def");
      expect(problems).toEqual(["def.modelPower must be between 0 and 100", "def.effort must be between 0 and 100"]);
      expect(sessionDefinitionProblems({ ...withoutTier(), modelPower: 25.5, effort: 20 }, "def")).toEqual(["def.modelPower must be an integer"]);
    });
    test("parseSessionDefinition stores modelPower/effort verbatim, tier absent", () => {
      const parsed = parseSessionDefinition({ ...withoutTier(), modelPower: 25, effort: 20 }, "def", HOME);
      expect(parsed.modelPower).toBe(25);
      expect(parsed.effort).toBe(20);
      expect(parsed.tier).toBeUndefined();
    });
    test("parseSessionDefinition stores tier verbatim, modelPower/effort absent (the deprecated path, unchanged)", () => {
      const parsed = parseSessionDefinition(good(), "def", HOME);
      expect(parsed.tier).toBe("tier1");
      expect(parsed.modelPower).toBeUndefined();
      expect(parsed.effort).toBeUndefined();
    });
  });
  test("permissionMode: one of SESSION_PERMISSION_MODES, including auto", () => {
    expect(SESSION_PERMISSION_MODES).toContain("auto");
    for (const permissionMode of SESSION_PERMISSION_MODES) expect(sessionDefinitionProblems({ ...good(), permissionMode }, "def")).toEqual([]);
    expect(sessionDefinitionProblems({ ...good(), permissionMode: "yolo" }, "def")[0]).toContain("permissionMode must be one of");
  });
  test("strictMcpConfig: optional boolean, absent means today's behaviour exactly", () => {
    expect(sessionDefinitionProblems(good(), "def")).toEqual([]);
    expect(sessionDefinitionProblems({ ...good(), strictMcpConfig: true }, "def")).toEqual([]);
    expect(sessionDefinitionProblems({ ...good(), strictMcpConfig: false }, "def")).toEqual([]);
    expect(sessionDefinitionProblems({ ...good(), strictMcpConfig: "true" }, "def")).toEqual(["def.strictMcpConfig must be a boolean"]);
    expect(parseSessionDefinition(good(), "def", HOME).strictMcpConfig).toBeUndefined();
    expect(parseSessionDefinition({ ...good(), strictMcpConfig: true }, "def", HOME).strictMcpConfig).toBe(true);
  });
  test("BUTCHR-453/BUTCHR-463: strictMcpConfig is rejected at manifest load for vendor codex — Codex has no equivalent concept", () => {
    expect(sessionDefinitionProblems({ ...good(), vendor: "codex", strictMcpConfig: true }, "def"))
      .toEqual(['def.strictMcpConfig is not supported for vendor "codex" — Codex has no strict-MCP-config concept; omit this field for a Codex definition']);
    // Even an explicit false is rejected — the field itself is unsupported for Codex, not just a truthy value.
    expect(sessionDefinitionProblems({ ...good(), vendor: "codex", strictMcpConfig: false }, "def")[0])
      .toContain('not supported for vendor "codex"');
    // Unlike permissionMode, which is silently stored-but-unforwarded for Codex (docs/managed-sessions.md), this is a hard rejection.
    expect(sessionDefinitionProblems({ ...good(), vendor: "codex" }, "def")).toEqual([]);
  });
  test("execution: reuses Rule's ExecutionMode enum verbatim, invalid value rejected", () => {
    for (const execution of ["swarm", "singleton", "persistent"]) expect(sessionDefinitionProblems({ ...good(), execution }, "def")).toEqual([]);
    expect(sessionDefinitionProblems({ ...good(), execution: "bogus" }, "def")[0]).toContain("execution must be one of");
  });
  test("account: reuses Rule's AccountPolicy enum verbatim, invalid value rejected", () => {
    for (const account of ["none", "temporary", "permanent"]) expect(sessionDefinitionProblems({ ...good(), account }, "def")).toEqual([]);
    expect(sessionDefinitionProblems({ ...good(), account: "bogus" }, "def")[0]).toContain("account must be one of");
  });
  test("role: reuses Rule's AgentRole enum verbatim (worker/sentinel), default worker, invalid value rejected", () => {
    for (const role of ["worker", "sentinel"]) expect(sessionDefinitionProblems({ ...good(), role }, "def")).toEqual([]);
    expect(sessionDefinitionProblems({ ...good(), role: "admin" }, "def")[0]).toContain("role must be one of worker, sentinel");
    expect(parseSessionDefinition(good(), "def", HOME).role).toBe("worker");
    expect(parseSessionDefinition({ ...good(), role: "sentinel" }, "def", HOME).role).toBe("sentinel");
  });
  test("frozen: boolean, defaults false — a frozen definition is still a VALID one (validity and frozen-ness are independent axes)", () => {
    expect(sessionDefinitionProblems({ ...good(), frozen: true }, "def")).toEqual([]);
    expect(sessionDefinitionProblems({ ...good(), frozen: "yes" }, "def")).toEqual(['def.frozen must be a boolean']);
    expect(parseSessionDefinition(good(), "def", HOME).frozen).toBe(false);
    expect(parseSessionDefinition({ ...good(), frozen: true }, "def", HOME).frozen).toBe(true);
  });
  test("mcpServers: reuses Rule's McpServerBinding/parseMcpServers verbatim (BUTCHR-408, ported from S4)", () => {
    const binding = { name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", channel: true };
    expect(sessionDefinitionProblems({ ...good(), mcpServers: [binding] }, "def")).toEqual([]);
    expect(sessionDefinitionProblems({ ...good(), mcpServers: [] }, "def")[0]).toContain("def.mcpServers must be a non-empty array");
    expect(sessionDefinitionProblems({ ...good(), mcpServers: [{ ...binding, name: "butchr" }] }, "def")[0]).toContain('reserved for butchr\'s own server');
    expect(sessionDefinitionProblems({ ...good(), mcpServers: [{ ...binding, url: "not a url" }] }, "def")[0]).toContain("must be an absolute http(s) URL");
    expect(sessionDefinitionProblems({ ...good(), mcpServers: [{ ...binding, channel: "yes" }] }, "def")[0]).toContain(".channel must be a boolean");
    expect(sessionDefinitionProblems({ ...good(), mcpServers: [binding, binding] }, "def")[0]).toContain('is a duplicate');
    const parsed = parseSessionDefinition({ ...good(), mcpServers: [binding] }, "def", HOME);
    expect(parsed.mcpServers).toEqual([binding]);
    expect(parseSessionDefinition(good(), "def", HOME).mcpServers).toBeUndefined();
  });
  test("mcpServers: headersEnvVar names the env var, never a literal header value — accepted, never resolved here", () => {
    const withEnvVar = { name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", headersEnvVar: "MUD_BRIDGE_HEADERS", channel: true };
    expect(sessionDefinitionProblems({ ...good(), mcpServers: [withEnvVar] }, "def")).toEqual([]);
    expect(parseSessionDefinition({ ...good(), mcpServers: [withEnvVar] }, "def", HOME).mcpServers).toEqual([withEnvVar]);
    expect(sessionDefinitionProblems({ ...good(), mcpServers: [{ ...withEnvVar, headersEnvVar: "lower-case" }] }, "def")[0]).toContain(".headersEnvVar must be an env var name");
  });

  // BUTCHR-412: accountHeader (the per-agent, non-secret literal extension) rides the same shared parseMcpServers this definition type already reuses verbatim.
  test("mcpServers: accountHeader is accepted, never resolved here", () => {
    const withAccountHeader = { name: "rocketr", type: "http" as const, url: "https://rocketr.internal/mcp", accountHeader: "x-rocketr-account", channel: true };
    expect(sessionDefinitionProblems({ ...good(), mcpServers: [withAccountHeader] }, "def")).toEqual([]);
    expect(parseSessionDefinition({ ...good(), mcpServers: [withAccountHeader] }, "def", HOME).mcpServers).toEqual([withAccountHeader]);
    expect(sessionDefinitionProblems({ ...good(), mcpServers: [{ ...withAccountHeader, accountHeader: "not a header" }] }, "def")[0]).toContain(".accountHeader must be a valid HTTP header name");
  });
  test("channels: not a real field — S4's shape folds the per-MCP notification flag into mcpServers[].channel, not a sibling field", () => {
    expect(sessionDefinitionProblems({ ...good(), channels: [] }, "def")).toEqual(['def has unknown field "channels"']);
  });
  test("freezeControllers/unfreezeControllers: array of non-empty file names, independent lists, .json-insensitive dedup", () => {
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: ["director-brooswit-mud"] }, "def")).toEqual([]);
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: [], unfreezeControllers: [] }, "def")).toEqual([]);
    expect(sessionDefinitionProblems(good(), "def")).toEqual([]);
    expect(parseSessionDefinition(good(), "def", HOME).freezeControllers).toBeUndefined();
    const parsed = parseSessionDefinition({ ...good(), freezeControllers: ["a"], unfreezeControllers: ["b", "c.json"] }, "def", HOME);
    expect(parsed.freezeControllers).toEqual(["a"]);
    expect(parsed.unfreezeControllers).toEqual(["b", "c.json"]);
  });
  test("freezeControllers: not an array is rejected", () => {
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: "a" }, "def")).toEqual(["def.freezeControllers must be an array of strings"]);
    expect(sessionDefinitionProblems({ ...good(), unfreezeControllers: { a: 1 } }, "def")).toEqual(["def.unfreezeControllers must be an array of strings"]);
  });
  test("freezeControllers: each entry must be a non-empty string", () => {
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: [""] }, "def")).toEqual(['def.freezeControllers[0] must be a non-empty string']);
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: ["   "] }, "def")).toEqual(['def.freezeControllers[0] must be a non-empty string']);
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: [7] }, "def")).toEqual(['def.freezeControllers[0] must be a non-empty string']);
  });
  test("freezeControllers: no path separators, no NUL, no bare . or ..", () => {
    for (const bad of ["a/b", "a\\b", "../x", "..", ".", "a\0b", "/etc/passwd"]) {
      const problems = sessionDefinitionProblems({ ...good(), freezeControllers: [bad] }, "def");
      expect(problems.length).toBe(1);
      expect(problems[0]).toMatch(/must not contain a path separator|is not a valid file name/);
    }
  });
  test("freezeControllers: length cap per entry", () => {
    const long = "a".repeat(201);
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: [long] }, "def")[0]).toContain("must be at most 200 characters");
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: ["a".repeat(200)] }, "def")).toEqual([]);
  });
  test("freezeControllers: no duplicates, compared after stripping a trailing .json", () => {
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: ["a", "a"] }, "def")[0]).toContain('duplicates an earlier entry');
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: ["a", "a.json"] }, "def")[0]).toContain('duplicates an earlier entry');
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: ["a.json", "a"] }, "def")[0]).toContain('duplicates an earlier entry');
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: ["a", "b"] }, "def")).toEqual([]);
  });
  test("freezeControllers: too many entries rejected", () => {
    const many = Array.from({ length: 101 }, (_, i) => `c${i}`);
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: many }, "def")[0]).toContain("must not list more than 100 controllers");
  });
  test("freezeControllers and unfreezeControllers are validated and stored independently — listing a name in one says nothing about the other", () => {
    const parsed = parseSessionDefinition({ ...good(), freezeControllers: ["a"] }, "def", HOME);
    expect(parsed.freezeControllers).toEqual(["a"]);
    expect(parsed.unfreezeControllers).toBeUndefined();
    // Duplicates are only checked WITHIN one field — "a" may appear in both lists (a controller can hold both grants independently).
    expect(sessionDefinitionProblems({ ...good(), freezeControllers: ["a"], unfreezeControllers: ["a"] }, "def")).toEqual([]);
  });

  test("linkedEventingProjects: absent means today's behaviour exactly", () => {
    expect(sessionDefinitionProblems(good(), "def")).toEqual([]);
    expect(parseSessionDefinition(good(), "def", HOME).linkedEventingProjects).toBeUndefined();
  });
  test("linkedEventingProjects: a definition WITH the field parses and exposes the named project(s), including multiple", () => {
    expect(sessionDefinitionProblems({ ...good(), linkedEventingProjects: ["jira-project:FACTORY"] }, "def")).toEqual([]);
    const parsed = parseSessionDefinition({ ...good(), linkedEventingProjects: ["jira-project:FACTORY", "jira-project:BUTCHR"] }, "def", HOME);
    expect(parsed.linkedEventingProjects).toEqual(["jira-project:FACTORY", "jira-project:BUTCHR"]);
  });
  test("linkedEventingProjects: not an array is rejected", () => {
    expect(sessionDefinitionProblems({ ...good(), linkedEventingProjects: "jira-project:FACTORY" }, "def"))
      .toEqual(["def.linkedEventingProjects must be an array of strings"]);
  });
  test("linkedEventingProjects: an empty array is rejected", () => {
    expect(sessionDefinitionProblems({ ...good(), linkedEventingProjects: [] }, "def"))
      .toEqual(["def.linkedEventingProjects must not be empty"]);
  });
  test("linkedEventingProjects: a non-string entry is rejected", () => {
    expect(sessionDefinitionProblems({ ...good(), linkedEventingProjects: [7] }, "def"))
      .toEqual(["def.linkedEventingProjects[0] must be a non-empty string"]);
    expect(sessionDefinitionProblems({ ...good(), linkedEventingProjects: [""] }, "def"))
      .toEqual(["def.linkedEventingProjects[0] must be a non-empty string"]);
  });
  test("linkedEventingProjects: a malformed jira-project key is rejected with a clear message", () => {
    expect(sessionDefinitionProblems({ ...good(), linkedEventingProjects: ["jira-project:not a key"] }, "def")[0])
      .toContain("invalid jira-project reference");
    expect(sessionDefinitionProblems({ ...good(), linkedEventingProjects: ["no-provider-prefix"] }, "def")[0])
      .toContain("invalid resource reference");
  });
  test("linkedEventingProjects: only the jira-project provider is accepted — any other provider is rejected", () => {
    expect(sessionDefinitionProblems({ ...good(), linkedEventingProjects: ["jira-work-item:FACTORY-1"] }, "def")[0])
      .toContain('must be a jira-project reference (got provider "jira-work-item")');
    expect(sessionDefinitionProblems({ ...good(), linkedEventingProjects: ["github-issue:brooswit-factory/butchr#42"] }, "def")[0])
      .toContain('must be a jira-project reference (got provider "github-issue")');
  });
  test("linkedEventingProjects: duplicate entries (by canonical form) are rejected, never silently deduped", () => {
    expect(sessionDefinitionProblems({ ...good(), linkedEventingProjects: ["jira-project:FACTORY", "jira-project:FACTORY"] }, "def")[0])
      .toContain("duplicates an earlier entry");
    expect(sessionDefinitionProblems({ ...good(), linkedEventingProjects: ["jira-project:FACTORY", "jira-project:factory"] }, "def")[0])
      .toContain("duplicates an earlier entry");
  });
  test("linkedEventingProjects: every problem is collected in one pass, alongside other field problems", () => {
    const problems = sessionDefinitionProblems({ ...good(), vendor: "bogus", linkedEventingProjects: ["bad", "jira-project:FACTORY", "jira-project:FACTORY"] }, "def");
    expect(problems.some((p) => p.includes("vendor must be one of"))).toBe(true);
    expect(problems.some((p) => p.includes("linkedEventingProjects[0]"))).toBe(true);
    expect(problems.some((p) => p.includes("linkedEventingProjects[2]") && p.includes("duplicates"))).toBe(true);
  });

  test("every problem is collected in one pass", () => {
    const problems = sessionDefinitionProblems({ workingDirectory: "", brief: "", vendor: "bogus", tier: "bogus", permissionMode: "bogus" }, "def");
    expect(problems.length).toBeGreaterThanOrEqual(5);
  });
});

describe("parseSessionDefinition", () => {
  test("throws with every collected problem, joined, when invalid", () => {
    expect(() => parseSessionDefinition({}, "def", HOME)).toThrow(/workingDirectory must be a non-empty string/);
  });
  test("expands ~ in workingDirectory against the given home", () => {
    const parsed = parseSessionDefinition({ ...good(), workingDirectory: "~/project" }, "def", HOME);
    expect(parsed.workingDirectory).toBe(`${HOME}/project`);
  });
  test("trims brief and workingDirectory", () => {
    const parsed = parseSessionDefinition({ ...good(), brief: "  Tend this repo.  " }, "def", HOME);
    expect(parsed.brief).toBe("Tend this repo.");
  });
});

describe("parseSessionDefinitionFile", () => {
  test("invalid JSON is reported plainly, same style as loadRules", () => {
    expect(() => parseSessionDefinitionFile("not json", "/x/a.json")).toThrow(/invalid JSON/);
  });
  test("valid JSON text parses through to the same result as parseSessionDefinition", () => {
    const parsed = parseSessionDefinitionFile(JSON.stringify(good()), "/x/a.json", HOME);
    expect(parsed.vendor).toBe("claude");
    expect(parsed.tier).toBe("tier1");
  });
});

describe("tierToModel", () => {
  test("claude: tiers 1-3 -> sonnet, 4-5 -> opus (Candlestix model-tiers.json, ported per CNDLX-45 comment 23525)", () => {
    expect(tierToModel("claude", "tier1")).toBe("sonnet");
    expect(tierToModel("claude", "tier2")).toBe("sonnet");
    expect(tierToModel("claude", "tier3")).toBe("sonnet");
    expect(tierToModel("claude", "tier4")).toBe("opus");
    expect(tierToModel("claude", "tier5")).toBe("opus");
  });
  test("codex: tier 1 = gpt-5.6-luna, 2 = gpt-5.6-terra, 3 = gpt-5.6-sol, 4-5 = gpt-6-astra", () => {
    expect(tierToModel("codex", "tier1")).toBe("gpt-5.6-luna");
    expect(tierToModel("codex", "tier2")).toBe("gpt-5.6-terra");
    expect(tierToModel("codex", "tier3")).toBe("gpt-5.6-sol");
    expect(tierToModel("codex", "tier4")).toBe("gpt-6-astra");
    expect(tierToModel("codex", "tier5")).toBe("gpt-6-astra");
  });
  test("every declared tier maps to a non-empty model string for both vendors", () => {
    for (const tier of SESSION_TIERS) {
      expect(tierToModel("claude", tier).length).toBeGreaterThan(0);
      expect(tierToModel("codex", tier).length).toBeGreaterThan(0);
    }
  });
});

// FACTORY-75 — the ONE resolver specForSessionDefinition/staleIssues'
// resolvedAgentOf both read; see its own doc comment for why the tier path
// deliberately bypasses the modelPower/effort tables entirely.
describe("effectiveAgent", () => {
  test("tier path (deprecated): resolves via tierToModel verbatim, NO effort at all — reproduces today's launch exactly", () => {
    expect(effectiveAgent({ vendor: "claude", tier: "tier1" })).toEqual({ model: "sonnet" });
    expect(effectiveAgent({ vendor: "claude", tier: "tier4" })).toEqual({ model: "opus" });
    expect(effectiveAgent({ vendor: "codex", tier: "tier2" })).toEqual({ model: "gpt-5.6-terra" });
  });
  test("tier path never returns an `effort` key — not even undefined-but-present", () => {
    const result = effectiveAgent({ vendor: "codex", tier: "tier1" });
    expect("effort" in result).toBe(false);
  });
  test("modelPower/effort path: resolves both axes through power-scale.ts", () => {
    expect(effectiveAgent({ vendor: "claude", modelPower: 100, effort: 70 })).toEqual({ model: "fable", effort: "xhigh" });
    expect(effectiveAgent({ vendor: "claude", modelPower: 0, effort: 0 })).toEqual({ model: "haiku", effort: "low" });
    expect(effectiveAgent({ vendor: "codex", modelPower: 0, effort: 20 })).toEqual({ model: "gpt-5.6-luna", effort: "medium" });
  });
  test("back-compat: every tier resolves to the SAME model tierToModel names — a table/logic change here can never silently move a live tier-based definition's model", () => {
    for (const tier of SESSION_TIERS) {
      for (const vendor of ["claude", "codex"] as const) {
        expect(effectiveAgent({ vendor, tier }).model).toBe(tierToModel(vendor, tier));
      }
    }
  });
});

describe("sessionDefinitionsPath", () => {
  test("BUTCHR_SESSION_DEFINITIONS_DIR wins outright", () => {
    expect(sessionDefinitionsPath({ BUTCHR_SESSION_DEFINITIONS_DIR: "/custom/defs", XDG_CONFIG_HOME: "/xdg", HOME: "/home/x" })).toBe("/custom/defs");
  });
  test("falls back to $XDG_CONFIG_HOME/butchr/session-definitions", () => {
    expect(sessionDefinitionsPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/x" })).toBe("/xdg/butchr/session-definitions");
  });
  test("falls back to $HOME/.config/butchr/session-definitions with no XDG_CONFIG_HOME — same shape as rulesPath", () => {
    expect(sessionDefinitionsPath({ HOME: "/home/x" })).toBe("/home/x/.config/butchr/session-definitions");
  });
  test("empty-string overrides count as unset", () => {
    expect(sessionDefinitionsPath({ BUTCHR_SESSION_DEFINITIONS_DIR: "  ", XDG_CONFIG_HOME: "", HOME: "/home/x" })).toBe("/home/x/.config/butchr/session-definitions");
  });
});
