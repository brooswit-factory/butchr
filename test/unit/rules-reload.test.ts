import { describe, expect, test } from "bun:test";
import { createRulesHolder, parseRules, type Rule } from "../../src/rules/rules.js";
import { reloadRules } from "../../src/rules/reload.js";
import { createFilesystemResourceType } from "../../src/rules/filesystem-type.js";
import { createRuleResourceType } from "../../src/rules/resource-type.js";
import { unitAgentKey } from "../../src/rules/execution.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

// Built through `parseRules` itself, never by hand — a hand-built `Rule`
// literal omits the defaults `parseRules` fills in (`account: "none"`,
// `role: "worker"`, `execution: "swarm"`), which would make every
// "unchanged" comparison in this file a false "changed".
const [ruleA, ruleB]: Rule[] = parseRules({
  rules: [
    { id: "a", resourceProvider: "filesystem", query: JSON.stringify({ root: "/tmp/a", kind: "file" }), brief: "a" },
    { id: "b", resourceProvider: "filesystem", query: JSON.stringify({ root: "/tmp/b", kind: "file" }), brief: "b" },
  ],
}) as [Rule, Rule];

const [jiraWorkRule]: Rule[] = parseRules({
  rules: [{ id: "w", resourceProvider: "jira-work", query: "key = X-1", brief: "w" }],
}) as [Rule];

describe("reloadRules", () => {
  test("a valid file swaps the holder's rules and reports added/removed/changed", () => {
    const holder = createRulesHolder([ruleA]);
    const next = JSON.stringify({ rules: [{ ...ruleA, enabled: true }, { ...ruleB, enabled: true }] });
    const result = reloadRules(holder, { BUTCHR_RULES_FILE: "/rules.json" }, (p) => (p === "/rules.json" ? next : undefined));
    expect(result.ok).toBe(true);
    expect(result.added).toEqual(["b"]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(holder.getRules().map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("a rule present before and after, with a different query, is reported changed — never silently missed", () => {
    const holder = createRulesHolder([ruleA]);
    const editedA = { ...ruleA, query: JSON.stringify({ root: "/tmp/a2", kind: "file" }) };
    const next = JSON.stringify({ rules: [editedA] });
    const result = reloadRules(holder, { BUTCHR_RULES_FILE: "/rules.json" }, () => next);
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual(["a"]);
    expect(holder.getRules()[0]!.query).toBe(editedA.query);
  });

  test("disabling a previously-enabled rule reports it removed from the enabled set, even though the id is still present in the file", () => {
    const holder = createRulesHolder([ruleA]);
    const next = JSON.stringify({ rules: [{ ...ruleA, enabled: false }] });
    const result = reloadRules(holder, { BUTCHR_RULES_FILE: "/rules.json" }, () => next);
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual(["a"]);
    expect(result.added).toEqual([]);
  });

  test("invalid JSON keeps the running rules untouched and reports the parse problem", () => {
    const holder = createRulesHolder([ruleA]);
    const result = reloadRules(holder, { BUTCHR_RULES_FILE: "/rules.json" }, () => "{not json");
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("invalid JSON");
    expect(holder.getRules()).toEqual([ruleA]);
  });

  test("a schema validation failure keeps the running rules untouched and reports the problem", () => {
    const holder = createRulesHolder([ruleA]);
    const badDoc = JSON.stringify({ rules: [{ id: "x", resourceProvider: "not-a-real-provider", query: "q", brief: "b" }] });
    const result = reloadRules(holder, { BUTCHR_RULES_FILE: "/rules.json" }, () => badDoc);
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(holder.getRules()).toEqual([ruleA]);
  });

  test("a missing default file is a VALID reload to zero rules when the holder is ALREADY empty — nothing to wipe", () => {
    const holder = createRulesHolder([]);
    const result = reloadRules(holder, { XDG_CONFIG_HOME: "/x" }, () => undefined);
    expect(result.ok).toBe(true);
    expect(holder.getRules()).toEqual([]);
  });

  test("review round 1, BLOCKING finding 1: a missing file over a NON-EMPTY holder is REFUSED, never swapped in — a vanished/moved/bad-mount rules file must not wipe every running rule", () => {
    const holder = createRulesHolder([ruleA]);
    const result = reloadRules(holder, { XDG_CONFIG_HOME: "/x" }, () => undefined);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("missing");
    expect(result.problems.join("\n")).toContain("keeping the running");
    expect(holder.getRules()).toEqual([ruleA]); // untouched
  });

  test("an explicit BUTCHR_RULES_FILE that does not exist is reported as a failed reload, keeping the running rules — same refusal, an explicit path", () => {
    const holder = createRulesHolder([ruleA]);
    const result = reloadRules(holder, { BUTCHR_RULES_FILE: "/nope.json" }, () => undefined);
    expect(result.ok).toBe(false);
    expect(holder.getRules()).toEqual([ruleA]);
  });

  test("a PRESENT file that parses to zero rules IS accepted over a non-empty holder — an operator's deliberate 'disable everything' is distinguishable from a vanished file", () => {
    const holder = createRulesHolder([ruleA]);
    const result = reloadRules(holder, { BUTCHR_RULES_FILE: "/rules.json" }, () => JSON.stringify({ rules: [] }));
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual(["a"]);
    expect(holder.getRules()).toEqual([]);
  });
});

describe("review round 1, finding 3: jira-work after a reload from an empty-but-present file", () => {
  test("rules: [] reloading to one enabled jira-work rule is polled on the loop's very next search — no restart needed", async () => {
    const holder = createRulesHolder([]);
    const issue: JiraIssue = { key: "X-1", summary: "s", status: "To Do", issuetype: "Task", assignee: null, parent: null, updated: "", labels: [] };
    const type = createRuleResourceType({ rules: holder.getRules(), search: async () => [issue] });
    expect(await type.discovery.search()).toEqual([]);

    const added = JSON.stringify({ rules: [{ ...jiraWorkRule, enabled: true }] });
    const result = reloadRules(holder, { BUTCHR_RULES_FILE: "/rules.json" }, () => added);
    expect(result.ok).toBe(true);
    expect(result.added).toEqual(["w"]);

    const after = await type.discovery.search();
    expect(after.map((u) => unitAgentKey(u))).toEqual(["jira-work:w:X-1"]);
  });
});

describe("a reload's effect on an already-running resource type", () => {
  const listFor = (root: string): FilesystemResource[] =>
    root === "/tmp/a" ? [{ path: "/tmp/a/f", kind: "file", name: "f", size: 1, mtimeMs: 0 }] : [];

  test("a rule removed by reload stops being polled on the loop's very next search — no restart", async () => {
    const holder = createRulesHolder([ruleA]);
    const type = createFilesystemResourceType({
      rules: holder.getRules(),
      list: async (q) => listFor((q as { root: string }).root),
    });
    const before = await type.discovery.search();
    expect(before.map((u) => unitAgentKey(u))).toEqual(["filesystem:a:%2Ftmp%2Fa%2Ff"]);

    const removed = JSON.stringify({ rules: [] });
    const result = reloadRules(holder, { BUTCHR_RULES_FILE: "/rules.json" }, () => removed);
    expect(result.ok).toBe(true);

    const after = await type.discovery.search();
    expect(after).toEqual([]);
  });

  test("a rule added by reload starts being polled on the loop's very next search, with no new resource type constructed", async () => {
    const holder = createRulesHolder([]);
    const type = createFilesystemResourceType({
      rules: holder.getRules(),
      list: async (q) => listFor((q as { root: string }).root),
    });
    expect(await type.discovery.search()).toEqual([]);

    const added = JSON.stringify({ rules: [ruleA] });
    reloadRules(holder, { BUTCHR_RULES_FILE: "/rules.json" }, () => added);

    const after = await type.discovery.search();
    expect(after.map((u) => unitAgentKey(u))).toEqual(["filesystem:a:%2Ftmp%2Fa%2Ff"]);
  });

  test("a reload mid-poll does not tear the poll already in flight: that poll's own search() read the rule set once, before the swap landed", async () => {
    const holder = createRulesHolder([ruleA]);
    let sawDuringPoll: string[] = [];
    const type = createFilesystemResourceType({
      rules: holder.getRules(),
      list: async (q) => {
        // A reload lands WHILE this poll's own `list` call is in flight —
        // `discovery.search()` must already have read `deps.rules` into its
        // own local before this point (see filesystem-type.ts's own
        // `search()`), so this poll finishes with rule "a" alone even though
        // the holder now also has "b".
        const removed = JSON.stringify({ rules: [{ ...ruleA, enabled: true }, { ...ruleB, enabled: true }] });
        reloadRules(holder, { BUTCHR_RULES_FILE: "/rules.json" }, () => removed);
        sawDuringPoll = holder.getRules().map((r) => r.id);
        return listFor((q as { root: string }).root);
      },
    });
    const first = await type.discovery.search();
    expect(sawDuringPoll).toEqual(["a", "b"]); // the holder itself already swapped mid-poll...
    expect(first.map((u) => unitAgentKey(u))).toEqual(["filesystem:a:%2Ftmp%2Fa%2Ff"]); // ...but THIS poll's own result set, read before the swap, did not tear.

    const second = await type.discovery.search();
    expect(second.length).toBe(1); // rule "b"'s root has no files; the next poll sees both rules, as expected.
  });
});
