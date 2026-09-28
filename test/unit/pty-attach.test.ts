import { describe, expect, test } from "bun:test";
import { resolvePtyPane, isPaneStillLive, ptyAttachRefusalMessage } from "../../src/terminal/pty-attach.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import type { AgentDashboardRow, WithheldDashboardRow } from "../../src/agents/dashboard.js";

const floor = { sinceMs: 0, since: new Date(0).toISOString(), humanDuration: "0m", exact: true };

function agentRow(ruleId: string, resourceId: string, pane: string): AgentDashboardRow {
  return {
    kind: "agent",
    resourceKey: encodeAgentKey({ resourceProvider: "jira-work", ruleId, resourceId }),
    tier: { kind: "issue", issuetype: { checked: true, value: "Task" } },
    agentStatus: "working",
    pane,
    timeInStatus: floor,
    confirmedAt: new Date(0).toISOString(),
  };
}

function withheldRow(ruleId: string, resourceId: string): WithheldDashboardRow {
  return {
    kind: "withheld",
    resourceKey: encodeAgentKey({ resourceProvider: "jira-work", ruleId, resourceId }),
    tier: { kind: "issue", issuetype: { checked: true, value: "Task" } },
    source: "issue",
    waiting: floor,
    confirmedAt: new Date(0).toISOString(),
    agentFields: { applicable: false, reason: "no agent: withheld by the admission cap" },
  };
}

describe("resolvePtyPane", () => {
  test("malformed key is refused before anything else is asked", () => {
    const r = resolvePtyPane("not-a-real-key", []);
    expect(r).toEqual({ ok: false, refusal: { reason: "malformed-key", key: "not-a-real-key" } });
  });

  test("a well-formed key naming no row at all is refused as unknown-pane", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-1" });
    const r = resolvePtyPane(key, []);
    expect(r).toEqual({ ok: false, refusal: { reason: "unknown-pane", agentKey: key } });
  });

  test("a well-formed key naming a WITHHELD (not-live) row is refused as unknown-pane, not resolved to a pane", () => {
    const row = withheldRow("triage", "BUTCHR-1");
    const r = resolvePtyPane(row.resourceKey, [row]);
    expect(r).toEqual({ ok: false, refusal: { reason: "unknown-pane", agentKey: row.resourceKey } });
  });

  test("a live agent row resolves to its pane", () => {
    const row = agentRow("triage", "BUTCHR-1", "pane-42");
    const r = resolvePtyPane(row.resourceKey, [row]);
    expect(r).toEqual({ ok: true, pane: "pane-42" });
  });

  test("a query-level key (decodes, but is not a per-resource key) matches no per-resource row and is refused as unknown-pane", () => {
    const row = agentRow("triage", "BUTCHR-1", "pane-42");
    // %40query is a valid-decoding, distinct key shape — see agent-key.ts's QUERY_AGENT_MARKER.
    const queryKey = "jira-work:triage:%40query";
    const r = resolvePtyPane(queryKey, [row]);
    expect(r.ok).toBe(false);
  });
});

describe("ptyAttachRefusalMessage", () => {
  test("unknown-pane reuses terminal/open.ts's exact refusal wording, keyed by the agent key", () => {
    const msg = ptyAttachRefusalMessage({ reason: "unknown-pane", agentKey: "jira-work:triage:BUTCHR-1" });
    expect(msg).toBe("no such live pane: jira-work:triage:BUTCHR-1 (not one of this daemon's own running agents)");
  });
  test("malformed-key names the offending key", () => {
    expect(ptyAttachRefusalMessage({ reason: "malformed-key", key: "garbage" })).toContain("garbage");
  });
});

describe("isPaneStillLive", () => {
  test("true only when the SAME key still names an AGENT row with the SAME pane", () => {
    const row = agentRow("triage", "BUTCHR-1", "pane-42");
    expect(isPaneStillLive(row.resourceKey, "pane-42", [row])).toBe(true);
  });
  test("false once the row is gone", () => {
    const row = agentRow("triage", "BUTCHR-1", "pane-42");
    expect(isPaneStillLive(row.resourceKey, "pane-42", [])).toBe(false);
  });
  test("false once the row is withheld (no longer an agent row)", () => {
    const row = withheldRow("triage", "BUTCHR-1");
    expect(isPaneStillLive(row.resourceKey, "pane-42", [row])).toBe(false);
  });
  test("false when the pane was replaced (a respawned agent under the same key, different pane)", () => {
    const row = agentRow("triage", "BUTCHR-1", "pane-99");
    expect(isPaneStillLive(row.resourceKey, "pane-42", [row])).toBe(false);
  });
});
