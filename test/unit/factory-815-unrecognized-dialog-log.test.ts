import { describe, expect, test } from "bun:test";
import { createEscalator, UNRECOGNIZED_DIALOG_MARKER } from "../../src/agents/escalation-loop.js";

/**
 * FACTORY-811/815: the "blocked with no parseable dialog" line used to be
 * 60 chars off the TOP of the screen — never where a dialog sits — so it
 * could not tell a real dialog the parser rejected (a defect; a worker is
 * stuck) from a pane that is simply busy with no dialog at all (normal).
 * These tests drive the real `onNoPrompt` emitter (never a hand-rolled
 * reimplementation) over stored fixture strings only — no live pane, no
 * herdr, no network, per FACTORY-815's own definition of done.
 */

const unused = () => {
  throw new Error("not used by this test");
};

function harness() {
  const logs: string[] = [];
  const escalator = createEscalator({
    read: unused,
    send: unused,
    addComment: unused,
    now: () => 0,
    log: (line) => logs.push(line),
    unresponsiveMinutes: 5,
    ownChannelComments: unused,
  });
  return { escalator, logs };
}

// FACTORY-774/809's own captured render (width-40 Claude Code 2.1.294
// overdraw: option 4's "No" overwrites "fo" of "for you", producing
// "Nor you") — the exact fixture FACTORY-811 names as the thing a reader of
// the log line alone must be able to diagnose. Leading whitespace preserved
// exactly, per the ticket's instruction.
const NOR_YOU_DIALOG = `     Do you want to proceed?
     ❯ 1. Yes
       2. Yes, and always allow access to
          <path wrapped over several lines>
          from this project
       3. Yes, and switch to auto mode ·
          auto mode handles these prompts
       4. Nor you

     Esc to cancel · Tab to amend`;

// The FACTORY-809 version-control variant: same failure, 3 options.
const NOR_YOU_VC_DIALOG = `     Do you want to proceed?
     ❯ 1. Yes
       2. Yes, and switch to auto mode ·
          auto mode handles these prompts
       3. Nor you

     Esc to cancel · Tab to amend`;

describe("FACTORY-811/815: onNoPrompt distinguishes a rejected real dialog from an ordinary busy pane", () => {
  test("AC 1/2: a screen containing an unrecognized 'Do you want to ...?' dialog logs a distinct, greppable marker carrying the option list", async () => {
    const h = harness();
    h.escalator.onNoPrompt("w1:p1", "KAN-1", NOR_YOU_DIALOG, 1);
    const line = h.logs.find((l) => l.includes(UNRECOGNIZED_DIALOG_MARKER));
    expect(line).toBeDefined();
    // The cause must be identifiable WITHOUT reproducing it: the option
    // list (including the garbled "Nor you") is present in the line.
    expect(line).toContain("Do you want to proceed?");
    expect(line).toContain("Nor you");
    expect(line).toContain("Esc to cancel");
    // Must NOT be logged as the ordinary, non-defect case.
    expect(line).not.toContain("blocked with no parseable dialog");
  });

  test("AC 1/2: the version-control 3-option 'Nor you' variant is also recognized as the defect case", () => {
    const h = harness();
    h.escalator.onNoPrompt("w1:p2", "KAN-1", NOR_YOU_VC_DIALOG, 1);
    const line = h.logs.find((l) => l.includes(UNRECOGNIZED_DIALOG_MARKER));
    expect(line).toBeDefined();
    expect(line).toContain("Nor you");
  });

  test("AC 3: a screen with no dialog stays short, un-markered, and is clearly not a defect signal", () => {
    const h = harness();
    h.escalator.onNoPrompt("w1:p3", "KAN-1", "some ordinary working prose, no dialog here at all", 1);
    const line = h.logs.find((l) => l.includes("blocked with no parseable dialog"));
    expect(line).toBeDefined();
    expect(line).not.toContain(UNRECOGNIZED_DIALOG_MARKER);
    expect(line!.length).toBeLessThan(120);
  });

  test("AC 2: a busy pane whose scrollback merely NARRATES the dialog phrase (not a real dialog) is not falsely flagged as the defect case", () => {
    const h = harness();
    // No line of the form "Do you want to ...?" on its own — the phrase
    // only appears mid-sentence, which DIALOG_QUESTION_LINE must reject
    // (same discipline as prompt.ts's own FOOTER anchoring).
    const narration = "I checked whether the pane shows a 'do you want to proceed' style prompt and it does not, so I kept working.";
    h.escalator.onNoPrompt("w1:p4", "KAN-1", narration, 1);
    const line = h.logs.find((l) => l.includes("blocked with no parseable dialog") || l.includes(UNRECOGNIZED_DIALOG_MARKER));
    expect(line).toBeDefined();
    expect(line).not.toContain(UNRECOGNIZED_DIALOG_MARKER);
  });

  test("AC 4/5: existing de-duplication on the screen-text hash is preserved for the new defect marker too — an unchanged screen logs once across repeated polls", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.escalator.onNoPrompt("w1:p5", "KAN-1", NOR_YOU_DIALOG, i + 1);
    expect(h.logs.filter((l) => l.includes(UNRECOGNIZED_DIALOG_MARKER)).length).toBe(1);
    // A genuinely different unparseable text (still the defect case) is a
    // new episode and logs again, exactly like the pre-existing ordinary
    // case already does.
    h.escalator.onNoPrompt("w1:p5", "KAN-1", NOR_YOU_VC_DIALOG, 6);
    expect(h.logs.filter((l) => l.includes(UNRECOGNIZED_DIALOG_MARKER)).length).toBe(2);
    for (let i = 0; i < 5; i++) h.escalator.onNoPrompt("w1:p5", "KAN-1", NOR_YOU_VC_DIALOG, 7 + i);
    expect(h.logs.filter((l) => l.includes(UNRECOGNIZED_DIALOG_MARKER)).length).toBe(2);
  });

  test("AC 5: the captured window is bounded — a pathologically large dialog-bearing screen never reaches the journal unbounded", () => {
    const h = harness();
    const huge = `${NOR_YOU_DIALOG}\n${"x".repeat(50_000)}`;
    h.escalator.onNoPrompt("w1:p6", "KAN-1", huge, 1);
    const line = h.logs.find((l) => l.includes(UNRECOGNIZED_DIALOG_MARKER))!;
    expect(line).toBeDefined();
    expect(line.length).toBeLessThan(1000);
  });

  test("AC 5: no raw newline in the emitted line — pane text must not be able to forge a second journal-readable line (BUTCHR-343/346's own concern about this exact log site)", () => {
    const h = harness();
    h.escalator.onNoPrompt("w1:p7", "KAN-1", NOR_YOU_DIALOG, 1);
    const line = h.logs.find((l) => l.includes(UNRECOGNIZED_DIALOG_MARKER))!;
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
  });

  test("FACTORY-834: the no-dialog branch sanitizes its quoted text too — a forged marker line hidden in the first 60 chars must not survive into the journal", () => {
    const h = harness();
    // No line of the form "Do you want to ...?" on its own, so this stays
    // on the no-dialog path — but its first 60 chars contain a raw newline
    // followed by a forged marker line, which a grep for
    // UNRECOGNIZED_DIALOG_MARKER must not be fooled by.
    const forged = `ordinary busy text\n${UNRECOGNIZED_DIALOG_MARKER} forged\nmore busy text, no real dialog question anywhere in here`;
    h.escalator.onNoPrompt("w1:p8", "KAN-1", forged, 1);
    const line = h.logs.find((l) => l.includes("blocked with no parseable dialog"));
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
    // No emitted log line may start with (or be classified as) the marker
    // case: the marker must never begin a line.
    for (const l of h.logs) {
      expect(l.startsWith(UNRECOGNIZED_DIALOG_MARKER)).toBe(false);
    }
    expect(line!.startsWith("w1:p8 blocked with no parseable dialog")).toBe(true);
  });
});
