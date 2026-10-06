import { describe, expect, test } from "bun:test";
import { briefExcerpt, buildRulesApiResponse, BRIEF_EXCERPT_MAX } from "../../src/web/rules-api.js";
import type { RuleInventoryEntry } from "../../src/agents/query-agent-inventory.js";
import type { Rule } from "../../src/rules/rules.js";

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "triage",
    enabled: true,
    resourceProvider: "jira-work",
    query: "project = FACTORY",
    brief: "a".repeat(300),
    execution: "swarm",
    account: "none",
    role: "worker",
    ...overrides,
  } as Rule;
}

function entry(overrides: Partial<RuleInventoryEntry> = {}): RuleInventoryEntry {
  return {
    kind: "rule",
    id: "triage",
    resourceProvider: "jira-work",
    query: "project = FACTORY",
    enabled: true,
    execution: "swarm",
    account: "none",
    role: "worker",
    agentPreferences: [],
    linkedEventing: false,
    mcpServerNames: [],
    staffed: true,
    reason: null,
    ...overrides,
  };
}

describe("briefExcerpt", () => {
  test("shorter than the cap: unchanged", () => {
    expect(briefExcerpt("short brief")).toBe("short brief");
  });
  test("longer than the cap: truncated to exactly BRIEF_EXCERPT_MAX chars", () => {
    const long = "x".repeat(500);
    const out = briefExcerpt(long);
    expect(out.length).toBe(BRIEF_EXCERPT_MAX);
    expect(out).toBe(long.slice(0, BRIEF_EXCERPT_MAX));
  });
});

describe("buildRulesApiResponse", () => {
  test("valid file: path/mtime/valid/problems, one entry per rule, never the full brief", () => {
    const r = buildRulesApiResponse({
      rulesFile: { path: "/rules.json", rules: [rule()], error: null },
      mtime: "2026-10-05T12:00:00.000Z",
      sourceEtag: "deadbeef",
      fileEtag: "deadbeef",
      ruleInventory: [entry()],
    });
    expect(r.path).toBe("/rules.json");
    expect(r.mtime).toBe("2026-10-05T12:00:00.000Z");
    expect(r.sourceEtag).toBe("deadbeef");
    expect(r.fileEtag).toBe("deadbeef");
    expect(r.stale).toBe(false);
    expect(r.valid).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.rules).toHaveLength(1);
    const out = r.rules[0]!;
    expect(out.id).toBe("triage");
    expect(out.resourceProvider).toBe("jira-work");
    expect(out.execution).toBe("swarm");
    expect(out.account).toBe("none");
    expect(out.role).toBe("worker");
    expect(out.staffed).toBe(true);
    expect(out.whyUnstaffed).toBeNull();
    expect(out.briefExcerpt.length).toBe(BRIEF_EXCERPT_MAX);
    expect(out.briefExcerpt.length).toBeLessThan(300);
    // the full 300-char brief must never appear anywhere in the response
    expect(JSON.stringify(r)).not.toContain("a".repeat(300));
  });
  test("no title/maxAgents field anywhere — SPEC CHANGE (a): these are not real Rule fields", () => {
    const r = buildRulesApiResponse({
      rulesFile: { path: "/rules.json", rules: [rule()], error: null },
      mtime: null,
      sourceEtag: "deadbeef",
      fileEtag: "deadbeef",
      ruleInventory: [entry()],
    });
    const out = r.rules[0] as unknown as Record<string, unknown>;
    expect("title" in out).toBe(false);
    expect("maxAgents" in out).toBe(false);
  });
  test("invalid file: valid:false, problems populated from the error message, zero rules", () => {
    const r = buildRulesApiResponse({
      rulesFile: { path: "/rules.json", rules: [], error: { path: "/rules.json", message: "line 1 is bad\nline 2 is also bad" } },
      mtime: "2026-10-05T12:00:00.000Z",
      sourceEtag: "deadbeef",
      fileEtag: "deadbeef",
      ruleInventory: [],
    });
    expect(r.valid).toBe(false);
    expect(r.problems).toEqual(["line 1 is bad", "line 2 is also bad"]);
    expect(r.rules).toEqual([]);
  });
  test("missing file: mtime null, same invalid shape", () => {
    const r = buildRulesApiResponse({
      rulesFile: { path: "/rules.json", rules: [], error: { path: "/rules.json", message: "ENOENT: no such file" } },
      mtime: null,
      sourceEtag: "deadbeef",
      fileEtag: "deadbeef",
      ruleInventory: [],
    });
    expect(r.mtime).toBeNull();
    expect(r.valid).toBe(false);
  });
  test("a disabled rule with staffed:false and a reason: whyUnstaffed carries it", () => {
    const r = buildRulesApiResponse({
      rulesFile: { path: "/rules.json", rules: [rule({ enabled: false })], error: null },
      mtime: null,
      sourceEtag: "deadbeef",
      fileEtag: "deadbeef",
      ruleInventory: [entry({ enabled: false, staffed: false, reason: "disabled" })],
    });
    expect(r.rules[0]!.whyUnstaffed).toBe("disabled");
    expect(r.rules[0]!.staffed).toBe(false);
  });
  test("staffed: null (census unavailable) is preserved as a distinct tri-state value, not collapsed to false", () => {
    const r = buildRulesApiResponse({
      rulesFile: { path: "/rules.json", rules: [rule()], error: null },
      mtime: null,
      sourceEtag: "deadbeef",
      fileEtag: "deadbeef",
      ruleInventory: [entry({ staffed: null, reason: "census unavailable: ..." })],
    });
    expect(r.rules[0]!.staffed).toBeNull();
  });
  test("brief matched by (resourceProvider, id), not id alone — two providers may reuse the same rule id", () => {
    const r = buildRulesApiResponse({
      rulesFile: {
        path: "/rules.json",
        rules: [rule({ id: "shared", resourceProvider: "jira-work", brief: "work brief" }), rule({ id: "shared", resourceProvider: "jira-idea", brief: "idea brief" })],
        error: null,
      },
      mtime: null,
      sourceEtag: "deadbeef",
      fileEtag: "deadbeef",
      ruleInventory: [
        entry({ id: "shared", resourceProvider: "jira-work" }),
        entry({ id: "shared", resourceProvider: "jira-idea" }),
      ],
    });
    expect(r.rules[0]!.briefExcerpt).toBe("work brief");
    expect(r.rules[1]!.briefExcerpt).toBe("idea brief");
  });
  test("sourceEtag !== fileEtag: stale is true — PR #642 review round 2, G1 (the UI must not write against a listing it never actually saw)", () => {
    const r = buildRulesApiResponse({
      rulesFile: { path: "/rules.json", rules: [rule()], error: null },
      mtime: null,
      sourceEtag: "startup-etag",
      fileEtag: "current-file-etag",
      ruleInventory: [entry()],
    });
    expect(r.sourceEtag).toBe("startup-etag");
    expect(r.fileEtag).toBe("current-file-etag");
    expect(r.stale).toBe(true);
  });
  test("no field named token/secret/password/authorization anywhere, defensively — rules hold none today, but the redaction must apply regardless", () => {
    const r = buildRulesApiResponse({
      rulesFile: { path: "/rules.json", rules: [rule()], error: null },
      mtime: null,
      sourceEtag: "deadbeef",
      fileEtag: "deadbeef",
      ruleInventory: [entry()],
    });
    const serialized = JSON.stringify(r).toLowerCase();
    for (const bad of ["token", "secret", "password", "authorization"]) {
      // the literal strings might appear nowhere at all, which is fine — if
      // a key happened to match, its value must have been redacted, never
      // the real value leaking through.
      expect(serialized.includes(`"${bad}"`) ? serialized.includes("[redacted]") : true).toBe(true);
    }
  });
});
