/**
 * FACTORY-662 — requirement 4: every accepted AND rejected config write
 * appends exactly one JSON line to an audit log, and the same line to the
 * daemon's journal (`[butchr:audit]`). Never logs a secret: no CSRF token,
 * no rule `brief` — see `AuditWriteEvent`'s own field list for exactly what
 * is (and is not) recorded.
 *
 * Each write used to also raise a Rocket.Chat alert; that support is gone,
 * so the audit file and the journal line are the record.
 *
 * B4 (agentsafety second pass, 2026-10-05): the audit file is created at
 * mode 0600 (its directory at 0700), never the Bun/Node default — this file
 * accumulates every write's route/ids/diff, which is operational detail,
 * not secret, but still not world- or group-readable by default.
 */
import { appendFileSync, chmodSync, closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The audit log's basename, same `dirname(rulesPath(env))` directory as
 * `rules.json` itself in both callers (`src/daemon/index.ts`'s normal-mode
 * startup and `src/daemon/setup-mode.ts`'s setup mode) — exported as one
 * constant rather than the literal string living separately in three
 * places, since `src/rules/seed-first-run.ts`'s `setupWriteAllowlist`
 * (FACTORY-716) also needs this exact name: `POST /api/setup/jira` audits
 * every attempt, success or failure, so this file exists in the config dir
 * after UI setup same as the identity file and secrets dir do, and must not
 * read as "an established install configured some other way" either. If
 * this basename ever changes, update that allowlist too.
 */
export const WEB_WRITE_AUDIT_LOG_BASENAME = "web-write-audit.jsonl";

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
  /**
   * FACTORY-694 item 2: `"write"` (default, every pre-existing caller) is a
   * real config write. `"test"` is a read-only connection test
   * (`POST /api/settings/jira/test`) that changes nothing; it is recorded
   * the same way, labelled so a reader can tell the two apart.
   */
  kind?: "write" | "test";
}

export interface AuditLogDeps {
  /** Appends one line (already including the trailing `\n`) to the audit log file. Defaults to a real `fs.appendFileSync` against `path`. */
  append: (line: string) => void;
  log: (line: string) => void;
  /** Injectable clock, for tests only — defaults to `Date.now`. */
  now?: () => number;
}

/** Real production `append`: ensures the parent directory exists at mode 0700 and the file itself exists at mode 0600 (chmod'd on every call — cheap, and guarantees the mode even if the file pre-existed at something looser), refuses a symlinked path the same way `write-rules.ts` refuses one for the rules file itself, then appends via a raw `O_APPEND|O_CREAT|O_WRONLY` open rather than `fs.appendFileSync`'s own default mode. */
export function fileAuditAppend(path: string): (line: string) => void {
  const dir = dirname(path);
  return (line: string) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error(`audit log path ${path} is a symlink — refusing to write through it`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }
    const fd = openSync(path, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY, 0o600);
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
    chmodSync(path, 0o600);
  };
}

/** Kept for tests/callers that want the old, uncreated-dir-unaware `appendFileSync` behavior against an already-prepared path — production uses `fileAuditAppend` above. */
export function plainAppend(path: string): (line: string) => void {
  return (line) => appendFileSync(path, line);
}

function flattenDiffSummary(summary: string): string {
  // Defensive: a diff summary is built from field NAMES and short scalar
  // values this module's own callers construct, never user-supplied free
  // text (a rule's `query`/`brief`) — this just keeps the audit line to one
  // JSON line even if a caller ever passes something with an embedded
  // newline.
  return summary.replace(/\n/g, "\\n");
}

/** Builds the audit logger: one instance per daemon process, reused across every write. */
export function createAuditLogger(deps: AuditLogDeps): (event: Omit<AuditWriteEvent, "time">) => void {
  const now = deps.now ?? Date.now;
  return (partial) => {
    const event: AuditWriteEvent = { ...partial, time: new Date(now()).toISOString() };
    const line = JSON.stringify({ ...event, diffSummary: flattenDiffSummary(event.diffSummary) });
    try {
      deps.append(line + "\n");
    } catch (e) {
      // Fails open on the LOG itself: a logging failure must never block or
      // unwind the write it is recording.
      deps.log(`WARNING: [butchr:audit] could not append audit line: ${(e as Error)?.message ?? e}`);
    }
    deps.log(`[butchr:audit] ${line}`);
  };
}
