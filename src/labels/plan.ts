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
 * a daemon-owned label, deliberately — it is READ-ONLY for the DAEMON'S OWN
 * label machinery (this file, and the poll-loop reconciler and
 * `sweepStaleAgentLabels`, src/labels/sweep.ts, that it drives): that
 * machinery only ever READS it (to skip escalating a parked child) and must
 * never add or remove it itself. Do NOT fold it into `isDaemonLabel` below:
 * doing so would make `sweepStaleAgentLabels` treat it as daemon-owned and
 * silently strip a deliberate exemption the moment the ticket left the
 * active statuses. Pinned by a test in test/unit/labels-plan.test.ts.
 *
 * This is narrower than "nobody but a human ever writes it" (BUTCHR-50): the
 * relationship TOOLS — `shelve_worker` sets it, `start_worker`/
 * `finish_worker`/`adopt_worker(..., "start")` clear it — own its lifecycle
 * as an explicit, agent-invoked verb, which is a different actor from the
 * daemon's own unattended poll/sweep machinery this file guards against. A
 * label set by hand (never through those verbs) is cleared by nobody but
 * whoever set it.
 *
 * `butchr:orphan` (src/tools/relationship.ts's `ORPHAN_LABEL`) is likewise
 * NOT daemon-owned, for the same reason and by the same test — not folded
 * into `isDaemonLabel` below, so the sweep never touches it either
 * (BUTCHR-108/BUTCHR-137). `file_where_it_belongs` applies it once, at
 * creation; `adopt_worker` (both the issue-caller and PROJECT-caller paths,
 * both dispositions) is now its withdrawal site — the first one this label
 * has ever had. Same category as `butchr:shelved`: an explicit,
 * agent-invoked relationship verb owns the lifecycle, never this file's own
 * unattended machinery.
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
 * BUTCHR-144/BUTCHR-155: value-level anchor for AgentLabel. TypeScript types
 * are erased at runtime, so the bare `type AgentLabel` above cannot by itself
 * produce a runtime list of its members — this Record is what a runtime
 * consumer (the startup sweep, ./sweep.ts) derives that list from. Extending
 * AgentLabel without adding a matching key here fails to compile ("Property
 * '<newlabel>' is missing"), the same closed-Record door ./registry.ts's
 * LABEL_REGISTRY uses for the same reason (see that file's header, "door
 * 1") — this is a second, INDEPENDENT anchor for a different consumer, not a
 * shared one: ./registry.ts's own header states it must never be imported BY
 * this file, ./sync.ts, or ./sweep.ts, specifically so its role stays pure
 * documentation with zero runtime effect (AC-7).
 *
 * Deliberately no exclusion mechanism: every member of AgentLabel is always
 * selected, because as of BUTCHR-144/BUTCHR-155 all five belong in the
 * sweep's selection and none is known to need excluding. `Record<AgentLabel,
 * true>` makes silent, by-omission exclusion impossible today — an omitted
 * key is a compile error, proven in test/unit/labels-plan.test.ts. If a
 * future member should ever be excluded from the sweep's selection, that
 * exclusion must be a deliberate change to THIS Record's value type (e.g.
 * `true | { excludedBecause: string }`, filtered when building the selection
 * below) — never a silent omission, and never expressible by just leaving a
 * key out, which this type does not allow.
 *
 * WHAT THIS ANCHOR CANNOT SEE, STATED AS BUTCHR-144 POSED IT: what could
 * someone add to this codebase tomorrow that emits an agent:* label the
 * sweep never selects, while this Record stays green (compiles) and
 * test/unit/labels-sweep.test.ts stays green? Answer: A NEW WRITE SITE,
 * OUTSIDE desiredLabels/mapAgentStatus ABOVE, THAT WRITES AN agent:*-PREFIXED
 * LABEL WITHOUT EVER ROUTING THROUGH THE AgentLabel TYPE — e.g. a future
 * module calling the Jira label-update op directly with `AGENT_PREFIX +
 * "paused"` (or the bare literal `"agent:paused"`), never adding `"paused"`
 * to `AgentLabel` at all. This Record enforces completeness of AgentLabel's
 * OWN declared members; it has no way to know about, and cannot require
 * completeness against, a real write site that never touches the type in the
 * first place. `agent:paused` would then be written by that new site,
 * omitted from `ALL_AGENT_LABEL_KEYS` and therefore from SWEEP_JQL, and stay
 * unreached by the sweep forever — while this Record's shape (still five
 * keys, still compiling) and the sweep-derivation test (still checking that
 * SWEEP_JQL matches those five) both report nothing wrong, because neither
 * one is watching for a NEW write site; both watch only whether AgentLabel's
 * EXISTING members are all reached. THIS IS THE SAME SPECIES OF BLIND SPOT
 * ./registry.ts's own header describes for its type-level door (a bare
 * literal or concatenation, declared anywhere, never routed through the
 * governing type, is invisible to a check built only on that type) — applied
 * here to a second, independent anchor for a different consumer. Today,
 * every real agent:* write site in this codebase (this file's
 * `desiredLabels`, the only one) DOES route through `AgentLabel`; nothing
 * automated in this repository — not this Record, not
 * test/unit/labels-sweep.test.ts, and not ./registry.ts's LABEL_REGISTRY,
 * which the exact same concatenation trick already defeats for `agent:*`/
 * `pr:*` per that file's own AC-9(a) — forces a FUTURE write site to keep
 * that discipline. That is left to code review, same as it always was for
 * `butchr:orphan` before BUTCHR-108/BUTCHR-137, per ./registry.ts's header.
 *
 * A second, narrower thing this anchor cannot see: it forces every
 * AgentLabel member to be present as a KEY here — completeness, not
 * correctness of what a caller does with the result. It cannot force a
 * consumer to actually read `ALL_AGENT_LABEL_KEYS` below rather than
 * hand-rolling a list that happens to agree with it today; that SWEEP_JQL in
 * ./sweep.ts is genuinely DERIVED from this array, and not just
 * coincidentally consistent with it, is a separate claim this Record alone
 * cannot prove — it is checked at runtime in test/unit/labels-sweep.test.ts
 * instead, because a bare type/Record cannot compel a caller to use it.
 */
const ALL_AGENT_LABELS: Record<AgentLabel, true> = {
  working: true,
  idle: true,
  blocked: true,
  stalled: true,
  none: true,
};

/**
 * `AGENT_PREFIX`-qualified form of every AgentLabel member, derived from
 * ALL_AGENT_LABELS above — grows automatically, and ONLY by editing that
 * Record, if AgentLabel grows. The startup sweep (./sweep.ts) builds its JQL
 * selection from this array instead of the hand-written list BUTCHR-144
 * found `agent:stalled` missing from.
 */
export const ALL_AGENT_LABEL_KEYS: readonly string[] = (Object.keys(ALL_AGENT_LABELS) as AgentLabel[]).map((label) => AGENT_PREFIX + label);

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
