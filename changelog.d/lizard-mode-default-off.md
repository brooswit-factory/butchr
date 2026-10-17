bump: minor

### Changed

- A rule is lizard-mode eligible only when it sets `lizardMode: true`. Since
  FACTORY-138 a rule that left the field out was eligible, so the
  permission-answer timer answered its tool-permission prompts, while the
  dashboard showed such a rule's lizard mode as off: the edit dialog starts
  from `lizardMode ?? false`, and the create dialog saves an unticked box as
  no field at all. Absent now means off, so the dashboard and the daemon
  agree. A rule that wants unattended prompt-clearing sets `lizardMode: true`.
  Managed sessions are unchanged (`vendor: "claude"` still defaults to
  eligible).
