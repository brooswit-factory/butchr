import { describe, expect, test } from "bun:test";
import { configInventoryEntryCount } from "../../dashboard-app/src/view-model/config-inventory-availability.js";
import type { QueryAgentInventory, RuleInventoryEntry, SessionDefinitionInventoryEntry } from "../../src/agents/query-agent-inventory.js";

const rule: RuleInventoryEntry = {
  kind: "rule",
  id: "r1",
  resourceProvider: "jira-work",
  query: "project = FOO",
  enabled: true,
  execution: "swarm",
  account: "none",
  role: "worker",
  agentPreferences: [],
  linkedEventing: false,
  mcpServerNames: [],
  staffed: true,
  reason: null,
};

const sessionDef: SessionDefinitionInventoryEntry = {
  kind: "session-definition",
  name: "foo.json",
  path: "/sessions/foo.json",
  valid: true,
  problems: [],
  archived: false,
};

describe("configInventoryEntryCount (pure) — FACTORY-614", () => {
  test("KNOWN zero for an empty inventory — no polled payload to count means a fetch failure, which is this adapter's caller's concern, not an unknowable count", () => {
    const inventory: QueryAgentInventory = { rules: [], sessionDefinitions: [], errors: [] };
    expect(configInventoryEntryCount(inventory)).toEqual({ kind: "known", value: 0 });
  });

  test("KNOWN count sums rules AND session definitions, never just one of the two", () => {
    const inventory: QueryAgentInventory = { rules: [rule, rule], sessionDefinitions: [sessionDef], errors: [] };
    expect(configInventoryEntryCount(inventory)).toEqual({ kind: "known", value: 3 });
  });

  test("a file-level error does not change the count by itself — errors is independent of rules/sessionDefinitions (see QueryAgentInventory's own doc comment)", () => {
    const inventory: QueryAgentInventory = { rules: [rule], sessionDefinitions: [], errors: [{ path: "/bad.json", message: "parse error" }] };
    expect(configInventoryEntryCount(inventory)).toEqual({ kind: "known", value: 1 });
  });
});
