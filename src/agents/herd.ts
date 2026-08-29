import type { HerdrClient } from "@brooswit/herdr-sdk";
import { buildWorkspace, type SpawnSpec } from "./workspace.js";
import { spawnArgs, checkArgv, KICKOFF_PROMPT } from "./argv.js";
import { selectClaudeProcess, realProcessTable, type ProcessEntry } from "./proctable.js";
import { detectSessionLimitRefusal } from "./session-limit.js";
export type { SpawnSpec } from "./workspace.js";

/** A running agent found to be stale: its process argv lacks butchr's spawn flags. */
export interface StaleAgent {
  issue: string;
  /** Why it's stale — a checkArgv() reason string, e.g. "argv lacks --permission-mode bypassPermissions". */
  reason: string;
  /** The offending process's real argv, for the log line and Jira notice. */
  observedArgv: string[];
}

/** What the reconcile loop needs from herdr. Abstracted so it fakes cleanly in tests. */
export interface Herd {
  /** Issues that currently have a butchr-managed agent running. */
  runningIssues(): Promise<string[]>;
  /**
   * Running agents whose claude process was found, but its argv lacks
   * butchr's spawn flags — e.g. a pane herdr restored as a bare
   * `claude --resume <id>` after a server restart. An agent whose process
   * can't be found at all is NOT stale (unknown ≠ stale — see proctable.ts).
   */
  staleIssues(): Promise<StaleAgent[]>;
  /** Start an agent for an issue (idempotent — a no-op if one is already running). */
  spawn(spec: SpawnSpec): Promise<void>;
  /** Shut off the agent for an issue (idempotent). */
  stop(issue: string): Promise<void>;
  /** The current pane id of an issue's agent, freshly resolved, or null if not running. */
  paneFor(issue: string): Promise<string | null>;
  /**
   * Deliver `text` to the issue's agent as a prompt — this STARTS a turn on an
   * idle agent (a channel push renders mid-turn but cannot wake one). Queues on
   * a busy agent. False if no agent is running or the pane refused (blocked).
   */
  nudge(issue: string, text: string): Promise<boolean>;
}

const AGENT_PREFIX = "butchr-";
const nameFor = (issue: string) => AGENT_PREFIX + issue.toLowerCase();
const issueOf = (name: string | null | undefined) =>
  name && name.startsWith(AGENT_PREFIX) ? name.slice(AGENT_PREFIX.length).toUpperCase() : null;

/**
 * How long nudge() waits after delivering a prompt before checking whether a
 * turn actually started, vs. the prompt merely landing in an unsubmitted
 * composer (KAN-691 sat 2.5h on exactly that). 8s is long enough for Claude
 * Code to move off "idle" once it accepts input.
 */
const NUDGE_VERIFY_MS = 8_000;

/**
 * Sibling to NUDGE_VERIFY_MS: how long spawn() waits after `agent.start`
 * before checking whether the kickoff actually started a turn (KAN-804/807 —
 * the kickoff is fire-and-forget, unlike a nudge, so nothing else ever
 * re-checks it). Slightly longer than the nudge wait: a cold process start
 * (loading, startup dialogs) is slower than an already-running agent
 * accepting a new prompt. ~8-15s is the intended range.
 */
const KICKOFF_VERIFY_MS = 12_000;

/** Herd backed by a live herdr, over the typed SDK. */
export class HerdrHerd implements Herd {
  constructor(
    private readonly herdr: HerdrClient,
    /** Where the daemon serves its MCP endpoint, so spawned agents can connect back. */
    private readonly mcpUrl: string,
    /** Injectable wait, for tests. */
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    /** Injectable process table reader, for tests — defaults to walking /proc. */
    private readonly processSource: () => Promise<ProcessEntry[]> = realProcessTable,
  ) {}

  private async byIssue(): Promise<Map<string, { pane: string; cwd: string | null }>> {
    const { agents } = await this.herdr.agent.list();
    const map = new Map<string, { pane: string; cwd: string | null }>();
    for (const a of agents) {
      const issue = issueOf((a as { name?: string }).name);
      if (issue && a.pane_id) map.set(issue, { pane: a.pane_id, cwd: (a as { cwd?: string | null }).cwd ?? null });
    }
    return map;
  }

  async runningIssues(): Promise<string[]> {
    return [...(await this.byIssue()).keys()];
  }

  async staleIssues(): Promise<StaleAgent[]> {
    const table = await this.processSource();
    const out: StaleAgent[] = [];
    for (const [issue, { cwd }] of await this.byIssue()) {
      if (!cwd) continue; // no cwd reported — can't locate its process — unknown, not stale
      const proc = selectClaudeProcess(cwd, table);
      if (!proc) continue; // no claude process found — unknown, not stale
      // issuetype/summary/parent don't matter here: --model (the only thing
      // issuetype affects) is deliberately excluded from the comparison.
      const expected = spawnArgs({ key: issue, issuetype: "task", summary: "", parent: null }, cwd);
      const check = checkArgv(expected, proc.argv);
      if (!check.ok) out.push({ issue, reason: check.reason, observedArgv: proc.argv });
    }
    return out;
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
      // See spawnArgs() (argv.ts) for why: bypassPermissions (KAN-679), the
      // positional-first ordering (KAN-681/CHANGELOG 0.5.6) — and it's the
      // single source the staleness check compares a restored pane against.
      args: spawnArgs(spec, dir),
    } as Parameters<HerdrClient["agent"]["start"]>[0]);
    } catch (e) {
      // A failed start must not leak the workspace we just created: the next
      // reconcile would create another, forever (measured: 7 in 2 minutes).
      await this.herdr.pane.close(paneId).catch(() => {});
      throw e;
    }
    await this.verifyKickoff(issue);
  }

  /**
   * KAN-804/807: the kickoff is fire-and-forget — unlike nudge()'s prompt, or
   * a blocked dialog, NOTHING else ever re-sends it if it's swallowed (e.g.
   * landing at a Claude session-limit refusal). Give it KICKOFF_VERIFY_MS,
   * then check whether a turn actually started; if not, recover the same way
   * nudge() recovers a stranded composer — UNLESS the pane shows a
   * session-limit refusal, which is not recoverable by re-sending (the
   * refusal is a property of the CLI session, not of the composer) and is
   * instead handled by the level-triggered poll in session-limit-watch.ts.
   */
  private async verifyKickoff(issue: string): Promise<void> {
    await this.wait(KICKOFF_VERIFY_MS);
    const status = await this.statusOf(issue);
    if (status !== "idle" && status !== "done") return; // working/blocked: the kickoff landed
    const entry = (await this.byIssue()).get(issue); // re-resolve: panes renumber
    if (!entry) return;
    const text = await this.readPane(entry.pane);
    if (detectSessionLimitRefusal(text, new Date())) return;
    await this.nudge(issue, KICKOFF_PROMPT);
  }

  private async readPane(paneId: string): Promise<string> {
    const r = await this.herdr.pane.read({ pane_id: paneId, source: "detection", strip_ansi: true } as Parameters<HerdrClient["pane"]["read"]>[0]);
    return (r as { read: { text: string } }).read.text;
  }

  async stop(issue: string): Promise<void> {
    const pane = (await this.byIssue()).get(issue)?.pane;
    if (pane) await this.herdr.pane.close(pane);
  }

  async paneFor(issue: string): Promise<string | null> {
    return (await this.byIssue()).get(issue)?.pane ?? null;
  }

  private async statusOf(issue: string): Promise<string | null> {
    const { agents } = await this.herdr.agent.list();
    for (const a of agents) if (issueOf((a as { name?: string }).name) === issue) return a.agent_status ?? null;
    return null;
  }

  async nudge(issue: string, text: string): Promise<boolean> {
    if (!(await this.byIssue()).has(issue)) return false;
    try {
      await this.herdr.agent.prompt({ target: nameFor(issue), text } as Parameters<HerdrClient["agent"]["prompt"]>[0]);
    } catch {
      return false; // e.g. the pane is blocked on a dialog — the prompt-watcher owns that
    }
    // "Delivered" is not "a turn started": a prompt landing as a turn ends
    // strands in the composer unsubmitted (KAN-691 sat 2.5h on an approved PR).
    // Verify a turn starts; if the agent is still IDLE — never blocked, where
    // enter would select a dialog option — submit the stranded composer text.
    await this.wait(NUDGE_VERIFY_MS);
    if ((await this.statusOf(issue)) === "idle") {
      const pane = (await this.byIssue()).get(issue)?.pane; // re-resolve: panes renumber
      if (pane) await this.herdr.pane.sendKeys({ pane_id: pane, keys: ["enter"] } as Parameters<HerdrClient["pane"]["sendKeys"]>[0]).catch(() => {});
    }
    return true;
  }
}

export { nameFor as agentNameFor, issueOf as issueOfAgentName };
