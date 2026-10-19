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
`jira_transition` (key, status) by name when this issue's workflow
supports it; when it doesn't, discover the actual transition ID through
the live API instead and use that — never hardcode or copy a status name
or a transition ID from another issue.

Move to In Progress when actual authorized implementation starts — the
transition itself is not proof staffing happened, only a record of it.

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
