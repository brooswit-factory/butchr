import { describe, expect, test } from "bun:test";
import { changeNudge, notifyReasonTag } from "../../src/agents/change-nudge.js";
import type { NotifyReason } from "../../src/resources/types.js";

/**
 * BUTCHR-87: `changeNudge` (the agent-facing nudge) and `notifyReasonTag`
 * (the operator-facing `[notify]` log tag) are exported specifically so a
 * test can assert against their RENDERED output, same precedent as
 * `prReviewStateNudge`/test/unit/merge-check-guard.test.ts — not a regex
 * over daemon source text. `pr` itself is NOT exercised here: it renders
 * through `prReviewStateNudge` instead (see src/daemon/index.ts's notify
 * callback), which merge-check-guard.test.ts already pins; this file covers
 * every OTHER NotifyReason member plus the no-reason fallback.
 */

describe("changeNudge", () => {
  test("self path (about === issue): fallback names that the poll looked and could not tell", () => {
    expect(changeNudge("KAN-1", "KAN-1", undefined)).toBe(
      "[butchr] Ticket KAN-1 was updated (reason not determinable from the poll) — re-read it.",
    );
  });

  test("related path (about !== issue): fallback carries the same distinguishable phrase, in the related sentence shape", () => {
    expect(changeNudge("KAN-1", "KAN-2", undefined)).toBe(
      "[butchr] KAN-2 (related to your KAN-1) was updated (reason not determinable from the poll) — re-read it, then act on what changed.",
    );
  });

  test("appeared", () => {
    expect(changeNudge("KAN-1", "KAN-1", { appeared: true })).toBe(
      "[butchr] Ticket KAN-1 just appeared in the watch set — re-read it.",
    );
  });

  test("disappeared, related path", () => {
    expect(changeNudge("KAN-1", "KAN-2", { disappeared: true })).toBe(
      "[butchr] KAN-2 (related to your KAN-1) just dropped out of the watch set — re-read it, then act on what changed.",
    );
  });

  test("status transition names both from and to", () => {
    const msg = changeNudge("KAN-1", "KAN-1", { status: { from: "In Progress", to: "In Review" } });
    expect(msg).toBe('[butchr] Ticket KAN-1 changed status from "In Progress" to "In Review" — re-read it.');
  });

  test("agent:* label transition names the namespace and both values", () => {
    const msg = changeNudge("KAN-1", "KAN-1", { label: { prefix: "agent", from: "working", to: "idle" } });
    expect(msg).toBe("[butchr] Ticket KAN-1 changed its agent:* label from agent:working to agent:idle — re-read it.");
  });

  test("pr:* label transition on the RELATED path (never wrapped in prReviewStateNudge — that would wrongly say 'your PR')", () => {
    const msg = changeNudge("KAN-1", "KAN-2", { label: { prefix: "pr", from: "open", to: "approved" } });
    expect(msg).toBe("[butchr] KAN-2 (related to your KAN-1) changed its pr:* label from pr:open to pr:approved — re-read it, then act on what changed.");
    expect(msg).not.toContain("your PR");
  });

  test("a label appearing from nothing (null from) renders 'none', not 'null'", () => {
    const msg = changeNudge("KAN-1", "KAN-1", { label: { prefix: "pr", from: null, to: "open" } });
    expect(msg).toContain("from pr:none to pr:open");
  });

  test("summary changed", () => {
    expect(changeNudge("KAN-1", "KAN-1", { summary: true })).toBe("[butchr] Ticket KAN-1 had its summary edited — re-read it.");
  });

  test("comment observed", () => {
    expect(changeNudge("KAN-1", "KAN-1", { comment: "c1" })).toBe("[butchr] Ticket KAN-1 got a new comment — re-read it.");
  });

  // BUTCHR-351: `comment: null` is the comment-DELETION edge (the ticket's
  // newest comment id moved because the comment list went to empty, not
  // because one was added) — "got a new comment" would be actively wrong.
  test("comment deleted (null) renders honestly, distinct from a new comment", () => {
    expect(changeNudge("KAN-1", "KAN-1", { comment: null })).toBe("[butchr] Ticket KAN-1 had a comment removed — re-read it.");
  });

  test("a pr reason passed through anyway (should never happen — pr renders via prReviewStateNudge) falls back honestly rather than mis-rendering", () => {
    const prReason = { pr: { from: "open", to: "approved" } } as unknown as NotifyReason;
    expect(changeNudge("KAN-1", "KAN-1", prReason)).toBe(
      "[butchr] Ticket KAN-1 was updated (reason not determinable from the poll) — re-read it.",
    );
  });

  // BUTCHR-350 (§3D): all three `undetermined` sub-reasons collapse to the
  // SAME agent-facing sentence as a bare `undefined` — the finer distinction
  // is operator-facing forensics (notifyReasonTag below), not something an
  // agent acting on its own ticket needs.
  test("undetermined (any sub-reason) falls back to the same honest sentence as no reason at all", () => {
    for (const undetermined of ["unchecked", "check-failed", "checked-unchanged"] as const) {
      expect(changeNudge("KAN-1", "KAN-1", { undetermined })).toBe(
        "[butchr] Ticket KAN-1 was updated (reason not determinable from the poll) — re-read it.",
      );
    }
  });
});

describe("notifyReasonTag", () => {
  test("no reason at all -> explicit 'not determinable', never a silent empty string", () => {
    expect(notifyReasonTag(undefined)).toBe(" (reason: not determinable)");
  });

  test("pr:* — unchanged rendering from before this ticket", () => {
    expect(notifyReasonTag({ pr: { from: "open", to: "approved" } })).toBe(" (pr:open→pr:approved)");
    expect(notifyReasonTag({ pr: { from: null, to: "open" } })).toBe(" (pr:none→pr:open)");
  });

  test("appeared / disappeared", () => {
    expect(notifyReasonTag({ appeared: true })).toBe(" (appeared)");
    expect(notifyReasonTag({ disappeared: true })).toBe(" (disappeared)");
  });

  test("status", () => {
    expect(notifyReasonTag({ status: { from: "To Do", to: "In Progress" } })).toBe(" (status:To Do→In Progress)");
  });

  test("label — agent:* and pr:*, including a null side rendered as 'none'", () => {
    expect(notifyReasonTag({ label: { prefix: "agent", from: "working", to: "idle" } })).toBe(" (agent:working→agent:idle)");
    expect(notifyReasonTag({ label: { prefix: "pr", from: null, to: "open" } })).toBe(" (pr:none→pr:open)");
  });

  test("summary", () => {
    expect(notifyReasonTag({ summary: true })).toBe(" (summary changed)");
  });

  // BUTCHR-350 (§3D): `comment` now carries the actual moved-to id, rendered
  // as `(comment:<id>)` — a SUPERSET of the old bare `(comment)` literal for
  // any `grep '(comment'` (prefix) reader; see notifyReasonTag's own doc
  // comment for why no separate tag is warranted for this additive change.
  test("comment carries the moved-to comment id", () => {
    expect(notifyReasonTag({ comment: "17072447" })).toBe(" (comment:17072447)");
  });

  // BUTCHR-351: `comment: null` (the comment-deletion edge — see
  // NotifyReason's own doc comment) renders the honest `comment:deleted`,
  // never the literal string "null" a bare template would produce, and
  // stays a `(comment:` PREFIX (a superset), so no distinct tag is needed —
  // same additive reasoning as the string-id case above.
  test("comment deleted (null) renders as 'comment:deleted', never the literal 'null'", () => {
    expect(notifyReasonTag({ comment: null })).toBe(" (comment:deleted)");
  });

  // BUTCHR-350 (§3D): the three `undetermined` sub-reasons render as three
  // DISTINCT, honest sentences — replacing the one collapsed "(reason: not
  // determinable)" that used to cover all three facts (the defect this
  // ticket's own §3(D) names). `reason: undefined` itself (a caller that
  // never populates it, e.g. the project tier) is UNCHANGED — pinned above.
  test("undetermined: three distinct, honest sub-reasons, none of them the bare undefined fallback text alone", () => {
    expect(notifyReasonTag({ undetermined: "unchecked" })).toBe(" (reason: not determinable — comments not checked this poll)");
    expect(notifyReasonTag({ undetermined: "check-failed" })).toBe(" (reason: could not check — comments fetch failed)");
    expect(notifyReasonTag({ undetermined: "checked-unchanged" })).toBe(" (reason: not determinable — checked comments, unchanged)");
    // Pairwise distinct, and distinct from the bare-undefined fallback —
    // exactly the property §3(D) requires: a pending/unlooked-at reason
    // must not render identically to a DIFFERENT fact.
    const rendered = new Set([
      notifyReasonTag(undefined),
      notifyReasonTag({ undetermined: "unchecked" }),
      notifyReasonTag({ undetermined: "check-failed" }),
      notifyReasonTag({ undetermined: "checked-unchanged" }),
    ]);
    expect(rendered.size).toBe(4);
  });
});
