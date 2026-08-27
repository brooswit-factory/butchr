# Changelog

All notable changes to butchr. Format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
entries are `## [x.y.z] - YYYY-MM-DD` with subsections from: `BREAKING`, `Added`, `Changed`, `Fixed`, `Removed`.
CI refuses a merge that changes `src/` or `package.json` without a new entry here.

## Versioning
- **MAJOR** — a restructuring/rewrite that breaks a lot, requiring reimplementation. Requires a `### BREAKING` section.
- **MINOR** — a new feature, or a change to an existing feature that breaks just that feature.
- **PATCH** — a fix or correction needing no consumer code changes, or very minor ones.

## [0.5.9] - 2026-08-26
### Added
- `jira_link_issues` tool (default type Relates), and the story brief now requires linking the story to each task it files. Jira rejects a Story as a Task's parent — Story and Task sit at the same hierarchy level, so tasks parent to the epic (probed live: 400 "Please select valid parent issue") — which mis-routed task events to the epic. The related-work watcher already follows links of active issues; the link is what routes a task's In Review to the story that must review it.

## [0.5.8] - 2026-08-26
### Fixed
- **Notifications now wake idle agents.** A channel push renders mid-turn but cannot START a turn — measured live: the KAN-681 epic, idle and explicitly waiting to hear that its child reached In Review, never woke on the push. `notify` now also delivers the message as a herdr agent prompt (tagged `[butchr]`), which starts a turn on an idle agent and queues on a busy one; a blocked pane refuses it, which the prompt-watcher owns. Every delivery is logged with both outcomes.

## [0.5.7] - 2026-08-26
### Fixed
- **The prompt-watcher retries while an agent stays blocked** (KAN-682). It fired once on the transition into blocked: if the dialog wasn't parseable at that instant, or one read failed (e.g. during a spawn-retry storm), nothing ever retried and the agent sat blocked forever — measured on KAN-681 and KAN-683, both needing a manual Enter. Now every poll re-fires for every blocked pane (handlers re-parse, so re-answering is idempotent), which also answers chains of startup dialogs where only the first raises a transition.
- **The watcher logs.** Every prompt seen, every answer sent, every error — its failure paths were fully silenced before, so a dead watcher was indistinguishable from a quiet one.

## [0.5.6] - 2026-08-26
### Fixed
- **The kickoff prompt is now the first spawn argument.** `--dangerously-load-development-channels` is variadic, so the trailing positional from 0.5.4 was swallowed as a second channel entry — claude rejected it ("entries must be tagged: follow your CLAUDE.md") and exited, and every agent spawn failed. Found on KAN-681's first live spawn; proven red/green by running claude both ways.
- **A failed `agent.start` closes the workspace it created.** Without this the reconcile loop retried into a fresh herdr workspace every poll — 7 leaked in 2 minutes.

## [0.5.5] - 2026-08-26
### Added
- `jira_create_issue` accepts an `assignee` (accountId). A ticket filed without one is never staffed — the board reconciler needs an assignee *and* an active status — so a parent filing work for a child must be able to say who works it. This also lets a hierarchy span machines: stories on one account can file tasks assigned to another.
### Changed
- **The daemon watches related work.** Each poll now also fetches the children of every active ticket and the tickets linked to it, and a change to one — including a newly filed child — notifies the active ticket's agent, naming what changed. The assigned-issues query is per-credential, so without this a task assigned to another account (another machine's daemon) could move to In Review and its story's reviewer would never hear; now the wake-up is mechanical, not etiquette.

## [0.5.4] - 2026-08-26
### Changed
- **Spawned agents are kicked off by a command-line argument, not a wait-then-prompt chain.** `spawn()` now appends the positional prompt `follow your CLAUDE.md` to the args passed to `agent.start`; Claude Code queues it as the first message and submits it once the startup dialogs are answered. The fire-and-forget `agent.wait({until:["idle"], timeout_ms: 180_000})` → `agent.prompt(...)` chain that followed `agent.start` is gone, and with it its failure modes (a missed idle transition, a 180s timeout, a prompt racing the startup dialogs).

## [0.5.3] - 2026-08-26
### Fixed
- **Channel pushes now render in agent sessions.** Agents were spawned with `--channels server:butchr`, but Claude Code silently skips channel registration for servers that are not on its approved allowlist — so butchr's pushed notifications never reached the agent. Spawn now passes `--dangerously-load-development-channels server:butchr` instead; the dev-load confirmation dialog it shows at startup is already auto-answered by the prompt-watcher.

## [0.5.2] - 2026-08-26
### Fixed
- Spawned agents now run with `--permission-mode bypassPermissions`. Without it Claude Code's permission classifier denies `git add/commit/push`, so an agent does its work and then cannot deliver it — found live on KAN-679, where the agent made the change, ran the full check suite green, and stalled at the commit.

## [0.5.1] - 2026-08-26
### Changed
- Repository moved to the brooswit-factory org; package.json repository/homepage/bugs URLs updated (npm provenance verifies repository.url against the building repo).

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
