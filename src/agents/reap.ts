import { agentIdOfWorkspacePath } from "./workspace.js";
import type { results } from "@brooswit/drovr";

/**
 * BUTCHR-245 — reclaiming a workspace whose agent exited on its own (a
 * session-limit refusal, a crash, a manual `/exit`). `HerdrHerd.stop()` is
 * keyed on `agent.list()` (`byIssue()`, herd.ts) — once an agent vanishes
 * from that list, `stop()` on its issue is a silent no-op forever, and the
 * workspace/pane stay open, unreachable by anything butchr remembers. This
 * module gives butchr a SECOND, independent route to a workspace it
 * created: ownership proven from the workspace/pane state alone (never from
 * anything in memory, never from `agent.list()`), so it reclaims a stranded
 * workspace whether it predates this process's own lifetime or not.
 *
 * Three seams, deliberately kept separate so the decision is testable
 * without a herdr:
 *   1. `strandedCandidates` — pure ownership+agentless join, no I/O.
 *   2. `ReapGuard` — the across-poll grace period, no I/O.
 *   3. `createReaper` — the per-poll orchestration: gather candidates
 *      (`deps.candidates`), grace-filter them, verify+close through
 *      `deps.close` (a `HerdrHerd` method — see herd.ts's `closeStranded`
 *      — that does the `processInfo` live-check and only then
 *      `workspace.close`), capped and fault-isolated per candidate.
 */

/** A workspace herdr reports that is butchr's own (ownership proven, see `strandedCandidates`) and currently has no herdr-known agent. */
export interface StrandedCandidate {
  workspaceId: string;
  /**
   * Herdr's own free-text `workspace.label` — display/log only (FACTORY-92).
   * NEVER used to prove ownership or to derive the account to release: it's
   * free text a human can type, and a project-tier label is a bare project
   * key that collides with anything. `agentKey` below is the field every
   * ownership/account decision actually keys off.
   */
  label: string;
  /**
   * The REAL agent key (FACTORY-92), derived from a pane's `cwd` via the
   * shared `agentIdOfWorkspacePath` (src/agents/workspace.ts) — the same
   * helper residency-census.ts's `groupOwnedPanes` already uses, so there is
   * exactly ONE place that maps cwd -> agent key. This IS the ownership
   * proof (see `strandedCandidates`' own doc comment) and what
   * `ReaperDeps.release` is called with.
   */
  agentKey: string;
  paneIds: readonly string[];
}

/**
 * Pure ownership+agentless join over one poll's three herdr snapshots — no
 * herdr I/O of its own (that's `HerdrHerd.strandedCandidates()`, herd.ts),
 * and no live-process check (that's the separate `processInfo` layer,
 * deliberately never folded in here — see this file's own top comment).
 *
 * OWNERSHIP (BUTCHR-245's own ruling, re-grounded by FACTORY-92): a
 * workspace is butchr's iff one of its panes' `cwd` resolves, via the
 * shared `agentIdOfWorkspacePath`, to a real agent key under `root` —
 * `buildWorkspace()`'s own convention (src/agents/workspace.ts). Herdr's
 * reported `label` is NEVER consulted for this: it's free text a human can
 * type, and a project-tier label is a bare project key that collides with
 * anything, so it settles nothing about ownership by itself — only the
 * pane's actual cwd, run through the shared decoder, does.
 *
 * AGENTLESS: no `AgentInfo` in this poll's `agent.list()` names this
 * `workspace_id` — this is the independence the ticket requires: reachable
 * without going through `agent.list()` at all for the OWNERSHIP proof, and
 * consulting it only to ask "does anything herdr currently knows about live
 * here" — a fact `agent.list()` is perfectly suited to answer; what it
 * cannot answer is "did butchr create this," which the cwd-derived agent
 * key above settles independently.
 */
export function strandedCandidates(
  workspaces: readonly results.WorkspaceInfo[],
  panes: readonly results.PaneInfo[],
  agents: readonly results.AgentInfo[],
  root: string,
): StrandedCandidate[] {
  const agentWorkspaceIds = new Set(agents.map((a) => a.workspace_id));
  const panesByWorkspace = new Map<string, results.PaneInfo[]>();
  for (const p of panes) {
    const arr = panesByWorkspace.get(p.workspace_id);
    if (arr) arr.push(p);
    else panesByWorkspace.set(p.workspace_id, [p]);
  }
  const out: StrandedCandidate[] = [];
  for (const w of workspaces) {
    if (agentWorkspaceIds.has(w.workspace_id)) continue; // something herdr knows about lives here — never a candidate
    const wpanes = panesByWorkspace.get(w.workspace_id) ?? [];
    const agentKey = wpanes.map((p) => agentIdOfWorkspacePath(p.cwd, root)).find((k): k is string => k !== null);
    if (!agentKey) continue; // ownership not proven — never a candidate, whatever the label says
    out.push({ workspaceId: w.workspace_id, label: w.label, agentKey, paneIds: wpanes.map((p) => p.pane_id) });
  }
  return out;
}

/** How long, and how many observations, a workspace must sit in the candidate set before it's eligible — see this class's own doc comment. */
const GRACE_MS = 60_000;
const GRACE_OBSERVATIONS = 2;

interface GraceEntry {
  firstSeenAt: number;
  count: number;
}

/**
 * Across-poll grace period (BUTCHR-245): a workspace must be observed
 * agentless-and-owned on at least `GRACE_OBSERVATIONS` consecutive
 * `observe()` calls of THIS tracker AND for at least `GRACE_MS` of wall
 * clock since the first of those observations — BOTH, not either: the poll
 * interval is configurable and a short one must not collapse the window.
 * This is what protects the seconds between `workspace.create` returning
 * and `agent.start` registering the agent (`HerdrHerd.spawn()`, herd.ts) —
 * a spawn-in-progress looks exactly like a stranded slot for that window.
 *
 * PRUNING: an id absent from a given `observe()`'s candidate set loses its
 * accumulated count entirely — it must start over from zero. This is what
 * makes "the workspace gains an agent, or disappears, resets the counter"
 * true: neither case can ever appear in a later `observe()`'s candidate
 * set again unless it genuinely becomes agentless-and-owned afresh. Same
 * "prune on any disappearance" shape as crash-loop.ts's `CrashLoopTracker`
 * and loop.ts's `RespawnGuard`.
 */
export class ReapGuard {
  private readonly entries = new Map<string, GraceEntry>();

  /** One poll's observation. Returns the ids (among `candidateIds`) that have now cleared the grace period. */
  observe(candidateIds: ReadonlySet<string>, now: number): string[] {
    for (const id of [...this.entries.keys()]) if (!candidateIds.has(id)) this.entries.delete(id);
    const eligible: string[] = [];
    for (const id of candidateIds) {
      const e = this.entries.get(id);
      if (!e) {
        this.entries.set(id, { firstSeenAt: now, count: 1 });
        continue;
      }
      e.count += 1;
      if (e.count >= GRACE_OBSERVATIONS && now - e.firstSeenAt >= GRACE_MS) eligible.push(id);
    }
    return eligible;
  }
}

/**
 * Per-poll cap on closes (BUTCHR-245: "consider a per-poll cap on closes and
 * argue for whatever you choose"). Bounds the worst-case herdr I/O burst
 * (a `processInfo` + `workspace.close` round trip per candidate) any single
 * poll pays, while still draining a large backlog quickly: at 10/poll, the
 * issue tier's 15s cadence reclaims even the ~37-workspace backlog this
 * ticket measured in well under a minute of polling once each candidate has
 * individually cleared its own grace period — a candidate not reached this
 * poll is simply picked up again next poll (it's still in the candidate set
 * and already past its own grace period, so it costs nothing to retry).
 */
const MAX_CLOSES_PER_POLL = 10;

export interface ReaperDeps {
  now: () => number;
  /** This poll's stranded-and-owned candidates — `HerdrHerd.strandedCandidates()` (herd.ts): gathers `workspace.list`/`pane.list`/`agent.list` and joins them via `strandedCandidates` above. */
  candidates: () => Promise<StrandedCandidate[]>;
  /**
   * Verify-and-close ONE candidate — `HerdrHerd.closeStranded()` (herd.ts):
   * the live-process check (`pane.processInfo` per pane, reusing `isClaude`)
   * and, only when every pane comes back definitively dead, `workspace.close`.
   * Resolves `true` iff actually closed; `false` for "verified live/unknown,
   * left alone" AND for a caught herdr rejection alike — `check` below
   * additionally wraps this call itself (belt and suspenders, matching the
   * BUTCHR-147 isolation discipline this ticket calls for explicitly: "each
   * close catches its own rejection").
   */
  close: (candidate: StrandedCandidate) => Promise<boolean>;
  /**
   * BUTCHR-412: released after a candidate is actually closed — called with
   * `candidate.agentKey` (FACTORY-92), the real agent key
   * `strandedCandidates` derived from a pane's cwd via the shared
   * `agentIdOfWorkspacePath` — NEVER `candidate.label`, which is free text a
   * human (or a later herdr) can set to anything. This is the self-exit
   * path's own account teardown (a crash, `/exit`, or a quota-exhaustion
   * close that never goes through `HerdrHerd.stop()`/`reconcileNow`'s
   * `plan.stop` at all) — see `docs/rocketchat-accounts.md`'s "Wiring"
   * section. Optional; omitted, no account lifecycle runs for a reaped
   * workspace (every caller before this ticket). Never awaited into a
   * failed reap: a release failure is logged and swallowed, same fault
   * isolation `check()` already gives every other candidate's close.
   */
  release?: (agentKey: string) => Promise<void>;
  log?: (line: string) => void;
}

export interface Reaper {
  /**
   * One poll's worth of reclamation. Never throws — a herdr hiccup anywhere
   * in this call (gathering candidates, or any one candidate's verify/close)
   * degrades to "reaped nothing this poll," never aborts the caller's poll.
   * Logs one greppable `[reap] reclaimed workspace <id> (<label>)` line per
   * reclaimed workspace, plus a per-poll summary count — no Jira comment
   * (a reclaim is routine housekeeping; see this ticket's own ruling on why
   * a fleet-wide reclaim burst must never post 37 comments at once).
   */
  check: () => Promise<void>;
}

/** Builds the reaper wired into `reconcileNow`'s `ReconcileOptions.checkReap` (src/daemon/loop.ts), called once per poll before the spawn loop runs. */
export function createReaper(deps: ReaperDeps): Reaper {
  const guard = new ReapGuard();
  const log = (line: string) => deps.log?.(line);

  async function check(): Promise<void> {
    try {
      const candidates = await deps.candidates();
      const byId = new Map(candidates.map((c) => [c.workspaceId, c]));
      const eligible = guard.observe(new Set(byId.keys()), deps.now());
      if (!eligible.length) return;
      let closed = 0;
      for (const id of eligible) {
        if (closed >= MAX_CLOSES_PER_POLL) {
          log(`[reap] per-poll cap (${MAX_CLOSES_PER_POLL}) reached — ${eligible.length - closed} more candidate(s) deferred to next poll`);
          break;
        }
        const c = byId.get(id);
        if (!c) continue; // defensive only: c is always present — id came from byId's own keys via guard.observe
        try {
          const didClose = await deps.close(c);
          if (didClose) {
            closed++;
            log(`[reap] reclaimed workspace ${c.workspaceId} (${c.label})`);
            if (deps.release) {
              await deps.release(c.agentKey).catch((e) => log(`WARNING: [reap] account release failed for ${c.agentKey}: ${(e as Error)?.message ?? e}`));
            }
          }
        } catch (e) {
          log(`WARNING: [reap] close failed for ${c.workspaceId} (${c.label}): ${(e as Error)?.message ?? e}`);
        }
      }
      if (closed) log(`[reap] reclaimed ${closed} stranded workspace(s) this poll`);
    } catch (e) {
      log(`WARNING: [reap] detector error: ${(e as Error)?.message ?? e}`);
    }
  }

  return { check };
}
