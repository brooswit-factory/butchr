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
 */
import { execFile } from "node:child_process";

const UNIT = "butchr.service";
const TIMEOUT_MS = 2000;

export interface DaemonRestartDetectIo {
  /** `process.env.INVOCATION_ID` — present whenever systemd started this process (set for every unit, not just this one), so it is a necessary but not sufficient signal on its own. */
  invocationId: () => string | undefined;
  /** `systemctl --user show butchr.service -p MainPID` → the numeric pid systemd currently considers this unit's main process, or `undefined` on any failure (not installed, not running, no systemd, timeout). */
  mainPid: () => Promise<number | undefined>;
  /** This process's own pid (`process.pid`, injectable for tests). */
  ownPid: () => number;
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
  };
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
}

export function defaultDaemonRestartExecIo(): DaemonRestartExecIo {
  return {
    spawn: (argv) => {
      execFile(argv[0]!, argv.slice(1), { timeout: TIMEOUT_MS });
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
  if (!underSystemd) return { ok: false, status: 409, error: "restart butchr manually" };
  execIo.spawn(RESTART_ARGV);
  return { ok: true };
}
