/**
 * FACTORY-662 — requirement 4/7: every accepted AND rejected config write
 * appends exactly one JSON line to an audit log, and (item 7) raises a
 * NON-DEDUPED alert so a human is told about every single write, not just
 * the first in some window — deliberately NOT `../agents/ops-alert.ts`'s
 * `OpsAlertRouter` (that router's whole purpose is an hourly dedup cap,
 * which is the one property this requirement explicitly forbids). Never
 * logs a secret: no CSRF token, no rule `brief` — see `AuditWriteEvent`'s
 * own field list for exactly what is (and is not) recorded.
 */
import { appendFileSync } from "node:fs";

export interface AuditWriteEvent {
  time: string; // ISO 8601
  route: string;
  action: string;
  /** Resource ids this write named (e.g. the rule id) — never a brief, never a token. */
  ids: string[];
  /** A short, human-readable summary of what changed (e.g. `"enabled: false -> true"`) — never the full before/after documents. */
  diffSummary: string;
  origin: string | null;
  uid: number | undefined;
  outcome: "accepted" | "rejected";
  /** Present (and required) when `outcome === "rejected"`; the refusal reason. */
  reason?: string;
}

export interface AuditLogDeps {
  /** Appends one line (already including the trailing `\n`) to the audit log file. Defaults to a real `fs.appendFileSync` against `path`. */
  append: (line: string) => void;
  /** Posts one alert line to the ops room, fire-and-forget. `undefined` means "not configured" — logged once, never thrown. */
  postAlert?: (text: string) => Promise<void>;
  /** This daemon's own hostname, named in the alert so a room that collects more than one daemon's posts can tell them apart. */
  host: string;
  log: (line: string) => void;
}

/** Real production `append`: one line, `fsync`-free (an audit log losing its last line on an unclean shutdown is an accepted, documented gap — the write itself still happened, or didn't, correctly; this is the RECORD of it, not the write's own durability, which `writeRulesFile` already guarantees independently). */
export function fileAuditAppend(path: string): (line: string) => void {
  return (line) => appendFileSync(path, line);
}

function diffSummaryIsSafe(summary: string): string {
  // Defensive: a diff summary is built from field NAMES and short scalar
  // values this module's own callers construct, never user-supplied free
  // text (a rule's `query`/`brief`) — this just keeps the audit line to one
  // JSON line even if a caller ever passes something with an embedded
  // newline.
  return summary.replace(/\n/g, "\\n");
}

export function recordAuditEvent(event: AuditWriteEvent, deps: AuditLogDeps): void {
  const line = JSON.stringify({ ...event, diffSummary: diffSummaryIsSafe(event.diffSummary) });
  try {
    deps.append(line + "\n");
  } catch (e) {
    // Fails open on the LOG itself (same discipline as ops-alert.ts): a
    // logging failure must never block or unwind the write it is recording.
    deps.log(`WARNING: [butchr:audit] could not append audit line: ${(e as Error)?.message ?? e}`);
  }

  const verb = event.outcome === "accepted" ? "ACCEPTED" : "REJECTED";
  const reasonSuffix = event.reason ? ` (${event.reason})` : "";
  const text = `**write ${verb}** on **${deps.host}** — ${event.route} ${event.action} [${event.ids.join(", ")}]: ${event.diffSummary}${reasonSuffix}`;
  deps.log(`[butchr:audit] ${line}`);
  if (!deps.postAlert) return;
  // Fire-and-forget, deliberately NOT deduplicated (requirement 7) — every
  // write gets its own post. Never thrown back into the write path.
  void deps.postAlert(text).catch((e: unknown) => {
    deps.log(`WARNING: [butchr:audit] ops alert post failed: ${(e as Error)?.message ?? e}`);
  });
}
