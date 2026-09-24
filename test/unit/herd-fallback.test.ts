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
// Verbatim herdr read of a quota-blocked idle Codex pane, 2026-09-24.
const codexNotice = [
  "• Automatically switched to Luna Reserve medium due to usage limits.",
  "  You’re now using Luna, a faster model for simpler tasks.",
  "  Add credits to continue using the most advanced models, or wait for usage to reset after",
  "  16:03 on 29 Sep.",
  "› 1. Add Credits",
  "  2. Continue with Luna Reserve",
  "  Press enter to confirm or esc to continue working",
].join("\n");
const instant = async () => {};
const config: AgentConfig = { provider: "claude", providers: ["claude", "codex"], disabledMcpServers: [] };
type Row = { pane_id: string; agent: string; cwd: string; agent_status: string };

function fixture(options: { refuseClaude?: boolean; refuseCodex?: boolean; launchError?: Error; existing?: Row[]; text?: string; missingTranscript?: boolean; missingAck?: boolean } = {}) {
  let rows = options.existing ?? [];
  const starts: any[] = [], creates: any[] = [], closed: string[] = [], prompts: any[] = [], keys: any[] = [];
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
        const refused = (params.kind === "claude" && options.refuseClaude) || (params.kind === "codex" && options.refuseCodex);
        const prompt = params.args[params.kind === "agy" ? 1 : 0];
        const importing = prompt.includes("DROVR_HANDOFF_READY_");
        rows.push({ pane_id: params.pane_id, cwd: creates.at(-1).cwd, agent: params.kind, agent_status: refused || importing ? "idle" : "working" });
        record(params.pane_id, params.kind, prompt);
        texts.set(params.pane_id, refused ? (params.kind === "codex" ? codexNotice : banner) : "working");
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
      sendKeys: async (params: any) => { keys.push(params); },
    },
  };
  return { client: client as any, starts, creates, closed, prompts, keys, texts, rows: () => rows };
}

describe("HerdrHerd ordered provider fallback", () => {
  let root: string;
  let previous: string | undefined;
  beforeEach(() => {
    processProviderAvailability.clear({ provider: "claude", accountId: "default" });
    processProviderAvailability.clear({ provider: "codex", accountId: "default" });
    previous = process.env.BUTCHR_WORKSPACES;
    root = mkdtempSync(join(tmpdir(), "butchr-herd-fallback-"));
    process.env.BUTCHR_WORKSPACES = root;
  });
  afterEach(() => {
    processProviderAvailability.clear({ provider: "claude", accountId: "default" });
    processProviderAvailability.clear({ provider: "codex", accountId: "default" });
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

  describe("Codex usage limits", () => {
    const codexAccount = { provider: "codex", accountId: "default" } as const;
    const claudeAccount = { provider: "claude", accountId: "default" } as const;

    test("a Codex worker at its usage limit is replaced from the top of the order: Claude first", async () => {
      const f = fixture({ existing: [existing("codex")], text: codexNotice });
      const availability = new ProviderAvailabilityRegistry(() => new Date(2026, 8, 24, 12, 0).getTime());
      const logs: string[] = [];
      const herd = new HerdrHerd(f.client, url, instant, line => logs.push(line), config, availability);
      expect(await herd.recoverQuota(spec)).toBe("recovered");
      expect(f.starts.map(p => p.kind)).toEqual(["claude"]);
      expect(f.starts[0].args[0]).toContain("ONLY for importing and compacting historical context");
      expect(f.closed).toEqual(["old"]);
      expect(f.creates[0].cwd).toBe(existing().cwd);
      expect(await herd.paneFor(spec.key)).toBe("new-1");
      expect(herd.quotaBlocked(spec.key)).toBe(false);
      expect(availability.get(codexAccount)).toMatchObject({ status: "quota-blocked", resetsAt: new Date(2026, 8, 29, 16, 3).getTime() });
      expect(logs.some(line => line.includes("provider=codex quota-blocked"))).toBe(true);
      expect(logs.some(line => line.includes("recovered provider=claude"))).toBe(true);
    });

    test("a Codex worker at its limit under a codex-first role order still goes to Claude, and Codex regains its position after the reset", async () => {
      let now = new Date(2026, 8, 24, 12, 0).getTime();
      const availability = new ProviderAvailabilityRegistry(() => now);
      const agent: AgentConfig = { ...config, roleProviders: { task: ["codex", "claude"] } };
      const f = fixture({ existing: [existing("codex")], text: codexNotice });
      const herd = new HerdrHerd(f.client, url, instant, undefined, agent, availability);
      expect(await herd.recoverQuota(spec)).toBe("recovered");
      expect(f.starts.map(p => p.kind)).toEqual(["claude"]);
      now = new Date(2026, 8, 29, 16, 3).getTime();
      const later = fixture();
      await new HerdrHerd(later.client, url, instant, undefined, agent, availability).spawn({ ...spec, key: "TEST-2" });
      expect(later.starts.map(p => p.kind)).toEqual(["codex"]);
    });

    test("a Codex kickoff that lands on the usage-limit notice falls through to Claude", async () => {
      const f = fixture({ refuseCodex: true });
      const availability = new ProviderAvailabilityRegistry();
      const herd = new HerdrHerd(f.client, url, instant, undefined, { ...config, providers: ["codex", "claude"] }, availability);
      await herd.spawn(spec);
      expect(f.starts.map(p => p.kind)).toEqual(["codex", "claude"]);
      expect(f.closed).toEqual(["new-1"]);
      expect(availability.get(codexAccount).status).toBe("quota-blocked");
      expect(await herd.paneFor(spec.key)).toBe("new-2");
    });

    test("a Claude worker at its limit goes on to Codex; with both blocked the worker is kept and waits", async () => {
      const f = fixture({ existing: [existing()] });
      const availability = new ProviderAvailabilityRegistry();
      availability.markQuotaBlocked(codexAccount, { resetsAt: null, raw: "Automatically switched to Luna Reserve medium due to usage limits." });
      const herd = new HerdrHerd(f.client, url, instant, undefined, config, availability);
      expect(await herd.recoverQuota(spec)).toBe("waiting");
      expect(f.creates).toEqual([]);
      expect(f.closed).toEqual([]);
      expect(herd.quotaBlocked(spec.key)).toBe(true);
      availability.clear(codexAccount);
      expect(await herd.recoverQuota(spec)).toBe("recovered");
      expect(f.starts.map(p => p.kind)).toEqual(["codex"]);
      expect(availability.get(claudeAccount).status).toBe("quota-blocked");
    });

    test("a codex-only configuration marks the limit and waits instead of sitting silently", async () => {
      const f = fixture({ existing: [existing("codex")], text: codexNotice });
      const availability = new ProviderAvailabilityRegistry(() => new Date(2026, 8, 24, 12, 0).getTime());
      const logs: string[] = [];
      const herd = new HerdrHerd(f.client, url, instant, line => logs.push(line), { provider: "codex", disabledMcpServers: [] }, availability);
      expect(await herd.recoverQuota(spec)).toBe("waiting");
      expect(herd.quotaBlocked(spec.key)).toBe(true);
      expect(herd.resourceQuotaBlocked(spec.key)).toBe(true);
      expect(f.creates).toEqual([]);
      expect(f.closed).toEqual([]);
      expect(logs.some(line => line.includes("provider=codex quota-blocked resetsAt="))).toBe(true);
    });

    test("nudging a Codex pane on the notice reports the refusal and never presses Enter on its menu", async () => {
      const f = fixture({ existing: [existing("codex")], text: codexNotice });
      f.client.agent.prompt = async (params: any) => { f.prompts.push(params); return { agent: f.rows()[0] }; };
      const herd = new HerdrHerd(f.client, url, instant, undefined, config, new ProviderAvailabilityRegistry());
      const result = await herd.nudge(spec.key, "new request");
      expect(result.delivered).toBe(true);
      expect(result.refusal?.raw).toBe("Automatically switched to Luna Reserve medium due to usage limits.");
      expect(f.keys).toEqual([]);
    });

    test("quoted, indented, carried-on, and AGY notices are not recovered", async () => {
      for (const [agent, text] of [
        ["codex", `  └ ${codexNotice}`],
        ["codex", `${codexNotice}\n• Continuing on Luna Reserve with the tests.`],
        ["codex", banner],
        ["agy", codexNotice],
      ] as const) {
        const f = fixture({ existing: [existing(agent)], text });
        const availability = new ProviderAvailabilityRegistry();
        const herd = new HerdrHerd(f.client, url, instant, undefined, config, availability, instant);
        expect(await herd.recoverQuota(spec)).toBe("not-refused");
        expect(f.creates).toEqual([]);
        expect(availability.get(codexAccount).status).toBe("available");
      }
    });
  });
});
