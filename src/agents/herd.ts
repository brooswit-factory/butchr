import type { HerdrClient } from "@brooswit/herdr-sdk";
import { buildWorkspace, modelFor, type SpawnSpec } from "./workspace.js";
export type { SpawnSpec } from "./workspace.js";

/** What the reconcile loop needs from herdr. Abstracted so it fakes cleanly in tests. */
export interface Herd {
  /** Issues that currently have a butchr-managed agent running. */
  runningIssues(): Promise<string[]>;
  /** Start an agent for an issue (idempotent — a no-op if one is already running). */
  spawn(spec: SpawnSpec): Promise<void>;
  /** Shut off the agent for an issue (idempotent). */
  stop(issue: string): Promise<void>;
  /** The current pane id of an issue's agent, freshly resolved, or null if not running. */
  paneFor(issue: string): Promise<string | null>;
}

const AGENT_PREFIX = "butchr-";
const nameFor = (issue: string) => AGENT_PREFIX + issue.toLowerCase();
const issueOf = (name: string | null | undefined) =>
  name && name.startsWith(AGENT_PREFIX) ? name.slice(AGENT_PREFIX.length).toUpperCase() : null;

/** Herd backed by a live herdr, over the typed SDK. */
export class HerdrHerd implements Herd {
  constructor(
    private readonly herdr: HerdrClient,
    /** Where the daemon serves its MCP endpoint, so spawned agents can connect back. */
    private readonly mcpUrl: string,
  ) {}

  private async byIssue(): Promise<Map<string, string>> {
    const { agents } = await this.herdr.agent.list();
    const map = new Map<string, string>();
    for (const a of agents) {
      const issue = issueOf((a as { name?: string }).name);
      if (issue && a.pane_id) map.set(issue, a.pane_id);
    }
    return map;
  }

  async runningIssues(): Promise<string[]> {
    return [...(await this.byIssue()).keys()];
  }

  async spawn(spec: SpawnSpec): Promise<void> {
    const issue = spec.key;
    if ((await this.byIssue()).has(issue)) return;
    // The agent's filesystem workspace: CLAUDE.md + interpolated brief.md +
    // mcp.json (x-issue identity). Claude Code auto-reads CLAUDE.md from cwd,
    // which cascades into the brief.
    const dir = buildWorkspace(spec, this.mcpUrl);
    // herdr needs a pane: create a workspace WITH that cwd, start the agent in
    // its root pane, with the model for this issue type.
    const created = await this.herdr.workspace.create({ label: issue, cwd: dir } as Parameters<HerdrClient["workspace"]["create"]>[0]);
    const rp = (created as { root_pane?: unknown }).root_pane;
    const paneId = typeof rp === "string" ? rp : (rp as { pane_id?: string })?.pane_id;
    if (!paneId) throw new Error(`workspace.create for ${issue} returned no root pane`);
    const name = nameFor(issue);
    await this.herdr.agent.start({
      pane_id: paneId,
      name,
      kind: "claude",
      args: ["--model", modelFor(spec.issuetype), "--mcp-config", dir + "/mcp.json", "--channels", "server:butchr"],
    } as Parameters<HerdrClient["agent"]["start"]>[0]);
    // Kickoff: once the agent settles to idle (startup prompts auto-answered by
    // the prompt-watcher), tell it to follow its CLAUDE.md. Fire-and-forget —
    // a timeout here must not wedge the reconcile loop.
    void this.herdr.agent
      .wait({ target: name, until: ["idle"], timeout_ms: 180_000 } as Parameters<HerdrClient["agent"]["wait"]>[0])
      .then(() => this.herdr.agent.prompt({ target: name, text: "follow your CLAUDE.md" } as Parameters<HerdrClient["agent"]["prompt"]>[0]))
      .catch((e) => console.error(`  kickoff for ${issue} failed: ${(e as Error)?.message ?? e}`));
  }

  async stop(issue: string): Promise<void> {
    const pane = (await this.byIssue()).get(issue);
    if (pane) await this.herdr.pane.close(pane);
  }

  async paneFor(issue: string): Promise<string | null> {
    return (await this.byIssue()).get(issue) ?? null;
  }
}

export { nameFor as agentNameFor, issueOf as issueOfAgentName };
