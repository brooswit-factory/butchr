import { describe, expect, test } from "bun:test";
import { ALL_AGENT_LABEL_KEYS, canHavePr, desiredLabels, diffLabels, isDaemonLabel, type AgentLabel } from "../../src/labels/plan.js";

describe("canHavePr", () => {
  test("epics never have a branch, so they can never have a PR (case-insensitive)", () => {
    expect(canHavePr("Epic")).toBe(false);
    expect(canHavePr("epic")).toBe(false);
    expect(canHavePr("EPIC")).toBe(false);
  });
  test("every other issue type, including unknown/empty, can have a PR (conservative default: keeps today's behaviour)", () => {
    expect(canHavePr("Story")).toBe(true);
    expect(canHavePr("Task")).toBe(true);
    expect(canHavePr("Bug")).toBe(true);
    expect(canHavePr("SomeFutureType")).toBe(true);
    expect(canHavePr("")).toBe(true);
  });
});

describe("isDaemonLabel", () => {
  test("only agent: and pr: prefixed labels are daemon-owned", () => {
    expect(isDaemonLabel("agent:working")).toBe(true);
    expect(isDaemonLabel("pr:open")).toBe(true);
    expect(isDaemonLabel("needs-design")).toBe(false);
    expect(isDaemonLabel("urgent")).toBe(false);
  });

  // BUTCHR-24: butchr:shelved is a settable-by-any-actor exemption the
  // daemon only ever reads — pinned so nobody later folds it into
  // isDaemonLabel and has sweepStaleAgentLabels (src/labels/sweep.ts)
  // silently strip it.
  test("butchr:shelved is NOT daemon-owned — read-only exemption label", () => {
    expect(isDaemonLabel("butchr:shelved")).toBe(false);
  });
});

describe("desiredLabels", () => {
  test("active ticket, no agent running -> agent:none", () => {
    expect(desiredLabels({ status: "In Progress", agentStatus: null, prState: null })).toEqual(["agent:none"]);
  });
  test("idle and blocked map directly; done is idle (an agent sitting at its prompt); unknown is working", () => {
    expect(desiredLabels({ status: "In Progress", agentStatus: "idle", prState: null })).toEqual(["agent:idle"]);
    expect(desiredLabels({ status: "In Review", agentStatus: "blocked", prState: null })).toEqual(["agent:blocked"]);
    expect(desiredLabels({ status: "In Progress", agentStatus: "working", prState: null })).toEqual(["agent:working"]);
    expect(desiredLabels({ status: "In Progress", agentStatus: "done", prState: null })).toEqual(["agent:idle"]);
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
  test("pr:changes-requested is emitted like any other pr state (KAN-819/823)", () => {
    expect(desiredLabels({ status: "In Progress", agentStatus: "working", prState: "changes-requested" })).toEqual(["agent:working", "pr:changes-requested"]);
  });
  test("stalled takes precedence over idle (KAN-804/807): exactly one agent:* label, never both", () => {
    expect(desiredLabels({ status: "In Progress", agentStatus: "idle", prState: null, stalled: true })).toEqual(["agent:stalled"]);
    expect(desiredLabels({ status: "In Progress", agentStatus: "done", prState: null, stalled: true })).toEqual(["agent:stalled"]); // done maps to idle first
  });
  test("stalled is ignored (never applied) unless the mapped label is idle", () => {
    expect(desiredLabels({ status: "In Progress", agentStatus: "working", prState: null, stalled: true })).toEqual(["agent:working"]);
    expect(desiredLabels({ status: "In Progress", agentStatus: "blocked", prState: null, stalled: true })).toEqual(["agent:blocked"]);
    expect(desiredLabels({ status: "In Progress", agentStatus: null, prState: null, stalled: true })).toEqual(["agent:none"]);
  });
  test("stalled false/omitted never changes idle's output", () => {
    expect(desiredLabels({ status: "In Progress", agentStatus: "idle", prState: null, stalled: false })).toEqual(["agent:idle"]);
    expect(desiredLabels({ status: "In Progress", agentStatus: "idle", prState: null })).toEqual(["agent:idle"]);
  });

  // KAN-832/837 case 8: "unknown" re-emits whatever pr:* label the ticket already carries,
  // instead of reading as "no PR" and having diffLabels strip it.
  describe("prState: \"unknown\" (KAN-832/837)", () => {
    test("re-emits the ticket's existing pr:* label", () => {
      expect(desiredLabels({ status: "In Progress", agentStatus: "working", prState: "unknown", currentLabels: ["pr:approved", "agent:working"] })).toEqual(["agent:working", "pr:approved"]);
    });
    test("with no currentLabels pr:* entry, emits no pr:* label — nothing to preserve", () => {
      expect(desiredLabels({ status: "In Progress", agentStatus: "working", prState: "unknown", currentLabels: [] })).toEqual(["agent:working"]);
      expect(desiredLabels({ status: "In Progress", agentStatus: "working", prState: "unknown" })).toEqual(["agent:working"]);
    });
    test("a genuine null prState (confirmed no PR) does NOT preserve an existing pr:* label — the guard against KAN-814-style stickiness", () => {
      expect(desiredLabels({ status: "In Progress", agentStatus: "working", prState: null, currentLabels: ["pr:approved", "agent:working"] })).toEqual(["agent:working"]);
    });
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
  test("a human label that ends up in `desired` (a caller bug) is still never added — both sides are filtered", () => {
    const diff = diffLabels(["needs-design", "pr:approved"], ["agent:idle", "pr:approved"]);
    expect(diff.add).toEqual([]); // "needs-design" is not daemon-owned, so it's dropped, not added
    expect(diff.remove).toEqual(["agent:idle"]);
  });
});

// BUTCHR-144/BUTCHR-155: the startup sweep's SWEEP_JQL (src/labels/sweep.ts)
// used to select on a hand-written `labels IN (...)` list that never included
// "agent:stalled" — a ticket carrying it was never revisited once inactive,
// so it kept the stale label indefinitely. ALL_AGENT_LABEL_KEYS is the
// value-level anchor that fix derives from; see src/labels/plan.ts's header
// on ALL_AGENT_LABELS for the full argument.
describe("ALL_AGENT_LABEL_KEYS (BUTCHR-144/BUTCHR-155: the sweep's selection is derived from AgentLabel, not hand-maintained)", () => {
  // 5 members today (BUTCHR-144's own union count) — update this list
  // deliberately, alongside AgentLabel in ./plan.ts, not by reflex.
  test("contains exactly one agent:-prefixed key per AgentLabel member, nothing else", () => {
    expect([...ALL_AGENT_LABEL_KEYS].sort()).toEqual(["agent:blocked", "agent:idle", "agent:none", "agent:stalled", "agent:working"]);
  });

  // THE FALSIFIER for this test and the one above it in src/labels/sweep.ts's
  // "SWEEP_JQL's labels IN (...) clause" describe block: this test would
  // still PASS while BUTCHR-144's bug is present if TypeScript allowed a
  // `Record<AgentLabel, true>` literal to omit a key — it does not. Omitting
  // any one of the five keys below is a compile error ("Property '<name>' is
  // missing"), enforced by `bun run typecheck` on every PR, the same door
  // src/labels/registry.ts's LABEL_REGISTRY uses (see its own
  // "@ts-expect-error" tests further down this describe block's sibling file,
  // test/unit/labels-registry.test.ts). This is the mechanism that forces
  // ALL_AGENT_LABEL_KEYS above — and therefore SWEEP_JQL's selection in
  // src/labels/sweep.ts — to grow the moment AgentLabel grows, at the
  // developer's desk, before review, rather than at review time or never.
  test("omitting a member from a Record<AgentLabel, true> does not compile", () => {
    // @ts-expect-error — Record<AgentLabel, true> requires all five keys; "stalled" is missing here.
    const incomplete: Record<AgentLabel, true> = { working: true, idle: true, blocked: true, none: true };
    expect(incomplete).toBeDefined();
  });
});
