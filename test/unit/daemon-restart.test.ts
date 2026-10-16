import { describe, expect, test } from "bun:test";
import { RESTART_ARGV, isRunningUnderThisUnit, restartDaemon, type DaemonRestartDetectIo, type DaemonRestartExecIo } from "../../src/web/daemon-restart.js";

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
