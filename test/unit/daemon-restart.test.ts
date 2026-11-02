import { describe, expect, test } from "bun:test";
import { RESTART_ARGV, isRunningUnderThisUnit, launchdJobForThisProcess, launchdRestartArgv, restartDaemon, type DaemonRestartDetectIo, type DaemonRestartExecIo } from "../../src/web/daemon-restart.js";

describe("isRunningUnderThisUnit", () => {
  test("no INVOCATION_ID at all: false, never calls systemctl", async () => {
    let mainPidCalled = false;
    const io: DaemonRestartDetectIo = {
      invocationId: () => undefined,
      mainPid: async () => { mainPidCalled = true; return 123; },
      ownPid: () => 123,
    };
    expect(await isRunningUnderThisUnit(io)).toBe(false);
    expect(mainPidCalled).toBe(false);
  });

  test("INVOCATION_ID set, systemctl reports a DIFFERENT pid: false", async () => {
    const io: DaemonRestartDetectIo = { invocationId: () => "abc", mainPid: async () => 999, ownPid: () => 123 };
    expect(await isRunningUnderThisUnit(io)).toBe(false);
  });

  test("INVOCATION_ID set, systemctl reports THIS pid: true", async () => {
    const io: DaemonRestartDetectIo = { invocationId: () => "abc", mainPid: async () => 123, ownPid: () => 123 };
    expect(await isRunningUnderThisUnit(io)).toBe(true);
  });

  test("INVOCATION_ID set, systemctl call fails (undefined): false", async () => {
    const io: DaemonRestartDetectIo = { invocationId: () => "abc", mainPid: async () => undefined, ownPid: () => 123 };
    expect(await isRunningUnderThisUnit(io)).toBe(false);
  });
});

describe("restartDaemon", () => {
  test("not under systemd: 409 refusal, spawn never called", async () => {
    const detectIo: DaemonRestartDetectIo = { invocationId: () => undefined, mainPid: async () => undefined, ownPid: () => 123 };
    let spawnedArgv: readonly string[] | undefined;
    const execIo: DaemonRestartExecIo = { spawn: (argv) => { spawnedArgv = argv; } };
    const outcome = await restartDaemon(detectIo, execIo);
    expect(outcome).toEqual({ ok: false, status: 409, error: "restart butchr manually" });
    expect(spawnedArgv).toBeUndefined();
  });

  test("under systemd: ok, spawns the EXACT fixed argv, no interpolation", async () => {
    const detectIo: DaemonRestartDetectIo = { invocationId: () => "abc", mainPid: async () => 123, ownPid: () => 123 };
    let spawnedArgv: readonly string[] | undefined;
    const execIo: DaemonRestartExecIo = { spawn: (argv) => { spawnedArgv = argv; } };
    const outcome = await restartDaemon(detectIo, execIo);
    expect(outcome).toEqual({ ok: true });
    expect(spawnedArgv).toEqual(["systemctl", "--user", "restart", "butchr.service"]);
    expect(spawnedArgv).toEqual(RESTART_ARGV as unknown as readonly string[]);
  });
});

// local/ui — restart under launchd.
describe("launchdJobForThisProcess / restartDaemon under launchd", () => {
  const PRINTED = "gui/501/com.example.butchr = {\n\tactive count = 1\n\tstate = running\n\tstdout path = /Users/b/Library/Logs/butchr.log\n\tstderr path = /Users/b/Library/Logs/butchr.log\n\tpid = 4242\n\tendpoints = {\n\t\tpid = 9\n\t}\n}\n";
  const launchdIo = (overrides: Partial<DaemonRestartDetectIo> = {}): DaemonRestartDetectIo => ({
    invocationId: () => undefined,
    mainPid: async () => undefined,
    ownPid: () => 4242,
    launchdLabel: () => "com.example.butchr",
    uid: () => 501,
    launchctlPrint: async (target) => (target === "gui/501/com.example.butchr" ? PRINTED : undefined),
    ...overrides,
  });

  test("a matching top-level pid proves the job is this process", async () => {
    expect(await launchdJobForThisProcess(launchdIo())).toEqual({ label: "com.example.butchr", target: "gui/501/com.example.butchr", stderrPath: "/Users/b/Library/Logs/butchr.log" });
  });

  test("a different pid, a Terminal-style label, a malformed label, or a failed launchctl is not a launchd job", async () => {
    expect(await launchdJobForThisProcess(launchdIo({ ownPid: () => 9 }))).toBeUndefined();
    expect(await launchdJobForThisProcess(launchdIo({ launchdLabel: () => "0" }))).toBeUndefined();
    let printed = false;
    expect(await launchdJobForThisProcess(launchdIo({ launchdLabel: () => "bad label/../x", launchctlPrint: async () => { printed = true; return PRINTED; } }))).toBeUndefined();
    expect(printed).toBe(false);
    expect(await launchdJobForThisProcess(launchdIo({ launchctlPrint: async () => undefined }))).toBeUndefined();
    expect(await launchdJobForThisProcess(launchdIo({ uid: () => undefined }))).toBeUndefined();
  });

  test("under launchd: ok, the EXACT kickstart argv, through the detached spawn", async () => {
    let detached: readonly string[] | undefined;
    let plain: readonly string[] | undefined;
    const execIo: DaemonRestartExecIo = { spawn: (argv) => { plain = argv; }, spawnDetachedSoon: (argv) => { detached = argv; } };
    expect(await restartDaemon(launchdIo(), execIo)).toEqual({ ok: true });
    expect(detached).toEqual(["launchctl", "kickstart", "-k", "gui/501/com.example.butchr"]);
    expect(launchdRestartArgv({ label: "x", target: "gui/1/x", stderrPath: null })).toEqual(["launchctl", "kickstart", "-k", "gui/1/x"]);
    expect(plain).toBeUndefined();
  });

  test("systemd still wins when both are present; neither gives the 409", async () => {
    let spawned: readonly string[] | undefined;
    const execIo: DaemonRestartExecIo = { spawn: (argv) => { spawned = argv; }, spawnDetachedSoon: () => { throw new Error("not this one"); } };
    expect(await restartDaemon(launchdIo({ invocationId: () => "abc", mainPid: async () => 4242 }), execIo)).toEqual({ ok: true });
    expect(spawned).toEqual(RESTART_ARGV as unknown as readonly string[]);
    expect(await restartDaemon(launchdIo({ ownPid: () => 1 }), execIo)).toEqual({ ok: false, status: 409, error: "restart butchr manually" });
  });
});
