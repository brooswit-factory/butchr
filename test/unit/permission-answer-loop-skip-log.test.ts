import { expect, test } from "bun:test";
import { runPermissionAnswerTick } from "../../src/agents/permission-answer-loop.js";

// FACTORY-93: a skipped pane must never be silent. Inject a stub drovr pass
// (deps.autoAnswer) so a skip is produced deterministically; everything else
// is the real loop.
let fakeResults: unknown[] = [];
const autoAnswer = (async () => fakeResults) as never;

const client = {
  agent: {
    list: async () => ({ type: "agent_list", agents: [{ pane_id: "p1", cwd: "/w" }] }),
    get: async () => { throw new Error("unused"); },
    read: async () => { throw new Error("unused"); },
    sendKeys: async () => { throw new Error("unused"); },
  },
} as never;

test("a skipped pane is logged once per pane+reason, not every tick, and never silently", async () => {
  fakeResults = [{ paneId: "p1", label: "p1", outcome: "skipped", reason: "no plain \"Yes\" option" }];
  const lines: string[] = [];
  const loggedSkips = new Set<string>();
  const deps = { client, eligiblePanes: () => new Map([["p1", "lizard.json"]]), auditPath: "/dev/null", log: (l: string) => lines.push(l), loggedSkips, autoAnswer };
  await runPermissionAnswerTick(deps);
  await runPermissionAnswerTick(deps);
  const skips = lines.filter((l) => l.includes("SKIPPED"));
  expect(skips).toHaveLength(1);
  expect(skips[0]).toContain("lizard.json (p1) SKIPPED, left for a human: no plain \"Yes\" option");
  fakeResults = [{ paneId: "p1", label: "p1", outcome: "skipped", reason: "a different reason" }];
  await runPermissionAnswerTick(deps);
  expect(lines.filter((l) => l.includes("SKIPPED"))).toHaveLength(2);
});
