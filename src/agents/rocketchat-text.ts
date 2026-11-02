/**
 * The hardened-post text pipeline for EVERY Rocket.Chat message butchr
 * composes — the FACTORY-607 comment 28781 (Part A) / FACTORY-611
 * neutralisation rules, lifted verbatim out of `src/agents/escalation-loop.ts`
 * (where they were module-private) so a SECOND poster — FACTORY-630's ops
 * alert, `src/agents/ops-alert.ts` — reuses this exact pipeline instead of
 * re-deriving a weaker one by hand. The move is deliberately
 * behaviour-preserving: every function below is the escalation path's own
 * implementation unchanged, and `escalation-loop.ts` now imports them from
 * here rather than defining them, so its existing tests
 * (`test/unit/factory-611-*.test.ts`, `test/unit/managed-session-*.test.ts`,
 * and the real-parser fence test) are the regression proof that nothing
 * about the escalation posts changed.
 *
 * WHY THIS IS SHARED AND THE ROUTING IS NOT: the rules here are properties
 * of ROCKET.CHAT'S OWN PARSER and of the fact that quoted text can be
 * attacker-reachable — `@rocket.chat/message-parser` 0.32.0 recognising
 * exactly a 3-backtick fence, RC 8.8's `Message_MaxAllowedSize` of 5000,
 * `://` being what autolinks, `@` being what pings a real human from a bot
 * account. None of that varies by WHICH butchr feature is posting, so a
 * second copy could only ever drift into being wrong. Which room, which
 * mention and which tier delay to use DO vary per feature, and deliberately
 * stay with each caller (`MANAGED_ESCALATION_DEFAULTS` in
 * `./escalation-helper.ts` for the escalation path; `Config.opsAlert` for the
 * ops-alert path).
 *
 * DELIBERATELY NOT APPLIED TO JIRA-SHAPED TEXT (`escalationComment` in
 * `./escalate.ts`, `unresponsiveComment` in `./escalation-loop.ts`): the
 * requirement that produced these rules is scoped to a bot account posting
 * live, attacker-reachable pane text into a room where an unneutralised
 * `@all`/`@here` would ping real people FROM that bot account. A Jira
 * comment is posted by butchr's own existing account under its own existing
 * notification rules — a different exposure, and one neither FACTORY-607 nor
 * this ticket was asked to change.
 */
import { redact } from "./escalate.js";

/** A quoted field's character cap — stated here, not a magic number at each call site. Comment 28781 requires an EXPLICIT cap with a `... [truncated N chars]` marker; 2000 is generous for a dialog's question/option text (measured fixtures in escalation-loop.ts's own tests are well under 200 chars) while still bounding a pathological pane's output. FACTORY-611: this is the PER-FIELD ceiling — a caller's whole-message budget can shrink it further for a single oversized post, but never raise it. */
export const QUOTE_FIELD_CHAR_CAP = 2000;

/**
 * FACTORY-611 item 1: Rocket.Chat 8.8's own parser
 * (`@rocket.chat/message-parser` 0.32.0) recognizes ONLY a 3-backtick fence —
 * an older "widen the fence past the longest run" strategy was the bug
 * comment 28784 item 1 found: RC never sees a widened fence as special, so a
 * quoted run of 3+ backticks still closes (or entirely prevents) the ONE
 * 3-backtick fence this module actually emits. The fence is therefore fixed
 * at exactly 3 backticks, and every run of 3 or more backticks INSIDE a
 * quoted field is broken instead (see `breakBacktickRuns`) — the fence never
 * changes shape, the content does.
 */
export const FENCE = "```";

/**
 * FACTORY-611 item 5(a): Rocket.Chat 8.8's own `Message_MaxAllowedSize` is
 * 5000 — callers budget the WHOLE composed message (header, fences and every
 * labelled field included) to this smaller 4500, leaving headroom for
 * routing quirks (an emoji's multi-code-unit length, etc.) butchr cannot
 * predict exactly.
 */
export const WHOLE_MESSAGE_BUDGET = 4500;

/**
 * FACTORY-611 item 1: break every run of 3+ backticks in quoted content by
 * interleaving U+200B (zero-width space) between each backtick — a run of
 * any length (3, 4, 50, …) stops being a run RC's parser could ever read as
 * a fence, while staying visually identical to a human skimming the post
 * (the same zero-width-space technique `neutralizeMentions`/`defangLinks`
 * already use below). A run of 1-2 backticks is left untouched: RC's parser
 * never treats those as a fence, and a lone trailing backtick is ordinary
 * dialog content.
 */
export function breakBacktickRuns(text: string): string {
  return text.replace(/`{3,}/g, (run) => run.split("").join("​"));
}

/**
 * FACTORY-611 item 1: bidi-control characters (U+202A-202E, U+2066-2069,
 * U+200E, U+200F, U+061C) can visually reorder or hide text around them —
 * including, in principle, making a forged field label or a neutralised
 * `@`/`://` marker read differently than it actually is — so they are
 * stripped from every quoted field, never merely neutralised. U+2028 (LINE
 * SEPARATOR), U+2029 (PARAGRAPH SEPARATOR) and U+0085 (NEL) are stripped
 * alongside them: all three are alternate line-break code points `\r`/`\n`
 * handling does not cover, and which could otherwise let quoted text open a
 * new paragraph/line outside the fenced block the same way a bare `\r` could.
 */
export const BIDI_AND_LINE_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u2028\u2029\u0085]/g;

/** Comment 28781's "control characters and `\r` stripped or neutralised": `\r` is dropped outright (never folded into `\n`) so a CRLF-style line can never reintroduce a line break Rocket.Chat's renderer might treat differently than a bare `\n`; every other C0 control character and DEL is stripped too — none of them are legitimate dialog content. FACTORY-611 item 1: bidi controls and the other Unicode line/paragraph separators (`BIDI_AND_LINE_CONTROLS`) are stripped here too, for the same reason. */
export function stripControlChars(text: string): string {
  return text.replace(/\r/g, "").replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(BIDI_AND_LINE_CONTROLS, "");
}

/**
 * FACTORY-611 item 6(a): a quoted multi-line field must not be able to start
 * a line that LOOKS like one of the message's own labelled fields
 * (`fingerprint: ...`, `capture: ...`, `host: ...`, …) to a human skimming
 * the fenced block — forging one is otherwise as easy as putting
 * `fingerprint: deadbeef` on its own line inside the real quoted text.
 * CHOICE: flatten every embedded newline to a single visible marker (` ⏎ `)
 * rather than indenting continuation lines, so EVERY quoted field is
 * unconditionally exactly one line — simpler than tracking which lines are
 * "continuations" and just as legible. Confinement inside the fenced block
 * alone was sufficient against Rocket.Chat's OWN renderer (item 1's scope),
 * but not against a human simply reading the block's labelled lines at face
 * value.
 */
export function flattenNewlines(text: string): string {
  return text.replace(/\n/g, " ⏎ ");
}

/**
 * FACTORY-611 item 6(b): `String.prototype.slice` cuts on UTF-16 code units,
 * so a naive `text.slice(0, cap)` can land exactly between a surrogate
 * pair's high and low half, producing a lone surrogate in the posted text
 * (measured live). If `cap` would split a pair, the cut point backs up by
 * one — losing at most one extra character, never producing an unpaired
 * surrogate.
 */
export function safeTruncateIndex(text: string, cap: number): number {
  if (cap <= 0 || cap >= text.length) return Math.max(0, Math.min(cap, text.length));
  const code = text.charCodeAt(cap - 1);
  return code >= 0xd800 && code <= 0xdbff ? cap - 1 : cap;
}

/** Comment 28781's "a stated character cap with an explicit `... [truncated N chars]` marker" — surrogate-safe (FACTORY-611 item 6(b), see `safeTruncateIndex`). */
export function truncateField(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const i = safeTruncateIndex(text, cap);
  return `${text.slice(0, i)}... [truncated ${text.length - i} chars]`;
}

/** U+200B (zero-width space) immediately after every `@` — splits `@all`/`@here`/`@admin-assembly`/any other handle so NOTHING outside the intended header mention can ever resolve as a mention, in Rocket.Chat or any other reader, while staying visually identical to a human skimming the post. FACTORY-611 item 6(c): kept as defence in depth even once the fence itself provably holds (item 1's own real-parser test) — a quoted field also appears in the header-adjacent text of a composed message's header line (the session name; FACTORY-630's subject), which sits OUTSIDE the fenced block by design, so confinement alone does not cover every mention-shaped field. */
export function neutralizeMentions(text: string): string {
  return text.replace(/@/g, "@​");
}

/**
 * FACTORY-611 item 6(d): the ONLY sanitiser applied to a plain journal line
 * (never a quoted Rocket.Chat field — those go through the fuller
 * `quoteField` pipeline below) that interpolates raw pane text — strips
 * control characters and flattens embedded newlines to a visible marker so a
 * newline or ESC byte in a dialog's question/options cannot forge an extra
 * marker-looking journal line.
 */
export function sanitizeForJournal(text: string): string {
  return flattenNewlines(stripControlChars(text));
}

/** Comment 28781's "links and markup defanged": `://` is what turns a quoted `https://...` into a clickable link, and what markdown's `[text](url)` needs too — breaking it with the same zero-width-space technique neutralizes both without visually mangling the text (CHOICE: defang `://` rather than test for non-linking, since Rocket.Chat's own autolink behaviour is not something this test suite can exercise without a live instance). */
export function defangLinks(text: string): string {
  return text.replace(/:\/\//g, ":​//");
}

/**
 * The shared pipeline EVERY quoted field in a Rocket.Chat message goes
 * through before composition: strip control/bidi/line-separator chars first
 * (so the cap counts real content, not bytes about to be discarded), THEN —
 * for a field that can carry live pane/agent text (FACTORY-611 item 2) —
 * redact secret-shaped substrings BEFORE truncation, so a credential can
 * never straddle the cut, THEN flatten embedded newlines to a single visible
 * line (item 6(a)), THEN cap length surrogate-safely (item 6(b)), THEN break
 * any 3+ backtick run (item 1), THEN neutralise mentions and defang links
 * (both are harmless to run last — neither can re-lengthen the text past the
 * cap in a way that matters, and running them after truncation/breaking
 * means a cut mid-`@`/mid-`://` can't produce a half-neutralised artifact at
 * the boundary).
 */
export function quoteField(raw: string, opts: { cap?: number | undefined; redactSecrets?: boolean } = {}): string {
  const cap = opts.cap ?? QUOTE_FIELD_CHAR_CAP;
  let s = stripControlChars(raw);
  if (opts.redactSecrets) s = redact(s);
  s = flattenNewlines(s);
  s = truncateField(s, cap);
  s = breakBacktickRuns(s);
  s = neutralizeMentions(s);
  s = defangLinks(s);
  return s;
}

/**
 * Compose the labeled, already-neutralised quoted-field lines as ONE fenced
 * code block at the FIXED 3-backtick fence (`FENCE`) — everything
 * pane-derived lives inside it, never only individually escaped, which is
 * what makes a multi-line, adversarial field unable to inject a
 * header-looking line or a bare `@mention` outside the block (comment
 * 28781's confinement requirement). Every line must already have been
 * through `quoteField` (and so `breakBacktickRuns`), so the body itself can
 * never contain an unbroken 3+ backtick run that could close this fence
 * early (FACTORY-611 item 1).
 */
export function quotedBlock(lines: readonly string[]): string {
  const body = lines.join("\n");
  return [FENCE, body, FENCE].join("\n");
}
