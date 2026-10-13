import { expect, test } from "bun:test";
import { createStallRemediator, MARKER } from "../../src/agents/stall-remediation.js";
import { createStalledCheck } from "../../src/agents/stalled.js";
const MIN = 60_000;
function fixture() {
  let now = 0;
  const rows: Array<{id: string; body: string; created: string}> = [];
  const posts: string[] = [];
  const deps = {now: () => now, comments: async () => rows, addComment: async (_key: string, body: string) => {
    posts.push(body); rows.unshift({id: String(rows.length + 1), body, created: new Date(now).toISOString()});
  }};
  return {deps, rows, posts, at: (n: number) => {now = n;}};
}
test("one notice per qualifying episode, with no repetition or self-rearming", async () => {
  const f = fixture(), rem = createStallRemediator(f.deps);
  const detector = createStalledCheck({...f.deps, minutes: 10});
  expect(await detector.check("T-1", "idle")).toBe(false);
  f.at(10 * MIN);
  await rem.check("T-1", true, await detector.check("T-1", "idle"));
  expect(f.posts).toHaveLength(1);
  for (let day = 1; day <= 7; day++) {
    f.at(day * 1440 * MIN);
    await rem.check("T-1", true, await detector.check("T-1", "idle"));
  }
  expect(f.posts).toHaveLength(1);
  f.rows.unshift({id: "human", body: "Working on the follow-up", created: new Date(7 * 1440 * MIN).toISOString()});
  await rem.check("T-1", true, await detector.check("T-1", "idle"));
  f.at((7 * 1440 + 9) * MIN);
  expect(await detector.check("T-1", "idle")).toBe(false);
  f.at((7 * 1440 + 10) * MIN);
  await rem.check("T-1", true, await detector.check("T-1", "idle"));
  expect(f.posts).toHaveLength(2);
  expect(f.posts.every(p => p.startsWith(MARKER))).toBe(true);
});
test("working closes the episode; stale labels and unknown checks cannot produce a notice", async () => {
  const f = fixture(), rem = createStallRemediator(f.deps);
  await rem.check("T-1", true, true);
  f.at(MIN);
  expect((await rem.check("T-1", true, false)).kind).toBe("not-a-candidate");
  expect((await rem.check("T-1", true, null)).kind).toBe("suppressed");
  f.at(11 * MIN);
  await rem.check("T-1", true, true);
  expect(f.posts).toHaveLength(2);
});
test("label removal alone does not rearm; restart and ownership handoff adopt visible history", async () => {
  const f = fixture(), rem = createStallRemediator(f.deps);
  await rem.check("T-1", true, true);
  f.at(20 * MIN);
  await rem.check("T-1", false, true);
  await rem.check("T-1", true, true);
  await createStallRemediator(f.deps).check("T-1", true, true);
  expect(f.posts).toHaveLength(1);
  f.at(21 * MIN);
  f.rows.unshift({id: "human", body: "Actual activity", created: new Date(21 * MIN).toISOString()});
  f.at(31 * MIN);
  await createStallRemediator(f.deps).check("T-1", true, true);
  expect(f.posts).toHaveLength(2);
});
test("overlapping polls serialize the write for one ticket", async () => {
  const f = fixture(), rem = createStallRemediator(f.deps);
  await Promise.all(Array.from({length: 20}, () => rem.check("T-1", true, true)));
  expect(f.posts).toHaveLength(1);
});

test("changing the timeout or losing activity timestamps does not rearm an existing notice", async () => {
  const f = fixture(), rem = createStallRemediator(f.deps);
  f.at(10 * MIN);
  await rem.check("T-1", true, true, 10, [], 0);
  f.at(11 * MIN);
  await rem.check("T-1", true, false, 11, [], 0); // same streak, longer configured timeout
  await rem.check("T-1", true, null, 11, [], 0);
  f.at(40 * MIN);
  await rem.check("T-1", true, true, 40, [], 0);
  expect(f.posts).toHaveLength(1);
});
