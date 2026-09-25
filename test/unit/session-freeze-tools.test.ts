import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDef } from "@brooswit/thatch";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import { MANAGED_SESSIONS_RULE_ID } from "../../src/rules/session-definition-type.js";
import type { FilesystemQuery } from "../../src/resources/filesystem-query.js";
import { listFilesystemResources, type FilesystemResource } from "../../src/resources/filesystem.js";
import type { SessionFreezeStore } from "../../src/resources/session-freeze.js";
import { sessionFreezeTools, type SessionFreezeToolDeps } from "../../src/tools/session-freeze-tools.js";
import { Refusal } from "../../src/tools/outcome.js";

const goodDef = (over: Record<string, unknown> = {}) => ({
  workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default", ...over,
});

const agentKeyFor = (path: string): string => encodeAgentKey({ resourceProvider: "filesystem", ruleId: MANAGED_SESSIONS_RULE_ID, resourceId: path });

function fakeStore(initial: Record<string, boolean> = {}): SessionFreezeStore {
  const state = new Map(Object.entries(initial));
  return {
    async read(id) { return { frozen: state.get(id) ?? false }; },
    async set(id, frozen) { state.set(id, frozen); },
  };
}

/** In-memory definitions directory: `files` maps path -> raw JSON text, mutable so a freeze/unfreeze rewrite is observable. */
function fakeDeps(files: Record<string, string>, store: SessionFreezeStore = fakeStore()): SessionFreezeToolDeps & { files: Record<string, string> } {
  const list = async (_q: FilesystemQuery): Promise<FilesystemResource[]> =>
    Object.keys(files).map((path) => ({ path, kind: "file" as const, name: path.split("/").pop()!, size: 10, mtimeMs: 1 }));
  const read = async (path: string): Promise<string> => {
    if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return files[path]!;
  };
  return {
    dir: "/defs", list, read, files,
    freeze: { store, readFile: read, writeFile: async (p, c) => { files[p] = c; } },
    log: () => {},
  };
}

const call = (tools: Record<string, ToolDef<any>>, name: string, args: unknown, headers: Record<string, string>) =>
  Promise.resolve().then(() => tools[name]!.handler(args as never, { headers } as never));

const DIRECTOR = "/defs/director.json";
const CODEX_DIRECTOR = "/defs/codex-director.json";
const director = { headers: { "x-butchr-agent": agentKeyFor(DIRECTOR) } };
const codexDirector = { headers: { "x-butchr-agent": agentKeyFor(CODEX_DIRECTOR) } };

/** The staged scenario every test below shares: a claude controller granted freeze-only on one target and unfreeze-only on another, a codex controller granted both on a third, and a fourth target that grants NOBODY (scope isolation). */
function stagedFiles(): Record<string, string> {
  return {
    [DIRECTOR]: JSON.stringify(goodDef()),
    [CODEX_DIRECTOR]: JSON.stringify(goodDef({ vendor: "codex" })),
    "/defs/mud-player-freeze-only.json": JSON.stringify(goodDef({ freezeControllers: ["director"] })),
    "/defs/mud-player-unfreeze-only.json": JSON.stringify(goodDef({ frozen: true, unfreezeControllers: ["director"] })),
    "/defs/mud-player-codex.json": JSON.stringify(goodDef({ vendor: "codex", freezeControllers: ["codex-director"], unfreezeControllers: ["codex-director"] })),
    "/defs/ungranted.json": JSON.stringify(goodDef()),
    "/defs/broken.json": JSON.stringify({ ...goodDef(), vendor: "not-a-vendor", freezeControllers: ["director"] }),
  };
}

describe("freeze_session / unfreeze_session — granted calls", () => {
  test("freeze granted -> succeeds, both gates end frozen; grant fields survive the rewrite", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    const result = await call(tools, "freeze_session", { name: "mud-player-freeze-only" }, director.headers);
    expect(result).toEqual({ ok: true, name: "mud-player-freeze-only.json", gates: { manifestFrozen: true, storeFrozen: true } });
    const written = JSON.parse(deps.files["/defs/mud-player-freeze-only.json"]!);
    expect(written.frozen).toBe(true);
    expect(written.freezeControllers).toEqual(["director"]); // preserved byte-for-value, not dropped by the rewrite
  });

  test("unfreeze granted -> succeeds, both gates end open", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    const result = await call(tools, "unfreeze_session", { name: "mud-player-unfreeze-only" }, director.headers);
    expect(result).toEqual({ ok: true, name: "mud-player-unfreeze-only.json", gates: { manifestFrozen: false, storeFrozen: false } });
    expect(JSON.parse(deps.files["/defs/mud-player-unfreeze-only.json"]!).frozen).toBe(false);
  });

  test("both claude and codex controllers/targets work identically — vendor plays no role in authorization", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    const frozen = await call(tools, "freeze_session", { name: "mud-player-codex" }, codexDirector.headers);
    expect(frozen).toMatchObject({ ok: true, gates: { manifestFrozen: true, storeFrozen: true } });
    const unfrozen = await call(tools, "unfreeze_session", { name: "mud-player-codex" }, codexDirector.headers);
    expect(unfrozen).toMatchObject({ ok: true, gates: { manifestFrozen: false, storeFrozen: false } });
  });

  test("with-or-without .json in the argument resolves the same target", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    const result = await call(tools, "freeze_session", { name: "mud-player-freeze-only.json" }, director.headers);
    expect(result).toMatchObject({ ok: true, name: "mud-player-freeze-only.json" });
  });
});

describe("freeze_session / unfreeze_session — the two grants are independent", () => {
  test("a controller in freezeControllers only cannot unfreeze the same target", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    await expect(call(tools, "unfreeze_session", { name: "mud-player-freeze-only" }, director.headers)).rejects.toBeInstanceOf(Refusal);
  });

  test("a controller in unfreezeControllers only cannot freeze the same target", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    await expect(call(tools, "freeze_session", { name: "mud-player-unfreeze-only" }, director.headers)).rejects.toBeInstanceOf(Refusal);
  });
});

describe("freeze_session / unfreeze_session — scope isolation", () => {
  test("a controller cannot touch a definition that does not list it, even though it is granted elsewhere", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    await expect(call(tools, "freeze_session", { name: "ungranted" }, director.headers)).rejects.toBeInstanceOf(Refusal);
    await expect(call(tools, "unfreeze_session", { name: "ungranted" }, director.headers)).rejects.toBeInstanceOf(Refusal);
    // the ungranted file itself is untouched
    expect(JSON.parse(deps.files["/defs/ungranted.json"]!).frozen).toBeUndefined();
  });

  test("the codex controller's own grant does not leak to the claude controller's targets, or vice versa", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    await expect(call(tools, "freeze_session", { name: "mud-player-codex" }, director.headers)).rejects.toBeInstanceOf(Refusal);
    await expect(call(tools, "freeze_session", { name: "mud-player-freeze-only" }, codexDirector.headers)).rejects.toBeInstanceOf(Refusal);
  });
});

describe("freeze_session / unfreeze_session — every refusal reads identically", () => {
  async function refusalMessage(tools: Record<string, ToolDef<any>>, verb: "freeze_session" | "unfreeze_session", name: string, headers: Record<string, string>): Promise<string> {
    try {
      await call(tools, verb, { name }, headers);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(Refusal);
      return (e as Error).message;
    }
  }

  test("unknown name, invalid target, no grant, and a non-managed-session caller all throw the exact same message", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    const canonical = await refusalMessage(tools, "freeze_session", "does-not-exist", director.headers);

    const invalidTarget = await refusalMessage(tools, "freeze_session", "broken", director.headers); // fails to parse, even though it NAMES director
    const noGrant = await refusalMessage(tools, "freeze_session", "ungranted", director.headers);
    const jiraWorkCaller = await refusalMessage(tools, "freeze_session", "mud-player-freeze-only", { "x-issue": "BUTCHR-1" });
    const githubCaller = await refusalMessage(tools, "freeze_session", "mud-player-freeze-only", { "x-butchr-agent": "github-issue:bugs:acme%2Fw%2312" });
    const noIdentity = await refusalMessage(tools, "freeze_session", "mud-player-freeze-only", {});
    const bogusAgentKey = await refusalMessage(tools, "freeze_session", "mud-player-freeze-only", { "x-butchr-agent": "not-a-real-key" });

    for (const msg of [invalidTarget, noGrant, jiraWorkCaller, githubCaller, noIdentity, bogusAgentKey]) {
      expect(msg).toBe(canonical);
    }
  });

  test("unfreeze_session's refusal message differs from freeze_session's (names the right grant field) but is equally uniform across its own failure shapes", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    const canonical = await refusalMessage(tools, "unfreeze_session", "does-not-exist", director.headers);
    const noGrant = await refusalMessage(tools, "unfreeze_session", "ungranted", director.headers);
    expect(noGrant).toBe(canonical);
    const freezeCanonical = await refusalMessage(tools, "freeze_session", "does-not-exist", director.headers);
    expect(canonical).not.toBe(freezeCanonical); // the two verbs' messages differ from EACH OTHER; each is uniform only within itself
  });

  test("a plain filesystem (non-managed-session) agent, with a real BUTCHR-407 rule id, is refused exactly like a stranger", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    const plainFilesystemAgent = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "some-other-rule", resourceId: DIRECTOR });
    await expect(call(tools, "freeze_session", { name: "mud-player-freeze-only" }, { "x-butchr-agent": plainFilesystemAgent })).rejects.toBeInstanceOf(Refusal);
  });

  test("a query-level agent key (no single resource) is refused, not misread as a per-resource managed-session caller", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    await expect(call(tools, "freeze_session", { name: "mud-player-freeze-only" }, { "x-butchr-agent": `filesystem:${MANAGED_SESSIONS_RULE_ID}:%40query` })).rejects.toBeInstanceOf(Refusal);
  });

  test("caller identity is taken ONLY from the header-derived identity — an arbitrary extra field in the arguments cannot claim authorization", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    // "ungranted" lists nobody; passing an unrelated extra argument field changes nothing, because the
    // tool's own schema is `{ name }` and the handler reads identity from `c.headers`, never from `a`.
    await expect(call(tools, "freeze_session", { name: "ungranted", agent: agentKeyFor(DIRECTOR), callerAgentKey: agentKeyFor(DIRECTOR) }, director.headers)).rejects.toBeInstanceOf(Refusal);
  });
});

describe("freeze_session / unfreeze_session — path traversal and symlink attempts resolve to nothing", () => {
  test("a name containing a path separator, '..', or an absolute path never matches any real entry", async () => {
    const deps = fakeDeps(stagedFiles());
    const tools = sessionFreezeTools(deps);
    for (const bad of ["../mud-player-freeze-only", "..", "/etc/passwd", "sub/mud-player-freeze-only", "mud-player-freeze-only/../../etc/passwd"]) {
      await expect(call(tools, "freeze_session", { name: bad }, director.headers)).rejects.toBeInstanceOf(Refusal);
    }
  });

  test("real disk: a symlinked file inside the definitions directory is never listed, so it can never be named as a target or resolve a controller's grant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "butchr-freeze-tools-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "butchr-freeze-tools-outside-"));
    const outsideSecret = join(outside, "secret.json");
    await writeFile(outsideSecret, JSON.stringify(goodDef({ freezeControllers: ["director"] })));
    await writeFile(join(dir, "director.json"), JSON.stringify(goodDef()));
    await symlink(outsideSecret, join(dir, "escape.json"));
    // Real `listFilesystemResources`/disk reads (what actually proves the symlink is skipped) — but a FAKE
    // freeze store, never `defaultSessionFreezeIo()`: `listSessionDefinitions` reads the store for every
    // listed entry, and this ticket's own hard constraint forbids touching the real store from a test.
    const deps: SessionFreezeToolDeps = {
      dir, list: listFilesystemResources, read: (p) => readFile(p, "utf8"),
      freeze: { store: fakeStore(), readFile: (p) => readFile(p, "utf8"), writeFile: async () => { throw new Error("unreached — refused before any write"); } },
      log: () => {},
    };
    const tools = sessionFreezeTools(deps);
    const director2 = { "x-butchr-agent": agentKeyFor(join(dir, "director.json")) };
    await expect(call(tools, "freeze_session", { name: "escape" }, director2)).rejects.toBeInstanceOf(Refusal);
    await expect(call(tools, "freeze_session", { name: "escape.json" }, director2)).rejects.toBeInstanceOf(Refusal);
  });
});
