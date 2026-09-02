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
    expect(changeNudge("KAN-1", "KAN-1", { comment: true })).toBe("[butchr] Ticket KAN-1 got a new comment — re-read it.");
  });

  test("a pr reason passed through anyway (should never happen — pr renders via prReviewStateNudge) falls back honestly rather than mis-rendering", () => {
    const prReason = { pr: { from: "open", to: "approved" } } as unknown as NotifyReason;
    expect(changeNudge("KAN-1", "KAN-1", prReason)).toBe(
      "[butchr] Ticket KAN-1 was updated (reason not determinable from the poll) — re-read it.",
    );
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

  test("summary / comment", () => {
    expect(notifyReasonTag({ summary: true })).toBe(" (summary changed)");
    expect(notifyReasonTag({ comment: true })).toBe(" (comment)");
  });
});
