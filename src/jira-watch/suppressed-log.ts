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
 *
 * For the two classes THIS module logs, "no line" is NOT unambiguous proof
 * that nothing was suppressed — that overclaim was this comment's own
 * defect (BUTCHR-350 PR #352 review round 1) and is corrected here. Each
 * emitter fires unconditionally on ITS OWN trigger condition, no sampling,
 * no aggregation — but each trigger condition is itself a DETECTOR, and a
 * detector can have blind spots a real instance still falls into:
 *
 * - `stand-down`: the trigger (`unseen.length === 0`, inside
 *   `createIssueEventRules`'s `finalize`) is unconditional and total for
 *   what it covers — no known blind spot. "No `arm=stand-down` line for a
 *   poll where the gate ran" genuinely means it did not suppress there.
 *
 * - `agent-fold`: the trigger is `idx >= 2` (see `agentFoldSuppressedLine`'s
 *   own doc comment for why 2, not any change) — a DELIBERATE
 *   under-approximation of "a fold happened", not a total one. A real fold
 *   (a foreign comment genuinely swallowed by this arm) produces NO LINE in
 *   at least four situations: (1) the position-1 case that doc comment
 *   already names — the agent's own write was not itself a comment and
 *   exactly one foreign comment landed in the window; (2) the recorded
 *   baseline id is not present at all in the fetched page (`idx === -1`) —
 *   `AtlassianClient.comments()`'s own page size can leave an older
 *   baseline off the page on a busy ticket; (3) no baseline was recorded
 *   for this key yet (`!hadBaseline`, or a `null` baseline — the ticket's
 *   very first comment); (4) the `fetchComments` call itself failed
 *   (`!result.ok` — fail-open leaves the cursor untouched, and whatever
 *   happened in that window is simply unobserved). "No `arm=agent-fold`
 *   line" therefore means "no fold this detector could positively
 *   establish" — evidence of no DETECTED fold, never proof of no fold. It
 *   never FALSE-POSITIVES (see `agentFoldSuppressedLine`'s own doc comment
 *   for why `idx >= 2` cannot fire without a genuine second mover), so a
 *   line that DOES appear is trustworthy; the absence of one is not.
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
 *
 * THE `newCount >= 2` GUARD NEVER FALSE-POSITIVES, BUT IT DOES
 * FALSE-NEGATIVE (BUTCHR-350 PR #352 review round 1 — stated here, not only
 * at this module's top comment, since a reader who lands on this function
 * directly should not have to go find that): a genuine fold with exactly
 * ONE comment newer than the baseline (the agent's own round-trip write was
 * NOT itself a comment, and exactly one foreign comment landed in the same
 * window) is indistinguishable, by this signal alone, from the ordinary
 * "only the agent's own new comment landed" case — no line. So is a fold
 * whose baseline has aged off the fetched page entirely (a busy ticket
 * under `AtlassianClient.comments()`'s own page size). Neither is claimed
 * away: "no line" from this function's caller means "no fold this detector
 * could POSITIVELY establish", never "no fold happened".
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
 * FIRST NON-WHITESPACE token (nothing but the optional prefix and
 * whitespace may precede it), then `key=`/`watcher=`/`arm=`
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
 *
 * BUTCHR-351 CORRECTION: the "every single-line `--output=` mode" claim
 * above was true of `JOURNALD_PREFIX_SRC` in isolation, but this regex used
 * to interpolate it directly against `\[notify-suppressed\]` with nothing
 * between them. Production never emits a bare tag: every `log:` dep in
 * `src/daemon/index.ts`, this one included, is `(line) => console.error(\`
 * ${line}\`)` — a two-space indent applied UNCONDITIONALLY, prefix or not
 * (see that file's own call site). Alongside a genuine journalctl prefix,
 * `JOURNALD_PREFIX_SRC`'s own trailing `:\s*` happened to absorb that
 * indent too, so the old regex matched — but under `journalctl -o cat` (no
 * prefix at all) or any other raw capture, the indent had nothing to
 * absorb it, and a genuine, unmodified production line failed to parse: a
 * silent false negative, exactly what this module exists to prevent. Fixed
 * by tolerating optional whitespace between the (optional) prefix and the
 * tag — the same `\s*` `parseAliasAuditLine`'s `TOOLS_LINE` already carries
 * (`src/tools/alias-audit.ts`) for the identical reason. Pinned by a test
 * that builds the line through the PRODUCTION log closure's own shape, not
 * the bare emitter return value (`test/unit/suppressed-log.test.ts`),
 * failing first at `5119e61` for exactly this reason (a `null` parse under
 * `-o cat`), not a missing import.
 */
const SUPPRESSED_LINE_RE = new RegExp(
  `^${JOURNALD_PREFIX_SRC}\\s*\\[notify-suppressed\\]\\s+key=(\\S+)\\s+watcher=(\\S+)\\s+arm=(\\S+)((?:\\s+(?!msg=)\\S+=\\S+)*)(?:\\s+msg=(.*))?$`,
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
