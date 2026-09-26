import { describe, expect, test } from "bun:test";
import { runWatchdogCli, type WatchdogIo, type WatchdogState } from "../../scripts/deploy/watchdog.js";
import type { HealthSnapshot } from "../../scripts/deploy/rollback-decision.js";

const PREV_SHA = "0000000000000000000000000000000000000000";
const NEW_SHA = "1111111111111111111111111111111111111111";
const STATE_FILE = "/fake/state.json";
const FAKE_BUN = "/fake/.bun/bin/bun";

/**
 * `health` is a queue: `cmdCheck`'s rollback path calls `fetchHealth` TWICE
 * (the initial check, then a second re-verification fetch after the
 * rollback actions run) — a single fixed value can't distinguish those, so
 * tests that care which is which pass an array consumed in order (the last
 * entry repeats once exhausted).
 */
function fakeIo(opts: { health?: HealthSnapshot | null | Array<HealthSnapshot | null> } = {}) {
  const files = new Map<string, string>();
  const stdout: string[] = [];
  const healthQueue = Array.isArray(opts.health) ? [...opts.health] : undefined;
  const fixedHealth = Array.isArray(opts.health) ? undefined : (opts.health ?? null);
  const calls: {
    gitResetHard: [string, string][]; bunInstall: string[]; bunBuild: string[];
    systemctlRestart: string[]; systemctlStopTimer: string[];
  } = { gitResetHard: [], bunInstall: [], bunBuild: [], systemctlRestart: [], systemctlStopTimer: [] };
  const io: WatchdogIo = {
    async readStateFile(path) {
      return files.has(path) ? files.get(path)! : null;
    },
    async writeStateFile(path, contents) {
      files.set(path, contents);
    },
    async fetchHealth() {
      if (healthQueue) return healthQueue.length > 1 ? healthQueue.shift()! : healthQueue[0]!;
      return fixedHealth ?? null;
    },
    gitResetHard(installDir, sha) {
      calls.gitResetHard.push([installDir, sha]);
    },
    bunInstall(installDir) {
      calls.bunInstall.push(installDir);
    },
    bunBuild(installDir) {
      calls.bunBuild.push(installDir);
    },
    systemctlRestart(unit) {
      calls.systemctlRestart.push(unit);
    },
    systemctlStopTimer(timerUnit) {
      calls.systemctlStopTimer.push(timerUnit);
    },
    bunExecPath: () => FAKE_BUN,
    now: () => new Date("2026-09-26T00:00:00.000Z"),
    stdout: (line) => stdout.push(line),
    stderr: () => {},
  };
  return { io, files, calls, stdout };
}

async function arm(io: WatchdogIo, overrides: Partial<Record<string, string>> = {}) {
  const args = {
    "state-file": STATE_FILE, "install-dir": "/opt/butchr", unit: "butchr.service",
    port: "7717", "prev-sha": PREV_SHA, "expected-sha": NEW_SHA, "window-sec": "300", mode: "source",
    ...overrides,
  };
  const argv = ["arm", ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, v])];
  return runWatchdogCli(argv, io);
}

const HEALTHY_NEW: HealthSnapshot = { ok: true, build: { sha: NEW_SHA } };
const HEALTHY_PREV: HealthSnapshot = { ok: true, build: { sha: PREV_SHA } };

describe("watchdog CLI", () => {
  test("arm writes a state file with disarmed:false, mode, and the given fields", async () => {
    const { io, files } = fakeIo();
    const code = await arm(io);
    expect(code).toBe(0);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.prevSha).toBe(PREV_SHA);
    expect(state.expectedSha).toBe(NEW_SHA);
    expect(state.mode).toBe("source");
    expect(state.disarmed).toBe(false);
    expect(state.rolledBack).toBe(false);
    expect(state.rollbackVerified).toBeNull();
  });

  test("arm prints the systemd-run command using the ABSOLUTE bun path, not a bare 'bun'", async () => {
    const { io, stdout } = fakeIo();
    await arm(io);
    const line = stdout.find((l) => l.includes("systemd-run"));
    expect(line).toContain(FAKE_BUN);
    expect(line).not.toMatch(/\s--\s+bun\s+run/); // must not fall back to a bare "bun" on PATH
  });

  test("arm refuses identical prev/expected sha (nothing to roll back to)", async () => {
    const { io } = fakeIo();
    const code = await arm(io, { "expected-sha": PREV_SHA });
    expect(code).toBe(2);
  });

  test("arm refuses a non-integer --window-sec", async () => {
    const { io } = fakeIo();
    const code = await arm(io, { "window-sec": "soon" });
    expect(code).toBe(2);
  });

  test("arm refuses an invalid --mode", async () => {
    const { io } = fakeIo();
    const code = await arm(io, { mode: "sourcey" });
    expect(code).toBe(2);
  });

  test("arm requires --mode", async () => {
    const { io } = fakeIo();
    const code = await runWatchdogCli(
      ["arm", "--state-file", STATE_FILE, "--install-dir", "/opt/butchr", "--unit", "butchr.service",
        "--port", "7717", "--prev-sha", PREV_SHA, "--expected-sha", NEW_SHA, "--window-sec", "300"],
      io,
    );
    expect(code).toBe(2);
  });

  test("check with no armed state exits 2 (nothing to check)", async () => {
    const { io } = fakeIo();
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(2);
  });

  test("check: healthy response disarms and touches neither git, bun, nor systemctl", async () => {
    const { io, files, calls } = fakeIo({ health: HEALTHY_NEW });
    await arm(io);
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(0);
    expect(calls.gitResetHard).toEqual([]);
    expect(calls.bunInstall).toEqual([]);
    expect(calls.bunBuild).toEqual([]);
    expect(calls.systemctlRestart).toEqual([]);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.disarmed).toBe(true);
    expect(state.rolledBack).toBe(false);
  });

  test("check: unhealthy (unreachable) rolls back for real, source mode — reset, bun install, restart, in that order, no build step, verified healthy on prevSha exits 1", async () => {
    const { io, files, calls } = fakeIo({ health: [null, HEALTHY_PREV] });
    await arm(io, { mode: "source" });
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(1);
    expect(calls.gitResetHard).toEqual([["/opt/butchr", PREV_SHA]]);
    expect(calls.bunInstall).toEqual(["/opt/butchr"]);
    expect(calls.bunBuild).toEqual([]); // source mode never rebuilds
    expect(calls.systemctlRestart).toEqual(["butchr.service"]);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.rolledBack).toBe(true);
    expect(state.rollbackVerified).toBe(true);
    expect(state.disarmed).toBe(true);
  });

  test("check: unhealthy rolls back for real, BUILT mode — reset, bun install, bun build, THEN restart, in that order", async () => {
    const { io, calls } = fakeIo({ health: [null, HEALTHY_PREV] });
    await arm(io, { mode: "built" });
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(1);
    expect(calls.gitResetHard).toEqual([["/opt/butchr", PREV_SHA]]);
    expect(calls.bunInstall).toEqual(["/opt/butchr"]);
    expect(calls.bunBuild).toEqual(["/opt/butchr"]); // built mode DOES rebuild
    expect(calls.systemctlRestart).toEqual(["butchr.service"]);
  });

  test("check: rollback performed but post-rollback /health is STILL unhealthy — rollbackVerified:false, exit code 3 (not 1)", async () => {
    const { io, files, calls } = fakeIo({ health: [null, null] });
    await arm(io);
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(3);
    expect(calls.gitResetHard.length).toBe(1); // the rollback attempt itself still happened
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.rolledBack).toBe(true);
    expect(state.rollbackVerified).toBe(false);
    expect(state.disarmed).toBe(true); // still disarmed — no infinite retry
  });

  test("check --dry-run: same unhealthy verdict, but NEVER calls git/bun/systemctl and leaves state armed", async () => {
    const { io, files, calls } = fakeIo({ health: null });
    await arm(io, { mode: "built" });
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE, "--dry-run"], io);
    expect(code).toBe(1);
    expect(calls.gitResetHard).toEqual([]);
    expect(calls.bunInstall).toEqual([]);
    expect(calls.bunBuild).toEqual([]);
    expect(calls.systemctlRestart).toEqual([]);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.disarmed).toBe(false);
    expect(state.rolledBack).toBe(false);
  });

  test("check --dry-run mentions the build step only in built mode", async () => {
    const src = fakeIo({ health: null });
    await arm(src.io, { mode: "source" });
    await runWatchdogCli(["check", "--state-file", STATE_FILE, "--dry-run"], src.io);
    expect(src.stdout.some((l) => l.includes("bun run build"))).toBe(false);

    const built = fakeIo({ health: null });
    await arm(built.io, { mode: "built" });
    await runWatchdogCli(["check", "--state-file", STATE_FILE, "--dry-run"], built.io);
    expect(built.stdout.some((l) => l.includes("bun run build"))).toBe(true);
  });

  test("check on an already-disarmed state is a no-op, even if health now looks unhealthy", async () => {
    const { io, calls } = fakeIo({ health: null });
    await arm(io);
    await runWatchdogCli(["disarm", "--state-file", STATE_FILE], io);
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(0);
    expect(calls.gitResetHard).toEqual([]);
    expect(calls.systemctlRestart).toEqual([]);
  });

  test("disarm with --timer-unit stops that timer", async () => {
    const { io, calls } = fakeIo();
    await arm(io);
    const code = await runWatchdogCli(["disarm", "--state-file", STATE_FILE, "--timer-unit", "butchr-deploy-watchdog-butchr"], io);
    expect(code).toBe(0);
    expect(calls.systemctlStopTimer).toEqual(["butchr-deploy-watchdog-butchr"]);
  });

  test("status on a missing state file exits 1 without throwing", async () => {
    const { io } = fakeIo();
    const code = await runWatchdogCli(["status", "--state-file", STATE_FILE], io);
    expect(code).toBe(1);
  });

  test("unknown subcommand exits 2", async () => {
    const { io } = fakeIo();
    const code = await runWatchdogCli(["frobnicate"], io);
    expect(code).toBe(2);
  });

  test("no subcommand exits 2; --help exits 0", async () => {
    const { io } = fakeIo();
    expect(await runWatchdogCli([], io)).toBe(2);
    expect(await runWatchdogCli(["--help"], io)).toBe(0);
    expect(await runWatchdogCli(["-h"], io)).toBe(0);
  });

  test("arm refuses an out-of-range --port", async () => {
    const { io } = fakeIo();
    const code = await arm(io, { port: "99999" });
    expect(code).toBe(2);
  });

  test("arm with a missing required flag exits 2", async () => {
    const { io } = fakeIo();
    const code = await runWatchdogCli(["arm", "--state-file", STATE_FILE], io);
    expect(code).toBe(2);
  });

  test("disarm with no armed state exits 2", async () => {
    const { io } = fakeIo();
    const code = await runWatchdogCli(["disarm", "--state-file", STATE_FILE], io);
    expect(code).toBe(2);
  });

  test("status on an armed, still-live state prints a non-acting preview", async () => {
    const { io } = fakeIo({ health: HEALTHY_NEW });
    await arm(io);
    const code = await runWatchdogCli(["status", "--state-file", STATE_FILE], io);
    expect(code).toBe(0);
  });
});
