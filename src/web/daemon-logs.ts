/**
 * FACTORY-668 (C1, read) — `GET /api/daemon/logs`'s own data: a bounded,
 * redacted tail of this daemon's own journal, read through the SAME
 * `SystemdInfo` derivation `ENVIRONMENT.md`/`/health` already use
 * (`../agents/ground-truth.js`'s `currentSystemdInfo`) — never a
 * guessed/hard-coded unit name or journalctl invocation (this ticket's own
 * instruction: trust only this process's own measured identity).
 *
 * Bounded TWO ways, both enforced here (not left to the caller): a line
 * count (`-n <maxLines>`, so `journalctl` itself never emits more than
 * asked) and a byte cap applied to the joined text AFTER redaction (so a
 * cap can never split a secret shape mid-match and leave half of it
 * unredacted). Every line is run through `redact()`
 * (`../agents/escalate.js`) — the project's one existing secret-redaction
 * helper, reused verbatim, never a second implementation.
 *
 * `kind: "none"` (no systemd unit, no Windows scheduled task detected) is
 * an honest, operator-actionable refusal, never an empty page: the UI gets
 * a `source: "unavailable"` result with a message naming exactly why
 * (BUTCHR-this-ticket's own acceptance criterion 1).
 */
import { execFile } from "node:child_process";
import { redact } from "../agents/escalate.js";
import type { SystemdInfo } from "../agents/ground-truth.js";

export interface DaemonLogsOptions {
  /** Passed to `journalctl -n <maxLines>` / `Get-Content -Tail <maxLines>` — the daemon's own choice of how far back to look, never attacker/client supplied. */
  maxLines: number;
  /** Applied to the REDACTED joined text; the daemon never returns more than this many bytes regardless of how much the log source produced. */
  maxBytes: number;
}

export const DEFAULT_DAEMON_LOGS_MAX_LINES = 200;
export const DEFAULT_DAEMON_LOGS_MAX_BYTES = 64 * 1024;

export interface DaemonLogsExecIo {
  /** Runs `argv[0]` with `argv.slice(1)`, resolving to its stdout text (or rejecting on a non-zero exit / spawn failure). Fixed argv, never built from request input. */
  run: (argv: readonly string[]) => Promise<string>;
}

const TIMEOUT_MS = 5000;
/** `execFile`'s own stdout buffer cap — generous relative to `maxBytes` (applied again, post-redaction, by `readDaemonLogs` itself) so a pathological journal entry can't exhaust memory before the real cap ever runs. */
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;

export function defaultDaemonLogsExecIo(): DaemonLogsExecIo {
  return {
    run: (argv) =>
      new Promise((resolve, reject) => {
        execFile(argv[0]!, argv.slice(1), { timeout: TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER }, (error, stdout) => {
          if (error) { reject(error); return; }
          resolve(stdout);
        });
      }),
  };
}

export type DaemonLogsResult =
  | { ok: true; source: string; unit: string; lines: string[]; truncated: boolean }
  | { ok: false; error: string };

/**
 * Builds the fixed argv for a given `SystemdInfo` — never any
 * request-derived text, `maxLines` included (the daemon's own choice, see
 * `DaemonLogsOptions`'s own doc comment). `kind: "none"` has no argv at all
 * (the caller never runs anything).
 *
 * `windows-task`: `info.journalctl` is `parseWindowsTaskEnv`'s own
 * `Get-Content -Path "<logFile>" -Tail 200 -Wait` (`../agents/ground-
 * truth.js`) — built for a human tailing the log live, so it both hard-codes
 * 200 and never terminates (`-Wait`). This extracts just the path out of
 * that string (the one piece `SystemdInfo`'s public shape actually carries)
 * and rebuilds a ONE-SHOT, bounded invocation with `maxLines` instead,
 * rather than running the live-follow command as-is.
 */
function logsArgvFor(info: SystemdInfo, maxLines: number): readonly string[] | null {
  switch (info.kind) {
    case "user": return ["journalctl", "--user", "-u", info.unit, "-n", String(maxLines), "--no-pager", "-o", "cat"];
    case "system": return ["journalctl", "-u", info.unit, "-n", String(maxLines), "--no-pager", "-o", "cat"];
    case "windows-task": {
      const m = /-Path\s+"([^"]+)"/.exec(info.journalctl);
      if (!m) return null;
      return ["powershell", "-NoProfile", "-NonInteractive", "-Command", `Get-Content -Path "${m[1]}" -Tail ${maxLines}`];
    }
    case "none": return null;
  }
}

/**
 * The redacted, bounded tail itself. `info` is this process's OWN
 * `currentSystemdInfo()` result (the caller's responsibility to supply —
 * never re-derived here, so a test can inject any `SystemdInfo` without
 * touching `/proc`). On a `kind: "none"` daemon, or when the log source
 * itself fails (journalctl not installed, the unit's journal rotated away,
 * a timeout), this returns `ok: false` with an operator-actionable
 * `error` — never an empty `lines: []` masquerading as "no log output".
 */
export async function readDaemonLogs(info: SystemdInfo, opts: DaemonLogsOptions, io: DaemonLogsExecIo = defaultDaemonLogsExecIo()): Promise<DaemonLogsResult> {
  if (info.kind === "none") {
    return { ok: false, error: "no systemd unit or scheduled task detected for this daemon — logs are unavailable; check the process running this daemon directly" };
  }
  const argv = logsArgvFor(info, opts.maxLines);
  if (!argv) return { ok: false, error: "no systemd unit or scheduled task detected for this daemon — logs are unavailable; check the process running this daemon directly" };
  let stdout: string;
  try {
    stdout = await io.run(argv);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `could not read logs via "${info.journalctl}": ${detail}` };
  }
  const rawLines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
  const redactedLines = rawLines.map((l) => redact(l));
  let bytes = 0;
  const lines: string[] = [];
  let truncated = false;
  for (const line of redactedLines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes > opts.maxBytes) { truncated = true; break; }
    bytes += lineBytes;
    lines.push(line);
  }
  return { ok: true, source: info.journalctl, unit: info.unit, lines, truncated };
}
