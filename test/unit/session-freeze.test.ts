import { describe, expect, test } from "bun:test";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import { MANAGED_SESSIONS_RULE_ID, builtinManagedSessionsRule, createManagedSessionResourceType } from "../../src/rules/session-definition-type.js";
import type { Herd } from "../../src/agents/herd.js";
import type { SpawnSpec } from "../../src/agents/workspace.js";
import { desiredFrom, reconcileNow } from "../../src/daemon/loop.js";
import {
  defaultSessionFreezeIo, freezeSessionDefinition, readFreezeGates, readStoreFrozen, sessionAgentKey,
  sessionFreezeStoreKey, unfreezeSessionDefinition, type SessionFreezeStore,
} from "../../src/resources/session-freeze.js";
import { instanceFreezeStore } from "@brooswit/drovr-events";

/** A minimal valid definition body, as it would be written to a *.json file. */
const goodDef = (over: Record<string, unknown> = {}) => ({
  workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default", ...over,
});

/** In-memory freeze store — same shape `instanceFreezeStore`/`new InstanceFreezeStore(tmp)` present, no real disk. */
function fakeStore(initial: Record<string, boolean> = {}): SessionFreezeStore & { calls: Array<["read" | "set", string, boolean?]> } {
  const state = new Map(Object.entries(initial));
  const calls: Array<["read" | "set", string, boolean?]> = [];
  return {
    calls,
    async read(id) {
      calls.push(["read", id]);
      return { frozen: state.get(id) ?? false };
    },
    async set(id, frozen) {
      calls.push(["set", id, frozen]);
      state.set(id, frozen);
      return { version: 1, instanceId: id, frozen, updatedAt: "" };
    },
  };
}

/** In-memory manifest file backing, mutable so freeze/unfreeze rewrites are observable. */
function fakeManifests(files: Record<string, string>) {
  const readFile = async (path: string): Promise<string> => {
    if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return files[path]!;
  };
  const writeFile = async (path: string, contents: string): Promise<void> => {
    files[path] = contents;
  };
  return { files, readFile, writeFile };
}

describe("sessionAgentKey / sessionFreezeStoreKey", () => {
  test("matches the exact agent-key codec searchSessionDefinitions builds a match's agentKey from", () => {
    const path = "/defs/foo.json";
    expect(sessionAgentKey(path)).toBe(encodeAgentKey({ resourceProvider: "filesystem", ruleId: MANAGED_SESSIONS_RULE_ID, resourceId: path }));
  });

  test("the store key is HerdrHerd.frozen()'s own `butchr:<agentKey>` shape", () => {
    const path = "/defs/foo.json";
    expect(sessionFreezeStoreKey(path)).toBe(`butchr:${sessionAgentKey(path)}`);
  });
});

describe("defaultSessionFreezeIo — production wiring", () => {
  test("uses the exact same instanceFreezeStore singleton HerdrHerd.frozen() reads (src/agents/herd.ts) — same store, no separate freeze mechanism", () => {
    expect(defaultSessionFreezeIo().store).toBe(instanceFreezeStore);
  });
});

describe("freezeSessionDefinition / unfreezeSessionDefinition — the two gates and their order", () => {
  test("freeze sets the STORE gate FIRST, then the MANIFEST gate", async () => {
    const store = fakeStore();
    const { readFile, writeFile } = fakeManifests({ "/defs/a.json": JSON.stringify(goodDef()) });
    const order: string[] = [];
    const io = {
      store: { read: store.read, set: async (id: string, f: boolean) => { order.push("store"); return store.set(id, f); } },
      readFile: async (p: string) => { const v = await readFile(p); return v; },
      writeFile: async (p: string, c: string) => { order.push("manifest"); return writeFile(p, c); },
    };
    const gates = await freezeSessionDefinition(io, "/defs/a.json");
    expect(gates).toEqual({ manifestFrozen: true, storeFrozen: true });
    expect(order).toEqual(["store", "manifest"]);
  });

  test("unfreeze clears the MANIFEST gate FIRST, then the STORE gate", async () => {
    const key = sessionFreezeStoreKey("/defs/a.json");
    const store = fakeStore({ [key]: true });
    const { readFile, writeFile } = fakeManifests({ "/defs/a.json": JSON.stringify(goodDef({ frozen: true })) });
    const order: string[] = [];
    const io = {
      store: { read: store.read, set: async (id: string, f: boolean) => { order.push("store"); return store.set(id, f); } },
      readFile,
      writeFile: async (p: string, c: string) => { order.push("manifest"); return writeFile(p, c); },
    };
    const gates = await unfreezeSessionDefinition(io, "/defs/a.json");
    expect(gates).toEqual({ manifestFrozen: false, storeFrozen: false });
    expect(order).toEqual(["manifest", "store"]);
  });

  test("freeze preserves every OTHER manifest field, only touching frozen", async () => {
    const store = fakeStore();
    const def = goodDef({ role: "sentinel", execution: "persistent", mcpServers: [{ name: "x", type: "http", url: "https://x", channel: true }] });
    const { files, readFile, writeFile } = fakeManifests({ "/defs/a.json": JSON.stringify(def) });
    await freezeSessionDefinition({ store, readFile, writeFile }, "/defs/a.json");
    const rewritten = JSON.parse(files["/defs/a.json"]!);
    expect(rewritten).toEqual({ ...def, frozen: true });
  });

  test("freeze is idempotent: starting with BOTH gates already open ends with both still open", async () => {
    const path = "/defs/a.json";
    const store = fakeStore({ [sessionFreezeStoreKey(path)]: true });
    const { readFile, writeFile } = fakeManifests({ [path]: JSON.stringify(goodDef({ frozen: true })) });
    const gates = await freezeSessionDefinition({ store, readFile, writeFile }, path);
    expect(gates).toEqual({ manifestFrozen: true, storeFrozen: true });
  });

  test("freeze from a manifest-only-frozen start (store not yet frozen) ends with BOTH gates open", async () => {
    const path = "/defs/a.json";
    const store = fakeStore(); // store defaults to not-frozen
    const { readFile, writeFile } = fakeManifests({ [path]: JSON.stringify(goodDef({ frozen: true })) });
    expect(await readStoreFrozen(store, path)).toBe(false);
    const gates = await freezeSessionDefinition({ store, readFile, writeFile }, path);
    expect(gates).toEqual({ manifestFrozen: true, storeFrozen: true });
  });

  test("freeze from a store-only-frozen start (manifest field false) ends with BOTH gates open", async () => {
    const path = "/defs/a.json";
    const store = fakeStore({ [sessionFreezeStoreKey(path)]: true });
    const { readFile, writeFile } = fakeManifests({ [path]: JSON.stringify(goodDef({ frozen: false })) });
    const gates = await freezeSessionDefinition({ store, readFile, writeFile }, path);
    expect(gates).toEqual({ manifestFrozen: true, storeFrozen: true });
  });

  test("unfreeze is idempotent: starting with BOTH gates already closed ends with both still closed", async () => {
    const path = "/defs/a.json";
    const store = fakeStore({ [sessionFreezeStoreKey(path)]: false });
    const { readFile, writeFile } = fakeManifests({ [path]: JSON.stringify(goodDef({ frozen: false })) });
    const gates = await unfreezeSessionDefinition({ store, readFile, writeFile }, path);
    expect(gates).toEqual({ manifestFrozen: false, storeFrozen: false });
  });

  test("unfreeze from only one gate set (store frozen, manifest not) ends with BOTH gates closed", async () => {
    const path = "/defs/a.json";
    const store = fakeStore({ [sessionFreezeStoreKey(path)]: true });
    const { readFile, writeFile } = fakeManifests({ [path]: JSON.stringify(goodDef({ frozen: false })) });
    const gates = await unfreezeSessionDefinition({ store, readFile, writeFile }, path);
    expect(gates).toEqual({ manifestFrozen: false, storeFrozen: false });
  });
});

describe("readFreezeGates / readStoreFrozen", () => {
  test("reports both gates independently for a valid definition", async () => {
    const path = "/defs/a.json";
    const store = fakeStore({ [sessionFreezeStoreKey(path)]: true });
    const { readFile } = fakeManifests({ [path]: JSON.stringify(goodDef({ frozen: false })) });
    expect(await readFreezeGates({ store, readFile }, path)).toEqual({ manifestFrozen: false, storeFrozen: true });
  });

  test("an unreadable store fails CLOSED (reported frozen), same discipline as HerdrHerd.frozen()", async () => {
    const store: SessionFreezeStore = { read: async () => { throw new Error("disk on fire"); }, set: async () => {} };
    expect(await readStoreFrozen(store, "/defs/a.json")).toBe(true);
  });
});

describe("freeze holds through a file rename ONLY via the manifest flag — the double-gate rationale", () => {
  test("after a 'rename' (content copied to a new path), the STORE gate (keyed to the OLD path) does not follow, but the MANIFEST gate does", async () => {
    const oldPath = "/defs/mud-player-1.json";
    const newPath = "/defs/archive/mud-player-1.json";
    const store = fakeStore();
    const manifests = fakeManifests({ [oldPath]: JSON.stringify(goodDef({ execution: "persistent", role: "sentinel" })) });
    await freezeSessionDefinition({ store, readFile: manifests.readFile, writeFile: manifests.writeFile }, oldPath);
    expect(sessionFreezeStoreKey(oldPath)).not.toBe(sessionFreezeStoreKey(newPath));

    // Simulate the rename: same bytes, new path; the store is never told about the move.
    manifests.files[newPath] = manifests.files[oldPath]!;
    delete manifests.files[oldPath];

    const gatesAtNewPath = await readFreezeGates({ store, readFile: manifests.readFile }, newPath);
    expect(gatesAtNewPath.manifestFrozen).toBe(true); // survived the move
    expect(gatesAtNewPath.storeFrozen).toBe(false); // did NOT — a fresh key, never written
  });
});

/** A minimal Herd fixture with `frozen()` wired to a real freeze-gate check, exactly as `HerdrHerd.frozen()` does (src/agents/herd.ts) — a fake herd exercising the SAME store this file's freeze/unfreeze functions write to. */
function fakeHerdWithFreeze(store: SessionFreezeStore, initiallyRunning: string[] = []): Herd & { spawned: string[]; stopped: string[]; running: Set<string> } {
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

describe("reconcile-level: an explicit STORE freeze wins over persistence/sentinel status (BUTCHR-454 DoD)", () => {
  const rule = () => builtinManagedSessionsRule("/defs");

  test("a running persistent/sentinel definition, frozen ONLY via the store (manifest frozen: false), is removed from `desired` and stopped by reconcileNow", async () => {
    const path = "/defs/mud-player-1.json";
    const files: Record<string, string> = { [path]: JSON.stringify(goodDef({ execution: "persistent", role: "sentinel", frozen: false })) };
    const list = async () => [{ path, kind: "file" as const, name: "mud-player-1.json", size: 10, mtimeMs: 1 }];
    const read = async (p: string) => files[p]!;
    const resourceType = createManagedSessionResourceType({ rule: rule(), list, read });
    const units = await resourceType.discovery.search();
    const desired = desiredFrom(units, resourceType);
    const agentKey = sessionAgentKey(path);
    expect([...desired.keys()]).toEqual([agentKey]); // eligible: manifest frozen is false

    const store = fakeStore();
    const herd = fakeHerdWithFreeze(store, [agentKey]); // already running

    // Not frozen yet: reconcile leaves it running, untouched.
    await reconcileNow(herd, desired, {});
    expect(herd.running.has(agentKey)).toBe(true);
    expect(herd.stopped).toEqual([]);

    // Freeze via the STORE gate only (manifest untouched) — exactly what a racing
    // freeze-then-crash-before-manifest-write would leave, and enough on its own
    // per HerdrHerd.frozen()'s own store-only read.
    await store.set(`butchr:${agentKey}`, true);

    await reconcileNow(herd, desired, {});
    expect(herd.running.has(agentKey)).toBe(false);
    expect(herd.stopped).toEqual([agentKey]);
  });

  test("unfreezing (via unfreezeSessionDefinition) makes the SAME persistent/sentinel definition eligible again next poll", async () => {
    const path = "/defs/mud-player-1.json";
    const files: Record<string, string> = { [path]: JSON.stringify(goodDef({ execution: "persistent", role: "sentinel", frozen: true })) };
    const store = fakeStore({ [sessionFreezeStoreKey(path)]: true });
    const list = async () => [{ path, kind: "file" as const, name: "mud-player-1.json", size: 10, mtimeMs: 1 }];
    const read = async (p: string) => files[p]!;
    const resourceType = createManagedSessionResourceType({ rule: rule(), list, read });
    const agentKey = sessionAgentKey(path);
    const herd = fakeHerdWithFreeze(store, []); // not currently running (frozen, so never spawned)

    // Frozen manifest -> not even a candidate unit -> not desired -> reconcile spawns nothing.
    let units = await resourceType.discovery.search();
    let desired = desiredFrom(units, resourceType);
    expect(desired.size).toBe(0);
    await reconcileNow(herd, desired, {});
    expect(herd.running.has(agentKey)).toBe(false);

    await unfreezeSessionDefinition({ store, readFile: read, writeFile: async (p, c) => { files[p] = c; } }, path);

    units = await resourceType.discovery.search();
    desired = desiredFrom(units, resourceType);
    expect([...desired.keys()]).toEqual([agentKey]);
    await reconcileNow(herd, desired, {});
    expect(herd.running.has(agentKey)).toBe(true);
    expect(herd.spawned).toEqual([agentKey]);
  });
});
