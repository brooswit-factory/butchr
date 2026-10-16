bump: minor

### Fixed
- `butchr link ... jira-project:X` with a malformed `ATLASSIAN_EMAIL` now prints one clean `stderr` line + exit 1 instead of jira.js's multi-line Zod validation dump (`src/cli/link-cli.ts`'s `jiraProjectStoreFromEnv`); the missing-credential and Jira-4xx/5xx paths were already single-line and are unchanged.
- `butchr link list`/`add`/`remove jira-project:X` for a project key that does not exist (or isn't visible to the credential in use) now errors clearly instead of `list` silently reading as an empty collection (`add`/`remove` already failed one step later, at the write). A new `AtlassianOps.projectExists` op (optional, real impl in `atlassian-real.ts`) distinguishes a 404 on the project itself from a 404 on just the missing `brooswit.butchr.links` property; an existing project with no property still lists as empty, unchanged.
- `docs/resource-links.md` Decision 10 documents both fixes and corrects two inaccuracies Decision 9 left behind.
