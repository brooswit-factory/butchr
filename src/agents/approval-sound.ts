/**
 * FACTORY-100/FACTORY-103: an OPT-IN, OFF-by-default sound played on THIS
 * DAEMON'S OWN HOST each time lizard mode (src/agents/permission-answer-loop.ts)
 * auto-approves a tool-permission prompt — the operator's own request, so a
 * human in earshot of the host hears every unattended approval as it
 * happens, not just from `Config.permissionAuditPath`'s JSONL trail.
 *
 * Hook point: `runPermissionAnswerTick`'s own `answered` filter — the one
 * place in BUTCHR'S OWN code that knows "this pane's prompt was just
 * approved", regardless of whether it is driven by a timer or (FACTORY-97)
 * an event-driven watcher — both wrap this same tick function, so the hook
 * fires either way. The alternative (tailing `permissionAuditPath` for new
 * `outcome: "approved"` lines) was rejected: that JSONL file is written by
 * `@brooswit/drovr`'s `approvePermission` (a separate published package),
 * and this repo has no precedent anywhere for tailing a file it writes
 * itself as an event source — the tick's own in-memory result is strictly
 * earlier, cheaper, and already flows through this exact module.
 *
 * Default sound source: a file BUNDLED IN THE `@brooswit/drovr` PACKAGE
 * itself (`assets/sounds/lizard-button.mp3` at that package's root) — the
 * operator's original URL (`https://www.myinstants.com/...`) returns a
 * Cloudflare 403 to non-browser clients on this fleet's own hosts, and a
 * later operator redirect (FACTORY-100 comment, 2026-09-26T21:21Z) asked for
 * the asset to live in drovr, "next to the auto-answer that makes the
 * approval", rather than as a URL or a Butchr-side download. URL sources are
 * OUT OF SCOPE (cut per the same ticket's later requirements) — an optional
 * LOCAL FILE PATH override is the only other supported source.
 *
 * EVERY requirement here reduces to one property: this module must NEVER be
 * able to touch the approval path. `createApprovalSoundNotifier`'s
 * `notifyApproved` is therefore synchronous, never awaited by its caller,
 * catches everything, and any state it resolves to (no player found, source
 * unreadable) is resolved ONCE and cached — never re-attempted per approval,
 * per this ticket's explicit "never spawn per approval, never retry-loop"
 * requirements.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { homedir } from "node:os";

/** One local audio player this module knows how to invoke, most-preferred first. */
export interface SoundPlayerSpec {
  name: string;
  argv: (filePath: string) => string[];
  /** Omitted = plays every format this module ever resolves a source to. `aplay` (ALSA) cannot decode mp3, so it is restricted to `.wav`. */
  supportsExt?: (ext: string) => boolean;
}

/**
 * Tried in this order (FACTORY-100 comment, live measurement on codey,
 * 2026-09-26T21:43Z/22:06Z): `paplay`/`pw-play` FAIL on mp3 there ("Failed
 * to open audio file" / "Format not recognised" — codey's libsndfile build
 * has no mp3 support), while `gst-play-1.0 --no-interactive -q <file>` plays
 * it fine, and neither `mpv`, `ffplay` nor `ffmpeg` is installed. The
 * Director's final ruling on order (same ticket) is `gst-play-1.0` first,
 * then `afplay` (macOS), `mpv`, `ffplay`, then `paplay`/`pw-play` last (kept
 * for a host whose PulseAudio/PipeWire build DOES support mp3, or any wav
 * source); `aplay` (ALSA) only ever plays wav, so it is tried last and
 * restricted to that extension. A candidate that exits non-zero or errors is
 * NOT treated as "no more players to try" — see `candidateSoundPlayers`/the
 * retry loop in `createApprovalSoundNotifier` below (same live measurement:
 * "treat a player that exits non-zero on the file as 'try the next one', not
 * success").
 */
export const KNOWN_SOUND_PLAYERS: readonly SoundPlayerSpec[] = [
  { name: "gst-play-1.0", argv: (f) => ["gst-play-1.0", "--no-interactive", "-q", f] },
  { name: "afplay", argv: (f) => ["afplay", f] },
  { name: "mpv", argv: (f) => ["mpv", "--no-video", "--really-quiet", f] },
  { name: "ffplay", argv: (f) => ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", f] },
  { name: "paplay", argv: (f) => ["paplay", f] },
  { name: "pw-play", argv: (f) => ["pw-play", f] },
  { name: "aplay", argv: (f) => ["aplay", "-q", f], supportsExt: (ext) => ext === ".wav" },
];

/** Every installed player (per `has`, a PATH lookup), in try-order, that can play `filePath`'s format — the full fallback chain a single attempt walks; empty means none installed at all. */
export function candidateSoundPlayers(filePath: string, has: (cmd: string) => boolean): SoundPlayerSpec[] {
  const ext = extname(filePath).toLowerCase();
  return KNOWN_SOUND_PLAYERS.filter((p) => (!p.supportsExt || p.supportsExt(ext)) && has(p.name));
}

/** First installed player (per `has`, a PATH lookup) that can play `filePath`'s format, or null if none — the head of `candidateSoundPlayers`' own list. */
export function chooseSoundPlayer(filePath: string, has: (cmd: string) => boolean): SoundPlayerSpec | null {
  return candidateSoundPlayers(filePath, has)[0] ?? null;
}

/** `~` / `~/...` expansion — neither Node's nor Bun's `fs` does this for a path handed to it raw. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** The asset's path, relative to `@brooswit/drovr`'s own package root (FACTORY-122 ships it there). */
const DROVR_SOUND_ASSET_RELATIVE_PATH = join("assets", "sounds", "lizard-button.mp3");

/**
 * Real resolution of `@brooswit/drovr`'s own main entry file, as an absolute
 * path — `import.meta.resolve` (Bun, synchronous) resolves the package's
 * `exports["."]`, the only subpath that field actually exposes. Throws
 * (a `ResolveMessage`, still `Error`-shaped) if the package cannot be found
 * at all; callers of `resolveDrovrBundledAsset` are expected to catch this.
 */
export function resolveDrovrEntryReal(): string {
  return fileURLToPath(import.meta.resolve("@brooswit/drovr"));
}

/**
 * Walks up from `fromFile` until it finds the directory whose own
 * `package.json` declares `name === packageName` — that directory is the
 * package root. Needed because `@brooswit/drovr`'s `package.json` `exports`
 * exposes only `"."`, so neither `@brooswit/drovr/package.json` nor an
 * arbitrary asset subpath is guaranteed to resolve as a module specifier
 * (verified live: see this module's own top comment) — but a bundled,
 * non-code asset was never meant to be `import()`ed in the first place, so
 * walking the filesystem after resolving only the "." export sidesteps the
 * restriction entirely. `maxDepth` is a defensive bound (a real
 * `node_modules` layout resolves in 1-2 levels); returns `null` rather than
 * throwing if no such ancestor exists within it, or at the filesystem root.
 */
export function findPackageRoot(fromFile: string, packageName: string, maxDepth = 8): string | null {
  let dir = dirname(fromFile);
  for (let i = 0; i < maxDepth; i++) {
    const pkgJsonPath = join(dir, "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        if ((JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: string }).name === packageName) return dir;
      } catch {
        /* malformed/unreadable package.json at this level — keep walking up rather than failing the whole resolution */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root without finding it
    dir = parent;
  }
  return null;
}

/**
 * The default sound source: `@brooswit/drovr`'s own bundled asset, or
 * `null` if the package (or the asset within it) cannot be resolved —
 * callers treat that identically to "override path missing" (one warning,
 * disable for the daemon's lifetime). `resolveEntry` is a test seam
 * (defaults to `resolveDrovrEntryReal`): a fake pointed at a temp directory
 * shaped like a real `node_modules/@brooswit/drovr` install lets tests
 * exercise this without touching the real package.
 */
export function resolveDrovrBundledAsset(resolveEntry: () => string = resolveDrovrEntryReal): string | null {
  try {
    const root = findPackageRoot(resolveEntry(), "@brooswit/drovr");
    return root ? join(root, DROVR_SOUND_ASSET_RELATIVE_PATH) : null;
  } catch {
    return null;
  }
}

/** Minimal shape this module needs out of a spawned child process — satisfied by `Bun.spawn`'s return value; a test seam injects a fake. */
export interface SpawnedProcess {
  exited?: Promise<number>;
  /** Node's `child_process` emits this async for a spawn failure (e.g. ENOENT); `Bun.spawn` does not expose it, hence optional. */
  on?: (event: "error", cb: (err: unknown) => void) => void;
}

export interface ApprovalSoundDeps {
  /** `Config.lizardApprovalSound !== undefined` — false disables the feature entirely: no resolution, no PATH lookup, no player is ever spawned. */
  enabled: boolean;
  /** `Config.lizardApprovalSound?.overridePath` (`~` expanded) — when absent, the default source is drovr's own bundled asset (see `resolveDrovrBundledAsset`). */
  overridePath?: string;
  /** Test seam: resolves `@brooswit/drovr`'s main entry file (absolute path). Defaults to `resolveDrovrEntryReal`; irrelevant when `overridePath` is set. */
  resolveDrovrEntry?: () => string;
  /** PATH lookup for player detection; production wiring passes `(c) => Bun.which(c) != null`, same as `detectTerminalPrefix`'s own caller (`src/daemon/index.ts`). */
  has: (cmd: string) => boolean;
  /** Fire-and-forget process launch; production wiring passes `Bun.spawn`. Test seam: inject a fake that never touches a real process or plays real audio. */
  spawn: (argv: string[]) => SpawnedProcess;
  /** Test seam for the coalescing clock; defaults to `Date.now`. */
  now?: () => number;
  /** One line per actual play (player, file, exit status) AND one line per STATE CHANGE (no player found, source unresolvable, a spawn/playback failure — logged at most once per state, never once per approval). Optional; omitted, these are simply never logged. */
  log?: (line: string) => void;
  /** Minimum ms between two plays — a burst of approvals inside this window plays at most once. Default `DEFAULT_COALESCE_MS`. */
  coalesceMs?: number;
}

/** Default coalescing window: a burst of approvals inside this many ms plays at most one sound. */
export const DEFAULT_COALESCE_MS = 1500;

/**
 * Builds the fire-and-forget notifier `runPermissionAnswerTick` calls once
 * per approved pane. Two independent, EACH-LOGGED-AT-MOST-ONCE failure
 * modes, both of which degrade to permanent silence rather than affecting
 * any approval or retrying forever:
 *   - the configured source (an override local file, or drovr's own bundled
 *     asset) never resolves to a usable file (missing/unreadable path, or
 *     the package/asset can't be found) — logs once, the notifier goes
 *     permanently silent (never re-checks).
 *   - no known local player is on PATH — logs once, the notifier goes
 *     permanently silent.
 * A THIRD failure mode — a resolved source and at least one found player,
 * but every installed candidate fails to spawn or exits abnormally (the
 * headless-host, no-audio-device case) — logs once and stays silent about
 * it from then on, but future approvals still attempt to play (the device
 * may come back; nothing here can tell).
 * `enabled: false` (the default) short-circuits to a no-op notifier before
 * touching `has`/`spawn`/the filesystem at all — the "default off, no
 * player spawned" contract.
 */
export function createApprovalSoundNotifier(deps: ApprovalSoundDeps): { notifyApproved: () => void } {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;

  if (!deps.enabled) return { notifyApproved: () => {} };

  let disabledForever = false;
  let warnedPlaybackFailure = false;
  let resolvedFile: string | null = null;
  /** FACTORY-100: "remember the first player that works and reuse it" — avoids re-probing every candidate (a PATH lookup each) on every single approval once a good one is known. Cleared if the remembered player ever fails, so a later approval re-probes from scratch rather than getting stuck on a player that stopped working. */
  let workingPlayer: SoundPlayerSpec | null = null;
  let lastPlayedAt: number | null = null;

  /** Synchronous: no network fetch remains in this module, only filesystem checks and (for the default source) a package resolve. */
  function resolveFile(): string | null {
    const overridePath = deps.overridePath?.trim();
    if (overridePath) {
      const path = expandHome(overridePath);
      if (!existsSync(path)) {
        log(`[lizard-sound] override sound file not found, disabling for this daemon's lifetime: ${path}`);
        disabledForever = true;
        return null;
      }
      return path;
    }
    const assetPath = resolveDrovrBundledAsset(deps.resolveDrovrEntry);
    if (!assetPath || !existsSync(assetPath)) {
      log(`[lizard-sound] drovr's bundled sound asset not found${assetPath ? ` (resolved: ${assetPath})` : " (could not resolve @brooswit/drovr)"}, disabling for this daemon's lifetime`);
      disabledForever = true;
      return null;
    }
    return assetPath;
  }

  const warnPlaybackFailureOnce = (line: string): void => {
    if (warnedPlaybackFailure) return;
    warnedPlaybackFailure = true;
    log(line);
  };

  /**
   * FACTORY-100 live measurement: "treat a player that exits non-zero on the
   * file as 'try the next one', not success". `true` = played successfully
   * (exit 0, no async error); `false` = this candidate failed, try the next
   * one. Logs a failure SYNCHRONOUSLY from the `"error"` event handler
   * itself (not only from the `await` continuation below) so a caller
   * observing an externally-fired `"error"` event sees the log line
   * immediately, with no microtask-timing dependency.
   */
  async function tryOnePlayer(player: SoundPlayerSpec, filePath: string): Promise<boolean> {
    let child: SpawnedProcess;
    try {
      child = deps.spawn(player.argv(filePath));
    } catch (e) {
      warnPlaybackFailureOnce(`[lizard-sound] player "${player.name}" failed to start: ${(e as Error)?.message ?? e}`);
      return false;
    }
    const asyncError = new Promise<never>((_resolve, reject) => {
      try {
        child.on?.("error", (err) => {
          const error = err instanceof Error ? err : new Error(String(err));
          warnPlaybackFailureOnce(`[lizard-sound] player "${player.name}" reported an error: ${error.message}`);
          reject(error);
        });
      } catch { /* a fake test spawn may not support .on at all */ }
    });
    try {
      const code = await Promise.race([child.exited ?? Promise.resolve(0), asyncError]);
      if (code === 0) return true;
      warnPlaybackFailureOnce(`[lizard-sound] player "${player.name}" exited non-zero (${code}) — trying the next candidate if any`);
      return false;
    } catch (e) {
      // Covers `child.exited` itself rejecting (no `.on` support) — the
      // `"error"` event path above already logged for its own case, and
      // `warnPlaybackFailureOnce` is idempotent, so this is a safe no-op
      // when that already fired.
      warnPlaybackFailureOnce(`[lizard-sound] player "${player.name}" reported an error: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  /** FACTORY-100 requirement 6: journal evidence for a REAL play, distinct from the once-ever failure warnings above — one line every time a sound actually plays, so admin-assembly can confirm from the journal alone. */
  const logPlaySuccess = (player: SoundPlayerSpec, filePath: string): void => {
    log(`[lizard-sound] played ${filePath} via "${player.name}" (exit 0)`);
  };

  async function playOnce(): Promise<void> {
    if (resolvedFile === null) resolvedFile = resolveFile();
    if (resolvedFile === null) return; // resolveFile already logged + disabled

    const candidates = candidateSoundPlayers(resolvedFile, deps.has);
    if (candidates.length === 0) {
      log(`[lizard-sound] no usable local audio player found (tried ${KNOWN_SOUND_PLAYERS.map((p) => p.name).join(", ")}); disabling sound for this daemon's lifetime`);
      disabledForever = true;
      return;
    }
    // FACTORY-100: "remember the first player that works and reuse it" — try it FIRST (skip
    // re-probing PATH for it; it's already known installed), then fall back through the rest of
    // the fixed-order candidates, excluding it so it is never spawned twice in one attempt.
    const ordered = workingPlayer ? [workingPlayer, ...candidates.filter((p) => p !== workingPlayer)] : candidates;
    for (const player of ordered) {
      if (await tryOnePlayer(player, resolvedFile)) {
        workingPlayer = player;
        logPlaySuccess(player, resolvedFile);
        return;
      }
    }
    workingPlayer = null; // whatever we remembered (if anything) just failed too — re-probe fully next time
    // Every installed candidate failed at runtime (the headless/no-audio-device case) — degrade silently from
    // here on; per-player warnings above already covered "log once". This is only reached if NONE of them
    // logged (e.g. a future player type added here with none of the existing warning paths) — belt-and-suspenders.
    warnPlaybackFailureOnce("[lizard-sound] every available local audio player failed to play the sound; degrading to silence");
  }

  return {
    notifyApproved(): void {
      try {
        if (disabledForever) return;
        const t = now();
        if (lastPlayedAt !== null && t - lastPlayedAt < coalesceMs) return; // burst inside the window: coalesced away
        lastPlayedAt = t;
        void playOnce().catch((e) => log(`[lizard-sound] unexpected error playing sound: ${(e as Error)?.message ?? e}`));
      } catch (e) {
        log(`[lizard-sound] notifyApproved threw unexpectedly: ${(e as Error)?.message ?? e}`);
      }
    },
  };
}
