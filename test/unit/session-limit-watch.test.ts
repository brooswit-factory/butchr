import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { watchSessionLimits, POST_RESET_MARGIN_MS, CAPTURE_MAX_FILES, type AgentRow, type CaptureSink } from "../../src/agents/session-limit-watch.js";

const row = (issue: string, agent_status: string, pane_id = `${issue.toLowerCase()}:p1`): AgentRow => ({ pane_id, agent_status, issue });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

/** In-memory CaptureSink so capture tests never touch a real filesystem (BUTCHR-12). */
function fakeSink(seed: string[] = []) {
  const files = new Map<string, string>(seed.map((n) => [n, ""]));
  let failWrites = false;
  const sink: CaptureSink = {
    write: async (name, contents) => {
      if (failWrites) throw new Error("disk full");
      files.set(name, contents);
      return `/captures/${name}`;
    },
    list: async () => [...files.keys()],
    remove: async (name) => { files.delete(name); },
  };
  return { sink, files, failWrites: (v: boolean) => { failWrites = v; } };
}

describe("watchSessionLimits", () => {
  test("cost gate: never reads the pane of a working or blocked agent", async () => {
    const reads: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "working"), row("KAN-2", "blocked")],
      read: async (p) => { reads.push(p); return ""; },
      close: async () => {},
      now: () => Date.now(),
      log: () => {},
    }, 10);
    await wait(30);
    stop();
    expect(reads).toEqual([]);
  });

  test("no refusal in an idle/done pane -> never logs, never closes", async () => {
    const closed: string[] = []; const logs: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => "just an ordinary idle pane",
      close: async (i) => { closed.push(i); },
      now: () => Date.now(),
      log: (l) => logs.push(l),
    }, 10);
    await wait(30);
    stop();
    expect(closed).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("refused with a parseable reset time: logs once (deduplicated) before the reset, never closes early, closes at reset+margin, and stays idempotent afterward", async () => {
    const closed: string[] = []; const logs: string[] = [];
    let nowMs = 1_000_000; // arbitrary anchor, well before any resolved resetsAt
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "done")],
      read: async () => "You've hit your session limit · resets 9:50pm",
      close: async (i) => { closed.push(i); },
      now: () => nowMs,
      log: (l) => logs.push(l),
    }, 5);
    await wait(30); // several polls before any reset — all should just log, deduplicated
    expect(closed).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("KAN-1");
    expect(logs[0]).toContain("resets");

    // Jump `now` to exactly the resolved resetsAt + margin (computed the same
    // way detectSessionLimitRefusal would, from the log line's own math is
    // avoided here — instead derive it directly to keep the test independent
    // of log wording): resolve 9:50pm relative to the anchor instant.
    const anchor = new Date(nowMs);
    const resetsAt = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 21, 50, 0).getTime();
    const target = resetsAt >= nowMs ? resetsAt : resetsAt + 24 * 60 * 60_000;
    nowMs = target + POST_RESET_MARGIN_MS;
    await wait(30);
    stop();
    expect(closed.length).toBeGreaterThanOrEqual(1); // idempotent: repeated polls past the margin may close repeatedly, which herd.stop() already tolerates
    expect(closed.every((i) => i === "KAN-1")).toBe(true);
  });

  test("refusal with no parseable reset time: logs that recovery cannot be scheduled, never invents a time, never closes", async () => {
    const closed: string[] = []; const logs: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => "You've hit your session limit",
      close: async (i) => { closed.push(i); },
      now: () => Date.now(),
      log: (l) => logs.push(l),
    }, 10);
    await wait(30);
    stop();
    expect(closed).toEqual([]);
    expect(logs.some((l) => l.includes("cannot schedule recovery"))).toBe(true);
  });

  // KAN-829: the regression this whole ticket exists to guard against is a
  // widened recogniser (bigger TAIL_LINES, or a looser DECORATIVE set) that
  // makes the phrase quoted in scrollback/a ticket body/an agent's own
  // narration look live and close a perfectly healthy pane. Run the SAME
  // negative fixtures session-limit.test.ts checks against
  // detectSessionLimitRefusal() through the whole watcher, end to end, so a
  // future widening of the recogniser is caught here too, not only at the
  // unit level.
  test("negative-fixture regression guard: the phrase quoted mid-scrollback never logs or closes, however the pane is polled", async () => {
    const closed: string[] = []; const logs: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => fixture("pane-cap-session-limit-midscroll.txt"),
      close: async (i) => { closed.push(i); },
      now: () => Date.now(),
      log: (l) => logs.push(l),
    }, 10);
    await wait(30);
    stop();
    expect(closed).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("negative-fixture regression guard: the phrase inside a rendered ticket/comment (agent still visibly active) never logs or closes", async () => {
    const closed: string[] = []; const logs: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => fixture("pane-cap-session-limit-quoted-ticket.txt"),
      close: async (i) => { closed.push(i); },
      now: () => Date.now(),
      log: (l) => logs.push(l),
    }, 10);
    await wait(30);
    stop();
    expect(closed).toEqual([]);
    expect(logs).toEqual([]);
  });

  // Positive-fixture counterpart, through the whole watcher rather than the
  // bare recogniser: a genuine refusal with the real composer chrome
  // rendered below it (PR #68) must still log and, past reset+margin, close.
  test("real fixture: a genuine refusal with composer chrome below it is detected, logged once, and closed only after reset+margin", async () => {
    const closed: string[] = []; const logs: string[] = [];
    let nowMs = new Date(2026, 7, 28, 18, 59, 0).getTime(); // 6:59pm, before the fixture's 9:50pm reset
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => fixture("pane-cap-session-limit-with-composer.txt"),
      close: async (i) => { closed.push(i); },
      now: () => nowMs,
      log: (l) => logs.push(l),
    }, 5);
    await wait(30);
    expect(closed).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("KAN-1");

    nowMs = new Date(2026, 7, 28, 21, 50, 0).getTime() + POST_RESET_MARGIN_MS;
    await wait(30);
    stop();
    // DoD #4 says "exactly one close" on purpose: >= 1 would also pass a
    // watcher that closes the pane every poll forever. Once closed, the
    // level-triggered `now` is already past today's printed reset, so the
    // NEXT poll's fresh resolve rolls to TOMORROW's — which is why this
    // stays at exactly one even though the fake clock is held fixed here.
    expect(closed).toEqual(["KAN-1"]);
  });

  test("a failing list() poll survives to the next poll", async () => {
    const logs: string[] = [];
    let n = 0;
    const stop = watchSessionLimits({
      list: async () => { if (n++ === 0) throw new Error("herdr down"); return [row("KAN-1", "idle")]; },
      read: async () => "",
      close: async () => {},
      now: () => Date.now(),
      log: (l) => logs.push(l),
    }, 10);
    await wait(30);
    stop();
    expect(logs.some((l) => l.includes("poll failed"))).toBe(true);
  });
});

// BUTCHR-12: durable pane-text capture on the two trigger classes the
// recogniser can't itself resolve. All through the injected CaptureSink seam
// — no real filesystem writes anywhere in this suite.
describe("watchSessionLimits: capture (BUTCHR-12)", () => {
  test("(a) phrase present but unrecognised => captured", async () => {
    const { sink, files } = fakeSink();
    const logs: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => fixture("pane-cap-session-limit-midscroll.txt"),
      close: async () => {},
      now: () => Date.now(),
      log: (l) => logs.push(l),
      captures: sink,
    }, 10);
    await wait(30);
    stop();
    expect(files.size).toBe(1);
    const [name] = [...files.keys()];
    expect(name).toMatch(/^KAN-1-unrecognised-\d{8}T\d{6}Z\.txt$/);
    const contents = files.get(name!)!;
    expect(contents).toContain("# issue: KAN-1");
    expect(contents).toContain("# pane: kan-1:p1");
    expect(contents).toContain("# trigger: unrecognised");
    expect(contents).toContain("# --- pane text follows verbatim (ANSI already stripped) ---");
    expect(contents).toContain("You've hit your session limit");
    expect(logs.some((l) => l.startsWith("[session-limit] KAN-1 pane kan-1:p1 unrecognised — pane text captured to /captures/"))).toBe(true);
  });

  test("(b) recognised WITH a reset time => NOT captured (the working path is not noise)", async () => {
    const { sink, files } = fakeSink();
    const closed: string[] = []; const logs: string[] = [];
    let nowMs = new Date(2026, 7, 28, 18, 59, 0).getTime();
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => fixture("pane-cap-session-limit-with-composer.txt"),
      close: async (i) => { closed.push(i); },
      now: () => nowMs,
      log: (l) => logs.push(l),
      captures: sink,
    }, 5);
    await wait(30);
    expect(files.size).toBe(0);
    nowMs = new Date(2026, 7, 28, 21, 50, 0).getTime() + POST_RESET_MARGIN_MS;
    await wait(30);
    stop();
    expect(closed).toEqual(["KAN-1"]);
    expect(files.size).toBe(0); // still nothing captured, even once the pane is closed
  });

  test("(c) recognised WITHOUT a parseable reset time => captured, alongside the existing operator-needed log line", async () => {
    const { sink, files } = fakeSink();
    const logs: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => "You've hit your session limit",
      close: async () => {},
      now: () => Date.now(),
      log: (l) => logs.push(l),
      captures: sink,
    }, 10);
    await wait(30);
    stop();
    expect(files.size).toBe(1);
    const [name] = [...files.keys()];
    expect(name).toMatch(/^KAN-1-no-reset-time-\d{8}T\d{6}Z\.txt$/);
    expect(files.get(name!)).toContain("# trigger: no-reset-time");
    expect(logs.some((l) => l.includes("cannot schedule recovery"))).toBe(true);
    expect(logs.some((l) => l.includes("no-reset-time — pane text captured to"))).toBe(true);
  });

  test("(d) the same pane polled again => not captured twice", async () => {
    const { sink, files } = fakeSink();
    const logs: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => fixture("pane-cap-session-limit-midscroll.txt"),
      close: async () => {},
      now: () => Date.now(),
      log: (l) => logs.push(l),
      captures: sink,
    }, 5);
    await wait(60); // many polls over the same unchanged pane
    stop();
    expect(files.size).toBe(1);
    expect(logs.filter((l) => l.includes("captured to")).length).toBe(1);
  });

  test("(e) a write failure => logged, poll continues, not retried every poll", async () => {
    const { sink, failWrites, files } = fakeSink();
    failWrites(true);
    const logs: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => fixture("pane-cap-session-limit-midscroll.txt"),
      close: async () => {},
      now: () => Date.now(),
      log: (l) => logs.push(l),
      captures: sink,
    }, 5);
    await wait(60); // many polls; the failure must be logged once, not once per poll
    stop();
    expect(files.size).toBe(0);
    const failures = logs.filter((l) => l.includes("capture failed"));
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("disk full");
  });

  test("(f) eviction removes the globally OLDEST capture by timestamp — not the lexicographically-first filename — and never touches a foreign file sharing the directory", async () => {
    // Deliberately anti-correlated with alphabetical order (review on
    // BUTCHR-12): AAAA-1's issue key sorts before ZZZZ-9's, but AAAA-1's
    // captures are the NEWEST (Aug 2026) and ZZZZ-9's are the OLDEST (Jan
    // 2026), spanning both trigger classes. A plain lexicographic sort of
    // the whole filename would evict AAAA-1 entries first — the newest
    // evidence — while seven-month-old ZZZZ-9 files survived; sorting by
    // the parsed timestamp instead gets this right.
    const aaaa = Array.from({ length: 25 }, (_, i) => `AAAA-1-unrecognised-20260801T${String(i).padStart(2, "0")}0000Z.txt`);
    const zzzz = Array.from({ length: 25 }, (_, i) => `ZZZZ-9-no-reset-time-20260101T${String(i).padStart(2, "0")}0000Z.txt`);
    const foreign = "operator-notes.txt"; // not a butchr capture filename: must never be touched, never counted toward the cap
    const { sink, files } = fakeSink([...aaaa, ...zzzz, foreign]);
    expect(files.size).toBe(51);
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => fixture("pane-cap-session-limit-midscroll.txt"),
      close: async () => {},
      now: () => Date.now(),
      log: () => {},
      captures: sink,
    }, 10);
    await wait(30);
    stop();
    expect(files.has(foreign)).toBe(true);
    expect(aaaa.every((n) => files.has(n))).toBe(true); // newest: none evicted
    expect(files.has(zzzz[0]!)).toBe(false); // globally oldest: evicted
    expect(zzzz.slice(1).every((n) => files.has(n))).toBe(true);
    expect([...files.keys()].some((n) => n.startsWith("KAN-1-unrecognised-"))).toBe(true);
  });

  // BUTCHR-96's disjointness control, from this side: a check that FAILS if
  // this module's own CAPTURE_NAME ever starts matching an escalation-loop.ts
  // capture name (`<ISSUE-or-PROJECT>-escalation-<ts>.txt`). Without this,
  // "the two shapes never cross-evict" is only a claim in a comment.
  test("(f2) never treats an escalation-loop capture name as its own — foreign shapes are never evicted or counted toward the cap", async () => {
    const foreignIssue = "KAN-1-escalation-20260101T000000Z.txt";
    const foreignProject = "BUTCHR-escalation-20260101T000000Z.txt"; // bare project key, no issue number
    const ours = Array.from({ length: 50 }, (_, i) => `KAN-1-unrecognised-20260201T${String(i).padStart(2, "0")}0000Z.txt`);
    const { sink, files } = fakeSink([foreignIssue, foreignProject, ...ours]);
    expect(files.size).toBe(52);
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => fixture("pane-cap-session-limit-midscroll.txt"),
      close: async () => {},
      now: () => Date.now(),
      log: () => {},
      captures: sink,
    }, 10);
    await wait(30);
    stop();
    // The foreign, escalation-shaped files must survive untouched — never
    // recognised as ours, never evicted, never counted toward the cap.
    expect(files.has(foreignIssue)).toBe(true);
    expect(files.has(foreignProject)).toBe(true);
  });

  test("(g) no captures dep supplied => today's behaviour exactly (no throw, no capture-shaped log)", async () => {
    const logs: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => fixture("pane-cap-session-limit-midscroll.txt"),
      close: async () => {},
      now: () => Date.now(),
      log: (l) => logs.push(l),
    }, 10);
    await wait(30);
    stop();
    expect(logs).toEqual([]);
  });

  // Decision 2, pinned in code: a HEALTHY pane with the phrase quoted in
  // scrollback (a rendered ticket/comment body) trips the cheap unanchored
  // test and IS captured under `unrecognised` — accepted, bounded noise, no
  // discriminator added.
  test("decision 2: the quoted-ticket healthy-pane fixture is still captured as unrecognised", async () => {
    const { sink, files } = fakeSink();
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => fixture("pane-cap-session-limit-quoted-ticket.txt"),
      close: async () => {},
      now: () => Date.now(),
      log: () => {},
      captures: sink,
    }, 10);
    await wait(30);
    stop();
    expect(files.size).toBe(1);
    expect([...files.keys()][0]).toMatch(/^KAN-1-unrecognised-/);
  });

  test("dedupe clears once the pane recovers (phrase no longer present), so a later refusal captures again", async () => {
    const { sink, files } = fakeSink();
    let text = fixture("pane-cap-session-limit-midscroll.txt");
    let nowMs = Date.now();
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => text,
      close: async () => {},
      now: () => nowMs,
      log: () => {},
      captures: sink,
    }, 5);
    await wait(20);
    expect(files.size).toBe(1);
    text = "a perfectly ordinary idle pane, no refusal, no quoted phrase";
    nowMs += 1_000; // pane recovers; dedupe entry for KAN-1 clears
    await wait(20);
    text = fixture("pane-cap-session-limit-midscroll.txt");
    nowMs += 1_000; // refusal shape reappears with a distinct captured-at -> captured again, distinct filename
    await wait(20);
    stop();
    expect(files.size).toBe(2);
  });
});
