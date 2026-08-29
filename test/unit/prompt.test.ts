import { describe, expect, test } from "bun:test";
import { parsePrompt, keysToSelect, chooseStartupAnswer } from "../../src/agents/prompt.js";

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
    const p = parsePrompt("Pick one\n  1. a\n❯ 2. b\n  3. c")!;
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

describe("fullscreen renderer offer", () => {
  test("auto-answers Not now by content", () => {
    const p = parsePrompt(`  Try the new fullscreen renderer?
  · Flicker-free output
  · Mouse support — click to move your cursor or expand results
  · Selected text auto-copies to your clipboard
  ❯ 1. Yes, try it
    2. Not now
  Enter to confirm · Esc to cancel`)!;
    expect(p).not.toBeNull();
    expect(chooseStartupAnswer(p)).toBe(2);
  });
});
