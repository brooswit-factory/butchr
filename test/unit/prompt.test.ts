import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePrompt, keysToSelect, chooseStartupAnswer } from "../../src/agents/prompt.js";
import { fingerprint } from "../../src/agents/escalate.js";

// The real prompt captured from a blocked herdr agent (pane.read source:detection).
const REAL = `This session is 2d 12h old and 673.2k tokens.
Resuming the full session will consume a substantial portion of your usage limits. We
recommend resuming from a summary.
❯ 1. Resume from summary (recommended)
  2. Resume full session as-is
  3. Don't ask me again
Enter to confirm · Esc to cancel`;

describe("parsePrompt", () => {
  test("parses the real Claude selection prompt: question, options, current", () => {
    const p = parsePrompt(REAL)!;
    expect(p.options).toEqual(["Resume from summary (recommended)", "Resume full session as-is", "Don't ask me again"]);
    expect(p.current).toBe(1);
    expect(p.question).toContain("Resuming the full session");
    expect(p.question).not.toContain("Enter to confirm");
  });
  test("current follows the ❯ marker", () => {
    // KAN-756: the numbered branch now requires the same footer gate as the
    // un-numbered branch (see the FOOTER-gate tests below) — this synthetic
    // fixture is shorthand for a real dialog, and every real dialog has one.
    const p = parsePrompt("Pick one\n  1. a\n❯ 2. b\n  3. c\nEnter to confirm · Esc to cancel")!;
    expect(p.current).toBe(2); expect(p.options).toEqual(["a", "b", "c"]);
  });
  test("returns null when there is no menu", () => {
    expect(parsePrompt("just some output, no options")).toBeNull();
    expect(parsePrompt("❯ 1. only one option")).toBeNull(); // needs >= 2
  });
  // Regression: KAN-736. Real probe against dcdecbf — the numbered branch
  // pushed EVERY preceding line into `question`, unbounded, so command output
  // (and any secrets in it) that scrolled above the dialog leaked all the way
  // into a permanent, project-readable Jira comment via escalationComment().
  test("does not absorb unbounded preceding pane output", () => {
    // The bound's job is volume, not content — dropping lines older than the
    // tail. Scrubbing what's still inside the tail is redact()'s job, tested
    // end-to-end (against this exact pane) in test/unit/escalate.test.ts.
    const pane = `$ some earlier command
$ another earlier command
$ cat .env
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
DATABASE_URL=postgres://admin:hunter2@prod-db.internal:5432/main
GITHUB_TOKEN=ghp_16CharsOfRealLookingTokenAAAAAAAAAAAA
$ deploy --prod
Choose deployment target:
❯ 1. Production
  2. Staging
Enter to confirm · Esc to cancel`;
    const p = parsePrompt(pane)!;
    expect(p.question).toContain("Choose deployment target:");
    expect(p.question).not.toContain("some earlier command");
    expect(p.question).not.toContain("another earlier command");
  });
});
describe("keysToSelect", () => {
  test("arrows down for a higher target, up for lower, and always confirms", () => {
    expect(keysToSelect(1, 1)).toBe("\r");
    expect(keysToSelect(1, 3)).toBe("\x1b[B\x1b[B\r");
    expect(keysToSelect(3, 1)).toBe("\x1b[A\x1b[A\r");
  });
});

describe("un-numbered trust dialog (Claude Code 2.x)", () => {
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
  test("parses: two options, exit highlighted first", () => {
    const p = parsePrompt(TRUST)!;
    expect(p).not.toBeNull();
    expect(p.options).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(p.current).toBe(1);
  });
  test("chooseStartupAnswer picks the trust option BY CONTENT (option 2, not 1)", () => {
    const p = parsePrompt(TRUST)!;
    expect(chooseStartupAnswer(p)).toBe(2);
    expect(keysToSelect(p.current, 2)).toBe("\x1b[B\r"); // one down + enter
  });
  test("numbered dev-channels dialog still answers its matching option", () => {
    const p = parsePrompt(`  WARNING: Loading development channels
  Channels: server:butchr
  ❯ 1. I am using this for local development
    2. Exit
  Enter to confirm · Esc to cancel`)!;
    expect(chooseStartupAnswer(p)).toBe(1);
  });
  test("an unrecognized un-numbered menu is left for a human", () => {
    const p = parsePrompt(` Choose deployment target:
 ❯ Production
   Staging
 Enter to select · ↑/↓ to navigate · Esc to cancel`);
    if (p) expect(chooseStartupAnswer(p)).toBeNull();
  });
  test("prose without the footer never parses as a menu", () => {
    expect(parsePrompt("❯ some shell prompt\n  indented continuation line\n  another line")).toBeNull();
  });
  // Regression: KAN-736. The un-numbered branch already bounded with
  // .slice(-6), but that alone still let 6 lines of command output through —
  // the shared QUESTION_TAIL bound is what makes both branches safe together.
  test("7 lines of junk above the dialog keep the real question, drop the oldest", () => {
    const pane = [
      "line1 oldest junk",
      "SECRET_THREE=ccc",
      "line3",
      "line4",
      "line5",
      "line6",
      "line7",
      "Trust this folder?",
      "❯ No, exit",
      "  Yes, I trust this folder",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    const p = parsePrompt(pane)!;
    expect(p).not.toBeNull();
    expect(p.question).toContain("Trust this folder?");
    expect(p.question).not.toContain("line1 oldest junk");
    expect(p.question).not.toContain("SECRET_THREE");
  });
});

describe("bypass-permissions acceptance dialog", () => {
  test("accepts by content (option 2), never the leading exit", () => {
    const p = parsePrompt(` You are running in Bypass
 Permissions mode.
 https://code.claude.com/docs/en/security
 ❯ No, exit
   Yes, I accept
 Enter to confirm · Esc to cancel`)!;
    expect(p).not.toBeNull();
    expect(chooseStartupAnswer(p)).toBe(2);
  });
});

// KAN-756 PR #40 review, Finding 1 (comments 14956/14969/14983): item (B)
// hardened the NUMBERED branch and left parseUnnumbered carrying exactly
// the substring-anywhere footer trap it was warned about — `findIndex(l =>
// /Enter to (confirm|select)/.test(l))` matches the phrase ANYWHERE in a
// line, including mid-sentence prose, and un-numbered dialogs never got a
// positional gate at all. Reviewer's real proof (reproduced against PR
// head e6d1be4, fp bc4162ee): a working agent's own narration about the
// footer rule — `❯ `-prefixed lines (Claude Code's own composer/user-
// message prefix) and 2-space-indented short lines (ordinary tool output)
// are the everyday shape; the only scarce ingredient is the footer phrase
// in prose, and butchr itself puts it there (every escalation comment
// quotes a real dialog's footer onto a ticket the agent then reads) — the
// same self-sustaining loop as the numbered-branch finding, one code path
// over. Fix: anchor FOOTER to line-start on BOTH branches (a real footer
// IS the line, never a clause inside a sentence), and have parseUnnumbered
// anchor to the LAST matching line rather than the first — a real dialog
// is always the last thing rendered in scrollback, so prose mentioning the
// phrase ABOVE a genuine dialog must not steal the anchor from it.
describe("un-numbered branch: footer must be line-anchored, not merely present (KAN-756 PR #40 review)", () => {
  test("THE TRAP (reviewer's real proof): narration ABOUT the footer, with no real dialog anywhere, must not parse", () => {
    const trap = `❯ [butchr] KAN-756 was updated — re-read it, then act
● Reviewing the reviewer's note about the footer rule.
  the gate requires a footer
  immediately after the options
❯ so a stray cursor line counts
  the real dialog says Enter to confirm · Esc to cancel`;
    expect(parsePrompt(trap)).toBeNull();
  });

  test("a real un-numbered dialog still parses identically (regression: the captured trust dialog)", () => {
    const trust = `──────────────────────────────
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
    const p = parsePrompt(trust)!;
    expect(p).not.toBeNull();
    expect(p.options).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(p.current).toBe(1);
  });

  test("the footer phrase as a mid-line clause in prose, with a REAL dialog further down: the real dialog still parses (anchoring to the LAST match, not the first)", () => {
    const text = `● Someone wrote: "the real dialog says Enter to confirm · Esc to cancel somewhere"
 Choose deployment target:
 ❯ Production
   Staging
 Enter to confirm · Esc to cancel`;
    const p = parsePrompt(text)!;
    expect(p).not.toBeNull();
    expect(p.options).toEqual(["Production", "Staging"]);
    expect(p.current).toBe(1);
    expect(p.question).toContain("Choose deployment target:");
  });

  test("indented prose containing the footer phrase (not line-start once trimmed) never anchors, even alone", () => {
    expect(parsePrompt("  some text mentions Enter to confirm in passing\n  another line")).toBeNull();
  });
});

// KAN-756, item (B): parser hardening so transient pane prose never parses
// as a dialog. FINDING (KAN-756 comment 14863/14867, real captures on the
// affected host): the trigger is NOT any specific banner — it is ANY two
// "N. label" lines anywhere in a WORKING agent's scrollback, including text
// that merely QUOTES option strings (e.g. an escalation comment's own
// options, read back by the agent — a self-sustaining loop, measured). A
// naive "does the text contain a footer phrase anywhere" gate (this file's
// first cut, since reverted) FAILS: a real capture's own narration reads
// "no Enter to confirm footer", which contains the phrase as prose. The
// fix must be POSITIONAL — the footer must immediately follow the LAST
// option line (blank lines only in between, the same walk-upward discipline
// parseUnnumbered already uses) — AND require a ❯ cursor on exactly one
// option line. Both gates are independent; a real dialog satisfies both, a
// churning pane with a stray footer phrase or a stray cursor satisfies at
// most one.
describe("MCP-server trust dialog (real capture)", () => {
  // Real capture, epic account, KAN-756 comment 14835: `herdr pane read
  // <pane> --source detection --format text` against a genuinely
  // herd-blocked pane (w1:p44, sitting on this exact prompt). Carries both
  // the ❯ cursor and the footer, like every other real fixture — the
  // strongest regression probe available for the numbered branch, since (B)
  // must not touch it.
  const MCP_TRUST = `New MCP server found in this project: butchr

MCP servers may execute code or access system resources. All tool calls require approval.
Learn more in the MCP documentation.

❯ 1. Use this MCP server
  2. Use this and all future MCP servers in this project
  3. Continue without using this MCP server

Enter to confirm · Esc to cancel`;
  test("still parses after the footer gate: three options, first highlighted", () => {
    const p = parsePrompt(MCP_TRUST)!;
    expect(p).not.toBeNull();
    expect(p.options).toEqual([
      "Use this MCP server",
      "Use this and all future MCP servers in this project",
      "Continue without using this MCP server",
    ]);
    expect(p.current).toBe(1);
    expect(p.question).toContain("New MCP server found in this project: butchr");
  });
  test("fingerprint matches the epic's real-capture value (14835/14867)", () => {
    const p = parsePrompt(MCP_TRUST)!;
    expect(fingerprint(p)).toBe("3cd89e91");
  });
});

// KAN-756, comments 14863/14867: real captures from the story's own host,
// taken via `herdr pane read "$HERDR_PANE_ID" --source detection --format
// text` and verified against the real parser on 3ed377b. This is the
// DECISIVE evidence for (B) — not the earlier banner theory (KAN-755
// comment 14863, Finding 1: "the banner is not the trigger... any two
// `N. label` lines anywhere in a working agent's scrollback make the pane
// parse as a live dialog").
//
// PROVENANCE NOTE: reconstructed from the fragments pasted into KAN-756
// comments 14863/14867 (exact printf command, exact stated line positions —
// "Enter to confirm" at line 2, options at lines 24-25, 38 lines total —
// and the exact head/tail text shown), pending the byte-exact files
// requested in comment 14888. The properties this test depends on (trap
// phrase far above the options, no footer-matching line anywhere after the
// options, no cursor on either option) are all directly quoted from the
// story's own measurements, not inferred.
// Captured live by the KAN-755 agent (`herdr pane read "$HERDR_PANE_ID"
// --source detection --format text` on the story's own pane, on the
// affected host), transmitted base64 via KAN-756 comment 14899, decoded
// into test/fixtures/. Read as real files, not inline string literals, per
// the story's explicit instruction — a file read cannot silently "clean up"
// whitespace the way a hand-typed template literal might. NBSP characters
// (U+00A0, in the "⎿  " tool-result gutters) were normalised to ASCII
// spaces somewhere in transit through Jira's ADF storage, and the two
// decorative horizontal-rule lines came through a few characters shorter
// than the story's originals (a rendering-width artefact, not data loss —
// confirmed line-by-line, KAN-755 comment 14919: all 38 lines match in
// count, and every content line — including the exact option lines at
// pane-cap-b.txt:24-25 — matches character-for-character; only the two pure
// "─" rule lines differ). Verified against parsePrompt on 3ed377b (the
// commit before this fix), via a throwaway probe importing that commit's
// src/agents/prompt.ts and src/agents/escalate.ts: pane-cap-a.txt parses to
// null there too (it never had the bug — the honest control); pane-cap-b.txt
// parses to fp 7e64fff2, options ["Yes, try it", "Not now"], current 1 —
// exactly the fingerprint the story measured on their own originals, the
// decisive proof this is the same content that actually parsed in production.
describe("pane-cap-a / pane-cap-b: real captures, same pane, ~40s apart, one tool call apart (KAN-756)", () => {
  const capA = readFileSync(join(import.meta.dir, "../fixtures/pane-cap-a.txt"), "utf8");
  const capB = readFileSync(join(import.meta.dir, "../fixtures/pane-cap-b.txt"), "utf8");

  test("pane-cap-a.txt (no numbered lines in scrollback): returns null, as it always did", () => {
    expect(parsePrompt(capA)).toBeNull();
  });

  test("THE DECISIVE TEST: pane-cap-b.txt (the ONLY difference from cap-a is two echoed printf lines, '1. Yes, try it' / '2. Not now', quoted inside a tool-result block 13 lines before the pane's own composer footer, no ❯ cursor on either) returns null after the positional+cursor gate — it parsed as fp 7e64fff2 on 3ed377b", () => {
    expect(parsePrompt(capB)).toBeNull();
  });

  // The epic could not produce a real capture combining BOTH the footer
  // phrase as prose AND the numbered lines in one pane (KAN-756 comment
  // 14899: the pane elided the middle of the scrollback and the numbered
  // lines never rendered). This fixture is DERIVED, not captured: real
  // pane-cap-b.txt, verbatim, with one line inserted near the top
  // containing the footer phrase as narration — the trap a substring-
  // anywhere gate would fall into, that the positional gate must not.
  test("DERIVED trap (real pane-cap-b.txt + an inserted narration line containing the footer phrase): still returns null", () => {
    const lines = capB.split("\n");
    lines.splice(1, 0, "  narration: the dialog footer says Enter to confirm · Esc to cancel");
    expect(parsePrompt(lines.join("\n"))).toBeNull();
  });
});

describe("positional footer gate and single-cursor gate are independent (KAN-756)", () => {
  test("two numbered lines immediately followed by a footer, but with NO cursor on either, do not parse", () => {
    expect(parsePrompt("Pick one:\n1. a\n2. b\nEnter to confirm · Esc to cancel")).toBeNull();
  });

  test("two numbered lines with a cursor, but the footer is NOT adjacent (other content in between), do not parse", () => {
    const text = "Pick one:\n❯ 1. a\n2. b\n\n● unrelated tool output between the menu and the footer\n\nEnter to confirm · Esc to cancel";
    expect(parsePrompt(text)).toBeNull();
  });

  test("two numbered lines with a cursor AND an adjacent footer (blank lines allowed) DO parse", () => {
    const p = parsePrompt("Pick one:\n❯ 1. a\n2. b\n\n\nEnter to confirm · Esc to cancel")!;
    expect(p).not.toBeNull();
    expect(p.options).toEqual(["a", "b"]);
    expect(p.current).toBe(1);
  });

  test("two cursors on two different option lines do not parse (ambiguous highlight)", () => {
    expect(parsePrompt("Pick one:\n❯ 1. a\n❯ 2. b\nEnter to confirm · Esc to cancel")).toBeNull();
  });
});

// KAN-755 comment 14893: the GENUINE "Try the new fullscreen renderer?"
// offer (v0.5.17, operator hotfix PR #35, main 8060292) turned out to be a
// real MODAL dialog — unlike cap2 (mere prose quoting its option strings),
// it carries a ❯ cursor on exactly one option AND the footer immediately
// after the last option. It is the fixture that proves the positional+
// cursor gate separates the real dialog from the prose that merely mentions
// it, from the other direction: cap2 fails both gates, this passes both.
// v0.5.17 also taught chooseStartupAnswer to answer it "Not now" so it
// never reaches escalation — hardening (B) must not silently break that.
describe("fullscreen-renderer offer (real dialog, v0.5.17 — must keep parsing AND keep auto-answering)", () => {
  const RENDERER_OFFER = `  Try the new fullscreen renderer?
  · Flicker-free output
  · Mouse support — click to move your cursor or expand results
  · Selected text auto-copies to your clipboard
  ❯ 1. Yes, try it
    2. Not now
  Enter to confirm · Esc to cancel`;
  test("still parses: question, options, current, unchanged by the positional+cursor gate", () => {
    const p = parsePrompt(RENDERER_OFFER)!;
    expect(p).not.toBeNull();
    expect(p.question).toContain("Try the new fullscreen renderer?");
    expect(p.options).toEqual(["Yes, try it", "Not now"]);
    expect(p.current).toBe(1);
  });
  test("chooseStartupAnswer still answers it by content ('Not now'), so hardening never re-exposes it to escalation", () => {
    const p = parsePrompt(RENDERER_OFFER)!;
    expect(chooseStartupAnswer(p)).toBe(2);
  });
});

describe("the original KAN-741/751/755 production bursts never parse (supplementary, KAN-756)", () => {
  // RECONSTRUCTED, not captured, and kept only because it covers something
  // pane-cap-a/b do not: three DISTINCT moments from the ORIGINAL measured
  // incident (KAN-741 x9, KAN-751 x2, KAN-755 x3 — the escalation-comment
  // bursts that opened this ticket), each `question` string copied verbatim
  // from a genuine escalationComment() the daemon actually posted (KAN-755
  // comments 14815, 14819, 14822) — the real ≤6-line, space-joined tail
  // parsePrompt extracted. Newlines are reinserted at the known UI-artifact
  // boundaries (●, "(ctrl+o to expand)", "✻ Worked for Ns · done", "←"), so
  // the exact original line breaks within a run of prose are inferred, not
  // captured — the DECISIVE, byte-exact evidence for the fix itself is
  // pane-cap-a.txt/pane-cap-b.txt above; this block is corroborating
  // evidence that the same fix also closes the incident that started it.
  const BANNER_TAIL = "Try the new fullscreen renderer?\n\n1. Yes, try it\n2. Not now";

  const RECONSTRUCTED_1 = `delivered" : "refused/absent"}\`); },
… +104 lines (ctrl+o to expand)
● Now I'll file the implementation task with the full context.
Calling butchr… (ctrl+o to expand)

${BANNER_TAIL}`;

  const RECONSTRUCTED_2 = `delivered" : "refused/absent"}\`); },
… +104 lines (ctrl+o to expand)
● Now I'll file the implementation task with the full context.
● Calling butchr… (ctrl+o to expand)

${BANNER_TAIL}`;

  const RECONSTRUCTED_3 = `escalations land on this ticket I'll leave them unanswered, since a stale ANSWER is mechanism (2).
✻ Worked for 1m 51s · done 4:57 PM
← butchr: [butchr] Ticket KAN-755 was updated — re-read it.
← butchr: [butchr] KAN-756 (related to your KAN-755) was updated — re…

${BANNER_TAIL}`;

  test("three reconstructed production captures (rotating prose, same banner) all fail to parse", () => {
    expect(parsePrompt(RECONSTRUCTED_1)).toBeNull();
    expect(parsePrompt(RECONSTRUCTED_2)).toBeNull();
    expect(parsePrompt(RECONSTRUCTED_3)).toBeNull();
  });

  test("the banner alone, with no preceding prose at all, still fails to parse (no footer)", () => {
    expect(parsePrompt(BANNER_TAIL)).toBeNull();
  });
});
