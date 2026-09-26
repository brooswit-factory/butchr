/**
 * FACTORY-64: the WSL-host install/verify CLI — the actual decision-making
 * and file-editing logic behind `scripts/wsl-host/install.sh` (a thin
 * bootstrap that execs into this file once `bun` itself is confirmed
 * present — see that script's own header comment for why the split is
 * this way round) and behind `verify`, which `Verify-WslHost.ps1` shells
 * into from the Windows side for everything except the one signal it
 * can't observe from inside WSL (whether WSL itself is up at all).
 *
 * Follows this repo's own `scripts/deploy/watchdog.ts` precedent
 * end-to-end: every real side effect (exec, file read/write, chmod,
 * network fetch, the clock) is reached through one injected `WslHostIo`
 * object, `defaultIo()` is the only place any of it is real, and every
 * subcommand is a plain async function over that interface — so
 * `test/unit/wsl-host-cli.test.ts` can prove ordering, idempotency
 * (running `install` twice makes no further changes) and the printed
 * next-steps for a missing prerequisite, without a real WSL distro,
 * without root, and without a real herdr binary anywhere in sight.
 *
 * Two subcommands:
 *   install — WSL-side: check/install prerequisites, edit `/etc/wsl.conf`,
 *             enable lingering, place the herdr binary, write both
 *             systemd user units (+ herdr's `LimitNOFILE` drop-in), create
 *             (never overwrite) the two `EnvironmentFile=` sources empty
 *             and 0600, `daemon-reload`, then `enable --now` both units
 *             (unless `--no-start`/`--dry-run`).
 *   verify  — print the `classifyWslHealth` verdict for THIS distro
 *             (always assumed up — see `health.ts`'s own doc comment for
 *             why "is WSL up at all" is deliberately out of this
 *             command's scope) and exit with the matching code.
 *
 * `--dry-run` on `install`: every step still runs its READ-ONLY checks
 * (prereq detection, current wsl.conf content, current unit-file content)
 * so the printed plan is accurate, but no write/exec that would change
 * anything on disk or in systemd actually happens — mirrors
 * `watchdog.ts check --dry-run`'s own "decide, don't act" contract.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir, userInfo } from "node:os";
import { ensureWslConf } from "./wsl-conf.js";
import { renderButchrUnit, renderHerdrUnit, renderHerdrLimitNofileDropin } from "./units.js";
import { classifyWslHealth, type WslHealthResult } from "./health.js";

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

export interface WslHostIo {
  commandExists: (cmd: string) => boolean;
  /** Synchronous, like `watchdog.ts`'s own exec calls — never throws; a non-zero exit is a normal `ExecResult`, not an exception. `input`, when given, is piped to the child's stdin (used for `sudo tee <path>`, below). */
  execFile: (cmd: string, args: string[], input?: string) => ExecResult;
  readFile: (path: string) => string | null; // null on ENOENT
  /** Throws on failure (e.g. EACCES writing a root-owned path like `/etc/wsl.conf` as a non-root user) — callers that can recover (see `stepWslConf`'s `sudo tee` fallback) must catch it themselves; this is deliberately NOT swallowed into a return value the way `execFile` is, so a plain `install` run on files it DOES own (units, env files) still fails loudly on a real unexpected error instead of silently no-op'ing. */
  writeFile: (path: string, contents: string, mode?: number) => void;
  fileExists: (path: string) => boolean;
  chmod: (path: string, mode: number) => void;
  copyFile: (from: string, to: string) => void;
  whoami: () => string;
  homeDir: () => string;
  /** Absolute path to the `bun` binary this process is running under (`process.execPath`) — the default for `--bun-bin` when the flag is omitted. A systemd unit's `ExecStart=` resolves a bare command name against its own fixed search path, not the invoking shell's `PATH` (`systemd-analyze --user verify` on a unit with a bare `ExecStart=bun ...` fails with "Command bun is not executable" even when `bun` is genuinely on the operator's own PATH) — so the rendered unit must always get an absolute path, never a bare name, unless the caller explicitly overrides it with one via `--bun-bin`. Mirrors `scripts/deploy/watchdog.ts`'s own `bunExecPath`. */
  bunExecPath: () => string;
  fetchHealth: (port: number) => Promise<{ ok: boolean } | null>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const HEALTH_FETCH_TIMEOUT_MS = 5_000;

export function defaultIo(): WslHostIo {
  function run(cmd: string, args: string[], input?: string): ExecResult {
    try {
      const stdout = execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...(input !== undefined ? { input } : {}) });
      return { code: 0, stdout, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e) };
    }
  }

  return {
    commandExists(cmd) {
      return run("bash", ["-lc", `command -v ${cmd}`]).code === 0;
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
    writeFile(path, contents, mode) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, mode !== undefined ? { mode } : undefined);
    },
    fileExists(path) {
      return existsSync(path);
    },
    chmod(path, mode) {
      chmodSync(path, mode);
    },
    copyFile(from, to) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    },
    whoami: () => userInfo().username,
    homeDir: () => homedir(),
    bunExecPath: () => process.execPath,
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
  repoDir: string;
  bunBin: string;
  herdrBin?: string;
  defaultUser?: string;
  port: number;
  configDir: string; // where butchr.env / managed-sessions.env / unit files live
  dryRun: boolean;
  noStart: boolean;
}

async function stepPrereqs(io: WslHostIo, dryRun: boolean): Promise<StepResult[]> {
  const results: StepResult[] = [];

  if (io.commandExists("bun")) {
    results.push({ name: "prereq: bun", status: "ok", message: "found on PATH" });
  } else {
    // install.sh's own bootstrap should have made this unreachable — but cli.ts must never assume the caller was install.sh.
    results.push({ name: "prereq: bun", status: "next-step", message: "bun not found on PATH — install it (see https://bun.sh/install) before re-running" });
  }

  if (io.commandExists("git")) {
    results.push({ name: "prereq: git", status: "ok", message: "found on PATH" });
  } else if (dryRun) {
    results.push({ name: "prereq: git", status: "next-step", message: "git not found — would run `sudo apt-get install -y git` (skipped: --dry-run)" });
  } else {
    const r = io.execFile("sudo", ["apt-get", "install", "-y", "git"]);
    results.push(
      r.code === 0
        ? { name: "prereq: git", status: "ok", message: "installed via apt-get" }
        : { name: "prereq: git", status: "next-step", message: `apt-get install git failed (exit ${r.code}) — install git yourself: ${r.stderr.trim() || "(no stderr captured)"}` },
    );
  }

  // claude/codex genuinely can't be auto-installed-and-authenticated headlessly (interactive login) — detect and hand back a next-step, never fail the run over it.
  for (const cli of ["claude", "codex"] as const) {
    if (io.commandExists(cli)) {
      results.push({ name: `prereq: ${cli}`, status: "ok", message: "found on PATH — this script cannot verify login/authentication state automatically; confirm manually" });
    } else {
      results.push({ name: `prereq: ${cli}`, status: "next-step", message: `${cli} not found on PATH — install and authenticate it yourself (interactive login required; not auto-installable by this script)` });
    }
  }

  return results;
}

function expandHome(path: string, io: WslHostIo): string {
  return path.startsWith("~") ? path.replace(/^~/, io.homeDir()) : path;
}

function stepWslConf(io: WslHostIo, opts: InstallOptions): StepResult {
  const path = "/etc/wsl.conf";
  const existing = io.readFile(path) ?? "";
  const { content, changed } = ensureWslConf(existing, { systemd: true, ...(opts.defaultUser !== undefined ? { defaultUser: opts.defaultUser } : {}) });
  if (!changed) return { name: "wsl.conf", status: "skipped", message: `${path} already has [boot] systemd=true${opts.defaultUser ? ` and [user] default=${opts.defaultUser}` : ""}` };
  if (opts.dryRun) return { name: "wsl.conf", status: "next-step", message: `would update ${path} (skipped: --dry-run) — requires root; restart WSL (\`wsl --shutdown\` from Windows) for it to take effect` };

  // /etc/wsl.conf is root-owned. Try a direct write first (works if this process already runs as root); on any failure (typically EACCES for an ordinary user), fall back to `sudo tee` rather than crashing the whole run halfway through — a normal user with passwordless (or interactively-prompted) sudo still completes the install.
  try {
    io.writeFile(path, content);
    return { name: "wsl.conf", status: "ok", message: `updated ${path} directly — restart WSL (\`wsl --shutdown\` from Windows) for systemd to take effect on first install` };
  } catch (e) {
    const sudoResult = io.execFile("sudo", ["tee", path], content);
    if (sudoResult.code !== 0) {
      return {
        name: "wsl.conf",
        status: "next-step",
        message: `could not write ${path} directly (${(e as Error).message ?? e}) and \`sudo tee ${path}\` also failed (exit ${sudoResult.code}): ${sudoResult.stderr.trim() || "(no stderr captured)"} — edit it yourself: ensure [boot]\\nsystemd=true${opts.defaultUser ? ` and [user]\\ndefault=${opts.defaultUser}` : ""}, then \`wsl --shutdown\` from Windows`,
      };
    }
    return { name: "wsl.conf", status: "ok", message: `updated ${path} via \`sudo tee\` (direct write was not permitted) — restart WSL (\`wsl --shutdown\` from Windows) for systemd to take effect on first install` };
  }
}

function stepLinger(io: WslHostIo, opts: InstallOptions): StepResult {
  const user = opts.defaultUser ?? io.whoami();
  if (opts.dryRun) return { name: "linger", status: "next-step", message: `would run \`loginctl enable-linger ${user}\` (skipped: --dry-run)` };
  const r = io.execFile("loginctl", ["enable-linger", user]);
  return r.code === 0
    ? { name: "linger", status: "ok", message: `enable-linger ${user} (idempotent; already-enabled is not an error)` }
    : { name: "linger", status: "next-step", message: `\`loginctl enable-linger ${user}\` failed (exit ${r.code}): ${r.stderr.trim() || "(no stderr captured)"}` };
}

function stepHerdrBinary(io: WslHostIo, opts: InstallOptions): { result: StepResult; herdrBin: string } {
  const target = `${io.homeDir()}/.local/bin/herdr`;
  if (io.fileExists(target) && !opts.herdrBin) {
    return { result: { name: "herdr binary", status: "skipped", message: `already present at ${target}` }, herdrBin: target };
  }
  if (opts.herdrBin) {
    if (!io.fileExists(opts.herdrBin)) {
      return { result: { name: "herdr binary", status: "error", message: `--herdr-bin ${opts.herdrBin} does not exist` }, herdrBin: target };
    }
    if (opts.dryRun) return { result: { name: "herdr binary", status: "next-step", message: `would copy ${opts.herdrBin} to ${target} and chmod +x (skipped: --dry-run)` }, herdrBin: target };
    io.copyFile(opts.herdrBin, target);
    io.chmod(target, 0o755);
    return { result: { name: "herdr binary", status: "ok", message: `copied ${opts.herdrBin} to ${target}` }, herdrBin: target };
  }
  return {
    result: {
      name: "herdr binary",
      status: "next-step",
      message: `herdr not found at ${target} and no --herdr-bin given. This repo does not vendor or build herdr — obtain a herdr binary for this host and either place it at ${target} yourself or re-run with --herdr-bin <path>. See https://herdr.dev (already referenced by this repo's own README.md).`,
    },
    herdrBin: target,
  };
}

function stepEnvFile(io: WslHostIo, path: string, header: string, dryRun: boolean): StepResult {
  if (io.fileExists(path)) return { name: `env file ${path}`, status: "skipped", message: "already exists — never overwritten (may hold real credentials)" };
  if (dryRun) return { name: `env file ${path}`, status: "next-step", message: `would create empty ${path} (0600) (skipped: --dry-run)` };
  io.writeFile(path, header, 0o600);
  io.chmod(path, 0o600);
  return { name: `env file ${path}`, status: "next-step", message: `created empty ${path} (0600) — fill in the required variables before starting the daemon` };
}

function stepUnit(io: WslHostIo, path: string, content: string, dryRun: boolean, label: string): StepResult {
  const existing = io.readFile(path);
  if (existing === content) return { name: label, status: "skipped", message: `${path} already matches` };
  if (dryRun) return { name: label, status: "next-step", message: `would write ${path} (skipped: --dry-run)` };
  io.writeFile(path, content);
  return { name: label, status: "ok", message: `wrote ${path}` };
}

export async function cmdInstall(io: WslHostIo, opts: InstallOptions): Promise<{ results: StepResult[]; exitCode: number }> {
  const results: StepResult[] = [];
  results.push(...(await stepPrereqs(io, opts.dryRun)));
  results.push(stepWslConf(io, opts));
  results.push(stepLinger(io, opts));

  const { result: herdrResult, herdrBin } = stepHerdrBinary(io, opts);
  results.push(herdrResult);

  const unitDir = `${io.homeDir()}/.config/systemd/user`;
  const butchrEnv = `${opts.configDir}/butchr.env`;
  const sessionsEnv = `${opts.configDir}/managed-sessions.env`;
  results.push(stepEnvFile(io, butchrEnv, "# butchr.env — ATLASSIAN_SITE / ATLASSIAN_EMAIL / ATLASSIAN_TOKEN_FILE (or ATLASSIAN_TOKEN) and any other secrets. See docs/windows-wsl-host.md.\n", opts.dryRun));
  results.push(stepEnvFile(io, sessionsEnv, "# managed-sessions.env — BUTCHR_SESSION_DEFINITIONS_DIR, BUTCHR_AGENT_PROVIDER=codex (or claude), and any managed-session-specific vars. See docs/windows-wsl-host.md.\n", opts.dryRun));

  results.push(
    stepUnit(io, `${unitDir}/butchr.service`, renderButchrUnit({ workingDirectory: expandHome(opts.repoDir, io), bunBin: opts.bunBin, environmentFiles: [butchrEnv, sessionsEnv] }), opts.dryRun, "unit: butchr.service"),
  );
  results.push(stepUnit(io, `${unitDir}/herdr.service`, renderHerdrUnit({ herdrBin }), opts.dryRun, "unit: herdr.service"));
  results.push(stepUnit(io, `${unitDir}/herdr.service.d/limit-nofile.conf`, renderHerdrLimitNofileDropin(), opts.dryRun, "unit: herdr.service LimitNOFILE drop-in"));

  if (opts.dryRun) {
    results.push({ name: "systemd reload/enable", status: "next-step", message: "would run `systemctl --user daemon-reload` and `enable --now butchr.service herdr.service` (skipped: --dry-run)" });
  } else {
    const reload = io.execFile("systemctl", ["--user", "daemon-reload"]);
    results.push(reload.code === 0 ? { name: "systemd reload", status: "ok", message: "daemon-reload" } : { name: "systemd reload", status: "error", message: `daemon-reload failed (exit ${reload.code}): ${reload.stderr.trim()}` });
    if (opts.noStart) {
      results.push({ name: "systemd enable/start", status: "skipped", message: "--no-start given — units written but not enabled/started" });
    } else {
      const enable = io.execFile("systemctl", ["--user", "enable", "--now", "butchr.service", "herdr.service"]);
      results.push(
        enable.code === 0
          ? { name: "systemd enable/start", status: "ok", message: "enabled and started butchr.service, herdr.service" }
          : { name: "systemd enable/start", status: "next-step", message: `enable --now failed (exit ${enable.code}): ${enable.stderr.trim() || "(no stderr captured)"} — likely missing credentials in butchr.env; see docs/windows-wsl-host.md's known-limitation note (FACTORY-65)` },
      );
    }
  }

  const hasError = results.some((r) => r.status === "error");
  return { results, exitCode: hasError ? 1 : 0 };
}

export async function cmdVerify(io: WslHostIo, port: number, unit = "butchr.service"): Promise<WslHealthResult> {
  const sysRunning = io.execFile("systemctl", ["--user", "is-system-running"]);
  const systemdActive = sysRunning.code === 0 || ["degraded", "starting"].includes(sysRunning.stdout.trim()) ? true : sysRunning.stdout.trim() ? false : null;

  let daemonUnitActive: boolean | null = null;
  let journalTail: string[] | undefined;
  if (systemdActive) {
    const active = io.execFile("systemctl", ["--user", "is-active", unit]);
    daemonUnitActive = active.stdout.trim() === "active" ? true : active.stdout.trim() ? false : null;
    if (daemonUnitActive !== true) {
      const journal = io.execFile("journalctl", ["--user", "-u", unit, "-n", "20", "--no-pager"]);
      journalTail = journal.stdout.split("\n").filter(Boolean);
    }
  }

  const health = daemonUnitActive === true ? await io.fetchHealth(port) : null;

  return classifyWslHealth({
    distroInstalled: true,
    distroRunning: true,
    systemdActive,
    daemonUnitActive,
    health,
    ...(journalTail !== undefined ? { journalTail } : {}),
  });
}

const USAGE = `usage: bun run scripts/wsl-host/cli.ts install --repo-dir <dir> [--bun-bin <path>]
                                          [--herdr-bin <path>] [--default-user <name>]
                                          [--port <n>] [--config-dir <dir>]
                                          [--dry-run] [--no-start]
       bun run scripts/wsl-host/cli.ts verify [--port <n>] [--unit <name>]

Run from INSIDE the WSL distro. "install" is idempotent: re-running makes
no destructive changes, never duplicates a wsl.conf line, never overwrites
an existing env file. "verify" always assumes WSL itself is up (it can
only be run from inside it) — see health.ts's own doc comment for why "is
WSL up at all" is Verify-WslHost.ps1's job, not this command's.`;

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

export async function runWslHostCli(argv: string[], io: WslHostIo = defaultIo()): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    (sub === undefined ? io.stderr : io.stdout)(USAGE);
    return sub === undefined ? 2 : 0;
  }

  if (sub === "install") {
    const flags = parseFlags(rest);
    const repoDir = flags.get("repo-dir");
    if (typeof repoDir !== "string") {
      io.stderr(`missing required --repo-dir\n\n${USAGE}`);
      return 2;
    }
    const configDirFlag = flags.get("config-dir");
    const herdrBinFlag = flags.get("herdr-bin");
    const defaultUserFlag = flags.get("default-user");
    const opts: InstallOptions = {
      repoDir,
      bunBin: typeof flags.get("bun-bin") === "string" ? (flags.get("bun-bin") as string) : io.bunExecPath(),
      ...(typeof herdrBinFlag === "string" ? { herdrBin: herdrBinFlag } : {}),
      ...(typeof defaultUserFlag === "string" ? { defaultUser: defaultUserFlag } : {}),
      port: typeof flags.get("port") === "string" ? Number(flags.get("port")) : 7717,
      configDir: typeof configDirFlag === "string" ? configDirFlag : `${io.homeDir()}/.config/butchr`,
      dryRun: flags.has("dry-run"),
      noStart: flags.has("no-start"),
    };
    const { results, exitCode } = await cmdInstall(io, opts);
    for (const r of results) io.stdout(`[${r.status}] ${r.name}: ${r.message}`);
    const nextSteps = results.filter((r) => r.status === "next-step");
    if (nextSteps.length) {
      io.stdout(`\n${nextSteps.length} next step(s) require manual action — see [next-step] lines above.`);
    }
    return exitCode;
  }

  if (sub === "verify") {
    const flags = parseFlags(rest);
    const port = typeof flags.get("port") === "string" ? Number(flags.get("port")) : 7717;
    const unit = typeof flags.get("unit") === "string" ? (flags.get("unit") as string) : "butchr.service";
    const result = await cmdVerify(io, port, unit);
    io.stdout(result.headline);
    for (const line of result.detail) io.stdout(`  ${line}`);
    return result.exitCode;
  }

  io.stderr(`unknown subcommand ${JSON.stringify(sub)}\n\n${USAGE}`);
  return 2;
}

if (import.meta.main) {
  process.exit(await runWslHostCli(process.argv.slice(2)));
}
