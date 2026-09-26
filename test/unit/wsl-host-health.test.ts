import { describe, expect, test } from "bun:test";
import { classifyWslHealth, WSL_HEALTH_EXIT_CODES } from "../../scripts/wsl-host/health.js";

const HEALTHY_BASE = {
  distroInstalled: true,
  distroRunning: true,
  systemdActive: true,
  daemonUnitActive: true,
  health: { ok: true },
};

describe("classifyWslHealth", () => {
  test("distro not installed -> wsl-down, exit 2, before anything else is even consulted", () => {
    const r = classifyWslHealth({ ...HEALTHY_BASE, distroInstalled: false });
    expect(r.state).toBe("wsl-down");
    expect(r.exitCode).toBe(2);
    expect(r.headline).toContain("WSL: DOWN");
    expect(r.headline).toContain("not installed");
  });

  test("distro installed but not running -> wsl-down, exit 2", () => {
    const r = classifyWslHealth({ ...HEALTHY_BASE, distroRunning: false });
    expect(r.state).toBe("wsl-down");
    expect(r.exitCode).toBe(2);
    expect(r.headline).toContain("not running");
  });

  test("WSL up, systemd not active -> daemon-down, exit 1, headline distinguishes from wsl-down", () => {
    const r = classifyWslHealth({ ...HEALTHY_BASE, systemdActive: false });
    expect(r.state).toBe("daemon-down");
    expect(r.exitCode).toBe(1);
    expect(r.headline).toContain("WSL: UP");
    expect(r.headline).toContain("daemon: DOWN");
    expect(r.headline).not.toContain("WSL: DOWN");
  });

  test("WSL up, systemd state unknown (exec into distro failed) -> daemon-down, not silently healthy", () => {
    const r = classifyWslHealth({ ...HEALTHY_BASE, systemdActive: null });
    expect(r.state).toBe("daemon-down");
    expect(r.headline).toContain("could not determine");
  });

  test("systemd active, unit not active -> daemon-down, journal tail surfaced", () => {
    const r = classifyWslHealth({ ...HEALTHY_BASE, daemonUnitActive: false, journalTail: ["line1", "line2"] });
    expect(r.state).toBe("daemon-down");
    expect(r.headline).toContain("not active");
    expect(r.detail).toEqual(["line1", "line2"]);
  });

  test("unit active but /health unreachable -> daemon-down (unreachable treated as unhealthy, never assumed fine)", () => {
    const r = classifyWslHealth({ ...HEALTHY_BASE, health: null });
    expect(r.state).toBe("daemon-down");
    expect(r.headline).toContain("did not answer");
  });

  test("unit active, /health reachable but ok:false -> daemon-down", () => {
    const r = classifyWslHealth({ ...HEALTHY_BASE, health: { ok: false } });
    expect(r.state).toBe("daemon-down");
    expect(r.headline).toContain("ok: false");
  });

  test("everything up and healthy -> healthy, exit 0", () => {
    const r = classifyWslHealth(HEALTHY_BASE);
    expect(r.state).toBe("healthy");
    expect(r.exitCode).toBe(0);
    expect(r.headline).toContain("WSL: UP");
    expect(r.headline).toContain("daemon: UP");
  });

  test("exit codes table matches what every branch above actually returns", () => {
    expect(WSL_HEALTH_EXIT_CODES["wsl-down"]).toBe(2);
    expect(WSL_HEALTH_EXIT_CODES["daemon-down"]).toBe(1);
    expect(WSL_HEALTH_EXIT_CODES.healthy).toBe(0);
  });

  test("(a) vs (b) is unmistakable: wsl-down headline never says daemon, daemon-down headline never says just DOWN alone", () => {
    const wslDown = classifyWslHealth({ ...HEALTHY_BASE, distroRunning: false });
    const daemonDown = classifyWslHealth({ ...HEALTHY_BASE, daemonUnitActive: false });
    expect(wslDown.headline).not.toContain("daemon");
    expect(daemonDown.headline).toContain("WSL: UP");
  });
});
