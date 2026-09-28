import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateSoundPlayers,
  chooseSoundPlayer,
  createApprovalSoundNotifier,
  expandHome,
  findPackageRoot,
  resolveDrovrBundledAsset,
  KNOWN_SOUND_PLAYERS,
  type ApprovalSoundDeps,
  type SpawnedProcess,
} from "../../src/agents/approval-sound.js";

describe("chooseSoundPlayer / candidateSoundPlayers", () => {
  test("tries gst-play-1.0 first when everything is on PATH", () => {
    expect(chooseSoundPlayer("/x/sound.mp3", () => true)?.name).toBe("gst-play-1.0");
  });

  test("falls back through the fixed order: afplay, then mpv, then ffplay, then paplay/pw-play", () => {
    expect(chooseSoundPlayer("/x/sound.mp3", (c) => c === "afplay" || c === "paplay")?.name).toBe("afplay");
    expect(chooseSoundPlayer("/x/sound.mp3", (c) => c === "mpv" || c === "paplay")?.name).toBe("mpv");
    expect(chooseSoundPlayer("/x/sound.mp3", (c) => c === "pw-play" || c === "paplay")?.name).toBe("paplay");
  });

  test("skips aplay for a non-wav file even if it's the only player present", () => {
    expect(chooseSoundPlayer("/x/sound.mp3", (c) => c === "aplay")).toBeNull();
  });

  test("picks aplay for a wav file", () => {
    expect(chooseSoundPlayer("/x/sound.wav", (c) => c === "aplay")?.name).toBe("aplay");
  });

  test("returns null when nothing in KNOWN_SOUND_PLAYERS is on PATH", () => {
    expect(chooseSoundPlayer("/x/sound.mp3", () => false)).toBeNull();
  });

  test("every known player builds an argv naming itself first", () => {
    for (const p of KNOWN_SOUND_PLAYERS) expect(p.argv("/x/sound.mp3")[0]).toBe(p.name);
  });

  test("candidateSoundPlayers returns the FULL fallback chain, not just the first match", () => {
    const names = candidateSoundPlayers("/x/sound.mp3", (c) => c === "gst-play-1.0" || c === "mpv" || c === "paplay").map((p) => p.name);
    expect(names).toEqual(["gst-play-1.0", "mpv", "paplay"]); // in KNOWN_SOUND_PLAYERS order, not has()-call order
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

/** Builds a fake `node_modules/@brooswit/drovr` layout under a fresh temp dir; caller removes `root` when done. */
function fakeDrovrPackage(withAsset: boolean): { root: string; entry: string; assetPath: string } {
  const root = mkdtempSync(join(tmpdir(), "drovr-fake-"));
  const pkgDir = join(root, "node_modules", "@brooswit", "drovr");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@brooswit/drovr" }));
  const entry = join(pkgDir, "dist", "index.js");
  writeFileSync(entry, "export {};");
  const assetPath = join(pkgDir, "assets", "sounds", "lizard-button.mp3");
  if (withAsset) {
    mkdirSync(join(pkgDir, "assets", "sounds"), { recursive: true });
    writeFileSync(assetPath, "not real audio");
  }
  return { root, entry, assetPath };
}

describe("findPackageRoot / resolveDrovrBundledAsset", () => {
  test("finds the package root by walking up from a nested entry file and matching package.json's name", () => {
    const { root, entry } = fakeDrovrPackage(true);
    expect(findPackageRoot(entry, "@brooswit/drovr")).toBe(join(root, "node_modules", "@brooswit", "drovr"));
    rmSync(root, { recursive: true, force: true });
  });

  test("returns null if no ancestor package.json matches the name before reaching the filesystem root", () => {
    const root = mkdtempSync(join(tmpdir(), "drovr-fake-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "something-else" }));
    expect(findPackageRoot(join(root, "dist", "index.js"), "@brooswit/drovr")).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  test("returns null after exhausting maxDepth, even if a matching ancestor exists further up", () => {
    const { root, entry } = fakeDrovrPackage(true); // package.json with the right name sits 2 levels above `entry`
    expect(findPackageRoot(entry, "@brooswit/drovr", 1)).toBeNull(); // 1 level up is dist/, not the package root
    rmSync(root, { recursive: true, force: true });
  });

  test("resolveDrovrBundledAsset joins assets/sounds/lizard-button.mp3 onto the resolved package root", () => {
    const { root, entry, assetPath } = fakeDrovrPackage(true);
    expect(resolveDrovrBundledAsset(() => entry)).toBe(assetPath);
    rmSync(root, { recursive: true, force: true });
  });

  test("resolveDrovrBundledAsset returns null if the resolver throws (package not installed)", () => {
    expect(resolveDrovrBundledAsset(() => { throw new Error("Cannot find module '@brooswit/drovr'"); })).toBeNull();
  });

  // FACTORY-100 test (i), REAL-PACKAGE GUARD (deliberate): resolves the ACTUALLY installed
  // @brooswit/drovr and asserts the bundled asset exists — goes red the moment the pinned
  // version lacks assets/sounds/lizard-button.mp3 (e.g. a re-pin to a release cut without it,
  // a live risk since FACTORY-106 also re-pins drovr). Un-skipped now that package.json/bun.lock
  // are bumped to drovr v0.15.2, which ships the asset (FACTORY-122).
  test("REAL-PACKAGE GUARD: the installed @brooswit/drovr ships assets/sounds/lizard-button.mp3", () => {
    const assetPath = resolveDrovrBundledAsset();
    expect(assetPath).not.toBeNull();
    expect(existsSync(assetPath!)).toBe(true);
  });
});

/** Builds deps with sensible fakes, overridable per test — no test here ever spawns a real process, fetches over the network, or plays real audio. */
function fakeDeps(overrides: Partial<ApprovalSoundDeps> & { enabled: boolean }): {
  deps: ApprovalSoundDeps;
  spawnCalls: string[][];
  hasCalls: string[];
  lines: string[];
} {
  const spawnCalls: string[][] = [];
  const hasCalls: string[] = [];
  const lines: string[] = [];
  const deps: ApprovalSoundDeps = {
    has: (c) => { hasCalls.push(c); return false; },
    spawn: (argv) => { spawnCalls.push(argv); return { exited: Promise.resolve(0) }; },
    log: (l) => lines.push(l),
    ...overrides,
  };
  return { deps, spawnCalls, hasCalls, lines };
}

describe("createApprovalSoundNotifier", () => {
  test("(a) disabled: notifyApproved is a total no-op — no has/spawn call, ever", () => {
    const { deps, spawnCalls, hasCalls } = fakeDeps({ enabled: false });
    const notifier = createApprovalSoundNotifier(deps);
    notifier.notifyApproved();
    notifier.notifyApproved();
    expect(spawnCalls).toEqual([]);
    expect(hasCalls).toEqual([]);
  });

  test("(b) enabled with a local override file: one notifyApproved call spawns exactly once, via gst-play-1.0 first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    const { deps, spawnCalls } = fakeDeps({ enabled: true, overridePath: file, has: () => true });
    createApprovalSoundNotifier(deps).notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual(["gst-play-1.0", "--no-interactive", "-q", file]); // first in KNOWN_SOUND_PLAYERS order, since has() accepts everything
    rmSync(dir, { recursive: true, force: true });
  });

  test("(b) a burst of approvals inside the coalescing window plays at most once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    let t = 1_000;
    const { deps, spawnCalls } = fakeDeps({ enabled: true, overridePath: file, has: () => true, now: () => t, coalesceMs: 1500 });
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
    const { deps, spawnCalls } = fakeDeps({ enabled: true, overridePath: file, has: () => true, now: () => t, coalesceMs: 1500 });
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
    const { deps, spawnCalls, lines } = fakeDeps({ enabled: true, overridePath: file, has: () => false, now: () => t, coalesceMs: 10 });
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

  test("(d) override file missing: single warning, disabled permanently, spawn never called on a second approval", async () => {
    const { deps, spawnCalls, hasCalls, lines } = fakeDeps({ enabled: true, overridePath: "/definitely/does/not/exist-lizard.mp3", has: () => true });
    const notifier = createApprovalSoundNotifier(deps);
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toEqual([]);
    expect(hasCalls).toEqual([]); // never even reached player selection
    expect(lines.filter((l) => l.includes("not found"))).toHaveLength(1);
  });

  test("an override path that's all whitespace falls back to the drovr-default resolution rather than being treated as a real path", async () => {
    const { root, entry, assetPath } = fakeDrovrPackage(true);
    const { deps, spawnCalls } = fakeDeps({ enabled: true, overridePath: "   ", resolveDrovrEntry: () => entry, has: () => true });
    createApprovalSoundNotifier(deps).notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls[0]?.at(-1)).toBe(assetPath);
    rmSync(root, { recursive: true, force: true });
  });

  test("(h) default source: enabled with no override resolves to drovr's own bundled asset", async () => {
    const { root, entry, assetPath } = fakeDrovrPackage(true);
    const { deps, spawnCalls } = fakeDeps({ enabled: true, resolveDrovrEntry: () => entry, has: () => true });
    createApprovalSoundNotifier(deps).notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual(["gst-play-1.0", "--no-interactive", "-q", assetPath]);
    rmSync(root, { recursive: true, force: true });
  });

  test("default source: asset missing from the resolved package -> single warning, disabled, approval unaffected", async () => {
    const { root, entry } = fakeDrovrPackage(false); // package resolves, but assets/sounds/lizard-button.mp3 was never created
    const { deps, spawnCalls, hasCalls, lines } = fakeDeps({ enabled: true, resolveDrovrEntry: () => entry, has: () => true });
    const notifier = createApprovalSoundNotifier(deps);
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toEqual([]);
    expect(hasCalls).toEqual([]);
    expect(lines.filter((l) => l.includes("bundled sound asset not found"))).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("default source: an unresolvable @brooswit/drovr (resolver throws) -> single warning, disabled, approval unaffected", async () => {
    const lines: string[] = [];
    const { deps, spawnCalls } = fakeDeps({
      enabled: true,
      resolveDrovrEntry: () => { throw new Error("Cannot find module '@brooswit/drovr'"); },
      has: () => true,
      log: (l) => lines.push(l),
    });
    const notifier = createApprovalSoundNotifier(deps);
    expect(() => notifier.notifyApproved()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toEqual([]);
    expect(lines.filter((l) => l.includes("bundled sound asset not found"))).toHaveLength(1);
  });

  test("(f) falls back to the next candidate when the first exits non-zero, then remembers the working one for later approvals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    const lines: string[] = [];
    let t = 1_000;
    const spawnCalls: string[][] = [];
    // gst-play-1.0 is "installed" but fails on this file (codey's live measurement, mirrored here with a fake); mpv is installed and works.
    const has = (c: string) => c === "gst-play-1.0" || c === "mpv";
    const spawn = (argv: string[]): SpawnedProcess => {
      spawnCalls.push(argv);
      return { exited: Promise.resolve(argv[0] === "gst-play-1.0" ? 1 : 0) };
    };
    const notifier = createApprovalSoundNotifier({ enabled: true, overridePath: file, has, spawn, now: () => t, coalesceMs: 10, log: (l) => lines.push(l) });

    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toEqual([
      ["gst-play-1.0", "--no-interactive", "-q", file],
      ["mpv", "--no-video", "--really-quiet", file],
    ]);
    expect(lines.filter((l) => l.includes("exited non-zero"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("played") && l.includes("mpv"))).toHaveLength(1);

    // Next approval: the remembered player (mpv) is tried directly — gst-play-1.0 is never retried.
    t += 100;
    spawnCalls.length = 0;
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toEqual([["mpv", "--no-video", "--really-quiet", file]]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a remembered working player that later fails is forgotten, and the fallback chain is re-probed from scratch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    const spawnCalls: string[][] = [];
    let gstShouldFail = false;
    const has = (c: string) => c === "gst-play-1.0" || c === "mpv";
    const spawn = (argv: string[]): SpawnedProcess => {
      spawnCalls.push(argv);
      const failed = argv[0] === "gst-play-1.0" && gstShouldFail;
      return { exited: Promise.resolve(failed ? 1 : 0) };
    };
    let t = 1_000;
    const notifier = createApprovalSoundNotifier({ enabled: true, overridePath: file, has, spawn, now: () => t, coalesceMs: 10 });

    // First approval: gst-play-1.0 works and is remembered.
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toEqual([["gst-play-1.0", "--no-interactive", "-q", file]]);

    // gst-play-1.0 starts failing (e.g. a transient device issue) — the remembered player is dropped and mpv is tried instead.
    gstShouldFail = true;
    spawnCalls.length = 0;
    t += 100;
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toEqual([
      ["gst-play-1.0", "--no-interactive", "-q", file],
      ["mpv", "--no-video", "--really-quiet", file],
    ]);

    // Third approval: mpv is now the remembered player — gst-play-1.0 is not retried.
    spawnCalls.length = 0;
    t += 100;
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCalls).toEqual([["mpv", "--no-video", "--really-quiet", file]]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("(journal) logs one concise line per actual play, naming the player and file — not a once-ever warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    let t = 1_000;
    const { deps, lines } = fakeDeps({ enabled: true, overridePath: file, has: () => true, now: () => t, coalesceMs: 10 });
    const notifier = createApprovalSoundNotifier(deps);
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    t += 100;
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(lines.filter((l) => l.includes("played") && l.includes(file) && l.includes("gst-play-1.0"))).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("(g) a spawn that throws synchronously never surfaces to the caller and warns exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    const lines: string[] = [];
    let t = 1_000;
    const spawn = (): SpawnedProcess => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); };
    const notifier = createApprovalSoundNotifier({ enabled: true, overridePath: file, has: () => true, spawn, now: () => t, coalesceMs: 10, log: (l) => lines.push(l) });
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
    const notifier = createApprovalSoundNotifier({ enabled: true, overridePath: file, has: () => true, spawn: () => ({ exited: Promise.reject(new Error("boom")) }) });
    expect(() => notifier.notifyApproved()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    rmSync(dir, { recursive: true, force: true });
  });

  test("a synchronously-throwing `now` never surfaces out of notifyApproved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lizard-sound-file-"));
    const file = join(dir, "lizard.mp3");
    writeFileSync(file, "not real audio");
    const lines: string[] = [];
    const notifier = createApprovalSoundNotifier({ enabled: true, overridePath: file, has: () => true, spawn: () => ({ exited: Promise.resolve(0) }), now: () => { throw new Error("clock broke"); }, log: (l) => lines.push(l) });
    expect(() => notifier.notifyApproved()).not.toThrow();
    expect(lines.some((l) => l.includes("notifyApproved threw unexpectedly"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("(g) an async 'error' event from a spawned player (Node-style child_process) is caught, warned once (synchronously), and never affects a later approval", async () => {
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
    const notifier = createApprovalSoundNotifier({ enabled: true, overridePath: file, has: () => true, spawn, now: () => t, coalesceMs: 10, log: (l) => lines.push(l) });
    notifier.notifyApproved();
    await new Promise((r) => setTimeout(r, 10));
    expect(onErrorCb).toBeTruthy();
    onErrorCb?.(new Error("ENOENT"));
    onErrorCb?.(new Error("ENOENT again")); // a second async error report must not double-log
    expect(lines.filter((l) => l.includes("reported an error"))).toHaveLength(1); // logged synchronously from the event handler itself — no microtask wait needed here

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
    const notifier = createApprovalSoundNotifier({ enabled: true, overridePath: file, has, spawn: () => ({ exited: Promise.resolve(0) }), log: (l) => lines.push(l) });
    expect(() => notifier.notifyApproved()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(lines.some((l) => l.includes("unexpected error playing sound"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("omitting `log` entirely defaults to silence, not a throw, even on the disable-forever path", async () => {
    const notifier = createApprovalSoundNotifier({ enabled: true, overridePath: "/definitely/does/not/exist-lizard-2.mp3", has: () => true, spawn: () => ({ exited: Promise.resolve(0) }) });
    expect(() => notifier.notifyApproved()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  test("(g) an onApproved-style caller that throws synchronously is still swallowed (belt-and-suspenders on top of notifyApproved's own try/catch)", () => {
    const { deps } = fakeDeps({ enabled: false });
    const notifier = createApprovalSoundNotifier(deps);
    // Even a disabled notifier's returned function must be safe to call from a try/catch-free site.
    expect(() => notifier.notifyApproved()).not.toThrow();
  });
});
