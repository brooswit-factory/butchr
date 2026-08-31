import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IdleDialogTracker, withIdleDialogDetection } from "../../src/agents/idle-dialog.js";
import { blockedNow } from "../../src/agents/blocked.js";
import { watchPrompts } from "../../src/agents/prompt-watch.js";
import { chooseStartupAnswer, keysToSelect } from "../../src/agents/prompt.js";
import { createEscalator, type CommentRow } from "../../src/agents/escalation-loop.js";

const row = (pane_id: string, agent_status: string) => ({ pane_id, agent_status });

describe("IdleDialogTracker", () => {
  test("candidate only after `minutes` of continuous idle/done since first observation", () => {
    let now = 0;
    const t = new IdleDialogTracker(() => now, 2);
    expect(t.observe("p1", "idle")).toBe(false); // first observation: just started the floor
    now = 60_000;
    expect(t.observe("p1", "idle")).toBe(false); // 1 min in: not yet
    now = 2 * 60_000;
    expect(t.observe("p1", "idle")).toBe(true); // 2 min in: candidate
    now = 5 * 60_000;
    expect(t.observe("p1", "idle")).toBe(true); // stays a candidate
  });

  test("'done' counts the same as 'idle', and the two can mix within one continuous streak", () => {
    let now = 0;
    const t = new IdleDialogTracker(() => now, 2);
    t.observe("p1", "idle");
    now = 60_000;
    expect(t.observe("p1", "done")).toBe(false);
    now = 2 * 60_000;
    expect(t.observe("p1", "done")).toBe(true);
  });

  test("NOT a permanent latch (unlike StalledTracker): leaving idle/done resets the floor immediately, and a later idle spell must re-earn it", () => {
    let now = 0;
    const t = new IdleDialogTracker(() => now, 2);
    t.observe("p1", "idle");
    now = 3 * 60_000;
    expect(t.observe("p1", "idle")).toBe(true);
    now = 3 * 60_000 + 1;
    expect(t.observe("p1", "working")).toBe(false); // streak broken
    now = 3 * 60_000 + 2;
    expect(t.observe("p1", "idle")).toBe(false); // fresh floor, not yet 2 minutes
    now = 5 * 60_000 + 2;
    expect(t.observe("p1", "idle")).toBe(true); // 2 minutes from the NEW floor
  });

  test("forget() drops tracking so a later observation starts a fresh floor", () => {
    let now = 0;
    const t = new IdleDialogTracker(() => now, 2);
    t.observe("p1", "idle");
    now = 3 * 60_000;
    expect(t.observe("p1", "idle")).toBe(true);
    t.forget("p1");
    expect(t.observe("p1", "idle")).toBe(false);
  });
});

const END_OF_PANE_MENU = "Choose your favorite color:\n❯ 1. Red\n  2. Blue\nEnter to confirm · Esc to cancel";

describe("withIdleDialogDetection", () => {
  test("COST GATE: never reads pane text for a row that hasn't cleared the idle-duration bound yet", async () => {
    let now = 0;
    const reads: string[] = [];
    const wrapped = withIdleDialogDetection(
      async () => [row("p1", "idle")],
      { now: () => now, minutes: 2, read: async (p) => { reads.push(p); return END_OF_PANE_MENU; } },
    );
    await wrapped(); // first observation
    now = 60_000;
    await wrapped(); // 1 minute: still not a candidate
    expect(reads).toEqual([]);
  });

  test("reads pane text once the bound clears, and overrides agent_status to 'blocked' when it parses as an end-of-pane menu", async () => {
    let now = 0;
    const wrapped = withIdleDialogDetection(
      async () => [row("p1", "idle")],
      { now: () => now, minutes: 2, read: async () => END_OF_PANE_MENU },
    );
    await wrapped();
    now = 2 * 60_000;
    const rows = await wrapped();
    expect(rows).toEqual([{ pane_id: "p1", agent_status: "blocked" }]);
    expect(blockedNow(rows)).toEqual(["p1"]); // flows through blockedNow's existing, unmodified filter
  });

  test("leaves agent_status untouched when the pane text does not parse as a menu, even past the bound", async () => {
    let now = 0;
    const wrapped = withIdleDialogDetection(
      async () => [row("p1", "idle")],
      { now: () => now, minutes: 2, read: async () => "just idle, nothing on screen" },
    );
    await wrapped();
    now = 2 * 60_000;
    const rows = await wrapped();
    expect(rows).toEqual([{ pane_id: "p1", agent_status: "idle" }]);
    expect(blockedNow(rows)).toEqual([]);
  });

  test("never reads (and never flags) a pane that isn't idle/done at all", async () => {
    let now = 2 * 60_000;
    const reads: string[] = [];
    const wrapped = withIdleDialogDetection(
      async () => [row("p1", "working")],
      { now: () => now, minutes: 2, read: async (p) => { reads.push(p); return END_OF_PANE_MENU; } },
    );
    const rows = await wrapped();
    expect(rows).toEqual([{ pane_id: "p1", agent_status: "working" }]);
    expect(reads).toEqual([]);
  });

  test("a pane herdr already calls 'blocked' passes through unchanged, with no extra read (it isn't idle/done)", async () => {
    const reads: string[] = [];
    const wrapped = withIdleDialogDetection(
      async () => [row("p1", "blocked")],
      { now: () => 0, minutes: 2, read: async (p) => { reads.push(p); return END_OF_PANE_MENU; } },
    );
    const rows = await wrapped();
    expect(rows).toEqual([{ pane_id: "p1", agent_status: "blocked" }]);
    expect(reads).toEqual([]);
  });

  test("a pane read failure is logged and the row is left exactly as herdr reported it", async () => {
    let now = 0;
    const logs: string[] = [];
    const wrapped = withIdleDialogDetection(
      async () => [row("p1", "idle")],
      { now: () => now, minutes: 2, read: async () => { throw new Error("herdr unreachable"); }, log: (l) => logs.push(l) },
    );
    await wrapped();
    now = 2 * 60_000;
    const rows = await wrapped();
    expect(rows).toEqual([{ pane_id: "p1", agent_status: "idle" }]);
    expect(logs.some((l) => l.includes("p1") && l.includes("herdr unreachable"))).toBe(true);
  });

  test("independent per-pane tracking: one pane's status change never affects another's floor", async () => {
    let now = 0;
    const statusFor = new Map([["p1", "idle"], ["p2", "idle"]]);
    const wrapped = withIdleDialogDetection(
      async () => [...statusFor.entries()].map(([id, s]) => row(id, s)),
      { now: () => now, minutes: 2, read: async () => END_OF_PANE_MENU },
    );
    await wrapped(); // t=0: both first-observed
    now = 90_000;
    statusFor.set("p2", "working"); // p2 goes to work in between; p1 stays idle
    await wrapped(); // t=1.5min: p1 not yet a candidate; p2's floor resets
    now = 2 * 60_000 + 90_000;
    statusFor.set("p2", "idle"); // p2 back to idle, but from a FRESH floor
    const rows = await wrapped();
    const byId = Object.fromEntries(rows.map((r) => [r.pane_id, r.agent_status]));
    expect(byId.p1).toBe("blocked"); // p1's own floor, uninterrupted, has cleared 2 minutes
    expect(byId.p2).toBe("idle"); // p2's floor restarted when it went to "working"
  });
});

// BUTCHR-16 DoD items 1, 5, 6: the full pipeline exactly as daemon/index.ts
// wires it — withIdleDialogDetection's rows feed blockedNow, whose ids feed
// watchPrompts (auto-answer or expose), whose exposed prompts feed the SAME
// createEscalator used for herdr-native "blocked" panes. No real timers: each
// `tick()` call below is one simulated watchBlocked poll, with `nowMs`
// advanced by the test to simulate elapsed idle time without waiting for it.
function integrationHarness(minutes: number) {
  let nowMs = 0;
  const statusFor = new Map<string, string>();
  const paneTextFor = new Map<string, string>();
  const issueFor = new Map<string, string | null>();
  const posted: Array<{ issue: string; text: string }> = [];
  const sent: Array<{ pane: string; text: string }> = [];
  const reads: string[] = [];
  let commentRows: CommentRow[] = [];
  let nextId = 1;
  let seq = 0;

  const readPane = async (paneId: string) => { reads.push(paneId); return paneTextFor.get(paneId) ?? ""; };

  const escalator = createEscalator({
    read: readPane,
    send: async (pane, text) => { sent.push({ pane, text }); },
    addComment: async (issue, text) => {
      posted.push({ issue, text });
      commentRows = [{ id: String(nextId++), body: text, created: new Date(nowMs).toISOString() }, ...commentRows];
    },
    comments: async () => commentRows,
    now: () => nowMs,
    log: () => {},
  });

  const wrappedList = withIdleDialogDetection(
    async () => [...statusFor.entries()].map(([pane_id, agent_status]) => row(pane_id, agent_status)),
    { now: () => nowMs, minutes, read: readPane },
  );

  const pending: Promise<void>[] = [];
  let fireBlocked: ((paneId: string, pollSeq: number) => void) | null = null;
  watchPrompts({
    onBlocked: (cb) => { fireBlocked = cb; return () => {}; },
    read: readPane,
    send: async (pane, text) => { sent.push({ pane, text }); },
    onPrompt: ({ prompt }) => chooseStartupAnswer(prompt) ?? undefined,
    onExposed: ({ paneId, prompt, pollSeq }) => {
      pending.push(escalator.onBlocked(paneId, issueFor.get(paneId) ?? null, prompt, pollSeq));
    },
    onUnparseable: ({ paneId, text, pollSeq }) => escalator.onNoPrompt(paneId, issueFor.get(paneId) ?? null, text, pollSeq),
  });

  return {
    posted, sent, reads,
    setNow: (ms: number) => { nowMs = ms; },
    advanceMinutes: (m: number) => { nowMs += m * 60_000; },
    setStatus: (pane: string, status: string) => { statusFor.set(pane, status); },
    setPaneText: (pane: string, text: string) => { paneTextFor.set(pane, text); },
    setIssue: (pane: string, issue: string | null) => { issueFor.set(pane, issue); },
    tick: async () => {
      seq++;
      const rows = await wrappedList();
      const ids = blockedNow(rows);
      escalator.onPoll(seq, ids);
      for (const paneId of ids) fireBlocked!(paneId, seq);
      // watchPrompts's handler (read → parse → onPrompt → onExposed) is async
      // and fire-and-forget, exactly as production wires it (watchBlocked
      // never awaits onBlocked either) — yield to the macrotask queue so
      // every microtask it queued has settled before collecting `pending`.
      await new Promise((r) => setTimeout(r, 0));
      await Promise.all(pending.splice(0, pending.length));
    },
  };
}

const UNRECOGNIZED_MENU = "Choose your favorite color:\n❯ 1. Red\n  2. Blue\nEnter to confirm · Esc to cancel";

// The mid-scrollback shape a self-sustaining loop would produce: butchr's own
// escalation comment, quoted verbatim inside the agent's rendered ticket, with
// the agent's own continued work AFTER it — never at the pane's end, no
// footer adjacent to the quoted options, no cursor on either.
const QUOTED_MID_SCROLLBACK = [
  "[butchr:blocked] KAN-1 is waiting on a decision:",
  "",
  "Choose your favorite color:",
  "",
  "1. Red",
  "2. Blue",
  "",
  "fingerprint: abcd1234",
  "",
  "Reply on THIS ticket with a comment containing exactly `ANSWER <n> abcd1234` (or `ANSWER TEXT <your text> abcd1234`).",
  "● Read the ticket. Nothing else to do right now — waiting for further instructions.",
].join("\n");

describe("idle-dialog detection routed through the existing escalation pipeline (BUTCHR-16)", () => {
  test("DoD 1: an UNRECOGNISED dialog shape on a pane herdr calls idle, past the bound, ESCALATES rather than hanging", async () => {
    const h = integrationHarness(2);
    h.setStatus("p1", "idle");
    h.setPaneText("p1", UNRECOGNIZED_MENU);
    h.setIssue("p1", "KAN-1");

    await h.tick(); // t=0: first observation, not a candidate
    expect(h.reads).toEqual([]); // cost gate: no read at all before the bound
    expect(h.posted).toEqual([]);

    h.advanceMinutes(1);
    await h.tick(); // t=1min: still under the bound
    expect(h.posted).toEqual([]);

    h.advanceMinutes(1);
    await h.tick(); // t=2min: bound cleared — blocked pipeline sees it (debounce poll 1)
    expect(h.reads.length).toBeGreaterThan(0);
    expect(h.posted).toEqual([]); // escalator's own 2-poll debounce hasn't cleared yet

    await h.tick(); // consecutive poll — escalates
    expect(h.posted.length).toBe(1);
    expect(h.posted[0]!.issue).toBe("KAN-1");
    expect(h.posted[0]!.text).toContain("Choose your favorite color:");
    expect(h.sent).toEqual([]); // never auto-answered — no rule recognizes it
  });

  test("DoD 5: escalation is deduped across many further polls — one alert, not hundreds", async () => {
    const h = integrationHarness(2);
    h.setStatus("p1", "idle");
    h.setPaneText("p1", UNRECOGNIZED_MENU);
    h.setIssue("p1", "KAN-1");
    await h.tick(); // establishes the floor at t=0
    h.advanceMinutes(2);
    for (let i = 0; i < 20; i++) await h.tick();
    expect(h.posted.length).toBe(1);
  });

  test("DoD 6: the SAME menu text, quoted mid-scrollback (not at the pane's end) on an idle pane past the bound, never escalates", async () => {
    const h = integrationHarness(2);
    h.setStatus("p1", "idle");
    h.setPaneText("p1", QUOTED_MID_SCROLLBACK);
    h.setIssue("p1", "KAN-1");
    await h.tick(); // establishes the floor at t=0
    h.advanceMinutes(2);
    for (let i = 0; i < 20; i++) await h.tick();
    expect(h.reads.length).toBeGreaterThan(0); // it DID get read (past the cheap gate)...
    expect(h.posted).toEqual([]); // ...but never parsed as a real end-of-pane dialog
    expect(h.sent).toEqual([]);
  });

  test("a RECOGNISED dialog reaching this path is auto-answered, never escalated", async () => {
    const TRUST = `Quick safety check: is this a project you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel`;
    const h = integrationHarness(2);
    h.setStatus("p1", "idle");
    h.setPaneText("p1", TRUST);
    h.setIssue("p1", "KAN-1");
    await h.tick(); // establishes the floor at t=0
    h.advanceMinutes(2);
    await h.tick();
    expect(h.posted).toEqual([]);
    expect(h.sent).toEqual([{ pane: "p1", text: keysToSelect(1, 2) }]); // "Yes, I trust this folder"
  });

  // Ties requirement A (idle-dialog detection) and requirement B (settings-
  // preserving rule) together end to end: the effort-recommendation dialog
  // that opened this ticket, reaching the escalator ONLY through the new
  // idle-status path (herdr never called these panes blocked), is answered
  // by preserving the current setting and never escalates.
  test("the effort-recommendation dialog (real incident fixture), reached ONLY via idle-dialog detection, preserves the current setting and never escalates", async () => {
    const fixture = readFileSync(join(import.meta.dir, "../fixtures/pane-cap-effort-recommendation.txt"), "utf8");
    const DELIM = "# --- reconstructed pane text follows ---\n";
    const effortPane = fixture.slice(fixture.indexOf(DELIM) + DELIM.length);

    const h = integrationHarness(2);
    h.setStatus("p1", "idle"); // exactly what herdr reported for ~12 hours during the real incident
    h.setPaneText("p1", effortPane);
    h.setIssue("p1", "KAN-1");
    await h.tick(); // establishes the floor at t=0
    h.advanceMinutes(2);
    await h.tick();
    expect(h.posted).toEqual([]);
    expect(h.sent).toEqual([{ pane: "p1", text: keysToSelect(1, 2) }]); // option 2, "Keep high"
  });
});
