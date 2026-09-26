import { describe, expect, test } from "bun:test";
import type { Herd } from "../../src/agents/herd.js";
import type { SpawnSpec } from "../../src/agents/workspace.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";
import type { ExecutionUnit } from "../../src/rules/execution.js";
import type { Rule } from "../../src/rules/rules.js";
import type { FilesystemQuery } from "../../src/resources/filesystem-query.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";
import {
  builtinManagedSessionsRule, createManagedSessionResourceType, createSessionDefinitionEventRules,
  MANAGED_SESSIONS_RULE_ID, onceFrozenDefinition, onceInvalidDefinition, onceMissingRoot, ownsManagedSessionAgent,
  searchSessionDefinitions, specForSessionDefinition, specForSessionDefinitionUnit,
  type SessionDefinitionMatch,
} from "../../src/rules/session-definition-type.js";
import { listFilesystemResources } from "../../src/resources/filesystem.js";
import { startManagedSessionsLoop } from "../../src/daemon/session-definitions-loop.js";
import { startFilesystemLoop } from "../../src/daemon/filesystem-loop.js";
import { createAdmissionController } from "../../src/agents/admission.js";

const res = (path: string, over: Partial<FilesystemResource> = {}): FilesystemResource =>
  ({ path, kind: "file", name: path.split("/").pop()!, size: 10, mtimeMs: 1000, ...over });

/** A minimal valid definition body, as it would be written to a *.json file. */
const goodDef = (over: Record<string, unknown> = {}) => ({
  workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default", ...over,
});

function fakeFiles(files: Record<string, string>) {
  const list = async (_q: FilesystemQuery): Promise<FilesystemResource[]> => Object.keys(files).map((p) => res(p));
  const read = async (path: string): Promise<string> => {
    if (!(path in files)) throw new Error(`ENOENT: no such file ${path}`);
    return files[path]!;
  };
  return { list, read };
}

describe("builtinManagedSessionsRule", () => {
  test("a filesystem rule, one file per direct child, fixed swarm/none/worker, over the given root", () => {
    const rule = builtinManagedSessionsRule("/defs");
    expect(rule.id).toBe(MANAGED_SESSIONS_RULE_ID);
    expect(rule.resourceProvider).toBe("filesystem");
    expect(rule.execution).toBe("swarm");
    expect(rule.account).toBe("none");
    expect(JSON.parse(rule.query)).toEqual({ root: "/defs", kind: "file", maxDepth: 1 });
  });
});

describe("searchSessionDefinitions — eligible = valid, not frozen", () => {
  const rule = builtinManagedSessionsRule("/defs");

  test("a valid, non-frozen definition is eligible", async () => {
    const { list, read } = fakeFiles({ "/defs/a.json": JSON.stringify(goodDef()) });
    const matches = await searchSessionDefinitions({ rule, list, read });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.definition.vendor).toBe("claude");
    expect(matches[0]!.agentKey).toBe(encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/a.json" }));
  });

  test("invalid JSON is excluded and reported once via onInvalid, never crashes the poll, siblings still staff", async () => {
    const { list, read } = fakeFiles({ "/defs/bad.json": "not json", "/defs/good.json": JSON.stringify(goodDef()) });
    const invalid: Array<[string, string]> = [];
    const matches = await searchSessionDefinitions({ rule, list, read }, undefined, (p, e) => invalid.push([p, e]));
    expect(matches.map((m) => m.resource.path)).toEqual(["/defs/good.json"]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]![0]).toBe("/defs/bad.json");
    expect(invalid[0]![1]).toContain("invalid JSON");
  });

  test("a schema-invalid definition (missing required field) is excluded and reported", async () => {
    const { list, read } = fakeFiles({ "/defs/incomplete.json": JSON.stringify({ workingDirectory: "/x" }) });
    const invalid: Array<[string, string]> = [];
    const matches = await searchSessionDefinitions({ rule, list, read }, undefined, (p, e) => invalid.push([p, e]));
    expect(matches).toEqual([]);
    expect(invalid[0]![1]).toContain("brief must be a non-empty string");
  });

  test("a frozen definition is VALID but excluded, reported distinctly via onFrozen (not onInvalid)", async () => {
    const { list, read } = fakeFiles({ "/defs/frozen.json": JSON.stringify(goodDef({ frozen: true })) });
    const invalid: string[] = [];
    const frozen: string[] = [];
    const matches = await searchSessionDefinitions({ rule, list, read }, undefined, (p) => invalid.push(p), (p) => frozen.push(p));
    expect(matches).toEqual([]);
    expect(invalid).toEqual([]);
    expect(frozen).toEqual(["/defs/frozen.json"]);
  });

  test("a definition whose id would overflow the workspace-directory-name limit is skipped via onOversized, same as any other filesystem resource", async () => {
    const oversized = `/defs/${"d".repeat(300)}.json`;
    const { list, read } = fakeFiles({ [oversized]: JSON.stringify(goodDef()), "/defs/a.json": JSON.stringify(goodDef()) });
    const skipped: string[] = [];
    const matches = await searchSessionDefinitions({ rule, list, read }, (_r, p) => skipped.push(p));
    expect(matches.map((m) => m.resource.path)).toEqual(["/defs/a.json"]);
    expect(skipped).toEqual([oversized]);
  });

  test("BUTCHR-455 review fix: a hidden (dotfile) basename is never a candidate, even with a perfectly valid, non-frozen manifest — never onOversized/onInvalid/onFrozen, never logged at all", async () => {
    // Exactly the shape writeFileAtomic's own temp file takes (`.${uuid}.tmp`), and this ticket's own
    // EXDEV unarchive fallback's temp file — see isHiddenDefinitionFile's own doc comment for why.
    const { list, read } = fakeFiles({
      "/defs/.abc123.tmp": JSON.stringify(goodDef()),
      "/defs/good.json": JSON.stringify(goodDef()),
    });
    const oversized: string[] = [], invalid: string[] = [], frozen: string[] = [];
    const matches = await searchSessionDefinitions(
      { rule, list, read },
      (_r, p) => oversized.push(p),
      (p) => invalid.push(p),
      (p) => frozen.push(p),
    );
    expect(matches.map((m) => m.resource.path)).toEqual(["/defs/good.json"]);
    expect(oversized).toEqual([]);
    expect(invalid).toEqual([]);
    expect(frozen).toEqual([]);
  });

  test("BUTCHR-455 review fix: a hidden basename with a FROZEN manifest is still never a candidate and never reported via onFrozen either", async () => {
    const { list, read } = fakeFiles({ "/defs/.abc.tmp": JSON.stringify(goodDef({ frozen: true })) });
    const frozen: string[] = [];
    const matches = await searchSessionDefinitions({ rule, list, read }, undefined, undefined, (p) => frozen.push(p));
    expect(matches).toEqual([]);
    expect(frozen).toEqual([]);
  });

  test("PR #394 review fix 3: a missing well-known directory (ENOENT) is 0 definitions, NEVER a poll error — reported via onMissingRoot, once", async () => {
    const missing: number[] = [];
    const list = async (): Promise<FilesystemResource[]> => { throw Object.assign(new Error("filesystem root /nope is not readable: ENOENT: no such file or directory, realpath '/nope'"), { code: "ENOENT" }); };
    const matches = await searchSessionDefinitions({ rule, list, read: async () => "" }, undefined, undefined, undefined, () => missing.push(1));
    expect(matches).toEqual([]);
    expect(missing).toEqual([1]);
  });

  test("PR #394 review fix 3: a root that exists but is unreadable/not-a-directory (any OTHER error code) still fails the whole poll", async () => {
    const list = async (): Promise<FilesystemResource[]> => { throw Object.assign(new Error("filesystem root /defs is not readable: ENOTDIR: not a directory"), { code: "ENOTDIR" }); };
    await expect(searchSessionDefinitions({ rule, list, read: async () => "" })).rejects.toThrow("ENOTDIR");
  });

  test("mixed: one valid, one invalid, one frozen — only the valid one is eligible, nothing crashes", async () => {
    const { list, read } = fakeFiles({
      "/defs/ok.json": JSON.stringify(goodDef()),
      "/defs/bad.json": "{not json",
      "/defs/frozen.json": JSON.stringify(goodDef({ frozen: true })),
    });
    const matches = await searchSessionDefinitions({ rule, list, read });
    expect(matches.map((m) => m.resource.path)).toEqual(["/defs/ok.json"]);
  });
});

describe("onceInvalidDefinition / onceFrozenDefinition — log once, never spam", () => {
  test("the same (path, error) pair logs only once; a NEW error on the same path logs again", () => {
    const lines: string[] = [];
    const onInvalid = onceInvalidDefinition((l) => lines.push(l));
    onInvalid("/defs/a.json", "boom"); onInvalid("/defs/a.json", "boom");
    expect(lines).toHaveLength(1);
    onInvalid("/defs/a.json", "different problem");
    expect(lines).toHaveLength(2);
  });
  test("the same frozen path logs only once", () => {
    const lines: string[] = [];
    const onFrozen = onceFrozenDefinition((l) => lines.push(l));
    onFrozen("/defs/a.json"); onFrozen("/defs/a.json");
    expect(lines).toHaveLength(1);
  });
  test("PR #394 review fix 3: the missing-root FYI logs only once, never respammed while it stays missing", () => {
    const lines: string[] = [];
    const onMissingRoot = onceMissingRoot((l) => lines.push(l));
    onMissingRoot(); onMissingRoot(); onMissingRoot();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not an error");
  });
});

describe("PR #394 review fix 3, end-to-end: a genuinely nonexistent well-known directory never fails the poll", () => {
  test("createManagedSessionResourceType against the REAL listFilesystemResources (not a fake) on a directory that does not exist", async () => {
    const rule = builtinManagedSessionsRule("/definitely/does/not/exist/on/this/machine");
    const logs: string[] = [];
    const type = createManagedSessionResourceType({ rule, list: listFilesystemResources, read: async () => "", log: (l) => logs.push(l) });
    const units = await type.discovery.search(); // must NOT throw
    expect(units).toEqual([]);
    expect(logs.some((l) => l.includes("does not exist yet"))).toBe(true);
  });
});

describe("specForSessionDefinition", () => {
  test("builds a SpawnSpec carrying the definition's cwd/permissionMode/vendor+tier-as-model/brief", () => {
    const rule = builtinManagedSessionsRule("/defs");
    const match: SessionDefinitionMatch = {
      agentKey: encodeAgentKey({ resourceProvider: "filesystem", ruleId: rule.id, resourceId: "/defs/a.json" }),
      rule, resource: res("/defs/a.json"),
      definition: { workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "codex", tier: "tier2", permissionMode: "auto", execution: "swarm", account: "none", role: "worker", frozen: false },
    };
    const spec = specForSessionDefinition(match);
    expect(spec.key).toBe(match.agentKey);
    expect(spec.resource).toBe("/defs/a.json");
    expect(spec.brief).toBe("Tend this repo.");
    expect(spec.cwd).toBe("/repo/project");
    expect(spec.permissionMode).toBe("auto");
    expect(spec.agents).toEqual([{ harness: "codex", model: "gpt-5.6-terra" }]);
    expect(spec.parent).toBeNull();
    expect(spec.mcpServers).toBeUndefined();
    expect(spec.strictMcpConfig).toBeUndefined();
  });

  test("BUTCHR-453/BUTCHR-463: carries the definition's own strictMcpConfig through to the SpawnSpec", () => {
    const rule = builtinManagedSessionsRule("/defs");
    const match: SessionDefinitionMatch = {
      agentKey: encodeAgentKey({ resourceProvider: "filesystem", ruleId: rule.id, resourceId: "/defs/a.json" }),
      rule, resource: res("/defs/a.json"),
      definition: { workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier2", permissionMode: "auto", execution: "swarm", account: "none", role: "worker", frozen: false, strictMcpConfig: true },
    };
    expect(specForSessionDefinition(match).strictMcpConfig).toBe(true);
  });

  test("carries the definition's own mcpServers through to the SpawnSpec (BUTCHR-408, type ported from S4)", () => {
    const rule = builtinManagedSessionsRule("/defs");
    const mcpServers = [{ name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", channel: true }];
    const match: SessionDefinitionMatch = {
      agentKey: encodeAgentKey({ resourceProvider: "filesystem", ruleId: rule.id, resourceId: "/defs/a.json" }),
      rule, resource: res("/defs/a.json"),
      definition: { workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "auto", execution: "swarm", account: "none", role: "worker", frozen: false, mcpServers },
    };
    expect(specForSessionDefinition(match).mcpServers).toEqual(mcpServers);
  });

  test("specForSessionDefinitionUnit dispatches resource units; a query-kind unit (never actually produced) throws rather than silently mis-spawning", () => {
    const rule = builtinManagedSessionsRule("/defs");
    const match: SessionDefinitionMatch = {
      agentKey: encodeAgentKey({ resourceProvider: "filesystem", ruleId: rule.id, resourceId: "/defs/a.json" }),
      rule, resource: res("/defs/a.json"),
      definition: { workingDirectory: "/x", brief: "b", vendor: "claude", tier: "tier3", permissionMode: "default", execution: "swarm", account: "none", role: "worker", frozen: false },
    };
    expect(specForSessionDefinitionUnit({ kind: "resource", match })).toEqual(specForSessionDefinition(match));
    const qkey = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: rule.id });
    expect(() => specForSessionDefinitionUnit({ kind: "query", agentKey: qkey, rule })).toThrow(/must always run swarm/);
  });
});

describe("ownsManagedSessionAgent", () => {
  test("recognises only the managed-sessions rule's own filesystem agent keys", () => {
    expect(ownsManagedSessionAgent(encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/a.json" }))).toBe(true);
    expect(ownsManagedSessionAgent(encodeAgentKey({ resourceProvider: "filesystem", ruleId: "some-other-rule", resourceId: "/defs/a.json" }))).toBe(false);
    expect(ownsManagedSessionAgent(encodeAgentKey({ resourceProvider: "jira-work", ruleId: "managed-sessions", resourceId: "BUTCHR-1" }))).toBe(false);
    expect(ownsManagedSessionAgent("not a key")).toBe(false);
  });
});

describe("createManagedSessionResourceType", () => {
  test("one unit per eligible definition; frozen/invalid never appear", async () => {
    let files: Record<string, string> = { "/defs/a.json": JSON.stringify(goodDef()), "/defs/frozen.json": JSON.stringify(goodDef({ frozen: true })) };
    const { list, read } = fakeFiles(files);
    const rule = builtinManagedSessionsRule("/defs");
    const type = createManagedSessionResourceType({ rule, list, read: async (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; } });
    const units = await type.discovery.search();
    expect(units.map((u) => type.discovery.idOf(u))).toEqual([encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/a.json" })]);
    files = {};
    expect((await type.discovery.search()).length).toBe(0);
  });

  test("PR #394 review fix 1: `roles` is cleared and rebuilt every search from each eligible match's OWN manifest role, keyed by agent key — a frozen/removed definition's role does not linger", async () => {
    let files: Record<string, string> = {
      "/defs/a.json": JSON.stringify(goodDef({ role: "sentinel" })),
      "/defs/b.json": JSON.stringify(goodDef({ role: "worker" })),
    };
    const { list } = fakeFiles(files);
    const rule = builtinManagedSessionsRule("/defs");
    const roles = new Map<string, "worker" | "sentinel">();
    const type = createManagedSessionResourceType({ rule, list, read: async (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; }, roles });
    const keyA = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/a.json" });
    const keyB = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/b.json" });
    await type.discovery.search();
    expect(roles.get(keyA)).toBe("sentinel");
    expect(roles.get(keyB)).toBe("worker");
    // b.json goes frozen (still valid, but ineligible) — its role entry must not linger.
    files = { "/defs/a.json": files["/defs/a.json"]!, "/defs/b.json": JSON.stringify(goodDef({ role: "worker", frozen: true })) };
    await type.discovery.search();
    expect(roles.get(keyA)).toBe("sentinel");
    expect(roles.has(keyB)).toBe(false);
  });

  test("BUTCHR-460: `accountPolicies` is cleared and rebuilt every search from each eligible match's OWN manifest account policy, keyed by agent key — a frozen/removed definition's policy does not linger", async () => {
    let files: Record<string, string> = {
      "/defs/a.json": JSON.stringify(goodDef({ account: "temporary" })),
      "/defs/b.json": JSON.stringify(goodDef({ account: "permanent" })),
      "/defs/c.json": JSON.stringify(goodDef({})), // no `account` given — defaults to "none"
    };
    const { list } = fakeFiles(files);
    const rule = builtinManagedSessionsRule("/defs");
    const accountPolicies = new Map<string, "none" | "temporary" | "permanent">();
    const type = createManagedSessionResourceType({ rule, list, read: async (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; }, accountPolicies });
    const keyA = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/a.json" });
    const keyB = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/b.json" });
    const keyC = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/c.json" });
    await type.discovery.search();
    expect(accountPolicies.get(keyA)).toBe("temporary");
    expect(accountPolicies.get(keyB)).toBe("permanent");
    expect(accountPolicies.get(keyC)).toBe("none");
    // b.json goes frozen (still valid, but ineligible) — its policy entry must not linger.
    files = { "/defs/a.json": files["/defs/a.json"]!, "/defs/b.json": JSON.stringify(goodDef({ account: "permanent", frozen: true })), "/defs/c.json": files["/defs/c.json"]! };
    await type.discovery.search();
    expect(accountPolicies.get(keyA)).toBe("temporary");
    expect(accountPolicies.has(keyB)).toBe(false);
  });

  test("PR #394 review fix 1, end-to-end: a sentinel definition's agent is admitted and not counted against the cap, and a worker definition's agent is capped — through the REAL createAdmissionController, not a stub", async () => {
    const files: Record<string, string> = {
      "/defs/sentinel.json": JSON.stringify(goodDef({ role: "sentinel", workingDirectory: "/repo/sentinel" })),
      "/defs/worker-a.json": JSON.stringify(goodDef({ role: "worker", workingDirectory: "/repo/worker-a" })),
      "/defs/worker-b.json": JSON.stringify(goodDef({ role: "worker", workingDirectory: "/repo/worker-b" })),
    };
    const { list, read } = fakeFiles(files);
    const rule = builtinManagedSessionsRule("/defs");
    const roles = new Map<string, "worker" | "sentinel">();
    const type = createManagedSessionResourceType({ rule, list, read, roles });
    const units = await type.discovery.search();
    const candidates = units.map((u) => type.discovery.idOf(u));
    expect(candidates.length).toBe(3);

    const controller = createAdmissionController({
      cap: 1, // only ONE worker slot — the sentinel must not consume it
      residency: async () => [],
      roleOf: (id) => roles.get(id) ?? "worker",
      sources: ["managed-sessions"],
    });
    const admitted = await controller.admit(candidates, [], "managed-sessions");

    const sentinelId = candidates.find((id) => id.includes("sentinel.json"))!;
    const workerIds = candidates.filter((id) => id.includes("worker-"));
    expect(admitted).toContain(sentinelId); // sentinel: always admitted, per role
    expect(admitted.filter((id) => workerIds.includes(id)).length).toBe(1); // worker: capped at 1
    expect(admitted.length).toBe(2); // sentinel + exactly one worker, not all three
  });

  test("activation is always active for whatever reaches it (frozen/invalid never do)", () => {
    const rule = builtinManagedSessionsRule("/defs");
    const type = createManagedSessionResourceType({ rule, list: async () => [], read: async () => "" });
    const match: SessionDefinitionMatch = { agentKey: "x", rule, resource: res("/defs/a.json"), definition: { workingDirectory: "/x", brief: "b", vendor: "claude", tier: "tier3", permissionMode: "default", execution: "swarm", account: "none", role: "worker", frozen: false } };
    expect(type.activation.verdictFor({ kind: "resource", match })).toBe("active");
  });
});

describe("createSessionDefinitionEventRules", () => {
  test("unchanged content never notifies; a size/mtime move notifies the resource's own agent only", async () => {
    const rule = builtinManagedSessionsRule("/defs");
    const definition = { workingDirectory: "/x", brief: "b", vendor: "claude" as const, tier: "tier3" as const, permissionMode: "default" as const, execution: "swarm" as const, account: "none" as const, role: "worker" as const, frozen: false };
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: rule.id, resourceId: "/defs/a.json" });
    const unit = (r: FilesystemResource): ExecutionUnit<SessionDefinitionMatch> => ({ kind: "resource", match: { agentKey: key, rule, resource: r, definition } });
    const type = createSessionDefinitionEventRules();
    const unchanged = await type.poll({ primary: [unit(res("/defs/a.json"))], related: [] }, { primary: [unit(res("/defs/a.json"))], related: [] });
    expect(unchanged.changedPrimary).toEqual([]);
    const changed = await type.poll({ primary: [unit(res("/defs/a.json", { mtimeMs: 1 }))], related: [] }, { primary: [unit(res("/defs/a.json", { mtimeMs: 2 }))], related: [] });
    expect(changed.changedPrimary).toEqual([key]);
    expect(await changed.decide(key, key, "primary")).toEqual({ deliver: true });
    expect(await changed.decide(key, "someone-else", "primary")).toEqual({ deliver: false });
    expect(changed.changedRelated).toEqual([]);
    expect(await changed.decide(key, key, "related")).toEqual({ deliver: false });
  });
});

// ---------------------------------------------------------------------------
// daemon/session-definitions-loop.ts — end-to-end reconcile against a fake herd
// ---------------------------------------------------------------------------

const tick = () => new Promise((r) => setTimeout(r, 40));

function fakeHerd(initial: string[] = []): { herd: Herd; spawned: SpawnSpec[]; stopped: string[]; running: Set<string> } {
  const running = new Set(initial);
  const spawned: SpawnSpec[] = [], stopped: string[] = [];
  const herd: Herd = {
    async runningIssues() { return [...running]; },
    async staleIssues() { return []; },
    async spawn(sp) { spawned.push(sp); running.add(sp.key); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
  };
  return { herd, spawned, stopped, running };
}

describe("the managed-sessions built-in query loop — no-double-owner and add/modify/remove reconciliation", () => {
  test("spawns one agent per eligible definition, none for frozen/invalid, stops on removal", async () => {
    let files: Record<string, string> = {
      "/defs/baker.json": JSON.stringify(goodDef({ workingDirectory: "/repo/baker-project" })),
      "/defs/frozen.json": JSON.stringify(goodDef({ frozen: true })),
      "/defs/broken.json": "not json",
    };
    const { herd, spawned, stopped } = fakeHerd([]);
    const logs: string[] = [];
    const stop = startManagedSessionsLoop({
      root: "/defs", herd, deliver: async () => {},
      list: async () => Object.keys(files).map((p) => res(p)),
      read: async (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; },
      log: (l) => logs.push(l), intervalMs: 5,
    });
    await tick();
    const bakerKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/baker.json" });
    expect(spawned.map((s) => s.key)).toEqual([bakerKey]);
    expect(logs.some((l) => l.includes("frozen.json") && l.includes("frozen"))).toBe(true);
    expect(logs.some((l) => l.includes("broken.json") && l.includes("never staffed"))).toBe(true);

    files = {}; // baker.json removed
    await tick();
    stop();
    expect(stopped).toEqual([bakerKey]);
  });

  test("no double-staffing: a definition whose agent is already running is never spawned again", async () => {
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/a.json" });
    const { herd, spawned } = fakeHerd([key]);
    const stop = startManagedSessionsLoop({
      root: "/defs", herd, deliver: async () => {},
      list: async () => [res("/defs/a.json")],
      read: async () => JSON.stringify(goodDef()),
      log: () => {}, intervalMs: 5,
    });
    await tick(); await tick();
    stop();
    expect(spawned).toEqual([]);
  });

  test("add: a new definition file appearing spawns exactly one new agent, existing ones untouched", async () => {
    let files: Record<string, string> = { "/defs/a.json": JSON.stringify(goodDef()) };
    const { herd, spawned } = fakeHerd([]);
    const stop = startManagedSessionsLoop({
      root: "/defs", herd, deliver: async () => {},
      list: async () => Object.keys(files).map((p) => res(p)),
      read: async (p) => files[p]!,
      log: () => {}, intervalMs: 5,
    });
    await tick();
    const aKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/a.json" });
    expect(spawned.map((s) => s.key)).toEqual([aKey]);
    files = { ...files, "/defs/b.json": JSON.stringify(goodDef()) };
    await tick();
    stop();
    const bKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/b.json" });
    expect(spawned.map((s) => s.key).sort()).toEqual([aKey, bKey].sort());
  });

  test("modify: editing an already-running definition's content does not force a respawn (no key change) — same precedent as every other rule provider", async () => {
    let body = goodDef({ brief: "original" });
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/a.json" });
    const { herd, spawned, stopped } = fakeHerd([]);
    const stop = startManagedSessionsLoop({
      root: "/defs", herd, deliver: async () => {},
      list: async () => [res("/defs/a.json", { mtimeMs: Date.now() })],
      read: async () => JSON.stringify(body),
      log: () => {}, intervalMs: 5,
    });
    await tick();
    expect(spawned.map((s) => s.key)).toEqual([key]);
    body = goodDef({ brief: "changed" });
    await tick(); await tick();
    stop();
    // Still exactly one spawn call total — a content edit notifies (event rules), never respawns.
    expect(spawned.map((s) => s.key)).toEqual([key]);
    expect(stopped).toEqual([]);
  });

  test("BUTCHR-408 staged scenarios (a-d): Baker directory agent, Candlestix Claude session, Candlestix Codex session, and a non-Rocket.Chat-channel-bound sentinel (mud-bridge director, real S4 McpServerBinding type) all validate and produce the expected spawn shape; a frozen mud player stays frozen — no agent", async () => {
    const files: Record<string, string> = {
      "/defs/baker-repo.json": JSON.stringify(goodDef({
        workingDirectory: "/repo/some-project", brief: "Keep this repo's docs current.", vendor: "claude", tier: "tier1", permissionMode: "default", role: "worker",
      })),
      "/defs/candlestix-factory-director.json": JSON.stringify(goodDef({
        workingDirectory: "/var/candlestix/factory", brief: "Direct the factory channel.", vendor: "claude", tier: "tier2", permissionMode: "auto",
        execution: "persistent", account: "permanent", role: "sentinel",
      })),
      "/defs/candlestix-codex-agent.json": JSON.stringify(goodDef({
        workingDirectory: "/var/candlestix/codex-session", brief: "Codex channel agent.", vendor: "codex", tier: "tier1", permissionMode: "default", role: "worker",
      })),
      // (d) the mud DIRECTOR (distinct from the 10 frozen mud PLAYERS below): bound to the
      // real, non-Rocket.Chat mud-bridge MCP server, channel:true, using the real
      // McpServerBinding type/validator (ported from S4's BUTCHR-395 branch into
      // src/rules/rules.ts). account:"none" — BUTCHR-411's own design point that a
      // channel binding needs no Rocket.Chat account at all.
      "/defs/candlestix-mud-director.json": JSON.stringify(goodDef({
        workingDirectory: "/var/candlestix/mud", brief: "Direct the MUD channel.", vendor: "claude", tier: "tier2", permissionMode: "auto",
        execution: "persistent", account: "none", role: "sentinel",
        mcpServers: [{ name: "mud-bridge", type: "http", url: "https://mud.internal/mcp", channel: true }],
      })),
      // mud PLAYER: frozen (per BUTCHR-393: "10 MUD players ... frozen ... once unfrozen").
      "/defs/candlestix-mud-player-1.json": JSON.stringify(goodDef({
        workingDirectory: "/var/candlestix/mud/player-1", brief: "Play the MUD.", vendor: "claude", tier: "tier1", permissionMode: "default",
        execution: "persistent", account: "none", role: "sentinel", frozen: true,
      })),
    };
    const { herd, spawned } = fakeHerd([]);
    const logs: string[] = [];
    const stop = startManagedSessionsLoop({
      root: "/defs", herd, deliver: async () => {},
      list: async () => Object.keys(files).map((p) => res(p)),
      read: async (p) => files[p]!,
      log: (l) => logs.push(l), intervalMs: 5,
    });
    await tick();
    stop();

    const byResource = new Map(spawned.map((s) => [s.resource, s]));
    expect(byResource.size).toBe(4); // the frozen mud player never spawns
    expect(byResource.has("/defs/candlestix-mud-player-1.json")).toBe(false);
    expect(logs.some((l) => l.includes("candlestix-mud-player-1.json") && l.includes("frozen"))).toBe(true);

    const baker = byResource.get("/defs/baker-repo.json")!;
    expect(baker.cwd).toBe("/repo/some-project");
    expect(baker.agents).toEqual([{ harness: "claude", model: "sonnet" }]);

    const director = byResource.get("/defs/candlestix-factory-director.json")!;
    expect(director.cwd).toBe("/var/candlestix/factory");
    expect(director.permissionMode).toBe("auto");
    expect(director.agents).toEqual([{ harness: "claude", model: "sonnet" }]);

    const codexAgent = byResource.get("/defs/candlestix-codex-agent.json")!;
    expect(codexAgent.cwd).toBe("/var/candlestix/codex-session");
    expect(codexAgent.agents).toEqual([{ harness: "codex", model: "gpt-5.6-luna" }]);

    const mudDirector = byResource.get("/defs/candlestix-mud-director.json")!;
    expect(mudDirector.cwd).toBe("/var/candlestix/mud");
    expect(mudDirector.mcpServers).toEqual([{ name: "mud-bridge", type: "http", url: "https://mud.internal/mcp", channel: true }]);
  });
});

describe("FACTORY-47: crash-loop detection wired into the managed-sessions loop", () => {
  /**
   * A herd whose `spawn()` never actually makes the id show up as running —
   * every poll's discovery finds the definition eligible, `runningIssues()`
   * keeps reporting nothing, and `plan.spawn` keeps naming the same id again.
   * This is the shape a managed session actually takes when its OWN agent
   * process dies right after spawning (a startup crash, an MCP config that
   * fails to load, ...): nothing here is a "stale" agent needing a respawn
   * (`staleIssues()` never fires) — herdr genuinely reports no live agent for
   * it, so it is `spawn`ed again, forever, with the `[reconcile] respawned:`
   * line never once appearing. Before FACTORY-47, `startManagedSessionsLoop`
   * had no `checkCrashLoop` seam at all, so this pattern produced no audible
   * signal whatsoever — this is the exact gap the ticket reports ("nothing
   * records why the previous pane went away").
   */
  function fakeCrashLoopingHerd(): { herd: Herd; spawned: SpawnSpec[] } {
    const spawned: SpawnSpec[] = [];
    const herd: Herd = {
      async runningIssues() { return []; },
      async staleIssues() { return []; },
      async spawn(sp) { spawned.push(sp); },
      async stop() {},
      async paneFor() { return null; },
      async nudge() { return { delivered: true }; },
    };
    return { herd, spawned };
  }

  test("a managed session repeatedly spawned (its agent keeps dying) is reported through checkCrashLoop — never silent", async () => {
    const { herd, spawned } = fakeCrashLoopingHerd();
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/nexus.json" });
    const calls: { spawning: readonly string[]; desired: readonly string[] }[] = [];
    const stop = startManagedSessionsLoop({
      root: "/defs", herd, deliver: async () => {},
      list: async () => [res("/defs/nexus.json")],
      read: async () => JSON.stringify(goodDef({ tier: "tier4", permissionMode: "auto", execution: "persistent", account: "none", role: "sentinel" })),
      checkCrashLoop: async (spawning, desired) => { calls.push({ spawning, desired }); },
      log: () => {}, intervalMs: 5,
    });
    await tick(); await tick(); await tick();
    stop();
    // The SAME id was handed to checkCrashLoop on more than one poll — the
    // detector (never exercised here; see crash-loop.test.ts for its own
    // rolling-window/threshold behaviour) is what turns repeated occurrences
    // like this into an audible complaint.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.spawning).toEqual([key]);
      expect(call.desired).toEqual([key]);
    }
    expect(spawned.length).toBeGreaterThanOrEqual(2);
  });

  test("omitting checkCrashLoop is unaffected — today's exact behaviour for every caller that doesn't opt in", async () => {
    const { herd, spawned } = fakeCrashLoopingHerd();
    const stop = startManagedSessionsLoop({
      root: "/defs", herd, deliver: async () => {},
      list: async () => [res("/defs/nexus.json")],
      read: async () => JSON.stringify(goodDef()),
      log: () => {}, intervalMs: 5,
    });
    await tick(); await tick();
    stop();
    expect(spawned.length).toBeGreaterThanOrEqual(1);
  });
});

describe("FACTORY-47 root cause: startFilesystemLoop must never stop a managed-session agent", () => {
  /**
   * A real herd, not a stub that always reports "not running": `spawn`
   * actually adds the key to `running`, `stop` actually removes it — the
   * exact shape needed to prove startFilesystemLoop's own `runningIds`/
   * `ownsId` (both `ownsFilesystemAgent`) never claims a managed-session id
   * as one of its own leftover agents and stops it out from under the
   * managed-sessions loop, which is the bug assembly found live on codey:
   * `ownsFilesystemAgent` returned `true` for a `filesystem:managed-sessions:…`
   * id, so a daemon with ZERO enabled filesystem rules treated every
   * running managed-session agent as a leftover from a since-removed rule
   * and stopped it every poll, immediately followed by the managed-sessions
   * loop spawning it again — repeating forever, `[spawn] … origin=spawn`
   * only, no `[reconcile] … respawned:` line, exactly FACTORY-47's report.
   */
  function fakeSharedHerd(): { herd: Herd; spawned: string[]; stopped: string[] } {
    const running = new Set<string>();
    const spawned: string[] = [], stopped: string[] = [];
    const herd: Herd = {
      async runningIssues() { return [...running]; },
      async staleIssues() { return []; },
      async spawn(sp) { spawned.push(sp.key); running.add(sp.key); },
      async stop(i) { stopped.push(i); running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return { delivered: true }; },
    };
    return { herd, spawned, stopped };
  }

  test("a daemon with zero filesystem rules and one managed-session definition never stops the managed session — it stays running, spawned exactly once", async () => {
    const { herd, spawned, stopped } = fakeSharedHerd();
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/nexus.json" });
    const stopManaged = startManagedSessionsLoop({
      root: "/defs", herd, deliver: async () => {},
      list: async () => [res("/defs/nexus.json")],
      read: async () => JSON.stringify(goodDef()),
      log: () => {}, intervalMs: 5,
    });
    // ZERO enabled filesystem rules — the exact codey shape ("startFilesystemLoop"'s
    // own doc comment: "still stops filesystem agents left over from an earlier run").
    const stopFilesystem = startFilesystemLoop({
      rules: [], herd, deliver: async () => {}, log: () => {}, intervalMs: 5,
    });
    try {
      await tick(); await tick(); await tick(); await tick(); await tick();
      expect(stopped).toEqual([]);
      expect(spawned).toEqual([key]); // exactly one spawn, never respawned/re-spawned
      expect(await herd.runningIssues()).toEqual([key]);
    } finally {
      stopManaged();
      stopFilesystem();
    }
  });
});
