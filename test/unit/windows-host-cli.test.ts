import { describe, expect, test } from "bun:test";
import { runWindowsHostCli, type WindowsHostIo, type ExecResult } from "../../scripts/windows-host/cli.js";

interface FakeIoOpts {
  commands?: Set<string>;
  execResults?: Map<string, ExecResult>;
  files?: Map<string, string>;
  dirs?: Set<string>;
  health?: { ok: boolean } | null;
}

function fakeIo(opts: FakeIoOpts = {}) {
  const files = new Map(opts.files ?? []);
  const dirs = new Set(opts.dirs ?? []);
  const execCalls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];

  const io: WindowsHostIo = {
    commandExists(cmd) {
      return (opts.commands ?? new Set()).has(cmd);
    },
    execFile(cmd, args) {
      const key = [cmd, ...args].join(" ");
      execCalls.push(key);
      return opts.execResults?.get(key) ?? { code: 0, stdout: "", stderr: "" };
    },
    readFile(path) {
      return files.has(path) ? files.get(path)! : null;
    },
    writeFile(path, contents) {
      files.set(path, contents);
    },
    fileExists(path) {
      return files.has(path) || dirs.has(path);
    },
    mkdir(path) {
      dirs.add(path);
    },
    appDataDir: () => "C:\\Users\\broos\\AppData\\Roaming",
    localAppDataDir: () => "C:\\Users\\broos\\AppData\\Local",
    async fetchHealth() {
      return opts.health ?? null;
    },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  return { io, files, dirs, execCalls, stdout, stderr };
}

describe("windows-host CLI: install", () => {
  test("fresh host: creates the log dir and an empty env file, reports herdr as a next-step", async () => {
    const { io, files, dirs, stdout } = fakeIo();
    const code = await runWindowsHostCli(["install"], io);
    expect(code).toBe(0);
    expect(dirs.has("C:\\Users\\broos\\AppData\\Local\\butchr\\logs")).toBe(true);
    expect(files.has("C:\\Users\\broos\\AppData\\Roaming\\butchr\\butchr.env")).toBe(true);
    expect(stdout.some((l) => l.includes("[next-step] prereq: herdr"))).toBe(true);
  });

  test("herdr already on PATH: reported ok, not a next-step", async () => {
    const { io, stdout } = fakeIo({ commands: new Set(["herdr"]) });
    const code = await runWindowsHostCli(["install"], io);
    expect(code).toBe(0);
    expect(stdout.some((l) => l.startsWith("[ok] prereq: herdr"))).toBe(true);
  });

  test("re-running on an already-installed host: log dir and env file both reported skipped, env file untouched", async () => {
    const seeded = fakeIo({ commands: new Set(["herdr"]) });
    await runWindowsHostCli(["install"], seeded.io);

    const secondFiles = new Map(seeded.files);
    secondFiles.set("C:\\Users\\broos\\AppData\\Roaming\\butchr\\butchr.env", "ATLASSIAN_SITE=https://real.example\n");
    const { io, files, dirs, stdout } = fakeIo({ commands: new Set(["herdr"]), files: secondFiles, dirs: seeded.dirs });

    const code = await runWindowsHostCli(["install"], io);
    expect(code).toBe(0);
    expect(stdout.some((l) => l.startsWith("[skipped] log dir"))).toBe(true);
    expect(stdout.some((l) => l.startsWith("[skipped] env file"))).toBe(true);
    expect(files.get("C:\\Users\\broos\\AppData\\Roaming\\butchr\\butchr.env")).toBe("ATLASSIAN_SITE=https://real.example\n");
    expect(dirs.has("C:\\Users\\broos\\AppData\\Local\\butchr\\logs")).toBe(true);
  });

  test("--dry-run makes no writes at all", async () => {
    const { io, files, dirs } = fakeIo({ commands: new Set(["herdr"]) });
    const code = await runWindowsHostCli(["install", "--dry-run"], io);
    expect(code).toBe(0);
    expect(files.size).toBe(0);
    expect(dirs.size).toBe(0);
  });

  test("--env-file and --log-dir override the computed defaults", async () => {
    const { io, files, dirs } = fakeIo({ commands: new Set(["herdr"]) });
    const code = await runWindowsHostCli(["install", "--env-file", "D:\\custom\\butchr.env", "--log-dir", "D:\\custom\\logs"], io);
    expect(code).toBe(0);
    expect(files.has("D:\\custom\\butchr.env")).toBe(true);
    expect(dirs.has("D:\\custom\\logs")).toBe(true);
  });
});

describe("windows-host CLI: verify", () => {
  test("herdr process not found -> herdr-down, exit 2, /health never even fetched", async () => {
    let healthCalled = false;
    const base = fakeIo({ execResults: new Map([["tasklist /FI IMAGENAME eq herdr.exe /NH", { code: 0, stdout: "INFO: No tasks are running which match the specified criteria.\n", stderr: "" }]]) });
    const io: WindowsHostIo = { ...base.io, fetchHealth: async () => { healthCalled = true; return { ok: true }; } };
    const code = await runWindowsHostCli(["verify"], io);
    expect(code).toBe(2);
    expect(healthCalled).toBe(false);
    expect(base.stdout[0]).toContain("herdr: DOWN");
  });

  test("tasklist itself fails (couldn't run it) -> herdr-down, never a silent 'assume running'", async () => {
    const { io, stdout } = fakeIo({ execResults: new Map([["tasklist /FI IMAGENAME eq herdr.exe /NH", { code: 1, stdout: "", stderr: "access denied" }]]) });
    const code = await runWindowsHostCli(["verify"], io);
    expect(code).toBe(2);
    expect(stdout[0]).toContain("could not determine");
  });

  test("herdr running, /health ok -> healthy, exit 0", async () => {
    const { io } = fakeIo({
      execResults: new Map([["tasklist /FI IMAGENAME eq herdr.exe /NH", { code: 0, stdout: "herdr.exe                     4242 Console                    1     12,345 K\n", stderr: "" }]]),
      health: { ok: true },
    });
    const code = await runWindowsHostCli(["verify"], io);
    expect(code).toBe(0);
  });

  test("herdr running, /health unreachable -> daemon-down, log tail printed when a log file exists", async () => {
    const { io, stdout } = fakeIo({
      execResults: new Map([["tasklist /FI IMAGENAME eq herdr.exe /NH", { code: 0, stdout: "herdr.exe 4242\n", stderr: "" }]]),
      health: null,
      files: new Map([["C:\\Users\\broos\\AppData\\Local\\butchr\\logs\\butchr.log", "line one\nline two\nline three\n"]]),
    });
    const code = await runWindowsHostCli(["verify"], io);
    expect(code).toBe(1);
    expect(stdout.some((l) => l.includes("line three"))).toBe(true);
  });

  test("--port, --herdr-process-name and --log-file are honoured", async () => {
    const { io, execCalls } = fakeIo({
      execResults: new Map([["tasklist /FI IMAGENAME eq custom-herdr.exe /NH", { code: 0, stdout: "custom-herdr.exe 1\n", stderr: "" }]]),
      health: { ok: true },
    });
    const code = await runWindowsHostCli(["verify", "--herdr-process-name", "custom-herdr.exe", "--port", "9999", "--log-file", "D:\\x\\butchr.log"], io);
    expect(code).toBe(0);
    expect(execCalls).toContain("tasklist /FI IMAGENAME eq custom-herdr.exe /NH");
  });
});
