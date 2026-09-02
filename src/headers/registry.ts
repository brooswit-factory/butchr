import { HEADER_TAGS, type DescriptionHeaderKind } from "../tools/relationship.js";

/**
 * BUTCHR-151/BUTCHR-157: the description-header medium's analogue of
 * `src/labels/registry.ts` — the one place every "cached assertion baked
 * into a Jira ticket's description" header this codebase writes is
 * declared, together with WHO withdraws it. Read `src/labels/registry.ts`'s
 * own header before touching this file; this one follows the identical
 * rule, for the identical reason, on a different medium, and does not
 * repeat that reasoning at the same length here.
 *
 * THE RULE, RESTATED FOR THIS MEDIUM: not "every header must be withdrawn"
 * — some legitimately never are (`"adopted"` below is exactly that case,
 * `withdrawnBy: null` with a written `neverWithdrawnReason` — added in
 * review, not designed in from the start; see that entry's own comment).
 * It is that the withdrawal owner must be WRITTEN DOWN, and "nobody,
 * deliberately, because X" is a valid declaration only when a human wrote
 * the X. A declaration made silently, or by default, is the bug this whole
 * epic (BUTCHR-150) exists to catch — and this file's own subject, the
 * `[ORPHAN]` header, is the epic's own worked example of exactly that bug:
 * `adopt_worker` withdrew `butchr:orphan` (a declared, registered label)
 * for a long time before anything withdrew the header standing right next
 * to it, because nothing declared that the header needed a withdrawal path
 * at all. This file is what "declared" now means for this medium.
 *
 * BUTCHR-172/BUTCHR-154: `../media/registry.ts` is the INDEX of all four
 * media (this one included) and the grading of how strongly each one's
 * records are made safe — NOT a shared abstraction over this file,
 * `src/labels/registry.ts`, and `src/workspace/registry.ts`; unifying the
 * three was considered there and declined (about fifteen shared lines
 * bought at the cost of each file's own medium-specific documentation and
 * an import edge between three deliberately leaf-only modules).
 *
 * TWO DOORS, SAME SHAPE AS `src/labels/registry.ts`'s, NEITHER PROVING WHAT
 * IT LOOKS LIKE IT PROVES:
 *   1. THE TYPE-LEVEL DOOR (this file). `HEADER_REGISTRY` is typed
 *      `Record<DescriptionHeaderKind, HeaderRegistryEntry>` —
 *      `DescriptionHeaderKind` (`src/tools/relationship.ts`) is a CLOSED
 *      union, not `string`, so extending it (adding a second header kind)
 *      without a matching entry here fails to compile. This is the PRIMARY
 *      door for any header kind that is actually routed through that type —
 *      but, exactly like `RegisteredLabel`'s own limit, it only sees a
 *      header kind that some developer deliberately added to the union. A
 *      header block built entirely outside `DescriptionHeaderKind` — a new
 *      function nobody wired the type through — compiles just fine and this
 *      door never sees it. That is precisely how `ORPHAN_LABEL` came to
 *      exist outside `src/labels/registry.ts`'s own type door once, on the
 *      other medium; nothing here is structurally immune to the same
 *      mistake happening again, which is why door 2 exists.
 *   2. THE SOURCE-SCANNING DOOR (`./header-scan.ts` +
 *      `test/unit/header-registry.test.ts`). Reads every `.ts` file under
 *      `src/` for a string literal that OPENS with a bracketed, all-caps
 *      tag (`/^\[[A-Z][A-Z0-9_]*\]/` — see that file's header for exactly
 *      why a PATTERN, not today's literal `"[ORPHAN]"` text, is what's
 *      matched) and asserts every tag found is a key in `HEADER_REGISTRY`.
 *      This is what closes the bypass door 1 cannot see.
 *
 * WHAT THIS REGISTRY DOES **NOT** CLAIM (mirroring `src/labels/registry.ts`'s
 * own AC-9 distinction exactly, because the same overclaim is possible
 * here): an entry recording that a withdrawal path EXISTS is not a claim
 * that the path REACHES every ticket that ever carried the header. The
 * `[ORPHAN]` entry's `withdrawnBy` below names `retireOrphanHeader`, called
 * from both `adoptWorker` and `adoptProjectWorker` — true, and verified
 * against the code that calls it, not copied from a ticket. It does NOT
 * claim every ticket adopted before this fix landed has already had its
 * header retired — see `src/tools/relationship.ts`'s own "THE RETROACTIVE
 * QUESTION" comment (right above `orphanNotice`) for that answer, stated
 * explicitly rather than left implied by this registry's silence.
 *
 * NO RUNTIME BEHAVIOUR LIVES HERE, same discipline as `src/labels/
 * registry.ts` — this file is never imported by `src/tools/relationship.ts`
 * (the write path), so it cannot change what gets written, when, or in what
 * order. Pure documentation with a type system holding it honest.
 */

interface HeaderRegistryEntryCommon {
  /** Prose: what bakes this header into a description, and when. */
  readonly appliedBy: string;
  /** Prose: the shape and load-bearing properties a reader needs before touching this header's lifecycle again. */
  readonly notes: string;
}

export type HeaderRegistryEntry =
  | (HeaderRegistryEntryCommon & {
      /** Non-empty prose naming the function/mechanism that withdraws (retires/rewrites) this header. */
      readonly withdrawnBy: string;
    })
  | (HeaderRegistryEntryCommon & {
      readonly withdrawnBy: null;
      /** Required, non-empty prose: WHY this header is deliberately, permanently never withdrawn. Not optional, not a boolean — a human sentence. */
      readonly neverWithdrawnReason: string;
    });

/**
 * THE REGISTRY. Every description-header kind this codebase bakes into a
 * ticket at creation — verified against the code that actually writes/
 * retires each one, not copied from any ticket's own prose.
 */
export const HEADER_REGISTRY: Readonly<Record<DescriptionHeaderKind, HeaderRegistryEntry>> = {
  orphan: {
    appliedBy:
      "fileWhereItBelongs (orphanHeader, src/tools/relationship.ts) — bakes the [ORPHAN] header into the created ticket's OWN description, in the same create call that applies ORPHAN_LABEL (butchr:orphan). There is no verb that adds this header to an already-existing ticket, same as the label it's paired with.",
    notes:
      "Four lines: a static open line, `Filed by: <filerKey>`, `Destination: <where>` (can itself span multiple lines — a filer's reason prose is not newline-restricted), and a static close line. The open/close lines are exported as ORPHAN_HEADER_OPEN_LINE/ORPHAN_HEADER_CLOSE_LINE so retireOrphanHeader can locate the block by content, never by counting lines.",
    withdrawnBy:
      "retireOrphanHeader (src/tools/relationship.ts), called from BOTH adoptWorker (issue-caller) and adoptProjectWorker (project-caller — defence-in-depth: fileWhereItBelongs can only ever create a Story or a Task, so an orphan Epic cannot arrive through this codebase's own write path today, same status as that path's ORPHAN_LABEL clear), for BOTH dispositions ('start' and 'shelve'), NOT gated on adopt_worker's own alreadyAdopted idempotence check — the header must not outlive the same call that withdraws ORPHAN_LABEL, mirroring that label's own withdrawnBy exactly. Retires the header by rewriting the description with a truthful [ADOPTED] successor line (see the 'adopted' entry below), after archiving the retired text under HEADER_WITHDRAWN_MARKER; never throws — a failure here is reported (AdoptWorkerResult.orphanHeaderNotWithdrawn) and never aborts or corrupts the adoption already in progress. See retireOrphanHeader's own doc comment for the absent/hand-edited/duplicate cases it refuses to guess at, and src/tools/relationship.ts's 'THE RETROACTIVE QUESTION' comment for what this does NOT reach (tickets adopted before this fix shipped).",
  },
  /**
   * ADDED IN REVIEW (BUTCHR-157, 2026-09-02), NOT DESIGNED IN FROM THE
   * START: the `[ADOPTED]` successor line `retireOrphanHeader` writes in
   * place of a retired `[ORPHAN]` header is ITSELF a description header
   * baked into a ticket — the reviewer caught it shipping undeclared and
   * invisible to this very PR's own scanner (its first version was a
   * template literal WITH substitutions, which `ts.isStringLiteralLike`
   * does not match). Fixed on two axes together, not just one: the wording
   * was rewritten to assert ONLY historical, time-invariant facts (see
   * below for why that makes `withdrawnBy: null` an honest declaration
   * rather than a dodge), and its opening line was hoisted into
   * `ADOPTED_HEADER_OPEN_LINE`, a whole string literal with no
   * substitution, so the scanner catches it the same way it catches
   * `[ORPHAN]`'s.
   */
  adopted: {
    appliedBy:
      "retireOrphanHeader (src/tools/relationship.ts) — writes this in place of a retired [ORPHAN] header, inside adoptWorker/adoptProjectWorker, the same call that retires 'orphan' above. Never written any other way; there is no verb that adds this header to a ticket that never carried an [ORPHAN] header to begin with.",
    notes:
      "Three lines: the static ADOPTED_HEADER_OPEN_LINE, `Adopted by: <callerKey> on <ISO timestamp>.`, and `Originally filed by: <filerKey>; ...`. DELIBERATELY WORDED TO ASSERT ONLY A PAST EVENT, NEVER CURRENT STATE: earlier drafts read 'This ticket HAS a boss (X)' and '(disposition: Y)' — live, present-tense claims reachably falsified by a later jira_link_issues re-parent (the boss claim) or by start_worker following a 'shelve' adoption (start_worker transitions and clears EXEMPT_LABEL but never touches the description, so a stale 'disposition: shelve' would survive a later start). 'Adopted by: X on <date>' asserts only that the EVENT happened, which stays true forever regardless of what happens to the ticket afterward — the same distinction a git commit message or this registry's OWN appliedBy/withdrawnBy fields already rely on (a record of who did what, when, not a live claim about current ownership).",
    withdrawnBy: null,
    neverWithdrawnReason:
      "Nothing to withdraw: every clause is historical and time-invariant by construction (see notes above) — there is no future state in which 'X adopted this ticket at time T' becomes false, unlike '[ORPHAN] ... nobody owns it', which adoption itself falsifies. A withdrawal path exists for an assertion that can go stale; this one is designed, deliberately, not to.",
  },
};

/** Every tag string declared in HEADER_REGISTRY, for the source scanner (./header-scan.ts) to check literals against. */
export const REGISTERED_HEADER_TAGS: ReadonlySet<string> = new Set(Object.values(HEADER_TAGS));
