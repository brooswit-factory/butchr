/**
 * FACTORY-625: installs the file-execution veto as a Claude Code
 * `PreToolUse` hook on Bash, into a workspace's own `.claude/settings.json`.
 *
 * WHY A HOOK, AND NOT THE APPROVAL DIALOG. The first attempt at this
 * (PR #628, never merged) read the pending permission DIALOG off the pane and
 * withheld an approval. genius measured that against codey's real audit log:
 * it would have withheld 787 of 4,507 approved commands (17%, ~260 human
 * interventions a day), nearly all benign, AND still let the original incident
 * through — a plain `bun <file>` was unrecognised, `rm -rf /home/<user>` /
 * `$HOME/.claude` / `find ~ -delete` were not treated as roots, and a payload
 * on a wrapped or scrolled-off screen line was invisible. A hook is strictly
 * better on every one of those axes: it receives the exact command text and
 * cwd rather than a rendering, and it runs in EVERY permission mode including
 * bypass, where no dialog exists to intercept at all.
 *
 * WHAT IS DELIBERATELY NOT TOUCHED: `settings.local.json`. That is where
 * Claude's own "always allow" rules land, and it belongs to the user, not to
 * butchr. Only `settings.json` is merged.
 *
 * THE MODE SWITCH IS A FLAG FILE, NOT A SETTINGS KEY, and that is load-bearing:
 * Claude snapshots hooks at session start, so a switch living in
 * `settings.json` could not be flipped without relaunching every agent on the
 * fleet. The hook command is therefore installed UNCONDITIONALLY and the
 * script reads audit-only-vs-enforce from `modeFilePath` at run time, per
 * invocation. Audit-only is the default when that file is absent.
 */
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
// Embedded at build time, exactly as `briefs/*.md` are — see src/py.d.ts for
// why this cannot be a path into the checkout: the daemon ships as a bundled
// `dist/butchr.js` and the published package carries only `dist/`, so a
// `hooks/…` path would not exist in an installed daemon at all.
import VETO_SCRIPT from "../../hooks/file-execution-veto.py" with { type: "text" };

/**
 * Identifies butchr's own hook entry for the idempotent merge below. Carried
 * as a trailing shell comment INSIDE the command string (harmless — the hook
 * command runs through a shell) rather than as a sibling JSON field, because
 * Claude Code owns this object's schema and an unknown key is not guaranteed
 * to survive a round-trip through its own settings handling.
 */
export const HOOK_MARKER = "butchr:file-execution-veto";

/** The checker, copied into each workspace — see `installFileExecutionVeto` for why it is copied rather than referenced in place. */
export const HOOK_SCRIPT_BASENAME = ".butchr-file-execution-veto.py";

/** Flag file the SCRIPT reads per call: contents starting `enforce` mean block, anything else (or absent) means audit-only. */
export const VETO_MODE_BASENAME = ".butchr-veto-mode";

/** Rolling-hour fail-open counter state, so "fails open" can never quietly become "always open". */
export const VETO_FAIL_OPEN_STATE_BASENAME = ".butchr-veto-fail-open.json";

/** The embedded checker source, exposed so a test can assert what gets written without reading the repo. */
export const vetoScriptText = (): string => VETO_SCRIPT;

export interface VetoHookPaths {
  /** JSONL audit sink — `Config.permissionAuditPath`, the same file the approver already writes, so there is one place to look. */
  auditPath: string;
  /** Read per call by the script; see this module's header for why this is a file and not a settings key. */
  modeFilePath: string;
  failOpenStatePath: string;
  /** Test seam: the checker source to write. Defaults to the embedded script. */
  scriptText?: string;
}

export type VetoInstallOutcome =
  | { installed: true; backedUpTo?: string }
  | { installed: false; reason: string };

export type PythonCheck = { ok: true } | { ok: false; reason: string };

/** What `usablePython3` consults, injectable so a test needs neither a Mac nor a missing Python. */
export interface PythonProbeDeps {
  which: (cmd: string) => string | null;
  platform: NodeJS.Platform;
  /** Exit status of `xcode-select -p`, or null if it could not be run. */
  xcodeSelectStatus: () => number | null;
}

const APPLE_PYTHON3_PATH = "/usr/bin/python3";

const defaultProbeDeps = (): PythonProbeDeps => ({
  which: (cmd) => Bun.which(cmd),
  platform: process.platform,
  xcodeSelectStatus: () => {
    try { return Bun.spawnSync(["xcode-select", "-p"], { stdout: "ignore", stderr: "ignore" }).exitCode; }
    catch { return null; }
  },
});

/**
 * Whether the `python3` the hook command names can actually run. The hook is
 * `python3 <checker>` on every Bash call an agent makes, so a `python3` that
 * cannot run turns the tripwire into a silent no-op (the call exits non-zero,
 * which Claude treats as a non-blocking error and carries on).
 *
 * A stock Mac is the case that matters: `/usr/bin/python3` there is a stub that
 * runs nothing until the Xcode Command Line Tools are installed. It exits 1
 * and asks macOS to open the "install developer tools" dialog, so the stub is
 * recognised WITHOUT being run: running it to find out would raise that dialog.
 * `xcode-select -p` answers the same question and has no side effect.
 *
 * Deliberately not a run of `python3 --version`: that is exactly the call the
 * stub turns into a dialog. And when this cannot tell (`xcode-select` could not
 * be run), it says usable, so the protection is never switched off on a guess.
 */
export function usablePython3(deps: PythonProbeDeps = defaultProbeDeps()): PythonCheck {
  const found = deps.which("python3");
  if (!found) return { ok: false, reason: "python3 was not found on the daemon's PATH" };
  if (deps.platform === "darwin" && found === APPLE_PYTHON3_PATH) {
    const status = deps.xcodeSelectStatus();
    if (status !== null && status !== 0) {
      return {
        ok: false,
        reason: `python3 resolves to ${APPLE_PYTHON3_PATH}, which on this Mac is Apple's installer stub because the Xcode Command Line Tools are not installed; install them (xcode-select --install) or put a real python3 earlier on the daemon's PATH`,
      };
    }
  }
  return { ok: true };
}

/** The exact hook command line, with the marker. Quoted for paths containing spaces. */
function hookCommandFor(scriptPath: string, paths: VetoHookPaths): string {
  return `python3 "${scriptPath}" --mode-file "${paths.modeFilePath}" --audit "${paths.auditPath}" --fail-open-state "${paths.failOpenStatePath}" # ${HOOK_MARKER}`;
}

/** True for an entry this module wrote — matched by marker or by the script basename, so an entry written by an older daemon is still recognised (and replaced, not duplicated). */
function isOurs(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown })?.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => {
    const cmd = (h as { command?: unknown })?.command;
    return typeof cmd === "string" && (cmd.includes(HOOK_MARKER) || cmd.includes(HOOK_SCRIPT_BASENAME));
  });
}

/**
 * Merge butchr's veto hook into `<dir>/.claude/settings.json`, preserving
 * everything else in the file.
 *
 * IDEMPOTENT BY CONSTRUCTION, which is a hard requirement rather than a
 * nicety: `buildWorkspace` re-runs against the same directory on every spawn
 * and resume, so this runs many times over one file. The merge is
 * remove-every-marked-entry-then-append-exactly-one — NOT "append if absent"
 * (which duplicates the moment the command string changes) and NOT matching by
 * array position (which breaks when a human adds a hook of their own above
 * ours). That shape also self-heals an entry written by an older daemon whose
 * command line differed.
 *
 * `enabled: false` is the same code path in reverse — strip our entries, leave
 * every other key and every foreign PreToolUse entry untouched. Disabling must
 * never require hand-editing a settings file, or in an incident it will not
 * actually get disabled.
 *
 * A settings file that does not PARSE is backed up and replaced, and the
 * backup path is returned so the caller can log it loudly. That is the one
 * case where this knowingly writes over something a person may have authored:
 * refusing to launch would wedge the fleet on one bad file, and launching
 * unhooked is the unsafe direction and silent. A file that parses but has no
 * `hooks` key is MERGED, never replaced.
 *
 * Never throws: an unwritable `.claude` directory returns `installed: false`
 * with a reason. A workspace that cannot take the hook must still be able to
 * launch — the hook is one layer, not the only control, and a spawn failing
 * because a tripwire could not be installed trades a small risk for a certain
 * outage.
 */
export function installFileExecutionVeto(dir: string, paths: VetoHookPaths, enabled = true): VetoInstallOutcome {
  try {
    const claudeDir = join(dir, ".claude");
    const settingsPath = join(claudeDir, "settings.json");
    mkdirSync(claudeDir, { recursive: true });

    let settings: Record<string, unknown> = {};
    let backedUpTo: string | undefined;
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf8");
      if (raw.trim()) {
        try {
          const parsed = JSON.parse(raw);
          settings = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        } catch {
          backedUpTo = `${settingsPath}.butchr-bak-${Date.now()}`;
          writeFileSync(backedUpTo, raw);
          settings = {};
        }
      }
    }

    const hooks = (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? settings.hooks as Record<string, unknown>
      : {});
    const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse as unknown[] : [];
    const foreign = existing.filter((e) => !isOurs(e));

    let next: unknown[];
    if (enabled) {
      const scriptPath = join(dir, HOOK_SCRIPT_BASENAME);
      // Rewritten on every spawn, so a daemon upgrade ships its new checker to
      // an already-built workspace without any migration step.
      writeFileSync(scriptPath, paths.scriptText ?? VETO_SCRIPT);
      chmodSync(scriptPath, 0o700);
      next = [...foreign, {
        matcher: "Bash",
        hooks: [{ type: "command", command: hookCommandFor(scriptPath, paths), timeout: 5 }],
      }];
    } else {
      next = foreign;
    }

    // An empty PreToolUse list is removed rather than left as `[]`, so a
    // disabled install leaves a file indistinguishable from one butchr never
    // touched (and `hooks: {}` likewise).
    const nextHooks: Record<string, unknown> = { ...hooks };
    if (next.length) nextHooks.PreToolUse = next; else delete nextHooks.PreToolUse;
    const nextSettings: Record<string, unknown> = { ...settings };
    if (Object.keys(nextHooks).length) nextSettings.hooks = nextHooks; else delete nextSettings.hooks;

    // Temp-then-rename: a crash mid-write must never leave a truncated
    // settings file, which Claude would then fail to parse at session start.
    const tmp = `${settingsPath}.butchr-tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(nextSettings, null, 2) + "\n");
    renameSync(tmp, settingsPath);
    return backedUpTo ? { installed: true, backedUpTo } : { installed: true };
  } catch (e) {
    return { installed: false, reason: (e as Error)?.message ?? String(e) };
  }
}
