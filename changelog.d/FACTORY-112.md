bump: patch

### Fixed

- Agent briefs (`briefs/task.md`, `bug.md`, `story.md`, `epic.md`,
  `project.md`, `default.md`) no longer tell an agent its ticket "already
  has" a linked Confluence doc, or instruct it to keep one current — that
  workflow was retired by FACTORY-84/FACTORY-86, and the prose had not
  caught up. Each now documents the actual, on-request flow instead:
  `confluence_create_page` with an explicit space and parent (named
  directly, or found by reading a conventions page with
  `confluence_get_page`); revising a page created this way later with
  `confluence_update_page` (not the deprecated ticket-doc case its own
  description warns against); and that `set_doc` refuses outright when a
  ticket has no existing doc. A boss's review-step language now checks a
  worker's doc only when one was explicitly requested and exists, rather
  than assuming every worker has one. `project.md`'s root-doc guidance (a
  project's root doc is unaffected by FACTORY-84/FACTORY-86 and still needs
  to stay current) is preserved, with the one sentence that implied a
  per-ticket doc gets created for one of the project's own epics removed.
- `src/tools/brief-coverage.ts`: `confluence_create_page`,
  `confluence_update_page` and `confluence_get_page` are now declared
  `taught: true`, since the on-request guidance above teaches all three
  directly — the latter two were `taught: false` under the old assumption
  that no brief would ever name them as routine calls.
- `src/tools/defs.ts`: `confluence_update_page`'s description now names a
  page created on request via `confluence_create_page` as a second,
  non-deprecated use, matching the brief guidance above.
