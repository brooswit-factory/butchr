# Live validation plan

How to take this build from recorded-shape tests to a first live run, one
resource provider at a time: `jira-work`, `github-issue`, `jira-idea`, and
optionally `zendesk-ticket`. This is a plan, not a record: nothing here has
been run against a live site. Provider details live in the README,
[`jira-idea.md`](jira-idea.md) and [`zendesk-ticket.md`](zendesk-ticket.md).

## Blocked on operator-provided access

These cannot be validated from this repository or its tests. Each needs
something only the operator can supply; until then the matching step below
stays **unvalidated**, and its rule stays out of the rules file.

| provider | needs | without it |
|---|---|---|
| `jira-idea` | A Jira site with **Jira Product Discovery** and a discovery project the Butchr account can browse, comment on and (for linking) add links to. | The idea boundary (`Idea` + `product_discovery`), comment permission and remote links are unproven; see "Needs empirical proof" in `jira-idea.md`. |
| `github-issue` | A **fixture issue** in a repo inside `BUTCHR_GITHUB_ORGS`, created for this test, that the token can read and comment on. | Search scoping, change notices and `github_add_comment` are unproven live. Do not point a first run at real issues. |
| `zendesk-ticket` | A Zendesk sandbox or test ticket, a dedicated least-privilege agent account, and an **OAuth access token** for it. | Scopes accepted by search, the private-note audit field, and trigger behaviour are unproven; see "Needs live verification" in `zendesk-ticket.md`. |

No project keys, repos, subdomains, account ids or tokens are assumed here.
Every placeholder below (`<...>`) is the operator's to fill in.

## Inputs

Shared (every provider):

- `ATLASSIAN_SITE`, `ATLASSIAN_EMAIL`, `ATLASSIAN_TOKEN_FILE` (required even
  for a GitHub-only run: the daemon's config needs them).
- `BUTCHR_RULES_FILE`: an explicit path, so a typo stops startup instead of
  silently staffing nothing. The file is written by the operator, outside the
  repo, and read once at startup (edits need a restart).
- `BUTCHR_WORKSPACES` (default `~/butchr-workspaces`), `BUTCHR_PORT`
  (default in `.env.example`: `7717`), `HERDR_SOCKET` if not herdr's default.
- `BUTCHR_MAX_AGENTS`: set to `1` for validation. The cap is shared across
  every rule loop.
- Agent provider settings as in [`agent-providers.md`](agent-providers.md).

Per provider:

| provider | inputs | rule `query` |
|---|---|---|
| `jira-work` | shared only | JQL matching exactly one test ticket, e.g. `key = <TEST-KEY>` |
| `github-issue` | `GITHUB_TOKEN_FILE`, `BUTCHR_GITHUB_ORGS` | GitHub search naming the fixture, e.g. `repo:<owner>/<repo> <fixture-number or label>`; no `org:`/`user:`, `is:pr`, `AND`/`OR`/`NOT` or parentheses |
| `jira-idea` | shared only (same Jira client) | JQL matching exactly one test idea, e.g. `key = <IDEA-KEY>` |
| `zendesk-ticket` | `BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK=agents-can-read-the-zendesk-token`, `ZENDESK_SUBDOMAIN`, `ZENDESK_OAUTH_TOKEN_FILE` (mode `600`/`400`, owned by the daemon user or root); `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN` unset | Zendesk search matching one test ticket; no `type:`, boolean operators or parentheses |

## Preflight (before starting the daemon)

1. `bun run check` passes on the exact commit being run; paste its preflight
   line with the result.
2. `herdr agent list` shows no agents in legacy flat workspaces
   (`<workspace root>/<ISSUE>`). If any exist the daemon refuses to start;
   stop them by hand (`herdr pane close <pane>`), never let Butchr adopt them.
3. The rules file contains **only** the rule under test, `enabled: true`, with
   a query narrowed to one fixture. Every other rule is absent or
   `enabled: false`.
4. Credentials are least-privilege and dedicated. Agents run shell commands
   as the daemon's user and can read every token file the daemon reads; the
   MCP tool limits are not a sandbox. The accounts' own permissions are the
   boundary.
5. Run the query by hand in the provider's own UI/search first and confirm it
   returns only the fixture.
6. `BUTCHR_PROJECT_ALLOWLIST` stays unset unless project staffing is itself
   under test, so no project agents start as a side effect.
7. Zendesk only: triggers and automations do not notify requesters on private
   updates, and the account's role cannot post public comments.

## Validation order

Validate one provider per daemon start, in this order: `jira-work`,
`github-issue`, `jira-idea` (after `github-issue` if linking is in scope),
then `zendesk-ticket` only if wanted. Add the next rule only after the
previous one passed and was stopped.

## Expected health signals

Startup log:

- `butchr: rules from <path>: 1 enabled (<rule-id>)`.
- No `WARNING:` staffing reason for the provider under test. A disabled
  provider names its reason (missing GitHub config, missing Zendesk
  acknowledgement, bad token-file mode, etc.).

`GET /health` (503 when `ok` is false):

- `ok: true`, with `components` `pollLoop` and `notify` in state `ok` after
  the startup grace period.
- `resourceLoops[]` entry for the provider under test: `enabled: true`,
  `state: "ok"`, `consecutiveFailures: 0`, `lastError: null`. Other entries
  `enabled: false` with a `disabledReason`. `github-issue` and
  `zendesk-ticket` poll every 60 s, `jira-idea` every 15 s.
- `admission.residency` at most `1`.

Agents and side effects:

- Exactly one herdr agent, in
  `<workspace root>/<provider>/<rule-id>/<resource>`, and one MCP connection
  under `GET /agents`.
- A comment or note on the fixture only when the brief asks for one:
  `jira_add_comment` on the test ticket, `github_add_comment` on the fixture
  issue, `jira_idea_add_comment` on the test idea, a **private**
  `[butchr <rule>]` internal note on the Zendesk ticket.
- A change to the fixture (comment, status, title) nudges the agent within
  a poll or two.
- Removing the fixture from the query (e.g. closing it, or a label change)
  stops its agent on the next complete poll.

Record, redacted, the responses `jira-idea.md` and `zendesk-ticket.md` list as
needing empirical proof; do not model them in code until recorded.

## Stop and rollback

Stop at the first unexpected write, a second agent, a public Zendesk comment,
a `resourceLoops` entry with repeated failures, or `ok: false` that does not
recover.

1. **Stop staffing the rule:** set its `enabled` to `false` (or remove it) and
   restart the daemon. For Zendesk, unsetting
   `BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK` and restarting also stops any
   leftover `zendesk-ticket` agents.
2. **Hard stop:** stop the daemon process. The daemon does not own herdr's
   panes, so check `herdr agent list` and close any remaining
   `<workspace root>/<provider>/...` agent with `herdr pane close <pane>`.
3. **Revoke credentials** if an agent acted outside its fixture: rotate the
   Atlassian/GitHub token or revoke the Zendesk OAuth token, then replace the
   token file.
4. **Clean up external writes by hand:** Butchr never deletes comments, notes
   or remote links. Remove test comments and any `GitHub issue` remote link
   on the idea in the provider's UI.
5. Workspace directories are kept on disk; delete them only after any
   captures or logs needed for fixtures are copied out.
