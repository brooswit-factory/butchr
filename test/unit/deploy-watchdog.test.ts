import { describe, expect, test } from "bun:test";
import { runWatchdogCli, type WatchdogIo, type WatchdogState } from "../../scripts/deploy/watchdog.js";
import type { HealthSnapshot } from "../../scripts/deploy/rollback-decision.js";

const PREV_SHA = "0000000000000000000000000000000000000000";
const NEW_SHA = "1111111111111111111111111111111111111111";
const STATE_FILE = "/fake/state.json";

function fakeIo(opts: { health?: HealthSnapshot | null } = {}) {
  const files = new Map<string, string>();
  const calls: { gitResetHard: [string, string][]; systemctlRestart: string[]; systemctlStopTimer: string[] } = {
    gitResetHard: [], systemctlRestart: [], systemctlStopTimer: [],
  };
  const io: WatchdogIo = {
    async readStateFile(path) {
      return files.has(path) ? files.get(path)! : null;
    },
    async writeStateFile(path, contents) {
      files.set(path, contents);
    },
    async fetchHealth() {
      return opts.health ?? null;
    },
    gitResetHard(installDir, sha) {
      calls.gitResetHard.push([installDir, sha]);
    },
    systemctlRestart(unit) {
      calls.systemctlRestart.push(unit);
    },
    systemctlStopTimer(timerUnit) {
      calls.systemctlStopTimer.push(timerUnit);
    },
    now: () => new Date("2026-09-26T00:00:00.000Z"),
    stdout: () => {},
    stderr: () => {},
  };
  return { io, files, calls };
}

async function arm(io: WatchdogIo, overrides: Partial<Record<string, string>> = {}) {
  const args = {
    "state-file": STATE_FILE, "install-dir": "/opt/butchr", unit: "butchr.service",
    port: "7717", "prev-sha": PREV_SHA, "expected-sha": NEW_SHA, "window-sec": "300",
    ...overrides,
  };
  const argv = ["arm", ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, v])];
  return runWatchdogCli(argv, io);
}

describe("watchdog CLI", () => {
  test("arm writes a state file with disarmed:false and the given fields", async () => {
    const { io, files } = fakeIo();
    const code = await arm(io);
    expect(code).toBe(0);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.prevSha).toBe(PREV_SHA);
    expect(state.expectedSha).toBe(NEW_SHA);
    expect(state.disarmed).toBe(false);
    expect(state.rolledBack).toBe(false);
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

  test("check with no armed state exits 2 (nothing to check)", async () => {
    const { io } = fakeIo();
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(2);
  });

  test("check: healthy response disarms and touches neither git nor systemctl", async () => {
    const { io, files, calls } = fakeIo({ health: { ok: true, build: { sha: NEW_SHA } } });
    await arm(io);
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(0);
    expect(calls.gitResetHard).toEqual([]);
    expect(calls.systemctlRestart).toEqual([]);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.disarmed).toBe(true);
    expect(state.rolledBack).toBe(false);
  });

  test("check: unhealthy response (unreachable) rolls back for real — git reset then systemctl restart, in that order, and exits 1", async () => {
    const { io, files, calls } = fakeIo({ health: null });
    await arm(io);
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(1);
    expect(calls.gitResetHard).toEqual([["/opt/butchr", PREV_SHA]]);
    expect(calls.systemctlRestart).toEqual(["butchr.service"]);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.rolledBack).toBe(true);
    expect(state.disarmed).toBe(true);
  });

  test("check --dry-run: same unhealthy verdict, but NEVER calls git/systemctl and leaves state armed", async () => {
    const { io, files, calls } = fakeIo({ health: null });
    await arm(io);
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE, "--dry-run"], io);
    expect(code).toBe(1);
    expect(calls.gitResetHard).toEqual([]);
    expect(calls.systemctlRestart).toEqual([]);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.disarmed).toBe(false);
    expect(state.rolledBack).toBe(false);
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
    const { io } = fakeIo({ health: { ok: true, build: { sha: NEW_SHA } } });
    await arm(io);
    const code = await runWatchdogCli(["status", "--state-file", STATE_FILE], io);
    expect(code).toBe(0);
  });
});
