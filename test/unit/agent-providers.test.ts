import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnArgs, checkArgv, codexMcpServerNames, inventoryCodexMcp, type AgentProvider } from "../../src/agents/argv.js";
import { buildWorkspace, workspaceRoot } from "../../src/agents/workspace.js";
import { HerdrHerd } from "../../src/agents/herd.js";
import { loadConfig } from "../../src/config/config.js";
import { notifyIssue } from "../../src/daemon/app.js";
import { DrovrClient } from "@brooswit/drovr";
import { reconcileNow } from "../../src/daemon/loop.js";

const spec = { key: "TEST-990", issuetype: "project", summary: "fixture", parent: null };
const url = "http://localhost:7719/mcp";
const instant = async () => {};

describe("provider selection", () => {
  let root: string;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.BUTCHR_WORKSPACES;
    root = mkdtempSync(join(tmpdir(), "butchr-providers-"));
    process.env.BUTCHR_WORKSPACES = root;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
    else process.env.BUTCHR_WORKSPACES = previous;
    rmSync(root, { recursive: true, force: true });
  });
  test("inherited MCP identities are explicitly disabled and checked on restore", () => {
    expect(codexMcpServerNames('[{"name":"yappr","transport":{"type":"stdio"}},{"name":"butchr"}]')).toEqual([{ name: "yappr", transport: "stdio" }]);
    expect(() => codexMcpServerNames('{}')).toThrow();
    expect(() => codexMcpServerNames('[{"name":"server.with.dots"}]')).toThrow();
    const args = spawnArgs(spec, "/d", { provider: "codex", disabledMcpServers: [{ name: "yappr", transport: "stdio" }, { name: "other", transport: "streamable_http" }] }, url);
    expect(args).toContain('mcp_servers.yappr={enabled=false,command="false"}');
    expect(args).toContain('mcp_servers.other={enabled=false,url="http://127.0.0.1:9/disabled"}');
    expect(checkArgv(args, args)).toEqual({ ok: true });
    expect(checkArgv(args, args.slice(0, -2)).ok).toBe(false);
  });
  test("config preserves defaults, selects either provider and rejects invalid input", () => {
    const env = { ATLASSIAN_SITE: "https://example.invalid", ATLASSIAN_EMAIL: "test", ATLASSIAN_TOKEN: "fake" };
    expect(loadConfig(env, () => "").agent).toEqual({ provider: "claude" });
    for (const provider of ["claude", "codex"] as const) {
      expect(loadConfig({ ...env, BUTCHR_AGENT_PROVIDER: provider, BUTCHR_AGENT_MODEL: " custom " }, () => "").agent).toEqual({ provider, model: "custom" });
    }
    expect(() => loadConfig({ ...env, BUTCHR_AGENT_PROVIDER: "other" }, () => "")).toThrow("BUTCHR_AGENT_PROVIDER");
    expect(() => loadConfig({ ...env, BUTCHR_AGENT_MODEL: " " }, () => "")).toThrow("BUTCHR_AGENT_MODEL");
  });

  test("inventory failure is bounded, redacted, and only blocks new Codex spawns", async () => {
    const logs: string[] = [];
    let probes = 0, creates = 0;
    const agent = inventoryCodexMcp({ provider: "codex" }, (line) => logs.push(line), () => {
      probes++;
      throw new Error("fixture-secret");
    });
    const rows = ["claude", "codex"].map((provider, i) => {
      const key = `TEST-${i + 1}`;
      return { name: `butchr-test-${i + 1}`, pane_id: `p${i}`, agent_status: "working", agent: provider, provider,
        cwd: buildWorkspace({ ...spec, key }, url, provider as AgentProvider) };
    });
    const client = {
      agent: { list: async () => ({ agents: rows }), prompt: async () => ({ agent: rows[0] }) },
      workspace: { create: async () => { creates++; throw new Error("must not create"); } },
      pane: {
        list: async () => ({ panes: rows }),
        processInfo: async ({ pane_id }: any) => {
          const row = rows.find((a) => a.pane_id === pane_id)!;
          return { process_info: { foreground_processes: [{ name: row.provider, argv: [row.provider,
            ...spawnArgs({ ...spec, key: row.name.slice(7).toUpperCase() }, row.cwd, { provider: row.provider as AgentProvider }, url)] }] } };
        },
      },
    };
    const herd = new HerdrHerd(client as any, url, instant, undefined, agent);
    expect(await herd.runningIssues()).toEqual(["TEST-1", "TEST-2"]);
    expect(await herd.staleIssues()).toEqual([]);
    expect(await herd.residentIssues()).toEqual(["TEST-1", "TEST-2"]);
    for (const key of ["TEST-1", "TEST-2"]) await herd.spawn({ ...spec, key });
    expect(await herd.nudge("TEST-1", "fixture update")).toEqual({ delivered: true });
    for (let i = 0; i < 2; i++) await expect(herd.spawn(spec)).rejects.toThrow("new Codex spawns disabled");
    expect(creates).toBe(0);
    expect(existsSync(join(root, spec.key))).toBe(false);
    expect(probes).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("restart Butchr");
    expect(logs[0]).not.toContain("fixture-secret");
  });

  test("inventory handles invalid and failed probes without throwing, and skips Claude", () => {
    const log = () => {};
    for (const result of [{ exitCode: 1, stdout: "[]" }, { exitCode: 0, stdout: "invalid" }, { exitCode: 0, stdout: "{}" }]) {
      expect(inventoryCodexMcp({ provider: "codex" }, log, () => result).codexSpawnBlocked).toBeDefined();
    }
    expect(inventoryCodexMcp({ provider: "codex" }, log, () => ({ exitCode: 0, stdout: "[]" })).disabledMcpServers).toEqual([]);
    expect(inventoryCodexMcp({ provider: "claude" }, log, () => { throw new Error("must not probe"); })).toEqual({ provider: "claude" });
  });

  test("failed inventory retains a stale Claude worker before reconciliation can stop it", async () => {
    const agent = inventoryCodexMcp({ provider: "codex" }, () => {}, () => ({ exitCode: 1, stdout: "" }));
    const cwd = buildWorkspace(spec, url, "claude");
    let closes = 0, creates = 0;
    const client = {
      agent: { list: async () => ({ agents: [{ name: "butchr-test-990", pane_id: "p", cwd, agent_status: "working" }] }) },
      pane: {
        processInfo: async () => ({ process_info: { foreground_processes: [{ name: "claude", argv: ["claude", "--resume"] }] } }),
        close: async () => { closes++; },
      },
      workspace: { create: async () => { creates++; throw new Error("must not replace"); } },
    };
    expect(await new HerdrHerd(client as any, url, instant).staleIssues()).toHaveLength(1);
    const herd = new HerdrHerd(client as any, url, instant, undefined, agent);
    await reconcileNow(herd, new Map([[spec.key, spec]]));
    expect(await herd.runningIssues()).toEqual([spec.key]);
    expect(closes).toBe(0);
    expect(creates).toBe(0);
  });

  test("Codex MCP TOML round-trips and no Claude-only flags or model leak", () => {
    const args = spawnArgs(spec, "/fixture dir", { provider: "codex" }, url);
    expect(args[0]).toBe("follow your AGENTS.md");
    for (const flag of ["--model", "--effort", "--permission-mode", "--mcp-config", "--dangerously-load-development-channels"]) expect(args).not.toContain(flag);
    const config = Bun.TOML.parse(args[args.indexOf("--config") + 1]!) as any;
    expect(config.mcp_servers.butchr).toEqual({ url, enabled: true, http_headers: { "x-issue": spec.key, "x-butchr-provider": "codex" } });
    const trustArg = args.find((value) => value.startsWith("projects="))!;
    expect(Bun.TOML.parse(trustArg)).toEqual({ projects: { "/fixture dir": { trust_level: "trusted" } } });
    const withoutTrust = args.filter((value, i) => value !== trustArg && !(value === "--config" && args[i + 1] === trustArg));
    expect(checkArgv(args, ["codex", ...withoutTrust]).ok).toBe(false);
    expect(spawnArgs(spec, "/d", { provider: "codex", model: "custom" }, url)).toContain("custom");
    expect(spawnArgs(spec, "/d", { provider: "claude", model: "custom" })).toContain("custom");
    expect(checkArgv(args, ["codex", ...args])).toEqual({ ok: true });
    expect(checkArgv(args, ["codex", "resume", "session"]).ok).toBe(false);
  });

  test("Codex instructions include ground truth and omit Claude warning", () => {
    const dir = buildWorkspace(spec, url, "codex");
    const instructions = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(instructions).toContain("brief.md");
    expect(instructions).not.toContain("{{GROUND_TRUTH}}");
    expect(instructions).not.toContain("startup-order artefact");
    expect(existsSync(join(dir, "ENVIRONMENT.md"))).toBe(true);
  });

  for (const selected of ["claude", "codex"] as AgentProvider[]) test(`mixed residency and staleness with ${selected} selected`, async () => {
    buildWorkspace({ ...spec, key: "TEST-2" }, url, "codex");
    const agents = ["claude", "codex"].map((provider, i) => ({ name: `butchr-test-${i + 1}`, pane_id: `p${i}`, cwd: join(workspaceRoot(), `TEST-${i + 1}`), provider }));
    const client = {
      agent: { list: async () => ({ agents }) },
      pane: {
        list: async () => ({ panes: agents }),
        processInfo: async ({ pane_id }: any) => {
          const a = agents.find((a) => a.pane_id === pane_id)!;
          return { process_info: { foreground_processes: [{ name: a.provider, argv: [a.provider, ...spawnArgs({ ...spec, key: a.name.slice(7).toUpperCase() }, a.cwd, { provider: a.provider as AgentProvider }, url)] }] } };
        },
      },
    };
    const herd = new HerdrHerd(client as any, url, instant, undefined, { provider: selected });
    expect(await herd.staleIssues()).toEqual([]);
    expect(await herd.residentIssues()).toEqual(["TEST-1", "TEST-2"]);
    expect(await herd.closeStranded({ workspaceId: "w", paneIds: ["p1"] } as any)).toBe(false);
  });

  test("Codex spawn recovers kickoff through generic prompt and stays idempotent", async () => {
    const started: any[] = [], prompts: any[] = [];
    const agent = { name: "butchr-test-990", pane_id: "p", agent: "codex", cwd: join(workspaceRoot(), spec.key), agent_status: "idle" };
    const client = {
      agent: { list: async () => ({ agents: started.length ? [agent] : [] }), start: async (p: any) => { started.push(p); }, prompt: async (p: any) => { prompts.push(p); return { agent }; } },
      workspace: { create: async () => ({ root_pane: "p" }) },
      pane: { read: async () => ({ read: { text: "" } }), sendKeys: instant },
    };
    const herd = new HerdrHerd(client as any, url, instant, undefined, { provider: "codex" });
    await herd.spawn(spec);
    await herd.spawn(spec);
    expect(started).toHaveLength(1);
    expect(started[0].kind).toBe("codex");
    expect(started[0].args).toContain("follow your AGENTS.md");
    expect(prompts[0].text).toBe("Read brief.md and ENVIRONMENT.md in your workspace and follow them.");
    expect(await herd.nudge(spec.key, "fixture update")).toEqual({ delivered: true });
    expect(prompts[1].text).toBe("fixture update");
  });

  test("channel routing excludes Codex but retains legacy Claude clients", async () => {
    let filter: any;
    await notifyIssue({ sendAll: async (_: any, opts: any) => { filter = opts.where; } } as any, spec.key, "fixture");
    expect(filter({ headers: { "x-issue": spec.key } })).toBe(true);
    expect(filter({ headers: { "x-issue": spec.key, "x-butchr-provider": "codex" } })).toBe(false);
    expect(filter({ headers: { "x-issue": spec.key, "x-butchr-provider": "agy" } })).toBe(false);
    expect(filter({ headers: { "x-issue": "OTHER-1" } })).toBe(false);
  });

  test("restored Codex missing a persisted isolation override is stale with Claude selected", async () => {
    const disabledMcpServers = [{ name: "yappr", transport: "stdio" as const }];
    const cwd = buildWorkspace(spec, url, "codex", disabledMcpServers);
    const client = {
      agent: { list: async () => ({ agents: [{ name: "butchr-test-990", pane_id: "p", cwd }] }) },
      pane: { processInfo: async () => ({ process_info: { foreground_processes: [{ name: "codex", argv: ["node", ...spawnArgs(spec, cwd, { provider: "codex" }, url)] }] } }) },
    };
    const herd = new HerdrHerd(client as any, url, instant, undefined, { provider: "claude" });
    const stale = await herd.staleIssues();
    expect(stale).toHaveLength(1);
    expect(stale[0]!.reason).toContain("yappr");
  });

  test("kickoff recovery uses shared instructions after changing the selected provider", async () => {
    const prompts: any[] = [];
    const client = {
      agent: { list: async () => ({ agents: [{ name: "butchr-test-990", pane_id: "p", agent_status: "idle", agent: "codex", cwd: join(workspaceRoot(), spec.key) }] }), prompt: async (p: any) => { prompts.push(p); return { agent: { agent_status: "idle" } }; } },
      pane: { read: async () => ({ read: { text: "" } }), sendKeys: instant },
    };
    const herd = new HerdrHerd(client as any, url, instant, undefined, { provider: "codex" });
    await (herd as any).verifyKickoff(spec.key);
    expect(prompts[0].text).toContain("brief.md");
    expect(prompts[0].text).not.toContain("AGENTS.md");
  });

  test("Drovr-corrected trust dialog blocks kickoff recovery and nudges", async () => {
    const prompts: unknown[] = [], keys: unknown[] = [];
    const row = { name: "butchr-test-990", pane_id: "p", agent: "codex", agent_status: "idle" };
    class AgentService {
      async call(method: string, params?: unknown) {
        if (method === "agent.prompt") { prompts.push(params); return { agent: row }; }
        return { agents: [row] };
      }
      list() { return this.call("agent.list"); }
      prompt(params: unknown) { return this.call("agent.prompt", params); }
    }
    const client = new DrovrClient({ herdr: {
      agent: new AgentService(),
      pane: {
        read: async () => ({ read: {
          pane_id: "p", source: "visible", format: "text", truncated: false,
          text: "You are in /fixture Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection. Trusting the directory allows project-local config, hooks, and exec policies to load. > 1. Yes, continue 2. No, quit Press enter to continue",
        } }),
        sendKeys: async (params: unknown) => { keys.push(params); },
      },
    } as any });
    expect((await client.agent.list()).agents[0]!.agent_status).toBe("blocked");
    const herd = new HerdrHerd(client, url, instant);
    await (herd as any).verifyKickoff(spec.key);
    expect(await herd.nudge(spec.key, "fixture update")).toEqual({ delivered: false });
    expect(prompts).toEqual([]);
    expect(keys).toEqual([]);
  });
});
