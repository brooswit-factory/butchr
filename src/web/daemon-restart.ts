/**
 * FACTORY-665 — `POST /api/daemon/restart`'s own logic: restarts butchr
 * ONLY when it is actually running under systemd as `butchr.service`, via
 * a FIXED argv (`["systemctl", "--user", "restart", "butchr.service"]`,
 * `execFile` — never a shell string, never any request-derived text in the
 * argv), and refuses with 409 otherwise. Detection reuses the same
 * `INVOCATION_ID` + `systemctl --user show -p MainPID` approach the
 * ticket's own design-constraint comment names, cross-checked against THIS
 * process's own pid (not merely "a butchr.service exists somewhere" — see
 * `isRunningUnderThisUnit`'s own doc comment for why the MainPID check
 * matters).
 *
 * local/ui: also under launchd (macOS), via the fixed argv `launchctl
 * kickstart -k gui/<uid>/<label>`, once `launchdJobForThisProcess` proves
 * launchd's job IS this process (label from `XPC_SERVICE_NAME`, pid from
 * `launchctl print`).
 */
import { execFile, spawn } from "node:child_process";

const UNIT = "butchr.service";
const TIMEOUT_MS = 2000;

export interface DaemonRestartDetectIo {
  /** `process.env.INVOCATION_ID` — present whenever systemd started this process (set for every unit, not just this one), so it is a necessary but not sufficient signal on its own. */
  invocationId: () => string | undefined;
  /** `systemctl --user show butchr.service -p MainPID` → the numeric pid systemd currently considers this unit's main process, or `undefined` on any failure (not installed, not running, no systemd, timeout). */
  mainPid: () => Promise<number | undefined>;
  /** This process's own pid (`process.pid`, injectable for tests). */
  ownPid: () => number;
  /** local/ui — `process.env.XPC_SERVICE_NAME`: launchd's job label for this process, when it has one. */
  launchdLabel?: () => string | undefined;
  /** local/ui — this process's uid (`process.getuid()`), for the `gui/<uid>/<label>` launchd target. */
  uid?: () => number | undefined;
  /** local/ui — `launchctl print <target>`'s stdout, or `undefined` on any failure. Fixed argv, read-only. */
  launchctlPrint?: (target: string) => Promise<string | undefined>;
}

export function defaultDaemonRestartDetectIo(): DaemonRestartDetectIo {
  return {
    invocationId: () => process.env.INVOCATION_ID,
    mainPid: () =>
      new Promise((resolve) => {
        execFile("systemctl", ["--user", "show", UNIT, "-p", "MainPID"], { timeout: TIMEOUT_MS }, (error, stdout) => {
          if (error) { resolve(undefined); return; }
          const m = /^MainPID=(\d+)/m.exec(stdout);
          resolve(m ? Number(m[1]) : undefined);
        });
      }),
    ownPid: () => process.pid,
    launchdLabel: () => process.env.XPC_SERVICE_NAME,
    uid: () => process.getuid?.(),
    launchctlPrint: (target) =>
      new Promise((resolve) => {
        execFile("launchctl", ["print", target], { timeout: TIMEOUT_MS }, (error, stdout) => resolve(error ? undefined : stdout));
      }),
  };
}

/**
 * local/ui — a launchd job label as `XPC_SERVICE_NAME` carries it. A process
 * started from Terminal has one too (`0`, `application.com.apple.Terminal…`),
 * so a well-formed label proves nothing alone; the pid check below does.
 */
export const LAUNCHD_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface LaunchdJob {
  label: string;
  /** `gui/<uid>/<label>`. */
  target: string;
  /** Where launchd sends this job's stderr (where a setup code is printed), when it says. */
  stderrPath: string | null;
}

/**
 * local/ui — this process as a launchd job, the launchd twin of
 * `isRunningUnderThisUnit`: the label must be well-formed AND `launchctl
 * print gui/<uid>/<label>` must report this exact pid as the job's own
 * (top-level `pid = …`; nested sections are indented further). Anything
 * else is `undefined`.
 */
export async function launchdJobForThisProcess(io: DaemonRestartDetectIo = defaultDaemonRestartDetectIo()): Promise<LaunchdJob | undefined> {
  const label = io.launchdLabel?.();
  const uid = io.uid?.();
  if (!label || !LAUNCHD_LABEL_RE.test(label) || uid === undefined || !io.launchctlPrint) return undefined;
  const target = `gui/${uid}/${label}`;
  const printed = await io.launchctlPrint(target);
  if (!printed) return undefined;
  const pid = /^\tpid = (\d+)\s*$/m.exec(printed)?.[1];
  if (pid === undefined || Number(pid) !== io.ownPid()) return undefined;
  return { label, target, stderrPath: /^\tstderr path = (.+?)\s*$/m.exec(printed)?.[1] ?? null };
}

/** local/ui — fixed argv: launchd stops this job and starts it again. Nothing request-derived, ever. */
export function launchdRestartArgv(job: LaunchdJob): readonly string[] {
  return ["launchctl", "kickstart", "-k", job.target];
}

/**
 * BOTH signals must agree: `INVOCATION_ID` is set (systemd started THIS
 * process) AND `systemctl` itself reports this exact process as the
 * unit's current MainPID (this process is still the one systemd thinks is
 * running the unit — guards against a stale/renamed unit file, or a
 * second butchr process started by hand while INVOCATION_ID leaked into
 * its environment from a parent shell).
 */
export async function isRunningUnderThisUnit(io: DaemonRestartDetectIo = defaultDaemonRestartDetectIo()): Promise<boolean> {
  if (io.invocationId() === undefined) return false;
  const mainPid = await io.mainPid();
  return mainPid !== undefined && mainPid === io.ownPid();
}

export interface DaemonRestartExecIo {
  /** Fixed argv, never built from request input. Injected so a test asserts the exact argv without ever invoking a real `systemctl`. */
  spawn: (argv: readonly string[]) => void;
  /**
   * local/ui — for `launchctl kickstart -k`, which kills THIS process:
   * runs the argv detached (its own process group, so launchd's cleanup of
   * this job doesn't take it down) and unref'd, half a second later so the
   * HTTP response is sent first. Falls back to `spawn` when absent.
   */
  spawnDetachedSoon?: (argv: readonly string[]) => void;
}

export function defaultDaemonRestartExecIo(): DaemonRestartExecIo {
  return {
    spawn: (argv) => {
      execFile(argv[0]!, argv.slice(1), { timeout: TIMEOUT_MS });
    },
    spawnDetachedSoon: (argv) => {
      setTimeout(() => {
        try {
          spawn(argv[0]!, argv.slice(1), { detached: true, stdio: "ignore" }).unref();
        } catch { /* best-effort: the Settings page reports the restart never came back, and a manual restart still works */ }
      }, 500);
    },
  };
}

export const RESTART_ARGV = ["systemctl", "--user", "restart", UNIT] as const;

export type DaemonRestartOutcome = { ok: true } | { ok: false; status: 409; error: "restart butchr manually" };

/**
 * Fires `systemctl --user restart butchr.service` (fixed argv, no
 * interpolation) when `isRunningUnderThisUnit` is true; otherwise returns
 * the 409 refusal the route hands back verbatim. The caller — the HTTP
 * route in `./view.ts` — is responsible for every guard/confirm/rate-limit/
 * audit check BEFORE calling this; this function does none of that itself,
 * same separation `jiraTest`/`testJiraConnection` already follow (the
 * route owns policy, the dep owns the one privileged action).
 */
export async function restartDaemon(detectIo: DaemonRestartDetectIo = defaultDaemonRestartDetectIo(), execIo: DaemonRestartExecIo = defaultDaemonRestartExecIo()): Promise<DaemonRestartOutcome> {
  const underSystemd = await isRunningUnderThisUnit(detectIo);
  if (underSystemd) {
    execIo.spawn(RESTART_ARGV);
    return { ok: true };
  }
  // local/ui: the same restart under launchd (macOS), proven the same way.
  const job = await launchdJobForThisProcess(detectIo);
  if (job) {
    (execIo.spawnDetachedSoon ?? execIo.spawn)(launchdRestartArgv(job));
    return { ok: true };
  }
  return { ok: false, status: 409, error: "restart butchr manually" };
}
