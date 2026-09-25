import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realExists, runSessionCli, type SessionCliIo } from "../../src/cli/session-cli.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";
import { sessionAgentKey, type SessionFreezeStore } from "../../src/resources/session-freeze.js";
import type { OnArchived } from "../../src/resources/session-archive.js";

const goodDef = (over: Record<string, unknown> = {}) => ({
  workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default", ...over,
});

/** `files` backs BOTH the active dir (`/defs/...`) and the archive dir (`/archive/...`) — same in-memory map, keyed by full path, so `archive`/`unarchive` moving an entry between them is directly observable. */
function fakeIo(files: Record<string, string> = {}, opts: { archiveDir?: string; onArchived?: OnArchived } = {}): SessionCliIo & { out: string[]; err: string[] } {
  const out: string[] = [], err: string[] = [];
  const frozenIds = new Set<string>();
  const store: SessionFreezeStore = {
    async read(id) { return { frozen: frozenIds.has(id) }; },
    async set(id, f) { if (f) frozenIds.add(id); else frozenIds.delete(id); },
  };
  const exists = async (p: string) => p in files;
  return {
    out, err,
    dir: "/defs",
    freeze: { store, readFile: async (p) => { if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files[p]!; }, writeFile: async (p, c) => { files[p] = c; } },
    archive: {
      activeDir: "/defs",
      archiveDir: opts.archiveDir ?? "/archive",
      rename: async (from, to) => { if (!(from in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); files[to] = files[from]!; delete files[from]; },
      copyFile: async (from, to) => { if (!(from in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); files[to] = files[from]!; },
      unlink: async (p) => { delete files[p]; },
      exists,
      mkdir: async () => {},
      ...(opts.onArchived ? { onArchived: opts.onArchived } : {}),
    },
    // Real `listFilesystemResources` scopes a listing to `query.root` — this fake must too, now that `files` can back BOTH the active and archive dirs at once (same map, different path prefixes).
    list: async (query): Promise<FilesystemResource[]> => Object.keys(files)
      .filter((p) => p.startsWith(`${query.root}/`))
      .map((p) => ({ path: p, kind: "file", name: p.split("/").pop()!, size: 10, mtimeMs: 1 })),
    read: async (p) => { if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files[p]!; },
    write: async (p, c) => { files[p] = c; },
    exists,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  };
}

describe("butchr session — usage", () => {
  test("no subcommand: usage on stderr, exit 1", async () => {
    const io = fakeIo();
    const code = await runSessionCli([], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("usage: butchr session");
  });

  test("--help: usage on stdout, exit 0", async () => {
    const io = fakeIo();
    const code = await runSessionCli(["--help"], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("usage: butchr session");
  });

  test("unknown subcommand: error + usage on stderr, exit 1", async () => {
    const io = fakeIo();
    const code = await runSessionCli(["bogus"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("unknown subcommand");
  });
});

describe("butchr session list", () => {
  test("empty directory reports no definitions", async () => {
    const io = fakeIo();
    const code = await runSessionCli(["list"], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("no session definitions");
  });

  test("lists a valid claude and a valid codex definition, and an invalid one with its problems, none hidden", async () => {
    const io = fakeIo({
      "/defs/claude-agent.json": JSON.stringify(goodDef()),
      "/defs/codex-agent.json": JSON.stringify(goodDef({ vendor: "codex", tier: "tier2", permissionMode: "auto" })),
      "/defs/broken.json": JSON.stringify({ ...goodDef(), tier: "not-a-tier" }),
    });
    const code = await runSessionCli(["list"], io);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain("claude-agent.json  valid  vendor=claude tier=tier1");
    expect(text).toContain("codex-agent.json  valid  vendor=codex tier=tier2");
    expect(text).toContain("broken.json  INVALID");
    expect(text).toContain("tier must be one of");
    expect(text).toContain("freezeControllers=(none) unfreezeControllers=(none)");
  });

  test("lists a definition's delegated-freeze grants when set", async () => {
    const io = fakeIo({ "/defs/target.json": JSON.stringify(goodDef({ freezeControllers: ["director"] })) });
    const code = await runSessionCli(["list"], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("freezeControllers=director unfreezeControllers=(none)");
  });
});

describe("butchr session show", () => {
  test("shows a valid definition's parsed fields, agent key and freeze state", async () => {
    const io = fakeIo({ "/defs/a.json": JSON.stringify(goodDef()) });
    const code = await runSessionCli(["show", "a"], io);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain("name: a.json");
    expect(text).toContain("agentKey: filesystem:managed-sessions:");
    expect(text).toContain("vendor: claude");
    expect(text).toContain("frozen: manifest=false store=false");
    expect(text).toContain("freezeControllers: (none)");
    expect(text).toContain("unfreezeControllers: (none)");
  });

  test("shows a definition's delegated-freeze grants when set", async () => {
    const io = fakeIo({ "/defs/target.json": JSON.stringify(goodDef({ freezeControllers: ["director"], unfreezeControllers: ["director", "ops"] })) });
    const code = await runSessionCli(["show", "target"], io);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain("freezeControllers: director");
    expect(text).toContain("unfreezeControllers: director, ops");
  });

  test("no such definition: error on stderr, exit 1", async () => {
    const io = fakeIo();
    const code = await runSessionCli(["show", "missing"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("no definition named");
  });

  test("missing name argument: usage error, exit 1", async () => {
    const io = fakeIo();
    const code = await runSessionCli(["show"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("expected exactly one argument");
  });

  test("shows an invalid definition's problems rather than hiding it", async () => {
    const io = fakeIo({ "/defs/bad.json": JSON.stringify({ ...goodDef(), vendor: "not-a-vendor" }) });
    const code = await runSessionCli(["show", "bad"], io);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain("valid: false");
    expect(text).toContain("problems:");
    expect(text).toContain("vendor must be one of");
  });
});

describe("butchr session create", () => {
  test("creates a claude definition from flags", async () => {
    const io = fakeIo();
    const code = await runSessionCli([
      "create", "new-claude",
      "--working-directory", "~/code/some-project",
      "--brief", "Keep this tidy.",
      "--vendor", "claude", "--tier", "tier1", "--permission-mode", "default",
    ], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("created /defs/new-claude.json");
  });

  test("creates a codex definition from flags", async () => {
    const io = fakeIo();
    const code = await runSessionCli([
      "create", "new-codex",
      "--working-directory", "/repo",
      "--brief", "Keep this tidy.",
      "--vendor", "codex", "--tier", "tier3", "--permission-mode", "auto",
      "--execution", "swarm", "--role", "worker",
    ], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("created /defs/new-codex.json");
  });

  test("missing required flags: error naming them, exit 1", async () => {
    const io = fakeIo();
    const code = await runSessionCli(["create", "incomplete", "--vendor", "claude"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("missing required flag");
  });

  test("missing name argument: usage error, exit 1", async () => {
    const io = fakeIo();
    const code = await runSessionCli(["create"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("expected a name");
  });

  test("--frozen (a value-less flag) is honored", async () => {
    const io = fakeIo();
    const code = await runSessionCli([
      "create", "born-frozen", "--working-directory", "/x", "--brief", "b", "--vendor", "claude", "--tier", "tier1", "--permission-mode", "default", "--frozen",
    ], io);
    expect(code).toBe(0);
    expect(JSON.parse(await io.read("/defs/born-frozen.json")).frozen).toBe(true);
  });

  test("refuses to overwrite an existing definition", async () => {
    const io = fakeIo({ "/defs/dup.json": JSON.stringify(goodDef()) });
    const code = await runSessionCli([
      "create", "dup", "--working-directory", "/x", "--brief", "b", "--vendor", "claude", "--tier", "tier1", "--permission-mode", "default",
    ], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("already exists");
  });

  test("--freeze-controllers/--unfreeze-controllers: comma-separated names, trimmed, written verbatim", async () => {
    const io = fakeIo();
    const code = await runSessionCli([
      "create", "target", "--working-directory", "/x", "--brief", "b", "--vendor", "claude", "--tier", "tier1", "--permission-mode", "default",
      "--freeze-controllers", "director, mud-ops.json", "--unfreeze-controllers", "director",
    ], io);
    expect(code).toBe(0);
    const written = JSON.parse(await io.read("/defs/target.json"));
    expect(written.freezeControllers).toEqual(["director", "mud-ops.json"]);
    expect(written.unfreezeControllers).toEqual(["director"]);
  });

  test("an invalid grant (e.g. a path separator) is refused before writing, same as any other bad field", async () => {
    const io = fakeIo();
    const code = await runSessionCli([
      "create", "target", "--working-directory", "/x", "--brief", "b", "--vendor", "claude", "--tier", "tier1", "--permission-mode", "default",
      "--freeze-controllers", "../etc/passwd",
    ], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("must not contain a path separator");
  });

  test("invalid --mcp-servers JSON is rejected before validation", async () => {
    const io = fakeIo();
    const code = await runSessionCli([
      "create", "bad-mcp", "--working-directory", "/x", "--brief", "b", "--vendor", "claude", "--tier", "tier1", "--permission-mode", "default",
      "--mcp-servers", "not json",
    ], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("not valid JSON");
  });
});

describe("butchr session freeze / unfreeze", () => {
  test("freeze sets both gates and reports them, plus the poll-delay note", async () => {
    const io = fakeIo({ "/defs/a.json": JSON.stringify(goodDef()) });
    const code = await runSessionCli(["freeze", "a"], io);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain("frozen a.json");
    expect(text).toContain("manifest=true store=true");
    expect(text).toContain("effect takes up to one poll");
    expect(JSON.parse(await io.read("/defs/a.json")).frozen).toBe(true);
  });

  test("unfreeze clears both gates", async () => {
    const io = fakeIo({ "/defs/a.json": JSON.stringify(goodDef({ frozen: true })) });
    await runSessionCli(["freeze", "a"], io); // no-op re-affirm, then...
    const code = await runSessionCli(["unfreeze", "a"], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("manifest=false store=false");
  });

  test("freeze/unfreeze resolve a bare name to its .json file", async () => {
    const io = fakeIo({ "/defs/mud-player-1.json": JSON.stringify(goodDef()) });
    const code = await runSessionCli(["freeze", "mud-player-1"], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("frozen mud-player-1.json");
  });

  test("freeze on an unknown name: error, exit 1", async () => {
    const io = fakeIo();
    const code = await runSessionCli(["freeze", "nope"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("no definition named");
  });

  test("missing name argument: usage error, exit 1", async () => {
    const io = fakeIo();
    const code = await runSessionCli(["freeze"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("expected exactly one argument");
  });

  test("freeze output also names the resolved definitions dir and freeze-store root (BUTCHR-454 review follow-up)", async () => {
    const io = fakeIo({ "/defs/a.json": JSON.stringify(goodDef()) });
    const code = await runSessionCli(["freeze", "a"], io);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain("definitions dir: /defs");
    expect(text).toContain("freeze-store root:");
  });

  test("unfreeze output also names the resolved definitions dir and freeze-store root", async () => {
    const io = fakeIo({ "/defs/a.json": JSON.stringify(goodDef({ frozen: true })) });
    const code = await runSessionCli(["unfreeze", "a"], io);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain("definitions dir: /defs");
    expect(text).toContain("freeze-store root:");
  });
});

describe("butchr session archive / unarchive", () => {
  test("archives a definition: moved out of the active dir, into the archive dir, exact same name and content", async () => {
    const io = fakeIo({ "/defs/a.json": JSON.stringify(goodDef()) });
    const code = await runSessionCli(["archive", "a"], io);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain("archived a.json -> /archive/a.json");
    expect(text).toContain("definitions dir: /defs");
    expect(text).toContain("archive dir: /archive");
    expect(text).toContain("freeze-store root:");
    expect(text).toContain("does not stop the agent itself");
    expect(await io.exists("/defs/a.json")).toBe(false);
    expect(JSON.parse(await io.read("/archive/a.json"))).toEqual(goodDef());
  });

  test("unarchives a definition: moved back to the active dir, exact same name and content", async () => {
    const io = fakeIo({ "/archive/a.json": JSON.stringify(goodDef()) });
    const code = await runSessionCli(["unarchive", "a"], io);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain("unarchived a.json -> /defs/a.json");
    expect(text).toContain("does not start the agent itself");
    expect(await io.exists("/archive/a.json")).toBe(false);
    expect(JSON.parse(await io.read("/defs/a.json"))).toEqual(goodDef());
  });

  test("archive/unarchive resolve a bare name to its .json file", async () => {
    const io = fakeIo({ "/defs/mud-player-1.json": JSON.stringify(goodDef()) });
    const code = await runSessionCli(["archive", "mud-player-1"], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("archived mud-player-1.json -> /archive/mud-player-1.json");
  });

  test("archive on an unknown name: error, exit 1, nothing moved", async () => {
    const io = fakeIo();
    const code = await runSessionCli(["archive", "nope"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("does not exist");
  });

  test("archive refuses a name already archived: error, exit 1, active copy untouched", async () => {
    const io = fakeIo({ "/defs/a.json": "ACTIVE", "/archive/a.json": "ALREADY-ARCHIVED" });
    const code = await runSessionCli(["archive", "a"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("already exists");
    expect(await io.read("/defs/a.json")).toBe("ACTIVE");
  });

  test("unarchive refuses a name already active: error, exit 1, archived copy untouched", async () => {
    const io = fakeIo({ "/defs/a.json": "ALREADY-ACTIVE", "/archive/a.json": "ARCHIVED" });
    const code = await runSessionCli(["unarchive", "a"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("already exists");
    expect(await io.read("/archive/a.json")).toBe("ARCHIVED");
  });

  test("missing name argument: usage error, exit 1", async () => {
    const io = fakeIo();
    const code = await runSessionCli(["archive"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("expected exactly one argument");
  });

  test("BUTCHR-455 review fix: archive refuses a traversal name, nothing moved", async () => {
    const io = fakeIo({ "/defs/real.json": "CONTENT" });
    const code = await runSessionCli(["archive", "../real"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("bare file name");
    expect(await io.read("/defs/real.json")).toBe("CONTENT");
  });

  test("BUTCHR-455 review fix: unarchive refuses a traversal name, nothing moved", async () => {
    const io = fakeIo({ "/archive/real.json": "CONTENT" });
    const code = await runSessionCli(["unarchive", "../real"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("bare file name");
    expect(await io.read("/archive/real.json")).toBe("CONTENT");
  });

  test("refuses at startup when the resolved archive dir sits inside the definitions dir — nothing moved", async () => {
    const io = fakeIo({ "/defs/a.json": JSON.stringify(goodDef()) }, { archiveDir: "/defs/archive" });
    const code = await runSessionCli(["archive", "a"], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("must not equal or sit inside");
    expect(await io.exists("/defs/a.json")).toBe(true);
  });

  test("the post-archive hook fires with the definition's active-path agent key", async () => {
    const calls: Array<{ agentKey: string; path: string }> = [];
    const io = fakeIo({ "/defs/a.json": JSON.stringify(goodDef()) }, { onArchived: async (info) => { calls.push(info); } });
    const code = await runSessionCli(["archive", "a"], io);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/archive/a.json");
  });

  test("a hook failure is reported on stderr but the archive still succeeds (exit 0)", async () => {
    const io = fakeIo({ "/defs/a.json": JSON.stringify(goodDef()) }, { onArchived: async () => { throw new Error("rocket-chat unreachable"); } });
    const code = await runSessionCli(["archive", "a"], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("archived a.json");
    expect(io.err.join("\n")).toContain("rocket-chat unreachable");
    expect(await io.exists("/defs/a.json")).toBe(false); // still moved
  });
});

describe("butchr session list --archived", () => {
  test("empty archive directory reports no archived definitions", async () => {
    const io = fakeIo();
    const code = await runSessionCli(["list", "--archived"], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("no archived session definitions");
  });

  test("lists archived definitions with the same columns as plain list", async () => {
    const io = fakeIo({
      "/archive/claude-agent.json": JSON.stringify(goodDef()),
      "/archive/broken.json": JSON.stringify({ ...goodDef(), tier: "not-a-tier" }),
    });
    const code = await runSessionCli(["list", "--archived"], io);
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain("claude-agent.json  valid  vendor=claude tier=tier1");
    expect(text).toContain("broken.json  INVALID");
  });

  test("plain `list` never shows an archived definition", async () => {
    const io = fakeIo({ "/archive/a.json": JSON.stringify(goodDef()) });
    const code = await runSessionCli(["list"], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("no session definitions");
  });

  test("an archived entry's freeze gates are shown for the path it would have once restored, not its current archive path", async () => {
    // The store only ever has an entry for the ACTIVE-path key (set below); if list --archived
    // read the gate at the archive path it would report storeFrozen=false instead.
    const io = fakeIo({ "/archive/a.json": JSON.stringify(goodDef()) });
    await io.freeze.store.set(`butchr:${sessionAgentKey("/defs/a.json")}`, true);
    const code = await runSessionCli(["list", "--archived"], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("store=true");
  });
});

describe("butchr session create — archived-name collision (BUTCHR-454 gap closed)", () => {
  test("refuses to create a name that already exists as an archived definition", async () => {
    const io = fakeIo({ "/archive/dup.json": JSON.stringify(goodDef()) });
    const code = await runSessionCli([
      "create", "dup", "--working-directory", "/x", "--brief", "b", "--vendor", "claude", "--tier", "tier1", "--permission-mode", "default",
    ], io);
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("already exists");
    expect(await io.exists("/defs/dup.json")).toBe(false);
  });

  test("still creates a name with no archived collision", async () => {
    const io = fakeIo({ "/archive/other.json": JSON.stringify(goodDef()) });
    const code = await runSessionCli([
      "create", "fresh", "--working-directory", "/x", "--brief", "b", "--vendor", "claude", "--tier", "tier1", "--permission-mode", "default",
    ], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("created /defs/fresh.json");
  });
});

describe("realExists — real disk", () => {
  test("true for a file that exists, false otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "butchr-session-cli-exists-"));
    const path = join(dir, "a.json");
    expect(await realExists(path)).toBe(false);
    await writeFile(path, "{}");
    expect(await realExists(path)).toBe(true);
  });
});
