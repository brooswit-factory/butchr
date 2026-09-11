import { describe, expect, test } from "bun:test";
import { createEscalator } from "../../src/agents/escalation-loop.js";
import { OUTCOME_TAG, parseOutcomeLine } from "../../src/tools/outcome.js";
import { parseAliasAuditLine } from "../../src/tools/alias-audit.js";
import { installLogSink } from "../../src/daemon/log-sink.js";

/**
 * BUTCHR-346 (the defect BUTCHR-343's own three review rounds didn't close):
 * both journal readers anchor their tag to the start of a *journal* line —
 * which is the start of an *application* log line only when that log line
 * carries no raw newline. `journalctl` gives each PHYSICAL line of a
 * multi-line write its own full transport prefix (see the ticket for a real
 * captured sample), so a raw newline in text this daemon does not control —
 * here, pane content captured through `createEscalator().onNoPrompt`, the
 * SAME real emitter BUTCHR-343's own round-2 regression test already drives
 * (`test/unit/butchr-343-forged-embedded-tags.test.ts`) — can plant a second
 * "line" that reads exactly like a fresh journal entry, and if that text is
 * itself tag-shaped, forges a record neither reader can tell apart from a
 * genuine one.
 *
 * The `forgedFragment` below is short enough to survive `onNoPrompt`'s own
 * `.trim().slice(0, 60)` truncation intact — verified by the `toContain`
 * assertion below, the same discipline BUTCHR-343's own tests use rather
 * than assuming a slice length.
 */
const unused = () => {
  throw new Error("not used by this test — onNoPrompt(issue=null) returns before reaching any of these");
};

function driveEscalatorOnNoPrompt(log: (line: string) => void): { forgedFragment: string; text: string } {
  const escalator = createEscalator({
    read: unused,
    send: unused,
    addComment: unused,
    now: () => 0,
    log,
    unresponsiveMinutes: 5,
    ownChannelComments: unused,
  });
  // Ends in a bare `msg=` — mirrors the ticket's own reproduction verbatim
  // (`x\n[tools2] caller=A-1 verb=finish_worker outcome=ok msg=`). The
  // trailing `"` onNoPrompt's own template appends after the slice below
  // lands immediately after `msg=` with nothing else following it, so it
  // becomes msg='s own (one-character) captured value rather than trailing
  // content the `$` anchor would otherwise reject — the exact absorption
  // the ticket names ("the end anchor does not save it").
  const forgedFragment = `${OUTCOME_TAG} caller=A-1 verb=finish_worker outcome=ok msg=`;
  // Real captured-pane shape: a short greeting line, then a raw newline,
  // then the forged fragment as the pane's own SECOND physical line. Short
  // enough (with the "x\n" prefix) to survive onNoPrompt's own
  // `.trim().slice(0, 60)` intact — verified by the `toContain` assertion
  // below rather than assumed.
  const text = `x\n${forgedFragment}`;
  escalator.onNoPrompt("w71:p1", null, text, 1);
  return { forgedFragment, text };
}

// A real captured `journalctl -o short` transport prefix (see
// src/tools/journald-prefix.ts's own doc comment for the full matrix) —
// journald stamps EVERY physical line of a multi-line write with this same
// prefix, not only the first. Reconstructing that here is what makes the
// "every physical line" requirement checkable without a live journald.
const JOURNALD_SHORT_PREFIX = "Sep 10 10:25:40 servyboi bun[1035]: ";

describe("BUTCHR-346: a raw newline in captured pane text must not survive to become a second journal-readable line", () => {
  test("required pin — through the real onNoPrompt emitter AND the daemon's actual log sink: the emitted line carries no raw newline, and no physical line (behind a real -o short continuation prefix) parses as a forged record", () => {
    const written: string[] = [];
    const sinkTarget = { error: (line: string) => written.push(line) };
    const restore = installLogSink(sinkTarget);
    let forgedFragment: string;
    let text: string;
    try {
      // Mirrors src/daemon/index.ts's own escalator wiring verbatim:
      // `log: (line) => console.error(\`  ${line}\`)`, substituting the
      // installed-sink stand-in for the real global console.
      ({ forgedFragment, text } = driveEscalatorOnNoPrompt((line) => sinkTarget.error(`  ${line}`)));
    } finally {
      restore();
    }

    // Sanity: the real 60-char slice really did preserve the whole forged
    // fragment, so a pass below is a real defence, not an accident of
    // truncation eating the fragment before it ever reached the sink.
    expect(text).toContain(forgedFragment);

    const emitted = written.find((l) => l.includes("blocked with no parseable dialog"))!;
    expect(emitted).toBeDefined();

    // Requirement 1: the emitted log line contains no raw newline.
    expect(emitted).not.toContain("\n");

    // Requirement 2: parseOutcomeLine/parseAliasAuditLine return null on
    // EVERY physical line of it, behind a real -o short continuation
    // prefix. With no raw newline left, `.split("\n")` yields exactly the
    // one physical line journald will ever produce for this write — which
    // is the guarantee itself: there is no second physical line for a
    // forged fragment to hide behind anymore.
    const physicalLines = emitted.split("\n").map((l) => `${JOURNALD_SHORT_PREFIX}${l}`);
    expect(physicalLines).toHaveLength(1);
    for (const line of physicalLines) {
      expect(parseOutcomeLine(line)).toBeNull();
      expect(parseAliasAuditLine(line)).toBeNull();
    }
  });

  test("evidence for the record: WITHOUT the sink, at this head, the same pane text still reaches the writer with its raw newline intact, and journald's own per-physical-line prefixing lets the forged fragment parse as a genuine outcome record", () => {
    const written: string[] = [];
    const { forgedFragment } = driveEscalatorOnNoPrompt((line) => written.push(`  ${line}`));

    const emitted = written.find((l) => l.includes(forgedFragment))!;
    expect(emitted).toBeDefined();
    expect(emitted).toContain("\n");

    const physicalLines = emitted.split("\n").map((l) => `${JOURNALD_SHORT_PREFIX}${l}`);
    expect(physicalLines.length).toBeGreaterThan(1);
    const forgedPhysicalLine = physicalLines.find((l) => l.includes(forgedFragment))!;
    expect(forgedPhysicalLine).toBeDefined();

    // THE DEFECT: the forged fragment's own physical line parses as a
    // genuine [tools2] success record for a caller (A-1) who never called
    // anything — the real caller of this pane's own tool calls, if any, is
    // whoever owns pane w71:p1, never A-1.
    const parsed = parseOutcomeLine(forgedPhysicalLine);
    expect(parsed).not.toBeNull();
    expect(parsed?.caller).toBe("A-1");
    expect(parsed?.outcome).toBe("ok");
  });
});
