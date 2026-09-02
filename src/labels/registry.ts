import { AGENT_PREFIX, PR_PREFIX, type AgentLabel, type PrState } from "./plan.js";
import { EXEMPT_LABEL } from "../agents/parked.js";
import { ORPHAN_LABEL } from "../tools/relationship.js";

/**
 * BUTCHR-133/BUTCHR-143: the one place every label butchr writes under its
 * own namespaces (`agent:`, `pr:`, `butchr:`) is declared, together with WHO
 * withdraws it.
 *
 * THE RULE: *a label is a cached assertion ABOUT state and can silently
 * disagree with it, whereas the link IS the state* (BUTCHR-131). Every bug in
 * this family has been a cached assertion that stopped matching reality —
 * `butchr:shelved` had four withdrawal sites and its ordering argued in
 * comments; `butchr:orphan` (BUTCHR-108/BUTCHR-137) had one write site and
 * zero withdrawal sites, in the same codebase, right next to the label that
 * got it right. Nothing noticed the asymmetry until a human went looking. So
 * the rule is not "every label must be withdrawn" — some legitimately never
 * are — it is that the withdrawal owner must be WRITTEN DOWN, and "nobody,
 * deliberately, because X" is a valid declaration only when a human wrote the
 * X. A declaration that can be made silently, or by default, is the bug.
 *
 * LABELS ARE ONE MEDIUM OF THIS BUG, NOT THE WHOLE CLASS (AC-8). The real
 * target is any CACHED ASSERTION ABOUT STATE that can drift out of sync with
 * the thing it asserts. BUTCHR-131 found three other instances of the
 * identical shape in this same codebase: (1) a ticket description header —
 * BUTCHR-114's `[ORPHAN] … nobody owns it` prose, which adoption made false
 * and which had to be repaired by hand with `correct_worker`, because prose
 * has no withdrawal path a machine can check; (2) a Confluence doc's
 * `[unwritten]` title marker — a SECOND POSITIVE EXAMPLE alongside
 * `butchr:shelved` of a working withdrawal path, in a different medium:
 * `set_doc` structurally refuses to write real content while the marker is
 * still there, forcing a real retitle; (3) an agent's `brief.md` on disk,
 * which a ticket correction does not rewrite (a running agent must be told by
 * hand via `tell_worker`). This module — and the scanner in `./label-scan.js`
 * it feeds — covers exactly ONE of those four media: Jira labels written
 * under butchr's own namespaces. It does not cover description headers, doc
 * titles, or briefs on disk, and does not pretend to; a rule that silently
 * covers less than its own class would be a smaller version of the very bug
 * it exists to catch (BUTCHR-131). Widening the check to the other three
 * media was considered and deliberately declined (BUTCHR-84's precedent
 * against a check becoming a home for every detector gap anyone finds) — this
 * file states the boundary instead of leaving it to be discovered the way
 * `butchr:orphan` was.
 *
 * BUTCHR-172/BUTCHR-154: `../media/registry.ts` is the INDEX of all four
 * media (this one included) and the grading of how strongly each one's
 * records are made safe — it is NOT a shared abstraction over this file,
 * `../headers/registry.ts`, and `../workspace/registry.ts` (unifying the
 * three was considered and declined there, on grounds directly continuing
 * this file's own "declined widening" paragraph above). `../media/
 * family-scan.ts` is the machine check for one source-visible shape of
 * "a withdrawal path exists but its selection does not reach every member
 * of its family" — see that file's own header, and its cross-reference in
 * `./label-scan.ts`, for what it does and does not prove.
 *
 * TWO DOORS, BECAUSE THEY FAIL ON DIFFERENT MISTAKES — AND NEITHER PROVES
 * WHAT IT LOOKS LIKE IT PROVES (AC-9; read this before trusting either):
 *   1. THE TYPE-LEVEL DOOR (this file). `RegisteredLabel` below is a CLOSED
 *      union built from `AgentLabel`, `PrState`, and the verb-owned label
 *      constants — not a free-form `string`. `LABEL_REGISTRY` is typed
 *      `Record<RegisteredLabel, LabelRegistryEntry>`, so it must have EXACTLY
 *      one entry per member of that union: extend `AgentLabel` or `PrState`
 *      in `./plan.ts` and `LABEL_REGISTRY` below fails to compile
 *      ("Property '<newlabel>' is missing") until an entry is added, and
 *      every entry is `LabelRegistryEntry`, which makes `withdrawnBy`
 *      required (see below). This is cheap and fails at the developer's
 *      desk, but it ONLY sees labels that go through this file's own union —
 *      a bare `const FOO = "butchr:foo"` declared anywhere else, never
 *      referenced here, compiles just fine. That is exactly how
 *      `butchr:orphan` came to exist outside the file that claims to own
 *      label policy. THIS is deliberately the PRIMARY door for the agent:*
 *      and pr:* families (see AC-9(a) below for why the other door can't be).
 *   2. THE SOURCE-SCANNING DOOR (`./label-scan.ts` + `test/unit/labels-
 *      registry.test.ts`). It reads every `.ts` file under `src/` for
 *      butchr-namespaced string literals and asserts each one is a key in
 *      `LABEL_REGISTRY`, closing exactly the bypass door 1 cannot see: a bare
 *      literal never routed through this file at all. See that file's own
 *      header for the parsing mechanics and false-positive traps.
 *
 * AC-9(a) — THE SCANNER SEES THE agent:/pr: FAMILIES ONLY CIRCULARLY: AS
 * THIS REGISTRY'S OWN KEYS, NEVER AT AN EMISSION SITE. Every one of the nine
 * daemon-owned values below (`agent:working` through `agent:none`, `pr:open`
 * through `pr:merged`) IS literal text in `src` today — right here, as a
 * string key of `LABEL_REGISTRY`. But that is the registry agreeing with
 * itself. The place each value is actually EMITTED is `AGENT_PREFIX`
 * concatenated with a suffix in `./sync.ts` for `agent:*`, and
 * `PR_PREFIX + prState` for `pr:*` — a direct concatenation at both sites,
 * which a literal scanner cannot parse as a label and never claims to. Before
 * BUTCHR-155, the only four `agent:*` literals that existed anywhere else in
 * `src` sat on one line, inside `./sweep.ts`'s hand-written `SWEEP_JQL`
 * string, which the scanner correctly read as one JQL string rather than
 * four label literals (see ./label-scan.ts) — filtering JQL correctly was
 * the very act that blinded the scan to them there. BUTCHR-155 replaced that
 * hand-written string with one built from `./plan.ts`'s
 * `ALL_AGENT_LABEL_KEYS` (itself `AGENT_PREFIX` concatenated with each
 * `AgentLabel` member), removing even that incidental sighting — it changed
 * nothing about where the family's real emission sites are, and they remain
 * exactly as invisible to the scanner as before.
 *
 * SO A CLEAN OR COMPLETE-LOOKING SCAN OF THESE NINE VALUES PROVES NOTHING
 * ABOUT COVERAGE — READ THE MECHANISM, NOT A COUNT, AND THE TWO DOORS BELOW
 * ARE NOT THE SAME CLAIM:
 *   - THE REGISTRY (this file) IS THE PRIMARY MECHANISM. Its coverage is
 *     every label declared in `LABEL_REGISTRY` — all eleven, because all
 *     eleven are declared, enforced by door 1 (the type-level union), never
 *     by the scanner. `RegisteredLabel` below is DERIVED from `AgentLabel`
 *     and `PrState` themselves (see `AgentLabelKey`/`PrLabelKey`), so
 *     extending either family forces a matching registry entry at compile
 *     time regardless of whether the resulting label is ever written as a
 *     literal anywhere.
 *   - THE SCANNER (`./label-scan.ts`) IS A SECONDARY NET against one
 *     specific bypass — a bare literal declared outside this registry
 *     entirely. For the two verb-owned `butchr:*` constants (`EXEMPT_LABEL`,
 *     `ORPHAN_LABEL`), that check is real: the scanner finds them at their
 *     own genuine declaration sites, in `../agents/parked.ts` and
 *     `../tools/relationship.ts` respectively, independent of this file. For
 *     the nine agent:/pr: values it is not: the only place the scanner finds
 *     them is the keys just below, which is this file confirming itself, not
 *     an independent sighting anywhere near an emission site. Keep the
 *     scanner regardless: a new label is written as a literal far more often
 *     than as a concatenation, which is exactly the shape `butchr:orphan`
 *     slipped through before BUTCHR-108 — the scanner just must never be
 *     described as a coverage proof for the prefix families, clean run or
 *     not.
 *
 * AC-9(b) — A REGISTRY ENTRY RECORDS THAT A WITHDRAWAL PATH EXISTS, NOT THAT
 * IT REACHES EVERY MEMBER OF ITS FAMILY, AND CANNOT ITSELF PROVE REACH.
 * `agent:*`'s entries below correctly record the reconcile-loop diff
 * (`./sync.ts`) as the withdrawal path — and that record is accurate.
 * BUTCHR-144 found a real hole INSIDE that path (`agent:stalled` missing from
 * `SWEEP_JQL`'s `labels IN (...)` list in `./sweep.ts`, so a ticket carrying
 * it when it goes inactive was never picked up by that startup sweep); this
 * registry could not see that hole and never claimed to — it answers "is
 * there a withdrawal path", never "does it actually reach every case". That
 * specific hole was closed by BUTCHR-155, which derived the sweep's selection
 * from the `AgentLabel` union itself (`./plan.ts`'s `ALL_AGENT_LABEL_KEYS`),
 * rather than adding one more string to the hand-written list — see that
 * file's header. The general point stands regardless of that one fix: a
 * registry entry is still never a reach proof for whatever it names, and both
 * AC-9 blind spots are the same species of overclaim — say what a check
 * found, not what it would be nice for it to have found.
 *
 * `withdrawnBy` IS STRUCTURALLY REQUIRED, AND "NEVER" REQUIRES A REASON:
 * `LabelRegistryEntry` is a discriminated union on `withdrawnBy` itself —
 * either a non-empty string naming the verb/mechanism that removes the
 * label, or the literal `null` paired with a REQUIRED `neverWithdrawnReason`
 * string. There is no optional field and no boolean escape hatch: you cannot
 * omit `withdrawnBy`, and you cannot say "never" without also writing down
 * why. Example of the deliberately-permanent shape (this is not a real
 * registered label — just the pattern to copy):
 *
 *   {
 *     appliedBy: "...",
 *     notes: "...",
 *     withdrawnBy: null,
 *     neverWithdrawnReason: "a human-written sentence saying WHY this is permanent",
 *   }
 *
 * See `test/unit/labels-registry.test.ts` for `@ts-expect-error` lines that
 * prove both omissions really do fail to compile, checked by `bun run
 * typecheck` on every PR — not asserted in prose and trusted.
 *
 * NO RUNTIME BEHAVIOUR LIVES HERE. This file only imports the constants and
 * types it registers against; it is never imported BY `./plan.ts`,
 * `./sync.ts`, `./sweep.ts`, or `../tools/relationship.ts`'s own write paths,
 * so it cannot change what gets written, when, or in what order (AC-7). It is
 * pure documentation with a type system holding it honest.
 */

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
/** The two verb-owned labels that live outside the daemon's own prefix machinery — see `./plan.ts`'s `isDaemonLabel` comment for why they're a separate category. */
type VerbLabelKey = typeof EXEMPT_LABEL | typeof ORPHAN_LABEL;

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
    appliedBy: "src/labels/sync.ts's syncLabels — an overlay on top of an \"idle\" mapping (see src/agents/stalled.ts's StalledCheck): idle/done continuously since first observed, with zero comments from the daemon's own account, for the configured stall window. Never mapAgentStatus's own direct output (see ./plan.ts's ObservedAgentLabel exclusion) — always layered on top of idle.",
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
  [EXEMPT_LABEL]: {
    appliedBy:
      "shelve_worker (shelveWorker in src/tools/relationship.ts), and the \"shelve\" disposition of the worker-creating/adopting verbs (newWorker's and adoptWorker's/adoptProjectWorker's `disposition.kind === \"shelve\"` branches) — added BEFORE the To Do transition in every case (order writes by how bad it is to stop halfway: a failed transition after labelling leaves an inert label on an In Progress ticket, harmless; labelling after a successful transition would risk a To Do, assigned, UNEXEMPT child — a textbook parked ticket).",
    notes:
      "BUTCHR-24: deliberately NOT daemon-owned — isDaemonLabel (./plan.ts) must keep returning false for it, pinned by test/unit/labels-plan.test.ts, so the daemon's own poll/sweep machinery only ever READS it (to skip escalating a parked child) and never adds or removes it. It IS verb-owned: the explicit, agent-invoked relationship verbs below own its lifecycle, a different actor from the daemon's unattended machinery. A label set by hand (never through those verbs) is cleared by nobody but whoever set it — narrower than \"nobody but a human ever writes it\" (BUTCHR-50).",
    withdrawnBy:
      "start_worker (startWorker) and finish_worker (finishWorker) — both clear it unconditionally if present, BEFORE transitioning (BUTCHR-50; same halfway-failure ordering as above, in reverse: clearing first and failing the transition leaves a To Do, unexempt child the parked detector reports loudly, rather than a silently-wrong Done/In Progress ticket still carrying the label). Also adopt_worker's \"start\" disposition, on BOTH the issue-caller path (adoptWorker) and the project-caller path (adoptProjectWorker) — cleared whenever present, NOT gated on the alreadyAdopted idempotence check, so even a fully idempotent re-adoption still clears a stale exemption.",
  },
  [ORPHAN_LABEL]: {
    appliedBy:
      "file_where_it_belongs (fileWhereItBelongs in src/tools/relationship.ts) — applied exactly once, in the same call that creates the ticket, together with its destination header. There is no verb that adds this label to an already-existing ticket.",
    notes:
      "BUTCHR-108/BUTCHR-137: deliberately NOT daemon-owned, same category and same test as butchr:shelved above (an explicit, agent-invoked relationship verb owns its lifecycle, not the daemon's poll/sweep machinery). Means UNDIRECTED, not shelved — a materially different thing from EXEMPT_LABEL, so its withdrawal shape differs from EXEMPT_LABEL's on purpose (see withdrawnBy).",
    withdrawnBy:
      "adopt_worker — on BOTH the issue-caller path (adoptWorker) and the project-caller path (adoptProjectWorker), for BOTH dispositions (\"start\" AND \"shelve\"), unlike EXEMPT_LABEL above: a shelve-adopted ticket is exactly as directed as a start-adopted one (it now has a boss, a link, and a recorded decision either way), so both dispositions clear it. NOT gated on the alreadyAdopted idempotence check — a plain re-adoption clears a stale label even when nothing else about the call is new, which is the only reachable remedy for a ticket adopted before BUTCHR-108/BUTCHR-137, since no verb in this system removes a label from an existing issue outside adopt_worker. The project-caller (adoptProjectWorker) site is declared defence-in-depth, not a reachable-bug fix: file_where_it_belongs can only ever create a Story or a Task, so an orphan Epic cannot arrive through this codebase's own write path today — the clear is there for symmetry and for a label landing on an Epic by some other route, at zero extra cost (it reuses a fetch the idempotence check already makes).",
  },
};

/** Every label string declared in LABEL_REGISTRY, for the source scanner (./label-scan.ts) to check literals against. */
export const REGISTERED_LABELS: ReadonlySet<string> = new Set(Object.keys(LABEL_REGISTRY));
