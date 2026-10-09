/**
 * FACTORY-662 — requirement 4/7: every accepted AND rejected config write
 * appends exactly one JSON line to an audit log, and (item 7) raises an
 * ops alert so a human is told about it, not just the first in some
 * window — deliberately NOT `../agents/ops-alert.ts`'s `OpsAlertRouter`
 * (that router's whole purpose is an hourly dedup cap). Never logs a
 * secret: no CSRF token, no rule `brief` — see `AuditWriteEvent`'s own
 * field list for exactly what is (and is not) recorded.
 *
 * B4 (agentsafety second pass, 2026-10-05): two fixes on top of the
 * original design —
 *   (1) Alert text is now composed through the SAME hardened pipeline
 *   every other Rocket.Chat post in this codebase uses (`quoteField`/
 *   `quotedBlock`, `../agents/rocketchat-text.ts`) — the route/action/ids/
 *   diff/reason fields can all carry caller-influenced text (a rule id, a
 *   diff summary built from request fields), and the previous version
 *   interpolated them raw, so a crafted id/field could forge an `@all`
 *   mention or a clickable link in the posted alert.
 *   (2) Every ACCEPTED write still alerts individually and immediately
 *   (that is the whole point — a human must see every real change), but
 *   REJECTED writes are aggregated: the first rejection in a window starts
 *   a short timer and every rejection arriving before it fires is counted,
 *   not separately posted; the timer then posts ONE alert naming the
 *   count and the LAST rejection's own detail. A burst of refused writes
 *   (a forged-origin probe, a misconfigured client retrying) no longer
 *   floods the room with one post per attempt.
 *   (3) The audit file is created at mode 0600 (its directory at 0700),
 *   never the Bun/Node default — this file accumulates every write's
 *   route/ids/diff, which is operational detail, not secret, but still
 *   not world- or group-readable by default.
 */
import { appendFileSync, chmodSync, closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { quoteField, quotedBlock } from "../agents/rocketchat-text.js";

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
   * real config write — accepted alerts individually, rejected aggregates.
   * `"test"` is a read-only connection test (`POST /api/settings/jira/test`)
   * that changes nothing: an accepted test alerts NOBODY (there is nothing
   * for an admin to review), and a rejected/failed test alerts immediately,
   * under its own label, and never joins the `"write"` rejection aggregator
   * — a burst of failed connection tests must never swallow or relabel a
   * real rejected write's own "last event" detail, and vice versa. See
   * `composeAlertText`/`createAuditLogger` below for exactly where this
   * changes behavior.
   */
  kind?: "write" | "test";
}

export interface AuditLogDeps {
  /** Appends one line (already including the trailing `\n`) to the audit log file. Defaults to a real `fs.appendFileSync` against `path`. */
  append: (line: string) => void;
  /** Posts one alert line to the ops room, fire-and-forget. `undefined` means "not configured" — logged once, never thrown. */
  postAlert?: (text: string) => Promise<void>;
  /** This daemon's own hostname, named in the alert so a room that collects more than one daemon's posts can tell them apart. */
  host: string;
  log: (line: string) => void;
  /** Injectable clock, for tests only — defaults to `Date.now`. */
  now?: () => number;
  /** How long a burst of REJECTED writes is aggregated into one alert before posting — see this module's own header, fix (2). Defaults to 10s. Accepted writes are never affected by this. */
  rejectAggregateWindowMs?: number;
}

const DEFAULT_REJECT_AGGREGATE_WINDOW_MS = 10_000;

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

const CAP = { route: 200, action: 200, ids: 400, diff: 400, reason: 400, host: 253 };

/** B4 fix (1): every field composed into the alert goes through `quoteField` (control/bidi stripping, mention-neutralizing, link-defanging, length-capping) — see this module's own header. */
function composeAlertText(event: AuditWriteEvent, host: string, count: number): string {
  const isTest = event.kind === "test";
  const noun = isTest ? "connection test" : "write";
  const verb = event.outcome === "accepted" ? "ACCEPTED" : isTest ? "FAILED" : count > 1 ? `REJECTED x${count}` : "REJECTED";
  const route = quoteField(event.route, { cap: CAP.route });
  const action = quoteField(event.action, { cap: CAP.action });
  const ids = quoteField(event.ids.join(", "), { cap: CAP.ids });
  const diff = quoteField(event.diffSummary, { cap: CAP.diff });
  const hostQ = quoteField(host, { cap: CAP.host });
  const header = `**${noun} ${verb}** on **${hostQ}** — ${route} ${action} [${ids}]`;
  const lines = [`route: ${route}`, `action: ${action}`, `ids: ${ids}`, `diff: ${diff}`];
  if (event.reason) lines.push(`reason: ${quoteField(event.reason, { cap: CAP.reason })}`);
  if (count > 1) lines.push(`count: ${count} rejected write(s) aggregated in this window (showing the last)`);
  return [header, "", quotedBlock(lines)].join("\n");
}

/**
 * Builds the stateful audit logger: one instance per daemon process,
 * reused across every write (matching `createOpsAlertRouter`'s own
 * "shared instance, not rebuilt per call" discipline) — the aggregation
 * state (fix (2)) only works at all if the SAME instance sees every
 * rejected write, not a fresh one per call.
 */
export function createAuditLogger(deps: AuditLogDeps): (event: Omit<AuditWriteEvent, "time">) => void {
  const now = deps.now ?? Date.now;
  const windowMs = deps.rejectAggregateWindowMs ?? DEFAULT_REJECT_AGGREGATE_WINDOW_MS;
  let pending: { count: number; last: AuditWriteEvent; timer: ReturnType<typeof setTimeout> } | null = null;

  function dispatchAlert(event: AuditWriteEvent, count: number): void {
    if (!deps.postAlert) return;
    const text = composeAlertText(event, deps.host, count);
    void deps.postAlert(text).catch((e: unknown) => {
      deps.log(`WARNING: [butchr:audit] ops alert post failed: ${(e as Error)?.message ?? e}`);
    });
  }

  return (partial) => {
    const event: AuditWriteEvent = { ...partial, time: new Date(now()).toISOString() };
    const line = JSON.stringify({ ...event, diffSummary: flattenDiffSummary(event.diffSummary) });
    try {
      deps.append(line + "\n");
    } catch (e) {
      // Fails open on the LOG itself (same discipline as ops-alert.ts): a
      // logging failure must never block or unwind the write it is recording.
      deps.log(`WARNING: [butchr:audit] could not append audit line: ${(e as Error)?.message ?? e}`);
    }
    deps.log(`[butchr:audit] ${line}`);

    if (event.outcome === "accepted") {
      // FACTORY-694 item 2: a successful connection test changes nothing —
      // never alert on it (only a failure is actionable for an admin).
      if (event.kind !== "test") dispatchAlert(event, 1);
      return;
    }

    if (event.kind === "test") {
      // A failed/rejected connection test alerts immediately, under its own
      // label — it must never join the "write" rejection aggregator below,
      // whose aggregated "last event" exists to summarize a burst of real
      // rejected writes, not get its detail overwritten by an unrelated test.
      dispatchAlert(event, 1);
      return;
    }

    // Rejected: aggregate (fix (2)) rather than posting one alert per attempt.
    if (pending) {
      pending.count += 1;
      pending.last = event;
      return;
    }
    const entry = {
      count: 1,
      last: event,
      timer: setTimeout(() => {
        const { count, last } = entry;
        pending = null;
        dispatchAlert(last, count);
      }, windowMs),
    };
    entry.timer.unref?.();
    pending = entry;
  };
}
