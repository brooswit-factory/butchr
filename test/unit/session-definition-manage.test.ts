import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import { MANAGED_SESSIONS_RULE_ID } from "../../src/rules/session-definition-type.js";
import type { FilesystemQuery } from "../../src/resources/filesystem-query.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";
import {
  createSessionDefinition, listSessionDefinitions, showSessionDefinition,
} from "../../src/resources/session-definition-manage.js";
import type { SessionFreezeStore } from "../../src/resources/session-freeze.js";
import { absPath } from "../helpers/abs-path";

const res = (path: string, over: Partial<FilesystemResource> = {}): FilesystemResource =>
  ({ path, kind: "file", name: basename(path), size: 10, mtimeMs: 1000, ...over });

const goodDef = (over: Record<string, unknown> = {}) => ({
  workingDirectory: absPath("repo", "project"), brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default", ...over,
});

function fakeFiles(files: Record<string, string>) {
  const list = async (_q: FilesystemQuery): Promise<FilesystemResource[]> => Object.keys(files).map((p) => res(p));
  const read = async (path: string): Promise<string> => {
    if (!(path in files)) throw Object.assign(new Error(`ENOENT: no such file ${path}`), { code: "ENOENT" });
    return files[path]!;
  };
  return { list, read };
}

function fakeStore(frozenIds: Set<string> = new Set()): SessionFreezeStore {
  return {
    async read(id) { return { frozen: frozenIds.has(id) }; },
    async set(id, f) { if (f) frozenIds.add(id); else frozenIds.delete(id); },
  };
}

const missingRootList = async (): Promise<FilesystemResource[]> => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };

describe("listSessionDefinitions — everything, not just the eligible subset", () => {
  test("a valid definition reports vendor/tier/role/execution and both freeze gates", async () => {
    const text = JSON.stringify(goodDef({ role: "sentinel", execution: "persistent" }));
    const { list, read } = fakeFiles({ [absPath("defs", "a.json")]: text });
    const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: MANAGED_SESSIONS_RULE_ID, resourceId: absPath("defs", "a.json") });
    const store = fakeStore(new Set([`butchr:${agentKey}`]));
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store });
    expect(entries).toEqual([{
      name: "a.json", path: absPath("defs", "a.json"), agentKey, valid: true, problems: [],
      vendor: "claude", tier: "tier1", role: "sentinel", execution: "persistent",
      account: "none", permissionMode: "default", workingDirectory: absPath("repo", "project"), mcpServerNames: [],
      manifestFrozen: false, storeFrozen: true,
      freezeControllers: [], unfreezeControllers: [],
      // FACTORY-667: `etag` is the raw file text's own sha256 — computed
      // here the same way `listSessionDefinitions` itself does, never a
      // hardcoded literal that would silently stop proving anything.
      etag: createHash("sha256").update(text, "utf8").digest("hex"),
    }]);
  });

  test("FACTORY-72: account, permissionMode, workingDirectory and mcpServerNames (names only, never the full binding) are surfaced", async () => {
    const { list, read } = fakeFiles({
      [absPath("defs", "b.json")]: JSON.stringify(goodDef({
        account: "temporary",
        permissionMode: "bypassPermissions",
        workingDirectory: absPath("repo", "other"),
        mcpServers: [{ name: "rocketr", type: "http", url: "https://mcp.internal/rocketr", headersEnvVar: "ROCKETR_HEADERS", channel: true }],
      })),
    });
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store: fakeStore() });
    expect(entries[0]!.account).toBe("temporary");
    expect(entries[0]!.permissionMode).toBe("bypassPermissions");
    expect(entries[0]!.workingDirectory).toBe(absPath("repo", "other"));
    expect(entries[0]!.mcpServerNames).toEqual(["rocketr"]);
    expect(JSON.stringify(entries[0]!)).not.toContain("ROCKETR_HEADERS");
  });

  test("a definition's own freeze/unfreeze grant fields are surfaced verbatim", async () => {
    const { list, read } = fakeFiles({
      [absPath("defs", "target.json")]: JSON.stringify(goodDef({ freezeControllers: ["director"], unfreezeControllers: ["director", "operator-tool"] })),
    });
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store: fakeStore() });
    expect(entries[0]!.freezeControllers).toEqual(["director"]);
    expect(entries[0]!.unfreezeControllers).toEqual(["director", "operator-tool"]);
  });

  test("an invalid definition is listed WITH its problems, never hidden — manifestFrozen is undefined (unknowable)", async () => {
    const { list, read } = fakeFiles({ [absPath("defs", "bad.json")]: JSON.stringify({ ...goodDef(), vendor: "not-a-vendor" }) });
    const store = fakeStore();
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.valid).toBe(false);
    expect(entries[0]!.manifestFrozen).toBeUndefined();
    expect(entries[0]!.storeFrozen).toBe(false);
    expect(entries[0]!.problems.some((p) => p.includes("vendor must be one of"))).toBe(true);
  });

  test("invalid JSON is listed too, with the parse error as its problem", async () => {
    const { list, read } = fakeFiles({ [absPath("defs", "bad.json")]: "not json" });
    const store = fakeStore();
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store });
    expect(entries[0]!.valid).toBe(false);
    expect(entries[0]!.problems[0]).toContain("invalid JSON");
  });

  test("a missing definitions directory is an empty list, never an error", async () => {
    const store = fakeStore();
    const entries = await listSessionDefinitions({ dir: absPath("nope"), list: missingRootList, read: async () => "", store });
    expect(entries).toEqual([]);
  });

  test("a path whose percent-encoded id would overflow the workspace directory-name limit is listed as invalid, with that specific problem, distinctly from a schema failure", async () => {
    const overlong = `/defs/${"x".repeat(300)}.json`;
    const { list, read } = fakeFiles({ [overlong]: JSON.stringify(goodDef()) });
    const store = fakeStore();
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.valid).toBe(false);
    expect(entries[0]!.problems[0]).toContain("workspace directory-name limit");
  });

  test("BUTCHR-455 review fix: a hidden (dotfile) basename is never listed, even with a perfectly valid manifest — not shown as valid, not shown as invalid, not shown at all", async () => {
    const { list, read } = fakeFiles({
      [absPath("defs", ".abc123.tmp")]: JSON.stringify(goodDef()),
      [absPath("defs", "good.json")]: JSON.stringify(goodDef()),
    });
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store: fakeStore() });
    expect(entries.map((e) => e.name)).toEqual(["good.json"]);
  });

  test("FACTORY-755: a byte-identical *.json.bak-* backup is never listed, even though it is a byte-identical valid manifest — only the real .json is", async () => {
    const body = JSON.stringify(goodDef());
    const { list, read } = fakeFiles({
      [absPath("defs", "admin-agentsafety.json")]: body,
      [absPath("defs", "admin-agentsafety.json.bak-1008")]: body,
    });
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store: fakeStore() });
    expect(entries.map((e) => e.name)).toEqual(["admin-agentsafety.json"]);
  });

  test("FACTORY-755: a plain non-definition file (notes.txt) is never listed", async () => {
    const { list, read } = fakeFiles({
      [absPath("defs", "notes.txt")]: "just some notes",
      [absPath("defs", "good.json")]: JSON.stringify(goodDef()),
    });
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store: fakeStore() });
    expect(entries.map((e) => e.name)).toEqual(["good.json"]);
  });

  test("FACTORY-755: a genuinely malformed .json file is STILL listed as invalid — the new filter only excludes non-.json basenames, never a bad .json", async () => {
    const { list, read } = fakeFiles({ [absPath("defs", "broken.json")]: "{not json" });
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store: fakeStore() });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("broken.json");
    expect(entries[0]!.valid).toBe(false);
  });

  test("FACTORY-755: uppercase .JSON is NOT accepted (case-sensitive extension match, decided+pinned here) — never listed", async () => {
    const { list, read } = fakeFiles({ [absPath("defs", "weird.JSON")]: JSON.stringify(goodDef()) });
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store: fakeStore() });
    expect(entries).toEqual([]);
  });

  test("FACTORY-755: a bare basename of literally \".json\" is dot-prefixed, so it hits the hidden-file gate first, not the new extension filter — never listed", async () => {
    const { list, read } = fakeFiles({ [absPath("defs", ".json")]: JSON.stringify(goodDef()) });
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store: fakeStore() });
    expect(entries).toEqual([]);
  });

  test("a mix of valid, invalid and frozen definitions all appear, none hidden", async () => {
    const { list, read } = fakeFiles({
      [absPath("defs", "good.json")]: JSON.stringify(goodDef()),
      [absPath("defs", "bad.json")]: "not json",
      [absPath("defs", "frozen.json")]: JSON.stringify(goodDef({ frozen: true })),
    });
    const store = fakeStore();
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store });
    expect(entries.map((e) => e.name).sort()).toEqual(["bad.json", "frozen.json", "good.json"]);
    expect(entries.find((e) => e.name === "frozen.json")!.manifestFrozen).toBe(true);
    expect(entries.find((e) => e.name === "bad.json")!.valid).toBe(false);
  });
});

describe("listSessionDefinitions — identityDir (BUTCHR-455, backs `list --archived`)", () => {
  test("agentKey/storeFrozen are computed against identityDir + the resource's own basename, not its actual (archived) path", async () => {
    const { list, read } = fakeFiles({ [absPath("archive", "a.json")]: JSON.stringify(goodDef()) });
    const wouldBeActivePath = absPath("defs", "a.json");
    const agentKeyAtArchivePath = encodeAgentKey({ resourceProvider: "filesystem", ruleId: MANAGED_SESSIONS_RULE_ID, resourceId: absPath("archive", "a.json") });
    const agentKeyAtActivePath = encodeAgentKey({ resourceProvider: "filesystem", ruleId: MANAGED_SESSIONS_RULE_ID, resourceId: wouldBeActivePath });
    const store = fakeStore(new Set([`butchr:${agentKeyAtActivePath}`])); // frozen ONLY at the would-be-active key
    const entries = await listSessionDefinitions({ dir: absPath("archive"), identityDir: absPath("defs"), list, read, store });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe(absPath("archive", "a.json")); // still reports where the file actually lives
    expect(entries[0]!.agentKey).toBe(agentKeyAtActivePath);
    expect(entries[0]!.agentKey).not.toBe(agentKeyAtArchivePath);
    expect(entries[0]!.storeFrozen).toBe(true); // read at the identity path, where the store entry actually is
  });

  test("omitted identityDir: identity is computed from dir (unchanged pre-BUTCHR-455 behaviour)", async () => {
    const { list, read } = fakeFiles({ [absPath("defs", "a.json")]: JSON.stringify(goodDef()) });
    const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: MANAGED_SESSIONS_RULE_ID, resourceId: absPath("defs", "a.json") });
    const entries = await listSessionDefinitions({ dir: absPath("defs"), list, read, store: fakeStore() });
    expect(entries[0]!.agentKey).toBe(agentKey);
  });

  test("manifestFrozen is unaffected by identityDir — it always reads the file's own actual content", async () => {
    const { list, read } = fakeFiles({ [absPath("archive", "a.json")]: JSON.stringify(goodDef({ frozen: true })) });
    const entries = await listSessionDefinitions({ dir: absPath("archive"), identityDir: absPath("defs"), list, read, store: fakeStore() });
    expect(entries[0]!.manifestFrozen).toBe(true);
  });
});

describe("showSessionDefinition", () => {
  test("finds by exact file name", async () => {
    const { list, read } = fakeFiles({ [absPath("defs", "a.json")]: JSON.stringify(goodDef()) });
    const result = await showSessionDefinition({ dir: absPath("defs"), list, read, store: fakeStore() }, "a.json");
    expect(result.found).toBe(true);
  });

  test("finds by bare name (no .json)", async () => {
    const { list, read } = fakeFiles({ [absPath("defs", "a.json")]: JSON.stringify(goodDef()) });
    const result = await showSessionDefinition({ dir: absPath("defs"), list, read, store: fakeStore() }, "a");
    expect(result.found).toBe(true);
  });

  test("reports not-found for an unknown name", async () => {
    const { list, read } = fakeFiles({});
    const result = await showSessionDefinition({ dir: absPath("defs"), list, read, store: fakeStore() }, "missing");
    expect(result.found).toBe(false);
  });
});

describe("createSessionDefinition", () => {
  function fakeCreateDeps(existing: Set<string> = new Set()) {
    const written: Record<string, string> = {};
    return {
      dir: absPath("defs"),
      exists: async (p: string) => existing.has(p),
      write: async (p: string, c: string) => { written[p] = c; },
      written,
    };
  }

  test("validates through the SAME validator the daemon uses, then writes the RAW (unexpanded) fields atomically", async () => {
    const deps = fakeCreateDeps();
    const result = await createSessionDefinition(deps, "new-agent", {
      workingDirectory: "~/code/some-project", brief: "Do the thing.", vendor: "claude", tier: "tier1", permissionMode: "default",
    });
    expect(result).toEqual({ ok: true, path: absPath("defs", "new-agent.json") });
    const written = JSON.parse(deps.written[absPath("defs", "new-agent.json")]!);
    expect(written.workingDirectory).toBe("~/code/some-project"); // NOT expanded to an absolute path
    expect(written).not.toHaveProperty("execution"); // omitted optional fields stay omitted, not defaulted
  });

  test("appends .json when the name omits it", async () => {
    const deps = fakeCreateDeps();
    const result = await createSessionDefinition(deps, "bare-name", goodDef() as never);
    expect(result).toEqual({ ok: true, path: absPath("defs", "bare-name.json") });
  });

  test("refuses to overwrite an existing definition of the same name", async () => {
    const deps = fakeCreateDeps(new Set([absPath("defs", "dup.json")]));
    const result = await createSessionDefinition(deps, "dup", goodDef() as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("already exists");
    expect(deps.written).toEqual({});
  });

  test("refuses an invalid definition, naming every problem, and never writes", async () => {
    const deps = fakeCreateDeps();
    const result = await createSessionDefinition(deps, "bad", { ...goodDef(), vendor: "not-a-vendor" } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("vendor must be one of");
    expect(deps.written).toEqual({});
  });

  test("BUTCHR-455: refuses a name that already exists in the archive directory, never writes", async () => {
    const deps = fakeCreateDeps(new Set([absPath("archive", "dup.json")]));
    const result = await createSessionDefinition({ ...deps, archiveDir: absPath("archive") }, "dup", goodDef() as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("already exists");
    expect(deps.written).toEqual({});
  });

  test("BUTCHR-455: an archive-name collision check is skipped entirely when no archiveDir is given (unchanged pre-BUTCHR-455 behaviour)", async () => {
    const deps = fakeCreateDeps(new Set([absPath("archive", "dup.json")])); // "exists" would say yes if ever asked about this path
    const result = await createSessionDefinition(deps, "dup", goodDef() as never); // no archiveDir
    expect(result.ok).toBe(true);
  });

  test("freezeControllers/unfreezeControllers, when given, are written verbatim; omitted otherwise", async () => {
    const deps = fakeCreateDeps();
    await createSessionDefinition(deps, "granted", { ...goodDef(), freezeControllers: ["director"], unfreezeControllers: [] } as never);
    const written = JSON.parse(deps.written[absPath("defs", "granted.json")]!);
    expect(written.freezeControllers).toEqual(["director"]);
    expect(written.unfreezeControllers).toEqual([]);
    await createSessionDefinition(deps, "ungranted", goodDef() as never);
    expect(JSON.parse(deps.written[absPath("defs", "ungranted.json")]!)).not.toHaveProperty("freezeControllers");
  });

  test("both claude and codex vendors validate and write", async () => {
    const deps = fakeCreateDeps();
    const claude = await createSessionDefinition(deps, "c1", { workingDirectory: absPath("x"), brief: "b", vendor: "claude", tier: "tier1", permissionMode: "default" });
    const codex = await createSessionDefinition(deps, "c2", { workingDirectory: absPath("x"), brief: "b", vendor: "codex", tier: "tier2", permissionMode: "auto" });
    expect(claude.ok).toBe(true);
    expect(codex.ok).toBe(true);
  });

  test("real disk (temp dir), default exists/write: creates, then refuses to overwrite the same real file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "butchr-session-create-"));
    const first = await createSessionDefinition({ dir }, "on-disk", { workingDirectory: absPath("x"), brief: "b", vendor: "claude", tier: "tier1", permissionMode: "default" });
    expect(first).toEqual({ ok: true, path: join(dir, "on-disk.json") });
    expect(JSON.parse(await readFile(join(dir, "on-disk.json"), "utf8"))).toEqual({ workingDirectory: absPath("x"), brief: "b", vendor: "claude", tier: "tier1", permissionMode: "default" });

    const second = await createSessionDefinition({ dir }, "on-disk", { workingDirectory: absPath("y"), brief: "c", vendor: "codex", tier: "tier2", permissionMode: "auto" });
    expect(second.ok).toBe(false);
  });
});

describe("listSessionDefinitions — real disk (temp dir), default list/read", () => {
  test("lists a real definition file written to a real temp directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "butchr-session-list-"));
    await createSessionDefinition({ dir }, "real", goodDef() as never);
    const entries = await listSessionDefinitions({ dir, store: fakeStore() });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("real.json");
    expect(entries[0]!.valid).toBe(true);
    expect(entries[0]!.vendor).toBe("claude");
  });

  test("a real, genuinely missing directory is an empty list (default listFilesystemResources' own ENOENT), never an error", async () => {
    const entries = await listSessionDefinitions({ dir: absPath("definitely", "does", "not", "exist", "on", "this", "host"), store: fakeStore() });
    expect(entries).toEqual([]);
  });
});
