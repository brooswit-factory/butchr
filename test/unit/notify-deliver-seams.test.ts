import { describe, expect, test } from "bun:test";

/**
 * FACTORY-893/FACTORY-894 — `src/daemon/index.ts` is a top-level daemon
 * entry point with side effects on import (it starts the HTTP server, the
 * poll loops, etc.), so it cannot be unit-tested by importing it. These
 * tests instead pin the SOURCE TEXT of its delivery seams directly — the
 * "structural guard test that greps/inspects for the old pairing outside
 * the shared function" the ticket itself names as an acceptable answer to
 * "how is an eighth provider loop prevented from reintroducing the old
 * pattern". `src/notify/deliver.ts`'s own test file (notify-deliver.test.ts)
 * covers the gate's actual behaviour; this file only covers "every seam
 * routes through it, and the old pairing is gone everywhere".
 *
 * Each test below would FAIL on the pre-fix base commit: every one of the
 * strings/counts it asserts (`deliverNotice(`, `renderNotifyDelivery(`, the
 * absence of `void notifyAgent(`) simply did not exist before this ticket —
 * the base source read `void notifyAgent(mcp, agent, ..., msg).catch(...)`
 * followed unconditionally by `await herd.nudge(...)` at all 7 sites.
 *
 * FACTORY-845: the count below was 8, not 7 — `deliverIdlePoke` (the
 * idle-poke engine's channel half, src/daemon/index.ts) is an EIGHTH seam,
 * added in the same commit that updates these counts, exactly as
 * FACTORY-868's own contract on FACTORY-845 instructs ("when you add a
 * site, update the counts in the same commit and say so in your PR"). This
 * is the intended, anticipated outcome of adding a seam — not evidence the
 * new seam is wrong.
 *
 * FACTORY-998: the count below is now 9, not 8 — `startConfluencePageLoop`
 * (the new `confluence-page` rule loop) is a NINTH seam, same contract,
 * same reasoning: an anticipated, intended new seam, not a regression.
 */

const src = await Bun.file(new URL("../../src/daemon/index.ts", import.meta.url)).text();

describe("every delivery seam routes through the ONE shared gate (acceptance D)", () => {
  test("the old fire-and-forget pairing is gone everywhere in this file", () => {
    expect(src.includes("void notifyAgent(")).toBe(false);
  });

  test("notifyAgent is still called exactly 9 times — once per seam, none dropped", () => {
    const count = src.split("notifyAgent(mcp,").length - 1;
    expect(count).toBe(9);
  });

  test("every notifyAgent(mcp, ...) call is wrapped as deliverNotice's pushChannel — never called bare", () => {
    const calls = src.split("notifyAgent(mcp,").length - 1;
    const wrapped = src.split("pushChannel: () => notifyAgent(mcp,").length - 1;
    expect(wrapped).toBe(calls);
  });

  test("deliverNotice and renderNotifyDelivery are each invoked exactly 9 times — one per seam, no seam keeps its own copy", () => {
    expect(src.split("deliverNotice({").length - 1).toBe(9);
    expect(src.split("renderNotifyDelivery(").length - 1).toBe(9);
  });

  test("the shared gate is imported from src/notify/deliver.ts, not reimplemented locally", () => {
    expect(src).toMatch(/import\s*\{\s*deliverNotice,\s*renderNotifyDelivery\s*\}\s*from\s*["']\.\.\/notify\/deliver\.js["']/);
  });
});

/**
 * One named test per provider seam (acceptance D's "one test per provider
 * seam, named for it"), isolating the block that immediately follows each
 * loop's own `start*Loop(`/the rule engine's `notifyRuleAgent` definition
 * and asserting THAT slice both calls the shared gate and contains no bare
 * notifyAgent/herd.nudge pairing of its own.
 */
function sliceAfter(marker: string, length = 600): string {
  const i = src.indexOf(marker);
  expect(i, `expected to find ${JSON.stringify(marker)} in src/daemon/index.ts`).toBeGreaterThan(-1);
  return src.slice(i, i + length);
}

describe("named per-seam checks", () => {
  test("jira-work rule engine (notifyRuleAgent)", () => {
    const block = sliceAfter("const notifyRuleAgent = async (agent: string, about: string, reason?: NotifyReason)", 1400);
    expect(block).toContain("deliverNotice({");
    expect(block).toContain("renderNotifyDelivery(");
    expect(block).not.toContain("void notifyAgent(");
  });

  test("github-issue loop (startGithubIssueLoop)", () => {
    const block = sliceAfter("startGithubIssueLoop({");
    expect(block).toContain("deliverNotice({");
    expect(block).toContain("renderNotifyDelivery(");
    expect(block).not.toContain("void notifyAgent(");
  });

  test("github-pr loop (startGithubPrLoop)", () => {
    const block = sliceAfter("startGithubPrLoop({");
    expect(block).toContain("deliverNotice({");
    expect(block).toContain("renderNotifyDelivery(");
    expect(block).not.toContain("void notifyAgent(");
  });

  test("jira-idea loop (startJiraIdeaLoop)", () => {
    const block = sliceAfter("startJiraIdeaLoop({", 900);
    expect(block).toContain("deliverNotice({");
    expect(block).toContain("renderNotifyDelivery(");
    expect(block).not.toContain("void notifyAgent(");
  });

  test("zendesk-ticket loop (startZendeskTicketLoop)", () => {
    const block = sliceAfter("startZendeskTicketLoop({");
    expect(block).toContain("deliverNotice({");
    expect(block).toContain("renderNotifyDelivery(");
    expect(block).not.toContain("void notifyAgent(");
  });

  test("filesystem loop (startFilesystemLoop)", () => {
    const block = sliceAfter("startFilesystemLoop({");
    expect(block).toContain("deliverNotice({");
    expect(block).toContain("renderNotifyDelivery(");
    expect(block).not.toContain("void notifyAgent(");
  });

  test("managed-sessions loop (startManagedSessionsLoop)", () => {
    const block = sliceAfter("startManagedSessionsLoop({");
    expect(block).toContain("deliverNotice({");
    expect(block).toContain("renderNotifyDelivery(");
    expect(block).not.toContain("void notifyAgent(");
  });

  test("FACTORY-845: idle-poke engine (deliverIdlePoke)", () => {
    const block = sliceAfter("const deliverIdlePoke = async (issue: string, text: string)", 500);
    expect(block).toContain("deliverNotice({");
    expect(block).toContain("renderNotifyDelivery(");
    expect(block).not.toContain("void notifyAgent(");
  });

  test("FACTORY-998: confluence-page loop (startConfluencePageLoop)", () => {
    const block = sliceAfter("startConfluencePageLoop({", 700);
    expect(block).toContain("deliverNotice({");
    expect(block).toContain("renderNotifyDelivery(");
    expect(block).not.toContain("void notifyAgent(");
  });
});

/**
 * FACTORY-1010 — every rule-owned seam (the seven above that staff agents
 * FROM a `Rule`: jira-work, github-issue, github-pr, jira-idea,
 * zendesk-ticket, filesystem, confluence-page) must thread the per-rule
 * `Rule.notifyDeliveryMode` into its own `deliverNotice({...})` call via
 * the shared `ruleNotifyDeliveryMode(agent)` lookup — never a second,
 * independently-reimplemented lookup per seam (which could drift). The two
 * NON-rule seams (idle-poke's per-ISSUE multi-rule merge, and the
 * SessionDefinition-based managed-sessions loop) are deliberately NOT
 * wired — see each one's own inline comment in src/daemon/index.ts for
 * why — and this test proves that boundary is real, not just claimed in a
 * comment that could silently go stale.
 */
describe("FACTORY-1010: per-rule notifyDeliveryMode is threaded through every rule-owned seam, and ONLY those", () => {
  test("ruleNotifyDeliveryMode is defined once, decoding the agent key to look up its owning rule", () => {
    expect(src).toContain("const ruleNotifyDeliveryMode = (agent: string): NotifyDeliveryMode | undefined =>");
  });

  test("mode: ruleNotifyDeliveryMode(agent) appears exactly 7 times — once per rule-owned seam, no seam keeps its own copy", () => {
    expect(src.split("mode: ruleNotifyDeliveryMode(agent),").length - 1).toBe(7);
  });

  for (const marker of [
    'const notifyRuleAgent = async (agent: string, about: string, reason?: NotifyReason)',
    "startGithubIssueLoop({",
    "startGithubPrLoop({",
    "startJiraIdeaLoop({",
    "startZendeskTicketLoop({",
    "startFilesystemLoop({",
    "startConfluencePageLoop({",
  ]) {
    test(`rule-owned seam at ${JSON.stringify(marker)} passes mode: ruleNotifyDeliveryMode(agent)`, () => {
      const block = sliceAfter(marker, 1300);
      expect(block).toContain("mode: ruleNotifyDeliveryMode(agent),");
    });
  }

  test("the idle-poke seam deliberately does NOT read notifyDeliveryMode (documented out-of-scope: per-issue multi-rule merge, a different event family)", () => {
    const block = sliceAfter("const deliverIdlePoke = async (issue: string, text: string)", 500);
    expect(block).not.toContain("ruleNotifyDeliveryMode");
  });

  test("the managed-sessions seam deliberately does NOT read notifyDeliveryMode (documented out-of-scope: SessionDefinition, not a Rule)", () => {
    const block = sliceAfter("startManagedSessionsLoop({");
    expect(block).not.toContain("ruleNotifyDeliveryMode");
  });
});
