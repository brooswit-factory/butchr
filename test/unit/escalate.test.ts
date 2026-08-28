import { describe, expect, test } from "bun:test";
import { fingerprint, escalationComment, parseDirective, freeTextOption, redact } from "../../src/agents/escalate.js";
import { parsePrompt } from "../../src/agents/prompt.js";
import type { Prompt } from "../../src/agents/prompt.js";

const prompt = (question: string, options: string[], current = 1): Prompt => ({ question, options, current });

describe("fingerprint", () => {
  test("is a stable 8-hex-char digest of question + options", () => {
    const fp = fingerprint(prompt("Pick one", ["A", "B"]));
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint(prompt("Pick one", ["A", "B"]))).toBe(fp);
  });
  test("is independent of `current` — the highlight moves, the dialog does not", () => {
    expect(fingerprint(prompt("Pick one", ["A", "B"], 1))).toBe(fingerprint(prompt("Pick one", ["A", "B"], 2)));
  });
  test("differs when the question or options differ", () => {
    const fp = fingerprint(prompt("Pick one", ["A", "B"]));
    expect(fingerprint(prompt("Pick two", ["A", "B"]))).not.toBe(fp);
    expect(fingerprint(prompt("Pick one", ["A", "C"]))).not.toBe(fp);
  });
});

describe("escalationComment", () => {
  test("is built ONLY from the issue, question, options and fingerprint", () => {
    const c = escalationComment("KAN-1", prompt("Deploy to prod?", ["Yes", "No"]), "a1b2c3d4");
    expect(c).toContain("[butchr:blocked] KAN-1 is waiting on a decision:");
    expect(c).toContain("Deploy to prod?");
    expect(c).toContain("1. Yes");
    expect(c).toContain("2. No");
    expect(c).toContain("fingerprint: a1b2c3d4");
    expect(c).toContain("ANSWER <n> a1b2c3d4");
    expect(c).toContain("ANSWER TEXT <your text> a1b2c3d4");
  });
  test("never leaks anything beyond question/options — no sentinel field exists to leak", () => {
    const c = escalationComment("KAN-1", prompt("Q", ["only", "these"]), "deadbeef");
    // The function signature admits no other input; assert the whole comment
    // is accounted for by the four known parts plus the fixed template.
    const known = ["[butchr:blocked]", "KAN-1", "Q", "1. only", "2. these", "deadbeef"];
    for (const line of c.split("\n").filter(Boolean)) {
      expect(known.some((k) => line.includes(k)) || /^Reply on THIS ticket/.test(line)).toBe(true);
    }
  });
});

describe("redact", () => {
  test("KEY=VALUE / KEY: VALUE, keying on KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL/AUTH/BEARER/API_KEY", () => {
    expect(redact("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe("AWS_SECRET_ACCESS_KEY=[redacted]");
    expect(redact("DB_PASSWORD: hunter2")).toBe("DB_PASSWORD: [redacted]");
    expect(redact("API_KEY=abc123")).toBe("API_KEY=[redacted]");
    expect(redact("normal text with no secrets")).toBe("normal text with no secrets");
  });
  test("provider token shapes", () => {
    expect(redact("token is ghp_16CharsOfRealLookingTokenAAAAAAAAAAAA now")).toBe("token is [redacted] now");
    expect(redact("sk-abcdefghijklmnopqrstuvwxyz123456")).toBe("[redacted]");
    expect(redact("xoxb-1234567890-abcdefghij")).toBe("[redacted]");
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toBe("[redacted]");
  });
  test("credentials embedded in a URL — only the password is masked, host survives", () => {
    expect(redact("postgres://admin:hunter2@prod-db.internal:5432/main")).toBe(
      "postgres://admin:[redacted]@prod-db.internal:5432/main",
    );
  });
  test("Authorization: Bearer / Basic — the scheme word survives, the token doesn't", () => {
    expect(redact("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer [redacted]");
    expect(redact("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic [redacted]");
  });
  test("long opaque blobs (32+ chars) are redacted", () => {
    const blob = "aZ9" + "x".repeat(30) + "Q1";
    expect(redact(`token: ${blob}`)).not.toContain(blob);
  });
  test("a normal filesystem path is not mistaken for an opaque blob", () => {
    const path = "/home/brooswit/butchr-workspaces/KAN-706-a-very-long-branch-name";
    expect(redact(path)).toBe(path);
  });
});

describe("parseDirective", () => {
  test("ANSWER <n>", () => {
    expect(parseDirective("ANSWER 2")).toEqual({ kind: "option", n: 2, fp: null });
  });
  test("ANSWER <n> <fp>", () => {
    expect(parseDirective("ANSWER 2 a1b2c3d4")).toEqual({ kind: "option", n: 2, fp: "a1b2c3d4" });
  });
  test("ANSWER TEXT <words>", () => {
    expect(parseDirective("ANSWER TEXT do it differently")).toEqual({ kind: "text", text: "do it differently", fp: null });
  });
  test("ANSWER TEXT <words> <fp> strips the fingerprint, keeps the text intact", () => {
    expect(parseDirective("ANSWER TEXT do it differently a1b2c3d4")).toEqual({ kind: "text", text: "do it differently", fp: "a1b2c3d4" });
  });
  test("plain prose with no ANSWER line is null", () => {
    expect(parseDirective("Sounds good, go ahead with option 2.")).toBeNull();
  });
  test("an ANSWER line with a non-numeric arg and no TEXT keyword is null", () => {
    expect(parseDirective("ANSWER banana")).toBeNull();
  });
  test("the daemon's OWN escalation comment is never read back as an answer", () => {
    const own = escalationComment("KAN-1", prompt("Q", ["A", "B"]), "a1b2c3d4");
    expect(parseDirective(own)).toBeNull();
  });
  test("a reply that quotes the marker mid-body (not at the start) is still a valid answer", () => {
    // Regression: KAN-732 review of PR #27 — `.includes(MARKER)` was too broad
    // and silently dropped answers that quote what they're replying to.
    const reply = "Replying to the escalation:\n> [butchr:blocked] KAN-1 is waiting...\nANSWER 2 a1b2c3d4";
    expect(parseDirective(reply)).toEqual({ kind: "option", n: 2, fp: "a1b2c3d4" });
  });
  test("finds the first ANSWER line among other prose", () => {
    expect(parseDirective("I looked at this.\nANSWER 3 deadbeef\nThanks.")).toEqual({ kind: "option", n: 3, fp: "deadbeef" });
  });
});

describe("escalationComment — redaction end-to-end (KAN-736)", () => {
  const PANE_WITH_SECRET = `$ cat .env
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
DATABASE_URL=postgres://admin:hunter2@prod-db.internal:5432/main
GITHUB_TOKEN=ghp_16CharsOfRealLookingTokenAAAAAAAAAAAA
$ deploy --prod
Choose deployment target:
❯ 1. Production
  2. Staging
Enter to confirm · Esc to cancel`;

  test("a pane carrying a secret produces a comment with the question tail and every option, but no secret value", () => {
    const p = parsePrompt(PANE_WITH_SECRET)!;
    const c = escalationComment("KAN-1", p, "a1b2c3d4");
    expect(c).toContain("Choose deployment target:");
    expect(c).toContain("1. Production");
    expect(c).toContain("2. Staging");
    expect(c).not.toContain("wJalrXUtnFEMI");
    expect(c).not.toContain("hunter2");
    expect(c).not.toContain("ghp_16CharsOfRealLookingTokenAAAAAAAAAAAA");
  });

  test("secrets in option labels are also redacted (defence in depth)", () => {
    const p: Prompt = { question: "Use this token?", options: ["Yes, use ghp_16CharsOfRealLookingTokenAAAAAAAAAAAA", "No"], current: 1 };
    const c = escalationComment("KAN-1", p, "a1b2c3d4");
    expect(c).not.toContain("ghp_16CharsOfRealLookingTokenAAAAAAAAAAAA");
  });

  test("the 600-char cap truncates a long question with a marker", () => {
    const longQuestion = "word ".repeat(140); // 700 chars, no single run is blob-length
    const p: Prompt = { question: longQuestion, options: ["Yes", "No"], current: 1 };
    const c = escalationComment("KAN-1", p, "a1b2c3d4");
    expect(c).toContain(longQuestion.slice(0, 600) + " …[truncated]");
    expect(c).not.toContain(longQuestion.slice(0, 601));
  });

  test("REGRESSION: the two REAL captured dialogs still parse identically and escalate unchanged (no secrets to redact)", () => {
    const REAL = `This session is 2d 12h old and 673.2k tokens.
Resuming the full session will consume a substantial portion of your usage limits. We
recommend resuming from a summary.
❯ 1. Resume from summary (recommended)
  2. Resume full session as-is
  3. Don't ask me again
Enter to confirm · Esc to cancel`;
    const realPrompt = parsePrompt(REAL)!;
    expect(realPrompt.options).toEqual(["Resume from summary (recommended)", "Resume full session as-is", "Don't ask me again"]);
    const realComment = escalationComment("KAN-1", realPrompt, "a1b2c3d4");
    expect(realComment).toContain("Resuming the full session");
    expect(realComment).toContain("1. Resume from summary (recommended)");

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
    const trustPrompt = parsePrompt(TRUST)!;
    expect(trustPrompt.options).toEqual(["No, exit", "Yes, I trust this folder"]);
    const trustComment = escalationComment("KAN-1", trustPrompt, "a1b2c3d4");
    expect(trustComment).toContain("1. No, exit");
    expect(trustComment).toContain("2. Yes, I trust this folder");
  });
});

describe("freeTextOption", () => {
  test("finds the option that opens free-text entry, by content", () => {
    expect(freeTextOption(prompt("Proceed?", ["Yes, proceed", "No, and tell Claude what to do differently", "No, exit"]))).toBe(2);
  });
  test("returns null when no option matches", () => {
    expect(freeTextOption(prompt("Resume?", ["Resume from summary", "Resume full session", "Don't ask again"]))).toBeNull();
  });
  test("returns null rather than guessing when more than one option matches", () => {
    expect(freeTextOption(prompt("Pick", ["Write custom instructions", "Other feedback"]))).toBeNull();
  });
  test("a bare 'write' in a permission grant is NOT mistaken for the free-text option", () => {
    // Regression: KAN-732 review of PR #27 — Claude Code permission dialogs
    // routinely offer "...read and write files here", which a bare /write/i
    // wrongly classified as the free-text entry.
    expect(freeTextOption(prompt("Proceed?", ["Yes, allow Claude to read and write files here", "No, exit"]))).toBeNull();
  });
});
