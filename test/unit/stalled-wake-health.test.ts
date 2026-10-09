import { describe, expect, test } from "bun:test";
import { combineHealth, createLoopHealth } from "../../src/daemon/health.js";

/**
 * FACTORY-972 (story FACTORY-971, item 5): `stalledWakes`/`stalledWakesCapped`
 * (src/daemon/health.ts) are the `/health` sibling fields `createIssueEventRules`'s
 * `onStalledWake`/`onStalledWakeCapped` callbacks feed — see
 * src/resources/issue.ts's `decide()` stalled-wake branch. Pinned the same
 * way `commentChecksSkipped` already is (test/unit/comment-check-skip-health.test.ts):
 * additive, absent when omitted, never flips `ok`.
 */
describe("combineHealth FACTORY-972: stalledWakes / stalledWakesCapped", () => {
  const poll = createLoopHealth({ name: "pollLoop", thresholdMs: 10_000 });
  poll.recordSuccess();

  test("both absent entirely when the caller passes neither — never a bare 0", () => {
    const health = combineHealth([poll]);
    expect("stalledWakes" in health).toBe(false);
    expect("stalledWakesCapped" in health).toBe(false);
  });

  test("present and equal to whatever counts the caller passes, never flipping `ok`, and 0 is a real present value", () => {
    const health = combineHealth(
      [poll],
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined,
      5,
      0,
    );
    expect(health.stalledWakes).toBe(5);
    expect("stalledWakesCapped" in health).toBe(true);
    expect(health.stalledWakesCapped).toBe(0);
    expect(health.ok).toBe(true);
  });
});
