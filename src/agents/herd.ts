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
    try {
      await this.herdr.agent.start({
      pane_id: paneId,
      name,
      kind: "claude",
      // bypassPermissions: a spawned agent works unattended in its own workspace and
      // must be able to run git/gh without a human to approve each command. Without
      // it the permission classifier denies `git add/commit/push` and the agent
      // completes its work but cannot deliver it (measured, KAN-679).
      // The positional is Claude Code's initial prompt: queued at startup and
      // submitted once the startup dialogs are answered, so the agent kicks
      // itself off. It MUST come FIRST: --dangerously-load-development-channels
      // (and --mcp-config) are variadic and swallow a trailing positional as
      // another entry — "entries must be tagged: follow your CLAUDE.md", claude
      // exits, and the daemon retry-loops leaking a workspace per poll
      // (measured live on KAN-681's first spawn).
      args: ["follow your CLAUDE.md", "--model", modelFor(spec.issuetype), "--permission-mode", "bypassPermissions", "--mcp-config", dir + "/mcp.json", "--dangerously-load-development-channels", "server:butchr"],
    } as Parameters<HerdrClient["agent"]["start"]>[0]);
    } catch (e) {
      // A failed start must not leak the workspace we just created: the next
      // reconcile would create another, forever (measured: 7 in 2 minutes).
      await this.herdr.pane.close(paneId).catch(() => {});
      throw e;
    }
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
