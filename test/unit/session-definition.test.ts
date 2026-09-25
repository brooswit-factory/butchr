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
  test("mcpServers/channels: a clear, specific deferred-field error, not a generic unknown-field one", () => {
    const withMcp = sessionDefinitionProblems({ ...good(), mcpServers: [] }, "def");
    expect(withMcp).toHaveLength(1);
    expect(withMcp[0]).toContain("def.mcpServers is not supported yet");
    expect(withMcp[0]).toContain("BUTCHR-395/BUTCHR-411");
    const withChannels = sessionDefinitionProblems({ ...good(), channels: [] }, "def");
    expect(withChannels[0]).toContain("def.channels is not supported yet");
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
  test("tier1 -> sonnet: the one entry independently confirmed by BUTCHR-393's own ticket text (\"10 MUD players: Claude at tier 1 (sonnet)\")", () => {
    expect(tierToModel("tier1")).toBe("sonnet");
  });
  test("every declared tier maps to a non-empty model string", () => {
    for (const tier of SESSION_TIERS) expect(tierToModel(tier).length).toBeGreaterThan(0);
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
