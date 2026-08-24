import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HerdrClient } from "@brooswit/herdr-sdk";

/** What the reconcile loop needs from herdr. Abstracted so it fakes cleanly in tests. */
export interface Herd {
  /** Issues that currently have a butchr-managed agent running. */
  runningIssues(): Promise<string[]>;
  /** Start an agent for an issue (idempotent — a no-op if one is already running). */
  spawn(issue: string): Promise<void>;
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

  async spawn(issue: string): Promise<void> {
    if ((await this.byIssue()).has(issue)) return;
    // Per-issue MCP config: the agent connects to butchr's channel and identifies
    // the issue it works on via the x-issue header. --channels opts the session
    // into receiving butchr's pushes (the server must be on the approved list).
    const dir = join(tmpdir(), "butchr-agents", issue);
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "mcp.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { butchr: { type: "http", url: this.mcpUrl, headers: { "x-issue": issue } } } }));
    // herdr needs a pane to start the agent in: create a workspace for the issue,
    // then start the agent in its root pane.
    const created = await this.herdr.workspace.create({ label: issue } as Parameters<HerdrClient["workspace"]["create"]>[0]);
    const rp = (created as { root_pane?: unknown }).root_pane;
    const paneId = typeof rp === "string" ? rp : (rp as { pane_id?: string })?.pane_id;
    if (!paneId) throw new Error(`workspace.create for ${issue} returned no root pane`);
    await this.herdr.agent.start({
      pane_id: paneId,
      name: nameFor(issue),
      kind: "claude",
      args: ["--mcp-config", cfg, "--channels", "server:butchr"],
    } as Parameters<HerdrClient["agent"]["start"]>[0]);
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
