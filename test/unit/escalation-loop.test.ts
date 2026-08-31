import { describe, expect, test } from "bun:test";
import { createEscalator, type CommentRow } from "../../src/agents/escalation-loop.js";
import { parsePrompt, chooseStartupAnswer, keysToSelect } from "../../src/agents/prompt.js";
import { watchPrompts } from "../../src/agents/prompt-watch.js";
import { fingerprint } from "../../src/agents/escalate.js";
import { tellWorker } from "../../src/tools/relationship.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

/**
 * BUTCHR-45: the REAL tell_worker/tagComment construction (src/tools/
 * relationship.ts) — a boss (`bossKey`) replying on one of its worker's
 * tickets, exactly the intended downward channel for an ANSWER. Returns the
 * body `addComment` actually received (a leading `[bossKey] ` tag), not a
 * hand-typed `"[KEY] ANSWER ..."` literal standing in for the real path.
 */
async function taggedReply(bossKey: string, workerKey: string, text: string): Promise<string> {
  let captured = "";
  const ops = {
    getIssue: async () => ({ fields: { issuelinks: [{ type: { name: "Implements" }, inwardIssue: { key: bossKey } }] } }),
    addComment: async (_key: string, body: string) => { captured = body; },
  } as unknown as AtlassianOps;
  await tellWorker(ops, bossKey, workerKey, text);
  return captured;
}

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

/** In-memory CaptureSink fake — no real fs, mirrors capture-store.ts's contract. */
function fakeCaptureSink() {
  const files = new Map<string, string>();
  return {
    files,
    sink: {
      write: async (name: string, contents: string) => { files.set(name, contents); return `/fake-captures/${name}`; },
      list: async () => [...files.keys()],
      remove: async (name: string) => { files.delete(name); },
    },
  };
}

function harness(opts: { commentsFail?: boolean; delayMs?: number; captures?: ReturnType<typeof fakeCaptureSink>["sink"] } = {}) {
  const sent: Array<{ pane: string; text: string }> = [];
  const posted: Array<{ issue: string; text: string }> = [];
  const logs: string[] = [];
  let clock = 0;
  let paneText = "";
  let commentRows: CommentRow[] = [];
  let nextId = 1;
  let readCalls = 0;
  let commentsCalls = 0;
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
      commentsCalls++;
      await delay();
      if (opts.commentsFail) throw new Error("jira unreachable");
      return commentRows;
    },
    now: () => clock,
    log: (line) => logs.push(line),
    ...(opts.captures ? { captures: opts.captures } : {}),
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
    get commentsCalls() { return commentsCalls; },
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

describe("createEscalator — identity-tagged directives (BUTCHR-45)", () => {
  // BUTCHR-44: an ANSWER sent as the entire comment body — the terse form the
  // escalation comment itself asks for — is silently dropped once the
  // identity tag every jira_add_comment/tell_worker reply carries lands in
  // front of it (a single line reading "[KEY] ANSWER 2 abc12345" never
  // STARTS with "ANSWER "). These reproduce the bug end-to-end through the
  // real tagging construction (taggedReply -> tell_worker -> tagComment),
  // proving delivery actually happens now, not just that parseDirective
  // returns a value in isolation.
  test("a terse ANSWER <n>, tagged via the real tell_worker construction, is delivered", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt); // debounce
    await h.poll("p1", "KAN-1", prompt); // escalate
    const fp = fingerprint(prompt);
    const tagged = await taggedReply("BOSS-1", "KAN-1", `ANSWER 2 ${fp}`);
    expect(tagged).toBe(`[BOSS-1] ANSWER 2 ${fp}`); // sanity: this IS the tagged, single-line, terse form
    h.addHumanComment(tagged);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([{ pane: "p1", text: keysToSelect(prompt.current, 2) }]);
  });

  test("a tagged ANSWER TEXT is delivered too — selects the free-text option, sends the text, then Enter", async () => {
    const h = harness();
    h.setPaneText(FREE_TEXT_MENU);
    const prompt = parsePrompt(FREE_TEXT_MENU)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(await taggedReply("BOSS-1", "KAN-1", `ANSWER TEXT run the migration first ${fp}`));
    await h.poll("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([
      { pane: "p1", text: keysToSelect(prompt.current, 2) },
      { pane: "p1", text: "run the migration first" },
      { pane: "p1", text: "\r" },
    ]);
  });

  test("negative: a tagged ANSWER carrying a stale fingerprint is refused — nothing sent", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const dialogA = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", dialogA); // debounce
    await h.poll("p1", "KAN-1", dialogA); // escalate A
    const fpA = fingerprint(dialogA);
    h.addHumanComment(await taggedReply("BOSS-1", "KAN-1", `ANSWER 2 ${fpA}`));
    // The pane has moved on to a different dialog by the time this directive
    // is actually processed, exactly like the untagged stale-fingerprint test
    // above — the fp verification lives in handleDirective, downstream of
    // (and unaffected by) the tag-stripping fix.
    h.setPaneText(TRUST);
    await h.poll("p1", "KAN-1", dialogA);
    expect(h.sent).toEqual([]);
    expect(h.logs.some((l) => /REFUSED directive on KAN-1: fingerprint/.test(l))).toBe(true);
  });

  test("negative: a tagged ANSWER quoted mid-sentence inside prose still does not fire", async () => {
    const h = harness();
    h.setPaneText(REAL);
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    const fp = fingerprint(prompt);
    h.addHumanComment(await taggedReply("BOSS-1", "KAN-1", `quoting the dialog above: ANSWER 2 ${fp}`));
    await h.poll("p1", "KAN-1", prompt);
    expect(h.sent).toEqual([]);
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

// KAN-756, items (E) and (F): conformance to the story's original spec that
// v0.5.16 did not fully meet (KAN-755 comment 14869, ruled in scope by the
// epic). The cap is per PANE — v0.5.16 keyed it by issue despite the spec
// and despite the variable being named paneEscalations — and an escalation
// ADOPTED after a daemon restart counts toward the budget, which v0.5.16's
// adoption branch skipped entirely (it returned before the cap block).
describe("escalation spam containment (KAN-756, items E and F)", () => {
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

  test("(E) the cap is keyed per PANE, not per issue: a second pane on the SAME issue is unaffected by the first pane's cap", async () => {
    const h = harness();
    h.setClock(1_000_000);
    // p1 gets capped on KAN-1: 3 escalations + 1 summary notice.
    await earn(h, "p1", "KAN-1", REAL);
    await earn(h, "p1", "KAN-1", TRUST);
    await earn(h, "p1", "KAN-1", FREE_TEXT_MENU);
    await earn(h, "p1", "KAN-1", BYPASS);
    expect(h.posted.filter((c) => c.text.includes("rate cap reached")).length).toBe(1);
    const before = h.posted.length;

    // p2 — a DIFFERENT pane, e.g. the same agent's pane recreated by the
    // herd — but the SAME issue key. Under per-ISSUE keying this would
    // still be capped (0.5.16's bug); under per-PANE keying it is a fresh
    // budget.
    const FRESH = `Overwrite the existing file?
❯ 1. Yes, overwrite
  2. No, keep both
Enter to confirm · Esc to cancel`;
    await earn(h, "p2", "KAN-1", FRESH);
    const newEscalations = h.posted.slice(before).filter((c) => c.text.includes("fingerprint:"));
    expect(newEscalations.length).toBe(1); // p2 escalated normally, not capped
    expect(h.posted.filter((c) => c.text.includes("rate cap reached")).length).toBe(1); // still just the one notice, from p1
  });

  test("(F) an escalation ADOPTED after a restart counts toward the cap: 3 adopted + a 4th distinct dialog posts the summary, not a 4th escalation", async () => {
    const h = harness();
    h.setClock(1_000_000);
    const dialogs = [REAL, TRUST, FREE_TEXT_MENU];
    const fps = dialogs.map((t) => fingerprint(parsePrompt(t)!));
    // Simulate a restart: these 3 escalation comments already exist on the
    // issue (posted by a prior daemon instance) BEFORE this daemon instance
    // ever calls onBlocked for them.
    for (const fp of fps) {
      h.addHumanComment(`[butchr:blocked] KAN-1 is waiting on a decision:\n\nQ\n\n1. a\n2. b\n\nfingerprint: ${fp}\n\nReply...`);
    }
    for (const text of dialogs) {
      await earn(h, "p1", "KAN-1", text); // each hits the "adopted" branch — zero NEW posts
    }
    expect(h.posted.length).toBe(0); // nothing posted yet — all 3 were adopted, not posted
    expect(h.logs.filter((l) => /adopted existing escalation/.test(l)).length).toBe(3);

    // A 4th, genuinely DISTINCT dialog: the budget is already spent by the
    // 3 adoptions, so this must be capped, not escalated.
    await earn(h, "p1", "KAN-1", BYPASS);
    const escalations = h.posted.filter((c) => c.text.includes("fingerprint:"));
    const notices = h.posted.filter((c) => c.text.includes("rate cap reached"));
    expect(escalations.length).toBe(0);
    expect(notices.length).toBe(1);
    expect(h.logs.some((l) => /RATE-CAPPED/.test(l))).toBe(true);
  });
});

// KAN-756 PR #40 review, Finding 2 (comments 14969/14976/14983): item (A)'s
// onPoll/onNoPrompt used to fully DELETE a pane's PaneState the moment it
// was reported not-blocked (or unparseable) — including escalatedAt and
// followedUpAt, which have nothing to do with the debounce. On a pane that
// had ALREADY escalated, one flickering poll made it forget entirely:
// - the 15-minute follow-up (KAN-732's contract) never fires on a
//   flickering pane, because the adoption branch `return`s as soon as it
//   sets escalatedAt, so the follow-up check further down handleBlocked is
//   never reached on that poll — and the NEXT flicker deletes the state
//   again before any later poll can reach it either. Measured on the
//   pre-fix branch: 1 escalation, 3 flickers, clock past 15 minutes, 3 more
//   flickers → zero follow-ups, ever.
// - the re-discovery round-trip through escalate()'s "adopted existing"
//   branch on every flicker double-counts the rate-cap budget (found
//   first; the id-dedupe alone was the initially proposed fix, but the
//   epic ruled the deeper fix — state must survive the flicker at all —
//   is what closes it, since a re-adoption should not need to happen for
//   an in-memory pane in the first place).
//
// FIX: a poll on which the pane is not reported blocked (or is blocked but
// unparseable) resets ONLY the debounce fields (blockedPolls, lastPollSeq)
// in place — never deletes the entry. handleBlocked carries escalatedAt/
// followedUpAt forward whenever the SAME fingerprint reappears after such
// a gap (newState() alone would zero them right back out). A genuinely
// DIFFERENT fingerprint still gets a full, clean reset — that contract is
// unchanged and pinned below. The id-dedupe from the first round of review
// stays as the backstop for a genuine daemon restart, which has no
// in-memory state to preserve in the first place.
describe("createEscalator — escalated state survives a flicker (KAN-756 PR #40 review, Finding 2)", () => {
  test("the 15-minute follow-up fires exactly once on a pane that flickers repeatedly, not zero and not once per flicker", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt); // escalates at clock=0
    expect(h.posted.length).toBe(1);

    // Flicker: not blocked, then blocked again with the SAME dialog — three
    // times, before the follow-up window elapses.
    for (let i = 0; i < 3; i++) {
      h.notBlocked([]);
      await h.poll("p1", "KAN-1", prompt);
    }
    expect(h.posted.length).toBe(1); // still just the one escalation

    h.setClock(15 * 60_000);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(2); // exactly one follow-up
    expect(h.posted[1]!.text).toMatch(/still waiting on the decision/);

    // Three more flickers past the follow-up: still exactly one, not a
    // second.
    for (let i = 0; i < 3; i++) {
      h.notBlocked([]);
      await h.poll("p1", "KAN-1", prompt);
    }
    expect(h.posted.length).toBe(2);
  });

  test("flickers on an already-escalated pane cost exactly one comments() fetch per blocked poll — no extra re-adoption round-trip on top", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt); // debounce — no comments() call yet
    expect(h.commentsCalls).toBe(0);
    await h.poll("p1", "KAN-1", prompt); // escalates — 1 comments() call (idempotency check)
    expect(h.commentsCalls).toBe(1);

    for (let i = 1; i <= 5; i++) {
      h.notBlocked([]); // no comments() call — nothing blocked this tick
      await h.poll("p1", "KAN-1", prompt); // directive-check phase — exactly 1 more
      expect(h.commentsCalls).toBe(1 + i);
    }
    // If escalatedAt had been lost on any flicker, that poll would instead
    // re-enter escalate() and ALSO adopt — still one comments() call, but
    // with an "adopted existing escalation" log line and a second entry in
    // the rate-cap budget. Neither happened.
    expect(h.logs.filter((l) => /adopted existing escalation/.test(l)).length).toBe(0);
    expect(h.posted.length).toBe(1); // never re-escalated
  });

  test("a flicker followed by a NEW distinct dialog escalates it normally, with no rate-cap notice (the original Finding 2 probe)", async () => {
    const h = harness();
    const dialogA = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", dialogA);
    await h.poll("p1", "KAN-1", dialogA); // escalate A
    expect(h.posted.length).toBe(1);

    for (let i = 0; i < 3; i++) {
      h.notBlocked([]);
      await h.poll("p1", "KAN-1", dialogA);
    }
    expect(h.posted.length).toBe(1); // still just A, no re-adoption round-trips

    const dialogB = parsePrompt(TRUST)!;
    await h.poll("p1", "KAN-1", dialogB);
    await h.poll("p1", "KAN-1", dialogB); // escalate B — genuinely new fp
    const escalations = h.posted.filter((c) => c.text.includes("fingerprint:"));
    const notices = h.posted.filter((c) => c.text.includes("rate cap reached"));
    expect(escalations.length).toBe(2); // A and B, both real escalations
    expect(notices.length).toBe(0); // budget was never inflated by the flickers
  });

  test("a DIFFERENT fingerprint after a gap still starts over completely — the carry-over is keyed on the SAME fp, nothing looser", async () => {
    const h = harness();
    const dialogA = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", dialogA);
    await h.poll("p1", "KAN-1", dialogA); // escalate A
    expect(h.posted.length).toBe(1);

    h.notBlocked([]); // gap
    const dialogB = parsePrompt(TRUST)!;
    await h.poll("p1", "KAN-1", dialogB); // a DIFFERENT fp after the gap
    expect(h.posted.length).toBe(1); // does not inherit A's escalatedAt — must re-earn the debounce
    await h.poll("p1", "KAN-1", dialogB);
    expect(h.posted.length).toBe(2); // B escalates fresh, on its own two consecutive polls
  });

  test("re-adopting the SAME comment (dialog A, then B, then A again) counts toward the rate-cap budget only once — the id-dedupe backstop", async () => {
    const h = harness();
    h.setClock(1_000_000);
    const dialogA = parsePrompt(REAL)!;
    const dialogB = parsePrompt(TRUST)!;
    await h.poll("p1", "KAN-1", dialogA);
    await h.poll("p1", "KAN-1", dialogA); // escalate A — 1 posted, 1 budget entry
    await h.poll("p1", "KAN-1", dialogB);
    await h.poll("p1", "KAN-1", dialogB); // escalate B — 2 posted, 2 budget entries (genuinely distinct)
    expect(h.posted.filter((c) => c.text.includes("fingerprint:")).length).toBe(2);

    // Dialog A reappears (fp changed away and back — a real, reachable
    // sequence, not a restart): its escalation comment already exists, so
    // this ADOPTS rather than reposts. Without the id-dedupe backstop this
    // would push a THIRD entry into the budget for only two real comments.
    await h.poll("p1", "KAN-1", dialogA);
    await h.poll("p1", "KAN-1", dialogA);
    expect(h.logs.some((l) => /adopted existing escalation/.test(l))).toBe(true);
    expect(h.posted.filter((c) => c.text.includes("fingerprint:")).length).toBe(2); // no new comment

    // Two more genuinely distinct dialogs: the budget has room for exactly
    // ONE more (2 real entries so far, cap is 3) before the notice fires —
    // proving the A-re-adoption above did NOT count as a third.
    const dialogC = `Deploy to prod?\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel`;
    const dialogD = `Overwrite the file?\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel`;
    await h.poll("p1", "KAN-1", parsePrompt(dialogC)!);
    await h.poll("p1", "KAN-1", parsePrompt(dialogC)!); // 3rd real entry — still escalates, no cap yet
    expect(h.posted.filter((c) => c.text.includes("fingerprint:")).length).toBe(3);
    await h.poll("p1", "KAN-1", parsePrompt(dialogD)!);
    await h.poll("p1", "KAN-1", parsePrompt(dialogD)!); // 4th — now the cap engages
    expect(h.posted.filter((c) => c.text.includes("fingerprint:")).length).toBe(3);
    expect(h.posted.filter((c) => c.text.includes("rate cap reached")).length).toBe(1);
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

// BUTCHR-16: the escalation carries the pane text via a durable local capture
// (never raw text in the Jira comment itself), so the NEXT unknown shape can
// be fixtured from the escalation — the fixture for the effort-recommendation
// dialog that opened this ticket is otherwise gone for good.
describe("createEscalator — escalation captures the full pane text (BUTCHR-16)", () => {
  test("with no captures dep configured, behaves exactly as before: no capture, no path in the comment", async () => {
    const h = harness();
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(1);
    expect(h.posted[0]!.text).not.toContain("captured to");
  });

  test("on a fresh escalation, the FULL raw pane text (not just question/options) is written to the capture store, unredacted, and only the PATH reaches the Jira comment", async () => {
    const cap = fakeCaptureSink();
    const h = harness({ captures: cap.sink });
    const SECRET_PANE = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n" + REAL;
    h.setPaneText(SECRET_PANE);
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt); // debounce
    await h.poll("p1", "KAN-1", prompt); // escalates
    expect(h.posted.length).toBe(1);

    expect(cap.files.size).toBe(1);
    const [name, contents] = [...cap.files.entries()][0]!;
    expect(name).toMatch(/^KAN-1-escalation-\d{8}T\d{6}Z\.txt$/);
    expect(contents).toContain(SECRET_PANE); // full pane text, UNREDACTED, on local disk
    expect(contents).toContain("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI"); // the raw secret, deliberately (local-disk-only)

    const path = `/fake-captures/${name}`;
    expect(h.posted[0]!.text).toContain(path);
    expect(h.posted[0]!.text).not.toContain(SECRET_PANE); // the Jira comment never gets the raw text
    expect(h.posted[0]!.text).not.toContain("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI"); // nor the secret
  });

  test("an ADOPTED escalation (daemon restart) does not capture again", async () => {
    const cap = fakeCaptureSink();
    const h = harness({ captures: cap.sink });
    const prompt = parsePrompt(REAL)!;
    const fp = fingerprint(prompt);
    h.addHumanComment(`[butchr:blocked] KAN-1 is waiting on a decision:\n\nQ\n\n1. a\n\nfingerprint: ${fp}\n\nReply...`);
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(0); // adopted, not posted
    expect(cap.files.size).toBe(0); // and nothing captured for an adoption
  });

  test("a RATE-CAPPED escalation does not capture", async () => {
    const cap = fakeCaptureSink();
    const h = harness({ captures: cap.sink });
    h.setClock(1_000_000);
    const TRUST = `You are running in Bypass\n Permissions mode.\n ❯ No, exit\n   Yes, I accept\n Enter to confirm · Esc to cancel`;
    const FREE_TEXT_MENU = `Proceed with the deploy?\n❯ 1. Yes, proceed\n  2. No, and tell Claude what to do differently\n  3. No, exit\nEnter to confirm · Esc to cancel`;
    const BYPASS = `Overwrite?\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel`;
    async function earn(text: string) {
      h.setPaneText(text);
      const d = parsePrompt(text)!;
      await h.poll("p1", "KAN-1", d);
      await h.poll("p1", "KAN-1", d);
    }
    await earn(REAL);
    await earn(TRUST);
    await earn(FREE_TEXT_MENU);
    const before = cap.files.size;
    await earn(BYPASS); // 4th distinct dialog: rate-capped, not escalated
    expect(h.posted.filter((c) => c.text.includes("rate cap reached")).length).toBe(1);
    expect(cap.files.size).toBe(before); // no new capture for the capped notice
  });

  test("evicts the oldest capture, by timestamp, once at the file cap", async () => {
    const cap = fakeCaptureSink();
    // Pre-populate 50 (the cap) recognizable escalation captures, oldest first by name/timestamp.
    for (let i = 0; i < 50; i++) {
      const ts = `202601${String(i + 1).padStart(2, "0")}T000000Z`;
      cap.files.set(`KAN-1-escalation-${ts}.txt`, "old capture");
    }
    const oldestName = "KAN-1-escalation-20260101T000000Z.txt";
    expect(cap.files.has(oldestName)).toBe(true);
    const h = harness({ captures: cap.sink });
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt); // escalates — pushes past the cap
    expect(h.posted.length).toBe(1);
    expect(cap.files.has(oldestName)).toBe(false); // evicted
    expect(cap.files.size).toBe(50); // 49 kept + 1 new
  });

  test("a capture failure is logged and never blocks the escalation comment from posting", async () => {
    const failingSink = {
      write: async (): Promise<string> => { throw new Error("disk full"); },
      list: async () => [] as string[],
      remove: async () => {},
    };
    const h = harness({ captures: failingSink });
    const prompt = parsePrompt(REAL)!;
    await h.poll("p1", "KAN-1", prompt);
    await h.poll("p1", "KAN-1", prompt);
    expect(h.posted.length).toBe(1); // still escalates
    expect(h.posted[0]!.text).not.toContain("captured to");
    expect(h.logs.some((l) => /escalation capture failed/.test(l))).toBe(true);
  });
});
