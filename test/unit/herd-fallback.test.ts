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
const instant = async () => {};
const config: AgentConfig = { provider: "claude", providers: ["claude", "codex"], disabledMcpServers: [] };
type Row = { pane_id: string; agent: string; cwd: string; agent_status: string };

function fixture(options: { refuseClaude?: boolean; launchError?: Error; existing?: Row[]; text?: string } = {}) {
  let rows = options.existing ?? [];
  const starts: any[] = [], creates: any[] = [], closed: string[] = [], prompts: any[] = [];
  const texts = new Map<string, string>();
  const client = {
    agent: {
      list: async () => ({ agents: rows }),
      start: async (params: any) => {
        starts.push(params);
        if (options.launchError) throw options.launchError;
        const refused = params.kind === "claude" && options.refuseClaude;
        rows.push({ pane_id: params.pane_id, cwd: creates.at(-1).cwd, agent: params.kind, agent_status: refused ? "idle" : "working" });
        texts.set(params.pane_id, refused ? banner : "working");
      },
      prompt: async (params: any) => { prompts.push(params); return { agent: rows.find((r) => r.pane_id === params.target) }; },
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

  test("role order wins and a different provider does not inherit the Claude model", async () => {
    const f = fixture();
    const herd = new HerdrHerd(f.client, url, instant, undefined, {
      ...config, model: "opus", roleProviders: { task: ["codex", "claude"] },
    });
    await herd.spawn(spec);
    expect(f.starts.map((p) => p.kind)).toEqual(["codex"]);
    expect(f.starts[0].args).not.toContain("opus");
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
