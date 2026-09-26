/**
 * FACTORY-64: the pure classification behind `cli.ts verify` and
 * `Verify-WslHost.ps1` — given raw signals about the WSL distro and the
 * daemon inside it, decide which of the ticket's three named states this
 * host is in, with a distinct exit code per state so a caller (a human, a
 * scheduled task, another script) can branch on the exit code alone,
 * never on parsing the printed text. Mirrors this repo's
 * `scripts/deploy/rollback-decision.ts` split: the decision is a plain
 * function over plain data, no shell-out, so it can be proven correct for
 * every state without a real WSL distro to test against (this workspace
 * has none).
 *
 * THE THREE STATES, NAMED EXACTLY AS THE TICKET ASKS FOR:
 *   "wsl-down"    — the distro itself isn't up (not installed, or
 *                   installed but not running). Nothing inside it can be
 *                   observed at all; this is deliberately the FIRST thing
 *                   checked, and every other signal is ignored once this
 *                   is true, so a "daemon-down" verdict is never printed
 *                   for a host where WSL itself never came up.
 *   "daemon-down" — WSL is up, but the butchr daemon inside it isn't
 *                   healthy: systemd itself isn't active, the unit isn't
 *                   active, the port doesn't answer, or `/health` answers
 *                   but reports `ok: false`.
 *   "healthy"     — WSL is up, the unit is active, and `/health` reports
 *                   `ok: true`.
 */

export type WslHealthState = "wsl-down" | "daemon-down" | "healthy";

/** Exit codes, fixed once and documented here so no other file re-derives them. 0 is deliberately the healthy case (ordinary shell/CI convention: zero means "nothing to act on"). */
export const WSL_HEALTH_EXIT_CODES: Record<WslHealthState, number> = {
  "wsl-down": 2,
  "daemon-down": 1,
  healthy: 0,
};

export interface WslHealthInput {
  /** `wsl.exe -l -q` (or equivalent) lists the distro at all. */
  distroInstalled: boolean;
  /** `wsl.exe -l -v` (or equivalent) reports the distro's own state as Running. Meaningless (never read) when `distroInstalled` is false. */
  distroRunning: boolean;
  /**
   * `systemctl --user is-system-running` (or equivalent) succeeded, i.e.
   * systemd itself is up inside the distro — distinct from any one unit's
   * own state. `null` means this could not be determined at all (e.g. the
   * exec into WSL itself failed after `distroRunning` reported true,
   * which is itself worth surfacing rather than silently treated as ok).
   * Ignored when `distroRunning` is false.
   */
  systemdActive: boolean | null;
  /** `systemctl --user is-active butchr.service` reported `active`. `null` = could not be determined. Ignored once an earlier signal already decided the state. */
  daemonUnitActive: boolean | null;
  /**
   * The result of fetching `http://127.0.0.1:<port>/health` from INSIDE
   * the distro (never from the Windows side — the zippy report's own NAT
   * networking note means a Windows-side fetch of a WSL-internal port is
   * not a given). `null` = connection failed/timed out/non-2xx/unparsable
   * JSON, treated the same as an explicit `ok: false` — an unreachable
   * daemon is not healthy, never "unknown, so assume fine" (same
   * governing rule `scripts/deploy/rollback-decision.ts` states for the
   * Codey watchdog).
   */
  health: { ok: boolean } | null;
  /**
   * The last few lines of `journalctl --user -u butchr.service` — only
   * ever surfaced for a "daemon-down" verdict, per this ticket's own
   * known-limitation note: a daemon that crashes on missing Atlassian
   * credentials (`src/config/config.ts`'s unconditional `required(...)`
   * calls, tracked separately under FACTORY-65) looks identical to any
   * other crash from the unit's own `is-active` alone — the journal tail
   * is what lets a reader tell them apart without this script guessing.
   */
  journalTail?: string[];
}

export interface WslHealthResult {
  state: WslHealthState;
  exitCode: number;
  /** One line, meant to make (a) vs (b) unmistakable at a glance — e.g. `WSL: DOWN (distro not running)` vs `WSL: UP, daemon: DOWN (unit inactive)`. */
  headline: string;
  /** Extra lines (reasoning, journal tail) — printed below the headline, never folded into it. */
  detail: string[];
}

export function classifyWslHealth(input: WslHealthInput): WslHealthResult {
  if (!input.distroInstalled) {
    return { state: "wsl-down", exitCode: WSL_HEALTH_EXIT_CODES["wsl-down"], headline: "WSL: DOWN (distro not installed)", detail: [] };
  }
  if (!input.distroRunning) {
    return { state: "wsl-down", exitCode: WSL_HEALTH_EXIT_CODES["wsl-down"], headline: "WSL: DOWN (distro not running)", detail: [] };
  }

  if (input.systemdActive === false) {
    return { state: "daemon-down", exitCode: WSL_HEALTH_EXIT_CODES["daemon-down"], headline: "WSL: UP, daemon: DOWN (systemd is not active inside the distro)", detail: [] };
  }
  if (input.systemdActive === null) {
    return {
      state: "daemon-down",
      exitCode: WSL_HEALTH_EXIT_CODES["daemon-down"],
      headline: "WSL: UP, daemon: DOWN (could not determine whether systemd is active — most likely systemd is not enabled inside the distro; less commonly, the exec into it failed)",
      detail: [],
    };
  }

  if (input.daemonUnitActive !== true) {
    const detail = input.journalTail ?? [];
    const reason = input.daemonUnitActive === false ? "butchr.service is not active" : "could not determine whether butchr.service is active";
    return { state: "daemon-down", exitCode: WSL_HEALTH_EXIT_CODES["daemon-down"], headline: `WSL: UP, daemon: DOWN (${reason})`, detail };
  }

  if (input.health === null) {
    return { state: "daemon-down", exitCode: WSL_HEALTH_EXIT_CODES["daemon-down"], headline: "WSL: UP, daemon: DOWN (unit is active but /health did not answer)", detail: input.journalTail ?? [] };
  }
  if (!input.health.ok) {
    return { state: "daemon-down", exitCode: WSL_HEALTH_EXIT_CODES["daemon-down"], headline: "WSL: UP, daemon: DOWN (/health reported ok: false)", detail: input.journalTail ?? [] };
  }

  return { state: "healthy", exitCode: WSL_HEALTH_EXIT_CODES.healthy, headline: "WSL: UP, daemon: UP (/health reports ok)", detail: [] };
}
