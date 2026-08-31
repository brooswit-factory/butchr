import { isActive } from "../reconcile/plan.js";

/**
 * Namespaced, daemon-owned labels: butchr adds/removes ONLY labels under
 * these prefixes. Every other label (human labels) is preserved untouched —
 * this file is the one place the "never touch human labels" rule lives.
 */
export const AGENT_PREFIX = "agent:";
export const PR_PREFIX = "pr:";

export const isAgentLabel = (label: string): boolean => label.startsWith(AGENT_PREFIX);
export const isPrLabel = (label: string): boolean => label.startsWith(PR_PREFIX);

/**
 * BUTCHR-24: `butchr:shelved` (src/agents/parked.ts's `EXEMPT_LABEL`) is NOT
 * a daemon-owned label, deliberately — it is READ-ONLY for the daemon. ANY
 * actor may SET it on a ticket to declare a parked child deliberately
 * shelved — a human today, and possibly an automated shelving tool in
 * future (BUTCHR-25) — but the daemon only ever READS it (to skip escalating
 * that child) and must never add or remove it itself. Do NOT fold it into
 * `isDaemonLabel` below: doing so would make `sweepStaleAgentLabels`
 * (src/labels/sweep.ts) treat it as daemon-owned and silently strip a
 * deliberate exemption the moment the ticket left the active statuses.
 * Pinned by a test in test/unit/labels-plan.test.ts.
 */
export const isDaemonLabel = (label: string): boolean => isAgentLabel(label) || isPrLabel(label);

export type PrState = "open" | "approved" | "changes-requested" | "merged" | null;

/**
 * `PrState` plus "could not look": PrTracker.stateFor returns this instead of
 * PrState so a non-OK GitHub response or a throttle/backoff window is never
 * conflated with "we searched and there is definitely no PR" (KAN-832/837).
 * Deliberately kept as a SIBLING type, not a member of PrState — every member
 * of PrState is, by construction, a label butchr is willing to write
 * (`desiredLabels` does `PR_PREFIX + prState`, a direct concat), and admitting
 * "unknown" there would make `pr:unknown` representable and type-checking.
 * PrLookup keeps that illegal state unrepresentable.
 */
export type PrLookup = PrState | "unknown";

/**
 * Whether a ticket of this Jira issue type could ever have a PR — used to
 * skip GitHub search discovery entirely for types that structurally never
 * do. Epics in this fleet never have a branch of their own (their stories do
 * the work), so a search for one can only ever miss — pure waste against
 * GitHub's 30/min search budget (KAN-824). Case-insensitive; an unrecognised
 * or empty issuetype is treated as "yes" (conservative: keeps today's
 * behaviour rather than risk skipping a type that does get PRs).
 */
export const canHavePr = (issuetype: string): boolean => issuetype.toLowerCase() !== "epic";

export interface DesiredInput {
  /** The ticket's Jira status. */
  status: string;
  /** Raw herdr agent_status for the issue's agent, or null if none is running. */
  agentStatus: string | null;
  /** Discovered PR state for the ticket: null when no PR is known/tracked, "unknown" when we could not look this poll. */
  prState: PrLookup;
  /** The ticket's current full label set, used to preserve an existing pr:* label when prState is "unknown". Only pr:* is ever read from it. */
  currentLabels?: readonly string[];
  /**
   * True when this ticket's agent has been idle/done continuously since it
   * was first observed running, with zero comments from the daemon's own
   * account, for at least the configured stall window (see
   * src/agents/stalled.ts). Only meaningful when the mapped agent label would
   * otherwise be "idle" — stalled takes precedence over idle so a swallowed
   * kickoff can never look like a completed agent (KAN-804/807).
   */
  stalled?: boolean;
}

export type AgentLabel = "working" | "idle" | "blocked" | "stalled" | "none";

/** What a raw herdr status ever maps to — "stalled" is a separate overlay (see src/agents/stalled.ts), never mapAgentStatus's own output. */
export type ObservedAgentLabel = Exclude<AgentLabel, "stalled">;

/**
 * idle and blocked map directly. "done" — herdr's status for an agent sitting
 * at its prompt after finishing a turn (confirmed against a live `herdr agent
 * list`: several done agents doing nothing) — is idle in every sense this
 * board cares about, so it maps to idle too; labelling it "working" would be
 * the exact lie this feature exists to prevent. Any other non-empty status
 * (unknown, or a future herdr value) is "working" — the conservative default
 * when the agent is running but its state isn't one we specifically know is
 * idle-shaped.
 */
export const mapAgentStatus = (raw: string | null): ObservedAgentLabel => {
  if (raw === "idle" || raw === "done") return "idle";
  if (raw === "blocked") return "blocked";
  if (raw == null) return "none";
  return "working";
};

/** The desired daemon-owned label set for a ticket, given its current known state. Pure. */
export function desiredLabels({ status, agentStatus, prState, stalled, currentLabels }: DesiredInput): string[] {
  const out: string[] = [];
  if (isActive(status)) {
    const label = mapAgentStatus(agentStatus);
    out.push(AGENT_PREFIX + (label === "idle" && stalled ? "stalled" : label));
  }
  if (prState === "unknown") {
    // KAN-832/837: re-emit whatever pr:* label is already on the ticket instead of
    // emitting nothing, so a poll where we could not look never reads as "no PR" and
    // strips a real pr:approved/pr:merged label out from under the ticket.
    //
    // This is NOT a reintroduction of KAN-814's stickiness. KAN-814's bug was a pr:*
    // label treated as a fact the daemon could re-assert from its OWN prior output —
    // the label was evidence for itself, so a wrong state latched with no way back;
    // that's why pr.ts still re-verifies against GitHub on every cold cache rather than
    // trusting a ticket's current pr:merged label as sticky. What happens here is
    // different, and the test is falsifiability, not how long the label survives:
    //   - Sticky: the label persists BECAUSE it is the label — a successful
    //     contradicting observation does not dislodge it.
    //   - Unknown: the label persists across an interval where the daemon made NO
    //     observation at all, and the very next successful search or pull fetch
    //     overwrites it in either direction, including to nothing (the genuine-absence
    //     branches in PrTracker.stateFor still return null and still strip it).
    // The blind interval is bounded and self-terminating (PrTracker's tracker-wide
    // throttle and per-key backoff both expire on their own), and nothing about an
    // "unknown" result extends or renews that window. Concretely: under stickiness a
    // pr:merged label on a never-merged PR would survive a successful contradicting
    // search; under this rule it does not — a successful search is exactly what ENDS
    // the unknown state. A future change that lets "unknown" persist itself, or that
    // stops re-verifying on the next successful look, reintroduces KAN-814.
    const existing = currentLabels?.find(isPrLabel);
    if (existing) out.push(existing);
  } else if (prState) {
    out.push(PR_PREFIX + prState);
  }
  return out;
}

export interface LabelDiff {
  add: string[];
  remove: string[];
}

/**
 * Diff the desired daemon-owned labels against the ticket's CURRENT full label
 * set. Only daemon-prefixed labels are ever added or removed — non-daemon
 * (human) labels never appear in the result, even if one accidentally ends up
 * in `desired` (both sides are filtered here, in the one place this rule
 * lives, rather than trusted to every caller). Idempotent: an already-correct
 * label set diffs to `{ add: [], remove: [] }`.
 */
export function diffLabels(desired: readonly string[], current: readonly string[]): LabelDiff {
  const desiredDaemon = desired.filter(isDaemonLabel);
  const currentDaemon = current.filter(isDaemonLabel);
  const desiredSet = new Set(desiredDaemon);
  const currentSet = new Set(currentDaemon);
  return {
    add: desiredDaemon.filter((label) => !currentSet.has(label)),
    remove: currentDaemon.filter((label) => !desiredSet.has(label)),
  };
}
