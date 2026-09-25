import { describe, expect, test } from "bun:test";
import {
  parseSessionDefinition, parseSessionDefinitionFile, sessionDefinitionProblems, sessionDefinitionsPath,
  tierToModel, SESSION_DEFINITION_VENDORS, SESSION_PERMISSION_MODES, SESSION_TIERS,
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
  test("permissionMode: one of SESSION_PERMISSION_MODES, including auto", () => {
    expect(SESSION_PERMISSION_MODES).toContain("auto");
    for (const permissionMode of SESSION_PERMISSION_MODES) expect(sessionDefinitionProblems({ ...good(), permissionMode }, "def")).toEqual([]);
    expect(sessionDefinitionProblems({ ...good(), permissionMode: "yolo" }, "def")[0]).toContain("permissionMode must be one of");
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
  test("channels: not a real field — S4's shape folds the per-MCP notification flag into mcpServers[].channel, not a sibling field", () => {
    expect(sessionDefinitionProblems({ ...good(), channels: [] }, "def")).toEqual(['def has unknown field "channels"']);
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
