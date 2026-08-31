import type { Prompt } from "./prompt.js";

/**
 * A directive parsed from a Jira comment, answering an escalated dialog.
 * `fp`, when present, is the fingerprint the replier copied from the
 * escalation comment — the caller must verify it against the live dialog
 * before acting.
 */
export type Directive =
  | { kind: "option"; n: number; fp: string | null }
  | { kind: "text"; text: string; fp: string | null };

export const MARKER = "[butchr:blocked]";

/** Max length of the question posted in an escalation comment, after redaction. */
const QUESTION_CAP = 600;

/**
 * A single alternation over every secret shape `redact` recognizes, tried
 * left-to-right at each position so the more specific shapes (Authorization
 * header, URL credentials, provider tokens, KEY=VALUE) win over the opaque-
 * blob catch-all — this keeps a `KEY=<token>` pair from being redacted twice
 * (once as KEY=VALUE, once as its own blob).
 */
const SECRET = new RegExp(
  [
    /Authorization:\s*(?:Bearer|Basic)\s+\S+/.source,
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/.source,
    /gh[pousr]_[A-Za-z0-9]{20,}/.source,
    /sk-[A-Za-z0-9]{20,}/.source,
    /xox[abprs]-[A-Za-z0-9-]{10,}/.source,
    /AKIA[0-9A-Z]{16}/.source,
    /[A-Za-z][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|BEARER|API[_-]?KEY)[A-Za-z0-9_]*\s*[:=]\s*\S+/.source,
    /[A-Za-z0-9+/=_-]{32,}/.source,
  ].join("|"),
  "gi",
);

/** A path-shaped run (segments of word chars joined by `/`, no `+`/`=`) is not a secret blob. */
function looksLikePath(s: string): boolean {
  return /^\/?[\w.-]+(?:\/[\w.-]+)+$/.test(s);
}

/**
 * Mask the VALUE of a matched secret shape, keeping enough of the surrounding
 * text that the shape stays legible (e.g. `AWS_SECRET_ACCESS_KEY=[redacted]`).
 */
function maskMatch(m: string): string {
  let mm: RegExpExecArray | null;
  if ((mm = /^Authorization:\s*(Bearer|Basic)\s+\S+$/i.exec(m))) return `Authorization: ${mm[1]} [redacted]`;
  if ((mm = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@$/.exec(m))) return `${mm[1]}:[redacted]@`;
  if ((mm = /^([A-Za-z][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|BEARER|API[_-]?KEY)[A-Za-z0-9_]*)(\s*[:=]\s*)\S+$/i.exec(m)))
    return `${mm[1]}${mm[2]}[redacted]`;
  if (looksLikePath(m)) return m;
  return "[redacted]";
}

/**
 * Mask credential-shaped values in `text`, keeping their surrounding shape
 * legible. Applied to the question and every option in `escalationComment`
 * before assembly — the last line of defence against a secret that scrolled
 * through the pane above a blocked dialog. Deliberately over-eager: a false
 * positive costs nothing (a reviewer can still ask), a missed credential is a
 * permanent leak into a project-readable Jira comment.
 */
export function redact(text: string): string {
  return text.replace(SECRET, maskMatch);
}

/**
 * Stable 8-hex-char fingerprint of a dialog's question + options. A
 * self-contained FNV-1a 32-bit hash — no dependency, trivially testable.
 * Deliberately independent of `current`: the highlighted option moves as a
 * responder navigates, but it is still the same dialog.
 */
export function fingerprint(prompt: Prompt): string {
  const s = prompt.question + "\n" + prompt.options.join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The comment butchr posts on a blocked agent's own ticket. Built ONLY from
 * `prompt.question` and `prompt.options` — never the surrounding pane text,
 * which may carry command output or secrets. Both are redacted and the
 * question is capped at `QUESTION_CAP` chars: `parsePrompt` bounds how much
 * pane text can reach `question`, but a bound is not a scrub, and a dialog
 * question longer than the cap is not a question.
 *
 * `capturePath`, when given, is a LOCAL DISK path only — the full pane text
 * itself is never redacted for and never posted to Jira (BUTCHR-16): the
 * fixture for a dialog Claude Code stops showing is otherwise gone within
 * hours, so the caller durably captures the raw pane text to
 * `config.captureDir` (see capture-store.ts) and this only references
 * WHERE, so the next unknown shape can be fixtured from the escalation
 * itself without ever putting raw scrollback in a project-readable comment.
 * A path is not secret-shaped (see `looksLikePath` above) so it needs no
 * redaction of its own.
 */
export function escalationComment(issue: string, prompt: Prompt, fp: string, capturePath: string | null = null): string {
  let question = redact(prompt.question);
  if (question.length > QUESTION_CAP) question = question.slice(0, QUESTION_CAP) + " …[truncated]";
  const options = prompt.options.map((o, i) => `${i + 1}. ${redact(o)}`).join("\n");
  return [
    `${MARKER} ${issue} is waiting on a decision:`,
    "",
    question,
    "",
    options,
    "",
    `fingerprint: ${fp}`,
    ...(capturePath ? ["", `Full pane text captured to ${capturePath} (local disk only — not posted here, may carry command output or secrets).`] : []),
    "",
    `Reply on THIS ticket with a comment containing exactly \`ANSWER <n> ${fp}\` (or \`ANSWER TEXT <your text> ${fp}\`).`,
  ].join("\n");
}

/**
 * Parse the first `ANSWER ...` directive line out of a comment body. Returns
 * null for prose, an unparseable ANSWER line, or (CRITICAL) a comment that IS
 * one of butchr's own — every comment butchr writes (escalation, follow-up,
 * no-free-text notice) STARTS with the marker, so the daemon would otherwise
 * read its own comment back as an answer to itself. Deliberately checks only
 * the START of the (trimmed) text, not merely that it appears somewhere: a
 * reviewer replying "quoting the dialog above: [butchr:blocked] ... ANSWER 2
 * abc12345" is a perfectly good answer and must not be silently dropped.
 */
export function parseDirective(commentText: string): Directive | null {
  if (commentText.trimStart().startsWith(MARKER)) return null;
  const line = commentText.split("\n").map((l) => l.trim()).find((l) => l.startsWith("ANSWER "));
  if (!line) return null;
  const rest = line.slice("ANSWER ".length).trim();

  const textMatch = /^TEXT\s+(.+)$/i.exec(rest);
  if (textMatch) {
    const body = textMatch[1]!.trim();
    const fpMatch = /^(.*\S)\s+([0-9a-f]{8})$/.exec(body);
    return fpMatch ? { kind: "text", text: fpMatch[1]!, fp: fpMatch[2]! } : { kind: "text", text: body, fp: null };
  }

  const optMatch = /^(\d+)(?:\s+([0-9a-f]{8}))?$/.exec(rest);
  if (optMatch) return { kind: "option", n: Number(optMatch[1]), fp: optMatch[2] ?? null };

  return null;
}

/**
 * The 1-based index of the option that opens a free-text/chat entry, chosen
 * BY CONTENT — never assumed by position. Returns null when nothing matches
 * or more than one option plausibly does; guessing wrong here sends a real
 * keystroke into the wrong control.
 */
export function freeTextOption(prompt: Prompt): number | null {
  // NOTE: bare "write" is deliberately excluded — Claude Code permission
  // dialogs routinely offer options like "Yes, allow Claude to read and
  // write files here", which would wrongly classify a permission grant as
  // the free-text entry and then type prose into it.
  const RE = /tell .* what to do|type .* instructions|write .* instructions|other|custom|different|feedback/i;
  const hits: number[] = [];
  prompt.options.forEach((o, i) => { if (RE.test(o)) hits.push(i + 1); });
  return hits.length === 1 ? hits[0]! : null;
}
