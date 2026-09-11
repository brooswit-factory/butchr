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
**estimated post-storage** character length of the body about to be written
— `estimateStoredLength(body)`, not a bare `body.length` (see "The residual
limit" section below for why the estimate step exists and what it does and
does not cover).

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

**BUTCHR's own row has since moved, and this is expected, not a correction to
the table above.** BUTCHR-249's split landed after this table was measured;
the live BUTCHR root doc read at 52,301 characters shortly after the split
(the epic's own measurement) and at 57,791 characters later the same
session (this ticket's own re-check, under "Re-checking the budget" below) —
the page is under active edit and both are snapshots, not disagreements.
**The conclusion this table exists to support is unchanged either way: BUTCHR
is still over the 50,000 budget and still pinned at merge time**, correctable
and shrinkable, never bricked. The other ten rows were not re-measured for
this update — nothing in this PR's later rounds touched them, and the split
was BUTCHR-specific.

## The residual limit on any content-based comparison on this surface — MEASURED live in review, and fixed

This bound turns on a **size** comparison, never a content comparison — it
never inspects what changed, only how large `stored` and `proposed` are. That
matters because BUTCHR-235 measured that Confluence rewrites content it is
sent (entity-encoding at minimum) without establishing that entity-encoding
is the *only* transformation involved (attribute ordering, whitespace,
self-closing tags and empty-element normalisation were explicitly not
tested). A size comparison is far less exposed to that residual than a
content comparison would be, since `stored`/`proposed` never need to be
diffed or reconciled against each other.

**This section originally said the length-changing residual "has not
measured whether that happens." PR #299's review measured it, live, against
the real `setDoc` path, and it does happen — the original code was
measurably unsound as a result.** Two measurements, reproduced independently
in this repo's review:

- A literal em dash (`—`, U+2014) sent through `set_doc` came back from
  Confluence storage as `&mdash;` — 6 characters longer, the only difference
  in an otherwise-unchanged 48,730-character body.
- Starting from a stored body containing 97 `&mdash;` entities, replacing 50
  of them with literal `—` and sending that (**300 characters smaller** than
  what was stored) read back **byte-identical** to the prior stored body —
  same sha256, same length. The page did not shrink at all.

**Why that broke the guard, precisely: `stored` (read back, post-transform)
and a raw, un-normalised `proposed.length` (pre-transform, as the caller
wrote it) were being compared as though they were in the same unit, and they
are not.** Both clauses under-counted in the permissive direction — the one
a bound cannot afford:

- The **budget** clause under-counted a `proposed` body rich in
  transform-inflated characters, since the raw length is smaller than what
  it will actually occupy once stored.
- The **growth** clause under-counted the same way, and this was the more
  serious defect: a `proposed` body that looks smaller than `stored` in raw
  terms can have a real post-storage size *larger* than `stored` — so a
  genuinely growing, over-budget write could be scored as a permitted
  shrink, repeatedly, entirely defeating the anti-bricking clause's actual
  job (which is to make growth impossible once over budget, not merely to
  make *apparent* growth impossible).

**First fix (this PR's first round): `estimateStoredLength()`** puts
`proposed` into the same representation `stored` is already in — whatever
`get_doc`/`confluence_get_page` returns is already post-transform — instead
of comparing raw lengths. Its first version used a small, hand-picked table
of 10 characters this corpus had actually been observed round-tripping (em
dash, en dash, ellipsis, both arrow glyphs, curly quotes, `Δ`), framed
honestly as a known-subset approximation, not a claim of completeness.

**Second review round measured the EXACT boundary, closing the residual
rather than merely narrowing it.** The reviewer probed 20 characters
deliberately chosen as *not* in that first table — ordinary prose/typography
like `× ° é • ≥ ½ ± § © µ à ü ñ ∞ ≈ † ‰ € ™ ·` — and every one came back
re-encoded. Then a boundary probe: 7 characters with a standard HTML4 named
entity (`Ω ∂ ℵ ♠ ⌈ ∴ ⊕`) all came back encoded; 10 characters with no
standard named entity (`漢 😀 ʃ ŧ ǽ ᴀ ค ж א ᚠ` — CJK, emoji, IPA, other-script
letters) all survived literal. Seventeen for seventeen, no exception either
direction. **The measured rule: Confluence's storage layer re-encodes a
character if and only if it has a standard HTML 4 named character
reference.**

That rule has a name and a size — HTML 4.01 defines exactly 252 of these
(§24.2 ISO 8859-1, §24.3 symbols/math/Greek, §24.4 markup-significant and
internationalization characters) — so the fix is to use the *complete* set,
not a hand-picked slice of it. `src/tools/html4-named-entities.generated.ts`
is that complete table, **vendored from the W3C HTML 4.01 spec itself**
(`scripts/vendor/html4-entities.ts` fetches
`https://www.w3.org/TR/html4/sgml/entities.html` and mechanically parses its
own `<!ENTITY name CDATA "&#code;">` declarations) rather than hand-typed —
a 252-row table transcribed from memory is exactly where a silent
transcription error hides, which is precisely what a review of a hand-picked
10-row table had already caught once. `estimateStoredLength()` now replaces
every character present in that table with its named entity; every other
character passes through unchanged, per the measured rule. Both
`refuseIfGrowingOverBudget`'s clauses compare against
`estimateStoredLength(proposed)`, never `proposed.length` directly.

`test/unit/docs.test.ts` carries a regression arm using real non-ASCII
characters (not `"a".repeat(...)`) that fails against the pre-fix
raw-comparison code and passes against the fix — reverted and re-run by hand
during this PR to confirm it is a genuine falsifier, not decoration.
`test/unit/html4-named-entities.test.ts` separately pins the vendored
table's exact size (252) and a set of representative rows — including every
character either review round named — so a bad regeneration (wrong source,
a parser bug, a truncated fetch) fails loudly instead of drifting silently.

**What round 2's fix closed, and what it still did not.** It closed the
character-substitution residual against a 37-character probe with zero
exceptions — but every one of those 37 characters was, by the probing
reviewer's own later correction, above U+007F (non-ASCII). The rule as
stated — "encodes iff it has an HTML4 named entity" — was true of every
character actually tested and still over-generalised, because 4 of HTML4's
252 named entities are ASCII: `"` (quot), `&` (amp), `<` (lt), `>` (gt).

**Third review round measured why those four are different, and it matters:
Confluence's storage format IS XHTML.** `<`, `>`, `&` and `"` appearing in a
stored body are that format's OWN MARKUP SYNTAX — the brackets of a `<p>`
tag, the quotes around an `href` attribute, the leading `&` of an entity
reference already present — not content the storage layer re-encodes.
Measured directly: a real 54,824-character stored body containing 160
literal `&`, 953 literal `<`, 953 literal `>` and 30 literal `"` round-tripped
byte-identical (zero diff opcodes) on its last write. Running round 2's own
(then-unfixed) estimator against three real, currently-stored pages showed
the cost concretely — 12–14% phantom inflation on ordinary storage-markup
bodies, including one **genuinely under-budget page it scored as over**:
exactly the false-refusal failure mode this whole design exists to prevent,
now happening to a real page because of this bound's own estimator.

**Fix:** `scripts/vendor/html4-entities.ts` now excludes those 4 codepoints
by construction — not by hand-editing the `GENERATED` table (the exclusion
lives in the generator, with an explicit check that exactly 4 were found and
removed, so a future spec fetch can't silently re-include or over-exclude
them) — regenerating `html4-named-entities.generated.ts` to 248 entries. The
remaining 248 were checked for the same kind of storage-syntax significance
(the generator's own header comment has the reasoning: no other ASCII
delimiter Confluence's storage XML depends on — `'`, `=`, `/`, `;` — is even
an HTML4 named entity, so none of them could have been in this table
regardless) and found clean.

**Also corrected: a backwards polarity claim.** An earlier version of
`estimateStoredLength`'s doc comment said over-estimating could "never
manufacture a false refusal", reasoning that lengthening (never shrinking) a
body was inherently safe. That is wrong, and this bug is the proof: an
over-estimate is not a safe conservative bias here, it is the SAME failure
this design exists to avoid, just approached from the opposite direction —
locking the writing tier out of a page it is entitled to write is exactly as
real a defect as letting an over-budget page grow. Correctness means neither
direction of error, not merely "never shrinks."

`test/unit/docs.test.ts` gained a regression arm using realistic storage
markup (a `<p>` tag, a quoted `href`, an already-present `&mdash;` entity) —
genuinely under budget in raw form, verified by hand to fail against the
round-2 table and pass against this one. `test/unit/html4-named-entities.test.ts`
pins the new 248 count and asserts all four excluded codepoints are absent.

**What this closes, and what it still does not.** Three rounds in, this
closes the character-substitution residual exactly for NON-ASCII content
characters, while correctly leaving Confluence's own storage-format markup
syntax alone — an exact model of the measured transform, not an
approximation. **It does not claim anything about BUTCHR-235's separate,
still-unresolved caution** — attribute ordering, whitespace handling,
self-closing tag forms and empty-element normalisation were never tested by
either ticket, and a transform of THAT kind (not a character substitution)
would still be invisible to this size comparison. This bound turns on size,
not content, precisely because that residual is real; closing the
character-substitution instance of it does not retire the broader caution.

## Re-checking the budget after the phantom inflation and after BUTCHR-249's split

Round 3's reviewer asked, correctly, whether `DOC_BODY_CHAR_BUDGET = 50_000`
still stands once the ~12–14% phantom inflation is gone, and against the
corpus as it exists after BUTCHR-249's split landed (merged into this
branch's base as of the merge commit bringing BUTCHR-235/236 in too).

**It stands, unchanged, and the phantom inflation never actually bore on its
derivation.** The 50,000 figure was derived from `docs/tool-result-size-cap.md`'s
directly-measured (56,239, 61,376] PREVIEW/ERROR bracket — real MCP result
sizes observed by the harness — with margin for whole-result envelope
overhead and the bracket's own imprecision. None of that measurement ever
passed through `estimateStoredLength`; the phantom inflation was a bug in
how THIS bound's own guard judged a write's size, not a re-derivation of the
underlying cap experiment. Fixing the guard's estimator doesn't move a
number that was never computed by it.

**Re-measured against the live, post-split corpus (2026-09-10, this
session):** BUTCHR's root doc, after BUTCHR-249's split landed, reads at
**57,791 characters** via `get_doc` — still over the 50,000 budget (the
epic's own agent separately measured it at 52,301 characters earlier the
same day; the page is under active edit and both readings are consistent
with "still over budget," which is the only fact this re-check needed).
**BUTCHR remains pinned at merge time** — correctable and shrinkable, never
bricked, exactly as designed — and the split having landed does not change
that conclusion or the budget number.

## Read this next to `docs/tool-result-size-cap.md`

That document establishes the cap this bound exists to stay under, in more
detail than restated here — the calling-harness layer, the PREVIEW/ERROR
boundary experiment, and the separate byte-measured Bash-output cap this
bound does not address (a different surface, a different unit, not this
budget's problem).
