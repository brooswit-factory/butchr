import { describe, expect, test } from "bun:test";
import { agentRowAnchorId as realAgentRowAnchorId, configAnchorForResourceKey as realConfigAnchorForResourceKey } from "../../src/agents/config-inventory-links.js";
import { MANAGED_SESSIONS_RULE_ID } from "../../src/rules/session-definition-type.js";
import { agentRowAnchorId, configAnchorForResourceKey } from "../../dashboard-app/src/view-model/config-links.js";
import { encodeAgentKey, encodeQueryAgentKey, RESOURCE_PROVIDERS } from "../../src/rules/agent-key.js";

const SAMPLE_RESOURCE_IDS: Record<(typeof RESOURCE_PROVIDERS)[number], string> = {
  "jira-work": "FACTORY-68",
  "github-issue": "owner/repo#12",
  "github-pr": "owner/repo#34",
  "jira-idea": "IDEA-1",
  "zendesk-ticket": "subdomain#9",
  "jira-project": "FACTORY",
  filesystem: "/abs/path",
};

describe("dashboard-app/view-model/config-links: parity with the real src/agents/config-inventory-links.ts (drift guard)", () => {
  for (const provider of RESOURCE_PROVIDERS) {
    test(`agentRowAnchorId matches for a ${provider} agent key`, () => {
      const key = encodeAgentKey({ resourceProvider: provider, ruleId: "rule1", resourceId: SAMPLE_RESOURCE_IDS[provider] });
      expect(agentRowAnchorId(key)).toBe(realAgentRowAnchorId(key));
    });
    test(`configAnchorForResourceKey matches for a ${provider} agent key`, () => {
      const key = encodeAgentKey({ resourceProvider: provider, ruleId: "rule1", resourceId: SAMPLE_RESOURCE_IDS[provider] });
      expect(configAnchorForResourceKey(key)).toBe(realConfigAnchorForResourceKey(key));
    });
    test(`configAnchorForResourceKey matches for a ${provider} query-level agent key`, () => {
      const key = encodeQueryAgentKey({ resourceProvider: provider, ruleId: "singleton-rule" });
      expect(configAnchorForResourceKey(key)).toBe(realConfigAnchorForResourceKey(key));
    });
  }

  test("the reserved managed-sessions rule id takes the session-anchor branch on both — real sentinel value, not a guessed copy", () => {
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: MANAGED_SESSIONS_RULE_ID, resourceId: "/abs/some/path" });
    expect(configAnchorForResourceKey(key)).toBe(realConfigAnchorForResourceKey(key));
    expect(configAnchorForResourceKey(key)).toMatch(/^session-/);
  });

  test("an undecodable key yields null on both", () => {
    expect(configAnchorForResourceKey("not-a-real-key")).toBeNull();
    expect(realConfigAnchorForResourceKey("not-a-real-key")).toBeNull();
  });
});
