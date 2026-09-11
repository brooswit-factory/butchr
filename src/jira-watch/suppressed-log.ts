import { JOURNALD_PREFIX_SRC } from "../tools/journald-prefix.js";

/**
 * suppressed-log.ts — BUTCHR-350 (implementing BUTCHR-322): the SUPPRESSION
 * side of the notify record. `src/resources/issue.ts`'s suppression stack
 * (`createIssueEventRules`) decides, per (key, watcher) pair, whether a
 * change is DELIVERED (`[notify]`, `src/agents/change-nudge.ts`) or
 * swallowed. Before this ticket, a swallowed ping wrote nothing at all —
 * indistinguishable, in the journal, from a change this daemon never
 * observed at all. This module is the emitter (and, for testability and
 * AC2's pinning requirement, the reader) for the two suppression classes
 * this ticket chose to always log.
 *
 * WHY ONLY TWO OF THE FOUR ARMS: measured on this daemon's own journal
 * (see the PR for the exact `journalctl` counts and the arithmetic derived
 * from them) — the two OMITTED arms (a pure daemon-label echo with no new
 * comment, on either the own-write-ledger DAEMON arm or the cross-daemon
 * check) fire on the order of 150-200 times/HOUR on this fleet alone, more
 * than the entire `[notify]` delivered volume; logging every one of those
 * would dwarf the rest of this journal for a class that is, definitionally,
 * "nothing happened here beyond a routine agent:* or pr:* flip echoing back".
 * The two logged here are both LOW volume and HIGH value: `agent-fold` is
 * the literal defect this story exists to make visible (KAN-838 — a foreign
 * comment silently swallowed), and `stand-down` is a genuine, observed
 * suppression of a real change (BUTCHR-307's sleep gate), not an echo.
 *
 * WHAT A MISSING LINE MEANS: see `createIssueEventRules`'s own doc comment
 * at each of the two OMITTED arms' call sites, and this ticket's own
 * Confluence doc, for the exact, honest statement of what "no
 * `[notify-suppressed]` line" does and does not prove for those two classes.
 * For the two classes THIS module logs, "no line" is unambiguous: that
 * suppression did not happen — see each emitter's own doc comment for why
 * (both fire unconditionally on their trigger, no sampling, no aggregation).
 */

/** The one tag every line this module emits carries — a NEW class, never previously written, so no existing reader can be confused by it (see AC4's own reasoning in the PR for why no *separate* tag per arm is warranted here either). */
export const SUPPRESSED_TAG = "[notify-suppressed]";

export type SuppressedArm = "agent-fold" | "stand-down";

/**
 * (B): the own-write ledger's AGENT arm (KAN-838) suppressed `key`'s own
 * agent's ping — always does, unconditionally, unchanged by this ticket —
 * and the comment id list it fetched to advance the cursor shows MORE THAN
 * ONE new comment landed since the recorded baseline (`newCount >= 2`, the
 * caller's own guard, not re-validated here). The agent's own write can
 * account for AT MOST one of those; the rest were not delivered to this
 * agent and never will be (see `ledgerHitSuppressed`'s own doc comment for
 * why the cursor advance makes this permanent, not merely delayed —
 * KAN-838/BUTCHR-350(C)). `baseline`/`newest` are comment IDS, never bodies.
 */
export function agentFoldSuppressedLine(key: string, baseline: string, newest: string, newCount: number): string {
  return (
    `${SUPPRESSED_TAG} key=${key} watcher=${key} arm=agent-fold baseline=${baseline} newest=${newest} new_comments=${newCount}` +
    ` msg=a foreign comment was folded into this agent's own-write suppression and was not delivered this poll (KAN-838)`
  );
}

/**
 * Arm 4: BUTCHR-307's stand-down gate suppressed a non-structural edge for a
 * currently-asleep `watcher` because every comment id `createIssueEventRules`
 * fetched for `key` this poll was already in `watcher`'s own seen-set at the
 * moment it stood down (`stand-down.ts`'s `unseenFor`) — a genuine
 * suppression of an observed change, not an echo, but not the lossy fold
 * case either (see this module's own top comment for why it is logged
 * unconditionally rather than aggregated). `totalComments` is a COUNT (the
 * length of the comment id list consulted), never the ids or their bodies.
 */
export function standDownSuppressedLine(key: string, watcher: string, totalComments: number): string {
  return (
    `${SUPPRESSED_TAG} key=${key} watcher=${watcher} arm=stand-down total_comments=${totalComments}` +
    ` msg=sleeping watcher has no unseen comment ids for this non-structural change`
  );
}

/** Recovered fields from one `[notify-suppressed]` line — pure, no filesystem/subprocess, fixturable against literal strings, same discipline `parseOutcomeLine` (src/tools/outcome.ts) already follows. */
export interface ParsedSuppressedLine {
  key: string;
  watcher: string;
  arm: string;
  /** Every `name=value` token between `arm=` and `msg=` (or end of line), keyed by name — a superset a caller narrows itself rather than this module guessing which arm's shape it's reading. */
  fields: Record<string, string>;
  message: string | null;
}

/**
 * AC2: anchored exactly like `src/tools/outcome.ts`'s `OUTCOME_LINE_RE` —
 * an optional `journalctl` transport prefix (`JOURNALD_PREFIX_SRC`, every
 * single-line `--output=` mode), then `SUPPRESSED_TAG` as the LINE'S OWN
 * FIRST token (nothing else may precede it), then `key=`/`watcher=`/`arm=`
 * in that fixed order, then zero or more further `name=value` tokens (never
 * `msg=` — the negative lookahead is what stops this repetition from eating
 * into free text whose first word happens to look like `msg=<word>`, see
 * `test/unit/suppressed-log.test.ts` for a line whose `msg=` value's FIRST
 * word is itself `key=looks-like-a-field` and is still captured as free
 * text, not as a spurious field), then an optional `msg=` free-text field
 * that runs to the end of the line — nothing may follow it. Every value here
 * is either a Jira ID (issue key or comment id — never user-authored text,
 * see this module's own emitters) or a small integer, so unlike
 * `[tools2]`'s `msg=`, none of the STRUCTURED fields here need
 * `sanitizeField`-style flattening; the `msg=` free text is always one of
 * this module's own fixed literal strings (see the two emitters above),
 * never Jira content — the log sink (`src/daemon/log-sink.ts`) is still the
 * backstop against a raw newline forging a second line, exactly as for
 * every other emitter, but there is no ATTACKER-CONTROLLED text on this
 * line at all for that backstop to need to catch.
 */
const SUPPRESSED_LINE_RE = new RegExp(
  `^${JOURNALD_PREFIX_SRC}\\[notify-suppressed\\]\\s+key=(\\S+)\\s+watcher=(\\S+)\\s+arm=(\\S+)((?:\\s+(?!msg=)\\S+=\\S+)*)(?:\\s+msg=(.*))?$`,
);

export function parseSuppressedLine(line: string): ParsedSuppressedLine | null {
  const m = line.match(SUPPRESSED_LINE_RE);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const tok of (m[4] ?? "").trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq > 0) fields[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return { key: m[1]!, watcher: m[2]!, arm: m[3]!, fields, message: m[5] ?? null };
}
