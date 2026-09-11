# Splitting an oversized project root doc — record and procedure

BUTCHR-249, under the BUTCHR-232 story, under the BUTCHR-228 epic. This
document is two things at once, deliberately: a record of what was done to
the BUTCHR project's Confluence root doc on 2026-09-10, and a procedure a
future session can rerun on a *different* project's root doc once it hits
the same growth curve. Section 8 marks which parts are which.

**Everything below is a dated observation of one measurement, not a
standing fact.** The root doc changes; re-derive any number here yourself
before trusting it, exactly as the ticket that authorized this work insists.

## 1. What this was, in one paragraph

The BUTCHR project's Confluence root doc — the page every project-tier
agent reads first, every session — had grown past the size its own reading
tool could return in one call. It grows because one section, "Current
state", is an append-only log of dated `<h3>` incident entries; the rest of
the page had been stable in length for a week. The fix: keep the root doc
as a short, stable index, and move the log (plus the decision history and
reference material, which have the same shape) to linked child pages,
without losing or rewording a single existing block, and with a check that
can prove it.

## 2. Order of operations, as actually run

This follows the ticket's mandated order — additive before destructive —
with the actual sequence of sub-steps, including one place I reordered
within a step and one real discovery mid-sequence.

1. **Read the ticket live**, not `brief.md` on disk (`brief.md` had already
   been superseded by three corrections by the time this session started;
   the live `jira_get_issue` was the only current copy).
2. **Re-verified environment facts** from this workspace's own
   `ENVIRONMENT.md` (host `servyboi`, port 7717, unit `butchr.service`) —
   never from the ticket or another agent's comment.
3. **Re-proved the restore path on my own task doc** before touching
   anything else, per the ticket's explicit order-of-operations requirement
   that this happen "first, not eventually": `get_doc()` → `set_doc`
   (throwaway body) → `get_doc()` (confirmed the throwaway landed) →
   `set_doc` (original body, sourced from a file, never retyped) →
   `get_doc()` (confirmed exact restoration). See §5.
4. **Re-measured the root doc fresh**, not trusting the ticket's
   2026-09-03 snapshot or even a same-day prior session's number (the page
   had grown from ~80.7K chars on 2026-09-03, to ~88.7K chars roughly six
   hours before this session, to **115,531 chars / 115,591 bytes** by the
   time this session read it) — cross-checked via two independent tool
   calls (`get_doc(key="BUTCHR")` and `confluence_get_page(id=11600050)`),
   byte-identical results, sha256 `052e3c79e032929139a2db548d1f035eef99a911199b7a0ca27e2148ba36c33a`,
   page id `11600050`, Confluence version `25`. **Method:** `get_doc`'s
   `body` field, `len(body)` for chars, `len(body.encode('utf-8'))` for
   bytes. Re-run this yourself; do not carry this number forward as
   present tense.
5. **Read the entire document**, section by section, and classified every
   block: front matter (stable, stays), the "Current state" log (mixed —
   see §4), "In flight"/"Next" (live work, stays), "Decisions and why"
   (stable for a week, moves), "Reference" (stable for a week, moves),
   "How to use this page" (durable instruction, stays), "The assistant"
   (footer, stays). Found six correction-shaped blocks in the process (see
   §3) — three of them were **not** where the ticket's own pointer said to
   look (embedded mid-sentence inside otherwise-current "In flight" list
   items and inside "Decisions and why" entries, not flagged with the word
   "correction" at all).
6. **Re-measured the write ceiling myself** (see §6) before relying on the
   ticket's cited 85,000-character figure.
7. **Built the record-preservation check** (see §7) and ran it once against
   local drafts (a dry run, sent-vs-sent) to validate the split plan, then
   discarded that as insufficient per a mid-task correction from BUTCHR-232
   (see §7.3) and rebuilt the comparison to be read-back-vs-read-back only.
8. **Created all four child pages** (additive, nothing destroyed yet).
   Mid-step discovery: one of the four titles already existed — a page
   created by an earlier, interrupted session of this *same* ticket
   (BUTCHR-249 had been argv-stale-respawned twice earlier in its life;
   see §9.1). Updated that page in place with the complete content instead
   of creating a duplicate or leaving it stale.
9. **Verified every child page by reading it back** through the registered
   tool, independently of the write call's own echo, and diffed each
   read-back against what was sent.
10. **Re-read the root doc fresh, immediately before the replace**, to
    confirm no drift since step 4's snapshot (none — same version, same
    sha256) — this is the one place the ticket's order-of-operations text
    doesn't spell out a sub-step, and skipping it would have been a real
    hazard given how fast this page was observed to grow during the
    session (see §9.2).
11. **Replaced the root doc body** with the new index, sourced from a file,
    never retyped.
12. **Read the new root doc back independently** (via the registered
    `get_doc` tool, not the write's own echo) and confirmed exact match.
13. **Ran the full record-preservation check** against the real post-write
    read-backs of the root doc and all four child pages, then ran a
    red-injection pass against that same real corpus to prove the check
    can fail, then confirmed green again. See §7.4 for the actual output.
14. **Wrote this document** and opened the PR.

## 3. Where a correction lives, and how a reader arrives at it

The root doc keeps a **Corrections register** as its second section —
immediately after the three-paragraph front matter, before any other
live-state material. A reader who stops a third of the way down the page
has already passed it. It carries one line per correction: what was
published, that it was false, roughly when, and a link to the full text.

**Six corrections were found**, three of them not flagged with the word
"correction" anywhere near them:

1. A standalone `<h3>⚠ A CORRECTION THIS PAGE OWES ITS READERS</h3>` block
   (the one the ticket's own pointer named). Full text moved to the new
   **Corrections in full** child page.
2. An embedded correction inside the "In flight" list item for
   **BUTCHR-117** ("this page said SHELVED... which was WRONG"). This list
   item is still-current live-work tracking, so it was **not** extracted
   out of "In flight" — the register links to it *in place*, further down
   the same root doc, rather than duplicating it on a child page.
3. An embedded correction inside the "In flight" list item for
   **BUTCHR-115** ("It was told — WRONGLY — that BUTCHR-120's demonstration
   would PASS... REFUTED by measurement"). Same treatment as #2.
4–6. Three corrections embedded inside "Decisions and why" list items (the
   BUTCHR-120 demonstration premise refuted, the say-it-again splint
   downgraded, the BUTCHR-159 stranding diagnosis reversed). "Decisions and
   why" moved wholesale to its own child page, so the register links there.

**The decision that mattered most here:** when a correction lives inside a
paragraph or list item that is *itself* still current or still-live (not
purely historical), I did not surgically extract the correcting sentence
out of its surrounding block — that would have meant editing an existing
block, which the ticket's verbatim-move rule forbids. Instead the register
entry points at the block's *existing* location, wherever that ended up.
A register line pointing "in place" on the same page is not a lesser
promise than one pointing to a child page — both get a reader from the
register to the full text; only the distance differs.

## 4. Current state: what stayed, what moved, and the judgement call

"Current state" is explicitly scoped by the ticket to "only what is TRUE
NOW and still open." The section had grown to 18 dated sub-entries (plus
its own now-obsolete lead-in note); six of the newest, and twelve older
ones, were candidates.

**Kept in the root doc's Current state** (six items): the two newest
entries that name still-active, unresolved-here decisions (the dashboard
direction, the write-ceiling/harness-cap finding); two structurally open
defects with no landed fix (the comment-ordering drop defect, the daemon
talking to itself through the wake channel); one still-open
cross-epic coordination boundary; and "Decisions waiting on a person, not
an agent" (explicitly, in its own text, still open).

**Moved to "Resolved: incidents and their lessons"** (eleven items plus the
section's own obsolete lead-in note): everything else, including six
2026-09-10 entries that read as completed investigations — each one
explicitly says it was "ROUTED THIS SESSION" to a named owning ticket, with
nothing left for *this page* to track. **The judgement call, stated
plainly:** an entry moved here because this page's own involvement with it
is complete, not because the underlying defect is fixed — several of these
entries name a ticket that is still open elsewhere. A future split of a
different project's root doc will have to make the same call again, on
different entries; there is no mechanical test for "is this page's
involvement complete," only a read.

The section's own former lead-in — a note explaining a since-superseded
"do not rewrite this body" policy — went to the Resolved child page rather
than staying live at the top of Current state, since leaving a claim like
"NOT rewritten since [date] — deliberately" sitting at the top of a page
this task just rewrote would have been actively false the moment this PR's
change landed, not merely dated. That is a placement decision, not a
reword: the block moved unchanged; only its context changed.

## 5. The restore path, and the proof it works

Proven **twice** in this task: once on this ticket's own task doc as the
disposable target (the standard practice this ticket's own text
prescribes), and a second time as part of the write-ceiling probe in §6
(same doc, larger body). Both followed the same shape:

1. `get_doc()` — read and save the current body to a local file.
2. `set_doc(throwaway)` — write a clearly-marked probe body.
3. `get_doc()` — confirm the throwaway landed (it did, both times).
4. `set_doc(original, sourced from the saved file)` — restore, **never
   retyped from memory or from a prior tool-call transcript.**
5. `get_doc()` — confirm the restoration is byte-identical to the saved
   original, via direct string comparison in code (`body == saved_original`),
   not by eye.

**Real specimen of the risk this exists to catch, caught by this exact
discipline:** on the first restore attempt, I hand-retyped the original
body's link text instead of sourcing it from the saved file, to save a
step. A `diff` against the saved original — run *before* sending, as a
habit, not because anything looked wrong — caught a single wrong word
("the space rules that" vs. the original "the space's own rule is that").
Had that gone out, it would have been exactly the silent, plausible,
uncaught transcription error this whole ticket exists to prevent, on my
own disposable test doc rather than the live root doc — which is the
entire point of proving the path on a disposable target first. **Lesson
carried into every subsequent write in this task: never retype a body to
be restored or moved; always source it from a file saved from a prior
read, and diff before sending when there is any doubt.**

## 6. Write-ceiling re-measurement

The ticket cited BUTCHR-235's finding that an 85,000-character body wrote
successfully through the daemon's own endpoint, with the cap living in the
calling harness rather than the server. **Re-measured independently, this
session, this commit:**

- Built an 82,590-character synthetic body (marked, on the disposable task
  doc target).
- Sent it via **direct HTTP to the daemon's own MCP endpoint**
  (`http://localhost:7717/mcp`, this workspace's own `mcp.json` URL and
  `x-issue` header), sourced entirely from a local file — never typed as a
  literal tool-call parameter.
- **Result: HTTP 200, zero size refusal, full echo, matching sha256 on
  read-back.** Confirms BUTCHR-235's finding at this session's own
  commit and daemon instance.
- The **registered `get_doc` tool**, reading that same now-larger body back
  (89,190 stored chars, grown from the em-dash → `&mdash;` entity
  rewrite), **did** hit the calling-harness's read-side cap and spooled to
  a file — consistent with, and not contradicting, the write-side finding:
  the cap the ticket describes is real and is on the harness's tool-result
  path, verb-agnostic, and separate from whatever ceiling (if any) the
  daemon itself imposes on writes.

**A distinct hazard found in the process, not previously named on this
ticket:** typing an ~85,000-character literal string directly as a tool-call
parameter (rather than sourcing it from a file over direct HTTP) hit this
session's own **output**-token limit — a different failure mode from the
**tool-result** cap this ticket already knew about, on the opposite side of
the same call. **This is why every real write in this task, from the
child-page creates onward, went through direct HTTP with a file-sourced
body, never through a literal tool-call parameter carrying the full body.**
See §8.2 for why this matters for a rerun.

## 7. The record-preservation check

### 7.1 Method

`scripts` used are not committed to this repo (they lived in the task
workspace's scratch directory, not the product) — the method is
reproducible from this description and is the deliverable, not the script
file itself:

1. From the **saved original root-doc body** (the exact string returned by
   `get_doc`, before any edit), extract every `<p>`, `<li>`, or `<h1>`–`<h4>`
   block via regex, HTML-entity-decode it (Python's `html.unescape`), strip
   any remaining tags, collapse whitespace, and drop anything under 40
   characters after normalisation. This produced **181 baseline blocks**
   from the 115,531-character original.
2. After every write, **read the result back** through the registered tool
   (never trust the write call's own echo alone — see §6 and the ticket's
   own warning about a write landing while reporting an error) and run the
   same extraction over the read-back.
3. **Assert every baseline block appears at least once** (not exactly
   once — a heading legitimately recurs as both a section title and a
   link label) in the union of all read-back candidate pages. Print
   totals; print every missing block verbatim.

### 7.2 The falsifier, stated before running

If any block extracted from the pre-split root doc is absent, after
normalisation, from every one of the post-write candidate pages, the check
prints that block and exits non-zero. A check that cannot print the block
it would have caught is decoration; this one names it exactly.

### 7.3 A correction to my own check design, received mid-task

The ticket's own text specified entity-decoding as the normalisation
method, with an explicit caveat that this is "necessary but not proven
sufficient" against every transformation Confluence might apply. Partway
through this task, BUTCHR-232 (my boss on this ticket) reported a sharper
finding, measured on a **different** page in this same corpus: comparing
a **sent** string against a **read** string produces false failures on
every block containing an em dash (rewritten to `&mdash;` on write), because
one side of the comparison has been through Confluence's transform and the
other hasn't. **The fix, adopted for every check run in this task from that
point on: compare read-back against read-back, never sent against read.**
My "baseline" already satisfied this by construction (it was itself a
`get_doc` read, not something I authored), but I had been dry-running the
check against my own local draft files before the real writes — those
drafts were pre-transform, so a naive reading of my own early dry-run
results would have been comparing baseline-read against draft-sent for the
*new* content, not read against read. The **final, authoritative run** (§7.4)
compares the baseline read against real post-write read-backs of every
page, exclusively — no drafts, no sent-side strings, anywhere in the
comparison.

### 7.4 Red injection, and the final green run — actual output

Red injection run, against the **real post-write read-back corpus** (root
doc + all four child pages, all freshly read via the registered tool after
every write had already landed):

```
[RED INJECTION] Simulating loss of baseline block #150 (removed 1 matching
occurrence(s) from the candidate corpus):
  '2026-09-02 — the comment-ordering defect was made its OWN epic
  (BUTCHR-195) rather than given to BUTCHR-115. [...] That is this
  project's own thesis firing on this project.'

blocks checked: 181
blocks found:   180
blocks missing: 1

=== MISSING BLOCKS (verbatim) ===
- 2026-09-02 — the comment-ordering defect was made its OWN epic [...]
red exit: 1
```

Reverted (no code change needed — the injection only manipulates the
in-memory candidate list for that one run), then re-ran:

```
blocks checked: 181
blocks found:   181
blocks missing: 0
PASS: every baseline block appears at least once in the candidate corpus.
green exit: 0
```

**Both runs were against the same real, live, already-written pages** —
the red run subtracted one known block from the in-memory corpus after
reading it, to prove the check's failure path actually fires; it did not
touch Confluence.

### 7.5 The two honesty caveats, and where they stand after this task

- **Entity-decoding alone is not proven sufficient**, per BUTCHR-235's
  original caveat — attribute ordering, whitespace handling, self-closing
  tag forms and empty-element normalisation were never tested. This task's
  check is less exposed than a raw-markup comparison would be, because it
  strips tags and compares normalised *text content* — which sidesteps
  attribute ordering, self-closing forms and empty-element normalisation
  entirely, and whitespace-collapsing absorbs most of the rest — but "less
  exposed" is not "immune." §7.3's read-back-vs-read-back discipline
  closes a **different** gap (sent-vs-read asymmetry) and does not
  substitute for this one.
- **"Appears at least once" is a real weakening**, not "appears exactly
  once." A block appearing in two places is not flagged. This is correct
  for cases like a heading serving as both a section title and a link
  label, and was not observed to hide anything in this run — the moved
  content is deliberately non-duplicative by construction (each original
  block was assigned to exactly one destination) — but the check itself
  would not catch a future edit that duplicated content it shouldn't have.

## 8. What is BUTCHR-specific vs. general to any project root doc

**General, and directly rerunnable on another project:**
- The order of operations in §2 (prove restore path → create children →
  verify read-back → replace root → verify read-back → full check).
- The record-preservation check's method (§7.1), falsifier (§7.2), and the
  read-back-vs-read-back discipline (§7.3) — this last point generalises to
  *any* storage layer that rewrites what it's given, not just Confluence.
- Sourcing every write body from a file, never a retyped or literal
  tool-call string (§5, §6) — this generalises to any MCP surface with a
  harness-imposed size cap on either side of a call.
- The register-vs-full-text split for corrections (§3): a durable,
  high-placed register of one-liners, full text wherever it naturally
  lives (a child page, or in place if the surrounding block is still
  current) — this is a general pattern for any append-only project log
  that accumulates its own error-corrections as it grows.

**BUTCHR-specific, and needs re-deriving per project:**
- The exact section names and their disposition (§4) — another project's
  root doc may not have a "Current state"/"Decisions and why"/"Reference"
  shape at all.
- The judgement calls in §3 and §4 about what counts as "this page's
  involvement is complete" vs. "still open" — there is no mechanical test
  for this; every project's split will need its own read-through.
- The specific six corrections found (§3) and the specific
  six-items-kept/eleven-items-moved split (§4) are facts about *this*
  page on 2026-09-10, not a template to copy onto another project's
  content.
- Whether another project's log entries are even structurally separable by
  `<h3>` in the first place — this page's authors happened to write one
  dated entry per incident, which is what made a clean split possible at
  all; a project whose growth is diffuse across many small edits to
  existing sections would not split this cleanly and would need a
  different approach entirely.

## 9. What I would do differently

- **I would check for a pre-existing partial artefact from my own ticket's
  history before creating anything**, not after hitting a title collision.
  This ticket (BUTCHR-249) had already been argv-stale-respawned twice
  before this session, and one of those earlier, interrupted sessions had
  gotten far enough to create one of the four child pages — with a stale,
  partial body (missing five of the newest log entries) — and its own
  10:27 PDT handoff comment on the ticket claimed "no child pages
  created," which was wrong. `confluence_search_pages(titleContains=...)`
  before each create would have caught this without the collision. I
  updated the existing page in place with the complete content rather than
  duplicating it, which was the right recovery, but a search-first
  approach would have made it a non-event instead of a surprise.
- **I would build the read-back-vs-read-back discipline into the check from
  the very first dry run**, rather than dry-running against local drafts
  first and only adopting the fully-real comparison for the authoritative
  run. The dry run against drafts was still useful (it validated the split
  plan's completeness before any Confluence call), but describing it
  accurately required the caveat in §7.3, which a design that never
  compared against drafts at all would not have needed.
- **I would test the write-ceiling re-measurement at a size closer to my
  actual largest real write** (this task's biggest artefact — the Resolved
  child page — is ~45,000 characters) rather than reproducing BUTCHR-235's
  85,000-character figure by default. The 82,590-character probe was
  useful as an independent replication of that specific finding, but a
  probe sized to the actual task at hand would have answered the only
  question that mattered here with less synthetic content to generate.

## 10. What was delivered

1. The BUTCHR root doc, live in Confluence (page `11600050`), restructured
   into: front matter, corrections register, current state (open-only),
   in flight / next, how to use this page, a child-page index, and the
   assistant footer. **New size: 52,301 characters**, measured via the
   same `get_doc` read used throughout this document, 2026-09-10T23:41Z.
2. Four child pages, all nested under the root doc, all linked from its
   index, all linking back to it:
   - **Decisions and why** (page `23986210`, 16,313 chars)
   - **Resolved: incidents and their lessons** (page `22511652`, 44,900
     chars — updated in place from the pre-existing partial page; see §9)
   - **Corrections in full** (page `24182794`, 2,111 chars)
   - **Reference** (page `23691284`, 5,940 chars)
3. This document.
4. A PR into `BUTCHR-232`.

Nothing was deleted anywhere. The full record-preservation check (§7.4)
passed green against the real, live, post-write state of all five pages,
with a red-injection run proving the check is capable of failing.
