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
  MANAGED_SESSIONS_RULE_ID, onceFrozenDefinition, onceInvalidDefinition, ownsManagedSessionAgent,
  searchSessionDefinitions, specForSessionDefinition, specForSessionDefinitionUnit,
  type SessionDefinitionMatch,
} from "../../src/rules/session-definition-type.js";
import { startManagedSessionsLoop } from "../../src/daemon/session-definitions-loop.js";

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
    expect(spec.agents).toEqual([{ harness: "codex", model: "opus" }]);
    expect(spec.parent).toBeNull();
  });

  test("specForSessionDefinitionUnit dispatches resource units; a query-kind unit (never actually produced) throws rather than silently mis-spawning", () => {
    const rule = builtinManagedSessionsRule("/defs");
    const match: SessionDefinitionMatch = {
      agentKey: encodeAgentKey({ resourceProvider: "filesystem", ruleId: rule.id, resourceId: "/defs/a.json" }),
      rule, resource: res("/defs/a.json"),
      definition: { workingDirectory: "/x", brief: "b", vendor: "claude", tier: "tier0", permissionMode: "default", execution: "swarm", account: "none", role: "worker", frozen: false },
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

  test("activation is always active for whatever reaches it (frozen/invalid never do)", () => {
    const rule = builtinManagedSessionsRule("/defs");
    const type = createManagedSessionResourceType({ rule, list: async () => [], read: async () => "" });
    const match: SessionDefinitionMatch = { agentKey: "x", rule, resource: res("/defs/a.json"), definition: { workingDirectory: "/x", brief: "b", vendor: "claude", tier: "tier0", permissionMode: "default", execution: "swarm", account: "none", role: "worker", frozen: false } };
    expect(type.activation.verdictFor({ kind: "resource", match })).toBe("active");
  });
});

describe("createSessionDefinitionEventRules", () => {
  test("unchanged content never notifies; a size/mtime move notifies the resource's own agent only", async () => {
    const rule = builtinManagedSessionsRule("/defs");
    const definition = { workingDirectory: "/x", brief: "b", vendor: "claude" as const, tier: "tier0" as const, permissionMode: "default" as const, execution: "swarm" as const, account: "none" as const, role: "worker" as const, frozen: false };
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

  test("BUTCHR-408 staged scenarios: Baker directory agent, Candlestix Claude session, Candlestix Codex session, and a frozen non-Rocket.Chat-channel (mud-style) sentinel all validate and produce the expected spawn shape (mud player stays frozen — no agent)", async () => {
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
      // mud-bridge-bound player: real channel delivery is deferred to S4 (see session-definition.ts's mcpServers doc comment) — this
      // definition intentionally carries NO mcpServers key yet, and is frozen (per BUTCHR-393: "10 MUD players ... frozen ... once unfrozen").
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
    expect(byResource.size).toBe(3); // the frozen mud player never spawns
    expect(byResource.has("/defs/candlestix-mud-player-1.json")).toBe(false);
    expect(logs.some((l) => l.includes("candlestix-mud-player-1.json") && l.includes("frozen"))).toBe(true);

    const baker = byResource.get("/defs/baker-repo.json")!;
    expect(baker.cwd).toBe("/repo/some-project");
    expect(baker.agents).toEqual([{ harness: "claude", model: "sonnet" }]);

    const director = byResource.get("/defs/candlestix-factory-director.json")!;
    expect(director.cwd).toBe("/var/candlestix/factory");
    expect(director.permissionMode).toBe("auto");
    expect(director.agents).toEqual([{ harness: "claude", model: "opus" }]);

    const codexAgent = byResource.get("/defs/candlestix-codex-agent.json")!;
    expect(codexAgent.cwd).toBe("/var/candlestix/codex-session");
    expect(codexAgent.agents).toEqual([{ harness: "codex", model: "sonnet" }]);
  });
});
