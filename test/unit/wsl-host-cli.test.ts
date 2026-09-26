import { describe, expect, test } from "bun:test";
import { runWslHostCli, type WslHostIo, type ExecResult } from "../../scripts/wsl-host/cli.js";

interface FakeIoOpts {
  commands?: Set<string>; // which `command -v` checks succeed
  execResults?: Map<string, ExecResult>; // "cmd arg1 arg2" -> result
  files?: Map<string, string>;
  health?: { ok: boolean } | null;
  /** Paths whose `writeFile` call throws (simulating EACCES on a root-owned path) instead of succeeding. */
  writeFileThrows?: Set<string>;
  bunExecPath?: string;
}

function fakeIo(opts: FakeIoOpts = {}) {
  const files = new Map(opts.files ?? []);
  const chmods: Array<[string, number]> = [];
  const copies: Array<[string, string]> = [];
  const execCalls: string[] = [];
  const stdinInputs: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];

  const io: WslHostIo = {
    commandExists(cmd) {
      return (opts.commands ?? new Set()).has(cmd);
    },
    execFile(cmd, args, input) {
      const key = [cmd, ...args].join(" ");
      execCalls.push(key);
      const result = opts.execResults?.get(key) ?? { code: 0, stdout: "", stderr: "" };
      if (input !== undefined) {
        stdinInputs.push(input);
        if (result.code === 0 && cmd === "sudo" && args[0] === "tee" && typeof args[1] === "string") files.set(args[1], input);
      }
      return result;
    },
    readFile(path) {
      return files.has(path) ? files.get(path)! : null;
    },
    writeFile(path, contents) {
      if (opts.writeFileThrows?.has(path)) throw new Error(`EACCES: permission denied, open '${path}'`);
      files.set(path, contents);
    },
    fileExists(path) {
      return files.has(path);
    },
    chmod(path, mode) {
      chmods.push([path, mode]);
    },
    copyFile(from, to) {
      copies.push([from, to]);
      files.set(to, files.get(from) ?? "(binary)");
    },
    whoami: () => "broos",
    homeDir: () => "/home/broos",
    bunExecPath: () => opts.bunExecPath ?? "/fake/.bun/bin/bun",
    async fetchHealth() {
      return opts.health ?? null;
    },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  return { io, files, chmods, copies, execCalls, stdinInputs, stdout, stderr };
}

describe("wsl-host CLI: install", () => {
  test("missing --repo-dir is a usage error (exit 2), nothing touched", async () => {
    const { io, files } = fakeIo();
    const code = await runWslHostCli(["install"], io);
    expect(code).toBe(2);
    expect(files.size).toBe(0);
  });

  test("fresh host: writes wsl.conf, both units, the LimitNOFILE drop-in, creates both env files, enables linger, reports herdr as a next-step", async () => {
    const { io, files, stdout } = fakeIo({ commands: new Set(["bun", "git", "claude", "codex"]) });
    const code = await runWslHostCli(["install", "--repo-dir", "/home/broos/butchr", "--default-user", "broos"], io);
    expect(code).toBe(0);
    expect(files.get("/etc/wsl.conf")).toContain("systemd=true");
    expect(files.has("/home/broos/.config/systemd/user/butchr.service")).toBe(true);
    expect(files.has("/home/broos/.config/systemd/user/herdr.service")).toBe(true);
    expect(files.has("/home/broos/.config/systemd/user/herdr.service.d/limit-nofile.conf")).toBe(true);
    expect(files.has("/home/broos/.config/butchr/butchr.env")).toBe(true);
    expect(files.has("/home/broos/.config/butchr/managed-sessions.env")).toBe(true);
    expect(stdout.some((l) => l.includes("[next-step] herdr binary"))).toBe(true);
  });

  test("herdr binary: --herdr-bin copies it into place and chmods +x", async () => {
    const { io, files, chmods } = fakeIo({
      commands: new Set(["bun", "git", "claude", "codex"]),
      files: new Map([["/tmp/herdr-linux-x64", "(elf)"]]),
    });
    const code = await runWslHostCli(["install", "--repo-dir", "/home/broos/butchr", "--herdr-bin", "/tmp/herdr-linux-x64"], io);
    expect(code).toBe(0);
    expect(files.get("/home/broos/.local/bin/herdr")).toBe("(elf)");
    expect(chmods).toContainEqual(["/home/broos/.local/bin/herdr", 0o755]);
  });

  test("missing --herdr-bin path is an error, does not crash the whole run", async () => {
    const { io } = fakeIo({ commands: new Set(["bun", "git", "claude", "codex"]) });
    const code = await runWslHostCli(["install", "--repo-dir", "/home/broos/butchr", "--herdr-bin", "/does/not/exist"], io);
    expect(code).toBe(1); // an "error" step makes cmdInstall report a non-zero exit
  });

  test("re-running on an already-installed host: wsl.conf, units, and env files are all reported skipped — no duplicate writes, no destroyed env files", async () => {
    const commands = new Set(["bun", "git", "claude", "codex"]);
    const first = fakeIo({ commands, files: new Map([["/tmp/herdr", "(elf)"]]) });
    const firstCode = await runWslHostCli(["install", "--repo-dir", "/home/broos/butchr", "--default-user", "broos", "--herdr-bin", "/tmp/herdr"], first.io);
    expect(firstCode).toBe(0);

    // Seed a second run's env file with real (operator-filled) content to prove it survives untouched.
    const secondFiles = new Map(first.files);
    secondFiles.set("/home/broos/.config/butchr/butchr.env", "ATLASSIAN_SITE=https://real.example\n");
    const second = fakeIo({ commands, files: secondFiles });

    const code = await runWslHostCli(["install", "--repo-dir", "/home/broos/butchr", "--default-user", "broos", "--herdr-bin", "/tmp/herdr"], second.io);
    expect(code).toBe(0);
    expect(second.stdout.some((l) => l.startsWith("[skipped] wsl.conf"))).toBe(true);
    expect(second.stdout.some((l) => l.startsWith("[skipped] env file /home/broos/.config/butchr/butchr.env"))).toBe(true);
    expect(second.stdout.some((l) => l.startsWith("[skipped] unit: butchr.service"))).toBe(true);
    expect(second.files.get("/home/broos/.config/butchr/butchr.env")).toBe("ATLASSIAN_SITE=https://real.example\n");
  });

  test("--dry-run makes no writes at all", async () => {
    const { io, files } = fakeIo({ commands: new Set(["bun", "git", "claude", "codex"]) });
    const code = await runWslHostCli(["install", "--repo-dir", "/home/broos/butchr", "--dry-run"], io);
    expect(code).toBe(0);
    expect(files.size).toBe(0);
  });

  test("missing prerequisite (claude not found) is reported as next-step, never fails the run", async () => {
    const { io, stdout } = fakeIo({ commands: new Set(["bun", "git", "codex"]) });
    const code = await runWslHostCli(["install", "--repo-dir", "/home/broos/butchr"], io);
    expect(code).toBe(0);
    expect(stdout.some((l) => l.includes("[next-step] prereq: claude"))).toBe(true);
  });

  test("default invocation (no --bun-bin) renders an ABSOLUTE ExecStart, never a bare 'bun' a systemd unit would refuse to start", async () => {
    const { io, files } = fakeIo({ commands: new Set(["bun", "git", "claude", "codex"]), bunExecPath: "/home/broos/.bun/bin/bun" });
    const code = await runWslHostCli(["install", "--repo-dir", "/home/broos/butchr"], io);
    expect(code).toBe(0);
    const unit = files.get("/home/broos/.config/systemd/user/butchr.service")!;
    expect(unit).toContain("ExecStart=/home/broos/.bun/bin/bun run src/daemon/index.ts");
    expect(unit).not.toContain("ExecStart=bun ");
  });

  test("an explicit --bun-bin overrides the resolved default", async () => {
    const { io, files } = fakeIo({ commands: new Set(["bun", "git", "claude", "codex"]), bunExecPath: "/home/broos/.bun/bin/bun" });
    const code = await runWslHostCli(["install", "--repo-dir", "/home/broos/butchr", "--bun-bin", "/opt/custom/bun"], io);
    expect(code).toBe(0);
    expect(files.get("/home/broos/.config/systemd/user/butchr.service")).toContain("ExecStart=/opt/custom/bun run src/daemon/index.ts");
  });

  test("/etc/wsl.conf: a direct write refused (EACCES) falls back to `sudo tee` and still succeeds, run continues to completion", async () => {
    const { io, files, execCalls, stdout } = fakeIo({
      commands: new Set(["bun", "git", "claude", "codex"]),
      writeFileThrows: new Set(["/etc/wsl.conf"]),
    });
    const code = await runWslHostCli(["install", "--repo-dir", "/home/broos/butchr"], io);
    expect(code).toBe(0);
    expect(execCalls).toContain("sudo tee /etc/wsl.conf");
    expect(files.get("/etc/wsl.conf")).toContain("systemd=true");
    expect(stdout.some((l) => l.startsWith("[ok] wsl.conf") && l.includes("sudo tee"))).toBe(true);
    // the run didn't die halfway — steps after wsl.conf still ran.
    expect(files.has("/home/broos/.config/systemd/user/butchr.service")).toBe(true);
  });

  test("/etc/wsl.conf: direct write AND sudo tee both fail -> next-step (not a crash), run still continues to completion", async () => {
    const { io, files, stdout } = fakeIo({
      commands: new Set(["bun", "git", "claude", "codex"]),
      writeFileThrows: new Set(["/etc/wsl.conf"]),
      execResults: new Map([["sudo tee /etc/wsl.conf", { code: 1, stdout: "", stderr: "sudo: a password is required" }]]),
    });
    const code = await runWslHostCli(["install", "--repo-dir", "/home/broos/butchr"], io);
    expect(code).toBe(0); // a next-step, not an "error" — never crashes the whole run
    expect(files.has("/etc/wsl.conf")).toBe(false);
    expect(stdout.some((l) => l.startsWith("[next-step] wsl.conf") && l.includes("sudo tee") && l.includes("also failed"))).toBe(true);
    expect(files.has("/home/broos/.config/systemd/user/butchr.service")).toBe(true);
  });
});

describe("wsl-host CLI: verify", () => {
  test("systemd not running inside the distro -> daemon-down, exit 1", async () => {
    const { io } = fakeIo({
      commands: new Set(),
      execResults: new Map([["systemctl --user is-system-running", { code: 1, stdout: "", stderr: "" }]]),
    });
    const code = await runWslHostCli(["verify"], io);
    expect(code).toBe(1);
  });

  test("unit inactive -> daemon-down, journal tail fetched and printed", async () => {
    const { io, stdout } = fakeIo({
      execResults: new Map([
        ["systemctl --user is-system-running", { code: 0, stdout: "running\n", stderr: "" }],
        ["systemctl --user is-active butchr.service", { code: 3, stdout: "inactive\n", stderr: "" }],
        ["journalctl --user -u butchr.service -n 20 --no-pager", { code: 0, stdout: "Sep 26 crash: missing ATLASSIAN_SITE\n", stderr: "" }],
      ]),
    });
    const code = await runWslHostCli(["verify"], io);
    expect(code).toBe(1);
    expect(stdout.some((l) => l.includes("missing ATLASSIAN_SITE"))).toBe(true);
  });

  test("unit active and /health ok -> healthy, exit 0", async () => {
    const { io } = fakeIo({
      execResults: new Map([
        ["systemctl --user is-system-running", { code: 0, stdout: "running\n", stderr: "" }],
        ["systemctl --user is-active butchr.service", { code: 0, stdout: "active\n", stderr: "" }],
      ]),
      health: { ok: true },
    });
    const code = await runWslHostCli(["verify"], io);
    expect(code).toBe(0);
  });

  test("--port and --unit flags are honoured", async () => {
    const calls: string[] = [];
    const { io } = fakeIo({
      execResults: new Map([
        ["systemctl --user is-system-running", { code: 0, stdout: "running\n", stderr: "" }],
        ["systemctl --user is-active custom.service", { code: 0, stdout: "active\n", stderr: "" }],
      ]),
      health: { ok: true },
    });
    const wrapped: WslHostIo = { ...io, execFile: (cmd, args, input) => { calls.push([cmd, ...args].join(" ")); return io.execFile(cmd, args, input); } };
    const code = await runWslHostCli(["verify", "--unit", "custom.service"], wrapped);
    expect(code).toBe(0);
    expect(calls).toContain("systemctl --user is-active custom.service");
  });
});
