import { AGENT_PREFIX, PR_PREFIX, type AgentLabel, type PrState } from "./plan.js";
import { ORPHAN_LABEL, MISSING_IMPLEMENTS_LABEL } from "../tools/relationship.js";

interface LabelRegistryEntryCommon {
  /** Prose: what writes this label, and when. Not enforced by the type — for humans and for the Confluence doc, not for the check. */
  readonly appliedBy: string;
  /** Prose: the shape, ordering, and load-bearing properties a reader needs before touching this label's lifecycle again. */
  readonly notes: string;
}

export type LabelRegistryEntry =
  | (LabelRegistryEntryCommon & {
      /** Non-empty prose naming the verb(s) or mechanism that withdraws this label. */
      readonly withdrawnBy: string;
    })
  | (LabelRegistryEntryCommon & {
      readonly withdrawnBy: null;
      /** Required, non-empty prose: WHY this label is deliberately, permanently never withdrawn. Not optional, not a boolean — a human sentence. */
      readonly neverWithdrawnReason: string;
    });

/** `agent:working` | `agent:idle` | `agent:blocked` | `agent:stalled` | `agent:none` — grows automatically if `AgentLabel` grows. */
type AgentLabelKey = `${typeof AGENT_PREFIX}${AgentLabel}`;
/** `pr:open` | `pr:approved` | `pr:changes-requested` | `pr:merged` — grows automatically if `PrState` grows. */
type PrLabelKey = `${typeof PR_PREFIX}${NonNullable<PrState>}`;
/** The verb-owned labels that live outside the daemon's own prefix machinery — see `./plan.ts`'s `isDaemonLabel` comment for why they're a separate category. */
type VerbLabelKey = typeof ORPHAN_LABEL | typeof MISSING_IMPLEMENTS_LABEL;

/** Every label string this registry declares. The type-level door: this is a CLOSED union, not `string` — see this file's header. */
export type RegisteredLabel = AgentLabelKey | PrLabelKey | VerbLabelKey;

const AGENT_LABEL_LIFECYCLE_NOTES =
  "One of exactly five mutually exclusive agent:* values (mapAgentStatus / desiredLabels in ./plan.ts) computed fresh every ~15s poll for a ticket whose status isActive(). Flapping is damped by AgentLabelStabilizer in ./sync.ts (a candidate value must be observed on two consecutive polls before it's written), but that only delays which value gets applied — it never changes who applies or withdraws it. Former hole, live example for AC-9(b) (BUTCHR-144, outside this epic — AC-7 forbade fixing it here): SWEEP_JQL in ./sweep.ts's startup sweep once omitted agent:stalled from its hand-written `labels IN (...)` list, so a ticket carrying agent:stalled when it went inactive was not picked up by that particular sweep. BUTCHR-155 closed it by deriving SWEEP_JQL from AgentLabel itself (./plan.ts's ALL_AGENT_LABEL_KEYS) rather than adding one more string to the list. This entry's withdrawnBy was, and remains, correct throughout — the poll-loop diff below IS a real withdrawal path — the AC-9(b) point this instance illustrates is that a registry entry only ever records that a path exists, never that every caller on it is hole-free; see this file's header, AC-9(b).";

const AGENT_LABEL_WITHDRAWN_BY =
  "src/labels/sync.ts's syncLabels, via diffLabels in ./plan.ts — every poll, diffLabels removes any agent:* label the ticket currently carries that is not this poll's desired value; desiredLabels emits NO agent:* label once isActive(status) is false, so leaving the active status set removes it. syncLabels ALSO runs an explicit disappearance-cleanup pass (the `for (const key of [...lastLabels.keys()])` loop) for the poll where a ticket stops being returned by search() entirely, so the removal fires even without one more poll that still sees the ticket.";

const PR_LABEL_WITHDRAWN_BY =
  "src/labels/sync.ts's syncLabels, via diffLabels in ./plan.ts — removed only when desiredLabels computes NO pr:* entry, which happens on a genuine (non-\"unknown\") null prState result: PrTracker.stateFor confirmed there is no PR. Deliberately NOT removed just because a poll could not look — prState \"unknown\" re-emits whatever pr:* label the ticket already carries instead of reading a blind interval as absence (KAN-832/837), and the next successful search or pull fetch is what actually resolves it, in either direction. Deliberately NOT removed when the ticket leaves the active status set either — pr:* is independent of status (unlike agent:*, sync.ts's disappearance-cleanup filters ONLY agent:*-prefixed labels out of a departed ticket's carried-forward set) and is NOT covered by the startup sweep (src/labels/sweep.ts says why in its own comment).";

/**
 * THE REGISTRY. Every label butchr writes under agent:, pr:, or butchr: —
 * verified against the code that actually writes/removes each one, not
 * copied from any ticket's inventory. See this file's header for the rule,
 * why it exists, and what it does and does not cover.
 */
export const LABEL_REGISTRY: Readonly<Record<RegisteredLabel, LabelRegistryEntry>> = {
  "agent:working": {
    appliedBy: "src/labels/sync.ts's syncLabels, via desiredLabels/diffLabels in ./plan.ts — mapAgentStatus's conservative default for a running agent whose herdr status isn't specifically known to be idle/blocked (an unrecognised or future status also lands here).",
    notes: AGENT_LABEL_LIFECYCLE_NOTES,
    withdrawnBy: AGENT_LABEL_WITHDRAWN_BY,
  },
  "agent:idle": {
    appliedBy: "src/labels/sync.ts's syncLabels — mapAgentStatus maps herdr's \"idle\" AND \"done\" (an agent sitting at its prompt after finishing a turn) both to idle; stalled (below) takes precedence over this value once the stall window elapses.",
    notes: AGENT_LABEL_LIFECYCLE_NOTES,
    withdrawnBy: AGENT_LABEL_WITHDRAWN_BY,
  },
  "agent:blocked": {
    appliedBy: "src/labels/sync.ts's syncLabels — mapAgentStatus maps herdr's \"blocked\" status directly.",
    notes: AGENT_LABEL_LIFECYCLE_NOTES,
    withdrawnBy: AGENT_LABEL_WITHDRAWN_BY,
  },
  "agent:stalled": {
    appliedBy: "src/labels/sync.ts's syncLabels — an overlay on top of an \"idle\" mapping (see src/agents/stalled.ts's StalledCheck): idle/done continuously since the agent last stopped working, with no non-daemon-chatter comment (BUTCHR-289: kind×recency, not authorship) landing during that streak, for the configured stall window. Never mapAgentStatus's own direct output (see ./plan.ts's ObservedAgentLabel exclusion) — always layered on top of idle.",
    notes: AGENT_LABEL_LIFECYCLE_NOTES,
    withdrawnBy: AGENT_LABEL_WITHDRAWN_BY,
  },
  "agent:none": {
    appliedBy: "src/labels/sync.ts's syncLabels — mapAgentStatus's value when no butchr agent is currently running for an active ticket (raw herdr status is null).",
    notes: AGENT_LABEL_LIFECYCLE_NOTES,
    withdrawnBy: AGENT_LABEL_WITHDRAWN_BY,
  },
  "pr:open": {
    appliedBy: "src/labels/sync.ts's syncLabels, via desiredLabels/diffLabels in ./plan.ts — PrTracker.stateFor (src/labels/pr.ts) resolved this ticket's tracked PR to \"open\".",
    notes: "One of four mutually exclusive pr:* values, or absent — see PrState in ./plan.ts. Skipped entirely for issue types that structurally never have a branch (canHavePr — currently just Epic), so this never gets written for one.",
    withdrawnBy: PR_LABEL_WITHDRAWN_BY,
  },
  "pr:approved": {
    appliedBy: "src/labels/sync.ts's syncLabels — PrTracker.stateFor resolved \"approved\".",
    notes: "One of four mutually exclusive pr:* values, or absent — see PrState in ./plan.ts. Skipped entirely for issue types that structurally never have a branch (canHavePr — currently just Epic).",
    withdrawnBy: PR_LABEL_WITHDRAWN_BY,
  },
  "pr:changes-requested": {
    appliedBy: "src/labels/sync.ts's syncLabels — PrTracker.stateFor resolved \"changes-requested\" (KAN-819/823: emitted like any other pr state, no special-casing).",
    notes: "One of four mutually exclusive pr:* values, or absent — see PrState in ./plan.ts. Skipped entirely for issue types that structurally never have a branch (canHavePr — currently just Epic).",
    withdrawnBy: PR_LABEL_WITHDRAWN_BY,
  },
  "pr:merged": {
    appliedBy: "src/labels/sync.ts's syncLabels — PrTracker.stateFor resolved \"merged\".",
    notes: "One of four mutually exclusive pr:* values, or absent — see PrState in ./plan.ts. Skipped entirely for issue types that structurally never have a branch (canHavePr — currently just Epic).",
    withdrawnBy: PR_LABEL_WITHDRAWN_BY,
  },

  [ORPHAN_LABEL]: {
    appliedBy:
      "file_where_it_belongs (fileWhereItBelongs in src/tools/relationship.ts) — applied exactly once, in the same call that creates the ticket, together with its destination header. There is no verb that adds this label to an already-existing ticket.",
    notes:
      "Verb-owned: file_where_it_belongs marks undirected work; adopt_worker withdraws that state. The daemon poll/sweep machinery does not own this label.",
    withdrawnBy:
      "adopt_worker (adoptWorker and adoptProjectWorker) clears the orphan label whenever present, including idempotent re-adoptions. The project path is defence-in-depth because file_where_it_belongs only creates Stories or Tasks.",
  },
  [MISSING_IMPLEMENTS_LABEL]: {
    appliedBy:
      "FACTORY-909: assertOwnWorker's maybeWarnMissingImplements (src/tools/relationship.ts) — fired whenever resolveBoss (src/tools/docs.ts) finds a native Jira parent with NO Implements link from the child, and that parent's issue type is not one isEligibleParentTier recognises as an equivalent boss relationship (the (B) fallback for when (A)'s parent-as-boss resolution cannot apply). Applied together with one idempotent comment on the child naming the parent and the exact jira_link_issues call to add, and a `[relationship] missing Implements link child=<k> parent=<p>` log line.",
    notes:
      "Deliberately NOT daemon-owned — same category as ORPHAN_LABEL above, an explicit relationship-verb call site, not the daemon's poll/sweep machinery. Gates the comment's idempotence too: maybeWarnMissingImplements checks for this label on the SAME `issue` fetch assertOwnWorker already made before posting a second comment, so a ticket that keeps triggering this path (repeated start_worker/tell_worker/etc. calls from the would-be boss) gets exactly one comment, not one per call.",
    withdrawnBy: null,
    neverWithdrawnReason:
      "Nothing in this codebase detects \"the missing Implements link was since added\" — there is no poll, sweep, or verb that re-checks a ticket already carrying this label and notices the fix landed. A human adding the link (or re-filing under an eligible parent tier) resolves the underlying relationship; the stale label itself is inert afterward — nothing reads it to gate behaviour, unlike ORPHAN_LABEL above, so leaving it is harmless noise rather than a cached assertion that could mislead a later reader.",
  },
};

/** Every label string declared in LABEL_REGISTRY, for the source scanner (./label-scan.ts) to check literals against. */
export const REGISTERED_LABELS: ReadonlySet<string> = new Set(Object.keys(LABEL_REGISTRY));
