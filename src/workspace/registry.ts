import { WORKSPACE_PLACEHOLDERS, type WorkspacePlaceholder } from "../agents/workspace.js";

/**
 * BUTCHR-169: the workspace-file medium's analogue of
 * `src/headers/registry.ts` (itself modelled on `src/labels/registry.ts`) —
 * the one place every "cached assertion baked into an agent's on-disk
 * workspace" this codebase writes is declared, together with WHO withdraws
 * it. Read `src/headers/registry.ts`'s own header before touching this file;
 * this is the THIRD instance of the same rule (labels, description headers,
 * now workspace files), on a third medium, and does not repeat the shared
 * reasoning at the same length here.
 *
 * THE RULE, RESTATED FOR THIS MEDIUM: not "every workspace record must be
 * withdrawn" — several legitimately never are, for different reasons (see
 * KEY, TYPE, PARENT, GROUND_TRUTH below — no two of the four
 * `withdrawnBy: null` reasons in this file are the same reason). It is that
 * the withdrawal owner must be WRITTEN DOWN, and "nobody, deliberately,
 * because X" is a valid declaration only when a human wrote the X.
 *
 * WHERE THIS MEDIUM SITS IN THE EPIC: BUTCHR-150 named `brief.md` on disk as
 * the hardest of the three media because it spans two systems with different
 * read semantics — a Jira field read LIVE, and a file on disk read ONCE at
 * process start. Investigating this ticket found the epic's own headline
 * ("a correction to a DESCRIPTION never reaches a running agent") is not
 * literally what happens: `buildWorkspace` never writes a ticket's
 * description to disk at all (verified: it is absent from every
 * `briefs/*.md` template and from `CLAUDE.md`), so a description correction
 * already reaches a running agent, through the same `jira_get_issue` every
 * brief instructs it to use. The two records genuinely frozen on disk are
 * `SUMMARY` and `PARENT` — this file's registry, and BUTCHR-169's own ticket,
 * both build against that measured mechanism, not the ticket's original
 * headline.
 *
 * TWO DOORS, SAME SHAPE AS `src/headers/registry.ts`'s AND
 * `src/labels/registry.ts`'s, NEITHER PROVING WHAT IT LOOKS LIKE IT PROVES:
 *   1. THE TYPE-LEVEL DOOR (this file). `WORKSPACE_REGISTRY` is typed
 *      `Record<WorkspacePlaceholder, WorkspaceRegistryEntry>` —
 *      `WorkspacePlaceholder` (`src/agents/workspace.ts`) is a CLOSED union —
 *      `WORKSPACE_PLACEHOLDERS`, a plain hand-written array — but, unlike a
 *      free-floating list that could silently drift from what `interpolate()`
 *      actually substitutes, `interpolate()`'s OWN substitution table
 *      (`values`) is itself typed `Record<WorkspacePlaceholder, string>` (see
 *      that file's comment for the exact shape). That typing is what ties
 *      the two together in BOTH directions: a `values` entry for a name NOT
 *      in `WORKSPACE_PLACEHOLDERS` is an excess-property error, and a name
 *      IN `WORKSPACE_PLACEHOLDERS` with no matching `values` entry fails to
 *      compile there for the opposite reason (`Record` requires every key).
 *      Extending `WorkspacePlaceholder` without a matching entry here fails
 *      to compile HERE too, the same door `HEADER_REGISTRY`'s type check
 *      already demonstrates. This door sees every placeholder
 *      `interpolate()` is CAPABLE of substituting — including one no
 *      template currently uses (see TYPE below) — but it does NOT
 *      see a workspace record written by some OTHER path entirely (a file
 *      write that never goes through `interpolate()`/a `briefs/*.md`
 *      template at all). That is precisely how `mcp.json`'s `x-issue` field
 *      and the standalone `ENVIRONMENT.md` file exist outside this door —
 *      see "WHAT THIS REGISTRY DOES NOT CLAIM" below.
 *   2. THE SOURCE-SCANNING DOOR (`./workspace-scan.ts` +
 *      `test/unit/workspace-registry.test.ts`). Reads every `briefs/*.md`
 *      template for a `{{[A-Z_]+}}`-shaped placeholder and asserts each one
 *      found is a key of `WORKSPACE_REGISTRY`. This is what closes the
 *      bypass door 1 cannot see FROM THE TEMPLATE SIDE: a template that
 *      introduces a brand-new `{{THING}}` nobody wired into `interpolate()`
 *      yet would render literally (a real, silent bug — the placeholder
 *      leaking to the agent unsubstituted) and door 1 alone would never
 *      catch it, because door 1 only examines `interpolate()`'s OWN
 *      substitution table, never the templates that consume it.
 *
 * WHAT THIS REGISTRY DOES **NOT** CLAIM (mirroring `src/headers/registry.ts`'s
 * own AC-9-derived distinction, because the same overclaim is possible
 * here): an entry recording that a withdrawal path EXISTS (or is
 * deliberately absent, with a reason) is not a claim that this is the ONLY
 * place a snapshotted workspace record could ever be written. THREE
 * confirmed write sites sit entirely outside BOTH doors above, verified by
 * reading `src/agents/workspace.ts`'s `buildWorkspace`, not inherited from
 * any ticket:
 *   - `mcp.json`'s `x-issue` header value is `spec.key`, written directly via
 *     `JSON.stringify` — never through `interpolate()`, never containing
 *     `{{...}}` syntax. Covered by the `KEY` entry below by NAMING this
 *     second site in its `appliedBy` prose (verified against the code), not
 *     by either door actually seeing it.
 *   - `ENVIRONMENT.md`'s entire content is `groundTruthText(...)`, written
 *     directly via `writeFileSync` — never through `interpolate()`, never
 *     living under `briefs/` at all, so door 2 cannot scan it (it isn't a
 *     template) and it carries no `{{...}}` placeholder for door 1 to
 *     govern either. Covered by the `GROUND_TRUTH` entry below the same way
 *     `KEY` covers `mcp.json`: by naming the site in prose, not by either
 *     door seeing it directly. (`CLAUDE.md`'s `{{GROUND_TRUTH}}` usage IS
 *     the identical text and IS what door 2 actually finds — see that
 *     entry's `appliedBy`.)
 *   - A workspace file written by some THIRD path this ticket's author did
 *     not find. Neither door can rule this out; see `./workspace-scan.ts`'s
 *     header for the full, honest blind-spot list.
 *
 * NO RUNTIME BEHAVIOUR LIVES HERE, same discipline as `src/headers/
 * registry.ts`/`src/labels/registry.ts` — this file is never imported by
 * `src/agents/workspace.ts` (the write path) or by
 * `src/tools/relationship.ts`'s `correctWorker` (the one function that
 * REACTS to a stale `SUMMARY`), so it cannot change what gets written, when,
 * or how a correction is handled. Pure documentation with a type system
 * holding it honest.
 *
 * CARRIED FROM BUTCHR-151, WITH PROVENANCE (this ticket's description asked
 * for this explicitly): DOES THE TWO-DOOR SHAPE GENERALISE TO A THIRD
 * MEDIUM? MOSTLY — WITH ONE GENUINE MISMATCH BUTCHR-154 SHOULD CHECK FOR ON
 * EVERY FURTHER MEDIUM IT ADDS.
 *   - What transfers cleanly: a closed type-level union tied to the real
 *     write-site implementation, plus a secondary scan matching a SHAPE
 *     (not today's literal) over the actual source the medium is written
 *     from. Both labels and headers scan `.ts` source under `src/` with the
 *     real TypeScript parser; this medium's "source" for door 2 is instead
 *     plain-text Markdown under `briefs/` — `./workspace-scan.ts` is
 *     therefore a raw regex over file text, NOT `ts.createSourceFile`, for
 *     the mundane reason that `briefs/*.md` are not TypeScript. This is a
 *     mechanical difference, not a structural one: the shape/false-positive
 *     discipline (a named `KNOWN_NON_WORKSPACE_PLACEHOLDER_LITERALS`
 *     exclusion list, empty today, for a hypothetical future doc example
 *     that legitimately shows `{{LIKE_THIS}}` as prose rather than a real
 *     placeholder) is preserved even though the parser underneath is not.
 *   - THE GENUINE MISMATCH: labels and headers each have exactly one
 *     "everything lives outside the primary door" case (the `agent:`/`pr:`
 *     concatenation-built labels; a header opening line built by template
 *     substitution) — a single, well-understood residual blind spot. THIS
 *     medium has THREE structurally different non-template write sites
 *     (`mcp.json`'s `x-issue`, standalone `ENVIRONMENT.md`, and "some file
 *     write this ticket's author didn't find") that share NO SINGLE
 *     mechanism a scanner could target — they are not "the same kind of gap,
 *     occurring twice" the way `agent:`/`pr:` are, they are categorically
 *     different write paths (direct JSON serialisation; a second,
 *     non-templated call to the same render function; the unknown). BUTCHR-
 *     154, generalising across four media, should check for EACH additional
 *     medium whether its records are representable as some kind of
 *     source-level literal or pattern at all before assuming a scanner has
 *     a foothold — where a record is written with NO literal/pattern
 *     representation anywhere in source (this file's `mcp.json`/
 *     `ENVIRONMENT.md` cases), the type-level door plus a VERIFIED prose
 *     cross-reference in the registry entry is the necessary fallback, not
 *     an optional nicety, and no scanner design closes it.
 *
 * A SEPARATE ANSWER TO THE SAME CARRIED QUESTION, ABOUT `PARENT` SPECIFICALLY
 * — WORTH RECORDING BECAUSE THE ANSWER CHANGED MID-TICKET: an early draft of
 * this file argued `PARENT` did NOT fit the withdrawal-path shape at all,
 * because it was found FALSE AT WRITE TIME (not merely stale) for every
 * ticket with a real boss, and "withdraw a stale record" presupposes the
 * record was once true. That diagnosis was correct; the conclusion drawn
 * from it — remove the assertion rather than fix it — was reversed after
 * this ticket's boss withdrew an earlier instruction treating the
 * DERIVATION fix as out of scope. Once permitted to fix `SpawnSpec.parent`'s
 * SOURCE (see `bossKeyFrom`, `src/resources/issue.ts`) rather than only its
 * WORDING, the false-at-birth problem dissolved: `PARENT` fits this shape
 * exactly as well as `KEY` or `SUMMARY` do, once it is actually true. The
 * generalisable lesson for BUTCHR-154 is narrower than "some records don't
 * fit the shape" — it is: **a record that is false at write time is a
 * defect in the record's SOURCE, not evidence against the withdrawal-path
 * shape; check whether the source is fixable before concluding a medium
 * needs a different treatment.** Where a source genuinely cannot be fixed
 * (no live signal exists to derive a true value from), declaring the record
 * un-withdrawn with a written reason — or dropping it — remains legitimate;
 * this file's `TYPE` entry is exactly that case, for an unrelated reason
 * (nothing writes it, not that it can't be made true).
 *
 * THE RETROACTIVE QUESTION (mirroring `src/tools/relationship.ts`'s own
 * comment of that name, BUTCHR-151/BUTCHR-157's worked example of answering
 * this well) — WHAT HAPPENS TO WORKSPACES ALREADY ON DISK WHEN THIS TICKET
 * LANDS, ANSWERED EXPLICITLY: a workspace built BEFORE this ticket has a
 * `brief.md`/`CLAUDE.md` frozen with the OLD, WRONG `{{PARENT}}` rendering
 * (always "(none — you are top-level)", even for a ticket with a real
 * boss — see `PARENT`'s own entry above) and, if it has been corrected
 * since, a stale pre-correction `SUMMARY`. Two concretely known instances:
 * BUTCHR-153's own workspace and THIS TICKET'S OWN (BUTCHR-169) both carried
 * the false `{{PARENT}}` line at the time this fix was written. DECIDED: NOT
 * repaired retroactively by this ticket, deliberately, for the same shape of
 * reasons `src/tools/relationship.ts`'s precedent gives, adapted to this
 * medium:
 *   1. `SUMMARY` gets PARTIAL, OPPORTUNISTIC retroactive repair for free,
 *      as a side effect of the mechanism this ticket ships anyway: the next
 *      time anyone runs `correct_worker` with a `summary` against a ticket
 *      whose workspace already exists, `rewriteWorkspaceBriefSummary`
 *      regenerates its `brief.md` from the CURRENT `SpawnSpec` — which now
 *      includes the FIXED `{{PARENT}}` derivation too, not just the new
 *      summary. So a workspace does not need a DEDICATED repair pass to
 *      have both fields corrected; the existing correction workflow now
 *      does double duty. This is real but PARTIAL: it only fires for a
 *      ticket someone actually corrects the summary of, never for
 *      `{{PARENT}}` alone.
 *   2. There is no cheap, reliable way to FIND every OTHER workspace on
 *      disk with a stale `{{PARENT}}` line without a dedicated sweep:
 *      workspace directories are local to whichever host's daemon built
 *      them, not centrally enumerable from this codebase, and this ticket's
 *      own scope is the WRITE PATH, not an operator inventory of every
 *      machine in the fleet.
 *   3. Retroactively rewriting an unknown, unbounded set of OTHER agents'
 *      workspaces — files a currently-running agent may be actively reading
 *      — from inside a single Task's scope is exactly the kind of
 *      wide-blast-radius action this fleet's workers do not take
 *      unilaterally; a bulk repair script, if ever wanted, is its own
 *      bounded unit of work, filed with `file_where_it_belongs` if
 *      warranted, not a side effect buried in this fix.
 * This declaration is the answer this Requirement asks for, stated where a
 * reader of the code lands (here) and repeated in this ticket's changelog
 * fragment — silently shipping "the workspace-file medium is closed" while
 * every already-built workspace keeps a false `{{PARENT}}` line would be
 * exactly the fresh cached assertion this epic exists to stop producing.
 */

interface WorkspaceRegistryEntryCommon {
  /** Prose: what writes this record to disk, and when — every real write site, verified against the code, not only the primary one. */
  readonly appliedBy: string;
  /** Prose: the shape and load-bearing properties a reader needs before touching this record's lifecycle again. */
  readonly notes: string;
}

export type WorkspaceRegistryEntry =
  | (WorkspaceRegistryEntryCommon & {
      /** Non-empty prose naming the function/mechanism that withdraws (rewrites/corrects) this record. */
      readonly withdrawnBy: string;
    })
  | (WorkspaceRegistryEntryCommon & {
      readonly withdrawnBy: null;
      /** Required, non-empty prose: WHY this record is deliberately, permanently never withdrawn. Not optional, not a boolean — a human sentence. */
      readonly neverWithdrawnReason: string;
    });

/**
 * THE REGISTRY. Every workspace placeholder `interpolate()` (src/agents/
 * workspace.ts) is capable of substituting — verified against the code that
 * actually writes/reinterpolates each one, not copied from any ticket's own
 * prose.
 */
export const WORKSPACE_REGISTRY: Readonly<Record<WorkspacePlaceholder, WorkspaceRegistryEntry>> = {
  KEY: {
    appliedBy:
      "interpolate() (src/agents/workspace.ts), called from buildWorkspace for both CLAUDE.md and brief.md, substitutes {{KEY}} with SpawnSpec.key (issue.key — see ISSUE_SPAWN_CONFIG.specFor, src/resources/issue.ts). buildWorkspace ALSO writes the identical value, independently of interpolate()/any template, as mcp.json's `x-issue` header — a direct JSON.stringify field, structurally invisible to both doors (see this file's header, 'WHAT THIS REGISTRY DOES NOT CLAIM').",
    notes: "Used in every briefs/*.md template (verified by ./workspace-scan.ts's own test suite) and in mcp.json. The one record this file declares with two independently-verified write sites for the identical value.",
    withdrawnBy: null,
    neverWithdrawnReason:
      "A Jira issue's key is immutable in this codebase — no verb here renames or rekeys a ticket — so a value snapshotted from spec.key can never diverge from the live ticket's key. Time-invariant by construction, the same reasoning src/headers/registry.ts's 'adopted' entry uses for its own withdrawnBy: null: there is no future state in which this specific assertion becomes false.",
  },
  SUMMARY: {
    appliedBy:
      "interpolate() substitutes {{SUMMARY}} with SpawnSpec.summary (issue.summary) into brief.md — every briefs/*.md template EXCEPT CLAUDE.md uses it (verified: CLAUDE.md carries only {{GROUND_TRUTH}}). correctWorker's OLD success message and tool-doc text both claimed a summary is snapshotted into 'brief.md/CLAUDE.md' — that second half was never true; fixed by this same ticket (src/tools/relationship.ts, src/tools/defs.ts) as instance (b) of the very defect this file exists to catch: a cached assertion about where a cached assertion lives.",
    notes:
      "Genuinely can go stale: a summary is Jira-editable after workspace-build time (correct_worker, or a human in the Jira UI) and nothing re-renders brief.md on its own when that happens.",
    withdrawnBy:
      "correctWorker (src/tools/relationship.ts) — after a successful Jira summary update, best-effort REWRITES brief.md for any workspace already built for workerKey (join(workspaceRoot(), workerKey, 'brief.md')), regenerated from the SAME briefFor/interpolate machinery buildWorkspace itself uses, so a workspace built or re-read AFTER the correction carries the new summary. Skipped silently (not an error) when no workspace directory exists for workerKey — the common case for a ticket never spawned, or already cleaned up. A write failure is reported in CorrectWorkerResult (never thrown — the Jira correction that already landed must not be lost) but does NOT reach a RUNNING agent's already-loaded context: that gap is the one this mechanism cannot close by construction (a file rewrite cannot edit a process's memory), and CorrectWorkerResult.message says so explicitly, pointing at tell_worker as the only channel that can. See src/tools/relationship.ts's correctWorker doc comment for the full argument against the other three options (pure notify, pure declare-never-withdrawn) this entry chose a hybrid over.",
  },
  TYPE: {
    appliedBy:
      "interpolate() accepts {{TYPE}} -> SpawnSpec.issuetype, but as of this ticket (BUTCHR-169) NO template under briefs/ contains the literal '{{TYPE}}' — confirmed by ./workspace-scan.ts's own test suite finding zero hits, not inherited from a prior ticket's claim.",
    notes: "Not written to any workspace file today. Kept in the type-level door because interpolate() still offers the substitution and a future template could reintroduce it.",
    withdrawnBy: null,
    neverWithdrawnReason:
      "Nothing on disk asserts this today, so there is nothing to go stale. If a future template adds {{TYPE}}, note for whoever does: spec.issuetype cannot drift after workspace-build time either — no verb in this codebase changes an existing issue's issuetype — so even a future live usage would already be time-invariant, the same construction as KEY above, not a new staleness risk to design against.",
  },
  PARENT: {
    appliedBy:
      "interpolate() substitutes {{PARENT}} -> SpawnSpec.parent, used by task.md and story.md, ?? '(none — you are top-level)' when null. AS OF THIS TICKET (BUTCHR-169), SpawnSpec.parent NO LONGER comes from Jira's native `parent` field — ISSUE_SPAWN_CONFIG.specFor (src/resources/issue.ts) now derives it via bossKeyFrom(issue), which reads issue.issuelinks (populated by AtlassianClient#search, src/atlassian/client.ts) for an inward `Implements` link — the SAME convention findBossKey (src/tools/docs.ts) already uses on the raw-JSON shape jira_get_issue returns. See src/resources/issue.ts's own comment on bossKeyFrom for the full argument.",
    notes:
      "FIXED AT THE SOURCE, NOT SUPPRESSED — this was the false-at-write-time instance BUTCHR-169's own investigation found (and its boss independently confirmed and insisted on fixing forward, withdrawing an earlier instruction to file it elsewhere): this fleet's boss/worker relationship is carried ENTIRELY by Jira Implements issue links, never by Jira's native `parent` field, and SpawnSpec.parent read `issue.parent` directly before this ticket — EMPIRICALLY ALWAYS NULL for every issue in this project (verified against three live tickets, none carrying a `parent` field; every boss/worker relationship shows up only under `issuelinks`), not merely a value that could eventually go stale. scripts/migrate-links.ts confirms the history: this fleet MIGRATED from Jira's native parent field to Implements links for a predecessor project, so the old derivation was reading a field this fleet deliberately stopped populating. task.md/story.md's old text ('Your boss is the story named in your ticket, not {{PARENT}}' / 'Your parent epic is {{PARENT}}.') rendered a confusing, self-contradictory claim on EVERY spawn of a ticket with a real boss — reproduced live in this ticket's own workspace and in its boss BUTCHR-153's workspace, not merely asserted. Now that the derivation is honest, both templates were restored to assert {{PARENT}} plainly (see this ticket's diff) rather than routing around it — the fix closes the false claim at its source instead of teaching every reader to distrust a field that could have simply been made true.",
    withdrawnBy: null,
    neverWithdrawnReason:
      "A GENUINELY DIFFERENT shape than KEY's (both null, for different reasons — do not conflate them): this IS a live, in-use assertion, and it CAN still go stale in the one way any Implements-link-derived fact can — a ticket re-parented (relinked to a different boss) AFTER its workspace was already built. CORRECTED IN REVIEW (this ticket's own reviewer, on this same PR): an earlier draft of this reason claimed re-parenting 'isn't even a verb this fleet exposes' — FALSE, and reachable from the live tool roster, not a hypothetical: jira_link_issues (src/tools/defs.ts, calling ops.linkIssues) creates or changes an Implements link on an EXISTING issue, and adoptWorker's own refusal message (src/tools/relationship.ts: 'adopt_worker: ... is already linked to a different boss ... stealing another boss's worker must be an explicit act ... use jira_link_issues only if this is deliberate') names that exact verb as the sanctioned way to do it. So the gap this entry declares is REAL and REACHABLE, not merely theoretical — the honest justification for withdrawnBy: null is narrower than 'impossible': no verb in this codebase rewrites an ALREADY-BUILT workspace's brief.md when a re-parent happens via jira_link_issues (buildWorkspace runs once, at spawn time, and jira_link_issues never touches a workspace directory); the residual window this leaves is a ticket re-parented AFTER its workspace exists AND before any subsequent correct_worker summary correction re-derives {{PARENT}} fresh as a side effect (see SUMMARY's own withdrawnBy above — that path DOES repair PARENT opportunistically, just not on the re-parent event itself). Declared un-withdrawn because re-parenting an already-staffed, already-running ticket is judged rare on this fleet's own evidence (adopt_worker's refusal exists specifically to make it a deliberate, logged act rather than an accident), and building a DEDICATED rewrite/notify mechanism for this one narrow window — distinct from SUMMARY's, which already exists for an unrelated reason — was judged not worth it here. If jira_link_issues usage against already-staffed tickets turns out to be more common than assumed, this entry needs revisiting on that evidence, not by silent reuse of this reasoning.",
  },
  GROUND_TRUTH: {
    appliedBy:
      "interpolate() substitutes {{GROUND_TRUTH}} into CLAUDE.md ONLY (verified: no other briefs/*.md template references it) with groundTruthText(deriveGroundTruth(mcpUrl), buildIdentity, computeBuildCurrency(buildIdentity)) (src/agents/ground-truth.ts + src/agents/build-currency.ts), computed once by buildWorkspace. buildWorkspace ALSO writes the IDENTICAL text as ENVIRONMENT.md's entire standalone content — direct writeFileSync, never through interpolate()/a template, structurally invisible to both doors the same way mcp.json's x-issue is (see this file's header, 'WHAT THIS REGISTRY DOES NOT CLAIM'). BUTCHR-182 (implements BUTCHR-176) widened the SOURCE this entry's text is computed from: groundTruthText's signature grew a `build` (BUTCHR-54's frozen `BuildIdentity` singleton) and `currency` (a fresh-per-call `CurrencyVerdict` from build-currency.ts) parameter — the host/port/unit/pid fields and their write-once semantics are UNCHANGED by that widening.",
    notes:
      "Host/port/systemd unit/journalctl command/daemon pid, measured from the DAEMON's own process at workspace-build time — not the agent process this text lives next to. Every agent in this fleet is told this file is authoritative ('THEY ARE WRONG and this is right', groundTruthText's own wording) — a strong, unqualified claim with a real staleness window: if the daemon that built this workspace restarts (a redeploy, a crash-restart) while the agent it spawned keeps running, the pid (and possibly the port, on a redeploy that changes it) recorded here goes stale, and nothing rewrites it — the workspace directory is written exactly once, at spawn time. BUTCHR-182 adds a SECOND, DELIBERATELY NARROWER claim in the same block, under '## Build identity & currency': which build (sha/provenance/dirty/version) wrote this workspace, and a three-state currency verdict (current/stale-or-diverged/unknown) comparing that build's tree against the local `refs/remotes/origin/main` BY CONTENT (tree-object equality, not ancestry — a squash merge makes ancestry lie). That verdict speaks in the first person about the ONE daemon that computed it, never about 'the fleet' or 'the deploy' — this host is confirmed to run more than one butchr daemon, under different Unix users, and a currency claim is only ever true for the daemon that made it.",
    withdrawnBy: null,
    neverWithdrawnReason:
      "No verb in this codebase ever rewrites a running workspace's CLAUDE.md/ENVIRONMENT.md after buildWorkspace's one-time write, and an agent process has no reliable, cheap way to learn its own daemon has restarted from inside its own sandbox — it is never told, and there is no heartbeat. Declared deliberately un-withdrawn, not silently trusted: BUTCHR-169 added a `measured at: <ISO timestamp>` line to groundTruthText's own output (src/agents/ground-truth.ts) precisely so a careful reader has SOMETHING to weigh this claim against (how long has this agent actually been running relative to that timestamp?) — but that is a courtesy for a human or an unusually careful agent, never a machine check: nothing compares that timestamp to anything automatically, and this entry does not claim otherwise. BUTCHR-182 adds a SECOND staleness dimension on top of BUTCHR-169's, and this entry now states both honestly rather than only the older one: (1) the currency verdict's BASE side is a LOCAL remote-tracking ref, deliberately never fetched over the network on the agent-spawn path (a network call there can hang a spawn) — so even a `current` verdict means only 'matched the last `main` this daemon's own checkout already had', not 'matches `main` right now', and a `current` verdict is additionally gated on that base ref's OWN freshness being determinable at all (an undeterminable base freshness renders `unknown`, never a false `current` — the exact bug this mechanism exists to prevent, one level down, inside its own fix); (2) like the pid/port claim above, the currency verdict itself is a one-time snapshot — if the daemon is redeployed to a newer sha, or `origin/main` advances, WHILE an agent spawned from this workspace keeps running, nothing rewrites this block, and the agent has no way to learn that from inside its own sandbox. Flagged explicitly, not left to be discovered, because ENVIRONMENT.md is separately load-bearing (every brief in this fleet is told it is authoritative) — a silent staleness here could compound into an agent trusting a dead pid for a live-daemon-tree check, or trusting a currency verdict that was true at spawn time and has since gone stale itself.",
  },
};
