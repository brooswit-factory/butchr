import { describe, expect, test } from "bun:test";
import { combineHealth, createLoopHealth } from "../../src/daemon/health.js";
import { skippedCommentCheckLine } from "../../src/jira-watch/skipped-comment-check-log.js";

/**
 * FACTORY-922 (implementing story FACTORY-921): `commentChecksSkipped`
 * (src/daemon/health.ts) is the `/health` sibling field a
 * `createIssueEventRules`'s `onCommentCheckSkipped` callback feeds — see
 * src/resources/issue.ts's §3D fallback. Pinned here the same way every
 * other `combineHealth` sibling field already is (see loop-watchdog.test.ts/
 * resource-loop-health.test.ts for precedent): additive, absent when
 * omitted, never flips `ok`.
 */
describe("combineHealth FACTORY-922: commentChecksSkipped", () => {
  const poll = createLoopHealth({ name: "pollLoop", thresholdMs: 10_000 });
  poll.recordSuccess();

  test("absent entirely when the caller passes none — never a bare 0", () => {
    expect("commentChecksSkipped" in combineHealth([poll])).toBe(false);
  });

  test("present and equal to whatever count the caller passes, never flipping `ok`", () => {
    const health = combineHealth(
      [poll],
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      7,
    );
    expect(health.commentChecksSkipped).toBe(7);
    expect(health.ok).toBe(true);
  });

  test("0 is a real, present value — distinguishable from 'absent'", () => {
    const health = combineHealth(
      [poll],
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      0,
    );
    expect("commentChecksSkipped" in health).toBe(true);
    expect(health.commentChecksSkipped).toBe(0);
  });
});

describe("skippedCommentCheckLine (FACTORY-922)", () => {
  test("renders the exact documented literal shape for both reasons", () => {
    expect(skippedCommentCheckLine("KAN-1", "load")).toBe("[poll] skipped-comment-check key=KAN-1 reason=load retained-snapshot");
    expect(skippedCommentCheckLine("KAN-1", "failed")).toBe("[poll] skipped-comment-check key=KAN-1 reason=failed retained-snapshot");
  });
});
