import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAgentKey, encodeAgentKey, loadRules, parseRules, RULE_ID_MAX, rulesPath } from "../../src/rules/rules.js";

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
      expect(loadRules({ XDG_CONFIG_HOME: dir })).toEqual({ path: join(dir, "butchr", "rules.json"), origin: "file", rules: [parsedMinimal as never] });
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
      { ...full, query: "status = Open", agentPreferences: [{ harness: "codex", model: "gpt-5", effort: "xhigh" }, { harness: "claude" }, { harness: "claude", model: "haiku" }] },
      { ...other, enabled: true },
    ] as never);
  });
  test("omitted optionals stay absent; enabled defaults to true", () => {
    const [r] = parseRules({ rules: [minimal] });
    expect(Object.keys(r!).sort()).toEqual(["brief", "enabled", "id", "query", "resourceProvider"]);
    expect(r!.enabled).toBe(true);
  });
  test("rejects a non-document", () => {
    for (const doc of [null, [], {}, { rules: {} }]) expect(() => parseRules(doc)).toThrow('"rules" array');
  });
  test("reports every problem at once", () => {
    let msg = "";
    try {
      parseRules({ rules: [
        "nope",
        { ...minimal, id: "Bad.Id", enabled: "yes", resourceProvider: "jira", query: " ", brief: 3, role: "task", extra: 1 },
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
      'rules[1] has unknown field "role"', 'rules[1] has unknown field "extra"',
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
