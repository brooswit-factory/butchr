import { describe, expect, test } from "bun:test";
import { runWatchdogCli, type WatchdogIo, type WatchdogState } from "../../scripts/deploy/watchdog.js";
import type { HealthSnapshot } from "../../scripts/deploy/rollback-decision.js";

const PREV_SHA = "0000000000000000000000000000000000000000";
const NEW_SHA = "1111111111111111111111111111111111111111";
const STATE_FILE = "/fake/state.json";
const FAKE_BUN = "/fake/.bun/bin/bun";

interface FakeIoOpts {
  /** A queue of /health responses, one per call to fetchHealth (initial check, then each verification poll); the LAST entry repeats once exhausted. Defaults to always-null (unreachable). */
  health?: Array<HealthSnapshot | null>;
  /** Steps whose fake implementation should throw, by the same names used in watchdog.ts's own `steps` array. */
  throwOn?: Set<"git reset --hard" | "bun install --frozen-lockfile" | "bun run build" | "systemctl --user restart">;
}

function fakeIo(opts: FakeIoOpts = {}) {
  const files = new Map<string, string>();
  const stdout: string[] = [];
  const healthQueue = opts.health ?? [null];
  let healthCallIndex = 0;
  let clockMs = new Date("2026-09-26T00:00:00.000Z").getTime();
  const calls: {
    gitResetHard: [string, string][]; bunInstall: string[]; bunBuild: string[];
    systemctlRestart: string[]; systemctlStopTimer: string[]; sleeps: number[];
  } = { gitResetHard: [], bunInstall: [], bunBuild: [], systemctlRestart: [], systemctlStopTimer: [], sleeps: [] };
  const throwIfNeeded = (step: NonNullable<FakeIoOpts["throwOn"]> extends Set<infer T> ? T : never) => {
    if (opts.throwOn?.has(step)) throw new Error(`simulated failure: ${step}`);
  };
  const io: WatchdogIo = {
    async readStateFile(path) {
      return files.has(path) ? files.get(path)! : null;
    },
    async writeStateFile(path, contents) {
      files.set(path, contents);
    },
    async fetchHealth() {
      const v = healthQueue[Math.min(healthCallIndex, healthQueue.length - 1)]!;
      healthCallIndex++;
      return v;
    },
    gitResetHard(installDir, sha) {
      throwIfNeeded("git reset --hard");
      calls.gitResetHard.push([installDir, sha]);
    },
    bunInstall(installDir) {
      throwIfNeeded("bun install --frozen-lockfile");
      calls.bunInstall.push(installDir);
    },
    bunBuild(installDir) {
      throwIfNeeded("bun run build");
      calls.bunBuild.push(installDir);
    },
    systemctlRestart(unit) {
      throwIfNeeded("systemctl --user restart");
      calls.systemctlRestart.push(unit);
    },
    systemctlStopTimer(timerUnit) {
      calls.systemctlStopTimer.push(timerUnit);
    },
    bunExecPath: () => FAKE_BUN,
    now: () => new Date(clockMs),
    async sleep(ms) {
      calls.sleeps.push(ms);
      clockMs += ms; // advance the fake clock instantly instead of actually waiting
    },
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
  test("arm writes a state file with disarmed:false, mode, verifySec, and the given fields", async () => {
    const { io, files } = fakeIo();
    const code = await arm(io);
    expect(code).toBe(0);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.prevSha).toBe(PREV_SHA);
    expect(state.expectedSha).toBe(NEW_SHA);
    expect(state.mode).toBe("source");
    expect(state.verifySec).toBeGreaterThan(0);
    expect(state.disarmed).toBe(false);
    expect(state.rolledBack).toBe(false);
    expect(state.rollbackVerified).toBeNull();
    expect(state.rollbackFailedStep).toBeNull();
  });

  test("arm accepts an explicit --verify-sec", async () => {
    const { io, files } = fakeIo();
    await arm(io, { "verify-sec": "12" });
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.verifySec).toBe(12);
  });

  test("arm refuses a non-integer --verify-sec", async () => {
    const { io } = fakeIo();
    const code = await arm(io, { "verify-sec": "soon" });
    expect(code).toBe(2);
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

  test("arm requires --mode (every other flag given)", async () => {
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
    const { io, files, calls } = fakeIo({ health: [HEALTHY_NEW] });
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

  test("check: unhealthy initially, rolls back, source mode — reset, bun install, restart, in order, no build step; verification polls and finds it healthy on the FIRST poll after restart", async () => {
    const { io, files, calls } = fakeIo({ health: [null, HEALTHY_PREV] });
    await arm(io, { mode: "source", "verify-sec": "30" });
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(1);
    expect(calls.gitResetHard).toEqual([["/opt/butchr", PREV_SHA]]);
    expect(calls.bunInstall).toEqual(["/opt/butchr"]);
    expect(calls.bunBuild).toEqual([]); // source mode never rebuilds
    expect(calls.systemctlRestart).toEqual(["butchr.service"]);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.rolledBack).toBe(true);
    expect(state.rollbackVerified).toBe(true);
    expect(state.rollbackFailedStep).toBeNull();
    expect(state.disarmed).toBe(true);
  });

  test("check: unhealthy, rolls back, BUILT mode — reset, bun install, bun build, THEN restart, in that order", async () => {
    const { io, calls } = fakeIo({ health: [null, HEALTHY_PREV] });
    await arm(io, { mode: "built" });
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(1);
    expect(calls.gitResetHard).toEqual([["/opt/butchr", PREV_SHA]]);
    expect(calls.bunInstall).toEqual(["/opt/butchr"]);
    expect(calls.bunBuild).toEqual(["/opt/butchr"]); // built mode DOES rebuild
    expect(calls.systemctlRestart).toEqual(["butchr.service"]);
  });

  test("verification POLLS: unhealthy for the first few polls after restart, then healthy — verified true, exit 1 (not a false alarm from checking only once)", async () => {
    // index 0 = initial check (unhealthy, triggers rollback); 1-3 = post-restart polls still down; 4 = finally healthy
    const { io, files, calls } = fakeIo({ health: [null, null, null, null, HEALTHY_PREV] });
    await arm(io, { "verify-sec": "60" });
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(1);
    expect(calls.sleeps.length).toBeGreaterThan(0); // it actually polled more than once
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.rollbackVerified).toBe(true);
  });

  test("verification TIMES OUT: never healthy within --verify-sec — not verified, exit 3 (distinct from a rollback step failing)", async () => {
    const { io, files, calls } = fakeIo({ health: [null] }); // every call (initial + every poll) returns unreachable
    await arm(io, { "verify-sec": "10" }); // small budget so the test doesn't need many fake polls
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(3);
    expect(calls.gitResetHard.length).toBe(1); // the rollback actions themselves still ran
    expect(calls.systemctlRestart.length).toBe(1);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.rolledBack).toBe(true); // the mechanical steps succeeded
    expect(state.rollbackVerified).toBe(false); // but health was never confirmed
    expect(state.rollbackFailedStep).toBeNull(); // NOT a step failure — a verification timeout is a different thing
    expect(state.disarmed).toBe(true);
  });

  test("rollback step failure: git reset throws — no bun/systemctl calls at all, state records the failed step, exit 3", async () => {
    const { io, files, calls } = fakeIo({ health: [null], throwOn: new Set(["git reset --hard"]) });
    await arm(io);
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(3);
    expect(calls.gitResetHard).toEqual([]); // it throws before recording (fake throws inside the call)
    expect(calls.bunInstall).toEqual([]);
    expect(calls.systemctlRestart).toEqual([]);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.rolledBack).toBe(false);
    expect(state.rollbackVerified).toBe(false);
    expect(state.rollbackFailedStep).toMatch(/git reset --hard/);
    expect(state.disarmed).toBe(true);
  });

  test("rollback step failure: bun install throws — reset already ran, but build/restart never attempted", async () => {
    const { io, calls, files } = fakeIo({ health: [null], throwOn: new Set(["bun install --frozen-lockfile"]) });
    await arm(io, { mode: "built" });
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(3);
    expect(calls.gitResetHard.length).toBe(1); // this step ran before the failing one
    expect(calls.bunBuild).toEqual([]);
    expect(calls.systemctlRestart).toEqual([]);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.rollbackFailedStep).toMatch(/bun install --frozen-lockfile/);
  });

  test("rollback step failure: bun run build throws (built mode) — restart never attempted", async () => {
    const { io, calls, files } = fakeIo({ health: [null], throwOn: new Set(["bun run build"]) });
    await arm(io, { mode: "built" });
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(3);
    expect(calls.bunInstall.length).toBe(1);
    expect(calls.systemctlRestart).toEqual([]);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.rollbackFailedStep).toMatch(/bun run build/);
  });

  test("rollback step failure: systemctl restart throws — reported as a failed step, not a verification timeout", async () => {
    const { io, files } = fakeIo({ health: [null], throwOn: new Set(["systemctl --user restart"]) });
    await arm(io);
    const code = await runWatchdogCli(["check", "--state-file", STATE_FILE], io);
    expect(code).toBe(3);
    const state = JSON.parse(files.get(STATE_FILE)!) as WatchdogState;
    expect(state.rollbackFailedStep).toMatch(/systemctl --user restart/);
    expect(state.rolledBack).toBe(false);
  });

  test("check --dry-run: same unhealthy verdict, but NEVER calls git/bun/systemctl and leaves state armed", async () => {
    const { io, files, calls } = fakeIo({ health: [null] });
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
    const src = fakeIo({ health: [null] });
    await arm(src.io, { mode: "source" });
    await runWatchdogCli(["check", "--state-file", STATE_FILE, "--dry-run"], src.io);
    expect(src.stdout.some((l) => l.includes("bun run build"))).toBe(false);

    const built = fakeIo({ health: [null] });
    await arm(built.io, { mode: "built" });
    await runWatchdogCli(["check", "--state-file", STATE_FILE, "--dry-run"], built.io);
    expect(built.stdout.some((l) => l.includes("bun run build"))).toBe(true);
  });

  test("check on an already-disarmed state is a no-op, even if health now looks unhealthy", async () => {
    const { io, calls } = fakeIo({ health: [null] });
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
    const { io } = fakeIo({ health: [HEALTHY_NEW] });
    await arm(io);
    const code = await runWatchdogCli(["status", "--state-file", STATE_FILE], io);
    expect(code).toBe(0);
  });
});
