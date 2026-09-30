import { describe, expect, test } from "bun:test";
import { classifyWindowsHostHealth, WINDOWS_HOST_HEALTH_EXIT_CODES } from "../../scripts/windows-host/health.js";

const HEALTHY_BASE = {
  herdrRunning: true,
  health: { ok: true },
};

describe("classifyWindowsHostHealth", () => {
  test("herdr not running -> herdr-down, exit 2, before /health is even consulted", () => {
    const r = classifyWindowsHostHealth({ ...HEALTHY_BASE, herdrRunning: false });
    expect(r.state).toBe("herdr-down");
    expect(r.exitCode).toBe(2);
    expect(r.headline).toContain("herdr: DOWN");
    expect(r.headline).toContain("no herdr process found");
  });

  test("herdr presence unknown -> herdr-down, never silently assumed running", () => {
    const r = classifyWindowsHostHealth({ ...HEALTHY_BASE, herdrRunning: null });
    expect(r.state).toBe("herdr-down");
    expect(r.headline).toContain("could not determine");
  });

  test("herdr up, /health unreachable -> daemon-down (unreachable treated as unhealthy, never assumed fine)", () => {
    const r = classifyWindowsHostHealth({ ...HEALTHY_BASE, health: null });
    expect(r.state).toBe("daemon-down");
    expect(r.exitCode).toBe(1);
    expect(r.headline).toContain("herdr: UP");
    expect(r.headline).toContain("daemon: DOWN");
    expect(r.headline).toContain("did not answer");
  });

  test("herdr up, /health reachable but ok:false -> daemon-down, log tail surfaced", () => {
    const r = classifyWindowsHostHealth({ ...HEALTHY_BASE, health: { ok: false }, logTail: ["line1", "line2"] });
    expect(r.state).toBe("daemon-down");
    expect(r.headline).toContain("ok: false");
    expect(r.detail).toEqual(["line1", "line2"]);
  });

  test("everything up and healthy -> healthy, exit 0", () => {
    const r = classifyWindowsHostHealth(HEALTHY_BASE);
    expect(r.state).toBe("healthy");
    expect(r.exitCode).toBe(0);
    expect(r.headline).toContain("herdr: UP");
    expect(r.headline).toContain("daemon: UP");
  });

  test("exit codes table matches what every branch above actually returns", () => {
    expect(WINDOWS_HOST_HEALTH_EXIT_CODES["herdr-down"]).toBe(2);
    expect(WINDOWS_HOST_HEALTH_EXIT_CODES["daemon-down"]).toBe(1);
    expect(WINDOWS_HOST_HEALTH_EXIT_CODES.healthy).toBe(0);
  });

  test("herdr-down headline never says daemon, daemon-down headline always says herdr: UP first", () => {
    const herdrDown = classifyWindowsHostHealth({ ...HEALTHY_BASE, herdrRunning: false });
    const daemonDown = classifyWindowsHostHealth({ ...HEALTHY_BASE, health: null });
    expect(herdrDown.headline).not.toContain("daemon");
    expect(daemonDown.headline).toContain("herdr: UP");
  });
});
