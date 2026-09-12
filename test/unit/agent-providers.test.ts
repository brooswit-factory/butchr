import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnArgs, checkArgv, codexMcpServerNames, type AgentProvider } from "../../src/agents/argv.js";
import { buildWorkspace, workspaceRoot } from "../../src/agents/workspace.js";
import { HerdrHerd } from "../../src/agents/herd.js";
import { loadConfig } from "../../src/config/config.js";
import { notifyIssue } from "../../src/daemon/app.js";

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

  test("Codex MCP TOML round-trips and no Claude-only flags or model leak", () => {
    const args = spawnArgs(spec, "/fixture dir", { provider: "codex" }, url);
    expect(args[0]).toBe("follow your AGENTS.md");
    for (const flag of ["--model", "--effort", "--permission-mode", "--mcp-config", "--dangerously-load-development-channels"]) expect(args).not.toContain(flag);
    const config = Bun.TOML.parse(args[args.indexOf("--config") + 1]!) as any;
    expect(config.mcp_servers.butchr).toEqual({ url, enabled: true, http_headers: { "x-issue": spec.key, "x-butchr-provider": "codex" } });
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
    const agent = { name: "butchr-test-990", pane_id: "p", agent_status: "idle" };
    const client = {
      agent: { list: async () => ({ agents: started.length ? [agent] : [] }), start: async (p: any) => { started.push(p); }, prompt: async (p: any) => { prompts.push(p); } },
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
      agent: { list: async () => ({ agents: [{ name: "butchr-test-990", pane_id: "p", agent_status: "idle", kind: "claude" }] }), prompt: async (p: any) => { prompts.push(p); } },
      pane: { read: async () => ({ read: { text: "" } }), sendKeys: instant },
    };
    const herd = new HerdrHerd(client as any, url, instant, undefined, { provider: "codex" });
    await (herd as any).verifyKickoff(spec.key);
    expect(prompts[0].text).toContain("brief.md");
    expect(prompts[0].text).not.toContain("AGENTS.md");
  });
});
