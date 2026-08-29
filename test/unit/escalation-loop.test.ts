import { describe, expect, test } from "bun:test";
import { createEscalator, type CommentRow } from "../../src/agents/escalation-loop.js";
import { parsePrompt, chooseStartupAnswer, keysToSelect } from "../../src/agents/prompt.js";
import { watchPrompts } from "../../src/agents/prompt-watch.js";
import { fingerprint } from "../../src/agents/escalate.js";

// The real prompt text from test/unit/prompt.test.ts, reused per the ticket's
// instruction not to invent new dialog text for the delivery tests.
const REAL = `This session is 2d 12h old and 673.2k tokens.
Resuming the full session will consume a substantial portion of your usage limits. We
recommend resuming from a summary.
❯ 1. Resume from summary (recommended)
  2. Resume full session as-is
  3. Don't ask me again
Enter to confirm · Esc to cancel`;

const TRUST = `──────────────────────────────
 Accessing workspace:
 /home/brooswit/butchr-workspaces/KAN-706
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team). If not, take a moment to review
 what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`;

const FREE_TEXT_MENU = `Proceed with the deploy?
❯ 1. Yes, proceed
  2. No, and tell Claude what to do differently
  3. No, exit
Enter to confirm · Esc to cancel`;

function harness(opts: { commentsFail?: boolean; delayMs?: number } = {}) {
  const sent: Array<{ pane: string; text: string }> = [];
  const posted: Array<{ issue: string; text: string }> = [];
  const logs: string[] = [];
  let clock = 0;
  let paneText = "";
  let commentRows: CommentRow[] = [];
  let nextId = 1;
  let readCalls = 0;
  const delay = () => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve());

  const escalator = createEscalator({
    read: async () => { readCalls++; return paneText; },
    send: async (pane, text) => { sent.push({ pane, text }); },
    addComment: async (issue, text) => {
      await delay();
      posted.push({ issue, text });
      commentRows = [{ id: String(nextId++), body: text, created: new Date(clock).toISOString() }, ...commentRows];
    },
    comments: async () => {
      await delay();
      if (opts.commentsFail) throw new Error("jira unreachable");
      return commentRows;
    },
    now: () => clock,
    log: (line) => logs.push(line),
  });

  // A shared, auto-incrementing tick counter — one call to poll()/notBlocked()
  // /noPrompt() is one simulated watchBlocked tick, matching production where
  // pollSeq increments once per tick regardless of what happens for any given
  // pane. Tests that need explicit control over the sequence (races, gaps)
  // can still call escalator.onBlocked/.onPoll/.onNoPrompt directly.
  let seq = 0;

  return {
    escalator, sent, posted, logs,
    setClock: (ms: number) => { clock = ms; },
    setPaneText: (t: string) => { paneText = t; },
    get readCalls() { return readCalls; },
    addHumanComment: (body: string) => {
      commentRows = [{ id: String(nextId++), body, created: new Date(clock).toISOString() }, ...commentRows];
    },
    // One "poll": pane observed blocked with a parseable prompt.
    poll: (paneId: string, issue: string | null, prompt: import("../../src/agents/prompt.js").Prompt) => {
      seq++;
      return escalator.onBlocked(paneId, issue, prompt, seq);
    },
    // One "poll": nothing (or a different set of panes) was blocked.
    notBlocked: (stillBlockedPaneIds: string[] = []) => {
      seq++;
      escalator.onPoll(seq, stillBlockedPaneIds);
    },
    // One full watchBlocked tick with MULTIPLE panes, exactly as production
    // wires it: onPoll(blockedIds) fires once, then onBlocked fires for each
    // listed pane — all sharing the SAME pollSeq. Needed whenever a test
    // cares about a pane that stays blocked WHILE ANOTHER pane's state
    // changes in the same tick; the single-pane poll()/notBlocked() helpers
    // above each consume their own pollSeq and cannot express that.
    tick: async (blockedIds: string[], calls: Array<{ paneId: string; issue: string | null; prompt: import("../../src/agents/prompt.js").Prompt }>) => {
      seq++;
      escalator.onPoll(seq, blockedIds);
      for (const c of calls) await escalator.onBlocked(c.paneId, c.issue, c.prompt, seq);
    },
    // One "poll": the pane was blocked but its text did not parse.
    noPrompt: (paneId: string, issue: string | null, text: string) => {
      seq++;
      escalator.onNoPrompt(paneId, issue, text, seq);
    },
    get seq() { return seq; },
  };
}

describe("createEscalator — debounce and once-per-fingerprint", () => {
  test("debounces: zero comments on the first tick, one on the second", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(0);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(1);
  });

  test("escalates exactly once per fingerprint across five consecutive polls", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    for (let i = 0; i < 5; i++) await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(1);
    expect(h.sent.length).toBe(0);
  });

  test("never reads the raw pane to compose the escalation — only question/options are used", async () => {
    const h = harness();
    h.setPaneText("SECRET_COMMAND_OUTPUT_LINE\n" + REAL);
    const prompt = parsePrompt(REAL)!; // caller already isolated the prompt itself
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(1);
    expect(h.readCalls).toBe(0); // escalation never calls deps.read at all
    expect(h.posted[0]!.text).not.toContain("SECRET_COMMAND_OUTPUT_LINE");
    expect(h.posted[0]!.text).toContain(prompt.question);
    for (const o of prompt.options) expect(h.posted[0]!.text).toContain(o);
  });
});

describe("createEscalator — startup dialogs never escalate", () => {
  test("a dialog chooseStartupAnswer answers is auto-answered and never reaches the escalator", async () => {
    const h = harness();
    let fire: ((p: string, seq: number) => void) | null = null;
    watchPrompts({
      onBlocked: (cb) => { fire = cb; return () => {}; },
      read: async () => TRUST,
      send: async (pane, text) => { h.sent.push({ pane, text }); },
      onPrompt: ({ prompt }) => chooseStartupAnswer(prompt) ?? undefined,
      onExposed: ({ paneId, prompt }) => h.poll(paneId, "KAN-1", prompt),
    });
    fire!("p1", 1);
    await Bun.sleep(5);
    expect(h.posted).toEqual([]);
    expect(h.sent).toEqual([{ pane: "p1", text: "\x1b[B\r" }]); // TRUST: option 2, one down + enter
  });
});

describe("createEscalator — restart idempotency", () => {
  test("adopts an existing [butchr:blocked] comment carrying the same fingerprint instead of re-posting", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    const fp = fingerprint(prompt);
    h.addHumanComment(`[butchr:blocked] KAN-1 is waiting on a decision:\n\nQ\n\n1. a\n\nfingerprint: ${fp}\n\nReply...`);
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(0); // adopted, not re-posted
  });
});

describe("createEscalator — directive delivery", () => {
  test("delivers ANSWER <n> for the numbered dialog with the exact keysToSelect string", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt); // debounce
    await h.poll("p1", "KAN-1", prompt); // escalate
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER 2 ${fp}`);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([{ pane: "p1", text: keysToSelect(prompt.current, 2) }]);
  });

  test("delivers ANSWER <n> for the un-numbered trust dialog with the exact keysToSelect string", async () => {
    const h = harness();
    h.setPaneText(TRUST);
    const prompt = parsePrompt(TRUST)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER 2 ${fp}`);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([{ pane: "p1", text: keysToSelect(prompt.current, 2) }]);
  });

  test("ANSWER TEXT selects the free-text option, sends the text, then Enter — three sends in order", async () => {
    const h = harness();
    h.setPaneText(FREE_TEXT_MENU);
    const prompt = parsePrompt(FREE_TEXT_MENU)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER TEXT run the migration first ${fp}`);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([
      { pane: "p1", text: keysToSelect(prompt.current, 2) },
      { pane: "p1", text: "run the migration first" },
      { pane: "p1", text: "\r" },
    ]);
  });

  test("ANSWER TEXT on a dialog with no free-text option sends nothing and posts an explanatory comment", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER TEXT do something else ${fp}`);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([]);
    expect(h.posted.length).toBe(2); // the escalation, then the explanation
    expect(h.posted[1]!.text).toMatch(/no free-text option/);
  });

  test("an out-of-range option number is refused with zero sends", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER 99 ${fp}`);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([]);
    expect(h.logs.some((l) => /REFUSED ANSWER 99/.test(l))).toBe(true);
  });
});

describe("createEscalator — stale fingerprint guard", () => {
  test("a directive quoting a stale fingerprint is refused, nothing is sent, and a fresh escalation posts for the current dialog", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const dialogA = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", dialogA); // debounce
    await h.poll("p1", "KAN-1", dialogA); // escalate A
    expect(h.posted.length).toBe(1);
    const fpA = fingerprint(dialogA);

    h.addHumanComment(`ANSWER 2 ${fpA}`);
    // The pane has moved on to a different dialog by the time this directive
    // is actually processed (deps.read reflects the live pane right now).
    h.setPaneText(TRUST);

    await h.poll("p1", "KAN-1", dialogA); // outer poll still reports dialog A
    expect(h.sent).toEqual([]);
    expect(h.logs.some((l) => /REFUSED directive on KAN-1: fingerprint/.test(l))).toBe(true);
    // v0.5.16: the fresh dialog is NOT escalated instantly — it must re-earn
    // the debounce like any other observation (spam containment).
    expect(h.posted.length).toBe(1);
    const dialogB = parsePrompt(TRUST)!;
    await h.poll("p1", "KAN-1", dialogB); // debounce 1
    await h.poll("p1", "KAN-1", dialogB); // debounce 2 → escalate B
    expect(h.posted.length).toBe(2);
    const fpB = fingerprint(dialogB);
    expect(h.posted[1]!.text).toContain(`fingerprint: ${fpB}`);
  });

  // KAN-756, item (D): 0.5.16 already stops the immediate re-escalation, but
  // its REFUSED branch still seeded the fresh PaneState with an EMPTY
  // actedCommentIds, so the same stale ANSWER comment was re-read and
  // re-refused every time the directive-check phase ran again — a REFUSED
  // log line plus a Jira comments fetch on a loop, forever. Consumed comment
  // ids now live outside PaneState (consumedComments, keyed by pane) so a
  // reset can never forget one.
  test("a stale ANSWER is refused exactly once, never re-parsed across 20 further polls even once a new dialog escalates and enters its own directive-check phase", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const dialogA = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", dialogA);
    await h.poll("p1", "KAN-1", dialogA); // escalate A
    const fpA = fingerprint(dialogA);
    h.addHumanComment(`ANSWER 2 ${fpA}`);
    h.setPaneText(TRUST); // the live pane has already moved on

    await h.poll("p1", "KAN-1", dialogA); // REFUSED — consumes the stale comment id
    expect(h.logs.filter((l) => /REFUSED directive on KAN-1: fingerprint/.test(l)).length).toBe(1);

    // The pane settles on the new dialog and stays there for many more
    // polls: two to earn the debounce (escalating B), then eighteen more
    // once B's own directive-check phase is running every poll — exactly
    // the shape that used to re-read and re-refuse the OLD stale comment.
    const dialogB = parsePrompt(TRUST)!;
    for (let i = 0; i < 20; i++) await h.poll("p1", "KAN-1", dialogB);

    expect(h.logs.filter((l) => /REFUSED directive on KAN-1: fingerprint/.test(l)).length).toBe(1);
    expect(h.posted.filter((c) => c.text.includes("fingerprint:")).length).toBe(2); // A, then B once
  });
});

describe("createEscalator — 15-minute follow-up", () => {
  test("fires exactly once, not before 15 minutes and not again at 30", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt); // escalates at clock=0
    expect(h.posted.length).toBe(1);

    h.setClock(14 * 60_000);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(1);

    h.setClock(15 * 60_000);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(2);

    h.setClock(30 * 60_000);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(2);
  });
});

describe("createEscalator — Jira errors never throw into the poll loop", () => {
  test("a failing comments() fetch is caught and logged, both while escalating and while checking for a directive", async () => {
    const h = harness({ commentsFail: true });
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt); // debounce
    await h.poll("p1", "KAN-1", prompt); // escalate — comments() fails, falls back to []
    expect(h.posted.length).toBe(1); // still escalates despite the failed idempotency check
    await h.poll("p1", "KAN-1", prompt); // directive check — comments() fails again
    expect(h.posted.length).toBe(1);
    expect(h.logs.filter((l) => /comments fetch failed for KAN-1: jira unreachable/.test(l)).length).toBe(2);
  });
});

describe("createEscalator — no resolvable issue", () => {
  test("a blocked pane with no issue key posts nothing and logs once", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", null, prompt);
    await h.poll("p1", null, prompt);
    await h.poll("p1", null, prompt);
    expect(h.posted).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.logs.filter((l) => /no issue key — cannot escalate/.test(l)).length).toBe(3);
  });
});

// Regression coverage for the KAN-732 review of PR #27 (blocking findings 1 & 2).
describe("createEscalator — an answer is consumed exactly once", () => {
  test("a delivered directive is never replayed while the pane stays blocked on the same dialog", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt); // debounce
    await h.poll("p1", "KAN-1", prompt); // escalate
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER 2 ${fp}`);
    await h.poll("p1", "KAN-1", prompt); // delivers — 1 send
    expect(h.sent.length).toBe(1);

    // The keystroke didn't dismiss the dialog (herdr swallowed it, or the
    // agent is slow to re-render) — the pane reports blocked on the SAME
    // dialog on every later poll. Previously this walked debounce → escalate
    // (adopting the prior comment) → directive-found → deliver, forever.
    for (let i = 0; i < 5; i++) await h.poll("p1", "KAN-1", prompt);

    expect(h.sent.length).toBe(1); // not replayed
    expect(h.posted.length).toBe(1); // no duplicate escalation posted either
  });

  test("ANSWER TEXT delivery is also consumed exactly once", async () => {
    const h = harness();
    h.setPaneText(FREE_TEXT_MENU);
    const prompt = parsePrompt(FREE_TEXT_MENU)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER TEXT run the migration first ${fp}`);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.sent.length).toBe(3);

    for (let i = 0; i < 5; i++) await h.poll("p1", "KAN-1", prompt);
    expect(h.sent.length).toBe(3); // not replayed
  });

  test("a new dialog on the same pane starts over (fingerprint change still resets state)", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const dialogA = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", dialogA);
    await h.poll("p1", "KAN-1", dialogA);
    const fpA = fingerprint(dialogA);
    h.addHumanComment(`ANSWER 2 ${fpA}`);
    await h.poll("p1", "KAN-1", dialogA);
    expect(h.sent.length).toBe(1);

    // Now a genuinely NEW dialog blocks the same pane.
    h.setPaneText(TRUST);
    const dialogB = parsePrompt(TRUST)!;
    await h.poll("p1", "KAN-1", dialogB); // debounce for the new fingerprint
    await h.poll("p1", "KAN-1", dialogB); // escalates fresh
    expect(h.posted.length).toBe(2);
  });
});

describe("createEscalator — overlapping polls never double-post", () => {
  test("two concurrent onBlocked() calls for the same pane escalate exactly once", async () => {
    const h = harness({ delayMs: 30 });
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt); // debounce (poll 1)
    // Two overlapping polls both past debounce, both racing to escalate.
    await Promise.all([
      h.poll("p1", "KAN-1", prompt),
      h.poll("p1", "KAN-1", prompt),
    ]);
    expect(h.posted.length).toBe(1);
    expect(h.logs.some((l) => /skipped overlapping poll/.test(l))).toBe(true);
  });
});

describe("createEscalator — a quoted marker doesn't silently eat a real answer", () => {
  test("an ANSWER quoting the escalation marker mid-body (not at the start) is still honored", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`Replying to the escalation:\n> [butchr:blocked] KAN-1 is waiting...\nANSWER 2 ${fp}`);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([{ pane: "p1", text: keysToSelect(prompt.current, 2) }]);
  });

  test("a comment that genuinely STARTS with the marker and quotes an ANSWER line is ignored, and logged rather than silently dropped", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`[butchr:blocked] KAN-1 is waiting on a decision:\n...\nANSWER 2 ${fp}`);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([]);
    expect(h.logs.some((l) => /ignored an answer on KAN-1 .* quotes the escalation marker/.test(l))).toBe(true);
  });
});

describe("escalation spam containment (v0.5.16)", () => {
  const BYPASS = `You are running in Bypass
 Permissions mode.
 ❯ No, exit
   Yes, I accept
 Enter to confirm · Esc to cancel`;
  async function earn(h: ReturnType<typeof harness>, pane: string, issue: string, text: string) {
    h.setPaneText(text);
    const d = parsePrompt(text)!;
    await h.poll(pane, issue, d);
    await h.poll(pane, issue, d);
  }
  test("rate cap: 4th distinct escalation within an hour becomes one notice then log-only", async () => {
    const h = harness();
    h.setClock(1_000_000);
    await earn(h, "p1", "KAN-1", REAL);
    await earn(h, "p1", "KAN-1", TRUST);
    await earn(h, "p1", "KAN-1", FREE_TEXT_MENU);
    await earn(h, "p1", "KAN-1", BYPASS);
    const escalations = h.posted.filter((c) => c.text.includes("fingerprint:"));
    const notices = h.posted.filter((c) => c.text.includes("rate cap reached"));
    expect(escalations.length).toBe(3);
    expect(notices.length).toBe(1);
    expect(h.logs.some((l) => /RATE-CAPPED/.test(l))).toBe(true);
    // a 5th change inside the hour posts nothing further at all
    const before = h.posted.length;
    await earn(h, "p1", "KAN-1", REAL);
    expect(h.posted.length).toBe(before);
  });
  test("cap window slides: after an hour, escalations post again", async () => {
    const h = harness();
    h.setClock(0);
    await earn(h, "p1", "KAN-1", REAL);
    await earn(h, "p1", "KAN-1", TRUST);
    await earn(h, "p1", "KAN-1", FREE_TEXT_MENU);
    await earn(h, "p1", "KAN-1", BYPASS);                 // capped
    h.setClock(61 * 60_000);
    // a FIFTH distinct dialog (re-using an earlier one would be adopted from
    // its existing escalation comment — correct behavior, wrong probe)
    const FIFTH = `Overwrite the existing file?
❯ 1. Yes, overwrite
  2. No, keep both
Enter to confirm · Esc to cancel`;
    await earn(h, "p1", "KAN-1", FIFTH);
    const escalations = h.posted.filter((c) => c.text.includes("fingerprint:"));
    expect(escalations.length).toBe(4);                    // posts again post-window
  });
});

// KAN-756, item (A): consecutive-poll debounce. "Consecutive" means
// consecutive polls OF THE WATCHER — a poll on which the pane is not
// blocked, or does not parse, must reset the debounce exactly like a
// different fingerprint would. Before this, PaneState was only touched when
// onBlocked fired, so a gap left blockedPolls untouched: blocked(fp X, count
// 1) → working (no call at all) → blocked(fp X, count 2) escalated, though X
// was never observed on two ACTUALLY consecutive polls.
describe("createEscalator — consecutive-poll debounce (KAN-756, item A)", () => {
  test("a stable real dialog escalates exactly once, on the second consecutive poll and not the first, and never again across 20 further polls", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(0); // not on the first poll
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(1); // escalates on the second
    for (let i = 0; i < 20; i++) await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(1); // never again
  });

  test("a churning pane — a DIFFERENT parse every poll, built from real production prose rotating under the same banner — produces zero escalations across 10+ polls", async () => {
    const h = harness();
    // RECONSTRUCTED from KAN-755's own escalation comments (see
    // test/unit/prompt.test.ts for provenance) — real fps, rotating prose,
    // same options, exactly the shape that fooled the pre-(B) parser.
    const variants = [
      `● Now I'll file the implementation task with the full context.\nCalling butchr… (ctrl+o to expand)\n\nTry the new fullscreen renderer?\n\n1. Yes, try it\n2. Not now\nEnter to confirm · Esc to cancel`,
      `● Now I'll file the implementation task with the full context.\n● Calling butchr… (ctrl+o to expand)\n\nTry the new fullscreen renderer?\n\n1. Yes, try it\n2. Not now\nEnter to confirm · Esc to cancel`,
      `✻ Worked for 1m 51s · done 4:57 PM\n← butchr: [butchr] Ticket KAN-755 was updated — re-read it.\n\nTry the new fullscreen renderer?\n\n1. Yes, try it\n2. Not now\nEnter to confirm · Esc to cancel`,
    ];
    // NOTE: these fixtures carry a footer so (A)'s debounce is exercised in
    // isolation from (B)'s parser gate — (B) is proven separately in
    // test/unit/prompt.test.ts against footerless captures. A real churning
    // pane is stopped by BOTH layers; this test proves (A) alone still
    // closes mechanism (1) for any dialog-shaped prose that keeps changing.
    for (let i = 0; i < 12; i++) {
      const text = variants[i % variants.length]!;
      const prompt = parsePrompt(text)!;
      await h.poll("p1", "KAN-1", prompt);
    }
    expect(h.posted.length).toBe(0);
    expect(h.sent.length).toBe(0);
  });

  test("a flickering pane (blocked fp X, not blocked, blocked fp X) escalates zero times; the same fp on the two polls after that escalates exactly once", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);     // poll 1: blocked fp X
    h.notBlocked([]);                         // poll 2: pane not blocked at all
    await h.poll("p1", "KAN-1", prompt);     // poll 3: blocked fp X again — NOT consecutive with poll 1
    expect(h.posted.length).toBe(0);
    await h.poll("p1", "KAN-1", prompt);     // poll 4: consecutive with poll 3
    expect(h.posted.length).toBe(1);
  });

  test("a pane blocked with fp X, then blocked again with fp X but reported alongside OTHER panes (not itself) on an intervening poll, still resets", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    h.notBlocked(["p2"]); // p1 is not in the blocked set this tick — p2 is irrelevant
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(0); // reset by the gap, same as the flicker case
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(1);
  });

  test("onPoll does not reset a pane that IS in the blocked set — a normal tick between two onBlocked calls never breaks the debounce", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    // Mirrors production: watchBlocked's onTick fires for EVERY tick,
    // including the ones where this pane goes on to escalate.
    h.notBlocked(["p1"]);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(0);
  });

  test("two panes are debounced independently — one's gap does not touch the other's count", async () => {
    const h = harness();
    // Distinct dialogs (distinct fingerprints) on purpose: the harness's
    // comments() fake isn't issue-scoped, so two issues escalating the SAME
    // fingerprint would make the second "adopt" the first's comment — a test
    // fake artefact, not a production behavior, and irrelevant to what this
    // test checks (debounce independence).
    const promptA = parsePrompt(REAL)!;
    const promptB = parsePrompt(TRUST)!;
    // Tick 1: both panes blocked (first observation each).
    await h.tick(["p1", "p2"], [
      { paneId: "p1", issue: "KAN-1", prompt: promptA },
      { paneId: "p2", issue: "KAN-2", prompt: promptB },
    ]);
    // Tick 2: only p2 is blocked — p1 drops out (and is reset by onPoll),
    // p2 gets its second CONSECUTIVE observation and escalates.
    await h.tick(["p2"], [{ paneId: "p2", issue: "KAN-2", prompt: promptB }]);
    expect(h.posted.filter((c) => c.issue === "KAN-2").length).toBe(1);
    expect(h.posted.filter((c) => c.issue === "KAN-1").length).toBe(0);
    // p1 restarts from zero after its gap: needs two more consecutive polls.
    await h.poll("p1", "KAN-1", promptA);
    expect(h.posted.filter((c) => c.issue === "KAN-1").length).toBe(0);
    await h.poll("p1", "KAN-1", promptA);
    expect(h.posted.filter((c) => c.issue === "KAN-1").length).toBe(1);
  });
});

// KAN-756, item (C): a blocked pane whose text does not parse as a dialog
// must never be silently dropped. Deduplicated by distinct text so this
// cannot become its own spam source, but every debounce reset it causes must
// still be visible.
describe("createEscalator — unparseable blocked panes (KAN-756, item C)", () => {
  test("N polls of the same unparseable text produce exactly one [prompts] line; a changed text produces a second", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.noPrompt("p1", "KAN-1", "some working prose, no dialog here");
    expect(h.logs.filter((l) => /blocked with no parseable dialog/.test(l)).length).toBe(1);
    h.noPrompt("p1", "KAN-1", "different working prose, still no dialog");
    expect(h.logs.filter((l) => /blocked with no parseable dialog/.test(l)).length).toBe(2);
    for (let i = 0; i < 5; i++) h.noPrompt("p1", "KAN-1", "different working prose, still no dialog");
    expect(h.logs.filter((l) => /blocked with no parseable dialog/.test(l)).length).toBe(2);
  });

  test("resets the debounce for a pane that had a stable fp going, exactly like a gap", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt); // poll 1: blocked fp X (1/2)
    h.noPrompt("p1", "KAN-1", "garbled scroll, unparseable"); // poll 2: no prompt
    await h.poll("p1", "KAN-1", prompt); // poll 3: blocked fp X again — not consecutive
    expect(h.posted.length).toBe(0);
    await h.poll("p1", "KAN-1", prompt); // poll 4: consecutive with poll 3
    expect(h.posted.length).toBe(1);
  });

  test("does not log a reset for a pane it has never seen blocked", () => {
    const h = harness();
    h.noPrompt("p1", "KAN-1", "never blocked before");
    expect(h.logs.some((l) => /debounce reset/.test(l))).toBe(false);
    expect(h.logs.some((l) => /blocked with no parseable dialog/.test(l))).toBe(true);
  });
});
