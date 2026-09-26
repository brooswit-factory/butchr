import { describe, expect, test } from "bun:test";
import {
  agentRowAnchorId, agentRowsForRule, agentRowsForSessionDefinition,
  configAnchorForResourceKey, ruleAnchorId, sessionAnchorId,
} from "../../src/agents/config-inventory-links.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";
import { sessionAgentKey } from "../../src/resources/session-freeze.js";
import type { AgentDashboardRow, DashboardRow, WithheldDashboardRow } from "../../src/agents/dashboard.js";

const floor = { sinceMs: 0, since: new Date(0).toISOString(), humanDuration: "0s", exact: true };
function agentRow(resourceKey: string): AgentDashboardRow {
  return { kind: "agent", resourceKey, tier: { kind: "project" }, agentStatus: "working", pane: "p1", timeInStatus: floor, confirmedAt: new Date(0).toISOString() };
}
function withheldRow(resourceKey: string, source = "issue"): WithheldDashboardRow {
  return { kind: "withheld", resourceKey, tier: { kind: "project" }, source, waiting: floor, confirmedAt: new Date(0).toISOString(), agentFields: { applicable: false, reason: "no agent: withheld by the admission cap" } };
}

describe("agentRowsForRule (FACTORY-81) — a rule matches a LIVE row iff decodeAnyAgentKey gives the same (resourceProvider, ruleId)", () => {
  test("an ordinary per-resource swarm match", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    const rows: DashboardRow[] = [agentRow(key)];
    expect(agentRowsForRule({ id: "task", resourceProvider: "jira-work" }, rows)).toEqual([agentRow(key)]);
  });

  test("a singleton/persistent rule's one query-level agent also matches", () => {
    const key = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "director" });
    const rows: DashboardRow[] = [agentRow(key)];
    expect(agentRowsForRule({ id: "director", resourceProvider: "filesystem" }, rows)).toEqual([agentRow(key)]);
  });

  test("a different rule id on the SAME provider does not match", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    expect(agentRowsForRule({ id: "other-rule", resourceProvider: "jira-work" }, [agentRow(key)])).toEqual([]);
  });

  test("the same rule id on a DIFFERENT provider does not match — both halves of the correlation key are required", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    expect(agentRowsForRule({ id: "task", resourceProvider: "github-issue" }, [agentRow(key)])).toEqual([]);
  });

  test("a withheld row never matches — only LIVE rows are 'running agent rows'", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    expect(agentRowsForRule({ id: "task", resourceProvider: "jira-work" }, [withheldRow(key)])).toEqual([]);
  });

  test("a resourceKey that fails to decode entirely is silently skipped, never thrown", () => {
    expect(agentRowsForRule({ id: "task", resourceProvider: "jira-work" }, [agentRow("not-a-real-key")])).toEqual([]);
  });

  test("multiple matching resources for one swarm rule all come back", () => {
    const a = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    const b = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-2" });
    expect(agentRowsForRule({ id: "task", resourceProvider: "jira-work" }, [agentRow(a), agentRow(b)]).map((r) => r.resourceKey)).toEqual([a, b]);
  });
});

describe("agentRowsForSessionDefinition (FACTORY-81) — a session definition matches a LIVE row iff resourceKey === its own agentKey, EXACTLY", () => {
  test("an exact agentKey match", () => {
    const agentKey = sessionAgentKey("/home/butchr/defs/foo.json");
    const rows: DashboardRow[] = [agentRow(agentKey)];
    expect(agentRowsForSessionDefinition({ agentKey }, rows)).toEqual([agentRow(agentKey)]);
  });

  test("a DIFFERENT session definition's row does not match, even though both are filesystem/managed-sessions keys", () => {
    const mine = sessionAgentKey("/home/butchr/defs/foo.json");
    const other = sessionAgentKey("/home/butchr/defs/bar.json");
    expect(agentRowsForSessionDefinition({ agentKey: mine }, [agentRow(other)])).toEqual([]);
  });

  test("an entry with no agentKey (the oversized-path case) matches nothing, ever", () => {
    expect(agentRowsForSessionDefinition({}, [agentRow(sessionAgentKey("/home/butchr/defs/foo.json"))])).toEqual([]);
  });

  test("an ordinary (non-managed-session) filesystem rule's agent row never matches a session definition — exact key equality, not provider/ruleId decoding", () => {
    const ruleKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "watch-repo", resourceId: "/home/butchr/defs/foo.json" });
    const agentKey = sessionAgentKey("/home/butchr/defs/foo.json");
    expect(agentKey).not.toBe(ruleKey); // sanity: same resourceId, different ruleId, so genuinely different keys
    expect(agentRowsForSessionDefinition({ agentKey }, [agentRow(ruleKey)])).toEqual([]);
  });
});

describe("configAnchorForResourceKey (FACTORY-81) — the back-link target, computed WITHOUT the inventory in hand", () => {
  test("an ordinary rule-driven row anchors to that rule's own anchor id", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    expect(configAnchorForResourceKey(key)).toBe(ruleAnchorId("jira-work", "task"));
  });

  test("a query-level agent's row anchors to the same rule anchor id as a per-resource row would", () => {
    const key = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "director" });
    expect(configAnchorForResourceKey(key)).toBe(ruleAnchorId("filesystem", "director"));
  });

  test("a managed-session row (filesystem provider, the reserved managed-sessions rule id) anchors to ITS OWN session anchor, keyed on the whole resourceKey — never the generic rule anchor", () => {
    const agentKey = sessionAgentKey("/home/butchr/defs/foo.json");
    expect(configAnchorForResourceKey(agentKey)).toBe(sessionAnchorId(agentKey));
    expect(configAnchorForResourceKey(agentKey)).not.toBe(ruleAnchorId("filesystem", "managed-sessions"));
  });

  test("two DIFFERENT managed sessions get two DIFFERENT anchors — the whole point of keying on the full resourceKey rather than (provider, ruleId)", () => {
    const a = sessionAgentKey("/home/butchr/defs/foo.json");
    const b = sessionAgentKey("/home/butchr/defs/bar.json");
    expect(configAnchorForResourceKey(a)).not.toBe(configAnchorForResourceKey(b));
  });

  test("a resourceKey that fails to decode entirely yields null — nothing to link to", () => {
    expect(configAnchorForResourceKey("not-a-real-key")).toBeNull();
  });
});

describe("anchor ids (FACTORY-81) — stable, distinct, and safe as both an HTML id and a URL fragment", () => {
  test("agentRowAnchorId is distinct for distinct resource keys, and does not contain characters that would break an id or fragment", () => {
    const a = agentRowAnchorId("jira-work:task:BUTCHR-1");
    const b = agentRowAnchorId("jira-work:task:BUTCHR-2");
    expect(a).not.toBe(b);
    for (const s of [a, b]) expect(s).toMatch(/^agent-[A-Za-z0-9._%-]+$/);
  });

  test("ruleAnchorId and sessionAnchorId never collide with each other's prefix", () => {
    expect(ruleAnchorId("filesystem", "managed-sessions")).not.toBe(sessionAnchorId("filesystem:managed-sessions:%2Ffoo"));
  });
});
