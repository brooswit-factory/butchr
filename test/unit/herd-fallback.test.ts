import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderAvailabilityRegistry, processProviderAvailability } from "@brooswit/drovr";
import { HerdrHerd } from "../../src/agents/herd.js";
import type { AgentConfig } from "../../src/agents/argv.js";
import { buildWorkspace, workspaceRoot } from "../../src/agents/workspace.js";

const spec = { key: "TEST-1", issuetype: "Task", summary: "fallback fixture", parent: null };
const url = "http://localhost:7717/mcp";
const banner = "You've hit your session limit";
// Yield to I/O and test timeouts; an immediately resolved wait can starve the full-suite runner.
const instant = async () => { await Bun.sleep(0); };
const config: AgentConfig = { provider: "claude", providers: ["claude", "codex"], disabledMcpServers: [] };
type Row = { pane_id: string; agent: string; cwd: string; agent_status: string };

function fixture(options: { refuseClaude?: boolean; launchError?: Error; existing?: Row[]; text?: string; missingTranscript?: boolean; missingAck?: boolean } = {}) {
  let rows = options.existing ?? [];
  const starts: any[] = [], creates: any[] = [], closed: string[] = [], prompts: any[] = [];
  const texts = new Map<string, string>();
  const histories = new Map<string, string>();
  function record(pane: string, provider: string, prompt?: string) {
    const token = prompt?.match(/DROVR_HANDOFF_READY_[a-f0-9-]+/)?.[0];
    const text = token && !options.missingAck ? `${token}\nWorking summary with outstanding work.` : "Previous work and pending objectives.";
    const item = provider === "agy" ? { step_index: 0, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: text }
      : provider === "codex" ? { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }
      : { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
    const path = join(workspaceRoot(), `${pane}-native.jsonl`);
    writeFileSync(path, JSON.stringify(item) + "\n");
    histories.set(pane, path);
  }
  const client = {
    agent: {
      list: async () => ({ agents: rows }),
      get: async (pane: string) => {
        const agent = rows.find(r => r.pane_id === pane)!;
        if (options.missingTranscript) return { agent };
        if (!histories.has(pane)) record(pane, agent.agent);
        return { agent: { ...agent, agent_session: { agent: agent.agent, kind: "path", value: histories.get(pane), source: "fixture" } } };
      },
      start: async (params: any) => {
        starts.push(params);
        if (options.launchError) throw options.launchError;
        const refused = params.kind === "claude" && options.refuseClaude;
        const prompt = params.args[params.kind === "agy" ? 1 : 0];
        const importing = prompt.includes("DROVR_HANDOFF_READY_");
        rows.push({ pane_id: params.pane_id, cwd: creates.at(-1).cwd, agent: params.kind, agent_status: refused || importing ? "idle" : "working" });
        record(params.pane_id, params.kind, prompt);
        texts.set(params.pane_id, refused ? banner : "working");
      },
      prompt: async (params: any) => {
        prompts.push(params);
        const agent = rows.find(r => r.pane_id === params.target)!;
        if (params.text.includes("DROVR_HANDOFF_READY_")) record(agent.pane_id, agent.agent, params.text);
        else agent.agent_status = "working";
        return { agent };
      },
    },
    workspace: { create: async (params: any) => { creates.push(params); return { root_pane: `new-${creates.length}` }; } },
    pane: {
      close: async (pane: string) => { closed.push(pane); rows = rows.filter((r) => r.pane_id !== pane); },
      read: async ({ pane_id }: any) => ({ read: { text: texts.get(pane_id) ?? options.text ?? banner } }),
      sendKeys: async () => {},
    },
  };
  return { client: client as any, starts, creates, closed, prompts, texts, rows: () => rows };
}

describe("HerdrHerd ordered provider fallback", () => {
  let root: string;
  let previous: string | undefined;
  beforeEach(() => {
    processProviderAvailability.clear({ provider: "claude", accountId: "default" });
    processProviderAvailability.clear({ provider: "codex", accountId: "default" });
    processProviderAvailability.clear({ provider: "agy", accountId: "default" });
    previous = process.env.BUTCHR_WORKSPACES;
    root = mkdtempSync(join(tmpdir(), "butchr-herd-fallback-"));
    process.env.BUTCHR_WORKSPACES = root;
  });
  afterEach(() => {
    processProviderAvailability.clear({ provider: "claude", accountId: "default" });
    processProviderAvailability.clear({ provider: "codex", accountId: "default" });
    processProviderAvailability.clear({ provider: "agy", accountId: "default" });
    if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
    else process.env.BUTCHR_WORKSPACES = previous;
    rmSync(root, { recursive: true, force: true });
  });

  const existing = (agent = "claude", agent_status = "idle"): Row => ({
    pane_id: "old", cwd: join(workspaceRoot(), spec.key), agent, agent_status,
  });

  test("missing native history preserves the refused worker and reports waiting", async () => {
    const f = fixture({ existing: [existing()], missingTranscript: true });
    const logs: string[] = [];
    const herd = new HerdrHerd(f.client, url, instant, line => logs.push(line), config);
    expect(await herd.recoverQuota(spec)).toBe("waiting");
    expect(f.creates).toEqual([]);
    expect(f.closed).toEqual([]);
    expect(f.prompts).toEqual([]);
    expect(await herd.paneFor(spec.key)).toBe("old");
    expect(logs.some(line => line.includes("native transcript"))).toBe(true);
  });

  test("nudge waits for handoff acknowledgement and uses the committed pane", async () => {
    const f = fixture({ existing: [existing()] });
    const start = f.client.agent.start;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const importing = new Promise<void>(resolve => { entered = resolve; });
    f.client.agent.start = async (params: any) => { await start(params); entered(); await gate; };
    const herd = new HerdrHerd(f.client, url, instant, undefined, config);
    const recovery = herd.recoverQuota(spec);
    await importing;
    expect(await herd.paneFor(spec.key)).toBe("old");
    expect(await herd.runningIssues()).toEqual([spec.key]);
    const nudge = herd.nudge(spec.key, "new request");
    expect(f.prompts).toEqual([]);
    release();
    expect(await recovery).toBe("recovered");
    expect(await nudge).toEqual({ delivered: true });
    expect(f.prompts).toEqual([
      { target: "new-1", text: "follow your AGENTS.md" },
      { target: "new-1", text: "new request" },
    ]);
  });

  test("role order wins and a different provider does not inherit the Claude model", async () => {
    const f = fixture();
    const herd = new HerdrHerd(f.client, url, instant, undefined, {
      ...config, model: "opus", roleProviders: { task: ["codex", "claude"] },
    });
    await herd.spawn(spec);
    expect(f.starts.map((p) => p.kind)).toEqual(["codex"]);
    expect(f.starts[0].args).not.toContain("opus");
  });

  test("Claude quota falls back to AGY with workspace identity and no inherited Claude model", async () => {
    const f = fixture({ refuseClaude: true });
    const herd = new HerdrHerd(f.client, url, instant, undefined, {
      provider: "claude", model: "opus", providers: ["claude", "agy"],
    }, undefined, instant);
    await herd.spawn(spec);
    expect(f.starts.map(p => p.kind)).toEqual(["claude", "agy"]);
    expect(f.starts[1].args[1]).toContain("ONLY for importing and compacting historical context");
    expect(f.prompts).toEqual([{ target: "new-2", text: "follow your AGENTS.md" }]);
    expect(f.closed).toEqual(["new-1"]);
    expect(JSON.parse(readFileSync(join(f.creates[1].cwd, ".butchr-agy.json"), "utf8"))).toEqual({ issue: spec.key, mcpUrl: url });
    expect(await herd.runningIssues()).toEqual([spec.key]);
    expect(await herd.paneFor(spec.key)).toBe("new-2");
    await herd.spawn(spec);
    expect(f.starts).toHaveLength(2);
  });

  test("AGY role order and single-provider launches are supported", async () => {
    for (const agent of [{ provider: "agy", model: "test-model" }, { ...config, roleProviders: { task: ["agy", "claude"] } }] satisfies AgentConfig[]) {
      const f = fixture();
      await new HerdrHerd(f.client, url, instant, undefined, agent, undefined, instant).spawn(spec);
      expect(f.starts.map(p => p.kind)).toEqual(["agy"]);
    }
  });

  test("awaits exact AGY workspace preparation before replacing a refused worker", async () => {
    const f = fixture({ existing: [existing()] });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const calls: unknown[] = [];
    const herd = new HerdrHerd(f.client, url, instant, undefined, {
      provider: "claude", providers: ["claude", "agy"],
    }, new ProviderAvailabilityRegistry(), async options => {
      calls.push(options);
      expect(JSON.parse(readFileSync(join(options.cwd, ".butchr-agy.json"), "utf8"))).toEqual({ issue: spec.key, mcpUrl: url });
      entered();
      await gate;
    });
    const recovery = herd.recoverQuota(spec);
    try {
      await preparing;
      expect(calls).toEqual([{ provider: "agy", cwd: join(workspaceRoot(), spec.key), unattended: true }]);
      expect(f.closed).toEqual([]);
      expect(f.creates).toEqual([]);
      expect(f.starts).toEqual([]);
    } finally {
      release();
    }
    expect(await recovery).toBe("recovered");
    expect(f.closed).toEqual(["old"]);
    expect(f.creates).toHaveLength(1);
    expect(f.starts.map(p => p.kind)).toEqual(["agy"]);
  });

  test("preparation errors preserve a refused pane and never create or launch a replacement", async () => {
    const f = fixture({ existing: [existing()] });
    const error = new Error("workspace trust preparation failed");
    const state = new ProviderAvailabilityRegistry();
    const herd = new HerdrHerd(f.client, url, instant, undefined, {
      provider: "claude", providers: ["claude", "agy"],
    }, state, async options => {
      expect(options).toEqual({ provider: "agy", cwd: join(workspaceRoot(), spec.key), unattended: true });
      throw error;
    });
    await expect(herd.recoverQuota(spec)).rejects.toBe(error);
    expect(f.closed).toEqual([]);
    expect(f.creates).toEqual([]);
    expect(f.starts).toEqual([]);
    expect(f.rows()).toEqual([existing()]);
    expect(herd.quotaBlocked(spec.key)).toBe(true);
    expect(state.get({ provider: "agy", accountId: "default" }).status).toBe("available");
  });

  test("preparation errors on initial AGY spawn stop before Herdr workspace creation", async () => {
    const f = fixture();
    const error = new Error("cannot prepare trust");
    const herd = new HerdrHerd(f.client, url, instant, undefined, {
      provider: "agy", providers: ["agy", "claude"],
    }, undefined, options => {
      expect(options).toEqual({ provider: "agy", cwd: join(workspaceRoot(), spec.key), unattended: true });
      throw error;
    });
    await expect(herd.spawn(spec)).rejects.toBe(error);
    expect(f.creates).toEqual([]);
    expect(f.starts).toEqual([]);
    expect(f.closed).toEqual([]);
  });

  test("AGY bridge readiness blocks before creating a workspace or replacing a refused pane", async () => {
    const state = new ProviderAvailabilityRegistry();
    const f = fixture({ existing: [existing()] });
    const herd = new HerdrHerd(f.client, url, instant, undefined, {
      provider: "claude", providers: ["claude", "agy"], agySpawnBlocked: "global bridge missing",
    }, state, instant);
    await expect(herd.recoverQuota(spec)).rejects.toThrow("global bridge missing");
    expect(f.closed).toEqual([]);
    expect(f.creates).toEqual([]);
    expect(state.get({ provider: "agy", accountId: "default" }).status).toBe("available");
    const single = fixture();
    await expect(new HerdrHerd(single.client, url, instant, undefined, {
      provider: "agy", agySpawnBlocked: "global bridge missing",
    }, undefined, instant).spawn(spec)).rejects.toThrow("global bridge missing");
    expect(single.creates).toEqual([]);
  });

  test("AGY residents remain managed and quota-like text never establishes refusal", async () => {
    const f = fixture({ existing: [existing("agy")] });
    const herd = new HerdrHerd(f.client, url, instant, undefined, { provider: "agy", providers: ["agy", "claude"], agySpawnBlocked: "bridge unavailable" }, undefined, instant);
    expect(await herd.runningIssues()).toEqual([spec.key]);
    expect(await herd.managedAgents()).toEqual([{ issue: spec.key, pane: "old", cwd: existing().cwd, status: "idle" }]);
    expect(await herd.recoverQuota(spec)).toBe("not-refused");
    expect(herd.quotaBlocked(spec.key)).toBe(false);
    await herd.spawn(spec);
    expect(f.starts).toEqual([]);
    await herd.stop(spec.key);
    expect(f.closed).toEqual(["old"]);
  });

  test("startup refusal falls back once, retains cwd and work files, and shares quota with other roles", async () => {
    const f = fixture({ refuseClaude: true });
    const dir = buildWorkspace(spec, url);
    writeFileSync(join(dir, "progress.txt"), "unfinished work");
    const herd = new HerdrHerd(f.client, url, instant, undefined, config);
    await herd.spawn(spec);
    expect(f.starts.map((p) => p.kind)).toEqual(["claude", "codex"]);
    expect(f.creates.map((p) => p.cwd)).toEqual([dir, dir]);
    expect(f.closed).toEqual(["new-1"]);
    expect(readFileSync(join(dir, "progress.txt"), "utf8")).toBe("unfinished work");
    expect(f.rows()).toHaveLength(1);
    expect(herd.quotaBlocked(spec.key)).toBe(false);
    await herd.spawn({ ...spec, key: "TEST", issuetype: "project" });
    expect(f.starts.map((p) => p.kind)).toEqual(["claude", "codex", "codex"]);
  });

  test("mid-task refusal on an existing unnamed worker uses the desired role and same directory", async () => {
    const f = fixture({ existing: [existing()] });
    const herd = new HerdrHerd(f.client, url, instant, undefined, config);
    expect(await herd.recoverQuota(spec)).toBe("recovered");
    expect(f.starts.map((p) => p.kind)).toEqual(["codex"]);
    expect(f.closed).toEqual(["old"]);
    expect(f.creates[0].cwd).toBe(existing().cwd);
  });

  test("all exhausted retains refusal and makes no repeated workspace or launch attempts", async () => {
    const f = fixture({ refuseClaude: true });
    const herd = new HerdrHerd(f.client, url, instant, undefined, { provider: "claude", providers: ["claude", "claude"] });
    await herd.spawn(spec);
    expect(herd.quotaBlocked(spec.key)).toBe(true);
    for (let i = 0; i < 3; i++) expect(await herd.recoverQuota(spec)).toBe("waiting");
    expect(f.starts).toHaveLength(1);
    expect(f.closed).toEqual([]);
    expect(f.rows()).toHaveLength(1);
    await herd.spawn({ ...spec, key: "TEST-2" });
    expect(f.creates).toHaveLength(1);
  });

  test("known reset is pinned and a later poll restarts after availability expires", async () => {
    let now = new Date(2026, 8, 12, 9, 0).getTime();
    const availability = new ProviderAvailabilityRegistry(() => now);
    const f = fixture({ existing: [existing()], text: `${banner} · resets 9:30am` });
    const herd = new HerdrHerd(f.client, url, instant, undefined, { provider: "claude", providers: ["claude"] }, availability);
    expect(await herd.recoverQuota(spec)).toBe("waiting");
    now = new Date(2026, 8, 12, 9, 31).getTime();
    expect(await herd.recoverQuota(spec)).toBe("recovered");
    expect(f.starts).toHaveLength(1);
    expect(f.closed).toEqual(["old"]);
  });

  test("unknown reset waits until Drovr availability is explicitly cleared", async () => {
    const availability = new ProviderAvailabilityRegistry();
    const f = fixture({ existing: [existing()] });
    const herd = new HerdrHerd(f.client, url, instant, undefined, { provider: "claude", providers: ["claude"] }, availability);
    expect(await herd.recoverQuota(spec)).toBe("waiting");
    availability.clear({ provider: "claude", accountId: "default" });
    expect(await herd.recoverQuota(spec)).toBe("recovered");
  });

  test("arbitrary launch error containing quota words is propagated without fallback or quota state", async () => {
    const error = new Error("quota exceeded in invalid launch configuration");
    const f = fixture({ launchError: error });
    const availability = new ProviderAvailabilityRegistry();
    const herd = new HerdrHerd(f.client, url, instant, undefined, config, availability);
    await expect(herd.spawn(spec)).rejects.toBe(error);
    expect(f.starts.map((p) => p.kind)).toEqual(["claude"]);
    expect(f.closed).toEqual(["new-1"]);
    expect(availability.get({ provider: "claude", accountId: "default" }).status).toBe("available");
  });

  test("invalid fallback configuration retains the refused worker and does not mark Codex quota", async () => {
    const f = fixture({ existing: [existing()] });
    const availability = new ProviderAvailabilityRegistry();
    const herd = new HerdrHerd(f.client, url, instant, undefined, { ...config, codexSpawnBlocked: "inventory missing" }, availability);
    await expect(herd.recoverQuota(spec)).rejects.toThrow("inventory missing");
    expect(f.closed).toEqual([]);
    expect(f.creates).toEqual([]);
    expect(availability.get({ provider: "codex", accountId: "default" }).status).toBe("available");
  });

  test("working, blocked, Codex, ambiguous, and quoted refusals are not recovered", async () => {
    for (const rows of [[existing("claude", "working")], [existing("claude", "blocked")], [existing("codex")], [existing(), { ...existing(), pane_id: "other" }]]) {
      const f = fixture({ existing: rows });
      const herd = new HerdrHerd(f.client, url, instant, undefined, config);
      expect(await herd.recoverQuota(spec)).toBe("not-refused");
      expect(f.starts).toEqual([]);
      expect(f.closed).toEqual([]);
    }
    const f = fixture({ existing: [existing()], text: `ticket says: ${banner}` });
    expect(await new HerdrHerd(f.client, url, instant, undefined, config).recoverQuota(spec)).toBe("not-refused");
    expect(f.closed).toEqual([]);
  });

  test("legacy configuration leaves recovery to the existing watcher", async () => {
    const f = fixture({ existing: [existing()] });
    expect(await new HerdrHerd(f.client, url, instant).recoverQuota(spec)).toBe("not-refused");
    expect(f.closed).toEqual([]);
  });

  test("overlapping recovery and spawn calls replace a worker only once", async () => {
    const f = fixture({ existing: [existing()] });
    const herd = new HerdrHerd(f.client, url, instant, undefined, config);
    await Promise.all([herd.recoverQuota(spec), herd.spawn(spec), herd.recoverQuota(spec)]);
    expect(f.starts.map((p) => p.kind)).toEqual(["codex"]);
    expect(f.closed).toEqual(["old"]);
  });

  test("an externally resumed worker clears the issue stall gate", async () => {
    const f = fixture({ existing: [existing()] });
    const herd = new HerdrHerd(f.client, url, instant, undefined, { provider: "claude", providers: ["claude"] });
    expect(await herd.recoverQuota(spec)).toBe("waiting");
    expect(herd.quotaBlocked(spec.key)).toBe(true);
    f.rows()[0]!.agent_status = "working";
    expect(await herd.recoverQuota(spec)).toBe("not-refused");
    expect(herd.quotaBlocked(spec.key)).toBe(false);
  });

  test("default quota state is shared across distinct herd instances", async () => {
    const first = fixture({ existing: [existing()] });
    const second = fixture();
    await new HerdrHerd(first.client, url, instant, undefined, { provider: "claude", providers: ["claude"] }).recoverQuota(spec);
    await new HerdrHerd(second.client, url, instant, undefined, config).spawn({ ...spec, key: "TEST-2" });
    expect(second.starts.map((p) => p.kind)).toEqual(["codex"]);
  });
});
