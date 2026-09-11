import { HerdrError, type HerdrClient, type results } from "@brooswit/herdr-sdk";
import { buildWorkspace, workspaceRoot, type SpawnSpec } from "./workspace.js";
import { spawnArgs, checkArgv, KICKOFF_PROMPT } from "./argv.js";
import { detectSessionLimitRefusal, type SessionLimitRefusal } from "./session-limit.js";
import { strandedCandidates, type StrandedCandidate } from "./reap.js";
import { panesFor, groupOwnedPanes, aggregateVerdict, type ResidencyVerdict } from "./residency-census.js";
export type { SpawnSpec } from "./workspace.js";
export type { StrandedCandidate } from "./reap.js";
export type { ResidencyVerdict } from "./residency-census.js";

const basename = (p: string): string => p.replace(/\\/g, "/").split("/").pop() ?? p;
/**
 * Identifies the claude process among a pane's foreground processes. Checked
 * against BOTH argv[0] (tolerating a bun/node wrapper in front of the real
 * binary, same predicate proctable.ts used against /proc) and `name` (always
 * present on the wire, unlike `argv`) — so a process herdr identifies as
 * claude by name but couldn't report argv for is still recognized as THE
 * claude process, just one whose argv (and therefore its health) is unknown.
 */
const isClaude = (p: { argv?: readonly string[] | null; name?: string | null }): boolean =>
  basename(p.argv?.[0] ?? "") === "claude" || basename(p.name ?? "") === "claude";

/**
 * What nudge() actually accomplished — plain "delivered: true" (KAN-829) hid
 * a prompt that landed on a session-limit refusal, so `[notify] … prompt
 * delivered` was logged for a prompt that was, in fact, refused. `delivered`
 * still means "the send call itself succeeded" (agent.prompt did not throw —
 * distinct from `false`, where no agent was running or the pane rejected the
 * send outright, e.g. blocked on a dialog); `refusal` is set in addition,
 * after the verify wait, when the pane shows the session's refusal rather
 * than a started turn — the caller (daemon/index.ts) uses this to log
 * `refused (session limit, resets …)` instead of a bare "delivered", so the
 * operator can `grep` the journal for it.
 */
export interface NudgeResult {
  delivered: boolean;
  refusal?: SessionLimitRefusal;
}

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
   * `claude --resume <id>` after a server restart. Resolved from the pane's
   * OWN foreground process (herdr's `pane.process_info`) — never by scanning
   * /proc for a process sharing the cwd, which a stray process at that cwd
   * could confuse (see CHANGELOG). An agent whose process can't be found at
   * all is NOT stale (unknown ≠ stale).
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
   * a busy agent. `delivered: false` if no agent is running or the pane
   * refused the send outright (blocked); `refusal` set if the send succeeded
   * but the pane shows a session-limit refusal rather than a started turn.
   */
  nudge(issue: string, text: string): Promise<NudgeResult>;
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

/**
 * BUTCHR-268: `workspace.create`'s own just-returned root pane is not
 * reliably ready for `agent.start` — herdr rejects it with `agent_pane_busy`
 * ("not an available shell") on a race, measured (this branch's own commit,
 * see PR) to resolve within roughly the low hundreds of ms on a loaded herd,
 * but NOT bounded by any fixed wait: a repeated measurement still saw a
 * single busy rejection out past 1s. Waiting this long before EVERY
 * `agent.start` attempt (first attempt included) closes most of the gap
 * cheaply — it's negligible next to `KICKOFF_VERIFY_MS`'s multi-second wait
 * a few lines below — but per the measurement above a wait alone is not
 * sufficient; see `PANE_BUSY_MAX_RETRIES`.
 *
 * Exported so `scripts/repro-pane-busy.ts`'s "fixed" measurement mode can
 * exercise the SAME constants this file actually uses, rather than a copy
 * that could silently drift from them.
 */
export const PANE_READY_WAIT_MS = 200;

/**
 * Sibling to `PANE_READY_WAIT_MS`: bounded retries specifically on
 * `agent_pane_busy`, never on any other `agent.start` rejection (those must
 * still reach `spawn()`'s own catch immediately, which closes the pane it
 * just created — BUTCHR-111's leak-safety guarantee). At `PANE_READY_WAIT_MS`
 * between attempts, this bounds the extra wait spawn() can spend retrying to
 * `PANE_BUSY_MAX_RETRIES * PANE_READY_WAIT_MS` = 800ms in the worst case —
 * still negligible next to `KICKOFF_VERIFY_MS`, and small next to the whole
 * poll cycle a failed spawn used to cost before this existed.
 */
export const PANE_BUSY_MAX_RETRIES = 4;

/** Herd backed by a live herdr, over the typed SDK. */
export class HerdrHerd implements Herd {
  constructor(
    private readonly herdr: HerdrClient,
    /** Where the daemon serves its MCP endpoint, so spawned agents can connect back. */
    private readonly mcpUrl: string,
    /** Injectable wait, for tests. */
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
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
    const out: StaleAgent[] = [];
    for (const [issue, { pane, cwd }] of await this.byIssue()) {
      if (!cwd) continue; // no cwd reported — can't build the expected argv — unknown, not stale
      let info: results.PaneProcessInfo | undefined;
      try {
        info = (await this.herdr.pane.processInfo({ pane_id: pane }) as { process_info?: results.PaneProcessInfo }).process_info;
      } catch {
        continue; // herdr hiccup / pane gone — unknown, not stale — and this issue alone, not the whole sweep
      }
      // foreground_processes/argv are both optional/nullable on the wire: a
      // shell still starting, a claude that already exited, or a pane
      // blocked on a dialog can all report none of this — every such gap is
      // UNKNOWN, never stale (a fresh respawn must never itself be
      // respawned every poll — the 7-leaked-workspaces shape, CHANGELOG 0.5.6).
      const proc = info?.foreground_processes?.find((p) => isClaude(p));
      if (!proc?.argv) continue; // no claude in the foreground, or the matched claude reported no argv
      // issuetype/summary/parent don't matter here: --model and --effort
      // (the only things issuetype affects) are both deliberately excluded
      // from the comparison.
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
      await this.startWithReadinessRetry({
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
   * BUTCHR-268: waits `PANE_READY_WAIT_MS` before every attempt (including
   * the first), and retries ONLY an `agent_pane_busy` rejection, up to
   * `PANE_BUSY_MAX_RETRIES` extra times. Any other rejection — including a
   * busy rejection that has exhausted its retries — propagates immediately,
   * unchanged, so `spawn()`'s own catch above still sees it and closes the
   * pane it just created.
   */
  private async startWithReadinessRetry(params: Parameters<HerdrClient["agent"]["start"]>[0]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      await this.wait(PANE_READY_WAIT_MS);
      try {
        await this.herdr.agent.start(params);
        return;
      } catch (e) {
        const busy = e instanceof HerdrError && e.code === "agent_pane_busy";
        if (!busy || attempt >= PANE_BUSY_MAX_RETRIES) throw e;
      }
    }
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

  /**
   * BUTCHR-245: this poll's stranded-and-owned workspace candidates — the
   * "thin method" seam `strandedCandidates` (reap.ts) needs no herdr I/O of
   * its own; this method supplies it, deliberately independent of
   * `byIssue()`/`agent.list()`-keyed state elsewhere in this class (the
   * ownership half of `strandedCandidates` never touches `agent.list()` at
   * all — see that function's own doc comment).
   */
  async strandedCandidates(): Promise<StrandedCandidate[]> {
    const [{ workspaces }, { panes }, { agents }] = await Promise.all([
      this.herdr.workspace.list(),
      this.herdr.pane.list(),
      this.herdr.agent.list(),
    ]);
    return strandedCandidates(workspaces, panes, agents, workspaceRoot());
  }

  /**
   * BUTCHR-287 — a live per-issue residency census, independent of
   * `agent.list()`: for each of `candidates`, whether a pane at that
   * issue's OWN workspace directory (`buildWorkspace()`'s convention,
   * checked by `panesFor` — residency-census.ts) currently shows a live
   * claude in its foreground, reusing the exact `processInfo`/`isClaude`
   * check `paneVerdict` already applies as the reaper's decisive safety
   * layer. `pane.list()` itself is one whole-herd read (herdr has no
   * narrower query); only the `processInfo` calls that follow are scoped
   * to `candidates` — see residency-guard.ts's own doc comment for why
   * that scoping is what keeps this cheap in the common case (an empty or
   * small `plan.spawn`).
   *
   * Deliberately NOT part of the `Herd` interface (mirrors
   * `strandedCandidates`/`closeStranded` above — herdr I/O with no
   * `ownsId` scoping need, since `candidates` already arrives pre-scoped
   * from the caller's own `desired` set): see src/agents/residency-guard.ts
   * for the per-poll orchestration that calls this. A `pane.list()` fetch
   * failure reports every candidate "unknown" rather than throwing — same
   * unknown-≠-vacant discipline `staleIssues()`/`paneVerdict()` already
   * apply, and it leaves the decision of what unknown means to the caller
   * (residency-guard.ts) rather than baking one in here.
   */
  async residency(candidates: readonly string[]): Promise<ReadonlyMap<string, ResidencyVerdict>> {
    const out = new Map<string, ResidencyVerdict>();
    if (!candidates.length) return out;
    let panes: readonly results.PaneInfo[];
    try {
      ({ panes } = await this.herdr.pane.list());
    } catch {
      for (const id of candidates) out.set(id, "unknown");
      return out;
    }
    const root = workspaceRoot();
    for (const id of candidates) {
      const owned = panesFor(id, panes, root);
      const verdicts = await Promise.all(owned.map((p) => this.paneVerdict(p.pane_id)));
      out.set(id, aggregateVerdict(verdicts));
    }
    return out;
  }

  /**
   * BUTCHR-287 — the minimal reusable shape of the census above: every
   * currently-RESIDENT issue key, with no candidate list supplied at all
   * (a whole-herd sweep, via `groupOwnedPanes` rather than `panesFor` —
   * residency-census.ts), built on the exact same primitives as
   * `residency()`. Exposed so a future consumer needing only "which issues
   * are alive right now" (e.g. BUTCHR-284's admission cap, whose own
   * `residency` dependency is already shaped `() => Promise<readonly
   * string[]>`) can point at it with a one-line change — NOT wired to
   * anything in this ticket; that wiring is a deliberate follow-up owned
   * elsewhere (see this ticket's own report for why).
   *
   * Throws rather than reporting an empty list on a `pane.list()` failure
   * (unlike `residency()` above, which reports "unknown" per candidate):
   * a bare `[]` here would be indistinguishable from "genuinely nothing is
   * resident" to a caller that only asked for resident KEYS with no
   * unknown channel to report into — exactly the confident-zero hazard
   * this whole ticket exists to close. A future caller must decide its own
   * fail-open/fail-safe behaviour on a rejection, not inherit a silent
   * zero from this method.
   */
  async residentIssues(): Promise<readonly string[]> {
    const { panes } = await this.herdr.pane.list();
    const grouped = groupOwnedPanes(panes, workspaceRoot());
    const out: string[] = [];
    for (const [issue, ownedPanes] of grouped) {
      const verdicts = await Promise.all(ownedPanes.map((p) => this.paneVerdict(p.pane_id)));
      if (aggregateVerdict(verdicts) === "resident") out.push(issue);
    }
    return out;
  }

  /**
   * BUTCHR-245: verify ONE stranded candidate is genuinely dead — the
   * decisive safety layer (reap.ts's own top comment names three; this is
   * layer 2). Reap only if `pane.processInfo` SUCCEEDS for every one of the
   * candidate's panes and NONE reports a claude process in its foreground
   * (`isClaude`, this file). A thrown call, a missing `process_info`, or an
   * empty `foreground_processes` are all UNKNOWN, never dead — same
   * unknown-≠-stale discipline `staleIssues()` above already applies, for
   * the same reason (a fresh respawn's pane, or a herdr hiccup, must never
   * read as proof of death). Never throws: a herdr rejection on the verify
   * OR the close resolves `false` — "not reaped this poll" — never
   * propagates into the caller's per-poll loop (`reap.ts`'s `createReaper`
   * additionally wraps this call too — belt and suspenders, matching this
   * ticket's own "each close catches its own rejection" requirement).
   */
  async closeStranded(candidate: StrandedCandidate): Promise<boolean> {
    try {
      const verdict = await this.workspaceVerdict(candidate.paneIds);
      if (verdict !== "dead") return false;
      await this.herdr.workspace.close({ workspace_id: candidate.workspaceId } as Parameters<HerdrClient["workspace"]["close"]>[0]);
      return true;
    } catch {
      return false;
    }
  }

  /** "dead" only if EVERY pane's own verdict is "dead" (see `paneVerdict`); a single "live" pane vetoes the whole workspace immediately, a single "unknown" pane makes the whole workspace "unknown" (never "dead") but does not short-circuit — every pane is still checked, since a LATER pane could still veto with "live". */
  private async workspaceVerdict(paneIds: readonly string[]): Promise<"live" | "dead" | "unknown"> {
    if (!paneIds.length) return "unknown"; // no panes reported for this workspace — nothing to verify against
    let allDead = true;
    for (const paneId of paneIds) {
      const v = await this.paneVerdict(paneId);
      if (v === "live") return "live";
      if (v === "unknown") allDead = false;
    }
    return allDead ? "dead" : "unknown";
  }

  /**
   * "dead" requires a SUCCESSFUL processInfo call reporting at least one
   * identified foreground process, none of which is claude (e.g. the
   * measured `fish`/`/usr/bin/fish` shape). Deliberately NOT "dead" for an
   * empty `foreground_processes` — herdr reporting the call succeeded but
   * found nothing there is not proof nothing is there; it's exactly as
   * unverifiable as a thrown call or a missing `process_info`.
   */
  private async paneVerdict(paneId: string): Promise<"live" | "dead" | "unknown"> {
    let info: results.PaneProcessInfo | undefined;
    try {
      info = (await this.herdr.pane.processInfo({ pane_id: paneId }) as { process_info?: results.PaneProcessInfo }).process_info;
    } catch {
      return "unknown";
    }
    const procs = info?.foreground_processes;
    if (!procs || procs.length === 0) return "unknown";
    return procs.some((p) => isClaude(p)) ? "live" : "dead";
  }

  private async statusOf(issue: string): Promise<string | null> {
    const { agents } = await this.herdr.agent.list();
    for (const a of agents) if (issueOf((a as { name?: string }).name) === issue) return a.agent_status ?? null;
    return null;
  }

  async nudge(issue: string, text: string): Promise<NudgeResult> {
    if (!(await this.byIssue()).has(issue)) return { delivered: false };
    try {
      await this.herdr.agent.prompt({ target: nameFor(issue), text } as Parameters<HerdrClient["agent"]["prompt"]>[0]);
    } catch {
      return { delivered: false }; // e.g. the pane is blocked on a dialog — the prompt-watcher owns that
    }
    // "Delivered" is not "a turn started": a prompt landing as a turn ends
    // strands in the composer unsubmitted (KAN-691 sat 2.5h on an approved PR)
    // — or, per KAN-829, lands on a session-limit refusal, which looks
    // identical from here (still idle) but must not be treated the same way.
    // Verify a turn starts; if the agent is still IDLE — never blocked, where
    // enter would select a dialog option — check for a refusal before
    // submitting the stranded composer text: sending enter into a refused
    // session accomplishes nothing and only muddies what actually happened.
    await this.wait(NUDGE_VERIFY_MS);
    if ((await this.statusOf(issue)) === "idle") {
      const entry = (await this.byIssue()).get(issue); // re-resolve: panes renumber
      if (entry) {
        // A transient herdr hiccup here must not propagate: before this
        // refusal check existed, nudge() could no longer throw once
        // agent.prompt succeeded (sendKeys below is already .catch(() => {})),
        // and daemon/index.ts's caller turns a throw into `{ delivered: false }`
        // — inverting the honesty fix (a DELIVERED prompt logged as refused)
        // and skipping the stranded-composer enter (KAN-691's 2.5h stall,
        // reopened via an unrelated transient). Same treatment as
        // staleIssues()'s "herdr hiccup / pane gone — unknown, not stale".
        const text = await this.readPane(entry.pane).catch(() => "");
        const refusal = detectSessionLimitRefusal(text, new Date());
        if (refusal) return { delivered: true, refusal };
        await this.herdr.pane.sendKeys({ pane_id: entry.pane, keys: ["enter"] } as Parameters<HerdrClient["pane"]["sendKeys"]>[0]).catch(() => {});
      }
    }
    return { delivered: true };
  }
}

export { nameFor as agentNameFor, issueOf as issueOfAgentName };
