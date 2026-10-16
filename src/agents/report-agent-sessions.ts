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

/** Minimal slice of `DrovrClient` a single report needs — real callers pass the real client; tests pass a fake. */
export interface ReportAgentSessionHerdr {
  pane: { reportAgentSession(p: params.PaneReportAgentSessionParams): Promise<unknown> };
}

/** Minimal slice of `DrovrClient` the startup sweep needs (adds `agent.list()` on top of `ReportAgentSessionHerdr`). */
export interface ReportAgentSessionsHerdr extends ReportAgentSessionHerdr {
  agent: { list(): Promise<{ agents: readonly results.AgentInfo[] }> };
}

/**
 * The single `pane.report_agent_session` call both the startup sweep below
 * and `herd.ts`'s `spawn()` make — factored out so a respawn's report (made
 * the moment a NEW id is persisted, closing the staleness PR #678's review
 * found) uses the exact same shape and the exact same swallow-and-log
 * discipline as the sweep, rather than a second hand-maintained copy that
 * could drift from it. No `seq`: established read-only against the
 * installed `herdr-sdk`/`herdr` sources (`hook_report_is_newer` /
 * `accept_hook_report` in herdr's `src/terminal/state.rs`) that for a
 * source nothing has EVER attached a `seq` to, `hook_report_sequences` never
 * gains an entry for that source, so every subsequent report — seq-less,
 * from either call site — is still treated as "newer than the last" and its
 * `session_ref` plainly overwrites the previous one. Supplying `seq` only
 * from this second call site would instead PERMANENTLY lock out every future
 * seq-less report from the other (the sweep never sends one), which is worse
 * than not sending it at all — so neither call site sends one.
 */
export async function reportAgentSession(
  deps: { herdr: ReportAgentSessionHerdr; log?: ((line: string) => void) | undefined },
  paneId: string,
  agent: string,
  sessionId: string,
): Promise<boolean> {
  try {
    await deps.herdr.pane.reportAgentSession({
      pane_id: paneId,
      agent,
      agent_session_id: sessionId,
      source: AGENT_SESSION_REPORT_SOURCE,
    });
    return true;
  } catch (e) {
    deps.log?.(`WARNING: [agent-session-report] ${paneId} report failed: ${(e as Error)?.message ?? e}`);
    return false;
  }
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
 * separate check needed. That is also why the report call's own `a.agent ??
 * "claude"` fallback is safe rather than an unjustified claim about what is
 * running on a pane herdr has not detected an agent on: by the time the
 * loop reaches that call, `workspaceSessionId(a.cwd)` has already returned
 * a value, which — by the same one-sentence-above reasoning — could only
 * have been persisted by a Claude launch. A pane herdr genuinely cannot
 * identify is already excluded upstream (no persisted id to find), so the
 * fallback never actually asserts anything beyond what the persisted-id
 * check already established.
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
 *
 * REVIEW FIX (PR #676, round 1): `deps.herdr.agent.list()` itself is now
 * INSIDE the same try/catch, not just the per-pane `reportAgentSession`
 * call below. This function is called `void`-fire-and-forget at daemon
 * startup (src/daemon/index.ts) specifically BECAUSE it is documented to
 * never throw — the exact moment it runs (daemon startup) is also the
 * exact moment herdr is least likely to be fully ready, so a rejecting
 * `list()` here is not a hypothetical, it is the likely failure mode. Before
 * this fix, that rejection was an unhandled promise rejection with the
 * potential to crash the daemon at startup — the one thing this function's
 * own doc comment above promised would never happen.
 */
export async function reportPersistedAgentSessions(deps: { herdr: ReportAgentSessionsHerdr; log?: (line: string) => void }): Promise<ReportPersistedAgentSessionsResult> {
  const result: ReportPersistedAgentSessionsResult = { reported: 0, alreadyRegistered: 0, noPersistedId: 0 };
  let agents: readonly results.AgentInfo[];
  try {
    agents = (await deps.herdr.agent.list()).agents;
  } catch (e) {
    deps.log?.(`WARNING: [agent-session-report] herdr.agent.list() failed: ${(e as Error)?.message ?? e}`);
    return result;
  }
  for (const a of agents) {
    if (a.launch_pending) continue;
    if (a.agent_session) { result.alreadyRegistered++; continue; }
    if (!a.cwd) { result.noPersistedId++; continue; }
    const sessionId = workspaceSessionId(a.cwd);
    if (!sessionId) { result.noPersistedId++; continue; }
    if (await reportAgentSession(deps, a.pane_id, a.agent ?? "claude", sessionId)) result.reported++;
  }
  deps.log?.(`[agent-session-report] ${result.reported} reported, ${result.alreadyRegistered} already registered, ${result.noPersistedId} with no persisted id`);
  return result;
}
