import { describe, expect, test } from "bun:test";
import { createJiraProjectResourceType, pinnedActiveMinutesFor, type CreateJiraProjectResourceTypeDeps, type ProjectMatch } from "../../src/rules/jira-project-type.js";
import type { Rule } from "../../src/rules/rules.js";
import type { JiraProject } from "../../src/resources/jira-project.js";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { PollSnapshot } from "../../src/resources/types.js";

function rule(over: Partial<Rule> & Pick<Rule, "id">): Rule {
  return { enabled: true, resourceProvider: "jira-project", query: "{}", brief: "b", execution: "singleton", account: "none", role: "worker", ...over };
}

function project(key: string): JiraProject {
  return { id: key, key, name: key };
}

function match(agentKey: string, r: Rule, projectKey: string): ProjectMatch {
  return { agentKey, rule: r, project: project(projectKey) };
}

/**
 * FACTORY-941: `pinnedActiveMinutesFor` is the pure resolution step
 * `src/daemon/index.ts` calls each poll (from its own
 * `projectType.discovery.search` wrap) to feed
 * `PinnedActiveDetectorDeps.minutesFor` — see that module's own doc
 * comment for the full contract. Tested here directly, independent of
 * index.ts (which cannot itself be imported in a test).
 */
describe("pinnedActiveMinutesFor", () => {
  test("a rule with an explicit idlePokeMinutes produces an entry keyed by that match's agentKey", () => {
    const r = rule({ id: "r1", idlePokeMinutes: 5 });
    const result = pinnedActiveMinutesFor([match("jira-project:r1:ACME", r, "ACME")]);
    expect(result.get("jira-project:r1:ACME")).toBe(5);
  });

  test("a rule that leaves idlePokeMinutes unset produces no entry — caller's own global fallback applies", () => {
    const r = rule({ id: "r1" });
    const result = pinnedActiveMinutesFor([match("jira-project:r1:ACME", r, "ACME")]);
    expect(result.has("jira-project:r1:ACME")).toBe(false);
  });

  test("a DISABLED rule's idlePokeMinutes is ignored entirely, even though it still produced a match", () => {
    const r = rule({ id: "r1", enabled: false, idlePokeMinutes: 5 });
    const result = pinnedActiveMinutesFor([match("jira-project:r1:ACME", r, "ACME")]);
    expect(result.has("jira-project:r1:ACME")).toBe(false);
  });

  test("two different rules matching two different projects resolve independently, one per agentKey — no cross-contamination", () => {
    const fast = rule({ id: "fast", idlePokeMinutes: 5 });
    const slow = rule({ id: "slow", idlePokeMinutes: 90 });
    const result = pinnedActiveMinutesFor([
      match("jira-project:fast:ACME", fast, "ACME"),
      match("jira-project:slow:WIDGET", slow, "WIDGET"),
    ]);
    expect(result.get("jira-project:fast:ACME")).toBe(5);
    expect(result.get("jira-project:slow:WIDGET")).toBe(90);
  });

  test("two DIFFERENT rules matching the SAME project produce two independent agentKeys, each with its own resolved minutes — no 'smallest wins' merge, unlike the issue tier's idlePokeRuleConfigByIssue", () => {
    const fast = rule({ id: "fast", idlePokeMinutes: 5 });
    const slow = rule({ id: "slow", idlePokeMinutes: 90 });
    const result = pinnedActiveMinutesFor([
      match("jira-project:fast:ACME", fast, "ACME"),
      match("jira-project:slow:ACME", slow, "ACME"),
    ]);
    expect(result.get("jira-project:fast:ACME")).toBe(5);
    expect(result.get("jira-project:slow:ACME")).toBe(90);
  });

  test("an empty match list (no jira-project rules matched this poll) resolves to an empty map", () => {
    expect(pinnedActiveMinutesFor([]).size).toBe(0);
  });

  test("is rebuilt fresh each call — a stale id from a PRIOR call's matches must not survive into a later call that no longer matches it (would otherwise poke a now-gone project at the wrong threshold)", () => {
    const r = rule({ id: "r1", idlePokeMinutes: 5 });
    const first = pinnedActiveMinutesFor([match("jira-project:r1:ACME", r, "ACME")]);
    expect(first.get("jira-project:r1:ACME")).toBe(5);
    const second = pinnedActiveMinutesFor([]);
    expect(second.has("jira-project:r1:ACME")).toBe(false);
  });
});

/**
 * FACTORY-981 (story FACTORY-979): `createJiraProjectResourceType`'s
 * `eventRules` wiring — the blocked/stalled project-manager wake, driven
 * from the exact `managers`-style rule shape (one rule, several projects)
 * the story's acceptance criteria name explicitly. Built directly from
 * hand-crafted `ProjectMatch` snapshots (never from `discovery.search`,
 * which is a separate concern already covered by the `discovery.search`
 * describe block below) — `eventRules.poll` is a pure function of the
 * (prev, next) snapshots it's handed, per `ResourceType`'s own opaque-
 * snapshot contract (src/resources/types.ts).
 */
function minimalDeps(over: Partial<CreateJiraProjectResourceTypeDeps> = {}): CreateJiraProjectResourceTypeDeps {
  return { rules: [], search: async () => [], ...over };
}

async function decideFor(
  deps: CreateJiraProjectResourceTypeDeps,
  prev: readonly ProjectMatch[],
  next: readonly ProjectMatch[],
  key: string,
) {
  const type = createJiraProjectResourceType(deps);
  const prevSnap: PollSnapshot<ProjectMatch> = { primary: prev, related: [] };
  const nextSnap: PollSnapshot<ProjectMatch> = { primary: next, related: [] };
  const poll = await type.eventRules.poll(prevSnap, nextSnap);
  const verdict = await poll.decide(key, key, "primary");
  return { poll, verdict };
}

describe("createJiraProjectResourceType — eventRules (blocked/stalled manager wake)", () => {
  const managers = rule({ id: "mgrs" });
  const acmeKey = "jira-project:mgrs:ACME";
  const betaKey = "jira-project:mgrs:BETA";

  function withBlocked(agentKey: string, projectKey: string, blocked: readonly string[], stalled: readonly string[] = []): ProjectMatch {
    return { agentKey, rule: managers, project: project(projectKey), observedBlockedKeys: blocked, observedStalledKeys: stalled };
  }

  // Failure condition: a ticket newly carrying agent:blocked must deliver
  // exactly one notify to ITS OWN project's manager, naming that ticket.
  test("a transition into agent:blocked delivers one notify naming the ticket, to that project's own manager", async () => {
    const prev = [withBlocked(acmeKey, "ACME", []), withBlocked(betaKey, "BETA", [])];
    const next = [withBlocked(acmeKey, "ACME", ["ACME-1"]), withBlocked(betaKey, "BETA", [])];
    const { poll, verdict } = await decideFor(minimalDeps(), prev, next, acmeKey);
    expect(poll.changedPrimary).toEqual([acmeKey]);
    expect(verdict).toEqual({ deliver: true, reason: { blocked: { key: "ACME-1" } } });
  });

  // Failure condition: criterion 4 — a blocked ticket in ACME must never be
  // reported to BETA's manager, even though both projects share one rule.
  test("a blocked ticket in one project never wakes a different project's manager under the same rule", async () => {
    const prev = [withBlocked(acmeKey, "ACME", []), withBlocked(betaKey, "BETA", [])];
    const next = [withBlocked(acmeKey, "ACME", ["ACME-1"]), withBlocked(betaKey, "BETA", [])];
    const { poll, verdict } = await decideFor(minimalDeps(), prev, next, betaKey);
    expect(poll.changedPrimary).not.toContain(betaKey);
    expect(verdict).toEqual({ deliver: false });
  });

  test("a transition into agent:stalled delivers one notify naming the ticket", async () => {
    const prev = [withBlocked(acmeKey, "ACME", [], [])];
    const next = [withBlocked(acmeKey, "ACME", [], ["ACME-2"])];
    const { verdict } = await decideFor(minimalDeps(), prev, next, acmeKey);
    expect(verdict).toEqual({ deliver: true, reason: { stalled: { key: "ACME-2" } } });
  });

  // Failure condition: criterion 3 — a ticket STILL blocked from the
  // previous poll (no new transition) must not re-fire, and unblocking must
  // not itself wake the manager either.
  test("a ticket already blocked on the previous poll does not re-fire, and unblocking it is silent", async () => {
    const stillBlocked = [withBlocked(acmeKey, "ACME", ["ACME-1"])];
    const { poll: samePoll, verdict: sameVerdict } = await decideFor(minimalDeps(), stillBlocked, stillBlocked, acmeKey);
    expect(samePoll.changedPrimary).toEqual([]);
    expect(sameVerdict).toEqual({ deliver: false });

    const prev = [withBlocked(acmeKey, "ACME", ["ACME-1"])];
    const next = [withBlocked(acmeKey, "ACME", [])];
    const { verdict: unblockVerdict } = await decideFor(minimalDeps(), prev, next, acmeKey);
    expect(unblockVerdict).toEqual({ deliver: false });
  });

  // Failure condition: criterion 3 — a project appearing/disappearing with
  // no blocked/stalled change, or any other field moving, must stay silent.
  // (Here: nothing at all changed between prev/next.)
  test("a poll with no observed blocked/stalled change reports no changedPrimary at all", async () => {
    const same = [withBlocked(acmeKey, "ACME", ["ACME-1"], ["ACME-2"])];
    const type = createJiraProjectResourceType(minimalDeps());
    const snap: PollSnapshot<ProjectMatch> = { primary: same, related: [] };
    const poll = await type.eventRules.poll(snap, snap);
    expect(poll.changedPrimary).toEqual([]);
    expect(poll.changedRelated).toEqual([]);
  });

  // Failure condition: criterion 2 — the hourly cap, threaded via deps, must
  // still apply across polls for the SAME manager.
  test("stalledWakeMaxPerHour threads through and caps a second stalled wake to the same manager within the hour", async () => {
    let capped = 0;
    const deps = minimalDeps({ stalledWakeMaxPerHour: 1, onStalledWakeCapped: () => { capped++; } });
    const type = createJiraProjectResourceType(deps);

    const poll1 = await type.eventRules.poll(
      { primary: [withBlocked(acmeKey, "ACME", [], [])], related: [] },
      { primary: [withBlocked(acmeKey, "ACME", [], ["ACME-2"])], related: [] },
    );
    const verdict1 = await poll1.decide(acmeKey, acmeKey, "primary");
    expect(verdict1).toEqual({ deliver: true, reason: { stalled: { key: "ACME-2" } } });

    const poll2 = await type.eventRules.poll(
      { primary: [withBlocked(acmeKey, "ACME", [], ["ACME-2"])], related: [] },
      { primary: [withBlocked(acmeKey, "ACME", [], ["ACME-2", "ACME-3"])], related: [] },
    );
    const verdict2 = await poll2.decide(acmeKey, acmeKey, "primary");
    expect(verdict2).toEqual({ deliver: false });
    expect(capped).toBe(1);
  });
});

/**
 * FACTORY-981: `discovery.search`'s own blocked/stalled read — batched ONCE
 * across every distinct project key this poll matched, then split back out
 * per project via `projectKeyOfIssue`. Failure condition: a ticket from one
 * project's batch result must only ever be attributed to ITS OWN project's
 * match, never another's, and the whole read must be skippable when
 * `searchIssues` is omitted.
 */
describe("createJiraProjectResourceType — discovery.search blocked/stalled read", () => {
  const managers = rule({ id: "mgrs" });

  function jiraIssue(key: string, over: Partial<JiraIssue> = {}): JiraIssue {
    return { key, summary: "s", status: "To Do", issuetype: "Task", assignee: null, parent: null, updated: "2026-01-01T00:00:00.000Z", labels: [], ...over };
  }

  test("splits a batched blocked/stalled search result per project, scoped to exactly the matched projects", async () => {
    const calls: string[] = [];
    const deps = minimalDeps({
      rules: [managers],
      search: async () => [project("ACME"), project("BETA")],
      searchIssues: async (jql) => {
        calls.push(jql);
        if (jql.includes("agent:blocked")) return [jiraIssue("ACME-1"), jiraIssue("BETA-9")];
        return [jiraIssue("ACME-2")];
      },
    });
    const type = createJiraProjectResourceType(deps);
    const matches = await type.discovery.search();
    const acme = matches.find((m) => m.project.key === "ACME")!;
    const beta = matches.find((m) => m.project.key === "BETA")!;
    expect(acme.observedBlockedKeys).toEqual(["ACME-1"]);
    expect(acme.observedStalledKeys).toEqual(["ACME-2"]);
    expect(beta.observedBlockedKeys).toEqual(["BETA-9"]);
    expect(beta.observedStalledKeys).toEqual([]);
    // Batched ONCE across both projects, not once per project.
    expect(calls.filter((j) => j.includes("agent:blocked")).length).toBe(1);
    expect(calls.filter((j) => j.includes("agent:stalled")).length).toBe(1);
    expect(calls[0]).toContain("ACME");
    expect(calls[0]).toContain("BETA");
  });

  test("omitted searchIssues leaves every match's blocked/stalled sets undefined — the feature silently never runs", async () => {
    const deps = minimalDeps({ rules: [managers], search: async () => [project("ACME")] });
    const type = createJiraProjectResourceType(deps);
    const matches = await type.discovery.search();
    expect(matches[0]!.observedBlockedKeys).toBeUndefined();
    expect(matches[0]!.observedStalledKeys).toBeUndefined();
  });
});
