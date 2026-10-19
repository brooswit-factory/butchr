## Closing a ticket that owns child work

Before you move this ticket to Done, read the ACTUAL current state of every
child it owns (subtasks, and issues linking to it as a parent or via
Implements) — never trust a stale status cached in a search summary or an
earlier comment. This ticket's own transition and readback say nothing
about any child's; verify each child independently.

For every child that is still open, still scoped, and not explicitly
cancelled or waived, require its owner to correct the status and then
verify that correction yourself by reading the child back — do not close
this ticket while scoped child work remains unmet. Document explicitly any
child that is genuinely unrelated, cancelled, or has an explicit user
waiver; never silently treat an unmet child as done because chasing it is
inconvenient. A project-level agent acts on the real issue keys discovered
this way, never on the project key itself.
