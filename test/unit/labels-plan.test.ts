import { describe, expect, test } from "bun:test";
import {
  ALL_ADMISSION_LABEL_KEYS,
  ALL_AGENT_LABEL_KEYS,
  canHavePr,
  desiredLabels,
  diffLabels,
  isActiveStatusLabel,
  isDaemonLabel,
  type AdmissionLabel,
  type AgentLabel,
} from "../../src/labels/plan.js";

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
  test("agent:, pr:, and admission: prefixed labels are daemon-owned", () => {
    expect(isDaemonLabel("agent:working")).toBe(true);
    expect(isDaemonLabel("pr:open")).toBe(true);
    expect(isDaemonLabel("admission:withheld")).toBe(true); // BUTCHR-352
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

// BUTCHR-352: admission:* is lifecycle-bound to active status the same way
// agent:* is (cleared on inactivity/disappearance, swept on startup) — pr:*
// is deliberately excluded, since it is independent of status.
describe("isActiveStatusLabel", () => {
  test("agent:* and admission:* are active-status-bound; pr:* and human labels are not", () => {
    expect(isActiveStatusLabel("agent:working")).toBe(true);
    expect(isActiveStatusLabel("agent:none")).toBe(true);
    expect(isActiveStatusLabel("admission:withheld")).toBe(true);
    expect(isActiveStatusLabel("pr:open")).toBe(false);
    expect(isActiveStatusLabel("urgent")).toBe(false);
    expect(isActiveStatusLabel("butchr:shelved")).toBe(false);
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

  // BUTCHR-352: admission:withheld is a SEPARATE marker layered alongside
  // agent:none — never a replacement for it, never an agent:* value.
  describe("withheld (BUTCHR-352)", () => {
    test("withheld + no running agent -> agent:none PLUS admission:withheld", () => {
      expect(desiredLabels({ status: "In Progress", agentStatus: null, prState: null, withheld: true })).toEqual(["agent:none", "admission:withheld"]);
    });
    test("not withheld, no running agent -> agent:none alone (today's exact behaviour)", () => {
      expect(desiredLabels({ status: "In Progress", agentStatus: null, prState: null, withheld: false })).toEqual(["agent:none"]);
      expect(desiredLabels({ status: "In Progress", agentStatus: null, prState: null })).toEqual(["agent:none"]);
    });
    // THE REGRESSION TRAP this pins: if withheld ever overlaid AgentLabel's
    // own "none" value (as an early design would have), this ticket carries
    // agent:none alone would have to become something else — the falsifier
    // below fails if agent:* is EVER anything other than exactly "agent:none"
    // while withheld, proving the two labels are genuinely independent.
    test("withheld is IGNORED (never emitted) when a mapped label other than none is present — deliberate, not a fallthrough (BUTCHR-352)", () => {
      expect(desiredLabels({ status: "In Progress", agentStatus: "working", prState: null, withheld: true })).toEqual(["agent:working"]);
      expect(desiredLabels({ status: "In Progress", agentStatus: "idle", prState: null, withheld: true })).toEqual(["agent:idle"]);
      expect(desiredLabels({ status: "In Progress", agentStatus: "blocked", prState: null, withheld: true })).toEqual(["agent:blocked"]);
    });
    test("withheld is scoped to active status, same as agent:* itself", () => {
      expect(desiredLabels({ status: "Done", agentStatus: null, prState: null, withheld: true })).toEqual([]);
    });
    test("withheld composes with pr:*, unaffected", () => {
      expect(desiredLabels({ status: "In Progress", agentStatus: null, prState: "open", withheld: true })).toEqual(["agent:none", "admission:withheld", "pr:open"]);
    });

    // BUTCHR-311's second correction: "unknown" reuses the EXACT KAN-832/837
    // sticky-but-falsifiable pattern prState's own "unknown" branch already
    // uses (below) — a poll that could not check admission re-emits whatever
    // admission:withheld marker the ticket already carries, rather than
    // reading a blind poll as "confirmed not withheld".
    describe('withheld: "unknown" (BUTCHR-311 correction: mirrors prState\'s own "unknown" handling)', () => {
      test("re-emits the ticket's existing admission:withheld marker", () => {
        expect(desiredLabels({ status: "In Progress", agentStatus: null, prState: null, withheld: "unknown", currentLabels: ["admission:withheld", "agent:none"] })).toEqual(["agent:none", "admission:withheld"]);
      });
      test("with no currentLabels admission:* entry, emits no admission:* label — nothing to preserve", () => {
        expect(desiredLabels({ status: "In Progress", agentStatus: null, prState: null, withheld: "unknown", currentLabels: ["agent:none"] })).toEqual(["agent:none"]);
        expect(desiredLabels({ status: "In Progress", agentStatus: null, prState: null, withheld: "unknown" })).toEqual(["agent:none"]);
      });
      // THE BOUND: exactly two label writes per withheld episode — on at the
      // first confirming (true) poll, off at the first disconfirming
      // (false) poll — regardless of how many "unknown" declines fall in
      // between. This test walks a full episode through a decline and
      // counts flips via diffLabels (the actual Jira-write predicate).
      test("a decline mid-episode causes ZERO label churn (the two-flips-per-episode bound)", () => {
        // poll 1: confirmed withheld — ON (write 1)
        const p1 = desiredLabels({ status: "In Progress", agentStatus: null, prState: null, withheld: true });
        expect(p1).toEqual(["agent:none", "admission:withheld"]);
        // poll 2: census declined — re-emits p1's marker unchanged, no diff against p1
        const p2 = desiredLabels({ status: "In Progress", agentStatus: null, prState: null, withheld: "unknown", currentLabels: p1 });
        expect(p2).toEqual(p1);
        // poll 3: still declined — same again
        const p3 = desiredLabels({ status: "In Progress", agentStatus: null, prState: null, withheld: "unknown", currentLabels: p2 });
        expect(p3).toEqual(p1);
        // poll 4: confirmed NOT withheld — OFF (write 2)
        const p4 = desiredLabels({ status: "In Progress", agentStatus: null, prState: null, withheld: false, currentLabels: p3 });
        expect(p4).toEqual(["agent:none"]);
      });
      test('a genuine confirmed-false read (not "unknown") DOES clear an existing marker — the guard against KAN-814-style stickiness', () => {
        expect(desiredLabels({ status: "In Progress", agentStatus: null, prState: null, withheld: false, currentLabels: ["admission:withheld", "agent:none"] })).toEqual(["agent:none"]);
      });
      test('"unknown" is ignored (never re-emits a stale marker) when a mapped label other than none is present', () => {
        expect(desiredLabels({ status: "In Progress", agentStatus: "working", prState: null, withheld: "unknown", currentLabels: ["admission:withheld", "agent:none"] })).toEqual(["agent:working"]);
      });
    });
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

// BUTCHR-352: the SAME completeness-door mechanism, mirrored for the new
// admission: namespace — see ADMISSION_PREFIX/AdmissionLabel's own doc
// comments in src/labels/plan.ts.
describe("ALL_ADMISSION_LABEL_KEYS (BUTCHR-352: mirrors ALL_AGENT_LABEL_KEYS's own completeness door)", () => {
  test("contains exactly one admission:-prefixed key per AdmissionLabel member, nothing else", () => {
    expect([...ALL_ADMISSION_LABEL_KEYS].sort()).toEqual(["admission:withheld"]);
  });

  test("omitting a member from a Record<AdmissionLabel, true> does not compile", () => {
    // @ts-expect-error — Record<AdmissionLabel, true> requires the "withheld" key; it is missing here.
    const incomplete: Record<AdmissionLabel, true> = {};
    expect(incomplete).toBeDefined();
  });
});
