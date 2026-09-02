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
 * — some legitimately never are (there are none of those here today, but
 * the type keeps the option open the same way `LabelRegistryEntry` does).
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
      "retireOrphanHeader (src/tools/relationship.ts), called from BOTH adoptWorker (issue-caller) and adoptProjectWorker (project-caller — defence-in-depth: fileWhereItBelongs can only ever create a Story or a Task, so an orphan Epic cannot arrive through this codebase's own write path today, same status as that path's ORPHAN_LABEL clear), for BOTH dispositions ('start' and 'shelve'), NOT gated on adopt_worker's own alreadyAdopted idempotence check — the header must not outlive the same call that withdraws ORPHAN_LABEL, mirroring that label's own withdrawnBy exactly. Retires the header by rewriting the description with a truthful [ADOPTED] successor line, after archiving the retired text under HEADER_WITHDRAWN_MARKER; never throws — a failure here is reported (AdoptWorkerResult.orphanHeaderNotWithdrawn) and never aborts or corrupts the adoption already in progress. See retireOrphanHeader's own doc comment for the absent/hand-edited/duplicate cases it refuses to guess at, and src/tools/relationship.ts's 'THE RETROACTIVE QUESTION' comment for what this does NOT reach (tickets adopted before this fix shipped).",
  },
};

/** Every tag string declared in HEADER_REGISTRY, for the source scanner (./header-scan.ts) to check literals against. */
export const REGISTERED_HEADER_TAGS: ReadonlySet<string> = new Set(Object.values(HEADER_TAGS));
