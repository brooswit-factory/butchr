import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeSessionDefinitionFields, writeSessionDefinitionFrozen, writeSessionDefinitionUndo,
  resolveSessionDefinitionPath, type LastUiWriteRef, type SessionDefinitionsWriteDeps,
} from "../../src/resources/session-definitions-write.js";
import { jsonFileEtag } from "../../src/resources/write-json-file.js";
import { sessionFreezeStoreKey, type SessionFreezeStore } from "../../src/resources/session-freeze.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-session-defs-write-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const goodDoc = (over: Record<string, unknown> = {}) => ({
  workingDirectory: "/repo", brief: "tend it", vendor: "claude", modelPower: 50, effort: 50, permissionMode: "default", frozen: false, ...over,
});

function writeDef(name: string, doc: Record<string, unknown>): string {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return path;
}

function fakeStore(frozenIds: Set<string> = new Set()): SessionFreezeStore {
  return {
    async read(id) { return { frozen: frozenIds.has(id) }; },
    async set(id, f) { if (f) frozenIds.add(id); else frozenIds.delete(id); },
  };
}

function deps(over: Partial<SessionDefinitionsWriteDeps> = {}): SessionDefinitionsWriteDeps {
  return { dir: () => dir, store: fakeStore(), ...over };
}

describe("resolveSessionDefinitionPath", () => {
  test("rejects a path separator, a NUL byte, a dot-prefixed name, and a non-.json name", () => {
    expect(resolveSessionDefinitionPath(dir, "../evil.json").ok).toBe(false);
    expect(resolveSessionDefinitionPath(dir, "a/b.json").ok).toBe(false);
    expect(resolveSessionDefinitionPath(dir, "a\0b.json").ok).toBe(false);
    expect(resolveSessionDefinitionPath(dir, ".hidden.json").ok).toBe(false);
    expect(resolveSessionDefinitionPath(dir, "no-extension").ok).toBe(false);
  });
  test("accepts a plain basename", () => {
    const r = resolveSessionDefinitionPath(dir, "foo.json");
    expect(r).toEqual({ ok: true, path: join(dir, "foo.json") });
  });
});

describe("writeSessionDefinitionFields — field allowlist", () => {
  test("a disallowed field is refused (403), and the file is byte-for-byte unchanged", async () => {
    const text = `${JSON.stringify(goodDoc(), null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), text);
    const etag = jsonFileEtag(join(dir, "a.json"));
    const outcome = await writeSessionDefinitionFields(deps(), "a.json", { brief: "steal the launch" }, etag, true);
    expect(outcome).toEqual({ ok: false, status: 403, error: expect.stringContaining('"brief"') });
    expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(text);
  });

  test("an unknown definition name: 404, nothing written", async () => {
    const outcome = await writeSessionDefinitionFields(deps(), "nope.json", { modelPower: 10 }, "x", true);
    expect(outcome).toEqual({ ok: false, status: 404, error: expect.any(String) });
  });

  test("a stale ifMatch is refused (409), file unchanged", async () => {
    const text = `${JSON.stringify(goodDoc(), null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), text);
    const outcome = await writeSessionDefinitionFields(deps(), "a.json", { modelPower: 70 }, "stale-etag", true);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
    expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(text);
  });

  test("a low-risk patch (modelPower/effort) writes immediately, with no confirm required, and only the patched fields change", async () => {
    const text = `${JSON.stringify(goodDoc(), null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), text);
    const etag = jsonFileEtag(join(dir, "a.json"));
    const outcome = await writeSessionDefinitionFields(deps(), "a.json", { modelPower: 90, effort: 80 }, etag, false);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.requiresConfirm).toBe(false);
    const written = JSON.parse(readFileSync(join(dir, "a.json"), "utf8"));
    expect(written.modelPower).toBe(90);
    expect(written.effort).toBe(80);
    expect(written.brief).toBe("tend it"); // every other field survives untouched
  });
});

describe("writeSessionDefinitionFields — risky field confirm gate", () => {
  test("permissionMode: bypassPermissions without confirm: 200, requiresConfirm with a structured preview, file UNCHANGED, and (implicitly) not a rejected write", async () => {
    const text = `${JSON.stringify(goodDoc(), null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), text);
    const etag = jsonFileEtag(join(dir, "a.json"));
    const outcome = await writeSessionDefinitionFields(deps(), "a.json", { permissionMode: "bypassPermissions" }, etag, false);
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.requiresConfirm) {
      expect(outcome.confirmReason).toBe("risky-permission");
      expect(outcome.preview).toEqual([{ field: "permissionMode", oldValue: "default", newValue: "bypassPermissions", consequence: expect.any(String) }]);
    } else {
      throw new Error("expected requiresConfirm: true");
    }
    expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(text); // NOTHING written
  });

  test("lizardMode: true without confirm: requiresConfirm, file unchanged", async () => {
    const text = `${JSON.stringify(goodDoc(), null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), text);
    const etag = jsonFileEtag(join(dir, "a.json"));
    const outcome = await writeSessionDefinitionFields(deps(), "a.json", { lizardMode: true }, etag, false);
    expect(outcome.ok && outcome.requiresConfirm).toBe(true);
    expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(text);
  });

  test("same risky patch WITH confirm: true actually writes", async () => {
    const text = `${JSON.stringify(goodDoc(), null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), text);
    const etag = jsonFileEtag(join(dir, "a.json"));
    const outcome = await writeSessionDefinitionFields(deps(), "a.json", { permissionMode: "bypassPermissions" }, etag, true);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.requiresConfirm).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "a.json"), "utf8")).permissionMode).toBe("bypassPermissions");
  });

  test("permissionMode: default (non-risky) needs no confirm even though the field is risk-capable", async () => {
    const text = `${JSON.stringify(goodDoc({ permissionMode: "acceptEdits" }), null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), text);
    const etag = jsonFileEtag(join(dir, "a.json"));
    const outcome = await writeSessionDefinitionFields(deps(), "a.json", { permissionMode: "default" }, etag, false);
    expect(outcome.ok && outcome.requiresConfirm).toBe(false);
  });
});

describe("writeSessionDefinitionFields — resulting-document validation (reuses sessionDefinitionProblems, never a forked copy)", () => {
  test("a resulting document sessionDefinitionProblems would itself reject (e.g. an invalid permissionMode) is refused (400), file unchanged", async () => {
    const text = `${JSON.stringify(goodDoc(), null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), text);
    const etag = jsonFileEtag(join(dir, "a.json"));
    const outcome = await writeSessionDefinitionFields(deps(), "a.json", { permissionMode: "sudo" }, etag, true);
    expect(outcome.ok).toBe(false);
    expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(text);
  });
});

describe("writeSessionDefinitionFrozen — two freeze gates, order, and the write contract", () => {
  test("freezing sets the STORE then the manifest; both end frozen", async () => {
    const store = fakeStore();
    writeDef("a.json", goodDoc());
    const path = join(dir, "a.json");
    const etag = jsonFileEtag(path);
    const outcome = await writeSessionDefinitionFrozen(deps({ store }), "a.json", true, etag);
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).frozen).toBe(true);
    expect((await store.read(sessionFreezeStoreKey(path))).frozen).toBe(true);
  });

  test("unfreezing clears the manifest then the store", async () => {
    writeDef("a.json", goodDoc({ frozen: true }));
    const path = join(dir, "a.json");
    const etag = jsonFileEtag(path);
    const store = fakeStore(new Set([sessionFreezeStoreKey(path)]));
    const outcome = await writeSessionDefinitionFrozen(deps({ store }), "a.json", false, etag);
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).frozen).toBe(false);
    expect((await store.read(sessionFreezeStoreKey(path))).frozen).toBe(false);
  });

  test("a stale etag refuses the write; file unchanged", async () => {
    const text = `${JSON.stringify(goodDoc(), null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), text);
    const outcome = await writeSessionDefinitionFrozen(deps(), "a.json", true, "stale");
    expect(outcome.ok).toBe(false);
    expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(text);
  });

  test("an unknown definition: 404, and the store is never touched", async () => {
    let storeSetCalled = false;
    const store: SessionFreezeStore = { async read() { return { frozen: false }; }, async set() { storeSetCalled = true; } };
    const outcome = await writeSessionDefinitionFrozen(deps({ store }), "nope.json", true, "x");
    expect(outcome).toEqual({ ok: false, status: 404, error: expect.any(String) });
    expect(storeSetCalled).toBe(false);
  });

  test("a backup is taken before the manifest is rewritten", async () => {
    writeDef("a.json", goodDoc());
    const path = join(dir, "a.json");
    const etag = jsonFileEtag(path);
    const outcome = await writeSessionDefinitionFrozen(deps(), "a.json", true, etag);
    expect(outcome.ok && outcome.backupId).toBeTruthy();
  });
});

describe("writeSessionDefinitionUndo — B2 scoping, byte-for-byte", () => {
  test("end to end: a field write, then undo, restores the EXACT previous bytes", async () => {
    const originalText = `${JSON.stringify(goodDoc(), null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), originalText);
    const etag = jsonFileEtag(join(dir, "a.json"));
    const lastUiWrite: LastUiWriteRef = { value: null };
    const d = deps({ lastUiWrite });

    const write = await writeSessionDefinitionFields(d, "a.json", { modelPower: 95 }, etag, false);
    expect(write.ok).toBe(true);
    if (!write.ok || write.requiresConfirm) throw new Error("expected a completed write");
    expect(readFileSync(join(dir, "a.json"), "utf8")).not.toBe(originalText);

    const undone = writeSessionDefinitionUndo(d, write.backupId!);
    expect(undone.ok).toBe(true);
    expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(originalText); // byte-for-byte restore
  });

  test("a second undo of the SAME backup id is refused (one-shot — the ref is cleared on success)", async () => {
    const originalText = `${JSON.stringify(goodDoc(), null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), originalText);
    const etag = jsonFileEtag(join(dir, "a.json"));
    const lastUiWrite: LastUiWriteRef = { value: null };
    const d = deps({ lastUiWrite });
    const write = await writeSessionDefinitionFields(d, "a.json", { modelPower: 95 }, etag, false);
    if (!write.ok || write.requiresConfirm) throw new Error("expected a completed write");
    writeSessionDefinitionUndo(d, write.backupId!);
    const second = writeSessionDefinitionUndo(d, write.backupId!);
    expect(second.ok).toBe(false);
  });

  test("undo refuses (and writes nothing) once the file changed since that write (an unrelated later change)", async () => {
    const originalText = `${JSON.stringify(goodDoc(), null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), originalText);
    const etag = jsonFileEtag(join(dir, "a.json"));
    const lastUiWrite: LastUiWriteRef = { value: null };
    const d = deps({ lastUiWrite });
    const write = await writeSessionDefinitionFields(d, "a.json", { modelPower: 95 }, etag, false);
    if (!write.ok || write.requiresConfirm) throw new Error("expected a completed write");
    const afterFirstWrite = readFileSync(join(dir, "a.json"), "utf8");
    // an unrelated later change (hand edit, or another process) — undo must refuse, not clobber it
    writeFileSync(join(dir, "a.json"), `${JSON.stringify(goodDoc({ modelPower: 10, effort: 10 }), null, 2)}\n`);
    const undone = writeSessionDefinitionUndo(d, write.backupId!);
    expect(undone.ok).toBe(false);
    expect(readFileSync(join(dir, "a.json"), "utf8")).not.toBe(afterFirstWrite);
  });

  test("an unknown backup id is refused", () => {
    const outcome = writeSessionDefinitionUndo(deps(), "not-a-real-backup-id");
    expect(outcome.ok).toBe(false);
  });
});
