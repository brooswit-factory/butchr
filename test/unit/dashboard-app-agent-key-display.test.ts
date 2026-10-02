import { describe, expect, test } from "bun:test";
import { decodeAnyAgentKey as decodeDisplay } from "../../dashboard-app/src/view-model/agent-key-display.js";
import { decodeAnyAgentKey as decodeReal, encodeAgentKey, encodeQueryAgentKey, RESOURCE_PROVIDERS } from "../../src/rules/agent-key.js";

const SAMPLE_RESOURCE_IDS: Record<(typeof RESOURCE_PROVIDERS)[number], string> = {
  "jira-work": "FACTORY-68",
  "github-issue": "owner/repo#12",
  "github-pr": "owner/repo#34",
  "jira-idea": "IDEA-1",
  "zendesk-ticket": "subdomain#9",
  "jira-project": "FACTORY",
  filesystem: "/abs/path",
};

describe("dashboard-app/view-model/agent-key-display: parity with the real src/rules/agent-key.ts decodeAnyAgentKey (drift guard)", () => {
  for (const provider of RESOURCE_PROVIDERS) {
    test(`a real ${provider} agent key decodes identically`, () => {
      const key = encodeAgentKey({ resourceProvider: provider, ruleId: "rule1", resourceId: SAMPLE_RESOURCE_IDS[provider] });
      expect(decodeDisplay(key)).toEqual(decodeReal(key));
    });
    test(`a real ${provider} query-level agent key decodes identically`, () => {
      const key = encodeQueryAgentKey({ resourceProvider: provider, ruleId: "singleton-rule" });
      expect(decodeDisplay(key)).toEqual(decodeReal(key));
    });
  }

  test("an unrecognized provider segment decodes to null on both", () => {
    const key = "not-a-real-provider:rule1:FACTORY-68";
    expect(decodeDisplay(key)).toBeNull();
    expect(decodeReal(key)).toBeNull();
  });

  test("a key with the wrong number of segments decodes to null on both", () => {
    expect(decodeDisplay("jira-work:rule1")).toBeNull();
    expect(decodeReal("jira-work:rule1")).toBeNull();
  });

  test("an unparseable percent-encoding decodes to null on both, never throws", () => {
    const key = "jira-work:rule1:%";
    expect(decodeDisplay(key)).toBeNull();
    expect(decodeReal(key)).toBeNull();
  });
});
