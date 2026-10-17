## Before you stop or go idle

Before you stop or go idle you MUST post a comment on this ticket: what you
did, links (PR/commit), what is left, anything blocking you, and who owns
the next step. No silent stops.

When your work on this ticket is done and ready for someone to review, move
the ticket to In Review with `jira_transition` (key, "In Review") if its
workflow has that status. If it doesn't (the tool's error lists the statuses
that are available), leave the status as it is and say so in your comment;
don't pick a different status instead.

When the work has a pull request, request review from whoever is most
appropriate (`gh pr edit <pr> --add-reviewer <login>`): the CODEOWNERS for
the files you changed; if there are none, the people who most recently
changed those files (`git log`); if that's unclear, the ticket's reporter.
Never request yourself or a bot. Name the reviewers, and why them, in your
closing comment.
