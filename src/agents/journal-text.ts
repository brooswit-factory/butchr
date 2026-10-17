/**
 * Making live pane/agent text safe to put in ONE daemon journal line: the
 * escalation loop's dialog lines (`./escalation-loop.ts`) and the ops-alert
 * route (`./ops-alert.ts`) interpolate text an agent or a dialog produced,
 * and a newline or a control byte in it must not be able to forge a second,
 * marker-looking line.
 */

/**
 * FACTORY-611 item 1: bidi-control characters (U+202A-202E, U+2066-2069,
 * U+200E, U+200F, U+061C) can visually reorder or hide text around them, so
 * they are stripped, never merely neutralised. U+2028 (LINE SEPARATOR),
 * U+2029 (PARAGRAPH SEPARATOR) and U+0085 (NEL) are stripped alongside them:
 * all three are alternate line-break code points `\r`/`\n` handling does not
 * cover.
 */
export const BIDI_AND_LINE_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u2028\u2029\u0085]/g;

/** `\r` is dropped outright (never folded into `\n`); every other C0 control character and DEL is stripped too — none of them are legitimate dialog content — and so are `BIDI_AND_LINE_CONTROLS`. */
export function stripControlChars(text: string): string {
  return text.replace(/\r/g, "").replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(BIDI_AND_LINE_CONTROLS, "");
}

/** FACTORY-611 item 6(a): every embedded newline becomes one visible marker (` ⏎ `), so a field is always exactly one line and can never start a line of its own. */
export function flattenNewlines(text: string): string {
  return text.replace(/\n/g, " ⏎ ");
}

/**
 * FACTORY-611 item 6(b): `String.prototype.slice` cuts on UTF-16 code units,
 * so a naive `text.slice(0, cap)` can land between a surrogate pair's halves.
 * If `cap` would split a pair, the cut point backs up by one — losing at most
 * one extra character, never producing an unpaired surrogate.
 */
export function safeTruncateIndex(text: string, cap: number): number {
  if (cap <= 0 || cap >= text.length) return Math.max(0, Math.min(cap, text.length));
  const code = text.charCodeAt(cap - 1);
  return code >= 0xd800 && code <= 0xdbff ? cap - 1 : cap;
}

/** A stated character cap with an explicit `... [truncated N chars]` marker — surrogate-safe (see `safeTruncateIndex`). */
export function truncateField(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const i = safeTruncateIndex(text, cap);
  return `${text.slice(0, i)}... [truncated ${text.length - i} chars]`;
}

/**
 * FACTORY-611 item 6(d): the sanitiser for a plain journal line that
 * interpolates raw pane text — strips control characters and flattens
 * embedded newlines to a visible marker, so a newline or ESC byte in a
 * dialog's question/options cannot forge an extra marker-looking line.
 */
export function sanitizeForJournal(text: string): string {
  return flattenNewlines(stripControlChars(text));
}
