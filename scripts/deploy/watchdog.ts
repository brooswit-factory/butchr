/**
 * BUTCHR-465: the Codey deploy watchdog — a pre-staged, self-contained
 * automatic rollback for `docs/codey-deploy-runbook.md`'s restart step.
 *
 * WHY THIS EXISTS AS A SEPARATE PROCESS, NOT SOMETHING THE MANAGER
 * BABYSITS: the whole point (the runbook's own hard requirement) is that
 * the rollback must not depend on the manager agent surviving the restart
 * it just triggered — the restart takes down every Codey project manager,
 * including the one running it (BUTCHR-396's Execution model). So `arm`
 * only ever WRITES STATE; the actual timed check is a separate, ordinary
 * `systemd-run --user --on-active=<window>` transient unit — real init
 * infrastructure that answers to the user's systemd instance, not to this
 * process or to butchr.service, and fires on schedule whether or not
 * anything that armed it is still around. `arm`'s own output prints the
 * exact `systemd-run` command to copy — this file deliberately does not
 * invoke it, so that staging the watchdog (a pure state write, safe to
 * rerun) stays a separate, individually-inspectable step from actually
 * scheduling a job against the user's real systemd instance.
 *
 * FOUR SUBCOMMANDS:
 *   arm    — record prevSha/expectedSha/installDir/unit/port/windowSec/mode.
 *   check  — the timer's own action: fetch /health, decide (see
 *            `rollback-decision.ts`), and either mark healthy or actually
 *            roll back. `--dry-run` runs the exact same decision but only
 *            LOGS what it would do — this is how the runbook says to test
 *            the whole arm→timer→check path before the real restart.
 *   disarm — manually mark resolved (e.g. the manager independently
 *            confirmed health sooner than the window) and, given
 *            `--timer-unit`, cancel the pending transient timer so it
 *            never fires at all.
 *   status — read-only: print the current state and a PREVIEW of what
 *            `check` would decide right now, without acting. Always safe.
 *
 * WHAT "ROLL BACK" ACTUALLY MEANS (PR #436 review round 1 fix): a bare
 * `git reset --hard <prevSha>` is not a rollback — `dist/` is gitignored
 * (`.gitignore`), so in BUILT mode that leaves the just-built (bad)
 * `dist/butchr.js` in place and a restart just reloads the same broken
 * build. And `node_modules` is never restored by git either way. So a real
 * rollback repeats the SAME restore steps the runbook's own manual
 * rollback lists for §2.2/§2.3: reset, `bun install --frozen-lockfile`,
 * and — mode-dependent, hence `state.mode` below — `bun run build`, THEN
 * restart, THEN RE-CHECK `/health` and record whether the rollback itself
 * actually landed on a healthy `prevSha` (an unverified rollback is not a
 * rollback; a broken build restored to another broken state must not be
 * silently reported as fixed).
 *
 * ONLY /health IS CHECKED — NOT "MANAGER CHECK-IN" (PR #436 review round 1
 * fix): the story's own wording ("a health check or manager check-in has
 * not succeeded") names two possible triggers; this watchdog implements
 * only the first. A Codey manager agent not confirming in the
 * `#team-brooswit-factory` thread is handled by a SEPARATE, human-paced
 * mechanism (the runbook's own §5: the director escalates to Brooswit
 * after ~10 minutes) — deliberately not folded into this 5-minute-default
 * automatic check, which only ever looks at whether the DAEMON came back
 * up on the right build, never at whether a PERSON/manager-agent responded
 * in a chat thread (this process has no way to observe that reliably
 * anyway). See the runbook's own §3 for this stated in operator-facing
 * terms.
 *
 * Exit codes: 0 healthy/no-op, 1 rolled back and VERIFIED healthy on
 * `prevSha` (or would have, under `--dry-run`), 3 rolled back but
 * verification itself failed (post-rollback `/health` still not
 * matching `prevSha`/not `ok` — the more serious case: even the known-good
 * build won't come up, which is not this watchdog's to fix any further,
 * only to report loudly) — deliberately non-zero so a real (non-dry-run)
 * rollback shows up as a failed systemd unit in the journal, the same
 * "loud on its own" discipline `src/daemon/health.ts` documents for stale
 * loops. 2 is a usage/state error (bad flags, missing state file) —
 * distinguishable from "checked and rolled back" by exit code alone,
 * never by parsing stdout.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { decideRollback, type HealthSnapshot } from "./rollback-decision.js";

export type DeployMode = "source" | "built";

export interface WatchdogState {
  installDir: string;
  unit: string;
  port: number;
  prevSha: string;
  expectedSha: string;
  windowSec: number;
  /** "source": `ExecStart=` runs straight from a source checkout (e.g. `bun run src/daemon/index.ts`) — sha is read git-at-start, no build artifact to restore. "built": `ExecStart=` runs `dist/butchr.js` — sha is baked in, so a rollback must also rebuild `dist/` (gitignored, so `git reset --hard` alone leaves the bad build in place). See §1.1 of docs/codey-deploy-runbook.md. */
  mode: DeployMode;
  armedAt: string;
  disarmed: boolean;
  disarmedAt: string | null;
  disarmedReason: string | null;
  rolledBack: boolean;
  rolledBackAt: string | null;
  /** null until a rollback has been attempted; true/false once `check` re-verified /health after rolling back. See exit code 3 in this file's own doc comment. */
  rollbackVerified: boolean | null;
}

export interface WatchdogIo {
  readStateFile: (path: string) => Promise<string | null>;
  writeStateFile: (path: string, contents: string) => Promise<void>;
  fetchHealth: (port: number) => Promise<HealthSnapshot | null>;
  gitResetHard: (installDir: string, sha: string) => void;
  bunInstall: (installDir: string) => void;
  bunBuild: (installDir: string) => void;
  systemctlRestart: (unit: string) => void;
  systemctlStopTimer: (timerUnit: string) => void;
  /** Absolute path to the `bun` executable this process is running under (`process.execPath`) — printed in the `systemd-run` command `arm` suggests, since a transient unit runs in the user systemd instance's own PATH, which frequently does not include a bare `bun` (see docs/codey-deploy-runbook.md §3.2's rehearsal). */
  bunExecPath: () => string;
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const HEALTH_FETCH_TIMEOUT_MS = 5_000;

export function defaultIo(): WatchdogIo {
  return {
    async readStateFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    async writeStateFile(path, contents) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");
    },
    async fetchHealth(port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS) });
        if (!res.ok) return null;
        const body = (await res.json()) as unknown;
        if (typeof body !== "object" || body === null || typeof (body as { ok?: unknown }).ok !== "boolean") return null;
        return body as HealthSnapshot;
      } catch {
        return null;
      }
    },
    gitResetHard(installDir, sha) {
      execFileSync("git", ["-C", installDir, "reset", "--hard", sha], { stdio: "inherit" });
    },
    bunInstall(installDir) {
      execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: installDir, stdio: "inherit" });
    },
    bunBuild(installDir) {
      execFileSync("bun", ["run", "build"], { cwd: installDir, stdio: "inherit" });
    },
    systemctlRestart(unit) {
      execFileSync("systemctl", ["--user", "restart", unit], { stdio: "inherit" });
    },
    systemctlStopTimer(timerUnit) {
      execFileSync("systemctl", ["--user", "stop", timerUnit], { stdio: "inherit" });
    },
    bunExecPath: () => process.execPath,
    now: () => new Date(),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}

const USAGE = `usage: bun run scripts/deploy/watchdog.ts arm --state-file <path> --install-dir <dir>
                                            --unit <systemd-unit> --port <n>
                                            --prev-sha <sha> --expected-sha <sha>
                                            --window-sec <n> --mode source|built
       bun run scripts/deploy/watchdog.ts check --state-file <path> [--dry-run]
       bun run scripts/deploy/watchdog.ts disarm --state-file <path> [--timer-unit <name>] [--reason <text>]
       bun run scripts/deploy/watchdog.ts status --state-file <path>

"arm" only writes state — it prints the exact "systemd-run --user --on-active=..."
command (using this process's own absolute bun path) to schedule "check" as
a transient unit; run that command yourself. "check" is what the scheduled
timer runs: it fetches /health, decides healthy/rollback
(scripts/deploy/rollback-decision.ts), and on rollback runs, in order,
"git reset --hard <prevSha>", "bun install --frozen-lockfile", "bun run
build" (only when --mode built), "systemctl --user restart <unit>", then
re-fetches /health to VERIFY the rollback itself landed healthy on
<prevSha> — unless --dry-run, which only logs what it would do and touches
nothing. "disarm" cancels a still-pending watchdog (e.g. the manager
already confirmed health another way). "status" is always read-only.
Only /health is ever checked automatically — a manager agent not
confirming in chat is a separate, human-paced escalation (see the
runbook's own §5), not something this watchdog observes or acts on.`;

function parseFlags(rest: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

function requireFlag(flags: Map<string, string | true>, name: string, io: WatchdogIo): string | null {
  const v = flags.get(name);
  if (typeof v !== "string" || v.length === 0) {
    io.stderr(`missing required --${name}\n\n${USAGE}`);
    return null;
  }
  return v;
}

function timerUnitFor(state: Pick<WatchdogState, "unit">): string {
  return `butchr-deploy-watchdog-${state.unit.replace(/\.service$/, "")}`;
}

async function loadState(stateFile: string, io: WatchdogIo): Promise<WatchdogState | null> {
  const raw = await io.readStateFile(stateFile);
  if (raw === null) return null;
  return JSON.parse(raw) as WatchdogState;
}

async function saveState(stateFile: string, state: WatchdogState, io: WatchdogIo): Promise<void> {
  await io.writeStateFile(stateFile, JSON.stringify(state, null, 2) + "\n");
}

async function cmdArm(rest: string[], io: WatchdogIo): Promise<number> {
  const flags = parseFlags(rest);
  const stateFile = requireFlag(flags, "state-file", io);
  const installDir = requireFlag(flags, "install-dir", io);
  const unit = requireFlag(flags, "unit", io);
  const portStr = requireFlag(flags, "port", io);
  const prevSha = requireFlag(flags, "prev-sha", io);
  const expectedSha = requireFlag(flags, "expected-sha", io);
  const windowSecStr = requireFlag(flags, "window-sec", io);
  const modeStr = requireFlag(flags, "mode", io);
  if (!stateFile || !installDir || !unit || !portStr || !prevSha || !expectedSha || !windowSecStr || !modeStr) return 2;

  const port = Number(portStr);
  const windowSec = Number(windowSecStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    io.stderr(`--port must be a valid port number, got ${JSON.stringify(portStr)}`);
    return 2;
  }
  if (!Number.isInteger(windowSec) || windowSec <= 0) {
    io.stderr(`--window-sec must be a positive integer, got ${JSON.stringify(windowSecStr)}`);
    return 2;
  }
  if (modeStr !== "source" && modeStr !== "built") {
    io.stderr(`--mode must be "source" or "built" (see docs/codey-deploy-runbook.md §1.1 for how to tell which one Codey uses), got ${JSON.stringify(modeStr)}`);
    return 2;
  }
  const mode: DeployMode = modeStr;
  if (prevSha === expectedSha) {
    io.stderr(`--prev-sha and --expected-sha are identical (${prevSha}) — arming a watchdog for a no-op deploy is almost certainly a mistake; if this deploy really is a restart-only no-op, there is nothing to roll back to and this watchdog should not be armed`);
    return 2;
  }

  const state: WatchdogState = {
    installDir, unit, port, prevSha, expectedSha, windowSec, mode,
    armedAt: io.now().toISOString(),
    disarmed: false, disarmedAt: null, disarmedReason: null,
    rolledBack: false, rolledBackAt: null, rollbackVerified: null,
  };
  await saveState(stateFile, state, io);

  const timerUnit = timerUnitFor(state);
  io.stdout(`armed: ${stateFile}`);
  io.stdout(`  prevSha=${prevSha} expectedSha=${expectedSha} unit=${unit} port=${port} windowSec=${windowSec} mode=${mode}`);
  io.stdout("");
  io.stdout("now schedule the check by running exactly this:");
  io.stdout(`  systemd-run --user --on-active=${windowSec} --unit=${timerUnit} -- ${io.bunExecPath()} run ${installDir}/scripts/deploy/watchdog.ts check --state-file ${stateFile}`);
  return 0;
}

async function cmdCheck(rest: string[], io: WatchdogIo): Promise<number> {
  const flags = parseFlags(rest);
  const stateFile = requireFlag(flags, "state-file", io);
  if (!stateFile) return 2;
  const dryRun = flags.has("dry-run");

  const state = await loadState(stateFile, io);
  if (!state) {
    io.stderr(`no armed watchdog state at ${stateFile} — nothing to check`);
    return 2;
  }
  if (state.disarmed) {
    io.stdout(`${stateFile}: already disarmed (${state.disarmedReason ?? "no reason recorded"}) — no-op`);
    return 0;
  }

  const health = await io.fetchHealth(state.port);
  const decision = decideRollback({ expectedSha: state.expectedSha, health, disarmed: state.disarmed });
  io.stdout(`decision: ${decision.action} — ${decision.reason}`);

  if (decision.action === "healthy") {
    state.disarmed = true;
    state.disarmedAt = io.now().toISOString();
    state.disarmedReason = decision.reason;
    await saveState(stateFile, state, io);
    io.stdout(`${stateFile}: marked healthy and disarmed`);
    return 0;
  }

  // decision.action === "rollback" ("noop" is unreachable here — state.disarmed is checked above)
  if (dryRun) {
    io.stdout(`DRY RUN — would run: git -C ${state.installDir} reset --hard ${state.prevSha}`);
    io.stdout(`DRY RUN — would run: bun install --frozen-lockfile   (in ${state.installDir})`);
    if (state.mode === "built") io.stdout(`DRY RUN — would run: bun run build   (in ${state.installDir} — mode=built)`);
    io.stdout(`DRY RUN — would run: systemctl --user restart ${state.unit}`);
    io.stdout("DRY RUN — would then re-fetch /health to verify the rollback landed healthy");
    io.stdout("DRY RUN — state left armed (not marked rolled back)");
    return 1;
  }

  io.stderr(`ROLLING BACK: ${decision.reason}`);
  io.gitResetHard(state.installDir, state.prevSha);
  io.bunInstall(state.installDir);
  if (state.mode === "built") io.bunBuild(state.installDir);
  io.systemctlRestart(state.unit);

  const postHealth = await io.fetchHealth(state.port);
  const postDecision = decideRollback({ expectedSha: state.prevSha, health: postHealth, disarmed: false });
  const rollbackVerified = postDecision.action === "healthy";

  state.rolledBack = true;
  state.rolledBackAt = io.now().toISOString();
  state.rollbackVerified = rollbackVerified;
  state.disarmed = true;
  state.disarmedAt = state.rolledBackAt;
  state.disarmedReason = `rolled back: ${decision.reason}`;
  await saveState(stateFile, state, io);

  if (rollbackVerified) {
    io.stderr(`rolled back to ${state.prevSha} and restarted ${state.unit} — VERIFIED healthy on the restored build`);
    return 1;
  }
  io.stderr(`rolled back to ${state.prevSha} and restarted ${state.unit} — NOT VERIFIED: post-rollback /health check says ${postDecision.reason}. The known-good build did not come back up cleanly either — this needs a human now, not another automatic retry.`);
  return 3;
}

async function cmdDisarm(rest: string[], io: WatchdogIo): Promise<number> {
  const flags = parseFlags(rest);
  const stateFile = requireFlag(flags, "state-file", io);
  if (!stateFile) return 2;
  const timerUnit = flags.get("timer-unit");
  const reason = flags.get("reason");

  const state = await loadState(stateFile, io);
  if (!state) {
    io.stderr(`no armed watchdog state at ${stateFile} — nothing to disarm`);
    return 2;
  }
  state.disarmed = true;
  state.disarmedAt = io.now().toISOString();
  state.disarmedReason = typeof reason === "string" ? reason : "manually disarmed";
  await saveState(stateFile, state, io);
  io.stdout(`${stateFile}: disarmed (${state.disarmedReason})`);

  if (typeof timerUnit === "string") {
    io.systemctlStopTimer(timerUnit);
    io.stdout(`stopped pending timer ${timerUnit}`);
  }
  return 0;
}

async function cmdStatus(rest: string[], io: WatchdogIo): Promise<number> {
  const flags = parseFlags(rest);
  const stateFile = requireFlag(flags, "state-file", io);
  if (!stateFile) return 2;

  const state = await loadState(stateFile, io);
  if (!state) {
    io.stdout(`no watchdog state at ${stateFile}`);
    return 1;
  }
  io.stdout(JSON.stringify(state, null, 2));
  if (!state.disarmed) {
    const health = await io.fetchHealth(state.port);
    const decision = decideRollback({ expectedSha: state.expectedSha, health, disarmed: state.disarmed });
    io.stdout(`preview (does not act): ${decision.action} — ${decision.reason}`);
  }
  return 0;
}

/** `argv` is everything after `watchdog.ts` (i.e. `process.argv.slice(2)`). Returns the process exit code; never throws. */
export async function runWatchdogCli(argv: string[], io: WatchdogIo = defaultIo()): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    (sub === undefined ? io.stderr : io.stdout)(USAGE);
    return sub === undefined ? 2 : 0;
  }
  if (sub === "arm") return cmdArm(rest, io);
  if (sub === "check") return cmdCheck(rest, io);
  if (sub === "disarm") return cmdDisarm(rest, io);
  if (sub === "status") return cmdStatus(rest, io);
  io.stderr(`unknown subcommand ${JSON.stringify(sub)}\n\n${USAGE}`);
  return 2;
}

if (import.meta.main) {
  process.exit(await runWatchdogCli(process.argv.slice(2)));
}
