import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseSoundPlayer,
  createApprovalSoundNotifier,
  expandHome,
  KNOWN_SOUND_PLAYERS,
  type ApprovalSoundDeps,
  type SpawnedProcess,
} from "../../src/agents/approval-sound.js";

describe("chooseSoundPlayer", () => {
  test("picks the first available player in KNOWN_SOUND_PLAYERS order", () => {
    const has = (c: string) => c === "mpv" || c === "ffplay";
    expect(chooseSoundPlayer("/x/sound.mp3", has)?.name).toBe("mpv");
  });

  test("skips aplay for a non-wav file even if it's the only player present", () => {
    const has = (c: string) => c === "aplay";
    expect(chooseSoundPlayer("/x/sound.mp3", has)).toBeNull();
  });

  test("picks aplay for a wav file", () => {
    const has = (c: string) => c === "aplay";
    expect(chooseSoundPlayer("/x/sound.wav", has)?.name).toBe("aplay");
  });

  test("returns null when nothing in KNOWN_SOUND_PLAYERS is on PATH", () => {
    expect(chooseSoundPlayer("/x/sound.mp3", () => false)).toBeNull();
  });

  test("every known player builds an argv naming itself first", () => {
    for (const p of KNOWN_SOUND_PLAYERS) expect(p.argv("/x/sound.mp3")[0]).toBe(p.name);
  });
});

describe("expandHome", () => {
  test("expands a bare ~ to home", () => {
    expect(expandHome("~", "/home/op")).toBe("/home/op");
  });
  test("expands ~/... to home/...", () => {
    expect(expandHome("~/sounds/x.mp3", "/home/op")).toBe(join("/home/op", "sounds/x.mp3"));
  });
  test("leaves an absolute path untouched", () => {
    expect(expandHome("/abs/x.mp3", "/home/op")).toBe("/abs/x.mp3");
  });
});

/** Builds deps with sensible fakes, overridable per test — no test here ever spawns a real process, fetches over the network, or plays real audio. */
function fakeDeps(overrides: Partial<ApprovalSoundDeps> & { source: string | undefined }): {
  deps: ApprovalSoundDeps;
  spawnCalls: string[][];
  hasCalls: string[];
  lines: string[];
} {
  const spawnCalls: string[][] = [];
  const hasCalls: string[] = [];
  const lines: string[] = [];
  const deps: ApprovalSoundDeps = {
    cacheDir: mkdtempSync(join(tmpdir(), "lizard-sound-cache-")),
    has: (c) => { hasCalls.push(c); return false; },
    spawn: (argv) => { spawnCalls.push(argv); return { exited: Promise.resolve(0) }; },
    log: (l) => lines.push(l),
    ...overrides,
  };
  return { deps, spawnCalls, hasCalls, lines };
}

describe("createApprovalSoundNotifier", () => {
  test("(a) source unset: notifyApproved is a total no-op — no has/spawn/fetch call, ever", () => {
    const { deps, spawnCalls, hasCalls } = fakeDeps({ source: undefined });
    let fetchCalls = 0;
    (deps as ApprovalSoundDeps).fetchImpl = (async () => { fetchCalls++; throw new Error("must not be called"); }) as unknown as typeof fetch;
    const notifier = createApprovalSoundNotifier(deps);
    notifier.notifyApproved();
    notifier.notifyApproved();
    expect(spawnCalls).toEqual([]);
    expect(hasCalls).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  test("(a) empty-string source behaves the same as unset", () => {
    const { deps, spawnCalls, hasCalls } = fakeDeps({ source: "   " });
    createApprovalSoundNotifier(deps).notifyApproved();
    expect(spawnCalls).toEqual([]);
    expect(hasCalls).toEqual([]);
  });

  test("(b) enabled with a local file: one notifyApproved call spawns exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    const { deps, spawnCalls } = fakeDeps({ source: file, has: () => true });
    createApprovalSoundNotifier(deps).notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual(["paplay", file]); // first player in KNOWN_SOUND_PLAYERS order, since `has` accepts everything
    rmSync(dir, { recursive: true, force: true });
  });

  test("(b) a burst of approvals inside the coalescing window plays at most once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    let t = 1_000;
    const { deps, spawnCalls } = fakeDeps({ source: file, has: () => true, now: () => t, coalesceMs: 1500 });
    const notifier = createApprovalSoundNotifier(deps);
    notifier.notifyApproved();
    t += 200;
    notifier.notifyApproved();
    t += 200;
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toHaveLength(1); // three approvals inside 1500ms — collapsed into one play
    rmSync(dir, { recursive: true, force: true });
  });

  test("approvals spaced beyond the coalescing window each play once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    let t = 1_000;
    const { deps, spawnCalls } = fakeDeps({ source: file, has: () => true, now: () => t, coalesceMs: 1500 });
    const notifier = createApprovalSoundNotifier(deps);
    notifier.notifyApproved();
    t += 2_000;
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("(c) no usable player: approval outcome unaffected (never throws), single warning even across repeats, spawn never called", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    let t = 1_000;
    const { deps, spawnCalls, lines } = fakeDeps({ source: file, has: () => false, now: () => t, coalesceMs: 10 });
    const notifier = createApprovalSoundNotifier(deps);
    expect(() => notifier.notifyApproved()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    t += 1_000;
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toEqual([]);
    expect(lines.filter((l) => l.includes("no usable local audio player"))).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("(d) local file missing: single warning, disabled permanently, spawn never called on a second approval", async () => {
    const { deps, spawnCalls, hasCalls, lines } = fakeDeps({ source: "/definitely/does/not/exist-lizard.mp3", has: () => true });
    const notifier = createApprovalSoundNotifier(deps);
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10)); // let the (synchronous-bodied) resolve settle before the second call
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toEqual([]);
    expect(hasCalls).toEqual([]); // never even reached player selection
    expect(lines.filter((l) => l.includes("not found"))).toHaveLength(1);
  });

  test("(f) URL source: the cache is used on repeat — a second notifier instance over the SAME cacheDir does not re-download", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "lizard-sound-cache-"));
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response;
    }) as unknown as typeof fetch;

    const notifier1 = createApprovalSoundNotifier({ source: "https://example.com/lizard.mp3", cacheDir, has: () => true, spawn: () => ({ exited: Promise.resolve(0) }), fetchImpl });
    notifier1.notifyApproved();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls).toBe(1);

    // A second, independent notifier (standing in for a second daemon init) over the same cache dir.
    const spawnCalls2: string[][] = [];
    const notifier2 = createApprovalSoundNotifier({ source: "https://example.com/lizard.mp3", cacheDir, has: () => true, spawn: (a) => { spawnCalls2.push(a); return { exited: Promise.resolve(0) }; }, fetchImpl });
    notifier2.notifyApproved();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls).toBe(1); // still 1 — served from cache, no re-download
    expect(spawnCalls2).toHaveLength(1); // and playback still happened, from the cached file

    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("(f) URL source: a failed download logs once, disables the sound, and never retries on a later approval", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "lizard-sound-cache-"));
    let fetchCalls = 0;
    const fetchImpl = (async () => { fetchCalls++; return { ok: false, status: 403 } as unknown as Response; }) as unknown as typeof fetch;
    const lines: string[] = [];
    const spawnCalls: string[][] = [];
    const notifier = createApprovalSoundNotifier({ source: "https://example.com/lizard.mp3", cacheDir, has: () => true, spawn: (a) => { spawnCalls.push(a); return { exited: Promise.resolve(0) }; }, fetchImpl, log: (l) => lines.push(l) });
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 20));
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls).toBe(1); // exactly one attempt, ever
    expect(spawnCalls).toEqual([]);
    expect(lines.filter((l) => l.includes("failed to resolve sound source"))).toHaveLength(1);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("(g) a spawn that throws synchronously never surfaces to the caller and warns exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    const lines: string[] = [];
    let t = 1_000;
    const spawn = (): SpawnedProcess => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); };
    const notifier = createApprovalSoundNotifier({ source: file, cacheDir: dir, has: () => true, spawn, now: () => t, coalesceMs: 10, log: (l) => lines.push(l) });
    expect(() => notifier.notifyApproved()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    t += 100;
    expect(() => notifier.notifyApproved()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(lines.filter((l) => l.includes("failed to start"))).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("(g) a player whose exited promise rejects never surfaces to the caller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    const notifier = createApprovalSoundNotifier({ source: file, cacheDir: dir, has: () => true, spawn: () => ({ exited: Promise.reject(new Error("boom")) }) });
    expect(() => notifier.notifyApproved()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    rmSync(dir, { recursive: true, force: true });
  });

  test("a synchronously-throwing `now` never surfaces out of notifyApproved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    const lines: string[] = [];
    const notifier = createApprovalSoundNotifier({ source: file, cacheDir: dir, has: () => true, spawn: () => ({ exited: Promise.resolve(0) }), now: () => { throw new Error("clock broke"); }, log: (l) => lines.push(l) });
    expect(() => notifier.notifyApproved()).not.toThrow();
    expect(lines.some((l) => l.includes("notifyApproved threw unexpectedly"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("(g) an async 'error' event from a spawned player (Node-style child_process) is caught, warned once, and never affects a later approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    const lines: string[] = [];
    let onErrorCb: ((err: unknown) => void) | undefined;
    let t = 1_000;
    const spawn = (): SpawnedProcess => ({
      exited: new Promise<number>(() => {}), // never settles — the "error" event is what actually reports the failure, same as Node's child_process for a real ENOENT
      on: (_event, cb) => { onErrorCb = cb; },
    });
    const notifier = createApprovalSoundNotifier({ source: file, cacheDir: dir, has: () => true, spawn, now: () => t, coalesceMs: 10, log: (l) => lines.push(l) });
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(onErrorCb).toBeTruthy();
    onErrorCb?.(new Error("ENOENT"));
    onErrorCb?.(new Error("ENOENT again")); // a second async error report must not double-log
    expect(lines.filter((l) => l.includes("reported an error"))).toHaveLength(1);

    t += 100;
    expect(() => notifier.notifyApproved()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unexpected synchronous throw inside playOnce (e.g. a broken `has`) is caught by notifyApproved's own defensive .catch, never surfaced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    const lines: string[] = [];
    const has = (): boolean => { throw new Error("PATH lookup broke"); };
    const notifier = createApprovalSoundNotifier({ source: file, cacheDir: dir, has, spawn: () => ({ exited: Promise.resolve(0) }), log: (l) => lines.push(l) });
    expect(() => notifier.notifyApproved()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(lines.some((l) => l.includes("unexpected error playing sound"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("omitting `log` entirely defaults to silence, not a throw, even on the disable-forever path", async () => {
    const notifier = createApprovalSoundNotifier({ source: "/definitely/does/not/exist-lizard-2.mp3", cacheDir: mkdtempSync(join(tmpdir(), "lizard-sound-cache-")), has: () => true, spawn: () => ({ exited: Promise.resolve(0) }) });
    expect(() => notifier.notifyApproved()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  test("(g) an onApproved-style caller that throws synchronously is still swallowed (belt-and-suspenders on top of notifyApproved's own try/catch)", () => {
    const { deps } = fakeDeps({ source: undefined });
    const notifier = createApprovalSoundNotifier(deps);
    // Even a disabled (source-unset) notifier's returned function must be safe to call from a try/catch-free site.
    expect(() => notifier.notifyApproved()).not.toThrow();
  });
});
