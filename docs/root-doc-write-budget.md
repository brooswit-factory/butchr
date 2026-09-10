# The doc-write growth bound (BUTCHR-250, for BUTCHR-232)

Structural teeth for the claim BUTCHR-232's epic is built on: a root doc that
only grows eventually outgrows the MCP result cap `docs/tool-result-size-cap.md`
measured. A split (BUTCHR-249) fixes the state once; this bound is what stops
the state from re-accumulating after every future split, because it EXECUTES
rather than relying on an agent remembering a rule.

Re-derive every number in this document yourself before trusting it — it is a
snapshot at one commit, not a permanent fact. Verify any path or line number
cited here against your own checkout.

## The design

`src/tools/docs.ts`'s `refuseIfGrowingOverBudget` guards both `setDoc` (a
ticket's own doc) and `setProjectDoc` (a project's root doc) — the two callers
of the write path. Let `budget` be the named constant `DOC_BODY_CHAR_BUDGET`,
`stored` be the character length of the body already on the page (read before
the write, by the same pre-write read `projectRootDoc`/`ensureDoc` already
perform to resolve the page id — no second fetch), and `proposed` be the
character length of the body about to be written.

**Refuse if and only if `proposed.length > budget` AND `proposed.length >
stored.length`.**

- Under budget: always allowed.
- Over budget but not growing (`proposed.length <= stored.length`): allowed.
  An already-oversized page can still be corrected, compacted, shrunk, or
  split.
- Over budget AND growing: refused.

The second clause is the entire design. A plain ceiling with no shrink escape
would brick every page already over the line — including, at measurement
time, the very BUTCHR root doc this epic exists because of (see the blast-
radius table below) — permanently, since this corpus never archives a page
and there is no second write path to fall back on. An agent that cannot
record what it just learned is a worse failure than a long page; the
anti-bricking clause removes that failure while still making growth
impossible once a page is over budget.

Two boundary cases, decided deliberately rather than left to whichever
comparison operator someone happens to write:

- **`proposed.length == budget`**: allowed. The budget names the first size
  that is "over", not the last size that is "under".
- **`proposed.length == stored.length`**: allowed, even when both are over
  budget. A same-size rewrite is a correction, not growth — the design's own
  stated escape ("can always be corrected") would be false if an
  equal-length edit were refused.

Both are pinned by boundary-arm tests in `test/unit/docs.test.ts` so a future
`>` → `>=` edit on either clause fails loudly.

The refusal message names the current stored size, the proposed size, the
budget, and the remedy (move the excess into a child page linked from the
root doc's index) — a refusal that does not say where the content should go
is the lock-out this design exists to avoid, wearing a permission-denied
costume instead of a page-too-large one.

## Units: characters, not bytes

`docs/tool-result-size-cap.md` established that the MCP result cap this bound
exists to stay under is measured in **characters** (JS `.length` / UTF-16
code units — what the harness's own error text counts), not UTF-8 bytes, and
that the two diverge measurably in a corpus this heavy with em dashes and
arrows. `DOC_BODY_CHAR_BUDGET` and every comparison in
`refuseIfGrowingOverBudget` use `.length` throughout — never
`Buffer.byteLength` — so this bound is consistent with the cap it protects
against. Measured directly on 2026-09-10 against the live BUTCHR root doc:
115,531 characters vs 115,591 UTF-8 bytes on the same body — a 60-character
gap on one page, which is the scale of divergence a byte-based budget would
get wrong.

## Choosing the budget: method, not a bare number

`DOC_BODY_CHAR_BUDGET = 50_000`, a named constant with its derivation in the
code comment above it (`src/tools/docs.ts`), not a bare literal and not prose
asserting a measurement as a permanent fact. The method:

The budget must sit below the low end of the measured PREVIEW/ERROR boundary
for the MCP result cap — `docs/tool-result-size-cap.md`'s (56,239, 61,376]
character bracket, from one controlled experiment (BUTCHR-216) of unstated
precision — with margin, for three reasons named in the code comment:

1. The cap bounds the **whole MCP result** (JSON envelope, HTML escaping and
   all), not the body alone, and the envelope is not a fixed subtraction — it
   was observed at ~289 characters on 2026-09-02 and ~303 on 2026-09-10 on the
   same page, i.e. it grows with the body's own escaping.
2. The bracket itself comes from one experiment; its precision is unstated.
3. A document sitting exactly at the boundary is one comment away from
   crossing it.

50,000 leaves upward of 6,000 characters — over 10% — of margin under the
bracket's own low end, after all three of the above. Re-measure the bracket
before trusting that this margin is still conservative enough; it is a
snapshot, not a proof.

**A second, independent way to read the same number: the growth is not
diffuse.** A top-level-heading size breakdown of the live BUTCHR root doc
(`<h2>` span sizes over the `get_doc` body), re-derived directly against the
2026-09-10T23:16Z read rather than taken on faith, confirms the epic's own
comparison against its 2026-09-03 measurement: `Decisions and why` (15,957
chars), `How to use this page` (8,059) and `Reference` (5,722) sit
byte-for-byte unchanged across the week, while `Current state` — the
dated, append-only event log — grew from roughly 37,700 to **68,981 chars**,
independently confirmed exact here. That one section alone accounts for the
overwhelming majority of a week's growth on an otherwise-stable page (28
total `<h2>`+`<h3>` headings today, also independently confirmed). Read
together with the 28,000+ chars of standing structural content that has not
moved, 50,000 is not an arbitrary point below a bracket — it is roughly
"the stable core, plus meaningful headroom for the append-only log, plus the
envelope allowance" and can be re-run against a future re-measurement rather
than re-guessed. This does **not** make the guard section-aware — it stays a
size predicate over the whole stored body, deliberately, since teaching it
`Current state` specifically is BUTCHR-249's structural work, not this
ticket's — it only argues for the magnitude already chosen above.

## Scope decision 1: both project root docs and per-ticket docs

The write path has two callers, `setDoc` (per-ticket) and `setProjectDoc`
(project root). The bound applies to **both**, and both are exercised in
`test/unit/docs.test.ts`.

A per-ticket doc growing without bound is a smaller problem than a shared,
monotonically-growing project root doc — a ticket's doc has one writer, a
finite lifetime, and (per BUTCHR-71's own design) is nested under a boss's
doc rather than read on every project poll. But "smaller" is not "not a
problem": a per-ticket doc is read by `get_doc` exactly the same way a
project root doc is, hits the identical MCP result cap, and this corpus has
already shown (`docs/tool-result-size-cap.md`, row 2–5) that an *ordinary*
ticket's description-plus-comments can cross from PREVIEW to ERROR shape from
routine coordination traffic alone. The write path is one function shared by
both callers; special-casing the guard to skip per-ticket docs would be an
asymmetry with no argument behind it, for a saving (fewer refusals on a
smaller-blast-radius surface) that does not outweigh leaving a known-bad
growth pattern unguarded on half the write path.

## Scope decision 2: not project-specific

The bound must protect all eight-plus projects on this design (BUTCHR-232's
own ruling), not only BUTCHR — it is a verb-level guard on the write path,
applying to every caller the moment it merges, not per-project content. The
implementation takes no project key, no project-shaped branch, and no
BUTCHR-specific fixture: `refuseIfGrowingOverBudget` is a pure function of
`(who, stored, proposed, budget)` with `who` used only in the error message.
`test/unit/docs.test.ts` exercises the guard against project keys `ACME` and
`ZORP` — deliberately not `BUTCHR` — asserting identical refuse/allow
behaviour, which is what would have caught a hardcoded key or a
project-shaped assumption in how the root doc resolves, rather than a diff
read declaring the code "looks general."

## Scope decision 3: write path only, not read

The bound guards the STORED size, and the stored size is exactly what a read
returns — so guarding the only place size *changes* bounds what a read can
ever return, with one number, on one code path. Refusing a large READ would
help nobody: it would not shrink the page, and a sibling story (this epic's
read-path half) owns making a large read survivable rather than refused.

## What this bound does not cover

**A human editing the page directly in the Confluence UI is outside this
bound's reach entirely.** The guard lives in `AtlassianOps.updatePage`'s
callers inside this codebase; a browser edit never calls it. This is the
right scope — the growth this epic exists for is agent-driven and monotonic,
via repeated automated writes, not a human occasionally editing a page by
hand — but a reader must not infer coverage this bound does not have.

## What this costs when the budget is wrong

- **Too low:** legitimate root-doc growth gets refused, and someone has to
  split content they had not planned to split yet. Loud (the refusal names
  the sizes and the remedy) and recoverable (a code change to
  `DOC_BODY_CHAR_BUDGET`, or actually splitting the page) — never silent.
- **Too high:** the bound simply never fires, and this project is back to
  the pre-BUTCHR-250 state for whichever page/agent combination stays under
  the (too-generous) line — but the split this epic performs has already
  bought room regardless of where the number sits.

## Blast-radius table — every project root doc, measured before merge

Measured 2026-09-10 via `get_doc`/`confluence_get_page`'s server-computed
`bodyLength` (exact character count, not manually counted) against every
project this daemon could resolve a `butchr` root-doc entity property for.
`KAN` and `SD` returned a clean 404 on that property (KAN has none; SD is not
even a real Jira project here) — not counted as one of the eight-plus
projects this design protects. Re-derive rather than trust; several of these
pages are actively edited by their own project agents and will have moved.

| Project | Root doc size (chars) | Over 50,000-char budget? |
|---|---:|---|
| BUTCHR | 115,531 | **YES — pinned at its current size until shrunk or split** |
| WYZR | 41,152 | No (82% of budget — closest margin) |
| CNDLX | 37,554 | No |
| BAKR | 29,039 | No |
| SICKOS | 26,360 | No |
| DROVR | 24,919 | No |
| LIBS | 22,013 | No |
| RINTH | 17,248 | No |
| CATA | 16,961 | No |
| SCHEM | 15,201 | No |
| ASSIST | 5,460 | No |

**Only BUTCHR is pinned at merge time** — the exact page this epic exists
because of, and the one already under a standing instruction not to write it
at that size. Every other measured project root doc has comfortable headroom
under the budget; none is newly locked out of growth it was actually using.
WYZR is the one worth watching (82% of budget and actively growing this
session) but is not pinned today.

This table answers BUTCHR-232's blast-radius question as "which projects are
pinned the moment this merges," not "should the bound be widened" — that
question is already decided at the epic level.

## The residual limit on any content-based comparison on this surface

This bound turns on a **size** comparison, never a content comparison — it
never inspects what changed, only how large `stored` and `proposed` are. That
matters because BUTCHR-235 measured that Confluence rewrites content it is
sent (entity-encoding at minimum) without establishing that entity-encoding
is the *only* transformation involved (attribute ordering, whitespace,
self-closing tags and empty-element normalisation were explicitly not
tested). A size comparison is far less exposed to that residual than a
content comparison would be, since `stored`/`proposed` never need to be
diffed or reconciled against each other — but it is not zero-exposed: if
Confluence's storage transform changes a body's *length* (not just its
content) between what is sent and what is later read back, `stored` on a
later write is measuring the transformed length, not the sent length. This
bound has not measured whether that happens; it is a residual worth a future
reader's attention if `stored` and `proposed` for an unmodified body are ever
observed to disagree.

## Read this next to `docs/tool-result-size-cap.md`

That document establishes the cap this bound exists to stay under, in more
detail than restated here — the calling-harness layer, the PREVIEW/ERROR
boundary experiment, and the separate byte-measured Bash-output cap this
bound does not address (a different surface, a different unit, not this
budget's problem).
