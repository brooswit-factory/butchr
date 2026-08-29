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

export type PrState = "open" | "approved" | "merged" | null;

export interface DesiredInput {
  /** The ticket's Jira status. */
  status: string;
  /** Raw herdr agent_status for the issue's agent, or null if none is running. */
  agentStatus: string | null;
  /** Discovered PR state for the ticket, or null when no PR is known/tracked. */
  prState: PrState;
}

export type AgentLabel = "working" | "idle" | "blocked" | "none";

/** idle/blocked map directly; any other non-empty status (working/done/unknown/…) is "working". */
export const mapAgentStatus = (raw: string | null): AgentLabel => {
  if (raw === "idle") return "idle";
  if (raw === "blocked") return "blocked";
  if (raw == null) return "none";
  return "working";
};

/** The desired daemon-owned label set for a ticket, given its current known state. Pure. */
export function desiredLabels({ status, agentStatus, prState }: DesiredInput): string[] {
  const out: string[] = [];
  if (isActive(status)) out.push(AGENT_PREFIX + mapAgentStatus(agentStatus));
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
