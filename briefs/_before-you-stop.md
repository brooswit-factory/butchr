## Before you stop or go idle

Everything below about transitioning, reading back, and moving through In
Progress/In Review/Done is about a Jira ISSUE's status. If what you own is
a project resource rather than a single Jira issue, you have no status of
your own to transition at all: never call `jira_transition` with a project
key — it is not an issue key. Apply the rules below only to an actual issue
you are directly working or reviewing, if any; skip them entirely for the
project resource itself, and post your before-you-stop comment on the
destination your own brief names instead.

You own keeping your own Jira lifecycle accurate; a status change is never
someone else's job to notice and apply for you. Before any transition,
freshly read this issue's current status, full comment history, holds and
dependencies, and current PR state — never transition off stale
information. Discover the live transition API/schema and the target
statuses actually available on THIS issue. Use the supported
`jira_transition` (key, status) by name if that tool is present; only when
it is absent should you instead discover this issue's own transition IDs
through the live, authorized API and use those — never hardcode or copy a
status name or a transition ID from another issue. Whether a particular
target status exists on THIS issue's workflow is a separate question from
which tool/API you use to make the call — discovering a transition ID
cannot make an unsupported target status exist; see the failure paragraph
below for what to do when the target status itself isn't available.

Move to In Progress when actual authorized implementation starts — the
transition itself is not proof staffing happened, only a record of it.

When your scoped work genuinely cannot proceed because of a confirmed
unresolved dependency, a required approval, a quota/capacity limit, denied
or missing access, or another actual hold, move the issue to To Do before
you stop or go idle — this blocked-work rule takes precedence over any
generic preference to stay In Progress for queue/staffing eligibility; do
not leave a genuinely blocked issue In Progress solely to keep it
query-eligible. Preserve every blocked label, approval/quota/dependency/
freeze/cancellation hold, the existing assignee, and all
implementation/PR/reviewer continuity — changing status grants no
permission, clears no blocker, and neither finishes nor cancels the work;
never close or abandon an existing PR merely because its issue moves to To
Do. Post one concise comment when the blocked state actually changes,
naming the concrete cause and evidence, the exact condition that unblocks
it, and the responsible next owner/action, alongside your verified actual
status from the readback below; don't repost the same still-true blocker
comment on every wake, and don't ask again for a decision already resolved
in the latest history. Ordinary pending CI or an active requested review is
not automatically a blocker — keep its truthful existing workflow state
unless there is an actual hold preventing the required next work, and
draft/revision work that can still continue stays In Progress. Before
moving a blocked issue back to In Progress, confirm the blocker is actually
resolved and authorized implementation has actually resumed; never infer
resolution from elapsed time, a label change, or merely waking up.

Move to In Review once all review-ready scoped work exists: a current-head
PR or artifact, with its tests and acceptance evidence, linked on the
issue. A draft PR, or a review that comes back CHANGES_REQUESTED, means
back to In Progress while you revise — In Review means "ready for someone
else to look at," not "work is happening." Reuse the existing
reviewer/review thread; do not open a duplicate review request.

Move to Done only once every scoped requirement has linked evidence, or an
explicit user waiver of that named requirement. Where the ticket requires
them, required review, merge, release/deployment and end-to-end acceptance
are part of Done — an approval, merged code, or green CI alone never
substitutes for acceptance that hasn't actually happened yet. Being
blocked, having posted a comment, the agent having stopped, or an
agent:working label changing is never by itself grounds to move to Done.
Preserve existing approval gates and do not infer a waiver that was never
actually given.

After every transition, read the issue back and verify the status actually
changed to what you asked for. If the transition failed, the target status
doesn't exist on this issue's workflow (the tool's error lists what's
available), it was denied, or the readback doesn't match: say so in your
comment — the exact operation you tried, the current (real) status, the
blocker, and who owns it next — and do not claim success or silently
substitute a different status, Done included; if the status you need
genuinely isn't available, leave the status as it is rather than picking a
different one. Respect any newer conflicting owner/user action,
cancellation or hold you find on the freshly-read issue — it wins over
whatever transition you were about to make.

Before you stop or go idle you MUST post a comment on this ticket: what you
did, links (PR/commit), the actual verified status from the readback above
(not merely the one you requested), the test/acceptance evidence, what is
left, anything blocking you, and who owns the next step. No silent stops.
Don't repost the same still-true comment on every wake; post again only
when something has actually changed.

When the work has a pull request, request review from whoever is most
appropriate (`gh pr edit <pr> --add-reviewer <login>`): the CODEOWNERS for
the files you changed; if there are none, the people who most recently
changed those files (`git log`); if that's unclear, the ticket's reporter.
Never request yourself or a bot. Name the reviewers, and why them, in your
closing comment.
