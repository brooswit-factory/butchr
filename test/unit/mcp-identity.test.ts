import { describe, expect, test } from "bun:test";
import { callerIdentity } from "../../src/mcp/identity.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";

// BUTCHR-397: callerIdentity decodes `x-butchr-agent` with `decodeAnyAgentKey`, so a
// query-level key must never crash it (e.g. `parseGithubIssueRef(undefined)`) or be
// silently misread as a per-resource caller. Existing per-resource behaviour, covered
// more fully in the provider-specific test files, is exercised here only for contrast.
describe("callerIdentity (BUTCHR-397: query-level keys)", () => {
  test("per-resource agent keys still resolve as before, one per provider", () => {
    expect(callerIdentity({ "x-issue": "BUTCHR-1", "x-butchr-agent": encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-1" }) }))
      .toEqual({ provider: "jira-work", issue: "BUTCHR-1", agent: "jira-work:triage:BUTCHR-1" });
    expect(callerIdentity({ "x-butchr-agent": encodeAgentKey({ resourceProvider: "github-issue", ruleId: "triage", resourceId: "acme/web#42" }) }))
      .toEqual({ provider: "github-issue", agent: "github-issue:triage:acme%2Fweb%2342", ruleId: "triage", resource: "acme/web#42", ref: { owner: "acme", repo: "web", number: 42 } });
    expect(callerIdentity({ "x-butchr-agent": encodeAgentKey({ resourceProvider: "github-pr", ruleId: "triage", resourceId: "acme/web#42" }) }))
      .toEqual({ provider: "github-pr", agent: "github-pr:triage:acme%2Fweb%2342", ruleId: "triage", resource: "acme/web#42", ref: { owner: "acme", repo: "web", number: 42 } });
    expect(callerIdentity({ "x-butchr-agent": encodeAgentKey({ resourceProvider: "jira-idea", ruleId: "ideas", resourceId: "IDEA-1" }) }))
      .toEqual({ provider: "jira-idea", agent: "jira-idea:ideas:IDEA-1", ruleId: "ideas", resource: "IDEA-1" });
    expect(callerIdentity({ "x-butchr-agent": encodeAgentKey({ resourceProvider: "zendesk-ticket", ruleId: "support", resourceId: "acme#7" }) }))
      .toEqual({ provider: "zendesk-ticket", agent: "zendesk-ticket:support:acme%237", ruleId: "support", resource: "acme#7", ref: { subdomain: "acme", id: 7 } });
  });

  // BUTCHR-398: a query-level `x-butchr-agent` (a `singleton`/`persistent`
  // rule's one agent) is now RECOGNISED — `{ provider, agent, ruleId, query:
  // true }`, for every provider — never crashing on a missing `resourceId`
  // and never silently misread as a per-resource caller. Refused (null)
  // ONLY when it also carries `x-issue`: a query-level agent has no single
  // ticket to name one for, the same double-identity refusal every
  // `KEY_ONLY_PROVIDERS` branch already applies.
  test("a query-level agent key resolves as its own CallerIdentity variant, for every provider; refused only alongside x-issue", () => {
    for (const resourceProvider of ["jira-work", "github-issue", "github-pr", "jira-idea", "zendesk-ticket"] as const) {
      const agent = encodeQueryAgentKey({ resourceProvider, ruleId: "triage" });
      expect(callerIdentity({ "x-butchr-agent": agent })).toEqual({ provider: resourceProvider, agent, ruleId: "triage", query: true });
      expect(callerIdentity({ "x-issue": "BUTCHR-1", "x-butchr-agent": agent })).toBeNull();
    }
  });

  test("no headers at all is null; x-issue alone is a legacy/plain jira-work caller", () => {
    expect(callerIdentity({})).toBeNull();
    expect(callerIdentity({ "x-issue": "BUTCHR-1" })).toEqual({ provider: "jira-work", issue: "BUTCHR-1" });
  });
});
