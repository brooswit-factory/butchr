import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiraEnv, runRulesCli, type RulesCliIo } from "../../src/cli/rules-cli.js";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { RulesCheckJiraEnv } from "../../src/cli/rules-cli.js";

let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-rules-cli-"));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const issue = (key: string, status: string, summary: string, extra: Partial<JiraIssue> = {}): JiraIssue => ({
  key, summary, status, issuetype: "Task", assignee: null, parent: null, updated: "2026-01-01", labels: [], ...extra,
});

function io(overrides: Partial<RulesCliIo> = {}): RulesCliIo {
  return {
    env: {},
    loadJiraEnv: () => { throw new Error("loadJiraEnv should not be called in this test"); },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...overrides,
  };
}

function writeRules(json: unknown): string {
  const file = join(dir, "rules.json");
  writeFileSync(file, JSON.stringify(json));
  return file;
}

describe("usage / dispatch", () => {
  test("no subcommand: usage to stderr, exit 1", async () => {
    expect(await runRulesCli([], io())).toBe(1);
    expect(err.join("\n")).toMatch(/usage: butchr rules/);
  });

  test("--help: usage to stdout, exit 0", async () => {
    expect(await runRulesCli(["--help"], io())).toBe(0);
    expect(out.join("\n")).toMatch(/usage: butchr rules/);
  });

  test("unknown subcommand: error + usage to stderr, exit 1", async () => {
    expect(await runRulesCli(["bogus"], io())).toBe(1);
    expect(err.join("\n")).toMatch(/unknown subcommand/);
  });

  test("too many arguments to check: error, exit 1", async () => {
    expect(await runRulesCli(["check", "a", "b"], io())).toBe(1);
    expect(err.join("\n")).toMatch(/expected at most one argument/);
  });
});

describe("validation", () => {
  test("missing default file: friendly message, no error, exit 0, points at the README", async () => {
    // no BUTCHR_RULES_FILE set: the DEFAULT path under this empty XDG dir is absent,
    // which is zero rules, not an error (only an explicit BUTCHR_RULES_FILE throws).
    expect(await runRulesCli(["check"], io({ env: { XDG_CONFIG_HOME: dir } }))).toBe(0);
    expect(out.join("\n")).toMatch(/0 rules/);
    expect(out.join("\n")).toMatch(/README/);
  });

  test("invalid JSON: reported clearly, exit 1, no dry run attempted", async () => {
    const file = join(dir, "rules.json");
    writeFileSync(file, "{not json");
    expect(await runRulesCli(["check", file], io())).toBe(1);
    expect(err.join("\n")).toMatch(/invalid JSON/);
  });

  test("a validation problem names the rule and field, exit 1", async () => {
    const file = writeRules({ rules: [{ id: "bad id", resourceProvider: "jira-work", query: "x", brief: "b" }] });
    expect(await runRulesCli(["check", file], io())).toBe(1);
    expect(err.join("\n")).toMatch(/rules\[0\]\.id/);
  });

  test("an explicit missing BUTCHR_RULES_FILE equivalent (explicit path argument) is an error, not silently zero rules", async () => {
    const missing = join(dir, "nope.json");
    // passing a file path explicitly makes a missing file a real error (BUTCHR_RULES_FILE semantics)
    expect(await runRulesCli(["check", missing], io())).toBe(1);
    expect(err.join("\n")).toMatch(/does not exist/);
  });
});

describe("dry run dispatch by provider", () => {
  test("a non-Jira-backed rule is named as not dry-run, not silently skipped", async () => {
    const file = writeRules({ rules: [{ id: "gh", resourceProvider: "github-issue", query: "is:issue is:open", brief: "b", enabled: true }] });
    expect(await runRulesCli(["check", file], io())).toBe(0);
    expect(out.join("\n")).toMatch(/\[gh\] github-issue: not dry-run/);
  });

  test("a disabled rule is validated but never dry-run", async () => {
    const file = writeRules({ rules: [{ id: "r1", resourceProvider: "jira-work", query: "key = X-1", brief: "b", enabled: false }] });
    expect(await runRulesCli(["check", file], io())).toBe(0);
    expect(out.join("\n")).not.toMatch(/would staff/);
    expect(out.join("\n")).toMatch(/no enabled jira-work\/jira-idea rules/);
  });
});

describe("Jira dry run", () => {
  test("cannot reach Jira (e.g. missing credentials): clear message, exit 1, never a crash", async () => {
    const file = writeRules({ rules: [{ id: "r1", resourceProvider: "jira-work", query: "key = X-1", brief: "b" }] });
    const loadJiraEnv = (): RulesCheckJiraEnv => { throw new Error("ATLASSIAN_SITE is required"); };
    expect(await runRulesCli(["check", file], io({ loadJiraEnv }))).toBe(1);
    expect(err.join("\n")).toMatch(/cannot reach Jira/);
    expect(err.join("\n")).toMatch(/ATLASSIAN_SITE/);
  });

  test("a failed search (Jira unreachable) is a clear message, exit 1, never a crash", async () => {
    const file = writeRules({ rules: [{ id: "r1", resourceProvider: "jira-work", query: "key = X-1", brief: "b" }] });
    const loadJiraEnv = (): RulesCheckJiraEnv => ({ maxAgents: 8, search: async () => { throw new Error("ECONNREFUSED"); } });
    expect(await runRulesCli(["check", file], io({ loadJiraEnv }))).toBe(1);
    expect(err.join("\n")).toMatch(/dry-run query failed/);
    expect(err.join("\n")).toMatch(/ECONNREFUSED/);
  });

  test("zero matches: printed plainly, exit 0", async () => {
    const file = writeRules({ rules: [{ id: "r1", resourceProvider: "jira-work", query: "key = X-1", brief: "b" }] });
    const loadJiraEnv = (): RulesCheckJiraEnv => ({ maxAgents: 8, search: async () => [] });
    expect(await runRulesCli(["check", file], io({ loadJiraEnv }))).toBe(0);
    expect(out.join("\n")).toMatch(/would staff 0 ticket\(s\)/);
    expect(out.join("\n")).toMatch(/0 tickets matched/);
  });

  test("matches: key/status/summary printed, impossible-to-miss total, exit 0", async () => {
    const file = writeRules({ rules: [{ id: "r1", resourceProvider: "jira-work", query: "assignee = currentUser()", brief: "b" }] });
    const loadJiraEnv = (): RulesCheckJiraEnv => ({
      maxAgents: 8,
      search: async () => [issue("FACTORY-1", "In Progress", "Fix the thing")],
    });
    expect(await runRulesCli(["check", file], io({ loadJiraEnv }))).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/FACTORY-1/);
    expect(text).toMatch(/In Progress/);
    expect(text).toMatch(/Fix the thing/);
    expect(text).toMatch(/WOULD STAFF 1 REAL TICKET/);
  });

  test("matches over maxAgents: a plain warning naming the cap", async () => {
    const file = writeRules({ rules: [{ id: "r1", resourceProvider: "jira-work", query: "assignee = currentUser()", brief: "b" }] });
    const loadJiraEnv = (): RulesCheckJiraEnv => ({
      maxAgents: 2,
      search: async () => [issue("A-1", "In Progress", "one"), issue("A-2", "In Progress", "two"), issue("A-3", "In Progress", "three")],
    });
    expect(await runRulesCli(["check", file], io({ loadJiraEnv }))).toBe(0);
    expect(out.join("\n")).toMatch(/WARNING: 3 match\(es\) exceed maxAgents=2/);
  });

  test("jira-work and jira-idea rules are both dry-run, each against its own query", async () => {
    const file = writeRules({
      rules: [
        { id: "work-rule", resourceProvider: "jira-work", query: "project = X", brief: "b" },
        { id: "idea-rule", resourceProvider: "jira-idea", query: "project = Y", brief: "b" },
      ],
    });
    const calls: string[] = [];
    const loadJiraEnv = (): RulesCheckJiraEnv => ({
      maxAgents: 8,
      search: async (jql) => {
        calls.push(jql);
        if (jql === "project = X") return [issue("X-1", "In Progress", "work item", { issuetype: "Task" })];
        if (jql === "project = Y") return [issue("Y-1", "In Progress", "an idea", { issuetype: "Idea", projectType: "product_discovery" })];
        return [];
      },
    });
    expect(await runRulesCli(["check", file], io({ loadJiraEnv }))).toBe(0);
    expect(calls.sort()).toEqual(["project = X", "project = Y"]);
    const text = out.join("\n");
    expect(text).toMatch(/\[work-rule\] jira-work/);
    expect(text).toMatch(/\[idea-rule\] jira-idea/);
    expect(text).toMatch(/X-1/);
    expect(text).toMatch(/Y-1/);
    expect(text).toMatch(/WOULD STAFF 2 REAL TICKET/);
  });

  test("a jira-work rule's query never staffs an unproven idea, and vice versa (same exclusion the daemon itself applies)", async () => {
    const file = writeRules({ rules: [{ id: "broad", resourceProvider: "jira-work", query: "project = X", brief: "b" }] });
    const loadJiraEnv = (): RulesCheckJiraEnv => ({
      maxAgents: 8,
      search: async () => [issue("X-1", "In Progress", "an idea", { issuetype: "Idea", projectType: "product_discovery" })],
    });
    expect(await runRulesCli(["check", file], io({ loadJiraEnv }))).toBe(0);
    expect(out.join("\n")).toMatch(/would staff 0 ticket\(s\)/);
  });
});

describe("no-write guarantee (mutation check)", () => {
  /**
   * The ONLY Jira capability `createJiraEnv` ever hands back is `search`
   * (`AtlassianClient.searchAll`, a GET). This proves it against a REAL
   * `AtlassianClient` with a recording `fetchImpl`: every request this
   * command's full dry-run path makes is a GET to the search endpoint —
   * never a PUT/POST, which is what a write (a label update, a comment)
   * would be. A mutation that added any write/spawn call anywhere in this
   * path would have to go through a REAL Jira call to have any effect, and
   * this test would catch it mid-flight: either a new recorded request with
   * a non-GET method, or a request to a non-search path.
   */
  test("the full check run against a real AtlassianClient makes only GET /search/jql requests", async () => {
    const file = writeRules({
      rules: [
        { id: "work-rule", resourceProvider: "jira-work", query: "project = X", brief: "b" },
        { id: "idea-rule", resourceProvider: "jira-idea", query: "project = Y", brief: "b" },
      ],
    });
    const requests: { method: string; path: string }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      requests.push({ method: init?.method ?? "GET", path: new URL(url).pathname });
      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    };
    const env = { ATLASSIAN_SITE: "https://x.atlassian.net", ATLASSIAN_EMAIL: "a@b.c", ATLASSIAN_TOKEN: "tok" };
    const result = await runRulesCli(["check", file], io({ loadJiraEnv: () => createJiraEnv(env, fetchImpl) }));
    expect(result).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.method).toBe("GET");
      expect(r.path).toBe("/rest/api/3/search/jql");
    }
  });
});

describe("createJiraEnv", () => {
  test("wires maxAgents and search from the real config/client", async () => {
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({ issues: [{ key: "K-1", fields: {} }] }), { status: 200 });
    const jira = createJiraEnv({ ATLASSIAN_SITE: "https://x", ATLASSIAN_EMAIL: "a", ATLASSIAN_TOKEN: "t", BUTCHR_MAX_AGENTS: "3" }, fetchImpl);
    expect(jira.maxAgents).toBe(3);
    expect((await jira.search("x")).map((i) => i.key)).toEqual(["K-1"]);
  });

  test("throws a clear error when credentials are missing", () => {
    expect(() => createJiraEnv({})).toThrow(/ATLASSIAN_SITE/);
  });
});

/** Seeds the DEFAULT rules path (`XDG_CONFIG_HOME/butchr/rules.json`) `enable`/`disable`/`add` operate against — unlike `writeRules` above, which writes an arbitrary path for `check`'s own optional file argument. */
function seedDefaultRulesFile(json: unknown): { env: Partial<RulesCliIo["env"]>; path: string } {
  const rulesDir = join(dir, "butchr");
  const path = join(rulesDir, "rules.json");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  return { env: { XDG_CONFIG_HOME: dir }, path };
}

describe("rules enable / disable", () => {
  test("--help: usage to stdout, exit 0", async () => {
    expect(await runRulesCli(["enable", "--help"], io())).toBe(0);
    expect(out.join("\n")).toMatch(/usage: butchr rules enable/);
  });

  test("wrong argument count: usage to stderr, exit 1", async () => {
    expect(await runRulesCli(["enable"], io())).toBe(1);
    expect(err.join("\n")).toMatch(/expected exactly one argument/);
  });

  test("default rules file absent: clear error, exit 1", async () => {
    expect(await runRulesCli(["disable", "triage"], io({ env: { XDG_CONFIG_HOME: dir } }))).toBe(1);
    expect(err.join("\n")).toMatch(/does not exist/);
  });

  test("unknown id: clear error, exit 1, file untouched", async () => {
    const { env, path } = seedDefaultRulesFile({ rules: [{ id: "triage", resourceProvider: "jira-work", query: "project = X", brief: "b" }] });
    const before = readFileSync(path, "utf8");
    expect(await runRulesCli(["disable", "nope"], io({ env }))).toBe(1);
    expect(err.join("\n")).toMatch(/no rule with id "nope"/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("disable flips enabled to false, backs up, reports the diff, exit 0", async () => {
    const { env, path } = seedDefaultRulesFile({ rules: [{ id: "triage", resourceProvider: "jira-work", query: "project = X", brief: "b" }] });
    expect(await runRulesCli(["disable", "triage"], io({ env }))).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/triage.*disabled/);
    expect(text).toMatch(/backup:/);
    expect(text).toMatch(/changed rule\(s\): triage/);
    expect(text).toMatch(/Restart the daemon/);
    expect(JSON.parse(readFileSync(path, "utf8")).rules[0].enabled).toBe(false);
  });

  test("enable flips enabled back to true", async () => {
    const { env, path } = seedDefaultRulesFile({ rules: [{ id: "triage", resourceProvider: "jira-work", query: "project = X", brief: "b", enabled: false }] });
    expect(await runRulesCli(["enable", "triage"], io({ env }))).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).rules[0].enabled).toBe(true);
  });

  test("resulting file failing validation (e.g. a corrupted source file): clear error, exit 1", async () => {
    const rulesDir = join(dir, "butchr");
    mkdirSync(rulesDir, { recursive: true });
    const path = join(rulesDir, "rules.json");
    writeFileSync(path, "{not json");
    expect(await runRulesCli(["disable", "triage"], io({ env: { XDG_CONFIG_HOME: dir } }))).toBe(1);
    expect(err.join("\n")).toMatch(/invalid JSON/);
  });
});

describe("rules add", () => {
  test("--help: usage to stdout, exit 0", async () => {
    expect(await runRulesCli(["add", "--help"], io())).toBe(0);
    expect(out.join("\n")).toMatch(/usage: butchr rules add/);
  });

  test("missing --from: usage to stderr, exit 1", async () => {
    expect(await runRulesCli(["add"], io())).toBe(1);
    expect(err.join("\n")).toMatch(/expected "--from/);
  });

  test("adds a new rule to a freshly-created file when none exists yet", async () => {
    const fromFile = join(dir, "new-rule.json");
    writeFileSync(fromFile, JSON.stringify({ id: "triage", resourceProvider: "jira-work", query: "project = X", brief: "b" }));
    const env = { XDG_CONFIG_HOME: dir };
    expect(await runRulesCli(["add", "--from", fromFile], io({ env }))).toBe(0);
    const path = join(dir, "butchr", "rules.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.rules).toHaveLength(1);
    expect(doc.rules[0].id).toBe("triage");
    expect(out.join("\n")).toMatch(/backup: \(none/);
  });

  test("adds a new rule alongside existing ones, backs up the previous file", async () => {
    const { env, path } = seedDefaultRulesFile({ rules: [{ id: "triage", resourceProvider: "jira-work", query: "project = X", brief: "b" }] });
    const fromFile = join(dir, "new-rule.json");
    writeFileSync(fromFile, JSON.stringify({ id: "stories", resourceProvider: "jira-work", query: "project = X AND issuetype = Story", brief: "b2" }));
    expect(await runRulesCli(["add", "--from", fromFile], io({ env }))).toBe(0);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.rules.map((r: { id: string }) => r.id).sort()).toEqual(["stories", "triage"]);
    expect(out.join("\n")).toMatch(/backup: .*rules\.json\.bak-/);
  });

  test("duplicate id: clear error, exit 1, file untouched", async () => {
    const { env, path } = seedDefaultRulesFile({ rules: [{ id: "triage", resourceProvider: "jira-work", query: "project = X", brief: "b" }] });
    const before = readFileSync(path, "utf8");
    const fromFile = join(dir, "dup.json");
    writeFileSync(fromFile, JSON.stringify({ id: "triage", resourceProvider: "jira-work", query: "project = Y", brief: "b2" }));
    expect(await runRulesCli(["add", "--from", fromFile], io({ env }))).toBe(1);
    expect(err.join("\n")).toMatch(/duplicate/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("--from file missing: clear error, exit 1", async () => {
    const env = { XDG_CONFIG_HOME: dir };
    expect(await runRulesCli(["add", "--from", join(dir, "nope.json")], io({ env }))).toBe(1);
    expect(err.join("\n")).toMatch(/could not read/);
  });

  test("--from file is not valid JSON: clear error, exit 1", async () => {
    const env = { XDG_CONFIG_HOME: dir };
    const fromFile = join(dir, "bad.json");
    writeFileSync(fromFile, "{not json");
    expect(await runRulesCli(["add", "--from", fromFile], io({ env }))).toBe(1);
    expect(err.join("\n")).toMatch(/not valid JSON/);
  });

  test("--from file is not a single object (e.g. an array): clear error, exit 1", async () => {
    const env = { XDG_CONFIG_HOME: dir };
    const fromFile = join(dir, "array.json");
    writeFileSync(fromFile, "[1, 2]");
    expect(await runRulesCli(["add", "--from", fromFile], io({ env }))).toBe(1);
    expect(err.join("\n")).toMatch(/must contain a single JSON object/);
  });

  test("the existing rules file is invalid JSON: clear error, exit 1", async () => {
    const rulesDir = join(dir, "butchr");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "rules.json"), "{not json");
    const fromFile = join(dir, "new-rule.json");
    writeFileSync(fromFile, JSON.stringify({ id: "triage", resourceProvider: "jira-work", query: "project = X", brief: "b" }));
    expect(await runRulesCli(["add", "--from", fromFile], io({ env: { XDG_CONFIG_HOME: dir } }))).toBe(1);
    expect(err.join("\n")).toMatch(/is not valid JSON/);
  });

  test("the existing rules file is not a rules document (e.g. a JSON array): clear error, exit 1", async () => {
    const rulesDir = join(dir, "butchr");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "rules.json"), "[]");
    const fromFile = join(dir, "new-rule.json");
    writeFileSync(fromFile, JSON.stringify({ id: "triage", resourceProvider: "jira-work", query: "project = X", brief: "b" }));
    expect(await runRulesCli(["add", "--from", fromFile], io({ env: { XDG_CONFIG_HOME: dir } }))).toBe(1);
    expect(err.join("\n")).toMatch(/must be an object with a "rules" array/);
  });
});
