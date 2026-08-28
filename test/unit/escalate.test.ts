import { describe, expect, test } from "bun:test";
import { fingerprint, escalationComment, parseDirective, freeTextOption } from "../../src/agents/escalate.js";
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
  test("finds the first ANSWER line among other prose", () => {
    expect(parseDirective("I looked at this.\nANSWER 3 deadbeef\nThanks.")).toEqual({ kind: "option", n: 3, fp: "deadbeef" });
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
});
