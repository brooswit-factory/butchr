/**
 * FACTORY-560: the pure classification behind `cli.ts verify` (and so
 * `verify.ps1`, which is a thin bootstrap into it — see that script's own
 * header comment). Mirrors `scripts/wsl-host/health.ts#classifyWslHealth`
 * deliberately — same shape, same governing rule ("unknown is never treated
 * as healthy") — adapted for a native Windows host, which has no WSL
 * boundary and so no "is the VM up at all" question to answer first: the
 * layer that question fills there is "is herdr running at all," per the
 * spike's own finding that the daemon refuses to start unless herdr answers
 * (`src/daemon/missing-rules-preflight.ts`/`legacy-preflight.ts`'s "Refusing
 * to start ... Start herdr and retry").
 *
 * THE THREE STATES:
 *   "herdr-down"  — no herdr process was found (or its presence could not be
 *                   determined at all). Nothing past this point can be
 *                   trusted: the daemon cannot have started successfully
 *                   without herdr answering, so this is checked FIRST and
 *                   everything else is ignored once it's true — the same
 *                   "wsl-down short-circuits daemon-down" shape
 *                   `classifyWslHealth` uses.
 *   "daemon-down" — herdr is running, but the butchr daemon's own `/health`
 *                   doesn't answer, or answers with `ok: false`.
 *   "healthy"     — herdr is running and `/health` reports `ok: true`.
 */

export type WindowsHostHealthState = "herdr-down" | "daemon-down" | "healthy";

/** Exit codes, fixed once and documented here so no other file re-derives them — same numbering as `scripts/wsl-host/health.ts#WSL_HEALTH_EXIT_CODES` (0 = healthy, ordinary shell/CI convention). */
export const WINDOWS_HOST_HEALTH_EXIT_CODES: Record<WindowsHostHealthState, number> = {
  "herdr-down": 2,
  "daemon-down": 1,
  healthy: 0,
};

export interface WindowsHostHealthInput {
  /**
   * Whether a herdr process was found running on this host (e.g. via
   * `tasklist`). `null` means this could not be determined at all — treated
   * the same as `false`, never as "probably fine": the governing rule
   * `scripts/deploy/rollback-decision.ts` and `classifyWslHealth` both
   * already state for an unreachable/unknown signal.
   */
  herdrRunning: boolean | null;
  /**
   * The result of fetching `http://127.0.0.1:<port>/health`. `null` =
   * connection failed/timed out/non-2xx/unparsable JSON — an unreachable
   * daemon is not healthy, same as `WslHealthInput.health`'s own doc
   * comment.
   */
  health: { ok: boolean } | null;
  /**
   * The last few lines of the daemon's own rotating log file
   * (`%LOCALAPPDATA%\butchr\logs\butchr.log` by default — see
   * `scripts/windows-host/launcher.ts`) — only ever surfaced for a
   * "daemon-down" verdict, the Windows-host equivalent of `WslHealthInput`'s
   * `journalTail`: there is no journalctl on Windows, only this file.
   */
  logTail?: string[];
}

export interface WindowsHostHealthResult {
  state: WindowsHostHealthState;
  exitCode: number;
  /** One line, meant to make herdr-down vs daemon-down vs healthy unmistakable at a glance. */
  headline: string;
  /** Extra lines (log tail) — printed below the headline, never folded into it. */
  detail: string[];
}

export function classifyWindowsHostHealth(input: WindowsHostHealthInput): WindowsHostHealthResult {
  if (input.herdrRunning !== true) {
    return {
      state: "herdr-down",
      exitCode: WINDOWS_HOST_HEALTH_EXIT_CODES["herdr-down"],
      headline: input.herdrRunning === false ? "herdr: DOWN (no herdr process found)" : "herdr: DOWN (could not determine whether herdr is running)",
      detail: [],
    };
  }

  if (input.health === null) {
    return { state: "daemon-down", exitCode: WINDOWS_HOST_HEALTH_EXIT_CODES["daemon-down"], headline: "herdr: UP, daemon: DOWN (/health did not answer)", detail: input.logTail ?? [] };
  }
  if (!input.health.ok) {
    return { state: "daemon-down", exitCode: WINDOWS_HOST_HEALTH_EXIT_CODES["daemon-down"], headline: "herdr: UP, daemon: DOWN (/health reported ok: false)", detail: input.logTail ?? [] };
  }

  return { state: "healthy", exitCode: WINDOWS_HOST_HEALTH_EXIT_CODES.healthy, headline: "herdr: UP, daemon: UP (/health reports ok)", detail: [] };
}
