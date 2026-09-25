import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceFreezeStore } from "@brooswit/drovr-events";
import {
  archiveSessionDefinition, assertArchiveDirDisjoint, defaultSessionArchiveIo, sessionArchiveDir,
  unarchiveSessionDefinition, type OnArchived, type SessionArchiveIo,
} from "../../src/resources/session-archive.js";
import {
  freezeSessionDefinition, readFreezeGates, sessionAgentKey, sessionFreezeStoreKey,
} from "../../src/resources/session-freeze.js";
import { builtinManagedSessionsRule, createManagedSessionResourceType } from "../../src/rules/session-definition-type.js";
import { listFilesystemResources } from "../../src/resources/filesystem.js";
import { desiredFrom, reconcileNow } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";
import type { SpawnSpec } from "../../src/agents/workspace.js";

const goodDef = (over: Record<string, unknown> = {}) => ({
  workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default", ...over,
});

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("sessionArchiveDir", () => {
  test("BUTCHR_SESSION_ARCHIVE_DIR override wins", () => {
    expect(sessionArchiveDir({ BUTCHR_SESSION_ARCHIVE_DIR: "/custom/archive" }, "/defs")).toBe("/custom/archive");
  });

  test("trims whitespace on the override, same discipline as sessionDefinitionsPath", () => {
    expect(sessionArchiveDir({ BUTCHR_SESSION_ARCHIVE_DIR: "  /custom/archive  " }, "/defs")).toBe("/custom/archive");
  });

  test("default: a sibling of the definitions directory, suffixed -archive", () => {
    expect(sessionArchiveDir({}, "/home/x/.config/butchr/session-definitions")).toBe("/home/x/.config/butchr/session-definitions-archive");
  });

  test("default is derived from sessionDefinitionsPath() itself when no definitionsDir is given explicitly", () => {
    const env = { BUTCHR_SESSION_DEFINITIONS_DIR: "/explicit/defs" };
    expect(sessionArchiveDir(env)).toBe("/explicit/defs-archive");
  });
});

describe("assertArchiveDirDisjoint", () => {
  test("throws when the archive dir equals the definitions dir", () => {
    expect(() => assertArchiveDirDisjoint("/defs", "/defs")).toThrow(/must not equal or sit inside/);
  });

  test("throws when the archive dir is a subfolder of the definitions dir", () => {
    expect(() => assertArchiveDirDisjoint("/defs", "/defs/archive")).toThrow(/must not equal or sit inside/);
  });

  test("throws through a .. traversal that resolves inside the definitions dir", () => {
    expect(() => assertArchiveDirDisjoint("/defs", "/defs/sub/../nested")).toThrow(/must not equal or sit inside/);
  });

  test("does not throw for a genuine sibling", () => {
    expect(() => assertArchiveDirDisjoint("/defs", "/defs-archive")).not.toThrow();
  });

  test("does not throw for an unrelated directory entirely", () => {
    expect(() => assertArchiveDirDisjoint("/defs", "/somewhere/else")).not.toThrow();
  });
});

describe("archiveSessionDefinition / unarchiveSessionDefinition — real disk", () => {
  test("round-trip: archive then unarchive preserves the exact name and byte-for-byte content", async () => {
    const activeDir = await tmp("butchr-archive-active-");
    const archiveDir = join(activeDir, "..", "archive-dst");
    const content = JSON.stringify(goodDef({ role: "sentinel", execution: "persistent" }), null, 2) + "\n";
    await writeFile(join(activeDir, "a.json"), content);

    const io: SessionArchiveIo = { activeDir, archiveDir, ...defaultSessionArchiveIo() };
    const archived = await archiveSessionDefinition(io, "a.json");
    expect(archived).toEqual({ ok: true, path: join(archiveDir, "a.json") });
    expect(await readFile(join(archiveDir, "a.json"), "utf8")).toBe(content);

    const unarchived = await unarchiveSessionDefinition(io, "a.json");
    expect(unarchived).toEqual({ ok: true, path: join(activeDir, "a.json") });
    expect(await readFile(join(activeDir, "a.json"), "utf8")).toBe(content);
  });

  test("creates the archive directory if it does not exist yet", async () => {
    const activeDir = await tmp("butchr-archive-active-");
    const archiveDir = join(activeDir, "..", `butchr-archive-dst-${Math.random().toString(36).slice(2)}`);
    await writeFile(join(activeDir, "a.json"), JSON.stringify(goodDef()));
    const io: SessionArchiveIo = { activeDir, archiveDir, ...defaultSessionArchiveIo() };
    const result = await archiveSessionDefinition(io, "a.json");
    expect(result.ok).toBe(true);
    expect(await readFile(join(archiveDir, "a.json"), "utf8")).toBe(JSON.stringify(goodDef()));
  });

  test("refuses: source does not exist (archive direction) — nothing moved", async () => {
    const activeDir = await tmp("butchr-archive-active-");
    const archiveDir = await tmp("butchr-archive-dst-");
    const io: SessionArchiveIo = { activeDir, archiveDir, ...defaultSessionArchiveIo() };
    const result = await archiveSessionDefinition(io, "missing.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not exist");
  });

  test("refuses: source does not exist (unarchive direction) — nothing moved", async () => {
    const activeDir = await tmp("butchr-archive-active-");
    const archiveDir = await tmp("butchr-archive-dst-");
    const io: SessionArchiveIo = { activeDir, archiveDir, ...defaultSessionArchiveIo() };
    const result = await unarchiveSessionDefinition(io, "missing.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not exist");
  });

  test("refuses: destination already exists in the archive dir — active file untouched", async () => {
    const activeDir = await tmp("butchr-archive-active-");
    const archiveDir = await tmp("butchr-archive-dst-");
    await writeFile(join(activeDir, "a.json"), "ACTIVE");
    await writeFile(join(archiveDir, "a.json"), "ALREADY-ARCHIVED");
    const io: SessionArchiveIo = { activeDir, archiveDir, ...defaultSessionArchiveIo() };
    const result = await archiveSessionDefinition(io, "a.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("already exists");
    expect(await readFile(join(activeDir, "a.json"), "utf8")).toBe("ACTIVE"); // unmoved
    expect(await readFile(join(archiveDir, "a.json"), "utf8")).toBe("ALREADY-ARCHIVED"); // untouched
  });

  test("refuses: destination already exists in the active dir — archived file untouched", async () => {
    const activeDir = await tmp("butchr-archive-active-");
    const archiveDir = await tmp("butchr-archive-dst-");
    await writeFile(join(activeDir, "a.json"), "ALREADY-ACTIVE");
    await writeFile(join(archiveDir, "a.json"), "ARCHIVED");
    const io: SessionArchiveIo = { activeDir, archiveDir, ...defaultSessionArchiveIo() };
    const result = await unarchiveSessionDefinition(io, "a.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("already exists");
    expect(await readFile(join(activeDir, "a.json"), "utf8")).toBe("ALREADY-ACTIVE"); // untouched
    expect(await readFile(join(archiveDir, "a.json"), "utf8")).toBe("ARCHIVED"); // unmoved
  });
});

/** In-memory fake, for refusal/hook/EXDEV cases real disk can't easily force. */
function fakeArchiveIo(files: Record<string, string> = {}, opts: { renameFailures?: Array<NodeJS.ErrnoException | null>; mkdirFails?: boolean; onArchived?: OnArchived } = {}) {
  const renameFailures = [...(opts.renameFailures ?? [])];
  const io: SessionArchiveIo = {
    activeDir: "/active",
    archiveDir: "/archive",
    rename: async (from, to) => {
      const nextFailure = renameFailures.shift();
      if (nextFailure) throw nextFailure;
      if (!(from in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files[to] = files[from]!;
      delete files[from];
    },
    copyFile: async (from, to) => {
      if (!(from in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files[to] = files[from]!;
    },
    unlink: async (p) => { delete files[p]; },
    exists: async (p) => p in files,
    mkdir: async () => { if (opts.mkdirFails) throw new Error("permission denied"); },
    ...(opts.onArchived ? { onArchived: opts.onArchived } : {}),
  };
  return { io, files };
}

describe("archiveSessionDefinition — fake io", () => {
  test("refuses when the archive directory cannot be created; nothing moved", async () => {
    const { io, files } = fakeArchiveIo({ "/active/a.json": "CONTENT" }, { mkdirFails: true });
    const result = await archiveSessionDefinition(io, "a.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot create archive directory");
    expect(files).toEqual({ "/active/a.json": "CONTENT" });
  });

  test("cross-filesystem fallback: EXDEV on the direct rename triggers copy + rename-into-place + unlink-source, ending with the SAME content at the destination and nothing left at the source or under a temp name", async () => {
    const exdev = Object.assign(new Error("cross-device link"), { code: "EXDEV" }) as NodeJS.ErrnoException;
    const { io, files } = fakeArchiveIo({ "/active/a.json": "CONTENT" }, { renameFailures: [exdev] });
    const result = await archiveSessionDefinition(io, "a.json");
    expect(result).toEqual({ ok: true, path: "/archive/a.json" });
    expect(files).toEqual({ "/archive/a.json": "CONTENT" }); // exactly one key: no source, no stray temp file
  });

  test("a permanent failure on the fallback's own rename-into-place leaves the source untouched and cleans up its own temp file, never leaving a partial file at the destination name", async () => {
    const exdev = Object.assign(new Error("cross-device link"), { code: "EXDEV" }) as NodeJS.ErrnoException;
    const permFail = new Error("disk full");
    const { io, files } = fakeArchiveIo({ "/active/a.json": "CONTENT" }, { renameFailures: [exdev, permFail] });
    await expect(archiveSessionDefinition(io, "a.json")).rejects.toThrow("disk full");
    expect(files["/active/a.json"]).toBe("CONTENT"); // source never unlinked
    expect(files["/archive/a.json"]).toBeUndefined(); // destination never landed
    expect(Object.keys(files).filter((k) => k.endsWith(".tmp"))).toEqual([]); // temp file cleaned up
  });

  test("hook is called with the ACTIVE-path agent key and the new (archived) path, after a successful move", async () => {
    const calls: Array<{ agentKey: string; path: string }> = [];
    const onArchived: OnArchived = async (info) => { calls.push(info); };
    const { io } = fakeArchiveIo({ "/active/a.json": "CONTENT" }, { onArchived });
    const result = await archiveSessionDefinition(io, "a.json");
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ agentKey: sessionAgentKey("/active/a.json"), path: "/archive/a.json" }]);
  });

  test("hook is NOT called on a refusal (missing source)", async () => {
    const calls: unknown[] = [];
    const onArchived: OnArchived = async (info) => { calls.push(info); };
    const { io } = fakeArchiveIo({}, { onArchived });
    const result = await archiveSessionDefinition(io, "missing.json");
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a hook failure is reported on the result but does NOT undo the move", async () => {
    const onArchived: OnArchived = async () => { throw new Error("rocket-chat unreachable"); };
    const { io, files } = fakeArchiveIo({ "/active/a.json": "CONTENT" }, { onArchived });
    const result = await archiveSessionDefinition(io, "a.json");
    expect(result).toEqual({ ok: true, path: "/archive/a.json", hookError: "rocket-chat unreachable" });
    expect(files).toEqual({ "/archive/a.json": "CONTENT" }); // still moved
  });

  test("omitted hook (default no-op) does not throw and reports no hookError", async () => {
    const { io } = fakeArchiveIo({ "/active/a.json": "CONTENT" });
    const result = await archiveSessionDefinition(io, "a.json");
    expect(result).toEqual({ ok: true, path: "/archive/a.json" });
  });
});

describe("frozen state survives archive then unarchive — real InstanceFreezeStore on a temp root", () => {
  test("a definition frozen via BOTH gates comes back frozen via BOTH gates, at the SAME (restored) agent key", async () => {
    const activeDir = await tmp("butchr-archive-frz-active-");
    const archiveDir = await tmp("butchr-archive-frz-dst-");
    const storeRoot = await tmp("butchr-archive-frz-store-");
    const store = new InstanceFreezeStore(storeRoot);
    const path = join(activeDir, "mud-player-1.json");
    await writeFile(path, JSON.stringify(goodDef({ execution: "persistent", role: "sentinel" })));

    const freezeIo = { store, readFile: (p: string) => readFile(p, "utf8"), writeFile: (p: string, c: string) => writeFile(p, c) };
    await freezeSessionDefinition(freezeIo, path);
    expect(await readFreezeGates(freezeIo, path)).toEqual({ manifestFrozen: true, storeFrozen: true });

    const archiveIo: SessionArchiveIo = { activeDir, archiveDir, ...defaultSessionArchiveIo() };
    const archived = await archiveSessionDefinition(archiveIo, "mud-player-1.json");
    expect(archived.ok).toBe(true);

    const unarchived = await unarchiveSessionDefinition(archiveIo, "mud-player-1.json");
    expect(unarchived.ok).toBe(true);
    if (!unarchived.ok) throw new Error("unreachable");

    // Restored to the exact same path -> exact same agent key -> the STORE gate (path-derived) is still readable at it, and the MANIFEST gate (travelled with the file's own content) is still set.
    expect(unarchived.path).toBe(path);
    expect(sessionAgentKey(unarchived.path)).toBe(sessionAgentKey(path));
    expect(await readFreezeGates(freezeIo, unarchived.path)).toEqual({ manifestFrozen: true, storeFrozen: true });
  });

  test("an UNFROZEN definition comes back unfrozen (both gates) through the same round-trip", async () => {
    const activeDir = await tmp("butchr-archive-unfrz-active-");
    const archiveDir = await tmp("butchr-archive-unfrz-dst-");
    const storeRoot = await tmp("butchr-archive-unfrz-store-");
    const store = new InstanceFreezeStore(storeRoot);
    const path = join(activeDir, "a.json");
    await writeFile(path, JSON.stringify(goodDef()));
    const freezeIo = { store, readFile: (p: string) => readFile(p, "utf8"), writeFile: (p: string, c: string) => writeFile(p, c) };
    expect(await readFreezeGates(freezeIo, path)).toEqual({ manifestFrozen: false, storeFrozen: false });

    const archiveIo: SessionArchiveIo = { activeDir, archiveDir, ...defaultSessionArchiveIo() };
    await archiveSessionDefinition(archiveIo, "a.json");
    const unarchived = await unarchiveSessionDefinition(archiveIo, "a.json");
    if (!unarchived.ok) throw new Error("unreachable");
    expect(await readFreezeGates(freezeIo, unarchived.path)).toEqual({ manifestFrozen: false, storeFrozen: false });
  });

  test("archive does NOT clear or rewrite freeze-store state — a store-only freeze (manifest field false) is still readable as frozen at the archived path's WOULD-BE-restored identity", async () => {
    // This exercises the identity rule directly: the store key is path-derived, so a store-only freeze set
    // at the active path is invisible if you read it at the (different) archive path — exactly why archive
    // must not clear it, and exactly why `list --archived` (session-definition-manage.ts's `identityDir`)
    // reads the store gate against the WOULD-BE-ACTIVE path, never the file's current archived path.
    const activeDir = await tmp("butchr-archive-storeonly-active-");
    const archiveDir = await tmp("butchr-archive-storeonly-dst-");
    const storeRoot = await tmp("butchr-archive-storeonly-store-");
    const store = new InstanceFreezeStore(storeRoot);
    const path = join(activeDir, "a.json");
    await writeFile(path, JSON.stringify(goodDef()));
    await store.set(sessionFreezeStoreKey(path), true); // store-only: manifest field stays false

    const archiveIo: SessionArchiveIo = { activeDir, archiveDir, ...defaultSessionArchiveIo() };
    await archiveSessionDefinition(archiveIo, "a.json");
    const archivedPath = join(archiveDir, "a.json");

    expect((await store.read(sessionFreezeStoreKey(archivedPath))).frozen).toBe(false); // different key, never written
    expect((await store.read(sessionFreezeStoreKey(path))).frozen).toBe(true); // untouched by archive — same key, same value as before the move

    const unarchived = await unarchiveSessionDefinition(archiveIo, "a.json");
    if (!unarchived.ok) throw new Error("unreachable");
    expect(unarchived.path).toBe(path);
    expect((await store.read(sessionFreezeStoreKey(unarchived.path))).frozen).toBe(true); // restored to the SAME path -> SAME key -> reads frozen again
  });
});

/** Minimal Herd fixture, same shape session-freeze.test.ts's own `fakeHerdWithFreeze` uses, wired to a real freeze-gate check against `store`. */
function fakeHerdWithFreeze(store: { read(id: string): Promise<{ frozen: boolean }> }, initiallyRunning: string[] = []): Herd & { spawned: string[]; stopped: string[]; running: Set<string> } {
  const running = new Set(initiallyRunning);
  const spawned: string[] = [], stopped: string[] = [];
  return {
    running, spawned, stopped,
    async frozen(ids) {
      const out = new Set<string>();
      for (const id of ids) { if ((await store.read(`butchr:${id}`)).frozen) out.add(id); }
      return out;
    },
    async runningIssues() { return [...running]; },
    async staleIssues() { return []; },
    async spawn(sp: SpawnSpec) { spawned.push(sp.key); running.add(sp.key); },
    async stop(i: string) { stopped.push(i); running.delete(i); },
    async paneFor(i: string) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
  };
}

describe("reconcile-level: archiving a RUNNING persistent/sentinel definition stops it; unarchiving re-staffs it; a frozen one stays unstaffed after unarchive", () => {
  test("archive removes it from `desired` (directory listing drives eligibility) and reconcileNow stops the running agent; unarchive makes it desired again and reconcileNow spawns it", async () => {
    const activeDir = await tmp("butchr-archive-reconcile-active-");
    const archiveDir = await tmp("butchr-archive-reconcile-dst-");
    const path = join(activeDir, "mud-player-1.json");
    await writeFile(path, JSON.stringify(goodDef({ execution: "persistent", role: "sentinel" })));

    const rule = builtinManagedSessionsRule(activeDir);
    const resourceType = createManagedSessionResourceType({ rule, list: listFilesystemResources, read: (p: string) => readFile(p, "utf8") });
    const agentKey = sessionAgentKey(path);

    let units = await resourceType.discovery.search();
    let desired = desiredFrom(units, resourceType);
    expect([...desired.keys()]).toEqual([agentKey]);

    const herd = fakeHerdWithFreeze({ read: async () => ({ frozen: false }) }, [agentKey]); // already running
    await reconcileNow(herd, desired, {});
    expect(herd.running.has(agentKey)).toBe(true);
    expect(herd.stopped).toEqual([]);

    const archiveIo: SessionArchiveIo = { activeDir, archiveDir, ...defaultSessionArchiveIo() };
    const archived = await archiveSessionDefinition(archiveIo, "mud-player-1.json");
    expect(archived.ok).toBe(true);

    units = await resourceType.discovery.search();
    desired = desiredFrom(units, resourceType);
    expect(desired.size).toBe(0); // no longer a direct child of the active dir

    await reconcileNow(herd, desired, {});
    expect(herd.running.has(agentKey)).toBe(false);
    expect(herd.stopped).toEqual([agentKey]); // the SAME agent key, stopped by ordinary "no longer desired" reconcile — no archive-specific stop path exists or is needed

    const unarchived = await unarchiveSessionDefinition(archiveIo, "mud-player-1.json");
    expect(unarchived.ok).toBe(true);

    units = await resourceType.discovery.search();
    desired = desiredFrom(units, resourceType);
    expect([...desired.keys()]).toEqual([agentKey]); // same key: same path restored

    await reconcileNow(herd, desired, {});
    expect(herd.running.has(agentKey)).toBe(true);
    expect(herd.spawned).toEqual([agentKey]);
  });

  test("a definition frozen (store gate) before archiving is NOT staffed after unarchive", async () => {
    const activeDir = await tmp("butchr-archive-reconcile-frz-active-");
    const archiveDir = await tmp("butchr-archive-reconcile-frz-dst-");
    const storeRoot = await tmp("butchr-archive-reconcile-frz-store-");
    const store = new InstanceFreezeStore(storeRoot);
    const path = join(activeDir, "mud-player-2.json");
    await writeFile(path, JSON.stringify(goodDef({ execution: "persistent", role: "sentinel" })));

    const freezeIo = { store, readFile: (p: string) => readFile(p, "utf8"), writeFile: (p: string, c: string) => writeFile(p, c) };
    await freezeSessionDefinition(freezeIo, path); // both gates frozen

    const rule = builtinManagedSessionsRule(activeDir);
    const resourceType = createManagedSessionResourceType({ rule, list: listFilesystemResources, read: (p: string) => readFile(p, "utf8") });
    const agentKey = sessionAgentKey(path);

    const herd = fakeHerdWithFreeze(store, []); // never running: frozen manifest excludes it from eligible entirely
    let units = await resourceType.discovery.search();
    let desired = desiredFrom(units, resourceType);
    expect(desired.size).toBe(0); // frozen manifest -> not even a candidate

    const archiveIo: SessionArchiveIo = { activeDir, archiveDir, ...defaultSessionArchiveIo() };
    await archiveSessionDefinition(archiveIo, "mud-player-2.json");
    await unarchiveSessionDefinition(archiveIo, "mud-player-2.json");

    // Manifest frozen: true travelled with the file's own content through both moves, untouched — still not a candidate.
    units = await resourceType.discovery.search();
    desired = desiredFrom(units, resourceType);
    expect(desired.size).toBe(0);
    await reconcileNow(herd, desired, {});
    expect(herd.running.has(agentKey)).toBe(false);
    expect(herd.spawned).toEqual([]);
  });
});
