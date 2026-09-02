/**
 * BUTCHR-172/BUTCHR-154: the index of MEDIA, not a fourth registry of
 * records. Read `src/labels/registry.ts`'s header first — this file is not
 * a fourth instance of that same rule on a fourth medium; it is one level
 * up, over the three (soon four) media that each already run that rule for
 * themselves: `src/labels/registry.ts`, `src/headers/registry.ts`,
 * `src/workspace/registry.ts`, and the Confluence `[unwritten]` doc-title
 * marker, which has no registry file of its own (see the `docTitle` entry
 * below for why that is correct, not an omission).
 *
 * THE SENTENCE THIS FILE EXISTS FOR: "Exists" is not "reaches." A per-medium
 * registry entry records that a withdrawal path EXISTS for one record; it
 * never records that the path REACHES every member of the family it claims
 * to cover. `src/labels/registry.ts` declared `agent:stalled` had a
 * withdrawal path, correctly — the label rotted anyway because the startup
 * sweep's *selection* (`SWEEP_JQL` in `src/labels/sweep.ts`) was a
 * hand-written list that omitted it (fixed by BUTCHR-155, which derived the
 * selection from `src/labels/plan.ts`'s `ALL_AGENT_LABEL_KEYS` instead).
 * `./family-scan.ts` is the machine check for exactly that one source-visible
 * shape of that failure — see its own header for what it does and does not
 * prove. This file is the OTHER half of BUTCHR-154's mandate: a place to say,
 * per medium, how strong its withdrawal guarantee actually is, using one
 * shared vocabulary across all of them, without pretending the three media
 * are one mechanism.
 *
 * WHY AN INDEX OF MEDIA, NOT ONE REGISTRY OF RECORDS (BUTCHR-154's Q2,
 * answered NO to unifying the three per-medium registries, YES to this
 * index) — three genuinely different doors, restated here because this file
 * is the concrete artifact that answer produced:
 *   - The three registries' detectors match different SHAPES (a whole-literal
 *     namespaced value; a bracketed all-caps tag opening a literal; a
 *     `{{NAME}}` placeholder anywhere in Markdown text), read different
 *     CORPORA (`src/**\/*.ts` via the real TypeScript parser, twice;
 *     `briefs/*.md` via a raw-text regex, once — see `src/workspace/
 *     workspace-scan.ts`'s header for why a parser doesn't apply there), and
 *     carry their own exclusion lists and failure messages.
 *   - `src/workspace/registry.ts`'s own header names the deeper mismatch:
 *     labels and headers each have exactly ONE well-understood residual
 *     blind spot (a concatenation-built value; a template-literal-built
 *     opening line). The workspace medium has THREE categorically different
 *     non-template write sites (`mcp.json`'s `x-issue` via direct
 *     `JSON.stringify`; `ENVIRONMENT.md`'s content via direct
 *     `writeFileSync`; "some path the author did not find") sharing no
 *     single mechanism a scanner could target. They are not one kind of gap
 *     occurring three times.
 *   - What IS genuinely identical across all three is only the
 *     `withdrawnBy: string | (null + neverWithdrawnReason)` discriminated
 *     union — about fifteen lines, three times. Extracting it would save
 *     roughly thirty lines, at the cost of each registry's own
 *     medium-specific field documentation and an import edge between three
 *     modules every one of which deliberately declares "NO RUNTIME
 *     BEHAVIOUR LIVES HERE." Declined on those grounds: a false unification
 *     that turns three honest, specific mechanisms into one vague general
 *     one is worse than leaving them apart.
 *
 * SO THIS FILE'S PAYOFF IS NOT SHARED CODE. It is a place to say, for every
 * medium in one shared vocabulary, which failure shape it can even suffer —
 * which is what the grading below buys, and no per-medium file was asked to
 * buy on its own.
 *
 * NO RUNTIME IMPORT OF THE THREE PER-MEDIUM REGISTRIES — same leaf-only
 * discipline every one of them already declares for itself ("NO RUNTIME
 * BEHAVIOUR LIVES HERE"). This file's entries are prose, independently
 * verified against the code each medium actually runs, never derived by
 * importing and inspecting `LABEL_REGISTRY`/`HEADER_REGISTRY`/
 * `WORKSPACE_REGISTRY` at runtime or at type-check time. That also means
 * this file cannot be KEPT IN SYNC by the compiler the way, say,
 * `RegisteredLabel` keeps `LABEL_REGISTRY` in sync with `AgentLabel` — a
 * human has to notice when a per-medium registry's own grading changes and
 * update the matching entry here. Nothing automated closes that gap; see
 * `./media-scan.ts` for the one piece of it a check CAN close (a whole
 * medium's registry module appearing or disappearing on disk).
 *
 * THE GRADING — five ways a record is made safe, ordered by strength, and
 * this is the whole point of this file: it must be able to express all five
 * without forcing a record into a grade it does not actually earn.
 *
 *   structural      — the falsifying act is REFUSED until the record is
 *                      withdrawn. Worked example: the Confluence `[unwritten]`
 *                      doc-title marker — `set_doc` (src/tools/docs.ts)
 *                      throws if a caller tries to write real content while
 *                      the title still carries the marker and no new title
 *                      is given. See the `docTitle` entry below.
 *   same-call       — withdrawal fires in the same call as the falsifying
 *                      act. Worked example: `retireOrphanHeader`
 *                      (src/tools/relationship.ts) retires the `[ORPHAN]`
 *                      header in the same call that clears `ORPHAN_LABEL`.
 *   eventual        — a SEPARATE mechanism withdraws it later, over a
 *                      SELECTION. Worked examples: `agent:*` (poll-loop diff
 *                      plus the one-time startup sweep, both over a
 *                      selection); `pr:*` (poll-loop diff only — see the
 *                      `labels` entry below for why it is deliberately not
 *                      swept).
 *   time-invariant  — worded to assert a timestamped PAST EVENT; there is
 *                      nothing left to withdraw. Worked examples: the
 *                      `[ADOPTED]` header successor line; `WORKSPACE_
 *                      REGISTRY.KEY` (a Jira issue key is immutable in this
 *                      codebase).
 *   self-declaring  — the record names its OWN correction path, for a
 *                      reader careful enough to use it. Worked example:
 *                      `ENVIRONMENT.md`'s freshness paragraph (a
 *                      `measured at:` timestamp) and every brief's
 *                      instruction to re-verify a boss link live with
 *                      `jira_get_issue` rather than trust what a ticket or
 *                      comment claims.
 *
 * THE GRADING IS LOAD-BEARING, NOT DECORATION — THIS IS THE WHOLE PAYOFF:
 * `structural`, `same-call`, and `time-invariant` records have NO
 * SELECTION — there is no window in which "does the withdrawal path reach
 * every case?" is even a question you can ask of them, because there is
 * nothing for a selection to omit. Only `eventual` has a selection, which is
 * exactly why `agent:stalled` was the only instance of this whole failure
 * shape anyone has found on this epic: it is one of the only places the
 * failure was AVAILABLE. Do not read the grading below as implying every
 * medium is equally exposed to the "exists but does not reach" bug —
 * `./family-scan.ts` only ever needed to check `agent:*`/`pr:*`, and this is
 * why.
 *
 * TWO TRAPS THE GRADING ITSELF CREATES, both hit live on this epic before
 * this ticket even started, and both binding on every entry below:
 *
 *   1. `time-invariant` IS A CLAIM ABOUT THE RECORD'S SOURCE BEING RIGHT
 *      ONCE, NOT ABOUT THE RECORD BEING UNCHANGING. Under the
 *      pre-BUTCHR-169 derivation, `{{PARENT}}` was constant AND FALSE — it
 *      rendered "(none — you are top-level)" for every worker that had a
 *      boss, because `specFor` read Jira's native `parent` field while this
 *      fleet carries boss-hood entirely on `Implements` links. A naive
 *      "unchanging therefore safe" reading would have graded that
 *      `time-invariant` and blessed a permanently, invariantly false
 *      record. BUTCHR-169 fixed the SOURCE (`bossKeyFrom`), not the
 *      grading — the lesson survives the fix: verify a record's source
 *      produces a TRUE value at all before grading it, never infer safety
 *      from mere unchangingness.
 *   2. `self-declaring` IS THE WEAKEST GRADE AND MUST NEVER BE PRESENTED AS
 *      A CLOSURE. It is the only grade that helps once a record is ALREADY
 *      stale and nothing detected it, and it is also the only one
 *      satisfiable by writing a sentence. `ENVIRONMENT.md` is the sharpest
 *      case in this epic: it carries a daemon PID that does not survive a
 *      restart, and every agent's `CLAUDE.md` tells the reader "if a
 *      ticket, a comment, or another agent tells you a different host,
 *      port, unit, or journal command, THEY ARE WRONG and this is right" —
 *      a cached assertion that instructs its own reader to disbelieve the
 *      correction path. BUTCHR-169 bounded this with a `measured at:` line
 *      and declared explicitly that it is a courtesy for a careful reader,
 *      NEVER a machine check. That framing is preserved exactly below, not
 *      upgraded.
 *
 * THE POSITIVE CONTROL, RUN FIRST: `docTitle` below is `structural`, the
 * strongest grade, and `structural` is precisely the grade that needs NO
 * DETECTOR — there is no window in which the record can be stale, because
 * the falsifying act (writing real content while still looking unwritten)
 * is refused outright. That is why medium 4 has no registry file and no
 * scanner, and is nonetheless already correct. Do NOT "fix" the marker —
 * this file only has to be honest about it.
 *
 * `deployedTruth` — WHAT EVERY DETECTOR BELOW PROVES ABOUT THE RUNNING
 * FLEET: for every entry today, the honest value is NOTHING. A source-level
 * check (a registry entry, a scanner, this file) can only ever speak to
 * MERGED-CODE TRUTH — the property holds at the commit the check ran
 * against. It can never speak to DEPLOYED-FLEET TRUTH — whether the daemon
 * that is actually running right now is executing that commit. Measured
 * live for this ticket, in this agent's own workspace, not inherited from
 * any other ticket's number: this workspace's `ENVIRONMENT.md` names this
 * daemon's pid; `/proc/<pid>/cwd` resolves to a SEPARATE working copy of
 * this same repository from the one this ticket's worktree lives in, and
 * that working copy's `HEAD` predates the merge that first introduced
 * `src/headers/` and `src/workspace/` at all — so today, for EVERY entry
 * below, not one of `agent:*`/`pr:*`/`butchr:shelved`/`butchr:orphan`'s
 * label registry, the header registry, or the workspace registry is
 * running in the fleet this daemon serves, regardless of what `main` (or
 * this PR) contains. `git merge-base --is-ancestor` against that daemon
 * tree's own commit is the check; RE-RUN IT IN YOUR OWN ENVIRONMENT before
 * trusting this paragraph — a daemon can restart, redeploy, or simply be a
 * different pid by the time you read this, and this file is exactly the
 * kind of record `self-declaring` warns is never a machine check.
 *
 * NO RUNTIME BEHAVIOUR LIVES HERE, same discipline as the three files this
 * one indexes — this file is never imported by any write path in this
 * codebase, so it cannot change what gets written, when, or in what order.
 * Pure documentation with a type system holding it honest.
 */

/** Every medium this codebase declares a cached-assertion withdrawal grading for. Closed union — extending it without a matching `MEDIA_REGISTRY` entry fails to compile (see `MEDIA_REGISTRY`'s own `Record<Medium, ...>` type below). */
export type Medium = "labels" | "headers" | "workspace" | "docTitle";

/** One of the five ways a record is made safe — see this file's header for what each one means and the two traps grading one creates. */
export type WithdrawalGrade = "structural" | "same-call" | "eventual" | "time-invariant" | "self-declaring";

export interface WithdrawalGradeEntry {
  /** One of the five grades this file's header defines. */
  readonly grade: WithdrawalGrade;
  /** Prose naming the actual mechanism, verified against the medium's own registry/write-path code — never copied from this ticket. */
  readonly mechanism: string;
}

/**
 * A medium's withdrawal story is a LIST, not a single grade, because a real
 * medium's own records are not all made safe the same way — `labels` alone
 * mixes `eventual` (`agent:*`/`pr:*`) and `same-call` (`butchr:shelved`/
 * `butchr:orphan`). Forcing one grade to describe an entire medium would
 * either overclaim (picking the strongest grade present and letting it
 * imply coverage it does not have) or underclaim (picking the weakest and
 * hiding a real, stronger guarantee) — both are the exact overclaim/
 * underclaim shape this epic exists to catch, just moved up one level.
 */
export type WithdrawalStory = readonly WithdrawalGradeEntry[];

/**
 * `detector: null` REQUIRES a written reason, the same "you cannot say
 * 'none' without writing why" discipline `withdrawnBy: null` already
 * enforces in all three per-medium registries — a discriminated union so
 * the type makes the omission impossible, not a comment asking nicely. See
 * `test/unit/media-registry.test.ts` for the `@ts-expect-error` proof this
 * really does fail to compile.
 */
export type DetectorField =
  | { readonly detector: string }
  | { readonly detector: null; readonly noDetectorReason: string };

export type MediaRegistryEntry = DetectorField & {
  /** How this medium's own records are made safe — see `WithdrawalStory` above for why this is a list. */
  readonly withdrawal: WithdrawalStory;
  /** Prose, pointing at the per-medium file that argues each blind spot at length — never re-argued or summarised into something weaker here. */
  readonly blindSpots: string;
  /** What the detector(s) above prove about the RUNNING FLEET. Honest value for every entry today: nothing — see this file's header. */
  readonly deployedTruth: string;
};

const DEPLOYED_TRUTH_NOTHING =
  "Nothing. This medium's detector(s) can only ever speak to merged-code truth — the property held at the commit the check last ran against — never to deployed-fleet truth, whether the daemon actually running right now is executing that commit. Measured live for this ticket (see this file's header): this agent's own daemon (pid read from its own workspace's ENVIRONMENT.md, verified alive) has its working tree at a commit that predates the merge introducing src/headers/ and src/workspace/ at all, so today this is true of every entry in this registry, not a hedge. Re-measure in your own environment before trusting this sentence for a different point in time.";

/**
 * THE REGISTRY. Every medium this codebase declares a cached-assertion
 * withdrawal grading for — verified against the code each medium actually
 * runs, not copied from any ticket's own prose.
 */
export const MEDIA_REGISTRY: Readonly<Record<Medium, MediaRegistryEntry>> = {
  labels: {
    withdrawal: [
      {
        grade: "eventual",
        mechanism:
          "agent:* — src/labels/sync.ts's syncLabels, via diffLabels (src/labels/plan.ts) on every ~15s poll, PLUS src/labels/sweep.ts's one-time startup sweep for a ticket that went inactive while the daemon was down. Both operate over a selection: the poll loop's over whichever tickets it currently observes, the startup sweep's SWEEP_JQL is derived from ALL_AGENT_LABEL_KEYS (src/labels/plan.ts) — the value-level anchor BUTCHR-155 introduced after agent:stalled was found missing from a hand-written predecessor. pr:* — src/labels/sync.ts's syncLabels, via diffLabels, poll-loop diff ONLY. Deliberately NOT covered by the startup sweep: src/labels/sweep.ts's own comment says pr:* isn't tied to active status, so a ticket leaving the active set is not the event that would strand it.",
      },
      {
        grade: "same-call",
        mechanism:
          "butchr:shelved and butchr:orphan — cleared inside the SAME call as the verb that ends the shelved/orphan state, never by a separate later mechanism: start_worker/finish_worker/adopt_worker's 'start' disposition all clear butchr:shelved before transitioning; adopt_worker (both the issue- and project-caller paths, both dispositions) clears butchr:orphan. See src/labels/registry.ts's own EXEMPT_LABEL/ORPHAN_LABEL entries for the exact call sites and ordering rationale.",
      },
    ],
    detector:
      "src/labels/label-scan.ts (whole-string-literal scan over src/**/*.ts via the real TypeScript parser) plus src/labels/registry.ts's own type-level door (RegisteredLabel, built from AgentLabelKey/PrLabelKey/VerbLabelKey).",
    blindSpots:
      "src/labels/label-scan.ts's own header, in full — most load-bearingly AC-9(a): the nine agent:*/pr:* values are found by the scanner ONLY as this registry's own declared keys (the registry agreeing with itself), never at their real emission sites, which are AGENT_PREFIX/PR_PREFIX concatenations in src/labels/sync.ts. Real coverage for those nine comes entirely from the TYPE-level door, never the scanner. The two verb-owned labels (butchr:shelved, butchr:orphan) ARE genuinely found by the scanner at independent declaration sites (src/agents/parked.ts, src/tools/relationship.ts), so for those two the scan is a real, non-circular check. Also: test/ and scripts/ are unscanned by design (fixtures use label literals freely); a label-shaped literal that is not actually a Jira label needs a named KNOWN_NON_LABEL_LITERALS entry.",
    deployedTruth: DEPLOYED_TRUTH_NOTHING,
  },
  headers: {
    withdrawal: [
      {
        grade: "same-call",
        mechanism:
          "orphan — retireOrphanHeader (src/tools/relationship.ts), called from BOTH adoptWorker and adoptProjectWorker, retires the [ORPHAN] header in the SAME call that clears ORPHAN_LABEL (src/labels/registry.ts's own worked example for this grade, restated here for the header medium it actually lives in).",
      },
      {
        grade: "time-invariant",
        mechanism:
          "adopted — the [ADOPTED] successor line retireOrphanHeader writes is deliberately worded to assert ONLY a timestamped past event ('Adopted by: X on <date>'), never present-tense state — see src/headers/registry.ts's own 'adopted' entry for the two earlier, reachably-false present-tense drafts this was corrected away from in review. Nothing left to withdraw once a claim is only ever about what already happened.",
      },
    ],
    detector:
      "src/headers/header-scan.ts (a bracketed, all-caps tag SHAPE — /^\\[[A-Z][A-Z0-9_]*\\]/ — never today's literal text) plus src/headers/registry.ts's own type-level door (DescriptionHeaderKind).",
    blindSpots:
      "src/headers/header-scan.ts's own header, in full — most concretely: an opening line that is not itself a single, whole string literal (a template literal WITH substitutions is invisible to ts.isStringLiteralLike; this is not hypothetical — BUTCHR-157's own first draft of the [ADOPTED] line shipped exactly this shape and was caught only in human review, fixed by hoisting the tag-bearing prefix into its own whole-literal constant). Also: test/ and scripts/ are unscanned; a bracketed-all-caps literal that is not actually a description-header opening line needs a named KNOWN_NON_HEADER_LITERALS entry (empty today, per that file's own grep).",
    deployedTruth: DEPLOYED_TRUTH_NOTHING,
  },
  workspace: {
    withdrawal: [
      {
        grade: "time-invariant",
        mechanism:
          "KEY — a Jira issue key is immutable in this codebase (no verb renames or rekeys a ticket), so a snapshotted spec.key can never diverge from the live ticket's key. TYPE — as of today, no briefs/*.md template contains the literal {{TYPE}} at all (confirmed by src/workspace/workspace-scan.ts's own test suite finding zero hits), so there is nothing on disk to falsify; vacuously safe rather than actively proven safe, and src/workspace/registry.ts's own TYPE entry says so.",
      },
      {
        grade: "self-declaring",
        mechanism:
          "GROUND_TRUTH — the exact worked example this file's header names for this grade: ENVIRONMENT.md's freshness paragraph (a 'measured at:' timestamp, src/agents/ground-truth.ts) and every brief's framing that a stale copy is wrong and the reader's own live workspace file is right. BUTCHR-169 declared this explicitly as a courtesy for a careful reader, never a machine check — preserved exactly, not upgraded, here.",
      },
      {
        grade: "same-call",
        mechanism:
          "SUMMARY — correctWorker (src/tools/relationship.ts), after a successful Jira summary update it itself performs, best-effort rewrites brief.md for any workspace already built, in the SAME call. NARROWER than the labels/headers same-call examples: this only covers the correct_worker path. A direct Jira-UI edit to the summary field is a second, real way to falsify this record that correctWorker's own call never sees and nothing else in this codebase re-renders on — src/workspace/registry.ts's own SUMMARY entry says so ('nothing re-renders brief.md on its own' for that path). Grading this same-call is honest for the mechanism that exists; it is not a claim that every falsifying act triggers it.",
      },
    ],
    detector:
      "src/workspace/workspace-scan.ts (a {{[A-Z][A-Z0-9_]*}}-shaped regex over briefs/*.md — plain text, not TypeScript, so no AST is available; see that file's header for why this is a mechanical difference from the parser-based scanners, not a weaker discipline) plus src/workspace/registry.ts's own type-level door (WorkspacePlaceholder, tied in both directions to interpolate()'s own substitution table).",
    blindSpots:
      "src/workspace/registry.ts's and src/workspace/workspace-scan.ts's own headers, in full — most load-bearingly: THREE categorically different non-template write sites share no single mechanism a scanner could target (mcp.json's x-issue via direct JSON.stringify; ENVIRONMENT.md's content via direct writeFileSync, never living under briefs/ and never containing {{...}} syntax; and 'some path this ticket's author did not find'). Covered only by prose in the KEY and GROUND_TRUTH entries, verified by reading src/agents/workspace.ts, never by either door actually seeing them. SEPARATELY, and this does not fit either grade named above: PARENT (src/workspace/registry.ts) is withdrawnBy: null but is NOT time-invariant (its source, an Implements link, can genuinely change after workspace-build time via a real jira_link_issues re-parent — reachable, not hypothetical, named by that tool's own refusal message) and is NOT self-declaring (nothing in the rendered {{PARENT}} text itself tells a reader when to distrust it). Its only mitigation is an OPPORTUNISTIC side effect of SUMMARY's own same-call withdrawal above (correctWorker regenerates brief.md, including a fresh {{PARENT}}, whenever anyone corrects that ticket's summary) — not a dedicated mechanism of its own, and not triggered by a re-parent itself. PARENT is a live, reachable, ungraded gap; do not read its presence in this medium as covered by any grade above.",
    deployedTruth: DEPLOYED_TRUTH_NOTHING,
  },
  docTitle: {
    withdrawal: [
      {
        grade: "structural",
        mechanism:
          "set_doc (ensureDoc + the set_doc handler, src/tools/docs.ts) THROWS if a caller tries to write real content while the doc's title still starts with PROVISIONAL_MARKER ('[unwritten]') and no new title is supplied — the falsifying act itself (writing real content while the page still reads as unwritten) is refused outright, never merely detected after the fact. There is no runtime path in this codebase that can leave a doc holding both real content and a provisional title.",
      },
    ],
    detector: null,
    noDetectorReason:
      "structural is precisely the grade that needs no detector: there is no window in which this record can be stale for a scan to catch, because the guarantee is enforced by the same running code that would falsify it, not by a separate source-scanning pass over a corpus of literals. Unlike the other three media, this one has no registry.ts module and no scanner module — see src/media/media-scan.ts's own header for why that absence is itself a named, deliberate blind spot in THAT check, not an oversight here.",
    blindSpots:
      "None found in src/tools/docs.ts's own set_doc/isProvisional logic — there is no source artifact (a registry file, a scanner file) this medium could have a residual gap in, by construction. The one caveat this grade cannot remove: the guarantee only holds for whichever build of set_doc the deployed daemon is actually running — see deployedTruth.",
    deployedTruth:
      "Nothing to say beyond the general caveat, restated for a medium with no detector to make a merged-vs-deployed claim FROM: this medium's guarantee is enforced by live code (set_doc itself, at the moment it runs), not by a source scan proving something about a commit — but that only means the ordinary 'merged code vs. deployed fleet' framing does not apply in the same shape here, not that the concern disappears. The guarantee is still only as current as whichever build of set_doc the daemon happens to be executing, and nothing in this repository measures that specifically for this medium.",
  },
};
