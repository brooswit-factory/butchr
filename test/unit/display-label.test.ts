import { describe, expect, test } from "bun:test";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";
import { MANAGED_SESSIONS_RULE_ID } from "../../src/rules/session-definition-type.js";
import { jiraWorkShortDisplayId } from "../../src/rules/resource-type.js";
import { jiraIdeaShortDisplayId } from "../../src/rules/jira-idea-type.js";
import { jiraProjectShortDisplayId } from "../../src/rules/jira-project-type.js";
import { filesystemShortDisplayId } from "../../src/rules/filesystem-type.js";
import { managedSessionShortDisplayId } from "../../src/rules/session-definition-type.js";
import { githubIssueShortDisplayId } from "../../src/rules/github-issue-type.js";
import { githubPrShortDisplayId } from "../../src/rules/github-pr-type.js";
import { zendeskTicketShortDisplayId } from "../../src/rules/zendesk-ticket-type.js";
import { baseDisplayLabel, resolveDisplayLabels } from "../../src/rules/display-label.js";
import { absPath } from "../helpers/abs-path";

// FACTORY-95 (implementing FACTORY-90, epic FACTORY-83): one describe block
// per provider's own short-id method — each is its OWN function (the
// ticket's "one method on each provider, not a central switch"
// instruction), so each gets its own direct, unmediated test.

describe("per-provider short display id", () => {
  test("jira-work: the resourceId IS the issue key (operator's own example, FACTORY-20)", () => {
    expect(jiraWorkShortDisplayId("FACTORY-20")).toBe("FACTORY-20");
  });

  test("jira-idea: same identity shape as jira-work, independently", () => {
    expect(jiraIdeaShortDisplayId("IDEAS-7")).toBe("IDEAS-7");
  });

  test("jira-project: the resourceId IS the project key", () => {
    expect(jiraProjectShortDisplayId("BUTCHR")).toBe("BUTCHR");
  });

  test("filesystem: <parent>:<name> (operator's own example)", () => {
    expect(filesystemShortDisplayId("/home/brooswit/brooswit-factory/rinth")).toBe("brooswit-factory:rinth");
  });

  test("filesystem: a path one segment below root has no parent to name", () => {
    expect(filesystemShortDisplayId("/rinth")).toBe("rinth");
  });

  test("managed-sessions: the bare definition name, .json stripped", () => {
    expect(managedSessionShortDisplayId("/home/brooswrit/.config/butchr/session-definitions/admin-assembly.json")).toBe("admin-assembly");
  });

  test("managed-sessions: differs from the generic filesystem <parent>:<name> rule applied to the same path (FACTORY-83's deliberate decision)", () => {
    const path = "/home/brooswrit/.config/butchr/session-definitions/admin-assembly.json";
    expect(managedSessionShortDisplayId(path)).toBe("admin-assembly");
    expect(filesystemShortDisplayId(path)).toBe("session-definitions:admin-assembly.json");
    expect(managedSessionShortDisplayId(path)).not.toBe(filesystemShortDisplayId(path));
  });

  test("github-issue: <repo>#<number>, owner dropped (operator's own example shape)", () => {
    expect(githubIssueShortDisplayId("brooswit-factory/butchr#42")).toBe("butchr#42");
  });

  test("github-issue: an unparseable id falls back to itself rather than throwing", () => {
    expect(githubIssueShortDisplayId("not-a-ref")).toBe("not-a-ref");
  });

  test("github-pr: same <repo>#<number> shape as github-issue, independently", () => {
    expect(githubPrShortDisplayId("brooswit-factory/butchr#43")).toBe("butchr#43");
  });

  test("zendesk-ticket: #<id>, subdomain dropped (operator's own example shape)", () => {
    expect(zendeskTicketShortDisplayId("acme#4567")).toBe("#4567");
  });

  test("zendesk-ticket: an unparseable id falls back to itself rather than throwing", () => {
    expect(zendeskTicketShortDisplayId("not-a-ref")).toBe("not-a-ref");
  });
});

describe("baseDisplayLabel: combining a short id with its rule id", () => {
  test("an ordinary resource agent displays \"<shortId> · <ruleId>\" (operator's own example)", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-51" });
    expect(baseDisplayLabel(key)).toBe("FACTORY-51 · jira-work");
  });

  test("a managed session displays its bare short id alone — no \"· ruleId\" suffix", () => {
    const key = encodeAgentKey({
      resourceProvider: "filesystem",
      ruleId: MANAGED_SESSIONS_RULE_ID,
      resourceId: absPath("home", "brooswrit", ".config", "butchr", "session-definitions", "admin-assembly.json"),
    });
    expect(baseDisplayLabel(key)).toBe("admin-assembly");
  });

  test("a query-level (singleton/persistent) agent with no single resource displays its bare rule id", () => {
    const key = encodeQueryAgentKey({ resourceProvider: "github-issue", ruleId: "triage" });
    expect(baseDisplayLabel(key)).toBe("triage");
  });

  test("a legacy/bare id (not a rule-engine key) is returned unchanged — pre-FACTORY-95 behaviour", () => {
    expect(baseDisplayLabel("KAN-7")).toBe("KAN-7");
  });

  test("an ordinary filesystem resource agent combines <parent>:<name> with its rule id", () => {
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("srv", "brooswit-factory", "rinth") });
    expect(baseDisplayLabel(key)).toBe("brooswit-factory:rinth · repos");
  });
});

describe("resolveDisplayLabels: deterministic, loud collision handling (FACTORY-90 requirement 2)", () => {
  test("no collision: every key keeps its own bare label, no warning logged", () => {
    const a = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "FACTORY-1" });
    const b = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "FACTORY-2" });
    const lines: string[] = [];
    const labels = resolveDisplayLabels([a, b], (l) => lines.push(l));
    expect(labels.get(a)).toBe("FACTORY-1 · triage");
    expect(labels.get(b)).toBe("FACTORY-2 · triage");
    expect(lines).toEqual([]);
  });

  test("two resources under different roots collide on the same <parent>:<name> — disambiguated, not silently shared, one warning logged", () => {
    // Same "<parent>:<name>" (brooswit-factory:rinth) reached under two different roots.
    const a = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("home", "one", "brooswit-factory", "rinth") });
    const b = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("srv", "two", "brooswit-factory", "rinth") });
    const lines: string[] = [];
    const labels = resolveDisplayLabels([a, b], (l) => lines.push(l));
    const bareLabel = "brooswit-factory:rinth · repos";
    expect(labels.get(a)).not.toBe(labels.get(b)); // never shared
    expect([labels.get(a), labels.get(b)]).toContain(bareLabel); // one keeps the bare label
    const suffixed = [labels.get(a), labels.get(b)].find((l) => l !== bareLabel)!;
    expect(suffixed).toMatch(/^brooswit-factory:rinth · repos-[0-9a-f]{6}$/);
    expect(lines.length).toBe(1); // one warning for the whole group, not one per key
    expect(lines[0]).toContain(bareLabel);
  });

  test("query-level agents from two different providers sharing a rule id also collide (bare-ruleId labels)", () => {
    const a = encodeQueryAgentKey({ resourceProvider: "jira-work", ruleId: "sync" });
    const b = encodeQueryAgentKey({ resourceProvider: "github-issue", ruleId: "sync" });
    const labels = resolveDisplayLabels([a, b]);
    expect(labels.get(a)).not.toBe(labels.get(b));
    expect([labels.get(a), labels.get(b)]).toContain("sync");
  });

  test("determinism: the SAME colliding set always resolves the SAME way, regardless of input order or which key is asked about first", () => {
    const a = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("home", "one", "brooswit-factory", "rinth") });
    const b = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("srv", "two", "brooswit-factory", "rinth") });
    const forward = resolveDisplayLabels([a, b]);
    const backward = resolveDisplayLabels([b, a]);
    expect(forward.get(a)).toBe(backward.get(a));
    expect(forward.get(b)).toBe(backward.get(b));
  });

  test("stability across spawn-path vs. relabel-in-place-path universes: a key's label is the same whether resolved alone-plus-siblings or as part of the full running set (same agent -> same label both ways)", () => {
    const a = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("home", "one", "brooswit-factory", "rinth") });
    const b = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("srv", "two", "brooswit-factory", "rinth") });
    const c = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "FACTORY-9" });
    // "Spawn path": the running set at the moment `b` is spawned already contains `a` and `c`.
    const atSpawnTime = resolveDisplayLabels([a, c, b]);
    // "Relabel-in-place path": a later daemon restart re-derives labels for the full running set at once.
    const atRelabelTime = resolveDisplayLabels([a, b, c]);
    expect(atSpawnTime.get(a)).toBe(atRelabelTime.get(a));
    expect(atSpawnTime.get(b)).toBe(atRelabelTime.get(b));
    expect(atSpawnTime.get(c)).toBe(atRelabelTime.get(c));
  });

  test("a three-way collision disambiguates every member but the bare-label winner, each with its own distinct suffix", () => {
    const a = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("a", "brooswit-factory", "rinth") });
    const b = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("b", "brooswit-factory", "rinth") });
    const c = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("c", "brooswit-factory", "rinth") });
    const labels = resolveDisplayLabels([a, b, c]);
    const values = [labels.get(a)!, labels.get(b)!, labels.get(c)!];
    expect(new Set(values).size).toBe(3); // all distinct
    expect(values.filter((v) => v === "brooswit-factory:rinth · repos").length).toBe(1); // exactly one bare winner
  });
});
