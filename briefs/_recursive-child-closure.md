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
acceptance — whichever apply), and recurse into ITS OWN children, before
accepting its Done as real. A Done that lacks that evidence, or that hides
unresolved descendants underneath it, is a STALE status exactly like a
status that never advanced — require its owner to correct it to whatever
the real state actually is, then verify that correction yourself by
reading it back, the same way you would for work that is stuck. Genuinely,
accurately open, in-scope work that is not cancelled or waived needs no
such correction from its owner — it already carries the right status; it
simply blocks this ticket from closing until it resolves. Do not close
this ticket while scoped work anywhere in that descendant tree remains
unmet or unevidenced, however deep — whether that work is honestly still
open or hiding behind a false Done.

Document explicitly any descendant that is genuinely unrelated, cancelled,
or has an explicit user waiver; never silently treat an unmet descendant as
done, at any depth, because chasing it is inconvenient. A project-level
agent acts on the real issue keys discovered this way, never on the
project key itself.
