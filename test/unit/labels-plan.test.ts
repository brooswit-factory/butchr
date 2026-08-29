import { describe, expect, test } from "bun:test";
import { desiredLabels, diffLabels, isDaemonLabel } from "../../src/labels/plan.js";

describe("isDaemonLabel", () => {
  test("only agent: and pr: prefixed labels are daemon-owned", () => {
    expect(isDaemonLabel("agent:working")).toBe(true);
    expect(isDaemonLabel("pr:open")).toBe(true);
    expect(isDaemonLabel("needs-design")).toBe(false);
    expect(isDaemonLabel("urgent")).toBe(false);
  });
});

describe("desiredLabels", () => {
  test("active ticket, no agent running -> agent:none", () => {
    expect(desiredLabels({ status: "In Progress", agentStatus: null, prState: null })).toEqual(["agent:none"]);
  });
  test("idle and blocked map directly; any other non-empty status is working", () => {
    expect(desiredLabels({ status: "In Progress", agentStatus: "idle", prState: null })).toEqual(["agent:idle"]);
    expect(desiredLabels({ status: "In Review", agentStatus: "blocked", prState: null })).toEqual(["agent:blocked"]);
    expect(desiredLabels({ status: "In Progress", agentStatus: "working", prState: null })).toEqual(["agent:working"]);
    expect(desiredLabels({ status: "In Progress", agentStatus: "done", prState: null })).toEqual(["agent:working"]);
    expect(desiredLabels({ status: "In Progress", agentStatus: "unknown", prState: null })).toEqual(["agent:working"]);
  });
  test("inactive status carries no agent:* label, regardless of agentStatus", () => {
    expect(desiredLabels({ status: "Done", agentStatus: "working", prState: null })).toEqual([]);
    expect(desiredLabels({ status: "To Do", agentStatus: null, prState: null })).toEqual([]);
  });
  test("pr state adds pr:*, independent of active status", () => {
    expect(desiredLabels({ status: "In Progress", agentStatus: "idle", prState: "open" })).toEqual(["agent:idle", "pr:open"]);
    expect(desiredLabels({ status: "Done", agentStatus: null, prState: "merged" })).toEqual(["pr:merged"]);
  });
});

describe("diffLabels", () => {
  test("adds missing desired labels, removes daemon labels no longer desired, ignores human labels", () => {
    const diff = diffLabels(["agent:blocked"], ["agent:working", "urgent", "needs-design"]);
    expect(diff.add.sort()).toEqual(["agent:blocked"]);
    expect(diff.remove.sort()).toEqual(["agent:working"]);
  });
  test("human labels are never in add or remove, and are not counted against equality", () => {
    const diff = diffLabels(["agent:idle", "pr:open"], ["agent:idle", "pr:open", "urgent", "customer-x"]);
    expect(diff.add).toEqual([]);
    expect(diff.remove).toEqual([]);
  });
  test("identical daemon label state diffs to empty (idempotent, zero writes)", () => {
    expect(diffLabels(["agent:working"], ["agent:working"])).toEqual({ add: [], remove: [] });
    expect(diffLabels([], [])).toEqual({ add: [], remove: [] });
  });
  test("leaving active status: agent:* fully removed", () => {
    expect(diffLabels([], ["agent:working", "pr:approved"])).toEqual({ add: [], remove: ["agent:working", "pr:approved"] });
  });
});
