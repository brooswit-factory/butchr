import type { LinkedChangeEvent, NotifyReason } from "../resources/types.js";

/**
 * BUTCHR-87: the daemon nudge and the `[notify]` log line for every
 * NotifyReason member EXCEPT `pr` — that one keeps its own dedicated
 * rendering, `prReviewStateNudge` (src/agents/pr-nudge.ts), guarded by
 * test/unit/merge-check-guard.test.ts and deliberately NOT touched by this
 * ticket (see that file's own doc comment, and src/resources/types.ts's
 * NotifyReason doc comment, for why). `changeNudge` and `notifyReasonTag`
 * below are this module's own precedent-following pair: exported functions
 * a test can assert the RENDERED string against, same as `prReviewStateNudge`
 * — not text built inline in src/daemon/index.ts, which a test could only
 * reach by pattern-matching daemon source.
 *
 * Both functions are built on the same `reasonClause` so the two audiences
 * (an agent deciding whether to act, an operator reading the daemon's own
 * log) never drift on WHAT happened — only on how much sentence surrounds
 * it. Widening `NotifyReason` again (a new member) means widening
 * `reasonClause` and `notifyReasonTag` together, in the same commit, for
 * the same reason src/resources/issue.ts's decide() comment gives: a stale
 * renderer beside a correct type is the failure mode this epic exists to
 * kill.
 */

/**
 * BUTCHR-34 (epic comment on this ticket): a bare "updated" is ambiguous
 * between "the poll genuinely could not tell" and "this class was never
 * wired up" — the reader would act on those two differently. This phrase is
 * the honest, distinguishable fallback: it says the classifier ran and came
 * up with nothing in its taxonomy, not that nobody looked. Used whenever
 * `decide()` (src/resources/issue.ts) delivers with no `reason` at all
 * (still possible from a caller that never populates `reason`, e.g. the
 * project tier) OR with `reason: { undetermined: ... }` (BUTCHR-350) — the
 * issue tier's own three-way split of "could not tell" (see
 * NotifyReason's own doc comment, src/resources/types.ts) collapses back to
 * this SAME agent-facing sentence: the finer distinction is operator-facing
 * forensics (`notifyReasonTag` below), not something an agent acting on its
 * own ticket needs to see.
 */
const REASON_NOT_DETERMINABLE = "reason not determinable from the poll";

/**
 * The short, present-tense fact-clause for one non-`pr` NotifyReason — a
 * verb phrase meant to follow "Ticket X " / "About-ticket " (see
 * `changeNudge`), not a full sentence on its own. `pr` is deliberately
 * unreachable here in practice (see this module's top comment) but handled
 * defensively rather than asserted unreachable, since a caller passing one
 * through by mistake should get the honest fallback, not a crash or a
 * silently wrong label.
 */
function reasonClause(reason: NotifyReason | undefined): string {
  // BUTCHR-436: `linked` is deliberately unreachable here in practice, same
  // as `pr` — it renders via its own `linkedChangeNudge` below, never this
  // function's "related to your X" framing (a coalesced linked-change nudge
  // names every changed link itself; it has no single "about" clause to
  // append). Handled defensively rather than asserted unreachable, for the
  // same reason `pr` already is.
  //
  // FACTORY-417: `definitionField` is the same shape of "unreachable here in
  // practice" — it renders via its own `sessionDefinitionFieldNudge` below,
  // wired directly by src/daemon/session-definitions-loop.ts, never through
  // `changeNudge` (only Jira-issue-shaped resources call this function).
  // Folded into the same defensive fallback rather than given its own
  // clause here, for the same reason `pr`/`linked` are.
  // FACTORY-997: `confluencePageEdit`/`confluencePageComment` are the same
  // shape of "unreachable here in practice" as `linked`/`definitionField`
  // above — a standalone Confluence page has no Jira-issue-shaped agent to
  // call `changeNudge` for it (src/resources/confluence-page.ts's own
  // event rules have no wiring into src/daemon/index.ts's issue-tier nudge
  // path at all). Folded into the same defensive fallback for the same
  // reason.
  if (!reason || "pr" in reason || "undetermined" in reason || "linked" in reason || "definitionField" in reason || "confluencePageEdit" in reason || "confluencePageComment" in reason) return `was updated (${REASON_NOT_DETERMINABLE})`;
  if ("appeared" in reason) return "just appeared in the watch set";
  if ("disappeared" in reason) return "just dropped out of the watch set";
  if ("status" in reason) return `changed status from "${reason.status.from}" to "${reason.status.to}"`;
  if ("label" in reason) {
    const { prefix, from, to } = reason.label;
    return `changed its ${prefix}:* label from ${prefix}:${from ?? "none"} to ${prefix}:${to ?? "none"}`;
  }
  if ("summary" in reason) return "had its summary edited";
  // FACTORY-922: assignee/description/issuelinks are the three further
  // confirmed-diff classes the resolved FACTORY-921 decision adds — see
  // NotifyReason's own doc comment.
  if ("assignee" in reason) return `was reassigned from ${reason.assignee.from ?? "unassigned"} to ${reason.assignee.to ?? "unassigned"}`;
  if ("description" in reason) return "had its description edited";
  if ("issuelinks" in reason) {
    const { added, removed } = reason.issuelinks;
    const parts: string[] = [];
    if (added.length) parts.push(`linked to ${added.join(", ")}`);
    if (removed.length) parts.push(`unlinked from ${removed.join(", ")}`);
    return `had its linked issues changed (${parts.join("; ")})`;
  }
  // FACTORY-949: named explicitly (never folded into the `label` clause
  // above) since the TWO producers of this reason (issue.ts's boss wake,
  // project.ts's manager wake) need the SAME wording whether `about` is the
  // blocked ticket itself or the project that owns it — see NotifyReason's
  // own doc comment.
  if ("blocked" in reason) return `has its ticket ${reason.blocked.key} newly agent:blocked — it needs you`;
  // FACTORY-972: same "named explicitly, same wording for both producers"
  // reasoning as `blocked` just above — see NotifyReason's own doc comment.
  if ("stalled" in reason) return `has its ticket ${reason.stalled.key} newly agent:stalled — it needs you`;
  // BUTCHR-351: `reason.comment === null` means the mover was a comment
  // DELETION, not an addition (see NotifyReason's own doc comment) —
  // "got a new comment" would be actively wrong there.
  return reason.comment === null ? "had a comment removed" : "got a new comment"; // "comment" in reason
}

/**
 * The agent-facing channel push for every NotifyReason except `pr` (see
 * this module's top comment — `pr` renders via `prReviewStateNudge`
 * instead). Mirrors the two audiences src/daemon/index.ts's old inline
 * ternary already distinguished: `about === issue` is the ticket's own
 * agent hearing about itself; anything else is a boss/watcher hearing about
 * something it watches via the Implements chain, told explicitly to act on
 * what changed rather than just re-read.
 */
export function changeNudge(issue: string, about: string, reason: NotifyReason | undefined): string {
  const clause = reasonClause(reason);
  return about === issue
    ? `[butchr] Ticket ${issue} ${clause} — re-read it.`
    : `[butchr] ${about} (related to your ${issue}) ${clause} — re-read it, then act on what changed.`;
}

/**
 * The operator-facing `[notify]` log-line tag for ANY NotifyReason,
 * `pr` included — this is the direct successor to src/daemon/index.ts's old
 * inline `transitionTag` ternary (` (pr:from→pr:to)` or `""`), now covering
 * every class instead of only pr:*, and never empty: a delivery that
 * genuinely could not be explained now says so (` (reason: not
 * determinable)`) instead of appending nothing, so the measurement this
 * ticket is answering (`grep '\[notify\]'` — see BUTCHR-34's own journal
 * counts) stays reproducible: every line names why it fired, or says
 * plainly that the poll could not tell.
 *
 * BUTCHR-350 (§3D): two changes to the `comment`/no-reason members, both
 * ADDITIVE to this line's existing shape — `[notify]` itself, and every
 * other reason's rendering, are byte-for-byte unchanged, so no distinct tag
 * is warranted (AC4's concern is a READER silently misparsing an OLD line
 * as a NEW one, or vice versa; nothing in this codebase parses `[notify]`
 * lines programmatically today — grep is the only consumer, and every
 * pre-existing grep pattern this ticket is aware of still matches):
 *   1. `comment` now carries the moved-to comment id (`{comment: string}`,
 *      widened from a bare `true`) — rendered as `(comment:<id>)`, a
 *      SUPERSET of the old `(comment)` literal for any `grep '(comment'`
 *      (prefix, not exact-string) reader. Lets a reader recognise a LATER
 *      `(comment:<id>)` delivery and an EARLIER `(reason: not
 *      determinable …)` delivery for the same key as the SAME underlying
 *      change once the id is known on at least one of the pair — see
 *      `NotifyReason`'s own doc comment (src/resources/types.ts) for how
 *      `decide()` sometimes learns the id even on the earlier delivery now.
 *   2. `reason: { undetermined: ... }` (new — src/resources/issue.ts's
 *      `decide()` emits this INSTEAD OF a bare no-`reason` fallback now)
 *      renders as one of three DISTINCT sentences, replacing the one
 *      collapsed `(reason: not determinable)` that used to cover all three
 *      facts — see NotifyReason's own doc comment for exactly which fact
 *      each one states. `reason: undefined` itself (still possible from a
 *      caller that never populates it) is UNCHANGED: still the bare
 *      `(reason: not determinable)`, pinned by this module's own test
 *      against the literal pre-BUTCHR-350 string.
 */
export function notifyReasonTag(reason: NotifyReason | undefined): string {
  if (!reason) return " (reason: not determinable)";
  if ("linked" in reason) return ` (linked:${reason.linked.events.length})`;
  // FACTORY-417: unreachable via `notifyRuleAgent` in practice (managed
  // sessions log their own `[notify]` line in src/daemon/session-definitions-loop.ts's
  // `deps.deliver` caller, never through this tag) — handled defensively,
  // same precedent as every other member above.
  if ("definitionField" in reason) {
    const fields = Object.keys(reason.definitionField);
    return ` (definitionField:${fields.join(",")})`;
  }
  if ("pr" in reason) return ` (pr:${reason.pr.from ?? "none"}→pr:${reason.pr.to})`;
  if ("appeared" in reason) return " (appeared)";
  if ("disappeared" in reason) return " (disappeared)";
  if ("status" in reason) return ` (status:${reason.status.from}→${reason.status.to})`;
  if ("label" in reason) return ` (${reason.label.prefix}:${reason.label.from ?? "none"}→${reason.label.prefix}:${reason.label.to ?? "none"})`;
  if ("summary" in reason) return " (summary changed)";
  if ("assignee" in reason) return ` (assignee:${reason.assignee.from ?? "none"}→${reason.assignee.to ?? "none"})`;
  if ("description" in reason) return " (description changed)";
  if ("issuelinks" in reason) return ` (issuelinks:+${reason.issuelinks.added.length}/-${reason.issuelinks.removed.length})`;
  if ("undetermined" in reason) {
    if (reason.undetermined === "check-failed") return " (reason: could not check — comments fetch failed)";
    if (reason.undetermined === "checked-unchanged") return " (reason: not determinable — checked comments, unchanged)";
    return " (reason: not determinable — comments not checked this poll)"; // "unchecked"
  }
  // BUTCHR-351: `reason.comment` can now be `null` (the comment-deletion
  // edge — see NotifyReason's own doc comment) — rendered as the honest
  // `comment:deleted`, never the literal string "null" a bare template
  // would produce. Still a `(comment:` PREFIX, so AC4's own reasoning for
  // why no distinct tag is warranted (this module's top comment) still
  // holds: additive, not a meaning change to the existing shape.
  if ("comment" in reason) return ` (comment:${reason.comment === null ? "deleted" : reason.comment})`;
  if ("blocked" in reason) return ` (blocked:${reason.blocked.key})`; // FACTORY-949
  if ("stalled" in reason) return ` (stalled:${reason.stalled.key})`; // FACTORY-972
  // FACTORY-997: same "unreachable via notifyRuleAgent in practice" shape
  // as `definitionField` above — a standalone Confluence page's own event
  // rules (src/resources/confluence-page.ts) are not wired into this tag's
  // caller at all (no production `[notify]` line is ever produced for
  // them yet; see that module's top comment on scope). Handled explicitly
  // rather than folded into an untyped fallback, so a future wiring-in
  // gets a tag "for free" rather than reopening this function.
  if ("confluencePageEdit" in reason) return ` (confluencePageEdit:${reason.confluencePageEdit.from}→${reason.confluencePageEdit.to})`;
  return ` (confluencePageComment:${reason.confluencePageComment.ids.length})`; // "confluencePageComment" in reason
}

/**
 * The agent-facing push for a `github-issue` agent's own issue. Names the
 * tool to re-read with, since a GitHub agent has no Jira tools; carries no
 * GitHub-authored text (see src/rules/github-issue-type.ts).
 */
export function githubIssueNudge(resource: string, reason: NotifyReason | undefined): string {
  const clause = reason && "summary" in reason ? "had its title edited" : reasonClause(reason);
  return `[butchr] GitHub issue ${resource} ${clause} — re-read it with github_get_issue.`;
}

/**
 * FACTORY-57: the agent-facing push for a `github-pr` agent's own pull
 * request — `githubIssueNudge`'s twin, naming `github_get_pr` (the PR
 * provider's own re-read tool, src/tools/github-pr.ts) since a `github-pr`
 * agent has no `github_get_issue`/Jira tools either. Carries no
 * GitHub-authored text (see src/rules/github-pr-type.ts). `reasonClause`'s
 * `"status"` clause already reads naturally for a PR (`changed status from
 * "open" to "closed"`); merged-vs-closed-without-merging is the caller's
 * own `decideGithubPr` (src/rules/github-pr-type.ts) choice of `from`/`to`
 * strings ("merged" or the raw state), not something this renderer needs to
 * know about.
 */
export function githubPrNudge(resource: string, reason: NotifyReason | undefined): string {
  const clause = reason && "summary" in reason ? "had its title edited" : reasonClause(reason);
  return `[butchr] GitHub pull request ${resource} ${clause} — re-read it with github_get_pr.`;
}

/**
 * The agent-facing push for a `zendesk-ticket` agent's own ticket. Names the
 * tool to re-read with; carries no customer-authored text (see
 * src/rules/zendesk-ticket-type.ts).
 */
export function zendeskTicketNudge(resource: string, reason: NotifyReason | undefined): string {
  const clause = reason && "summary" in reason ? "had its subject edited" : reasonClause(reason);
  return `[butchr] Zendesk ticket ${resource} ${clause} — re-read it with zendesk_get_ticket.`;
}

/**
 * The agent-facing push for a `jira-idea` agent's own idea. Names the tool to
 * re-read with, since an idea agent has no Jira work tools.
 */
export function jiraIdeaNudge(resource: string, reason: NotifyReason | undefined): string {
  return `[butchr] Jira Product Discovery idea ${resource} ${reasonClause(reason)} — re-read it with jira_idea_get.`;
}

/**
 * BUTCHR-436 (epic BUTCHR-421, story 2/4): the coalesced linked-Jira-item
 * nudge — one summary line, then one `<target> (<kind>): <detail>` line per
 * event, for every changed/unreadable/removed Jira-kind link a `jira-work`
 * rule's `linkedEventing` poll tick found for ONE owning resource. A sibling
 * of `changeNudge` above, kept separate (rather than folded into it, or into
 * `reasonClause`) because its shape is fundamentally different: a plural,
 * multi-line summary of everything that changed in ONE tick, not a single
 * present-tense clause about the resource's own change — see
 * `src/jira-watch/linked-eventing.ts` for how one tick's worth of
 * `LinkedChangeEvent`s is assembled before reaching here. `issue` is the
 * owning resource's own Jira key (this story's coalescer never fires for
 * anyone else). Never empty: `events` is guaranteed non-empty by the
 * coalescer (a tick with nothing to report never calls this at all).
 */
export function linkedChangeNudge(issue: string, events: readonly LinkedChangeEvent[]): string {
  const n = events.length;
  const summary = `[butchr] ${issue}: ${n} linked Jira item${n === 1 ? "" : "s"} changed — re-read them.`;
  const lines = events.map((e) => `${e.target} (${e.kind}): ${e.detail}`);
  return [summary, ...lines].join("\n");
}

/**
 * The agent-facing push for a `filesystem` agent's own resource. Names no
 * tool (there is none — a filesystem agent reads/edits its resource directly
 * with its own file tools; see src/rules/filesystem-type.ts).
 */
export function filesystemNudge(resource: string, reason: NotifyReason | undefined): string {
  return `[butchr] Filesystem resource ${resource} ${reasonClause(reason)} — re-read it from disk.`;
}

/**
 * FACTORY-417 (story FACTORY-412, epic FACTORY-394): the content-push nudge
 * for a managed-session definition's `brief`/`workingDirectory` edit —
 * `session-definitions-loop.ts`'s `notify` callback renders THIS instead of
 * `filesystemNudge` above whenever `decide()` (src/rules/session-definition-type.ts)
 * detects one of those two fields moved, and falls back to `filesystemNudge`
 * for every other definition-field edit exactly as before (see that
 * function's own top comment).
 *
 * PUSHES THE NEW VALUE DIRECTLY, rather than telling the agent to re-read
 * `brief.md`/re-`cd`, because the survey this ticket implements
 * (`docs/session-field-reload-classification.md`, the `brief`/
 * `workingDirectory` rows) establishes that `buildWorkspace()` — the ONLY
 * code path that ever rewrites `brief.md` on disk — runs exclusively from
 * the spawn/resume path (`HerdrHerd.spawnExclusive`'s `prepare()` and
 * `resumeInPlaceExclusive`'s post-success re-persist, src/agents/herd.ts),
 * never from an ordinary poll against an already-running, non-stale agent.
 * A `brief`/`workingDirectory` edit on a live agent is, by this ticket's own
 * scope, never routed through `resumeInPlace()` or a respawn — so
 * `brief.md` on disk is NOT rewritten when this nudge fires, and "re-read
 * your brief.md" would point the agent at STALE content with no race to
 * even win: the file simply never changes underneath a live agent this
 * mechanism touches. Pushing the new text directly has no such dependency
 * on daemon-internal timing — it is exactly as reliable as `herd.nudge`
 * delivering the message at all, the same guarantee every other
 * `NotifyReason` nudge in this module already rests on.
 *
 * `changes` carries only the field(s) that actually moved this poll (see
 * `NotifyReason`'s own `definitionField` doc comment, src/resources/types.ts)
 * — both keys are rendered when both changed in the same poll, each its own
 * sentence, so a reader (agent or operator) never has to guess whether an
 * omitted field is "unchanged" or "not reported here."
 */
export function sessionDefinitionFieldNudge(resource: string, changes: { brief?: string; workingDirectory?: string }): string {
  const sentences: string[] = [];
  if (changes.brief !== undefined) sentences.push(`its brief changed — act on this new brief now:\n\n${changes.brief}`);
  if (changes.workingDirectory !== undefined) sentences.push(`its working directory changed — operate in ${changes.workingDirectory} from now on (this does not move your process's actual shell cwd; treat it as an instruction, not a signal anything already moved)`);
  return `[butchr] Managed-session definition ${resource} was edited: ${sentences.join(" Separately, ")}.`;
}

/**
 * The push for a `jira-idea` agent about a GitHub issue its idea links to
 * (src/rules/jira-idea-type.ts). Identity and reason only, never GitHub text;
 * an idea agent has no GitHub tools, so it names the link-listing tool.
 */
export function jiraIdeaLinkedGithubNudge(idea: string, githubIssue: string, reason: NotifyReason | undefined): string {
  const clause = reason && "summary" in reason ? "had its title edited" : reasonClause(reason);
  return `[butchr] GitHub issue ${githubIssue}, linked from your Jira Product Discovery idea ${idea}, ${clause} — see the idea's GitHub links with jira_idea_github_issues.`;
}
