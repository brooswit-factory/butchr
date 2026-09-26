bump: patch

### Fixed

- Agent briefs (`briefs/task.md`, `bug.md`, `story.md`, `epic.md`,
  `project.md`, `default.md`) no longer tell an agent its ticket "already
  has" a linked Confluence doc, or instruct it to keep one current — that
  workflow was retired by FACTORY-84/FACTORY-86, and the prose had not
  caught up. Each now documents the actual, on-request flow instead:
  `confluence_create_page` with an explicit space and (optionally) a parent
  named by whoever asked, and that `set_doc` refuses outright when a ticket
  has no existing doc. A boss's review-step language now checks a worker's
  doc only when one was explicitly requested and exists, rather than
  assuming every worker has one. `project.md`'s root-doc guidance (a
  project's root doc is unaffected by FACTORY-84/FACTORY-86 and still needs
  to stay current) is preserved, with the one sentence that implied a
  per-ticket doc gets created for one of the project's own epics removed.
- `src/tools/brief-coverage.ts`: `confluence_create_page` is now declared
  `taught: true`, since the on-request guidance above teaches it directly —
  it was `taught: false` under the old assumption that no brief would ever
  name it as a routine call.
