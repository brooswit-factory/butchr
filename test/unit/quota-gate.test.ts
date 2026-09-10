import { describe, expect, test } from "bun:test";
import { createQuotaGate } from "../../src/agents/quota-gate.js";
import type { AgentRow } from "../../src/agents/session-limit-watch.js";

const REFUSAL = "You've hit your session limit · resets 9:50pm";

describe("createQuotaGate", () => {
  test("isBlocked is false for an issue never observed", () => {
    const gate = createQuotaGate(async () => [], async () => "", () => 0);
    expect(gate.isBlocked("KAN-1")).toBe(false);
  });

  test("isBlocked flips true after a read tees a refusal for that issue's pane, without a second read", async () => {
    const rows: AgentRow[] = [{ pane_id: "kan-1:p1", agent_status: "idle", issue: "KAN-1" }];
    let reads = 0;
    const gate = createQuotaGate(
      async () => rows,
      async () => { reads++; return REFUSAL; },
      () => new Date(2026, 7, 28, 18, 59, 0).getTime(),
    );
    await gate.list();
    expect(gate.isBlocked("KAN-1")).toBe(false); // list() alone never reads a pane
    const text = await gate.read("kan-1:p1");
    expect(text).toBe(REFUSAL); // passthrough — the underlying read's return value is unchanged
    expect(reads).toBe(1); // exactly the one read watchSessionLimits itself would have made
    expect(gate.isBlocked("KAN-1")).toBe(true);
  });

  test("isBlocked flips back false once a later read for the same pane clears", async () => {
    const rows: AgentRow[] = [{ pane_id: "kan-1:p1", agent_status: "idle", issue: "KAN-1" }];
    let text = REFUSAL;
    const gate = createQuotaGate(async () => rows, async () => text, () => new Date(2026, 7, 28, 18, 59, 0).getTime());
    await gate.list();
    await gate.read("kan-1:p1");
    expect(gate.isBlocked("KAN-1")).toBe(true);
    text = "ordinary idle pane, no refusal";
    await gate.read("kan-1:p1");
    expect(gate.isBlocked("KAN-1")).toBe(false);
  });

  test("a read for a pane_id absent from the last list() is ignored — never guesses an issue", async () => {
    const gate = createQuotaGate(async () => [], async () => REFUSAL, () => 0);
    await gate.list();
    await gate.read("unknown:p1");
    expect(gate.isBlocked("KAN-1")).toBe(false);
  });

  test("a row with issue: null (a foreign pane) is never recorded as blocked for anything", async () => {
    const rows: AgentRow[] = [{ pane_id: "foreign:p1", agent_status: "idle", issue: null }];
    const gate = createQuotaGate(async () => rows, async () => REFUSAL, () => 0);
    await gate.list();
    await gate.read("foreign:p1");
    expect(gate.isBlocked("KAN-1")).toBe(false);
  });

  test("distinct issues are tracked independently", async () => {
    const rows: AgentRow[] = [
      { pane_id: "kan-1:p1", agent_status: "idle", issue: "KAN-1" },
      { pane_id: "kan-2:p1", agent_status: "idle", issue: "KAN-2" },
    ];
    const gate = createQuotaGate(async () => rows, async (p) => (p === "kan-1:p1" ? REFUSAL : "fine"), () => new Date(2026, 7, 28, 18, 59, 0).getTime());
    await gate.list();
    await gate.read("kan-1:p1");
    await gate.read("kan-2:p1");
    expect(gate.isBlocked("KAN-1")).toBe(true);
    expect(gate.isBlocked("KAN-2")).toBe(false);
  });
});
