/**
 * BUTCHR-257: the declared, executable half of `test/unit/brief-tool-
 * surface.test.ts`'s coverage claim that the FORWARD check (BUTCHR-48) never
 * made — which verb in the real tool registry (`atlassianTools()`, `src/
 * tools/defs.ts`) is expected to be taught by at least one shipped brief
 * (`briefs/*.md`), and when the answer is "no," a written, non-empty reason
 * why not. Kept ADJACENT to the registry, not inside the test file, the same
 * way `alias-audit.ts` already sits beside `defs.ts` for the alias-
 * classification half of this same registry — a maintainer adding a verb to
 * `defs.ts` finds this file the same way.
 *
 * THE DEFECT THIS CLOSES: the forward check only ever asserted "every brief-
 * named verb exists in the registry" — it caught a brief naming a renamed or
 * removed verb, but a verb that ships in the registry and is named by NO
 * brief passed silently, and nothing in the test, its name, or its doc
 * comment said so. This file turns that missing direction into a total,
 * per-verb declaration: `BRIEF_COVERAGE` below must carry EXACTLY one entry
 * per registry verb (checked by `brief-tool-surface.test.ts`'s own coverage
 * test — an unlisted new verb, or a stale entry naming a verb no longer in
 * the registry, both fail loud), and a `taught: true` entry is not merely a
 * hopeful label: that same test file re-derives every verb actually named by
 * `briefs/*.md`, using the SAME `extractVerbs` extraction rule the forward
 * check already uses, and fails if a `taught: true` entry isn't corroborated
 * by that real text.
 *
 * WHAT `taught: true` DOES NOT CLAIM: only that at least one shipped brief
 * names this verb in a backticked call — not that every tier that could use
 * it does, not that the surrounding prose is correct, and not that brief
 * coverage changes agent behaviour (UNMEASURED — see BUTCHR-257's own
 * ticket; do not read the paragraph above as asserting adoption impact).
 *
 * WHY NOT A PER-TIER BREAKDOWN: BUTCHR-257's ticket floats "which tier's
 * brief is expected to teach this verb" as one possible shape. Rejected here
 * on purpose — several `taught: true` verbs are legitimately taught by only
 * a SUBSET of tiers (e.g. `confluence_search_pages`/`confluence_list_spaces`
 * by story.md/epic.md only, `check_in`/`get_doc_comments`/`list_peers`/
 * `tell_peer` by project.md only), and declaring an "expected tier set" per
 * verb would be a SECOND hand-written list this mechanism would then have to
 * keep in sync with the first, rebuilding the exact one-list-goes-stale
 * failure this epic exists to close, one level up. The actual defect
 * measured on this ticket is "taught by no brief at all," not "taught by the
 * wrong subset of briefs" — this file closes the former and does not claim
 * the latter.
 *
 * DO NOT derive `taught: false`'s reasons below from `aliasTag`/`AliasClass`
 * (`src/tools/alias-audit.ts`). BUTCHR-257 measured that today's 8 untaught
 * verbs are exactly the aliasTag-carrying deprecated aliases — worth keeping
 * as evidence the exclusions are principled, not a coincidence to couple
 * this file to: `aliasTag` classifies a PER-CALL audit line's shape at
 * runtime; this file declares a PER-VERB teaching intent, checked against
 * static brief text. The two answer different questions and can drift apart
 * from each other without either one being wrong — this file's reasons are
 * written independently, from each verb's own `defs.ts` description.
 *
 * `taught: false` IS ALSO RE-VERIFIED, NOT JUST A LABEL (BUTCHR-257 review
 * round 1): `brief-tool-surface.test.ts`'s `findTaughtFalseButNamedVerbs`
 * checks the converse of `findFalselyTaughtVerbs` above — a `taught: false`
 * entry whose verb a real brief NOW names fails loud, naming the verb and
 * its stated reason, so a reason that quietly stops being true (someone
 * starts teaching a verb this file still claims no brief teaches) cannot
 * sit unnoticed the way the ORIGINAL forward-only guard let the whole
 * reverse direction sit unnoticed. Measured directly at review: appending
 * "Use `jira_transition` to move your ticket." to `briefs/task.md` — while
 * `jira_transition`'s entry still read `taught: false` — left the suite
 * fully green, because `findFalselyTaughtVerbs` only ever filters on
 * `entry.taught` and never checks a `false` entry against `extracted` in
 * either direction. That gap is what this paragraph and the converse
 * function close.
 *
 * THE HONEST LIMIT OF THAT CHECK, STATED RATHER THAN HIDDEN (same discipline
 * `src/media/blind-spot.ts` and this file's own merge-check-guard.test.ts
 * precedent use for a known hole): `extractVerbs` cannot distinguish
 * TEACHING a call from MENTIONING the verb for any other reason — a future
 * brief writing "never call `jira_transition`; use start_worker instead" is
 * indistinguishable, to a regex over backticked spans, from a brief
 * genuinely teaching `jira_transition` as a call. That sentence would flip
 * `findTaughtFalseButNamedVerbs` red even though nothing is actually wrong.
 * This is a DELIBERATE trade-off, not an oversight: a check that occasionally
 * demands a human judgment call on a rare, specific sentence shape is worth
 * more than one that stays silent forever while a reason quietly rots — the
 * same judgment this repo's own `BASE_MERGE_CAVEAT`
 * (`merge-check-guard.test.ts`) makes explicit for its own known hole: "this
 * assertion SHOULD go red... telling you the pinned text must be updated,
 * not that the test is broken." If this check ever fires on a genuine
 * non-teaching mention: either verify the verb really is now taught and
 * flip its entry to `taught: true`, or rephrase the brief so the mention
 * isn't a bare/paren-call-shaped backticked span (`extractVerbs`'s own doc
 * comment already names this exact imprecision — "does not understand
 * prose... beyond pulling out the verb itself" — as a pre-existing,
 * accepted limit of the extraction rule, not something new introduced
 * here) — never delete or weaken this check to silence a real,
 * honestly-explained false positive.
 */

export type BriefCoverageEntry =
  | { readonly taught: true }
  | { readonly taught: false; readonly reason: string };

/**
 * One entry per verb `atlassianTools()` ships, keyed by verb name. See this
 * file's header for what `taught: true` does and does not claim, and for why
 * a `taught: false` entry's `reason` is written by hand rather than derived
 * from `alias-audit.ts`.
 */
export const BRIEF_COVERAGE: Readonly<Record<string, BriefCoverageEntry>> = {
  jira_get_issue: { taught: true },
  jira_search: { taught: true },
  jira_link_issues: {
    taught: false,
    reason:
      "generic link creation superseded by new_worker/adopt_worker's own Implements-link handling, which a brief teaches instead. Its own description still sanctions it for a non-Implements link (Blocks, Relates, …) or a deliberate boss-reassignment override — neither of those is a call a brief needs to teach.",
  },
  jira_add_comment: { taught: true },
  jira_transition: {
    taught: false,
    reason:
      "generic status transition fully superseded by the relationship verbs a brief does teach (start_worker/finish_worker/shelve_worker/submit_to_boss/finish_without_a_boss) — its own description names no other blessed use.",
  },
  jira_create_issue: {
    taught: false,
    reason:
      "generic issue creation superseded by new_worker (staffing a worker under the caller) and file_where_it_belongs (deliberate orphans), both of which a brief teaches instead. Its own description still sanctions an Epic (new_worker never creates one) and implements:\"none\" — neither needs brief coverage of this call.",
  },
  jira_set_priority: {
    taught: false,
    reason: "generic priority write fully superseded by prioritize_worker, which a brief does teach — its own description names no other blessed use.",
  },
  jira_assign: {
    taught: false,
    reason:
      "generic reassignment superseded by adopt_worker for the adoption case, which a brief teaches instead. Its own description still sanctions a raw reassignment that isn't an adoption — a brief doesn't need to teach that narrower, rarer call.",
  },
  confluence_create_page: {
    taught: false,
    reason: "raw Confluence page CRUD for a page that ISN'T a ticket's own doc; a brief teaches set_doc for the ticket-doc case, which covers what an agent actually needs.",
  },
  confluence_update_page: {
    taught: false,
    reason: "raw Confluence page CRUD for a page that ISN'T a ticket's own doc; a brief teaches set_doc for the ticket-doc case, which covers what an agent actually needs.",
  },
  confluence_search_pages: { taught: true },
  confluence_get_page: {
    taught: false,
    reason: "raw Confluence page CRUD for a page that ISN'T a ticket's own doc; a brief teaches get_doc for the ticket-doc case, which covers what an agent actually needs.",
  },
  confluence_list_spaces: { taught: true },
  get_doc: { taught: true },
  set_doc: { taught: true },
  new_worker: { taught: true },
  start_worker: { taught: true },
  shelve_worker: { taught: true },
  adopt_worker: { taught: true },
  check_worker: {
    taught: false,
    reason:
      "NOT a deprecated alias — unlike every other taught:false entry here, this is a live, current verb (BUTCHR-244). It is a DIAGNOSTIC reached for at the moment a specific question arises (\"is my worker actually staffed?\"), and the three verbs that raise that question — new_worker, start_worker and adopt_worker, all of which briefs do teach — each point at it from their own description's STAFFING paragraph, so an agent meets it exactly when it needs it (verified in defs.ts at this commit, not inherited: all three say \"use `check_worker` ... to actually find out\"). A brief teaching it up front would be teaching a check for a condition the agent has not hit yet. If that stops being true — if a brief starts naming it, or the sibling descriptions stop pointing at it — flip this entry rather than editing this reason to fit.",
  },
  finish_worker: { taught: true },
  prioritize_worker: { taught: true },
  correct_worker: { taught: true },
  tell_worker: { taught: true },
  report_to_boss: { taught: true },
  ask_boss: { taught: true },
  check_in: { taught: true },
  get_doc_comments: { taught: true },
  list_peers: { taught: true },
  tell_peer: { taught: true },
  submit_to_boss: { taught: true },
  finish_without_a_boss: { taught: true },
  file_where_it_belongs: { taught: true },
};
