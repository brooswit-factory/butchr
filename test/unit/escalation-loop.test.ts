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

  return {
    escalator, sent, posted, logs,
    setClock: (ms: number) => { clock = ms; },
    setPaneText: (t: string) => { paneText = t; },
    get readCalls() { return readCalls; },
    addHumanComment: (body: string) => {
      commentRows = [{ id: String(nextId++), body, created: new Date(clock).toISOString() }, ...commentRows];
    },
  };
}

describe("createEscalator — debounce and once-per-fingerprint", () => {
  test("debounces: zero comments on the first tick, one on the second", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(0);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(1);
  });

  test("escalates exactly once per fingerprint across five consecutive polls", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    for (let i = 0; i < 5; i++) await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(1);
    expect(h.sent.length).toBe(0);
  });

  test("never reads the raw pane to compose the escalation — only question/options are used", async () => {
    const h = harness();
    h.setPaneText("SECRET_COMMAND_OUTPUT_LINE\n" + REAL);
    const prompt = parsePrompt(REAL)!; // caller already isolated the prompt itself
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
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
    let fire: ((p: string) => void) | null = null;
    watchPrompts({
      onBlocked: (cb) => { fire = cb; return () => {}; },
      read: async () => TRUST,
      send: async (pane, text) => { h.sent.push({ pane, text }); },
      onPrompt: ({ prompt }) => chooseStartupAnswer(prompt) ?? undefined,
      onExposed: ({ paneId, prompt }) => h.escalator.onBlocked(paneId, "KAN-1", prompt),
    });
    fire!("p1");
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
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(0); // adopted, not re-posted
  });
});

describe("createEscalator — directive delivery", () => {
  test("delivers ANSWER <n> for the numbered dialog with the exact keysToSelect string", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const prompt = parsePrompt(REAL)!;
    await h.escalator.onBlocked("p1", "KAN-1", prompt); // debounce
    await h.escalator.onBlocked("p1", "KAN-1", prompt); // escalate
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER 2 ${fp}`);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([{ pane: "p1", text: keysToSelect(prompt.current, 2) }]);
  });

  test("delivers ANSWER <n> for the un-numbered trust dialog with the exact keysToSelect string", async () => {
    const h = harness();
    h.setPaneText(TRUST);
    const prompt = parsePrompt(TRUST)!;
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER 2 ${fp}`);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([{ pane: "p1", text: keysToSelect(prompt.current, 2) }]);
  });

  test("ANSWER TEXT selects the free-text option, sends the text, then Enter — three sends in order", async () => {
    const h = harness();
    h.setPaneText(FREE_TEXT_MENU);
    const prompt = parsePrompt(FREE_TEXT_MENU)!;
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER TEXT run the migration first ${fp}`);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
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
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER TEXT do something else ${fp}`);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([]);
    expect(h.posted.length).toBe(2); // the escalation, then the explanation
    expect(h.posted[1]!.text).toMatch(/no free-text option/);
  });

  test("an out-of-range option number is refused with zero sends", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const prompt = parsePrompt(REAL)!;
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER 99 ${fp}`);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([]);
    expect(h.logs.some((l) => /REFUSED ANSWER 99/.test(l))).toBe(true);
  });
});

describe("createEscalator — stale fingerprint guard", () => {
  test("a directive quoting a stale fingerprint is refused, nothing is sent, and a fresh escalation posts for the current dialog", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const dialogA = parsePrompt(REAL)!;
    await h.escalator.onBlocked("p1", "KAN-1", dialogA); // debounce
    await h.escalator.onBlocked("p1", "KAN-1", dialogA); // escalate A
    expect(h.posted.length).toBe(1);
    const fpA = fingerprint(dialogA);

    h.addHumanComment(`ANSWER 2 ${fpA}`);
    // The pane has moved on to a different dialog by the time this directive
    // is actually processed (deps.read reflects the live pane right now).
    h.setPaneText(TRUST);

    await h.escalator.onBlocked("p1", "KAN-1", dialogA); // outer poll still reports dialog A
    expect(h.sent).toEqual([]);
    expect(h.logs.some((l) => /REFUSED directive on KAN-1: fingerprint/.test(l))).toBe(true);
    expect(h.posted.length).toBe(2);
    const fpB = fingerprint(parsePrompt(TRUST)!);
    expect(h.posted[1]!.text).toContain(`fingerprint: ${fpB}`);
  });
});

describe("createEscalator — 15-minute follow-up", () => {
  test("fires exactly once, not before 15 minutes and not again at 30", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    await h.escalator.onBlocked("p1", "KAN-1", prompt); // escalates at clock=0
    expect(h.posted.length).toBe(1);

    h.setClock(14 * 60_000);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(1);

    h.setClock(15 * 60_000);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(2);

    h.setClock(30 * 60_000);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(2);
  });
});

describe("createEscalator — Jira errors never throw into the poll loop", () => {
  test("a failing comments() fetch is caught and logged, both while escalating and while checking for a directive", async () => {
    const h = harness({ commentsFail: true });
    const prompt = parsePrompt(REAL)!;
    await h.escalator.onBlocked("p1", "KAN-1", prompt); // debounce
    await h.escalator.onBlocked("p1", "KAN-1", prompt); // escalate — comments() fails, falls back to []
    expect(h.posted.length).toBe(1); // still escalates despite the failed idempotency check
    await h.escalator.onBlocked("p1", "KAN-1", prompt); // directive check — comments() fails again
    expect(h.posted.length).toBe(1);
    expect(h.logs.filter((l) => /comments fetch failed for KAN-1: jira unreachable/.test(l)).length).toBe(2);
  });
});

describe("createEscalator — no resolvable issue", () => {
  test("a blocked pane with no issue key posts nothing and logs once", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.escalator.onBlocked("p1", null, prompt);
    await h.escalator.onBlocked("p1", null, prompt);
    await h.escalator.onBlocked("p1", null, prompt);
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
    await h.escalator.onBlocked("p1", "KAN-1", prompt); // debounce
    await h.escalator.onBlocked("p1", "KAN-1", prompt); // escalate
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER 2 ${fp}`);
    await h.escalator.onBlocked("p1", "KAN-1", prompt); // delivers — 1 send
    expect(h.sent.length).toBe(1);

    // The keystroke didn't dismiss the dialog (herdr swallowed it, or the
    // agent is slow to re-render) — the pane reports blocked on the SAME
    // dialog on every later poll. Previously this walked debounce → escalate
    // (adopting the prior comment) → directive-found → deliver, forever.
    for (let i = 0; i < 5; i++) await h.escalator.onBlocked("p1", "KAN-1", prompt);

    expect(h.sent.length).toBe(1); // not replayed
    expect(h.posted.length).toBe(1); // no duplicate escalation posted either
  });

  test("ANSWER TEXT delivery is also consumed exactly once", async () => {
    const h = harness();
    h.setPaneText(FREE_TEXT_MENU);
    const prompt = parsePrompt(FREE_TEXT_MENU)!;
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`ANSWER TEXT run the migration first ${fp}`);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.sent.length).toBe(3);

    for (let i = 0; i < 5; i++) await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.sent.length).toBe(3); // not replayed
  });

  test("a new dialog on the same pane starts over (fingerprint change still resets state)", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const dialogA = parsePrompt(REAL)!;
    await h.escalator.onBlocked("p1", "KAN-1", dialogA);
    await h.escalator.onBlocked("p1", "KAN-1", dialogA);
    const fpA = fingerprint(dialogA);
    h.addHumanComment(`ANSWER 2 ${fpA}`);
    await h.escalator.onBlocked("p1", "KAN-1", dialogA);
    expect(h.sent.length).toBe(1);

    // Now a genuinely NEW dialog blocks the same pane.
    h.setPaneText(TRUST);
    const dialogB = parsePrompt(TRUST)!;
    await h.escalator.onBlocked("p1", "KAN-1", dialogB); // debounce for the new fingerprint
    await h.escalator.onBlocked("p1", "KAN-1", dialogB); // escalates fresh
    expect(h.posted.length).toBe(2);
  });
});

describe("createEscalator — overlapping polls never double-post", () => {
  test("two concurrent onBlocked() calls for the same pane escalate exactly once", async () => {
    const h = harness({ delayMs: 30 });
    const prompt = parsePrompt(REAL)!;
    await h.escalator.onBlocked("p1", "KAN-1", prompt); // debounce (poll 1)
    // Two overlapping polls both past debounce, both racing to escalate.
    await Promise.all([
      h.escalator.onBlocked("p1", "KAN-1", prompt),
      h.escalator.onBlocked("p1", "KAN-1", prompt),
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
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`Replying to the escalation:\n> [butchr:blocked] KAN-1 is waiting...\nANSWER 2 ${fp}`);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([{ pane: "p1", text: keysToSelect(prompt.current, 2) }]);
  });

  test("a comment that genuinely STARTS with the marker and quotes an ANSWER line is ignored, and logged rather than silently dropped", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const prompt = parsePrompt(REAL)!;
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(`[butchr:blocked] KAN-1 is waiting on a decision:\n...\nANSWER 2 ${fp}`);
    await h.escalator.onBlocked("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([]);
    expect(h.logs.some((l) => /ignored an answer on KAN-1 .* quotes the escalation marker/.test(l))).toBe(true);
  });
});
