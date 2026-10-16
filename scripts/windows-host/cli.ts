/**
 * FACTORY-560: the native-Windows-host install/verify CLI — the actual
 * decision-making behind `scripts/windows-host/install.ps1` (a thin
 * bootstrap that execs into this file once `bun` is confirmed present, see
 * that script's own header comment) and `verify.ps1`. Follows this repo's
 * `scripts/wsl-host/cli.ts` precedent (itself following
 * `scripts/deploy/watchdog.ts`): every real side effect (exec, file
 * read/write, the clock, a network fetch) is reached through one injected
 * `WindowsHostIo` object, `defaultIo()` is the only place any of it is real,
 * so `test/unit/windows-host-cli.test.ts` can prove ordering and idempotency
 * under plain `bun test` — no real Windows host, no real herdr, no real
 * Task Scheduler anywhere in sight.
 *
 * Unlike the WSL host, there is no cross-boundary `wsl.exe` exec here at
 * all — this CLI runs directly ON the Windows host it's checking, so
 * `verify`'s `/health` fetch talks straight to `127.0.0.1`, and `install`'s
 * checks run directly against this machine's own PATH and filesystem.
 *
 * What lives HERE (testable): prerequisite checks, the env file, the log
 * directory, and `verify`'s herdr/health classification (delegated to
 * `./health.ts#classifyWindowsHostHealth`, never a second reimplementation).
 * What does NOT live here: registering/unregistering the Scheduled Task
 * itself. `Register-ScheduledTask`/`Unregister-ScheduledTask` are
 * PowerShell-only cmdlets (no standalone Windows executable), so that step
 * stays in real, untested PowerShell in `install.ps1`/`uninstall.ps1` —
 * the same "the one thing that genuinely cannot be exercised off-Windows
 * stays in real PowerShell, everything else lives in a tested CLI" split
 * `docs/windows-wsl-host.md` documents for `Register-WslHostTask.ps1`.
 *
 * Two subcommands:
 *   install — checks/reports the `herdr` prerequisite (never auto-installed;
 *             this repo doesn't vendor it, same story as the WSL path),
 *             creates the log directory, and creates (never overwrites) the
 *             env file empty. `install.ps1` runs this FIRST, then registers
 *             the Scheduled Task itself.
 *   verify  — checks whether a `herdr` process is running (via `tasklist`)
 *             and whether `/health` answers, classifies the result with
 *             `classifyWindowsHostHealth`, and on a "daemon-down" verdict
 *             tails the daemon's own rotating log file (there is no
 *             journalctl on Windows — this log file is the only record).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { classifyWindowsHostHealth, type WindowsHostHealthResult } from "./health.js";

export type StepStatus = "ok" | "skipped" | "next-step" | "error";

export interface StepResult {
  name: string;
  status: StepStatus;
  message: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WindowsHostIo {
  commandExists: (cmd: string) => boolean;
  /** Synchronous — never throws; a non-zero exit is a normal `ExecResult`, not an exception. Used for `tasklist` in `verify`. */
  execFile: (cmd: string, args: string[]) => ExecResult;
  readFile: (path: string) => string | null; // null on ENOENT
  writeFile: (path: string, contents: string) => void;
  fileExists: (path: string) => boolean;
  mkdir: (path: string) => void;
  /** `%APPDATA%` (roaming) — where `butchr.env` lives by default, mirroring the ticket's own `%APPDATA%\butchr\butchr.env`. */
  appDataDir: () => string;
  /** `%LOCALAPPDATA%` — where rotating logs live by default, mirroring the ticket's own `%LOCALAPPDATA%\butchr\logs`. */
  localAppDataDir: () => string;
  fetchHealth: (port: number) => Promise<{ ok: boolean } | null>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const HEALTH_FETCH_TIMEOUT_MS = 5_000;
const LOG_TAIL_LINES = 40;

export function defaultIo(): WindowsHostIo {
  function run(cmd: string, args: string[]): ExecResult {
    try {
      const stdout = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, stdout, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e) };
    }
  }

  return {
    commandExists(cmd) {
      return run("where", [cmd]).code === 0;
    },
    execFile: run,
    readFile(path) {
      try {
        return readFileSync(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    writeFile(path, contents) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    },
    fileExists(path) {
      return existsSync(path);
    },
    mkdir(path) {
      mkdirSync(path, { recursive: true });
    },
    appDataDir: () => process.env.APPDATA ?? "",
    localAppDataDir: () => process.env.LOCALAPPDATA ?? "",
    async fetchHealth(port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS) });
        if (!res.ok) return null;
        const body = (await res.json()) as unknown;
        if (typeof body !== "object" || body === null || typeof (body as { ok?: unknown }).ok !== "boolean") return null;
        return body as { ok: boolean };
      } catch {
        return null;
      }
    },
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}

export interface InstallOptions {
  envFile: string;
  logDir: string;
  dryRun: boolean;
}

function stepHerdrPrereq(io: WindowsHostIo): StepResult {
  if (io.commandExists("herdr")) {
    return { name: "prereq: herdr", status: "ok", message: "found on PATH" };
  }
  return {
    name: "prereq: herdr",
    status: "next-step",
    message: "herdr not found on PATH — this repo does not vendor or build herdr. Install it and make sure it's on PATH before running the scheduled task (see https://herdr.dev, this repo's own README.md).",
  };
}

function stepEnvFile(io: WindowsHostIo, path: string, dryRun: boolean): StepResult {
  if (io.fileExists(path)) return { name: `env file ${path}`, status: "skipped", message: "already exists — never overwritten (may hold real credentials)" };
  if (dryRun) return { name: `env file ${path}`, status: "next-step", message: `would create empty ${path} (skipped: --dry-run)` };
  io.writeFile(path, "# butchr.env — secrets for the Windows scheduled task (ATLASSIAN_SITE / ATLASSIAN_EMAIL / ATLASSIAN_TOKEN_FILE, etc). Never printed, never committed. See docs/windows-native-host.md.\n");
  return { name: `env file ${path}`, status: "next-step", message: `created empty ${path} — fill in the required variables before starting the daemon. Restrict its NTFS permissions to your own account (unlike a Unix 0600 chmod, this script does not set an ACL for you)` };
}

function stepLogDir(io: WindowsHostIo, path: string, dryRun: boolean): StepResult {
  if (io.fileExists(path)) return { name: `log dir ${path}`, status: "skipped", message: "already exists" };
  if (dryRun) return { name: `log dir ${path}`, status: "next-step", message: `would create ${path} (skipped: --dry-run)` };
  io.mkdir(path);
  return { name: `log dir ${path}`, status: "ok", message: `created ${path}` };
}

export function cmdInstall(io: WindowsHostIo, opts: InstallOptions): { results: StepResult[]; exitCode: number } {
  const results: StepResult[] = [stepHerdrPrereq(io), stepLogDir(io, opts.logDir, opts.dryRun), stepEnvFile(io, opts.envFile, opts.dryRun)];
  const hasError = results.some((r) => r.status === "error");
  return { results, exitCode: hasError ? 1 : 0 };
}

/** `tasklist /FI "IMAGENAME eq <name>" /NH` — a missing image name prints `INFO: No tasks are running which match the specified criteria.`, never a non-zero exit; a real match prints a row starting with the image name. `null` (never a guessed `false`) when `tasklist` itself could not be run at all. */
function isHerdrRunning(io: WindowsHostIo, processName: string): boolean | null {
  const r = io.execFile("tasklist", ["/FI", `IMAGENAME eq ${processName}`, "/NH"]);
  if (r.code !== 0) return null;
  return r.stdout.toLowerCase().includes(processName.toLowerCase());
}

function tailLines(text: string, n: number): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.slice(Math.max(0, lines.length - n));
}

export async function cmdVerify(io: WindowsHostIo, port: number, herdrProcessName: string, logFile: string | null): Promise<WindowsHostHealthResult> {
  const herdrRunning = isHerdrRunning(io, herdrProcessName);
  const health = herdrRunning === true ? await io.fetchHealth(port) : null;
  const logTail = logFile ? io.readFile(logFile) : null;
  return classifyWindowsHostHealth({
    herdrRunning,
    health,
    ...(logTail !== null ? { logTail: tailLines(logTail, LOG_TAIL_LINES) } : {}),
  });
}

const USAGE = `usage: bun run scripts/windows-host/cli.ts install [--env-file <path>] [--log-dir <path>] [--dry-run]
       bun run scripts/windows-host/cli.ts verify [--port <n>] [--herdr-process-name <name>] [--log-file <path>]

"install" only handles what this CLI can prove correct under \`bun test\`
(the herdr prerequisite check, the log directory, the env file) —
registering the Scheduled Task itself is real PowerShell in install.ps1,
which runs this command first. "verify" checks whether a herdr process is
running before ever asking the daemon's own /health — a daemon cannot have
started successfully without herdr answering (see
src/daemon/missing-rules-preflight.ts's own "Refusing to start" message).`;

function parseFlags(rest: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

export async function runWindowsHostCli(argv: string[], io: WindowsHostIo = defaultIo()): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    (sub === undefined ? io.stderr : io.stdout)(USAGE);
    return sub === undefined ? 2 : 0;
  }

  if (sub === "install") {
    const flags = parseFlags(rest);
    const envFileFlag = flags.get("env-file");
    const logDirFlag = flags.get("log-dir");
    const opts: InstallOptions = {
      envFile: typeof envFileFlag === "string" ? envFileFlag : `${io.appDataDir()}\\butchr\\butchr.env`,
      logDir: typeof logDirFlag === "string" ? logDirFlag : `${io.localAppDataDir()}\\butchr\\logs`,
      dryRun: flags.has("dry-run"),
    };
    const { results, exitCode } = cmdInstall(io, opts);
    for (const r of results) io.stdout(`[${r.status}] ${r.name}: ${r.message}`);
    const nextSteps = results.filter((r) => r.status === "next-step");
    if (nextSteps.length) io.stdout(`\n${nextSteps.length} next step(s) require manual action — see [next-step] lines above.`);
    return exitCode;
  }

  if (sub === "verify") {
    const flags = parseFlags(rest);
    const port = typeof flags.get("port") === "string" ? Number(flags.get("port")) : 7717;
    const herdrProcessName = typeof flags.get("herdr-process-name") === "string" ? (flags.get("herdr-process-name") as string) : "herdr.exe";
    const logFileFlag = flags.get("log-file");
    const logFile = typeof logFileFlag === "string" ? logFileFlag : `${io.localAppDataDir()}\\butchr\\logs\\butchr.log`;
    const result = await cmdVerify(io, port, herdrProcessName, logFile);
    io.stdout(result.headline);
    for (const line of result.detail) io.stdout(`  ${line}`);
    return result.exitCode;
  }

  io.stderr(`unknown subcommand ${JSON.stringify(sub)}\n\n${USAGE}`);
  return 2;
}

if (import.meta.main) {
  process.exit(await runWindowsHostCli(process.argv.slice(2)));
}
