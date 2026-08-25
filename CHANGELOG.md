# Changelog

All notable changes to butchr. Format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
entries are `## [x.y.z] - YYYY-MM-DD` with subsections from: `BREAKING`, `Added`, `Changed`, `Fixed`, `Removed`.
CI refuses a merge that changes `src/` or `package.json` without a new entry here.

## Versioning
- **MAJOR** — a restructuring/rewrite that breaks a lot, requiring reimplementation. Requires a `### BREAKING` section.
- **MINOR** — a new feature, or a change to an existing feature that breaks just that feature.
- **PATCH** — a fix or correction needing no consumer code changes, or very minor ones.

## [0.5.0] - 2026-08-25
### Added
- **The agent model (docs/agent-model.md) is implemented.** Agents now do things:
  - **MCP tools**: a thin proxy over the de-facto SDKs (jira.js 6, confluence.js 3) with the shared credential — `jira_get_issue`, `jira_search`, `jira_add_comment`, `jira_transition`, `jira_create_issue`, `confluence_create_page`, `confluence_get_page`, `confluence_list_spaces`. Every call is audited by the caller's `x-issue`. (Found live: jira.js 6.x wants `auth: { type: "basic", … }` — the old `authentication:` shape is silently ignored and Jira then returns EMPTY searches, not a 401.)
  - **Briefs + kickoff cascade**: `briefs/` (CLAUDE.md, epic, story, task, default — embedded into the build as text imports). Spawn builds `~/butchr-workspaces/<KEY>/` with CLAUDE.md + the interpolated brief + mcp.json, starts the herdr workspace with that cwd, and after the agent settles sends "follow your CLAUDE.md".
  - **Models per type**: epic=fable, story=opus, task=sonnet via `--model`.
  - **Parent notification**: a changed issue nudges its own agent AND its parent's — reviews flow upward.

## [0.4.1] - 2026-08-24
### Fixed
- First real run against the live board (7 tickets → 7 agents) surfaced three defects, all fixed: `agent.start` needs a pane, so spawn now creates a workspace per issue and starts the agent in its root pane; agent names must be lowercase (`butchr-kan-7`, mapped back to `KAN-7`); and the prompt-watcher now sweeps agents ALREADY blocked at daemon start (a restart no longer strands them). Also auto-answers Claude's "Settings Warning" startup prompt (Continue).

## [0.4.0] - 2026-08-24
### Added
- **The webapp.** A single served page (`/`) lists the active agents with their live herdr status and ticket summary, polling `/state` every 2s. Clicking an agent POSTs `/agents/:issue/open`, and butchr **spawns a terminal window running `herdr agent attach <that agent>`** — so from no terminal you land in just that agent's live shell.
- `terminal/open` — detects the desktop terminal emulator (gnome-terminal, konsole, alacritty, kitty, wezterm, xterm, …) or takes a `BUTCHR_TERMINAL` override, and builds the attach command.
- `Herd.paneFor` — resolves an issue to its agent's current pane at click time (no stale pane ids).

## [0.3.0] - 2026-08-24
### Added
- **The full daemon loop.** Every poll butchr fetches its assigned issues and reconciles the herd against the active set: it spawns a herdr agent for each In Progress / In Review ticket and **shuts off the agent for any ticket that has left those states** (`reconcile/plan`, `daemon/loop`). This is a periodic controller — correct after a restart, not just on deltas.
- **Change notifications.** On any change between polls (`jira-watch/diff`), butchr nudges the agent working the affected issue over the thatch channel.
- **Agent lifecycle** (`agents/herd`): each agent runs under a `butchr:<ISSUE>` name, is spawned with `--channels server:butchr` and a per-issue MCP config carrying its `x-issue` header, and is stopped by closing its pane.
- **Blocking-prompt handling** (`agents/prompt`, `agents/blocked`, `agents/prompt-watch`): butchr detects agents that go `blocked` (polling `agent.list`), reads the prompt via herdr's detection region, parses the `❯ N. label` menu, and either auto-answers known launch prompts (trust / dev-channel / resume) or leaves a real decision exposed for a human. No PTY driver — herdr owns the terminal.

## [0.2.0] - 2026-08-24
### Added
- Distribution: butchr builds to a single executable `dist/butchr.js` and publishes to npm with a `butchr` bin, so machines run it via `npm i -g @brooswit/butchr`. Releases publish on a version bump to `main` (OIDC provenance), matching the library repos.
### Changed
- The daemon fails cleanly with a one-line message (not a stack trace) when required configuration is missing.

## [0.1.0] - 2026-08-24
### Added
- The daemon skeleton: one Elysia server hosting the MCP endpoint agents connect to (`/mcp`, via `@brooswit/thatch`) and a read-only live view (`/health`, `/agents`).
- `config` — env parsing with the Atlassian token read from a file (`ATLASSIAN_TOKEN_FILE`), never logged.
- `atlassian` — a small Jira Cloud REST client (classic-token Basic auth): `search(jql)` and `links(key)`, with an injectable `fetch`.
- `notifyIssue` — pushes a channel update to whichever connected agents identify (via `x-issue`) as working that issue.
