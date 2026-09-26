/**
 * FACTORY-100/FACTORY-103: an OPT-IN, OFF-by-default sound played on THIS
 * DAEMON'S OWN HOST each time lizard mode (src/agents/permission-answer-loop.ts)
 * auto-approves a tool-permission prompt — the operator's own request, so a
 * human in earshot of the host hears every unattended approval as it
 * happens, not just from `Config.permissionAuditPath`'s JSONL trail.
 *
 * Hook point: `runPermissionAnswerTick`'s own `answered` filter — the one
 * place in BUTCHR'S OWN code that knows "this pane's prompt was just
 * approved". The alternative (tailing `permissionAuditPath` for new
 * `outcome: "approved"` lines) was rejected: that JSONL file is written by
 * `@brooswit/drovr`'s `approvePermission` (a separate published package),
 * and this repo has no precedent anywhere for tailing a file it writes
 * itself as an event source — the tick's own in-memory result is strictly
 * earlier, cheaper, and already flows through this exact module.
 *
 * EVERY requirement here reduces to one property: this module must NEVER be
 * able to touch the approval path. `createApprovalSoundNotifier`'s
 * `notifyApproved` is therefore synchronous, never awaited by its caller,
 * catches everything, and any state it resolves to (no player found, source
 * unreadable, download failed) is resolved ONCE and cached — never
 * re-attempted per approval, per this ticket's explicit "never fetch/spawn
 * per approval, never retry-loop" requirements.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { extname, join } from "node:path";

/** One local audio player this module knows how to invoke, most-preferred first. */
export interface SoundPlayerSpec {
  name: string;
  argv: (filePath: string) => string[];
  /** Omitted = plays every format this module ever resolves a source to. `aplay` (ALSA) cannot decode mp3, so it is restricted to `.wav`. */
  supportsExt?: (ext: string) => boolean;
}

/**
 * Tried in this order, mirroring `detectTerminalPrefix`'s table shape
 * (`src/terminal/open.ts`). `paplay`/`pw-play` (PulseAudio/PipeWire) are the
 * common Linux desktop/server case; `mpv`/`ffplay` decode mp3 directly and
 * run headless with the right flags; `aplay` (ALSA) only plays wav; `afplay`
 * is macOS's own player, tried last since this fleet's own hosts are Linux.
 */
export const KNOWN_SOUND_PLAYERS: readonly SoundPlayerSpec[] = [
  { name: "paplay", argv: (f) => ["paplay", f] },
  { name: "pw-play", argv: (f) => ["pw-play", f] },
  { name: "mpv", argv: (f) => ["mpv", "--no-video", "--really-quiet", f] },
  { name: "ffplay", argv: (f) => ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", f] },
  { name: "aplay", argv: (f) => ["aplay", "-q", f], supportsExt: (ext) => ext === ".wav" },
  { name: "afplay", argv: (f) => ["afplay", f] },
];

/** First installed player (per `has`, a PATH lookup) that can play `filePath`'s format, or null if none. */
export function chooseSoundPlayer(filePath: string, has: (cmd: string) => boolean): SoundPlayerSpec | null {
  const ext = extname(filePath).toLowerCase();
  for (const p of KNOWN_SOUND_PLAYERS) {
    if (p.supportsExt && !p.supportsExt(ext)) continue;
    if (has(p.name)) return p;
  }
  return null;
}

/** `~` / `~/...` expansion — neither Node's nor Bun's `fs` does this for a path handed to it raw. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

const isUrl = (source: string): boolean => /^https?:\/\//i.test(source);

/** Deterministic cache filename for a URL source — the same URL always resolves to the same cached file, across daemon restarts, with no manifest to keep in sync. */
function cacheFileFor(url: string, cacheDir: string): string {
  const ext = extname(new URL(url).pathname) || ".bin";
  return join(cacheDir, `${createHash("sha256").update(url).digest("hex").slice(0, 16)}${ext}`);
}

/** Minimal shape this module needs out of a spawned child process — satisfied by `Bun.spawn`'s return value; a test seam injects a fake. */
export interface SpawnedProcess {
  exited?: Promise<number>;
  /** Node's `child_process` emits this async for a spawn failure (e.g. ENOENT); `Bun.spawn` does not expose it, hence optional. */
  on?: (event: "error", cb: (err: unknown) => void) => void;
}

export interface ApprovalSoundDeps {
  /** `Config.lizardApprovalSound?.source` — undefined/empty disables the feature entirely: no player is ever spawned, no source is ever resolved, no fetch or fs check ever happens. */
  source: string | undefined;
  /** Where a URL source is downloaded to once and reused; irrelevant for a local-file source. */
  cacheDir: string;
  /** PATH lookup for player detection; production wiring passes `(c) => Bun.which(c) != null`, same as `detectTerminalPrefix`'s own caller (`src/daemon/index.ts`). */
  has: (cmd: string) => boolean;
  /** Fire-and-forget process launch; production wiring passes `Bun.spawn`. Test seam: inject a fake that never touches a real process or plays real audio. */
  spawn: (argv: string[]) => SpawnedProcess;
  /** Test seam for URL downloads; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam for the coalescing clock; defaults to `Date.now`. */
  now?: () => number;
  /** One line per STATE CHANGE (no player found, source unresolvable, a spawn/playback failure) — never one line per approval, and never more than once per state. Optional; omitted, these are simply never logged. */
  log?: (line: string) => void;
  /** Minimum ms between two plays — a burst of approvals inside this window plays at most once. Default `DEFAULT_COALESCE_MS`. */
  coalesceMs?: number;
}

/** Default coalescing window: a burst of approvals inside this many ms plays at most one sound. */
export const DEFAULT_COALESCE_MS = 1500;

/**
 * Builds the fire-and-forget notifier `runPermissionAnswerTick` calls once
 * per approved pane. Three independent, EACH-LOGGED-AT-MOST-ONCE failure
 * modes, all of which degrade to permanent silence rather than affecting any
 * approval or retrying forever:
 *   - the configured source (local file or URL) never resolves to a usable
 *     file (missing/unreadable path, or a download that fails) — logs once,
 *     the notifier goes permanently silent (never re-checks, never retries).
 *   - the source resolves, but no known local player is on PATH — logs once,
 *     the notifier goes permanently silent.
 *   - a resolved source and a found player, but the player itself fails to
 *     spawn or exits abnormally (the headless-host, no-audio-device case) —
 *     logs once and stays silent about it from then on, but future approvals
 *     still attempt to play (the device may come back; nothing here can
 *     tell).
 * `source` left unset (the default) short-circuits to a no-op notifier
 * before touching `has`/`spawn`/`fetchImpl`/the filesystem at all — the
 * "default off, no player spawned" contract.
 */
export function createApprovalSoundNotifier(deps: ApprovalSoundDeps): { notifyApproved: () => void } {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;
  const trimmedSource = deps.source?.trim();

  if (!trimmedSource) return { notifyApproved: () => {} };
  const source: string = trimmedSource; // narrowed once, outside the closures below — TS cannot see the guard above through a nested function boundary

  let disabledForever = false;
  let warnedPlaybackFailure = false;
  let resolvedFile: string | null = null;
  let resolving: Promise<string | null> | null = null;
  let lastPlayedAt: number | null = null;

  async function resolveFile(): Promise<string | null> {
    try {
      if (!isUrl(source)) {
        const path = expandHome(source);
        if (!existsSync(path)) {
          log(`[lizard-sound] local sound file not found, disabling for this daemon's lifetime: ${path}`);
          disabledForever = true;
          return null;
        }
        return path;
      }
      const cached = cacheFileFor(source, deps.cacheDir);
      if (existsSync(cached)) return cached;
      const fetchImpl = deps.fetchImpl ?? fetch;
      const res = await fetchImpl(source);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      mkdirSync(deps.cacheDir, { recursive: true });
      writeFileSync(cached, bytes);
      return cached;
    } catch (e) {
      log(`[lizard-sound] failed to resolve sound source, disabling for this daemon's lifetime (no retry): ${(e as Error)?.message ?? e}`);
      disabledForever = true;
      return null;
    }
  }

  async function playOnce(): Promise<void> {
    if (resolvedFile === null) {
      resolving ??= resolveFile();
      resolvedFile = await resolving;
      resolving = null;
    }
    if (resolvedFile === null) return; // resolveFile already logged + disabled
    const player = chooseSoundPlayer(resolvedFile, deps.has);
    if (!player) {
      log("[lizard-sound] no usable local audio player found (tried paplay, pw-play, mpv, ffplay, aplay, afplay); disabling sound for this daemon's lifetime");
      disabledForever = true;
      return;
    }
    let child: SpawnedProcess;
    try {
      child = deps.spawn(player.argv(resolvedFile));
    } catch (e) {
      if (!warnedPlaybackFailure) { log(`[lizard-sound] player "${player.name}" failed to start: ${(e as Error)?.message ?? e}`); warnedPlaybackFailure = true; }
      return;
    }
    try { child.on?.("error", (err) => { if (!warnedPlaybackFailure) { log(`[lizard-sound] player "${player.name}" reported an error: ${(err as Error)?.message ?? err}`); warnedPlaybackFailure = true; } }); } catch { /* a fake test spawn may not support .on at all */ }
    await (child.exited ?? Promise.resolve(0)).catch(() => undefined); // headless/no-device: a non-zero exit or a rejection both degrade silently — never surfaced beyond the one warning above
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
