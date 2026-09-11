import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { detectSessionLimitRefusal, classifySessionLimitText } from "../../src/agents/session-limit.js";
import { parsePrompt } from "../../src/agents/prompt.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const fixtureBytes = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

describe("detectSessionLimitRefusal", () => {
  // BUTCHR-259: `pane-cap-session-limit.txt` used to be a hand-built, bare
  // "You've hit…" line with no tool-result prefix at all — a shape that, per
  // the epic's own measurement, NEVER occurs in production (every real
  // banner is `⎿`-prefixed). This is now a REAL, sha256-manifest-verified
  // capture (BUTCHR-236-unrecognised-20260902T204727Z.txt, header stripped)
  // from the preserved corpus at
  // /home/wroosbit/butchr-workspaces/BUTCHR-207/captures-preserved-20260903/
  // — readable from this task's own Unix account (re-verify from yours
  // before trusting this claim; the ticket's own history shows this
  // permission boundary moved once already). The old assertion (resetsAt
  // 9:50pm) is replaced with this fixture's real reset time, 5:10pm.
  test("recognises a genuine, real-captured ⎿-prefixed refusal, and parses its reset time", () => {
    const now = new Date(2026, 7, 28, 12, 0, 0); // noon — before the 5:10pm reset, same day
    const r = detectSessionLimitRefusal(fixture("pane-cap-session-limit.txt"), now);
    expect(r).not.toBeNull();
    expect(r!.raw).toContain("You've hit your session limit");
    expect(r!.resetsAt).toBe(new Date(2026, 7, 28, 17, 10, 0).getTime());
  });

  // BUTCHR-259 AC1: assert the fixture's own bytes, not just that detection
  // happens to pass today — so this can never silently drift back to the
  // bare `You'` shape the way the two fixtures above already did once. Exact
  // byte spec from the ticket: `20 20 e2 8e bf 20 c2 a0 59 6f 75 27` — two
  // spaces, U+23BF (⎿), space, U+00A0 (NBSP), then "You'".
  test("the genuine fixture's refusal line carries the real ⎿+NBSP tool-result prefix, byte for byte", () => {
    const bytes = fixtureBytes("pane-cap-session-limit.txt");
    const needle = Buffer.from("You've hit your session limit", "utf8");
    const idx = bytes.indexOf(needle);
    expect(idx).toBeGreaterThan(-1);
    const prefix = bytes.subarray(idx - 8, idx);
    expect([...prefix]).toEqual([0x20, 0x20, 0xe2, 0x8e, 0xbf, 0x20, 0xc2, 0xa0]);
  });

  test("tolerates 'H:MMam/pm' with no space, 'H:MM AM/PM' with a space, and 24-hour form", () => {
    const now = new Date(2026, 7, 28, 6, 0, 0);
    expect(detectSessionLimitRefusal("You've hit your session limit · resets 9:50am", now)!.resetsAt)
      .toBe(new Date(2026, 7, 28, 9, 50, 0).getTime());
    expect(detectSessionLimitRefusal("You've hit your session limit · resets 9:50 AM", now)!.resetsAt)
      .toBe(new Date(2026, 7, 28, 9, 50, 0).getTime());
    expect(detectSessionLimitRefusal("You've hit your session limit · resets 21:50", now)!.resetsAt)
      .toBe(new Date(2026, 7, 28, 21, 50, 0).getTime());
  });

  test("rolls to tomorrow when the printed clock time has already passed today", () => {
    const now = new Date(2026, 7, 28, 23, 0, 0); // 11pm
    const r = detectSessionLimitRefusal("You've hit your session limit · resets 9:50pm", now);
    expect(r!.resetsAt).toBe(new Date(2026, 7, 29, 21, 50, 0).getTime());
  });

  test("still recognises the refusal but reports no resetsAt when no reset time is printed — never invents one", () => {
    const r = detectSessionLimitRefusal("You've hit your session limit", new Date(2026, 7, 28, 12, 0, 0));
    expect(r).not.toBeNull();
    expect(r!.resetsAt).toBeNull();
  });

  test("null for ordinary text with no refusal", () => {
    expect(detectSessionLimitRefusal("just some normal output\nwith no refusal in it", new Date())).toBeNull();
  });

  // KAN-804 comment 15380/15383: this exact phrase sits verbatim in the
  // ticket's own text, so it WILL appear in scrollback whenever an agent
  // reads KAN-804 or KAN-807. A matcher that fires on that scrollback would
  // close a perfectly healthy agent's pane — worse than a missed detection.
  // Neither of these two fixtures is ⎿-prefixed (real ticket/comment
  // continuation text, not a tool-result head), so they exercise the legacy
  // bare-line/TAIL_LINES path exactly as before BUTCHR-259 — unchanged.
  test("does NOT match the phrase quoted mid-scrollback, with real content (including the composer) after it", () => {
    expect(detectSessionLimitRefusal(fixture("pane-cap-session-limit-midscroll.txt"), new Date())).toBeNull();
  });

  test("does NOT match a pane that has read this very ticket (the phrase inside a rendered Jira comment/tool result), with the agent still visibly active afterward", () => {
    expect(detectSessionLimitRefusal(fixture("pane-cap-session-limit-quoted-ticket.txt"), new Date())).toBeNull();
  });

  // BUTCHR-259 AC2: this is the fixture the trap section warns about — the
  // OLD `-quoted-ticket.txt` fixture proves nothing about a fix that only
  // patches the anchor, because it's saved by POSITION (outside TAIL_LINES),
  // not by the anchor: its refusal line isn't ⎿-prefixed at all. This one
  // is: the refusal-shaped line carries the real ⎿+NBSP prefix (asserted
  // below, byte for byte) AND sits at the very end of the pane (inside any
  // reasonable tail window) — a naive prefix-strip fix, with no pairing
  // guard, WOULD match this and close a healthy pane. It must not.
  test("does NOT match a ⎿-prefixed refusal-shaped line, with real ⎿+NBSP bytes, sitting at the pane's own tail — quoted ticket text, not its own wrap continuation", () => {
    const text = fixture("pane-cap-session-limit-quoted-ticket-in-tail.txt");
    expect(detectSessionLimitRefusal(text, new Date())).toBeNull();
    const outcome = classifySessionLimitText(text, new Date());
    expect(outcome.kind).toBe("suppressed");
    if (outcome.kind === "suppressed") {
      expect(outcome.reason).toContain("not immediately followed by its own wrap continuation");
    }
  });

  test("the quoted-ticket-in-tail fixture's refusal line also carries the real ⎿+NBSP prefix, byte for byte — so a bare prefix-strip-only fix would wrongly match it", () => {
    const bytes = fixtureBytes("pane-cap-session-limit-quoted-ticket-in-tail.txt");
    const needle = Buffer.from("You've hit your session limit", "utf8");
    const idx = bytes.indexOf(needle);
    expect(idx).toBeGreaterThan(-1);
    const prefix = bytes.subarray(idx - 8, idx);
    expect([...prefix]).toEqual([0x20, 0x20, 0xe2, 0x8e, 0xbf, 0x20, 0xc2, 0xa0]);
  });

  // Worst case, defense-in-depth: an adversarial quote that reproduces the
  // FULL two-line pair verbatim (banner + its real "/usage-credits…" wrap)
  // and then keeps going — more quoted prose, a truncation tail. Pairing
  // alone would wrongly accept this; embeddedAfter() is what catches it.
  test("does NOT match even when the full banner+continuation PAIR is reproduced verbatim, if further quoted content follows", () => {
    const text = fixture("pane-cap-session-limit-quoted-full-pair-in-tail.txt");
    expect(detectSessionLimitRefusal(text, new Date())).toBeNull();
    const outcome = classifySessionLimitText(text, new Date());
    expect(outcome.kind).toBe("suppressed");
    if (outcome.kind === "suppressed") {
      expect(outcome.reason).toContain("followed by further content");
    }
  });

  // BUTCHR-259 review (comment 19445): the pairing guard alone is
  // defeated by a pane that is merely reading DOCUMENTATION OF THIS FIX —
  // any explanation of the pairing must display both lines in order, so
  // the corpus of text that trips a pairing-only detector grows every time
  // someone documents the fix (this ticket, this PR body, this file's own
  // comments). `.trim()` erases the one real difference: a quote nested
  // inside some OTHER, enclosing tool result renders at margin depth >= 5
  // (Claude Code's continuation-alignment column), never depth 2 — measured
  // 97/97 real banners at depth 2, zero elsewhere. TOOL_RESULT_HEAD is
  // anchored to the RAW line's exact `{2}` leading spaces for exactly this
  // reason. This fixture is the reviewer's own falsifier, verbatim byte
  // spec and all (`⎿` + NBSP survive a faithful copy-paste, so "same
  // bytes" doesn't save a margin-blind fix either) — a doc explaining
  // "Gate 2" that quotes the real banner and its real continuation, in
  // order, nested inside an outer tool result, with a truncation tail.
  test("does NOT match the pairing when it is nested inside an ENCLOSING tool result — a pane reading this fix's own documentation of the pairing (BUTCHR-259 review)", () => {
    const text = fixture("pane-cap-session-limit-nested-pair-with-truncation.txt");
    expect(detectSessionLimitRefusal(text, new Date())).toBeNull();
  });

  // The reviewer's fixture happens to end in a `… +N lines` truncation tail,
  // which embeddedAfter() alone would already catch — so this fixture drops
  // the tail entirely (the pair is the LAST thing in the enclosing block)
  // to prove the MARGIN check, not the truncation marker, is what rejects
  // it in general. Same bytes as the genuine banner at the "You've hit"
  // line (asserted below); only the leading-space count differs (5, not 2).
  test("does NOT match the nested pairing even with nothing after it — margin depth, not what follows, is the general guard", () => {
    const text = fixture("pane-cap-session-limit-nested-pair-no-truncation.txt");
    expect(detectSessionLimitRefusal(text, new Date())).toBeNull();
    expect(classifySessionLimitText(text, new Date())).toEqual({ kind: "not-recognised" });
  });

  test("the nested-pair fixture's refusal line carries the SAME real ⎿+NBSP bytes as a genuine banner — only indented 5 spaces instead of 2, proving margin depth (not the bytes) is what's rejecting it", () => {
    const bytes = fixtureBytes("pane-cap-session-limit-nested-pair-no-truncation.txt");
    const needle = Buffer.from("You've hit your session limit", "utf8");
    const idx = bytes.indexOf(needle);
    expect(idx).toBeGreaterThan(-1);
    const prefix = bytes.subarray(idx - 11, idx);
    expect([...prefix]).toEqual([0x20, 0x20, 0x20, 0x20, 0x20, 0xe2, 0x8e, 0xbf, 0x20, 0xc2, 0xa0]);
  });

  // BUTCHR-259 review (comment 19465): a NAMED, BOUNDED residual risk, not a
  // silent gap — see the long comment above SessionLimitRefusal in
  // session-limit.ts for the full reasoning (two candidate closing signals
  // tried and falsified against real data before concluding this can't be
  // closed from pane text alone). This test documents CURRENT behaviour —
  // it is not asserting this is correct, only that it is known and legible.
  // A tool result (e.g. `grep -A1 "hit your session limit" <a real capture
  // file>`) whose own output is byte-for-byte a genuine banner+continuation
  // pair, at margin depth 2, is indistinguishable from a live refusal.
  test("KNOWN RESIDUAL RISK: a tool result byte-identical to a genuine banner+continuation pair, at margin depth 2, is currently indistinguishable from a live refusal", () => {
    const text = fixture("pane-cap-session-limit-grep-result-same-margin.txt");
    const outcome = classifySessionLimitText(text, new Date(2026, 7, 28, 12, 0, 0));
    expect(outcome.kind).toBe("recognised"); // documented, not endorsed — see comment above
  });

  // BUTCHR-259: `pane-cap-session-limit-with-composer.txt` used to be
  // hand-built and bare (no ⎿ prefix) — same trap as the primary positive
  // fixture above. Now a real capture
  // (BUTCHR-115-unrecognised-20260902T173100Z.txt, header stripped): the
  // MINIMUM-depth specimen in the whole 52-file corpus (content-depth 5 —
  // banner, its own continuation, one status line, the composer's `❯`, then
  // the bypass-permissions line), the tightest real case of "composer chrome
  // directly below a live refusal". Old assertion (resetsAt 9:50pm) replaced
  // with this fixture's real reset time, 12:10pm.
  test("matches a genuine, real-captured refusal even with the real composer chrome rendered directly below it", () => {
    const now = new Date(2026, 7, 28, 6, 0, 0);
    const r = detectSessionLimitRefusal(fixture("pane-cap-session-limit-with-composer.txt"), now);
    expect(r).not.toBeNull();
    expect(r!.raw).toContain("You've hit your session limit");
    expect(r!.resetsAt).toBe(new Date(2026, 7, 28, 12, 10, 0).getTime());
  });

  test("does NOT match an ordinary healthy working-agent capture", () => {
    expect(detectSessionLimitRefusal(fixture("pane-cap-a.txt"), new Date())).toBeNull();
    expect(detectSessionLimitRefusal(fixture("pane-cap-b.txt"), new Date())).toBeNull();
  });

  test("parsePrompt never parses a genuine session-limit refusal as a dialog — it is not one", () => {
    expect(parsePrompt(fixture("pane-cap-session-limit.txt"))).toBeNull();
  });
});

// BUTCHR-259 AC4: every outcome legible, not just recognised-vs-null.
describe("classifySessionLimitText", () => {
  test("recognised: carries the same resetsAt/raw as detectSessionLimitRefusal", () => {
    const now = new Date(2026, 7, 28, 12, 0, 0);
    const outcome = classifySessionLimitText(fixture("pane-cap-session-limit.txt"), now);
    expect(outcome.kind).toBe("recognised");
    if (outcome.kind === "recognised") {
      expect(outcome.resetsAt).toBe(new Date(2026, 7, 28, 17, 10, 0).getTime());
    }
  });

  test("not-recognised: no refusal-shaped line anywhere", () => {
    expect(classifySessionLimitText("just some normal output", new Date())).toEqual({ kind: "not-recognised" });
  });

  test("suppressed: reason always names what looked wrong, never a silent null", () => {
    const outcome = classifySessionLimitText(fixture("pane-cap-session-limit-quoted-ticket-in-tail.txt"), new Date());
    expect(outcome.kind).toBe("suppressed");
    if (outcome.kind === "suppressed") {
      expect(outcome.reason.length).toBeGreaterThan(0);
      expect(outcome.raw).toContain("You've hit your session limit");
    }
  });

  // A pane that got refused, was nudged into reading its own ticket (whose
  // rendered comment happens to be refusal-shaped and ⎿-prefixed but NOT
  // paired), and is now genuinely refused AGAIN with a real, paired banner
  // closer to the tail: only the MOST RECENT ⎿-refusal-shaped line decides
  // the outcome — an older, unpaired one further back must never leak
  // through as "suppressed, so fall back to an earlier match" OR wrongly
  // veto a later genuine one.
  test("only the MOST RECENT ⎿-refusal-shaped line decides the outcome", () => {
    const older = "  ⎿  You've hit your session limit · resets 1:00pm — quoted in an earlier tool result, not paired\n     more unrelated text\n";
    const recent =
      "  ⎿  You've hit your session limit · resets 5:10pm (America/Los_Angeles)\n     /usage-credits to finish what you're working on.\n";
    const outcome = classifySessionLimitText(older + "\n" + recent, new Date(2026, 7, 28, 12, 0, 0));
    expect(outcome.kind).toBe("recognised");
    if (outcome.kind === "recognised") expect(outcome.resetsAt).toBe(new Date(2026, 7, 28, 17, 10, 0).getTime());
  });
});
