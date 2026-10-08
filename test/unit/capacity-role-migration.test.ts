import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCapacityRoleMigration, classifyJqlQuery, planCapacityRoleMigration, runCapacityRoleMigration } from "../../src/rules/capacity-role-migration.js";
import { defaultIo } from "../../src/rules/write-rules.js";
import { capacityRoleFor } from "../../src/agents/capacity-role.js";
import type { AgentCapacityRole } from "../../src/agents/admission.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import type { RulesEnv } from "../../src/rules/rules.js";
import rulesExample from "../../docs/rules.example.json";

/**
 * FACTORY-810 (implementing FACTORY-754, epic FACTORY-748): the upgrade
 * migration FACTORY-757 shipped without (see `changelog.d/FACTORY-757.md`'s
 * "No migration and no UI ship with this change"). Covers the JQL
 * classifier in isolation, the pure plan/apply pair, the real I/O entry
 * point's idempotency and existence-based no-op, and (last describe block)
 * the end-to-end capacity-equivalence proof FACTORY-754's own definition of
 * done requires: the set of agents counted toward `BUTCHR_MAX_AGENTS` is
 * identical before the upgrade (old `capacityRoleFor`, reproduced here
 * verbatim from PR #691's pre-change diff) and after (today's
 * `capacityRoleFor` plus this migration) for one representative rule set
 * spanning every category FACTORY-754 names.
 */

describe("classifyJqlQuery", () => {
  test("docs/rules.example.json: epics/stories/bugs migrate, tasks/subtasks do not", () => {
    const byId = new Map(rulesExample.rules.map((r) => [r.id, r.query]));
    expect(classifyJqlQuery(byId.get("epics")!)).toEqual({ outcome: "migrate", issueTypes: ["epic"] });
    expect(classifyJqlQuery(byId.get("stories")!)).toEqual({ outcome: "migrate", issueTypes: ["story"] });
    expect(classifyJqlQuery(byId.get("bugs")!)).toEqual({ outcome: "migrate", issueTypes: ["bug"] });
    expect(classifyJqlQuery(byId.get("tasks")!)).toEqual({ outcome: "skip", reason: "issuetype-set-not-a-subset-of-epic-story-bug", issueTypes: ["task"] });
    expect(classifyJqlQuery(byId.get("subtasks")!)).toEqual({ outcome: "skip", reason: "issuetype-set-not-a-subset-of-epic-story-bug", issueTypes: ["sub-task"] });
  });

  test("an `in (...)` list of only exempt types migrates", () => {
    expect(classifyJqlQuery(`assignee = currentUser() AND issuetype IN (Epic, Story, Bug) AND status IN ("In Progress")`)).toEqual({
      outcome: "migrate",
      issueTypes: ["epic", "story", "bug"],
    });
  });

  test("an `in (...)` list mixing an exempt and a non-exempt type does not migrate", () => {
    expect(classifyJqlQuery(`issuetype IN (Epic, Task)`)).toMatchObject({ outcome: "skip", reason: "issuetype-set-not-a-subset-of-epic-story-bug" });
  });

  test("quoted values and case-insensitivity both work", () => {
    expect(classifyJqlQuery(`issuetype = "Epic"`)).toEqual({ outcome: "migrate", issueTypes: ["epic"] });
    expect(classifyJqlQuery(`issuetype = EPIC`)).toEqual({ outcome: "migrate", issueTypes: ["epic"] });
  });

  test("no issuetype clause at all: skip, cannot classify", () => {
    expect(classifyJqlQuery(`assignee = currentUser() AND status = "In Progress"`)).toEqual({ outcome: "skip", reason: "no-top-level-issuetype-clause" });
  });

  test("more than one top-level issuetype clause: skip, ambiguous", () => {
    expect(classifyJqlQuery(`issuetype = Epic AND issuetype = Story`)).toEqual({ outcome: "skip", reason: "ambiguous-issuetype-clause-count" });
  });

  test("negation (!=): skip — restriction only, never exclusion", () => {
    expect(classifyJqlQuery(`issuetype != Task`)).toEqual({ outcome: "skip", reason: "issuetype-clause-is-negated-or-unrecognised-operator" });
  });

  test("negation (not in): skip", () => {
    expect(classifyJqlQuery(`issuetype NOT IN (Task, "Sub-task")`)).toEqual({ outcome: "skip", reason: "issuetype-clause-is-negated-or-unrecognised-operator" });
  });

  test("OR-combined with another clause: skip — an OR can widen what actually matches", () => {
    expect(classifyJqlQuery(`issuetype = Epic OR assignee = currentUser()`)).toEqual({ outcome: "skip", reason: "issuetype-clause-combined-with-or" });
    expect(classifyJqlQuery(`assignee = currentUser() OR issuetype = Epic`)).toEqual({ outcome: "skip", reason: "issuetype-clause-combined-with-or" });
  });

  test("issuetype clause nested inside an OR-containing parenthesized group is still safely classified at depth 0", () => {
    // The top-level clause itself is AND-ed; the OR lives safely inside its own parens and narrows
    // only the non-issuetype half of the query, so this is still a clean "migrate".
    expect(classifyJqlQuery(`issuetype = Story AND (status = "In Progress" OR status = "In Review")`)).toEqual({ outcome: "migrate", issueTypes: ["story"] });
  });

  test("unbalanced parens/quotes: skip, refuses to guess", () => {
    expect(classifyJqlQuery(`issuetype = Epic AND (status = "In Progress"`)).toEqual({ outcome: "skip", reason: "unbalanced-query-syntax" });
    expect(classifyJqlQuery(`issuetype = Epic AND status = "unterminated`)).toEqual({ outcome: "skip", reason: "unbalanced-query-syntax" });
  });

  test("a quoted string literal containing the word issuetype/order-by-like text is inert, never mistaken for a real clause", () => {
    expect(classifyJqlQuery(`summary ~ "issuetype = Epic" AND issuetype = Bug`)).toEqual({ outcome: "migrate", issueTypes: ["bug"] });
  });

  // Review finding (PR #701): a trailing top-level `ORDER BY` — JQL's own always-final construct —
  // must terminate the filter exactly like end-of-string, not read as "something follows the clause".
  test("a trailing top-level ORDER BY does not stop an otherwise-clean issuetype clause from migrating", () => {
    expect(classifyJqlQuery(`assignee = currentUser() AND issuetype = Epic ORDER BY created`)).toEqual({ outcome: "migrate", issueTypes: ["epic"] });
  });

  test("ORDER BY after an `in (...)` list also does not block migration", () => {
    expect(classifyJqlQuery(`assignee = currentUser() AND issuetype IN (Story, Bug) ORDER BY created`)).toEqual({ outcome: "migrate", issueTypes: ["story", "bug"] });
  });

  test("ORDER BY after a non-exempt issuetype still correctly skips (Task is not epic/story/bug)", () => {
    expect(classifyJqlQuery(`assignee = currentUser() AND issuetype = Task ORDER BY created`)).toEqual({
      outcome: "skip",
      reason: "issuetype-set-not-a-subset-of-epic-story-bug",
      issueTypes: ["task"],
    });
  });
});

describe("planCapacityRoleMigration (pure)", () => {
  const doc = (rules: unknown[]): string => JSON.stringify({ rules });

  test("jira-work rule with no role, exempt-only query: migrate", () => {
    const plan = planCapacityRoleMigration(doc([{ id: "epics", resourceProvider: "jira-work", query: "issuetype = Epic", brief: "b" }]));
    expect(plan).toEqual([{ id: "epics", outcome: "migrate", issueTypes: ["epic"] }]);
  });

  test("jira-work task rule with no role: skip, left alone (counted by default, same as before)", () => {
    const plan = planCapacityRoleMigration(doc([{ id: "tasks", resourceProvider: "jira-work", query: "issuetype = Task", brief: "b" }]));
    expect(plan).toEqual([{ id: "tasks", outcome: "skip", reason: "issuetype-set-not-a-subset-of-epic-story-bug", issueTypes: ["task"] }]);
  });

  test("a rule that ALREADY has an explicit role is never classified, in either direction — operator intent (or the interim admin-assembly step) always wins", () => {
    const planSentinel = planCapacityRoleMigration(doc([{ id: "epics", resourceProvider: "jira-work", query: "issuetype = Epic", brief: "b", role: "sentinel" }]));
    expect(planSentinel).toEqual([{ id: "epics", outcome: "skip", reason: "already-has-role" }]);
    const planWorker = planCapacityRoleMigration(doc([{ id: "epics", resourceProvider: "jira-work", query: "issuetype = Epic", brief: "b", role: "worker" }]));
    expect(planWorker).toEqual([{ id: "epics", outcome: "skip", reason: "already-has-role" }]);
  });

  test("jira-project (manager) rules are never even classified — role there is never read by capacityRoleFor", () => {
    const plan = planCapacityRoleMigration(doc([{ id: "managers", resourceProvider: "jira-project", query: "{}", brief: "b" }]));
    expect(plan).toEqual([{ id: "managers", outcome: "skip", reason: "not-jira-work" }]);
  });

  test("github-issue/zendesk-ticket/filesystem rules are never classified — the old exemption never covered them", () => {
    const plan = planCapacityRoleMigration(
      doc([
        { id: "gh", resourceProvider: "github-issue", query: "is:open", brief: "b" },
        { id: "zd", resourceProvider: "zendesk-ticket", query: "status:open", brief: "b" },
        { id: "fs", resourceProvider: "filesystem", query: "{}", brief: "b" },
      ]),
    );
    expect(plan).toEqual([
      { id: "gh", outcome: "skip", reason: "not-jira-work" },
      { id: "zd", outcome: "skip", reason: "not-jira-work" },
      { id: "fs", outcome: "skip", reason: "not-jira-work" },
    ]);
  });
});

describe("applyCapacityRoleMigration (pure text edit)", () => {
  test("writes role: sentinel only onto the plan's migrate entries, formatting otherwise untouched", () => {
    const text = JSON.stringify(
      {
        rules: [
          { id: "epics", resourceProvider: "jira-work", query: "issuetype = Epic", brief: "b" },
          { id: "tasks", resourceProvider: "jira-work", query: "issuetype = Task", brief: "b" },
        ],
      },
      null,
      2,
    );
    const plan = planCapacityRoleMigration(text);
    const next = applyCapacityRoleMigration(text, plan);
    const parsed = JSON.parse(next);
    expect(parsed.rules[0].role).toBe("sentinel");
    expect(parsed.rules[1].role).toBeUndefined();
  });
});

describe("runCapacityRoleMigration (I/O entry point)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "butchr-capacity-migration-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function env(): RulesEnv {
    return { XDG_CONFIG_HOME: dir };
  }

  function rulesPath(): string {
    return join(dir, "butchr", "rules.json");
  }

  function writeRulesFileDirect(rules: unknown[]): void {
    mkdirSync(join(dir, "butchr"), { recursive: true });
    writeFileSync(rulesPath(), JSON.stringify({ rules }, null, 2) + "\n");
  }

  test("no rules file at all: no-op, no directory created", () => {
    const outcome = runCapacityRoleMigration(env(), defaultIo());
    expect(outcome.kind).toBe("no-rules-file");
    expect(() => readdirSync(join(dir, "butchr"))).toThrow();
  });

  test("a representative rule set migrates exactly the exempt-query rules, and only those", () => {
    writeRulesFileDirect([
      { id: "epics", resourceProvider: "jira-work", query: `assignee = currentUser() AND issuetype = Epic AND status IN ("In Progress", "In Review")`, brief: "@builtin:epic" },
      { id: "stories", resourceProvider: "jira-work", query: `assignee = currentUser() AND issuetype = Story AND status IN ("In Progress", "In Review")`, brief: "@builtin:story" },
      { id: "bugs", resourceProvider: "jira-work", query: `assignee = currentUser() AND issuetype = Bug AND status IN ("In Progress", "In Review")`, brief: "@builtin:bug" },
      { id: "tasks", resourceProvider: "jira-work", query: `assignee = currentUser() AND issuetype = Task AND status IN ("In Progress", "In Review")`, brief: "@builtin:task" },
      { id: "subtasks", resourceProvider: "jira-work", query: `assignee = currentUser() AND issuetype = "Sub-task" AND status IN ("In Progress", "In Review")`, brief: "subtask brief" },
      { id: "managers", resourceProvider: "jira-project", query: "{}", brief: "manage it" },
    ]);
    const outcome = runCapacityRoleMigration(env(), defaultIo());
    expect(outcome.kind).toBe("migrated");
    if (outcome.kind !== "migrated") throw new Error("unreachable");
    expect(outcome.migratedIds.sort()).toEqual(["bugs", "epics", "stories"]);

    const after = JSON.parse(readFileSync(rulesPath(), "utf8")) as { rules: Array<{ id: string; role?: string }> };
    const roleById = new Map(after.rules.map((r) => [r.id, r.role]));
    expect(roleById.get("epics")).toBe("sentinel");
    expect(roleById.get("stories")).toBe("sentinel");
    expect(roleById.get("bugs")).toBe("sentinel");
    expect(roleById.get("tasks")).toBeUndefined();
    expect(roleById.get("subtasks")).toBeUndefined();
    expect(roleById.get("managers")).toBeUndefined();
  });

  test("idempotent: a second run performs ZERO filesystem writes (no new backup, mtime untouched)", () => {
    writeRulesFileDirect([{ id: "epics", resourceProvider: "jira-work", query: "issuetype = Epic", brief: "b" }]);
    const first = runCapacityRoleMigration(env(), defaultIo());
    expect(first.kind).toBe("migrated");
    const textAfterFirst = readFileSync(rulesPath(), "utf8");
    const entriesAfterFirst = readdirSync(join(dir, "butchr")).sort();

    const second = runCapacityRoleMigration(env(), defaultIo());
    expect(second.kind).toBe("no-op");
    expect(readFileSync(rulesPath(), "utf8")).toBe(textAfterFirst);
    // no new backup was created — the directory listing is byte-identical
    expect(readdirSync(join(dir, "butchr")).sort()).toEqual(entriesAfterFirst);
  });

  test("an operator-set (or admin-assembly-set) explicit role survives untouched, in both directions", () => {
    writeRulesFileDirect([
      { id: "epics", resourceProvider: "jira-work", query: "issuetype = Epic", brief: "b", role: "worker" },
      { id: "stories", resourceProvider: "jira-work", query: "issuetype = Story", brief: "b", role: "sentinel" },
    ]);
    const outcome = runCapacityRoleMigration(env(), defaultIo());
    expect(outcome.kind).toBe("no-op");
    const after = JSON.parse(readFileSync(rulesPath(), "utf8")) as { rules: Array<{ id: string; role?: string }> };
    expect(after.rules.find((r) => r.id === "epics")!.role).toBe("worker");
    expect(after.rules.find((r) => r.id === "stories")!.role).toBe("sentinel");
  });

  test("a jira-project (manager) rule never gets a role written, even though its query happens to mention issuetype", () => {
    writeRulesFileDirect([{ id: "managers", resourceProvider: "jira-project", query: JSON.stringify({ query: "issuetype = Epic" }), brief: "b" }]);
    const outcome = runCapacityRoleMigration(env(), defaultIo());
    expect(outcome.kind).toBe("no-op");
    const after = JSON.parse(readFileSync(rulesPath(), "utf8")) as { rules: Array<{ id: string; role?: string }> };
    expect(after.rules[0]!.role).toBeUndefined();
  });
});

/**
 * FACTORY-754's own required proof: the set of agents counted toward
 * `BUTCHR_MAX_AGENTS` is identical before and after the FACTORY-757 +
 * FACTORY-810 upgrade, for one representative rule set spanning every
 * category. "Before" reproduces the OLD `capacityRoleFor`
 * (three-argument form, `issuetypeOf` lookup, `UNCOUNTED_ISSUE_TYPES`)
 * VERBATIM from PR #691's own pre-change diff (`git show
 * bbe1758:src/agents/capacity-role.ts`, read at this repo's own commit —
 * this is deliberately a frozen historical snapshot, not an import, since
 * the real module no longer has this shape at all). "After" uses TODAY's
 * `capacityRoleFor` (two-argument, no issuetype lookup) together with this
 * migration's own output as the rule set's `role`.
 */
describe("end-to-end: counted-agent set is identical before and after the upgrade (FACTORY-754 DoD)", () => {
  const OLD_UNCOUNTED_ISSUE_TYPES: ReadonlySet<string> = new Set(["epic", "story", "bug"]);
  const oldIsUncountedIssueType = (issuetype: string | undefined): boolean => issuetype !== undefined && OLD_UNCOUNTED_ISSUE_TYPES.has(issuetype.trim().toLowerCase());

  function oldCapacityRoleFor(id: string, ruleRoleOf: (id: string) => AgentCapacityRole | undefined, issuetypeOf: (issueKey: string) => string | undefined): AgentCapacityRole {
    const decodeAnyAgentKeyShim = (agentId: string) => {
      const parts = agentId.split(":");
      if (parts.length !== 3) return null;
      const [resourceProvider, ruleId, resourceId] = parts;
      return { resourceProvider, ruleId, resourceId };
    };
    const isProjectIdShim = (agentId: string) => /^[A-Z][A-Z0-9]*$/.test(agentId);
    const isIssueKeyShim = (agentId: string) => /^[A-Z][A-Z0-9]*-\d+$/.test(agentId);

    if (isProjectIdShim(id)) return "sentinel";
    if (isIssueKeyShim(id)) return oldIsUncountedIssueType(issuetypeOf(id)) ? "sentinel" : ruleRoleOf(id) ?? "worker";
    const decoded = decodeAnyAgentKeyShim(id);
    if (decoded?.resourceProvider === "jira-project") return "sentinel";
    if (decoded?.resourceProvider === "jira-work" && oldIsUncountedIssueType(issuetypeOf(decoded.resourceId!))) return "sentinel";
    return ruleRoleOf(id) ?? "worker";
  }

  // One representative "live rules file" covering every FACTORY-754 category, pre-upgrade (no `role` field anywhere, since that field predates FACTORY-757 only via BUTCHR-398, and no rule here has set one yet).
  const PRE_UPGRADE_RULES = [
    { id: "epics", resourceProvider: "jira-work" as const, query: `assignee = currentUser() AND issuetype = Epic AND status IN ("In Progress", "In Review")` },
    { id: "stories", resourceProvider: "jira-work" as const, query: `assignee = currentUser() AND issuetype = Story AND status IN ("In Progress", "In Review")` },
    { id: "bugs", resourceProvider: "jira-work" as const, query: `assignee = currentUser() AND issuetype = Bug AND status IN ("In Progress", "In Review")` },
    { id: "tasks", resourceProvider: "jira-work" as const, query: `assignee = currentUser() AND issuetype = Task AND status IN ("In Progress", "In Review")` },
    { id: "subtasks", resourceProvider: "jira-work" as const, query: `assignee = currentUser() AND issuetype = "Sub-task" AND status IN ("In Progress", "In Review")` },
    { id: "managers", resourceProvider: "jira-project" as const, query: "{}" },
  ];

  // Candidate agents: one per jira-work rule's matched ticket (tagged with the issue type its own query selects), one jira-project manager, one bare project id, one github-issue and one zendesk-ticket agent (non-Jira providers the old exemption never touched).
  const ISSUE_TYPE_OF: Record<string, string> = { "BUTCHR-1": "Epic", "BUTCHR-2": "Story", "BUTCHR-3": "Task", "BUTCHR-4": "Sub-task", "BUTCHR-5": "Bug" };
  const issuetypeOf = (issueKey: string): string | undefined => ISSUE_TYPE_OF[issueKey];

  const jiraWorkAgentKeys = {
    epics: encodeAgentKey({ resourceProvider: "jira-work", ruleId: "epics", resourceId: "BUTCHR-1" }),
    stories: encodeAgentKey({ resourceProvider: "jira-work", ruleId: "stories", resourceId: "BUTCHR-2" }),
    tasks: encodeAgentKey({ resourceProvider: "jira-work", ruleId: "tasks", resourceId: "BUTCHR-3" }),
    subtasks: encodeAgentKey({ resourceProvider: "jira-work", ruleId: "subtasks", resourceId: "BUTCHR-4" }),
    bugs: encodeAgentKey({ resourceProvider: "jira-work", ruleId: "bugs", resourceId: "BUTCHR-5" }),
  };
  const managerKey = encodeAgentKey({ resourceProvider: "jira-project", ruleId: "managers", resourceId: "BUTCHR" });
  const projectKey = "BUTCHR";
  const githubKey = encodeAgentKey({ resourceProvider: "github-issue", ruleId: "triage", resourceId: "acme/widgets#99" });
  const zendeskKey = encodeAgentKey({ resourceProvider: "zendesk-ticket", ruleId: "support", resourceId: "acme#123" });

  const ALL_CANDIDATES = [...Object.values(jiraWorkAgentKeys), managerKey, projectKey, githubKey, zendeskKey];

  function countedSetOld(): Set<string> {
    const ruleRoleOf = (): AgentCapacityRole | undefined => undefined; // pre-upgrade: no rule in this representative file has ever set `role`
    return new Set(ALL_CANDIDATES.filter((id) => oldCapacityRoleFor(id, ruleRoleOf, issuetypeOf) === "worker"));
  }

  function countedSetNew(migratedRules: ReadonlyArray<{ id: string; resourceProvider: string; role?: AgentCapacityRole }>): Set<string> {
    const ruleRoleOf = (id: string): AgentCapacityRole | undefined => {
      const decoded = id.split(":");
      if (decoded.length !== 3) return undefined;
      const [resourceProvider, ruleId] = decoded;
      return migratedRules.find((r) => r.id === ruleId && r.resourceProvider === resourceProvider)?.role;
    };
    return new Set(ALL_CANDIDATES.filter((id) => capacityRoleFor(id, ruleRoleOf) === "worker"));
  }

  test("sanity: the old logic's counted set over this representative rule set is exactly tasks + subtasks + github + zendesk", () => {
    expect(countedSetOld()).toEqual(new Set([jiraWorkAgentKeys.tasks, jiraWorkAgentKeys.subtasks, githubKey, zendeskKey]));
  });

  test("migrated rules + today's capacityRoleFor reproduce the EXACT same counted set as the old issue-type hardcoding", () => {
    const text = JSON.stringify({ rules: PRE_UPGRADE_RULES.map((r) => ({ ...r, brief: "b" })) });
    const plan = planCapacityRoleMigration(text);
    const migratedText = applyCapacityRoleMigration(text, plan);
    const migratedRules = (JSON.parse(migratedText) as { rules: Array<{ id: string; resourceProvider: string; role?: AgentCapacityRole }> }).rules;

    expect(countedSetNew(migratedRules)).toEqual(countedSetOld());
  });

  test("this test genuinely fails if the migration is removed (disabled here on purpose, to prove the assertion has teeth)", () => {
    // "Disabling" the migration: pretend no rule ever got migrated (role is absent everywhere, exactly FACTORY-757's own unmigrated state).
    const unmigratedRules = PRE_UPGRADE_RULES.map((r) => ({ id: r.id, resourceProvider: r.resourceProvider }));
    expect(countedSetNew(unmigratedRules)).not.toEqual(countedSetOld());
    // Specifically: epics/stories/bugs are wrongly counted now (the exact regression this migration exists to prevent).
    const wronglyCounted = countedSetNew(unmigratedRules);
    expect(wronglyCounted.has(jiraWorkAgentKeys.epics)).toBe(true);
    expect(wronglyCounted.has(jiraWorkAgentKeys.stories)).toBe(true);
    expect(wronglyCounted.has(jiraWorkAgentKeys.bugs)).toBe(true);
  });
});
