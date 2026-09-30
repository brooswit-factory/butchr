import { describe, expect, test } from "bun:test";
import { parseEnvFile, planLogRotation, runLauncher, type LauncherIo, type LauncherOptions } from "../../scripts/windows-host/launcher.js";

describe("parseEnvFile", () => {
  test("plain KEY=VALUE lines", () => {
    expect(parseEnvFile("ATLASSIAN_SITE=https://example.atlassian.net\nFOO=bar\n")).toEqual({
      ATLASSIAN_SITE: "https://example.atlassian.net",
      FOO: "bar",
    });
  });

  test("comments and blank lines are skipped", () => {
    expect(parseEnvFile("# a comment\n\nFOO=bar\n  # indented comment\n")).toEqual({ FOO: "bar" });
  });

  test("quoted values (single or double) are unwrapped", () => {
    expect(parseEnvFile('FOO="bar baz"\nQUX=\'a#b\'\n')).toEqual({ FOO: "bar baz", QUX: "a#b" });
  });

  test("a line with no '=' at all is skipped, never thrown on", () => {
    expect(parseEnvFile("not a valid line\nFOO=bar\n")).toEqual({ FOO: "bar" });
  });

  test("a value may itself contain '=' — only the FIRST '=' splits key from value", () => {
    expect(parseEnvFile("FOO=a=b=c\n")).toEqual({ FOO: "a=b=c" });
  });

  test("empty file: empty object, never throws", () => {
    expect(parseEnvFile("")).toEqual({});
  });
});

describe("planLogRotation", () => {
  test("under the limit: keep", () => {
    expect(planLogRotation(100, 1000)).toBe("keep");
  });
  test("at or over the limit: rotate", () => {
    expect(planLogRotation(1000, 1000)).toBe("rotate");
    expect(planLogRotation(1001, 1000)).toBe("rotate");
  });
});

const OPTS: LauncherOptions = {
  repoDir: "C:\\butchr",
  bunBin: "bun",
  herdrBin: "herdr",
  envFile: "C:\\Users\\broos\\AppData\\Roaming\\butchr\\butchr.env",
  logDir: "C:\\Users\\broos\\AppData\\Local\\butchr\\logs",
  taskName: "Butchr-Native",
  herdrGraceSeconds: 3,
  maxLogBytes: 1000,
};

interface FakeOpts {
  fileSizes?: Map<string, number>;
  files?: Map<string, string>;
  daemonExitCode?: number;
}

function fakeIo(opts: FakeOpts = {}) {
  const events: string[] = [];
  const rotated: string[] = [];
  const dirsEnsured: string[] = [];
  const sleeps: number[] = [];
  let capturedEnv: NodeJS.ProcessEnv | null = null;

  const io: LauncherIo = {
    ensureDir(path) {
      dirsEnsured.push(path);
    },
    fileSize(path) {
      return opts.fileSizes?.get(path) ?? null;
    },
    rotateFile(path) {
      rotated.push(path);
    },
    readFile(path) {
      return opts.files?.get(path) ?? null;
    },
    spawnHerdr(herdrBin, logFile) {
      events.push(`spawnHerdr:${herdrBin}:${logFile}`);
    },
    async sleepSeconds(seconds) {
      sleeps.push(seconds);
      events.push(`sleep:${seconds}`);
    },
    async spawnDaemonAndWait(bunBin, repoDir, env, logFile) {
      capturedEnv = env;
      events.push(`spawnDaemon:${bunBin}:${repoDir}:${logFile}`);
      return opts.daemonExitCode ?? 0;
    },
    stdout: () => {},
    stderr: () => {},
  };
  return { io, events, rotated, dirsEnsured, sleeps, getEnv: () => capturedEnv };
}

describe("runLauncher", () => {
  test("order: herdr is spawned, THEN the grace sleep, THEN the daemon — never any other order", async () => {
    const { io, events } = fakeIo();
    await runLauncher(io, OPTS);
    const kinds = events.map((e) => e.split(":")[0]);
    expect(kinds).toEqual(["spawnHerdr", "sleep", "spawnDaemon"]);
  });

  test("the grace sleep uses herdrGraceSeconds verbatim", async () => {
    const { io, sleeps } = fakeIo();
    await runLauncher(io, OPTS);
    expect(sleeps).toEqual([3]);
  });

  test("ensures the log directory before anything else", async () => {
    const { io, dirsEnsured } = fakeIo();
    await runLauncher(io, OPTS);
    expect(dirsEnsured).toEqual([OPTS.logDir]);
  });

  test("the daemon's env always carries BUTCHR_WINDOWS_TASK_NAME and BUTCHR_WINDOWS_LOG_FILE", async () => {
    const { io, getEnv } = fakeIo();
    await runLauncher(io, OPTS);
    const env = getEnv()!;
    expect(env.BUTCHR_WINDOWS_TASK_NAME).toBe("Butchr-Native");
    expect(env.BUTCHR_WINDOWS_LOG_FILE).toBe(`${OPTS.logDir}\\butchr.log`);
  });

  test("env-file vars are merged into the daemon's own env", async () => {
    const { io, getEnv } = fakeIo({ files: new Map([[OPTS.envFile, "ATLASSIAN_SITE=https://example.atlassian.net\n"]]) });
    await runLauncher(io, OPTS);
    expect(getEnv()!.ATLASSIAN_SITE).toBe("https://example.atlassian.net");
  });

  test("missing env file: no crash, daemon still gets the task-name/log-file vars", async () => {
    const { io, getEnv } = fakeIo({ files: new Map() });
    await runLauncher(io, OPTS);
    expect(getEnv()!.BUTCHR_WINDOWS_TASK_NAME).toBe("Butchr-Native");
  });

  test("a log file at/over maxLogBytes is rotated before the daemon starts; one well under it is left alone", async () => {
    const herdrLog = `${OPTS.logDir}\\herdr.log`;
    const butchrLog = `${OPTS.logDir}\\butchr.log`;
    const { io, rotated } = fakeIo({ fileSizes: new Map([[herdrLog, 1000], [butchrLog, 5]]) });
    await runLauncher(io, OPTS);
    expect(rotated).toEqual([herdrLog]);
  });

  test("a brand-new log (no existing file) is never rotated", async () => {
    const { io, rotated } = fakeIo({ fileSizes: new Map() });
    await runLauncher(io, OPTS);
    expect(rotated).toEqual([]);
  });

  test("the daemon's own exit code is returned verbatim", async () => {
    const { io } = fakeIo({ daemonExitCode: 7 });
    expect(await runLauncher(io, OPTS)).toBe(7);
  });
});
