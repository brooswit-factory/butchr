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
export const isDaemonLabel = (label: string): boolean => isAgentLabel(label) || isPrLabel(label);

export type PrState = "open" | "approved" | "changes-requested" | "merged" | null;

export interface DesiredInput {
  /** The ticket's Jira status. */
  status: string;
  /** Raw herdr agent_status for the issue's agent, or null if none is running. */
  agentStatus: string | null;
  /** Discovered PR state for the ticket, or null when no PR is known/tracked. */
  prState: PrState;
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
export function desiredLabels({ status, agentStatus, prState, stalled }: DesiredInput): string[] {
  const out: string[] = [];
  if (isActive(status)) {
    const label = mapAgentStatus(agentStatus);
    out.push(AGENT_PREFIX + (label === "idle" && stalled ? "stalled" : label));
  }
  if (prState) out.push(PR_PREFIX + prState);
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
