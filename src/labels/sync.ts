import type { JiraIssue } from "../atlassian/types.js";
import { isActive } from "../reconcile/plan.js";
import { AGENT_PREFIX, canHavePr, desiredLabels, diffLabels, isAgentLabel, isDaemonLabel, mapAgentStatus, type AgentLabel, type PrLookup } from "./plan.js";
import type { StalledCheck } from "../agents/stalled.js";
import type { CoverageRecorder } from "../daemon/coverage.js";

export interface LabelWriter {
  updateLabels(key: string, ops: { add?: readonly string[]; remove?: readonly string[] }): Promise<void>;
}

export interface SyncDeps {
  jira: LabelWriter;
  /** issue key -> raw herdr agent_status, for every currently running butchr agent. */
  agentStatuses: () => Promise<ReadonlyMap<string, string>>;
  /** Per-ticket PR state; omitted (or always resolving null) when pr:* is disabled. */
  prState?: (key: string) => Promise<PrLookup>;
  /** KAN-804/807: the "idle since spawn, never spoke" signal. Omitted disables agent:stalled entirely. */
  stalled?: StalledCheck;
  /**
   * BUTCHR-179: reports `stalled.check`'s three-state result on `/health`
   * (src/daemon/coverage.ts) — `recordChecked` for a resolved `true`/`false`
   * (a completed verification, regardless of its answer), `recordDeclined`
   * for `null` (the comments fetch failed). Optional so every existing
   * caller/fixture is unaffected; when omitted, coverage is simply not
   * reported for this dimension, exactly as before this ticket.
   */
  coverage?: CoverageRecorder;
  /**
   * Called once per poll with the keys this poll wrote daemon-owned labels
   * for (only when non-empty), so the caller can feed the own-write ledger
   * (src/jira-watch/own-writes.ts) with writer "daemon" — generalizes the
   * old isOwnLabelBump swallow into the same mechanism agent writes use.
   */
  onWrite?: (keys: readonly string[]) => void;
  log?: (line: string) => void;
  /**
   * Called once at the end of every syncLabels run, after all issues (and
   * the disappearance cleanup) are processed — the poll boundary PrTracker
   * needs to log-and-reset its per-poll search count (KAN-824). Optional so
   * existing tests/callers that don't supply it are unaffected.
   */
  onPollEnd?: () => void;
}

/** A representative raw agent_status that maps back to `label` via mapAgentStatus. */
const rawFor = (label: AgentLabel): string | null => (label === "none" ? null : label);

const agentLabelOf = (labels: readonly string[]): AgentLabel | undefined => {
  const found = labels.find(isAgentLabel);
  return found ? (found.slice(AGENT_PREFIX.length) as AgentLabel) : undefined;
};

/**
 * herdr's agent_status is not reliable moment-to-moment (observed flapping
 * working/blocked/working within seconds). A candidate change is only
 * applied once the SAME new value has been observed on two consecutive
 * polls; a flip that reverts before that is suppressed — zero Jira writes,
 * one [labels] log line. The ticket's OWN current agent:* label (read fresh
 * from Jira each poll) is the source of truth for "currently applied", so
 * this only needs to track the in-flight candidate, not the applied value.
 */
class AgentLabelStabilizer {
  private readonly pending = new Map<string, { value: AgentLabel; count: number }>();

  /** The label to actually use this poll, plus whether a flip was suppressed. */
  resolve(key: string, applied: AgentLabel | undefined, observed: AgentLabel): { label: AgentLabel; suppressed: boolean } {
    if (applied === observed) {
      this.pending.delete(key);
      return { label: observed, suppressed: false };
    }
    const p = this.pending.get(key);
    const count = p && p.value === observed ? p.count + 1 : 1;
    if (count >= 2 || applied === undefined) {
      this.pending.delete(key);
      return { label: observed, suppressed: false };
    }
    this.pending.set(key, { value: observed, count });
    return { label: applied, suppressed: true };
  }

  clear(key: string): void {
    this.pending.delete(key);
  }
}

/**
 * Builds the level-style label reconciler: given this poll's issues, computes
 * each one's desired daemon-owned label set and writes only the diff — at
 * most one Jira request per issue, none when nothing changed.
 *
 * `search()` (the daemon's only source of issues) is scoped to active
 * statuses, so a ticket that leaves the active set simply stops appearing —
 * there is no "it changed to Done" event to react to. This reconciler tracks
 * the last label set it wrote for each ticket it has seen, so that on the
 * poll where a ticket disappears it can still issue the agent:* removal
 * (pr:* is untouched — it isn't tied to active status).
 */
export function createLabelSync(deps: SyncDeps) {
  const lastLabels = new Map<string, string[]>();
  const stabilizer = new AgentLabelStabilizer();
  // Last failure reason logged per key, so a PERMANENT condition (e.g. a
  // write that keeps 403ing) logs once instead of once per 15s poll; a
  // failure whose reason actually changes still gets its own line.
  const loggedFailure = new Map<string, string>();

  // Isolated per issue: syncLabels runs inside startLoop's snapshot function,
  // so an uncaught throw here would abort the WHOLE poll — no snapshot, no
  // change detection, no nudges for any ticket — every 15s until whatever
  // Jira rejected about this one write is fixed. A failed write must also
  // never be recorded in lastLabels, since Jira's actual state didn't change.
  const write = async (written: Set<string>, key: string, current: readonly string[], desired: readonly string[]): Promise<boolean> => {
    const diff = diffLabels(desired, current);
    if (!diff.add.length && !diff.remove.length) return true;
    try {
      await deps.jira.updateLabels(key, diff);
      loggedFailure.delete(key);
    } catch (e) {
      const reason = (e as Error)?.message ?? String(e);
      if (loggedFailure.get(key) !== reason) {
        loggedFailure.set(key, reason);
        deps.log?.(`[labels] ${key} write failed: ${reason}`);
      }
      return false;
    }
    written.add(key);
    const parts = [...diff.add.map((l) => `+${l}`), ...diff.remove.map((l) => `-${l}`)];
    deps.log?.(`[labels] ${key} ${parts.join(" ")}`);
    return true;
  };

  return async function syncLabels(issues: readonly JiraIssue[]): Promise<ReadonlySet<string>> {
    const written = new Set<string>();
    const seen = new Set(issues.map((i) => i.key));
    const agents = await deps.agentStatuses();

    for (const issue of issues) {
      let agentStatus: string | null;
      let stalled = false;
      if (!isActive(issue.status)) {
        stabilizer.clear(issue.key);
        deps.stalled?.forget(issue.key);
        agentStatus = null;
      } else {
        const observed = mapAgentStatus(agents.get(issue.key) ?? null);
        // Always observed (even when not idle), so the tracker's "since
        // spawn, continuously idle" streak sees every poll, not just the
        // ones where the result might matter.
        const stalledResult = deps.stalled ? await deps.stalled.check(issue.key, observed) : false;
        // BUTCHR-179: report coverage only when a check was actually
        // attempted (deps.stalled configured) — `stalledResult === false`
        // from the ternary's OTHER branch (the detector disabled entirely)
        // must never count as "checked", or /health would claim coverage
        // for a dimension that never runs on this deployment. A definitive
        // true/false answer (whether or not stalled.ts's own cheap
        // precondition even attempted a fetch) still counts as "checked":
        // sync.ts's question is "did this poll produce a trustworthy
        // answer", not "did it cost an HTTP call".
        if (deps.stalled) {
          if (stalledResult === null) deps.coverage?.recordDeclined("stalled");
          else deps.coverage?.recordChecked("stalled");
        }
        const stalledNow = stalledResult === true;
        // Logged unconditionally, every poll it holds — unlike the LABEL
        // below, which is deliberately delayed by the stabilizer so a single
        // flickering poll never writes Jira. An operator watching the log
        // should see this the instant it's true, not two polls later.
        if (stalledNow) deps.log?.(`[labels] ${issue.key} stalled: idle/done continuously since first observed, zero comments from this account for the configured window`);
        const applied = agentLabelOf(issue.labels);
        // `null` means the comments fetch failed — "could not verify", a
        // THIRD outcome that must never be treated as "confirmed stalled"
        // (the defect this ticket removes) NOR as "confirmed not stalled".
        // The latter is its own trap: naively falling through to `observed`
        // (always "idle" here — `check` only fetches comments once the
        // idle/done streak already qualifies) makes THIS dimension's
        // candidate "idle" regardless of what's actually applied, so on a
        // ticket that already carries `agent:stalled`, two consecutive
        // could-not-verify polls "confirm" a flip to idle through the SAME
        // stabilizer any real transition uses — silently erasing a true
        // stalled signal. The candidate on a `null` poll is `applied`
        // itself instead: fed through the stabilizer unchanged, it resolves
        // as "no candidate change", so this dimension is left exactly as it
        // was applied, whatever that value is. Only the TRACKER's internal
        // streak bookkeeping (`StalledTracker.observe`, which already ran
        // inside `deps.stalled.check` before the fetch was attempted) is
        // guaranteed delay-not-lose; this is what makes the LABEL itself
        // delay-not-lose too, by construction rather than by accident.
        if (stalledResult === null) deps.log?.(`WARNING: [labels] ${issue.key} stalled check could not verify (comments fetch failed) — leaving agent:${applied ?? "none"} as applied this poll`);
        const candidate: AgentLabel = stalledResult === null ? (applied ?? observed) : (observed === "idle" && stalledNow ? "stalled" : observed);
        const { label, suppressed } = stabilizer.resolve(issue.key, applied, candidate);
        if (suppressed) deps.log?.(`[labels] ${issue.key} agent:${candidate} unconfirmed (holding agent:${applied}) — flip suppressed`);
        stalled = label === "stalled";
        agentStatus = stalled ? "idle" : rawFor(label);
      }
      // KAN-824: epics never have a branch, so a search for one can only ever
      // miss — skip the call entirely rather than let it burn a GitHub search.
      const prState = deps.prState && canHavePr(issue.issuetype) ? await deps.prState(issue.key) : null;
      const desired = desiredLabels({ status: issue.status, agentStatus, prState, stalled, currentLabels: issue.labels });
      const ok = await write(written, issue.key, issue.labels, desired);
      if (ok) lastLabels.set(issue.key, [...issue.labels.filter((l) => !isDaemonLabel(l)), ...desired]);
    }

    for (const key of [...lastLabels.keys()]) {
      if (seen.has(key)) continue;
      stabilizer.clear(key);
      deps.stalled?.forget(key);
      const current = lastLabels.get(key)!;
      const desired = current.filter((l) => !l.startsWith(AGENT_PREFIX));
      const ok = await write(written, key, current, desired);
      if (ok) lastLabels.delete(key);
    }

    if (written.size) deps.onWrite?.([...written]);
    deps.onPollEnd?.();
    return written;
  };
}
