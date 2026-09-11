import { describe, expect, test } from "bun:test";
import {
  SUPPRESSED_TAG,
  agentFoldSuppressedLine,
  parseSuppressedLine,
  standDownSuppressedLine,
} from "../../src/jira-watch/suppressed-log.js";
import { OUTCOME_TAG } from "../../src/tools/outcome.js";

/**
 * BUTCHR-350 (§3A/§3B, AC2): `[notify-suppressed]` is a brand-new tag — no
 * prior line ever carried it, so there is no OLD format to stay
 * bidirectionally distinct from (unlike `[tools2]`/`[admission2]`'s own
 * BUTCHR-343 history). What AC2 still demands here: the reader must be
 * anchored to the line's own start (tolerating only a genuine `journalctl`
 * transport prefix), must be pinned against the REAL emitter's output (not
 * hand-typed strings), and must not be foolable by free text that merely
 * LOOKS tag-shaped. See suppressed-log.ts's own top comment for why this
 * line class carries no attacker-controllable free text at all (key/watcher
 * are Jira issue keys, the id fields are Jira comment ids, `msg=` is always
 * one of this module's own two fixed literal strings) — the "hostile
 * content" that matters here is a crafted-looking `msg=` VALUE that could
 * be mistaken for more fields, not attacker-supplied Jira content (covered
 * separately, end-to-end, by test/unit/loop.test.ts's KAN-838 suite, which
 * drives these same emitters through the real suppression stack).
 */

describe("agentFoldSuppressedLine: exact shape, fields before free text (AC3)", () => {
  test("pins the exact rendered line", () => {
    expect(agentFoldSuppressedLine("K", "c1", "f1", 2)).toBe(
      "[notify-suppressed] key=K watcher=K arm=agent-fold baseline=c1 newest=f1 new_comments=2" +
        " msg=a foreign comment was folded into this agent's own-write suppression and was not delivered this poll (KAN-838)",
    );
  });

  test("watcher is always the key itself — the AGENT arm is a self-suppression by construction", () => {
    const line = agentFoldSuppressedLine("BUTCHR-350", "1", "2", 2);
    expect(line).toContain("key=BUTCHR-350 watcher=BUTCHR-350 arm=agent-fold");
  });
});

describe("standDownSuppressedLine: exact shape", () => {
  test("pins the exact rendered line", () => {
    expect(standDownSuppressedLine("K", "W", 3)).toBe(
      "[notify-suppressed] key=K watcher=W arm=stand-down total_comments=3" +
        " msg=sleeping watcher has no unseen comment ids for this non-structural change",
    );
  });

  test("key and watcher can genuinely differ — arm 4 suppresses a WATCHER, not only a ticket's own agent", () => {
    const line = standDownSuppressedLine("BUTCHR-350", "BUTCHR-322", 0);
    expect(line).toContain("key=BUTCHR-350 watcher=BUTCHR-322 arm=stand-down");
  });
});

describe("parseSuppressedLine: round-trips the REAL emitters' own output", () => {
  test("agent-fold", () => {
    const line = agentFoldSuppressedLine("K", "c1", "f1", 2);
    expect(parseSuppressedLine(line)).toEqual({
      key: "K",
      watcher: "K",
      arm: "agent-fold",
      fields: { baseline: "c1", newest: "f1", new_comments: "2" },
      message: "a foreign comment was folded into this agent's own-write suppression and was not delivered this poll (KAN-838)",
    });
  });

  test("stand-down", () => {
    const line = standDownSuppressedLine("K", "W", 3);
    expect(parseSuppressedLine(line)).toEqual({
      key: "K",
      watcher: "W",
      arm: "stand-down",
      fields: { total_comments: "3" },
      message: "sleeping watcher has no unseen comment ids for this non-structural change",
    });
  });

  test("a non-matching line (no tag at all) returns null", () => {
    expect(parseSuppressedLine("  [notify] K ← K (comment:c1): channel pushed, prompt delivered")).toBeNull();
  });

  test("an OLD/OTHER tag ([tools2]) is never mistaken for this one, and vice versa — bidirectional (AC4's own discipline, applied even though this is a brand-new tag, not a reshaped old one)", () => {
    const outcomeLine = `${OUTCOME_TAG} caller=BUTCHR-9 verb=jira_get_issue outcome=ok`;
    expect(parseSuppressedLine(outcomeLine)).toBeNull();
    const suppressedLine = agentFoldSuppressedLine("K", "c1", "f1", 2);
    expect(suppressedLine.startsWith(OUTCOME_TAG)).toBe(false);
  });
});

describe("parseSuppressedLine: anchored to the line's own start — only journalctl's own transport prefix may precede the tag (AC2)", () => {
  // Same real captured samples test/unit/butchr-343-forged-embedded-tags.test.ts
  // pins parseOutcomeLine/parseAliasAuditLine against — every single-line
  // `journalctl --output=` mode, not only the default.
  const REAL_CAPTURED_PREFIXES: Array<[string, string]> = [
    ["short", "Sep 11 03:25:21 servyboi bun[641076]: "],
    ["short --utc", "Sep 11 10:25:48 servyboi bun[641076]: "],
    ["short-precise", "Sep 11 03:25:21.756106 servyboi bun[641076]: "],
    ["short-iso", "2026-09-11T03:25:21-07:00 servyboi bun[641076]: "],
    ["short-iso-precise", "2026-09-11T03:25:21.756106-07:00 servyboi bun[641076]: "],
    ["short-full", "Fri 2026-09-11 03:25:21 PDT servyboi bun[641076]: "],
    ["short-full --utc", "Fri 2026-09-11 10:25:48 UTC servyboi bun[641076]: "],
    ["short-unix", "1789122321.756106 servyboi bun[641076]: "],
    ["short-monotonic", "[58397.767905] servyboi bun[641076]: "],
    ["with-unit", "Fri 2026-09-11 03:25:48 PDT servyboi user@1001.service/butchr.service[641076]: "],
  ];

  for (const [mode, prefix] of REAL_CAPTURED_PREFIXES) {
    test(`accepts a genuine agent-fold line under journalctl -o ${mode}`, () => {
      const line = `${prefix}${agentFoldSuppressedLine("K", "c1", "f1", 2)}`;
      expect(parseSuppressedLine(line)?.arm).toBe("agent-fold");
    });
    test(`accepts a genuine stand-down line under journalctl -o ${mode}`, () => {
      const line = `${prefix}${standDownSuppressedLine("K", "W", 0)}`;
      expect(parseSuppressedLine(line)?.arm).toBe("stand-down");
    });
  }

  test("rejects the tag embedded mid-line, inside another record's own free text — 'what can start a journal line', not 'does this fragment appear anywhere'", () => {
    const forged = `  WARNING: [notify] stage threw: ${SUPPRESSED_TAG} key=K watcher=K arm=agent-fold baseline=1 newest=2 new_comments=2 msg=fake`;
    expect(parseSuppressedLine(forged)).toBeNull();
  });

  test("rejects a line with genuine text BEFORE the tag that is not journalctl's own transport prefix", () => {
    const forged = `not-journalctl-prefix ${agentFoldSuppressedLine("K", "1", "2", 2)}`;
    expect(parseSuppressedLine(forged)).toBeNull();
  });
});

describe("parseSuppressedLine: msg= boundary — free text is never mistaken for more k=v fields, and vice versa", () => {
  test("a msg value whose first word merely LOOKS like a field (contains '=') is still captured whole, as free text, not split", () => {
    // Neither emitter in this module ever produces a message shaped like
    // this — both messages are fixed literals — but the READER'S anchor
    // must not depend on that; a message could be extended later, and the
    // journald-prefix precedent (BUTCHR-343 round 1/2) is exactly "don't
    // assume the shape of free text you don't fully control".
    const line = `${SUPPRESSED_TAG} key=K watcher=K arm=agent-fold baseline=1 newest=2 new_comments=2 msg=looks=like-a-field but is just the message`;
    expect(parseSuppressedLine(line)).toEqual({
      key: "K",
      watcher: "K",
      arm: "agent-fold",
      fields: { baseline: "1", newest: "2", new_comments: "2" },
      message: "looks=like-a-field but is just the message",
    });
  });

  test("fields always precede free text: a line with fields AFTER a bare tag/key/watcher/arm but no msg= still parses the fields, with message: null", () => {
    const line = `${SUPPRESSED_TAG} key=K watcher=W arm=stand-down total_comments=5`;
    expect(parseSuppressedLine(line)).toEqual({ key: "K", watcher: "W", arm: "stand-down", fields: { total_comments: "5" }, message: null });
  });

  test("a raw newline inside what would be free text cannot appear on a genuine emitted line — installLogSink's own flatten is the backstop (see src/daemon/log-sink.ts); this reader refuses to match AT ALL across a literal newline (`.` does not match it, and `$` with no `m` flag anchors only the true end of the string), rather than silently matching a truncated prefix", () => {
    const line = `${SUPPRESSED_TAG} key=K watcher=K arm=agent-fold baseline=1 newest=2 new_comments=2 msg=first line\nsecond line looks like a fresh entry`;
    // Neither the tag's own free text (a truncated "first line") NOR a
    // forged second "entry" is recovered — the whole line simply fails to
    // parse as a suppressed-log record, which is a SAFER failure mode than
    // a partial match would be: a reader that saw `message: "first line"`
    // here would be the one being fooled, not this one.
    expect(parseSuppressedLine(line)).toBeNull();
  });
});
