import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Dirent } from "node:fs";
import type { Herd } from "../../src/agents/herd.js";
import { filesystemNudge } from "../../src/agents/change-nudge.js";
import { FILESYSTEM_TOOLS_NOTE } from "../../src/agents/workspace.js";
import { runResourceLoop } from "../../src/daemon/loop.js";
import { filesystemRules, FILESYSTEM_POLL_MS, startFilesystemLoop } from "../../src/daemon/filesystem-loop.js";
import { callerIdentity, KEY_ONLY_PROVIDERS } from "../../src/mcp/identity.js";
import { isFilesystemResourceId, MAX_ENCODED_SEGMENT_BYTES } from "../../src/resources/filesystem-ref.js";
import {
  expandHome, filesystemQueryProblems, MAX_ALLOWED_DEPTH, parseFilesystemQuery, type FilesystemQuery,
} from "../../src/resources/filesystem-query.js";
import {
  listFilesystemResources, MAX_RESULTS, MAX_VISITED, type FilesystemIo, type FilesystemResource,
} from "../../src/resources/filesystem.js";
import { decodeAgentKey, decodeAnyAgentKey, encodeAgentKey, encodeQueryAgentKey, isResourceId, RESOURCE_PROVIDERS } from "../../src/rules/agent-key.js";
import {
  createFilesystemEventRules, createFilesystemResourceType, onceOversized, ownsFilesystemAgent, searchFilesystemRules,
  specForFilesystem, specForFilesystemQuery, specForFilesystemUnit, type FilesystemMatch,
} from "../../src/rules/filesystem-type.js";
import { ownsManagedSessionAgent } from "../../src/rules/session-definition-type.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { ExecutionUnit } from "../../src/rules/execution.js";

const HOME = "/home/tester";

// ---------------------------------------------------------------------------
// filesystem-ref.ts
// ---------------------------------------------------------------------------

describe("isFilesystemResourceId", () => {
  test("accepts a canonical absolute path, and the bare root", () => {
    for (const id of ["/", "/a", "/a/b/c", "/a b/c.txt", "/" + "a".repeat(100)]) expect(isFilesystemResourceId(id)).toBe(true);
  });
  test("rejects anything not absolute, or not canonical", () => {
    for (const id of ["", "a", "a/b", "/a/", "/a//b", "/a/./b", "/a/../b", "/a\0b"]) {
      expect(isFilesystemResourceId(id)).toBe(false);
    }
  });
  test("PR #388 review finding: rejects an id whose percent-encoded form would overflow one workspace directory-name segment, even a short but heavily non-ASCII one", () => {
    // The review's own repro: 123 raw characters, but each "é" costs 6 bytes once percent-encoded (é is 2 UTF-8 bytes, each escaped to %XX).
    const id = `/data/${"d".repeat(80)}/${"é".repeat(30)}/x.txt`;
    expect(id.length).toBeLessThan(150);
    expect(Buffer.byteLength(encodeURIComponent(id), "utf8")).toBeGreaterThan(MAX_ENCODED_SEGMENT_BYTES);
    expect(isFilesystemResourceId(id)).toBe(false);
  });
  test("a purely-ASCII path long enough to overflow the encoded-segment limit is also rejected — a raw-length check could never have been stricter than this one", () => {
    expect(isFilesystemResourceId("/" + "a".repeat(5000))).toBe(false);
  });
  test("the encoded-segment byte boundary is exact: MAX_ENCODED_SEGMENT_BYTES fits, one byte more does not", () => {
    // The leading "/" alone costs 3 encoded bytes (%2F); each further "a" costs exactly 1 (unreserved) — so the boundary is found by counting up from that fixed cost, not assumed.
    const slashBytes = Buffer.byteLength(encodeURIComponent("/"), "utf8");
    const atLimit = "/" + "a".repeat(MAX_ENCODED_SEGMENT_BYTES - slashBytes);
    const overLimit = "/" + "a".repeat(MAX_ENCODED_SEGMENT_BYTES - slashBytes + 1);
    expect(Buffer.byteLength(encodeURIComponent(atLimit), "utf8")).toBe(MAX_ENCODED_SEGMENT_BYTES);
    expect(isFilesystemResourceId(atLimit)).toBe(true);
    expect(Buffer.byteLength(encodeURIComponent(overLimit), "utf8")).toBe(MAX_ENCODED_SEGMENT_BYTES + 1);
    expect(isFilesystemResourceId(overLimit)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filesystem-query.ts
// ---------------------------------------------------------------------------

describe("expandHome", () => {
  test("expands ~ and ~/rest against home; leaves anything else alone; refuses ~user", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome("~/", HOME)).toBe(`${HOME}/`); // trailing slash preserved; rootProblems rejects it downstream (see below) — expandHome itself does no normalization.
    expect(expandHome("~/repo", HOME)).toBe(`${HOME}/repo`);
    expect(expandHome("/abs", HOME)).toBe("/abs");
    expect(expandHome("relative", HOME)).toBe("relative");
    expect(expandHome("~otheruser/x", HOME)).toBeNull();
  });
});

describe("filesystemQueryProblems", () => {
  const good = () => JSON.stringify({ root: "/tmp/work", kind: "file" });

  test("a minimal valid query has no problems", () => {
    expect(filesystemQueryProblems(good(), HOME)).toEqual([]);
  });
  test("invalid JSON, or a non-object, is rejected", () => {
    expect(filesystemQueryProblems("not json", HOME)[0]).toContain("not valid JSON");
    expect(filesystemQueryProblems("[]", HOME)).toEqual(["query must be a JSON object"]);
    expect(filesystemQueryProblems('"a string"', HOME)).toEqual(["query must be a JSON object"]);
  });
  test("an unknown top-level field is rejected", () => {
    expect(filesystemQueryProblems(JSON.stringify({ root: "/tmp", kind: "file", extra: 1 }), HOME))
      .toEqual(['query has unknown field "extra"']);
  });
  test("root: must be a non-empty string, absolute (or ~-relative), canonical, and bounded", () => {
    expect(filesystemQueryProblems(JSON.stringify({ root: "", kind: "file" }), HOME)[0]).toContain("root must be a non-empty string");
    expect(filesystemQueryProblems(JSON.stringify({ root: 7, kind: "file" }), HOME)[0]).toContain("root must be a non-empty string");
    expect(filesystemQueryProblems(JSON.stringify({ root: "relative/path", kind: "file" }), HOME)[0]).toContain("must be absolute");
    expect(filesystemQueryProblems(JSON.stringify({ root: "/a/", kind: "file" }), HOME)[0]).toContain("trailing slash");
    expect(filesystemQueryProblems(JSON.stringify({ root: "/a/../b", kind: "file" }), HOME)[0]).toContain('"." or ".." segments');
    expect(filesystemQueryProblems(JSON.stringify({ root: "/a//b", kind: "file" }), HOME)[0]).toContain('"." or ".." segments');
    expect(filesystemQueryProblems(JSON.stringify({ root: "~bob/x", kind: "file" }), HOME)[0]).toContain("~user is not supported");
    expect(filesystemQueryProblems(JSON.stringify({ root: "/" + "a".repeat(5000), kind: "file" }), HOME)[0]).toContain("longer than");
    expect(filesystemQueryProblems(JSON.stringify({ root: "~/work", kind: "file" }), HOME)).toEqual([]);
    expect(filesystemQueryProblems(JSON.stringify({ root: "/", kind: "file" }), HOME)).toEqual([]);
  });
  test("kind: must be file or directory", () => {
    expect(filesystemQueryProblems(JSON.stringify({ root: "/tmp", kind: "socket" }), HOME)).toEqual(['query.kind must be "file" or "directory"']);
    expect(filesystemQueryProblems(JSON.stringify({ root: "/tmp" }), HOME)).toEqual(['query.kind must be "file" or "directory"']);
  });
  test("namePattern: non-empty, no slash", () => {
    expect(filesystemQueryProblems(JSON.stringify({ root: "/tmp", kind: "file", namePattern: "" }), HOME)[0]).toContain("namePattern must be");
    expect(filesystemQueryProblems(JSON.stringify({ root: "/tmp", kind: "file", namePattern: "a/b" }), HOME)[0]).toContain("namePattern must be");
    expect(filesystemQueryProblems(JSON.stringify({ root: "/tmp", kind: "file", namePattern: "*.ts" }), HOME)).toEqual([]);
  });
  test("maxDepth: an integer between 1 and MAX_ALLOWED_DEPTH", () => {
    for (const bad of [0, -1, 1.5, "3", MAX_ALLOWED_DEPTH + 1]) {
      expect(filesystemQueryProblems(JSON.stringify({ root: "/tmp", kind: "file", maxDepth: bad }), HOME)[0]).toContain("maxDepth must be");
    }
    for (const ok of [1, MAX_ALLOWED_DEPTH]) expect(filesystemQueryProblems(JSON.stringify({ root: "/tmp", kind: "file", maxDepth: ok }), HOME)).toEqual([]);
  });
  test("predicate: extension requires kind file, a leading-dot value with no slash/whitespace, and no other fields", () => {
    const at = (predicate: unknown, kind = "file") => filesystemQueryProblems(JSON.stringify({ root: "/tmp", kind, predicate }), HOME);
    expect(at({ predicateKind: "extension", value: ".ts" })).toEqual([]);
    expect(at({ predicateKind: "extension", value: ".ts" }, "directory")[0]).toContain('requires query.kind "file"');
    expect(at({ predicateKind: "extension", value: "ts" })[0]).toContain("must be an extension starting with");
    expect(at({ predicateKind: "extension", value: "." })[0]).toContain("must be an extension starting with");
    expect(at({ predicateKind: "extension", value: ".t s" })[0]).toContain("must be an extension starting with");
    expect(at({ predicateKind: "extension", value: "./ts" })[0]).toContain("must be an extension starting with");
    expect(at({ predicateKind: "extension", value: ".ts", name: "x" })[0]).toContain("takes only");
    expect(at("not an object")).toEqual(['query.predicate must be an object']);
    expect(at({ predicateKind: "nonsense" })).toEqual(['query.predicate.predicateKind must be "extension" or "hasEntry"']);
    expect(at({ predicateKind: "extension", value: ".ts", bogus: 1 })).toContain('query.predicate has unknown field "bogus"');
  });
  test("predicate: hasEntry requires kind directory, a direct child name, and an optional entryKind", () => {
    const at = (predicate: unknown, kind = "directory") => filesystemQueryProblems(JSON.stringify({ root: "/tmp", kind, predicate }), HOME);
    expect(at({ predicateKind: "hasEntry", name: "package.json" })).toEqual([]);
    expect(at({ predicateKind: "hasEntry", name: "package.json", entryKind: "file" })).toEqual([]);
    expect(at({ predicateKind: "hasEntry", name: "x" }, "file")[0]).toContain('requires query.kind "directory"');
    expect(at({ predicateKind: "hasEntry", name: "" })[0]).toContain("must be a direct child name");
    expect(at({ predicateKind: "hasEntry", name: "a/b" })[0]).toContain("must be a direct child name");
    expect(at({ predicateKind: "hasEntry", name: "." })[0]).toContain("must be a direct child name");
    expect(at({ predicateKind: "hasEntry", name: "..", })[0]).toContain("must be a direct child name");
    expect(at({ predicateKind: "hasEntry", name: "x", entryKind: "socket" })[0]).toContain("entryKind must be");
    expect(at({ predicateKind: "hasEntry", name: "x", value: "y" })[0]).toContain("takes no");
  });
  test("every problem is collected in one pass", () => {
    const problems = filesystemQueryProblems(JSON.stringify({ root: "", kind: "bad", maxDepth: 0 }), HOME);
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("parseFilesystemQuery", () => {
  test("throws with every collected problem when the query is invalid", () => {
    expect(() => parseFilesystemQuery("{}", HOME)).toThrow(/filesystem query rejected:.*root must be a non-empty string/);
  });
  test("resolves ~, defaults maxDepth, and carries namePattern/predicate through", () => {
    const q = parseFilesystemQuery(JSON.stringify({ root: "~/work", kind: "file", namePattern: "*.ts" }), HOME);
    expect(q).toEqual({ root: `${HOME}/work`, kind: "file", namePattern: "*.ts", maxDepth: MAX_ALLOWED_DEPTH });
  });
  test("an explicit maxDepth and predicate are carried through unchanged", () => {
    const q = parseFilesystemQuery(JSON.stringify({ root: "/tmp", kind: "directory", maxDepth: 3, predicate: { predicateKind: "hasEntry", name: "README.md", entryKind: "file" } }), HOME);
    expect(q).toEqual({ root: "/tmp", kind: "directory", maxDepth: 3, predicate: { predicateKind: "hasEntry", name: "README.md", entryKind: "file" } });
  });
});

// ---------------------------------------------------------------------------
// filesystem.ts — discovery, against a real temp directory tree
// ---------------------------------------------------------------------------

describe("listFilesystemResources (temp directory tree)", () => {
  let root: string;
  const write = (rel: string, content = "") => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const mkdir = (rel: string) => mkdirSync(join(root, rel), { recursive: true });
  const byPath = (rs: FilesystemResource[]) => rs.map((r) => r.path.slice(root.length + 1)).sort();

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "butchr-fs-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test("selects exactly the expected files, none of the excluded ones", async () => {
    write("a.txt"); write("b.md"); mkdir("sub"); write("sub/c.txt");
    const rs = await listFilesystemResources({ root, kind: "file", namePattern: "*.txt", maxDepth: 5 });
    expect(byPath(rs)).toEqual(["a.txt", "sub/c.txt"]);
  });

  test("selects directories, not files", async () => {
    write("a.txt"); mkdir("sub"); mkdir("sub/nested");
    const rs = await listFilesystemResources({ root, kind: "directory", maxDepth: 5 });
    expect(byPath(rs)).toEqual(["sub", "sub/nested"]);
  });

  test("root itself is never a candidate resource, even a root matching its own namePattern", async () => {
    // mkdtempSync's own basename is arbitrary; namePattern "*" would match everything else too — assert root is absent regardless.
    write("a.txt");
    const rs = await listFilesystemResources({ root, kind: "directory", maxDepth: 5 });
    expect(rs.some((r) => r.path === root)).toBe(false);
  });

  test("maxDepth bounds recursion: root's own children are depth 1", async () => {
    write("a.txt"); write("sub/b.txt"); write("sub/nested/c.txt");
    expect(byPath(await listFilesystemResources({ root, kind: "file", maxDepth: 1 }))).toEqual(["a.txt"]);
    expect(byPath(await listFilesystemResources({ root, kind: "file", maxDepth: 2 }))).toEqual(["a.txt", "sub/b.txt"]);
    expect(byPath(await listFilesystemResources({ root, kind: "file", maxDepth: 3 }))).toEqual(["a.txt", "sub/b.txt", "sub/nested/c.txt"]);
  });

  test('predicate "extension": files whose extension is Y', async () => {
    write("a.ts"); write("b.tsx"); write("c.txt");
    const rs = await listFilesystemResources({ root, kind: "file", maxDepth: 5, predicate: { predicateKind: "extension", value: ".ts" } });
    expect(byPath(rs)).toEqual(["a.ts"]);
  });

  test('predicate "hasEntry": directories containing a file named X', async () => {
    mkdir("withMarker"); write("withMarker/MARKER"); mkdir("withoutMarker");
    mkdir("withMarkerAsDir"); mkdir("withMarkerAsDir/MARKER");
    const rs = await listFilesystemResources({ root, kind: "directory", maxDepth: 5, predicate: { predicateKind: "hasEntry", name: "MARKER", entryKind: "file" } });
    expect(byPath(rs)).toEqual(["withMarker"]);
  });

  test("a symlink escaping the root is never a candidate and is never traversed into", async () => {
    const outside = mkdtempSync(join(tmpdir(), "butchr-fs-outside-"));
    writeFileSync(join(outside, "secret.txt"), "");
    write("a.txt");
    symlinkSync(outside, join(root, "escape"));
    try {
      const files = await listFilesystemResources({ root, kind: "file", maxDepth: 5 });
      expect(byPath(files)).toEqual(["a.txt"]);
      const dirs = await listFilesystemResources({ root, kind: "directory", maxDepth: 5 });
      expect(dirs.some((r) => r.name === "escape")).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a symlink to a location inside the root is also never matched or followed", async () => {
    mkdir("real"); write("real/x.txt");
    symlinkSync(join(root, "real"), join(root, "alias"));
    const dirs = await listFilesystemResources({ root, kind: "directory", maxDepth: 5 });
    expect(byPath(dirs)).toEqual(["real"]);
    const files = await listFilesystemResources({ root, kind: "file", maxDepth: 5 });
    expect(byPath(files)).toEqual(["real/x.txt"]);
  });

  test("two paths to the same real directory resolve to the same canonical root", async () => {
    mkdir("real"); write("real/x.txt");
    const alias = join(root, "alias");
    symlinkSync(join(root, "real"), alias);
    const viaReal = await listFilesystemResources({ root: join(root, "real"), kind: "file", maxDepth: 5 });
    const viaAlias = await listFilesystemResources({ root: alias, kind: "file", maxDepth: 5 });
    expect(viaAlias).toEqual(viaReal);
  });

  test("a missing root throws, failing the whole query", async () => {
    await expect(listFilesystemResources({ root: join(root, "nope"), kind: "file", maxDepth: 5 })).rejects.toThrow("is not readable");
  });

  test("a root that is a file, not a directory, throws", async () => {
    write("iamafile.txt");
    await expect(listFilesystemResources({ root: join(root, "iamafile.txt"), kind: "file", maxDepth: 5 })).rejects.toThrow("is not readable");
  });

  test("a subdirectory that disappears or turns unreadable mid-walk is skipped, not fatal", async () => {
    write("a.txt");
    const realIo = await import("../../src/resources/filesystem.js").then((m) => m.realFilesystemIo);
    const flaky: FilesystemIo = {
      ...realIo,
      readdir: async (p) => (p === join(root, "ghost") ? Promise.reject(new Error("ENOENT")) : realIo.readdir(p)),
    };
    mkdir("ghost");
    const rs = await listFilesystemResources({ root, kind: "file", maxDepth: 5 }, flaky);
    expect(byPath(rs)).toEqual(["a.txt"]);
  });
});

// ---------------------------------------------------------------------------
// filesystem.ts — caps, via an injected fake FilesystemIo (no real disk cost)
// ---------------------------------------------------------------------------

function fakeDirent(name: string, kind: "file" | "directory" | "symlink"): Dirent {
  return {
    name,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  } as Dirent;
}

describe("listFilesystemResources caps (fake io)", () => {
  test("MAX_RESULTS crossed rejects the whole query", async () => {
    const many = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => fakeDirent(`f${i}.txt`, "file"));
    const io: FilesystemIo = {
      realpath: async (p) => p,
      readdir: async (p) => (p === "/root" ? many : []),
      lstat: async () => ({ isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 0, mtimeMs: 0 }),
    };
    await expect(listFilesystemResources({ root: "/root", kind: "file", maxDepth: 1 }, io)).rejects.toThrow(/matched over/);
  });

  test("MAX_VISITED crossed rejects the whole query even with nothing matching", async () => {
    const many = Array.from({ length: MAX_VISITED + 5 }, (_, i) => fakeDirent(`d${i}`, "directory"));
    const io: FilesystemIo = {
      realpath: async (p) => p,
      readdir: async (p) => (p === "/root" ? many : []),
      lstat: async () => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, size: 0, mtimeMs: 0 }),
    };
    // kind: "file" so none of the many directories ever match — the cap must still fire on VISITED entries, not matches.
    await expect(listFilesystemResources({ root: "/root", kind: "file", maxDepth: 1 }, io)).rejects.toThrow(/visited over/);
  });

  test("symlinks are skipped without even an lstat call, and never descended into", async () => {
    const calls: string[] = [];
    const io: FilesystemIo = {
      realpath: async (p) => p,
      readdir: async (p) => { calls.push(`readdir:${p}`); return p === "/root" ? [fakeDirent("link", "symlink")] : []; },
      lstat: async (p) => { calls.push(`lstat:${p}`); return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 1, mtimeMs: 1 }; },
    };
    const rs = await listFilesystemResources({ root: "/root", kind: "file", maxDepth: 5 }, io);
    expect(rs).toEqual([]);
    expect(calls).toEqual(["readdir:/root"]);
  });
});

// ---------------------------------------------------------------------------
// filesystem-type.ts — the rule-engine ResourceType
// ---------------------------------------------------------------------------

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: "docs", enabled: true, resourceProvider: "filesystem",
  query: JSON.stringify({ root: "/repo", kind: "file", namePattern: "*.md" }),
  brief: "Keep it current.", execution: "swarm", account: "none", role: "worker",
  ...over,
});

const res = (path: string, over: Partial<FilesystemResource> = {}): FilesystemResource =>
  ({ path, kind: "file", name: path.split("/").pop()!, size: 10, mtimeMs: 1000, ...over });

describe("searchFilesystemRules", () => {
  test("dedupes by path, encodes the agent key, and ignores disabled/other-provider rules", async () => {
    const rules = [rule(), rule({ id: "off", enabled: false }), { ...rule({ id: "other" }), resourceProvider: "zendesk-ticket" as const }];
    const list = async () => [res("/repo/a.md"), res("/repo/a.md")];
    const matches = await searchFilesystemRules({ rules, list });
    expect(matches).toEqual([{ agentKey: encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a.md" }), rule: rule(), resource: res("/repo/a.md") }]);
  });
  test("any one rule's failed list rejects the whole poll", async () => {
    const rules = [rule(), rule({ id: "other", query: JSON.stringify({ root: "/other", kind: "file" }) })];
    const list = async (q: FilesystemQuery) => { if (q.root === "/other") throw new Error("boom"); return [res("/repo/a.md")]; };
    await expect(searchFilesystemRules({ rules, list })).rejects.toThrow("boom");
  });

  test("PR #388 review fix: an oversized path is SKIPPED (never thrown), reported via onOversized, and does not cost its sibling resources", async () => {
    const oversized = `/repo/${"d".repeat(80)}/${"é".repeat(30)}/x.md`;
    expect(isFilesystemResourceId(oversized)).toBe(false);
    const list = async () => [res("/repo/a.md"), res(oversized), res("/repo/b.md")];
    const oversizedCalls: Array<[string, string]> = [];
    const matches = await searchFilesystemRules({ rules: [rule()], list }, (r, path) => oversizedCalls.push([r.id, path]));
    expect(matches.map((m) => m.resource.path).sort()).toEqual(["/repo/a.md", "/repo/b.md"]);
    expect(oversizedCalls).toEqual([["docs", oversized]]);
  });
  test("without onOversized, an oversized path is still silently skipped rather than thrown", async () => {
    const oversized = `/repo/${"d".repeat(300)}`;
    const list = async () => [res("/repo/a.md"), res(oversized)];
    const matches = await searchFilesystemRules({ rules: [rule()], list });
    expect(matches.map((m) => m.resource.path)).toEqual(["/repo/a.md"]);
  });
});

describe("onceOversized", () => {
  test("logs each distinct (rule, path) exactly once, never repeating across calls", () => {
    const logs: string[] = [];
    const report = onceOversized((l) => logs.push(l));
    report(rule(), "/repo/x");
    report(rule(), "/repo/x");
    report(rule({ id: "other" }), "/repo/x");
    report(rule(), "/repo/y");
    expect(logs).toHaveLength(3);
    expect(logs[0]).toContain("rule docs skips /repo/x");
    expect(logs[0]).toContain(String(MAX_ENCODED_SEGMENT_BYTES));
  });
  test("with no log function, it is a silent no-op", () => {
    expect(() => onceOversized(undefined)(rule(), "/repo/x")).not.toThrow();
  });
});

describe("spec builders", () => {
  const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a.md" });
  test("specForFilesystem names the resource, kind and no parent", () => {
    expect(specForFilesystem({ agentKey: key, rule: rule(), resource: res("/repo/a.md") })).toEqual({
      key, resource: "/repo/a.md", issuetype: "file", summary: "file a.md", parent: null, brief: "Keep it current.",
    });
  });
  test("specForFilesystemQuery names no single resource", () => {
    const qkey = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "docs" });
    const spec = specForFilesystemQuery(rule(), qkey);
    expect(spec.resource).toBeUndefined();
    expect(spec.key).toBe(qkey);
    expect(spec.summary).toContain("docs (query agent");
  });
  test("specForFilesystemUnit dispatches on unit kind", () => {
    const match: FilesystemMatch = { agentKey: key, rule: rule(), resource: res("/repo/a.md") };
    expect(specForFilesystemUnit({ kind: "resource", match })).toEqual(specForFilesystem(match));
    const qkey = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "docs" });
    expect(specForFilesystemUnit({ kind: "query", agentKey: qkey, rule: rule() })).toEqual(specForFilesystemQuery(rule(), qkey));
  });
});

describe("ownsFilesystemAgent", () => {
  test("recognises its own per-resource and query-level keys, and no other provider's", () => {
    expect(ownsFilesystemAgent(encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a.md" }))).toBe(true);
    expect(ownsFilesystemAgent(encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "docs" }))).toBe(true);
    expect(ownsFilesystemAgent(encodeAgentKey({ resourceProvider: "jira-work", ruleId: "docs", resourceId: "BUTCHR-1" }))).toBe(false);
    expect(ownsFilesystemAgent("not a key")).toBe(false);
  });

  test("does not claim managed-session agents, which the managed-sessions loop owns (FACTORY-47)", () => {
    const managed = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/home/u/.config/butchr/session-definitions/nexus.json" });
    expect(ownsFilesystemAgent(managed)).toBe(false);
    expect(ownsManagedSessionAgent(managed)).toBe(true);
    const ordinary = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a.md" });
    expect(ownsFilesystemAgent(ordinary)).toBe(true);
    expect(ownsManagedSessionAgent(ordinary)).toBe(false);
  });
});

describe("createFilesystemEventRules — change events", () => {
  const type = () => createFilesystemEventRules();
  const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a.md" });
  const qkey = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "docs" });
  const unit = (r: FilesystemResource): ExecutionUnit<FilesystemMatch> => ({ kind: "resource", match: { agentKey: key, rule: rule(), resource: r } });

  test("PRIMARY (swarm): unchanged content never notifies", async () => {
    const a = res("/repo/a.md");
    const poll = await type().poll({ primary: [unit(a)], related: [] }, { primary: [unit(a)], related: [] });
    expect(poll.changedPrimary).toEqual([]);
  });
  test("PRIMARY (swarm): content change (size/mtime) notifies the resource's own agent with no specific reason", async () => {
    const before = res("/repo/a.md", { mtimeMs: 1000 });
    const after = res("/repo/a.md", { mtimeMs: 2000 });
    const poll = await type().poll({ primary: [unit(before)], related: [] }, { primary: [unit(after)], related: [] });
    expect(poll.changedPrimary).toEqual([key]);
    expect(await poll.decide(key, key, "primary")).toEqual({ deliver: true });
  });
  test("PRIMARY (swarm): a resource appearing or disappearing is NOT notified — spawn/stop already say that", async () => {
    const a = res("/repo/a.md");
    const appearing = await type().poll({ primary: [], related: [] }, { primary: [unit(a)], related: [] });
    expect(appearing.changedPrimary).toEqual([]);
    const disappearing = await type().poll({ primary: [unit(a)], related: [] }, { primary: [], related: [] });
    expect(disappearing.changedPrimary).toEqual([]);
  });
  test("PRIMARY: decide refuses a watcher that is not the resource's own agent", async () => {
    const before = res("/repo/a.md", { mtimeMs: 1000 });
    const after = res("/repo/a.md", { mtimeMs: 2000 });
    const poll = await type().poll({ primary: [unit(before)], related: [] }, { primary: [unit(after)], related: [] });
    expect(await poll.decide(key, "someone-else", "primary")).toEqual({ deliver: false });
  });

  const relUnit = (r: FilesystemResource): ExecutionUnit<FilesystemMatch> => ({ kind: "resource", match: { agentKey: key, rule: rule(), resource: r } });
  const related = (r: FilesystemResource) => [{ issue: relUnit(r), watchers: [qkey] }];

  test("RELATED (singleton/persistent scope): create — appeared, delivered exactly on the entering poll", async () => {
    const a = res("/repo/a.md");
    const poll = await type().poll({ primary: [], related: [] }, { primary: [], related: related(a) });
    expect(poll.changedRelated).toEqual([key]);
    expect(await poll.decide(key, qkey, "related")).toEqual({ deliver: true, reason: { appeared: true } });
  });
  test("RELATED: modify — content change delivers with no specific reason", async () => {
    const before = res("/repo/a.md", { size: 10 });
    const after = res("/repo/a.md", { size: 20 });
    const poll = await type().poll({ primary: [], related: related(before) }, { primary: [], related: related(after) });
    expect(poll.changedRelated).toEqual([key]);
    expect(await poll.decide(key, qkey, "related")).toEqual({ deliver: true });
  });
  test("RELATED: remove — disappeared, delivered exactly once", async () => {
    const a = res("/repo/a.md");
    const leaving = await type().poll({ primary: [], related: related(a) }, { primary: [], related: [] });
    expect(leaving.changedRelated).toEqual([key]);
    expect(await leaving.decide(key, qkey, "related")).toEqual({ deliver: true, reason: { disappeared: true } });
    // The NEXT poll: absent from both sides now — never reported again.
    const stillGone = await type().poll({ primary: [], related: [] }, { primary: [], related: [] });
    expect(stillGone.changedRelated).toEqual([]);
  });
  test("RELATED: decide refuses a watcher not among the entry's watchers", async () => {
    const a = res("/repo/a.md");
    const poll = await type().poll({ primary: [], related: [] }, { primary: [], related: related(a) });
    expect(await poll.decide(key, "someone-else", "related")).toEqual({ deliver: false });
  });
});

describe("createFilesystemResourceType — staffing under all three execution modes", () => {
  test("swarm: one unit per matched resource, none at zero matches", async () => {
    let resources: FilesystemResource[] = [res("/repo/a.md"), res("/repo/b.md")];
    const type = createFilesystemResourceType({ rules: [rule()], list: async () => resources });
    const units = await type.discovery.search();
    expect(units.map((u) => type.discovery.idOf(u)).sort()).toEqual([
      encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a.md" }),
      encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/b.md" }),
    ]);
    resources = [];
    expect((await type.discovery.search()).length).toBe(0);
  });
  test("singleton: one query unit while matches exist, none at zero", async () => {
    let resources: FilesystemResource[] = [res("/repo/a.md")];
    const type = createFilesystemResourceType({ rules: [rule({ execution: "singleton" })], list: async () => resources });
    const qkey = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "docs" });
    expect((await type.discovery.search()).map((u) => type.discovery.idOf(u))).toEqual([qkey]);
    resources = [];
    expect((await type.discovery.search()).length).toBe(0);
  });
  test("persistent: one query unit always, even at zero matches", async () => {
    const type = createFilesystemResourceType({ rules: [rule({ execution: "persistent" })], list: async () => [] });
    const qkey = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "docs" });
    expect((await type.discovery.search()).map((u) => type.discovery.idOf(u))).toEqual([qkey]);
  });
  test("singleton/persistent scope is exposed via related(), watched by the query agent", async () => {
    const type = createFilesystemResourceType({ rules: [rule({ execution: "persistent" })], list: async () => [res("/repo/a.md")] });
    await type.discovery.search();
    const related = await type.discovery.related!([]);
    const qkey = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "docs" });
    expect(related).toEqual([{ issue: { kind: "resource", match: { agentKey: encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a.md" }), rule: rule({ execution: "persistent" }), resource: res("/repo/a.md") } }, watchers: [qkey] }]);
  });
  test("activation is always active — a filesystem resource never sleeps", () => {
    const type = createFilesystemResourceType({ rules: [rule()], list: async () => [] });
    expect(type.activation.verdictFor({ kind: "resource", match: { agentKey: "x", rule: rule(), resource: res("/repo/a.md") } })).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// daemon/filesystem-loop.ts — end-to-end reconcile + notify, per execution mode
// ---------------------------------------------------------------------------

const tick = () => new Promise((r) => setTimeout(r, 40));

function fakeHerd(initial: string[] = []): { herd: Herd; spawned: string[]; stopped: string[]; running: Set<string> } {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [];
  const herd: Herd = {
    async runningIssues() { return [...running]; },
    async staleIssues() { return []; },
    async spawn(sp) { spawned.push(sp.key); running.add(sp.key); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
  };
  return { herd, spawned, stopped, running };
}

describe("the filesystem loop", () => {
  test("filesystemRules filters to enabled filesystem rules only", () => {
    const rules = [rule(), rule({ id: "off", enabled: false }), { ...rule({ id: "other" }), resourceProvider: "jira-work" as const }];
    expect(filesystemRules(rules).map((r) => r.id)).toEqual(["docs"]);
  });

  test("PR #388 review fix end-to-end: an oversized match neither crashes the poll nor blocks its siblings from staffing", async () => {
    const oversized = `/repo/${"d".repeat(300)}`;
    const goodKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a.md" });
    const { herd, spawned } = fakeHerd([]);
    const logs: string[] = [];
    const errors: string[] = [];
    let successes = 0;
    const stop = startFilesystemLoop({
      rules: [rule()], list: async () => [res("/repo/a.md"), res(oversized)], herd,
      deliver: async () => {}, log: (l) => logs.push(l), intervalMs: 5,
      onError: (e) => errors.push((e as Error).message), onPollSuccess: () => { successes++; },
    });
    await tick();
    stop();
    expect(spawned).toEqual([goodKey]);
    expect(errors).toEqual([]);
    expect(successes).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("skips") && l.includes(oversized))).toBe(true);
  });

  test("swarm: spawns one agent per matched resource, stops it on removal, notifies on modify, stops leftovers only among its own", async () => {
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a.md" });
    const { herd, spawned, stopped, running } = fakeHerd([key, "BUTCHR-9"]);
    let resources = [res("/repo/a.md", { mtimeMs: 1 })];
    const delivered: Array<[string, string, string]> = [];
    const stop = startFilesystemLoop({
      rules: [rule()], list: async () => resources, herd,
      deliver: async (agent, resource, msg) => { delivered.push([agent, resource, msg]); },
      log: () => {}, intervalMs: 5,
    });
    await tick();
    expect(spawned).toEqual([]); // already running
    resources = [res("/repo/a.md", { mtimeMs: 2 })];
    await tick();
    expect(delivered).toEqual([[key, "/repo/a.md", filesystemNudge("/repo/a.md", undefined)]]);
    resources = [];
    await tick();
    stop();
    expect(stopped).toEqual([key]);
    expect(new Set(running)).toEqual(new Set(["BUTCHR-9"]));
  });

  test("singleton: one query agent while matches exist, stopped at zero, scope-change notifies delivered", async () => {
    const qkey = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "docs" });
    const { herd, spawned, stopped } = fakeHerd([]);
    let resources = [res("/repo/a.md", { mtimeMs: 1 })];
    const delivered: Array<[string, string, string]> = [];
    const stop = startFilesystemLoop({
      rules: [rule({ execution: "singleton" })], list: async () => resources, herd,
      deliver: async (agent, resource, msg) => { delivered.push([agent, resource, msg]); },
      log: () => {}, intervalMs: 5,
    });
    await tick();
    expect(spawned).toEqual([qkey]);
    resources = [res("/repo/a.md", { mtimeMs: 1 }), res("/repo/b.md", { mtimeMs: 1 })];
    await tick();
    expect(delivered).toEqual([[qkey, "/repo/b.md", filesystemNudge("/repo/b.md", { appeared: true })]]);
    resources = [res("/repo/a.md", { mtimeMs: 1 })];
    await tick();
    expect(delivered).toEqual([
      [qkey, "/repo/b.md", filesystemNudge("/repo/b.md", { appeared: true })],
      [qkey, "/repo/b.md", filesystemNudge("/repo/b.md", { disappeared: true })],
    ]);
    resources = [];
    await tick();
    stop();
    expect(stopped).toEqual([qkey]);
  });

  test("persistent: the query agent runs even at zero matches", async () => {
    const qkey = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "docs" });
    const { herd, spawned, running } = fakeHerd([]);
    const stop = startFilesystemLoop({ rules: [rule({ execution: "persistent" })], list: async () => [], herd, deliver: async () => {}, log: () => {}, intervalMs: 5 });
    await tick();
    stop();
    expect(spawned).toEqual([qkey]);
    expect(running.has(qkey)).toBe(true);
  });

  test("persistent: an already-running query agent is stopped once its rule is frozen (enabled: false) — rules load once, so this is what a restart with the edited file looks like", async () => {
    const qkey = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "docs" });
    const { herd, stopped } = fakeHerd([qkey]);
    const stop = startFilesystemLoop({ rules: [rule({ execution: "persistent", enabled: false })], list: async () => [], herd, deliver: async () => {}, log: () => {}, intervalMs: 5 });
    await tick();
    stop();
    expect(stopped).toEqual([qkey]);
  });

  test("a failed poll (missing root) changes nothing and reports onError", async () => {
    const { herd, spawned, stopped } = fakeHerd([]);
    const errors: string[] = [];
    const stop = startFilesystemLoop({
      rules: [rule({ query: JSON.stringify({ root: "/does/not/exist", kind: "file" }) })],
      list: async (q) => listFilesystemResources(q),
      herd, deliver: async () => {}, log: () => {}, intervalMs: 5,
      onError: (e) => errors.push((e as Error).message),
    });
    await tick();
    stop();
    expect(spawned).toEqual([]);
    expect(stopped).toEqual([]);
    expect(errors.some((e) => e.includes("is not readable"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting wiring: agent-key / rules.ts / mcp identity / workspace notes
// ---------------------------------------------------------------------------

describe("filesystem in the shared agent-key / rules / identity surfaces", () => {
  test("RESOURCE_PROVIDERS and isResourceId recognise filesystem", () => {
    expect(RESOURCE_PROVIDERS).toContain("filesystem");
    expect(isResourceId("filesystem", "/a/b")).toBe(true);
    expect(isResourceId("filesystem", "relative")).toBe(false);
  });
  test("encode/decode round-trip for a filesystem agent key", () => {
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a b.md" });
    expect(decodeAgentKey(key)).toEqual({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a b.md" });
    expect(decodeAnyAgentKey(key)).toEqual({ kind: "resource", resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a b.md" });
  });

  test("parseRules validates a filesystem rule's JSON query and rejects a bad one", () => {
    const good = { id: "docs", resourceProvider: "filesystem", query: JSON.stringify({ root: "/repo", kind: "file" }), brief: "go" };
    expect(parseRules({ rules: [good] })).toHaveLength(1);
    expect(() => parseRules({ rules: [{ ...good, query: "not json" }] }, "f.json")).toThrow("f.json: rules[0].query: query is not valid JSON");
  });
  test("parseRules rejects relationships on a filesystem rule", () => {
    const bad = { id: "docs", resourceProvider: "filesystem", query: JSON.stringify({ root: "/repo", kind: "file" }), brief: "go", relationships: { childRule: "x" } };
    expect(() => parseRules({ rules: [bad] })).toThrow("relationships are not supported for filesystem rules yet");
  });
  test("execution/account/role apply generically to filesystem rules too", () => {
    const doc = { id: "docs", resourceProvider: "filesystem", query: JSON.stringify({ root: "/repo", kind: "file" }), brief: "go", execution: "persistent", role: "sentinel" };
    const [r] = parseRules({ rules: [doc] });
    expect(r).toMatchObject({ execution: "persistent", role: "sentinel", account: "none" });
  });

  test("callerIdentity resolves a filesystem agent from its key alone, and refuses one that also carries x-issue", () => {
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a.md" });
    expect(callerIdentity({ "x-butchr-agent": key })).toEqual({ provider: "filesystem", agent: key, ruleId: "docs", resource: "/repo/a.md" });
    expect(callerIdentity({ "x-butchr-agent": key, "x-issue": "BUTCHR-1" })).toBeNull();
    expect(KEY_ONLY_PROVIDERS).toContain("filesystem");
  });
  test("a filesystem query-level agent identifies with x-butchr-agent alone", () => {
    const qkey = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "docs" });
    expect(callerIdentity({ "x-butchr-agent": qkey })).toEqual({ provider: "filesystem", agent: qkey, ruleId: "docs", query: true });
  });

  test("FILESYSTEM_TOOLS_NOTE mentions there is no MCP tool and that other providers' tools refuse it", () => {
    expect(FILESYSTEM_TOOLS_NOTE).toContain("no butchr MCP tool");
    expect(FILESYSTEM_TOOLS_NOTE).toContain("Jira, Confluence, GitHub and Zendesk tools all refuse you");
  });
});

describe("filesystemNudge", () => {
  test("renders identity and clause, naming no tool (there is none)", () => {
    expect(filesystemNudge("/repo/a.md", undefined)).toBe("[butchr] Filesystem resource /repo/a.md was updated (reason not determinable from the poll) — re-read it from disk.");
    expect(filesystemNudge("/repo/a.md", { appeared: true })).toBe("[butchr] Filesystem resource /repo/a.md just appeared in the watch set — re-read it from disk.");
    expect(filesystemNudge("/repo/a.md", { disappeared: true })).toBe("[butchr] Filesystem resource /repo/a.md just dropped out of the watch set — re-read it from disk.");
  });
});

test("FILESYSTEM_POLL_MS is a sane, defined cadence", () => {
  expect(FILESYSTEM_POLL_MS).toBeGreaterThan(0);
});

test("runResourceLoop stays importable directly for a fully generic filesystem type run", async () => {
  const { herd, spawned } = fakeHerd();
  const type = createFilesystemResourceType({ rules: [rule({ enabled: false })], list: async () => [res("/repo/a.md")] });
  const stop = runResourceLoop(type, { herd, ownsId: ownsFilesystemAgent, intervalMs: 5, notify: () => {} });
  await tick();
  stop();
  expect(spawned).toEqual([]); // rule disabled — createFilesystemResourceType's own search() already filters it out
});
