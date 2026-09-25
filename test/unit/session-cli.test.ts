import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realExists, runSessionCli, type SessionCliIo } from "../../src/cli/session-cli.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";
import type { SessionFreezeStore } from "../../src/resources/session-freeze.js";

const goodDef = (over: Record<string, unknown> = {}) => ({
  workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default", ...over,
});

function fakeIo(files: Record<string, string> = {}): SessionCliIo & { out: string[]; err: string[] } {
  const out: string[] = [], err: string[] = [];
  const frozenIds = new Set<string>();
  const store: SessionFreezeStore = {
    async read(id) { return { frozen: frozenIds.has(id) }; },
    async set(id, f) { if (f) frozenIds.add(id); else frozenIds.delete(id); },
  };
  return {
    out, err,
    dir: "/defs",
    freeze: { store, readFile: async (p) => { if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files[p]!; }, writeFile: async (p, c) => { files[p] = c; } },
    list: async (): Promise<FilesystemResource[]> => Object.keys(files).map((p) => ({ path: p, kind: "file", name: p.split("/").pop()!, size: 10, mtimeMs: 1 })),
    read: async (p) => { if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files[p]!; },
    write: async (p, c) => { files[p] = c; },
    exists: async (p) => p in files,
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
