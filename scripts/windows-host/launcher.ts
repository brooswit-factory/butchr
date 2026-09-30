/**
 * FACTORY-560: the actual Scheduled Task action target on a native Windows
 * host. `install.ps1` registers a task whose action is
 * `<bun> run <repoDir>\scripts\windows-host\launcher.ts [flags]` — this
 * file, not a `.ps1`, so the same "real decisions live in a tested TS file"
 * split this story's `cli.ts` already uses applies here too, and so there
 * is exactly one language (bun/TS) doing anything beyond "register/
 * unregister a task" on this host.
 *
 * Ordering (per the zippy spike's own explicit finding, relayed on
 * FACTORY-560's own ticket): **herdr must be started BEFORE the daemon.**
 * `src/daemon/missing-rules-preflight.ts`/`legacy-preflight.ts` already
 * refuse to start when herdr doesn't answer ("Refusing to start ... Start
 * herdr and retry") — this launcher's whole job is to make that ordering
 * happen automatically instead of requiring a human to run `herdr server`
 * first by hand every logon. It does NOT poll herdr for readiness beyond a
 * fixed grace period (`--herdr-grace-seconds`, default below): if herdr
 * isn't ready in time and the daemon exits because of it, THIS PROCESS
 * exits non-zero, and the Scheduled Task's own restart-on-failure settings
 * (configured by `install.ps1`, mirroring `Register-WslHostTask.ps1`'s own
 * `-RestartCount`/`-RestartInterval`) retry the whole sequence — the same
 * "let the task's own restart policy cover a slow-starting dependency
 * rather than hand-rolling a readiness poll this workspace can't verify
 * against a real herdr anyway" reasoning `docs/windows-wsl-host.md` already
 * documents for its own keep-alive design.
 *
 * Sets `BUTCHR_WINDOWS_TASK_NAME`/`BUTCHR_WINDOWS_LOG_FILE` on the daemon's
 * own environment before spawning it — this is how
 * `src/agents/ground-truth.ts#parseWindowsTaskEnv` (FACTORY-560) knows it's
 * running under a Windows Scheduled Task at all, mirroring how a systemd
 * unit's own cgroup membership tells `parseCgroup` the same thing on Linux.
 */
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from "node:fs";
import { spawn } from "node:child_process";

export interface LauncherOptions {
  repoDir: string;
  bunBin: string;
  herdrBin: string;
  envFile: string;
  logDir: string;
  taskName: string;
  /** Seconds to wait after starting herdr before starting the daemon — see this module's own doc comment for why this is a fixed grace period, not a readiness poll. */
  herdrGraceSeconds: number;
  /** A log file is rotated (renamed to `<name>.old`, previous `.old` discarded) once it reaches this size, keeping exactly one backup generation — simple by design; see `planLogRotation`. */
  maxLogBytes: number;
}

/**
 * PURE: given a KEY=VALUE `.env`-style file's text, parse it into a plain
 * object — the Windows-host equivalent of systemd's own `EnvironmentFile=`
 * parsing, since there is no OS-native env-file mechanism to defer to here.
 * `#`-prefixed and blank lines are skipped; a value may be wrapped in
 * matching single or double quotes, stripped before returning (mirrors
 * `.env.example`'s own convention of quoting values that contain `#` or
 * spaces). A line with no `=` at all is skipped rather than thrown on — an
 * operator's stray blank line or comment-without-`#` should never crash the
 * whole launch.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** PURE: whether a log file this size needs rotating before more is appended to it. */
export function planLogRotation(currentSizeBytes: number, maxLogBytes: number): "rotate" | "keep" {
  return currentSizeBytes >= maxLogBytes ? "rotate" : "keep";
}

export interface LauncherIo {
  ensureDir: (path: string) => void;
  /** `null` when the file doesn't exist yet — never a fabricated 0, so a brand-new log is correctly never rotated. */
  fileSize: (path: string) => number | null;
  /** Renames `path` to `<path>.old`, overwriting any previous `.old` — exactly one backup generation kept, by design (see `LauncherOptions.maxLogBytes`'s own doc comment). */
  rotateFile: (path: string) => void;
  readFile: (path: string) => string | null; // null on ENOENT
  /** Starts herdr detached, with its stdout+stderr appended to `logFile`. Fire-and-forget by design — see this module's own doc comment for why readiness is a grace period, not a poll. */
  spawnHerdr: (herdrBin: string, logFile: string) => void;
  sleepSeconds: (seconds: number) => Promise<void>;
  /** Starts the daemon in the FOREGROUND (this launcher waits for it), stdout+stderr appended to `logFile`, given the fully-resolved child environment. Resolves with the daemon's own exit code — never rejects on a non-zero exit, mirroring `WslHostIo.execFile`'s own "a non-zero exit is data, not an exception" contract. */
  spawnDaemonAndWait: (bunBin: string, repoDir: string, env: NodeJS.ProcessEnv, logFile: string) => Promise<number>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export function defaultIo(): LauncherIo {
  function appendFd(path: string): number {
    return openSync(path, "a");
  }
  return {
    ensureDir(path) {
      mkdirSync(path, { recursive: true });
    },
    fileSize(path) {
      try {
        return statSync(path).size;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    rotateFile(path) {
      try {
        renameSync(path, `${path}.old`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    },
    readFile(path) {
      try {
        return existsSync(path) ? readFileSync(path, "utf8") : null;
      } catch {
        return null;
      }
    },
    spawnHerdr(herdrBin, logFile) {
      const fd = appendFd(logFile);
      const child = spawn(herdrBin, ["server"], { stdio: ["ignore", fd, fd], detached: true });
      child.unref();
    },
    sleepSeconds(seconds) {
      return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    },
    spawnDaemonAndWait(bunBin, repoDir, env, logFile) {
      const fd = appendFd(logFile);
      return new Promise((resolve) => {
        const child = spawn(bunBin, ["run", "src/daemon/index.ts"], { cwd: repoDir, env, stdio: ["ignore", fd, fd] });
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
      });
    },
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}

/** The orchestration itself — herdr first, a fixed grace period, then the daemon, foreground — kept as one small function over an injected `LauncherIo` so `test/unit/windows-host-launcher.test.ts` can prove the ORDER (herdr before the grace sleep, the grace sleep before the daemon) and the ENV (task name + log file always set on the daemon's own env, file-loaded vars merged in) without spawning anything real. */
export async function runLauncher(io: LauncherIo, opts: LauncherOptions): Promise<number> {
  io.ensureDir(opts.logDir);
  const herdrLog = `${opts.logDir}\\herdr.log`;
  const butchrLog = `${opts.logDir}\\butchr.log`;

  for (const log of [herdrLog, butchrLog]) {
    const size = io.fileSize(log);
    if (size !== null && planLogRotation(size, opts.maxLogBytes) === "rotate") io.rotateFile(log);
  }

  const envFileText = io.readFile(opts.envFile);
  const fileEnv = envFileText !== null ? parseEnvFile(envFileText) : {};

  io.stdout(`starting herdr (${opts.herdrBin} server) — log: ${herdrLog}`);
  io.spawnHerdr(opts.herdrBin, herdrLog);

  io.stdout(`waiting ${opts.herdrGraceSeconds}s for herdr before starting the daemon (see this module's own doc comment: a fixed grace period, not a readiness poll)`);
  await io.sleepSeconds(opts.herdrGraceSeconds);

  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...fileEnv,
    BUTCHR_WINDOWS_TASK_NAME: opts.taskName,
    BUTCHR_WINDOWS_LOG_FILE: butchrLog,
  };

  io.stdout(`starting butchr daemon (${opts.bunBin} run src/daemon/index.ts) — log: ${butchrLog}`);
  const exitCode = await io.spawnDaemonAndWait(opts.bunBin, opts.repoDir, daemonEnv, butchrLog);
  if (exitCode !== 0) io.stderr(`daemon exited ${exitCode} — if herdr wasn't ready in time, the scheduled task's own restart policy will retry this whole sequence`);
  return exitCode;
}

function parseArgs(argv: string[]): LauncherOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--") && argv[i + 1] !== undefined) {
      flags.set(arg.slice(2), argv[i + 1]!);
      i++;
    }
  }
  const repoDir = flags.get("repo-dir");
  if (!repoDir) throw new Error("missing required --repo-dir");
  return {
    repoDir,
    bunBin: flags.get("bun-bin") ?? "bun",
    herdrBin: flags.get("herdr-bin") ?? "herdr",
    envFile: flags.get("env-file") ?? `${process.env.APPDATA ?? ""}\\butchr\\butchr.env`,
    logDir: flags.get("log-dir") ?? `${process.env.LOCALAPPDATA ?? ""}\\butchr\\logs`,
    taskName: flags.get("task-name") ?? "Butchr-Native",
    herdrGraceSeconds: Number(flags.get("herdr-grace-seconds") ?? "5"),
    maxLogBytes: Number(flags.get("max-log-bytes") ?? String(10 * 1024 * 1024)),
  };
}

if (import.meta.main) {
  process.exit(await runLauncher(defaultIo(), parseArgs(process.argv.slice(2))));
}
