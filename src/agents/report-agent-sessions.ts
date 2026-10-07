import { params, results } from "@brooswit/drovr";
import { workspaceSessionId } from "./workspace.js";

/**
 * FACTORY-714/FACTORY-713/FACTORY-704 (re-aimed) — the `source` every
 * `pane.report_agent_session` call from this function carries. herdr groups
 * reports by source so a stale report from one reporter can be told apart
 * from a fresh one from another; `"herdr:claude"` is the same source
 * agentsafety's own rehearsal used against a real herdr (see FACTORY-704's
 * checkpoint addendum) — kept identical rather than invented, so a reader
 * correlating herdr's own logs against that rehearsal sees the same string.
 */
export const AGENT_SESSION_REPORT_SOURCE = "herdr:claude";

/** Minimal slice of `DrovrClient` this needs — real callers pass the real client; tests pass a fake. */
export interface ReportAgentSessionsHerdr {
  agent: { list(): Promise<{ agents: readonly results.AgentInfo[] }> };
  pane: { reportAgentSession(p: params.PaneReportAgentSessionParams): Promise<unknown> };
}

export interface ReportPersistedAgentSessionsResult {
  /** Panes a report was actually sent for this call. */
  reported: number;
  /** Panes that already carried `agent_session` — nothing to do, not a failure. */
  alreadyRegistered: number;
  /** Panes with no persisted butchr session id to report (never discovered, or discovery failed). */
  noPersistedId: number;
}

/**
 * FACTORY-714/FACTORY-713/FACTORY-704 (re-aimed) — the actual mechanism fix,
 * replacing the abandoned `RestoreSettleGate` thread-through (see
 * `FACTORY-714-wip`, kept only for mining). The director's RE-AIM found that
 * herdr itself relaunches `claude --resume <id>` for a restored pane whose
 * `agent_session` it already holds, and does so in ~0.1s — far faster than
 * any butchr-side gate or reconcile poll could ever react — so the real
 * defect is not a race to gate, it is that nothing ever told herdr the id in
 * the first place (the Claude `SessionStart` hook integration that would
 * normally do this is not installed). butchr already discovers and persists
 * the id itself (`discoverClaudeSessionId`/`persistDiscoveredSessionId` in
 * `./workspace.ts`, called from `herd.ts`'s `spawn()`), so this closes the
 * gap from the other end: report what butchr already has, once per pane, at
 * daemon startup — for exactly the panes that were already running when this
 * daemon started and never registered an `agent_session` of their own
 * (typically because they predate this fix, or herdr's own SessionStart hook
 * integration is absent/stale on this host).
 *
 * ONE-TIME, STARTUP-ONLY, NOT a reconcile-loop step — unlike the gate it
 * replaces, this needs no recurring presence: `herdr.agent.list()` is read
 * ONCE, and every pane with a persisted id AND no `agent_session` yet gets
 * reported exactly once, right then. A pane that gets its id THIS way keeps
 * it in herdr's own memory for the rest of herdr's process lifetime
 * (confirmed by agentsafety's rehearsal — see FACTORY-704's RE-AIM comment:
 * reported ids survive a herdr restart), so there is nothing to repeat on
 * a later poll — the next time THIS daemon restarts, it runs this sweep
 * again, which is exactly as safe as running it once (same "idempotent
 * startup sweep" discipline `herd.relabelOwnedWorkspaces()` already follows,
 * src/daemon/index.ts).
 *
 * Deliberately NOT gated on `a.agent === "claude"` matching some OTHER
 * already-known kind check beyond that: a persisted butchr session id is
 * only ever written for a Claude launch (`herd.ts`'s own `if
 * (result.account.provider === "claude")` branch), so a non-Claude pane
 * simply never has one and `workspaceSessionId` returns `undefined` for it
 * — the `noPersistedId` branch below already covers that case without a
 * separate check needed.
 *
 * A pane already carrying `agent_session` (herdr already knows, by whatever
 * means) is skipped — reporting again would be harmless but pointless, and
 * counting it as `reported` would make the summary lie about how much work
 * this sweep actually did.
 *
 * A pane still `launch_pending` (FACTORY-491's own discriminator field) is
 * skipped entirely: it is not an already-settled restored pane this sweep
 * exists for, and reporting a session id for a launch that has not finished
 * yet risks reporting a STALE id left over from a previous occupant of the
 * same workspace, before this launch's own discovery (which runs AFTER
 * `invalidatePersistedSessionId`, `herd.ts`'s `spawn()`) has had a chance to
 * correct it — the identical stale-id hazard that function's own doc
 * comment describes, applied here defensively even though this sweep runs
 * once at startup and a mid-launch pane at that exact moment is already an
 * edge case.
 *
 * Per-pane report failures are swallowed and logged as a WARNING, never
 * thrown — same "a report hiccup must never read as something more serious
 * than it is" discipline `reportFullAgentKey` (`herd.ts`) already follows
 * for `workspace.reportMetadata`: one pane's herdr call failing must not
 * abort the sweep for every other pane, and this function has no spawn of
 * its own to fail.
 */
export async function reportPersistedAgentSessions(deps: { herdr: ReportAgentSessionsHerdr; log?: (line: string) => void }): Promise<ReportPersistedAgentSessionsResult> {
  const result: ReportPersistedAgentSessionsResult = { reported: 0, alreadyRegistered: 0, noPersistedId: 0 };
  const { agents } = await deps.herdr.agent.list();
  for (const a of agents) {
    if (a.launch_pending) continue;
    if (a.agent_session) { result.alreadyRegistered++; continue; }
    if (!a.cwd) { result.noPersistedId++; continue; }
    const sessionId = workspaceSessionId(a.cwd);
    if (!sessionId) { result.noPersistedId++; continue; }
    try {
      await deps.herdr.pane.reportAgentSession({
        pane_id: a.pane_id,
        agent: a.agent ?? "claude",
        agent_session_id: sessionId,
        source: AGENT_SESSION_REPORT_SOURCE,
      });
      result.reported++;
    } catch (e) {
      deps.log?.(`WARNING: [agent-session-report] ${a.pane_id} report failed: ${(e as Error)?.message ?? e}`);
    }
  }
  deps.log?.(`[agent-session-report] ${result.reported} reported, ${result.alreadyRegistered} already registered, ${result.noPersistedId} with no persisted id`);
  return result;
}
