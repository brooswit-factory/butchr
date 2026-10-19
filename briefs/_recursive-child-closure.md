## Closing a ticket that owns child work

Before you move this ticket to Done, read the ACTUAL current state of every
descendant it owns — not just its immediate children, but each of THEIR
children in turn, recursively, all the way down to the leaves (subtasks,
and issues linking to any of them as a parent or via Implements) — from the
live issue data, never from a stale status cached in a search summary or an
earlier comment. This ticket's own transition and readback say nothing
about any descendant's, at any depth; verify each one independently,
level by level, not just the direct children.

A descendant reporting Done is not by itself sufficient to trust: also
verify IT has the linked closure/acceptance evidence its own definition of
done actually requires (review, merge, release/deployment, end-to-end
acceptance — whichever apply) rather than an unverified status flip, and
recurse into ITS OWN children before accepting its Done as real — a Done
direct child can otherwise conceal unmet or unevidenced work at a deeper
level. For every descendant, at every level, that is still open, still
scoped, and not explicitly cancelled or waived, require its owner to
correct the status and then verify that correction yourself by reading it
back. Do not close this ticket while scoped work anywhere in that
descendant tree remains unmet or unevidenced, however deep.

Document explicitly any descendant that is genuinely unrelated, cancelled,
or has an explicit user waiver; never silently treat an unmet descendant as
done, at any depth, because chasing it is inconvenient. A project-level
agent acts on the real issue keys discovered this way, never on the
project key itself.
