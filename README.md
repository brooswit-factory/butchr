# butchr

Agents support selectable Claude (default) and Codex providers. See
[provider configuration and deployment](docs/agent-providers.md).

The software factory, rewritten. A single local daemon that:

1. **Runs your resource-agent rules** — each rule is a JQL query plus a brief and agent preferences, read from `BUTCHR_RULES_FILE` or `$XDG_CONFIG_HOME/butchr/rules.json` (when the default file is absent, or its `rules` array is empty, nothing is staffed — there are no built-in rules; a `BUTCHR_RULES_FILE` that does not exist stops the daemon at startup). See `src/rules/rules.ts` for the schema. Rules may also name `resourceProvider: "github-issue"` with a GitHub issue search query; those are staffed only when `GITHUB_TOKEN_FILE` and `BUTCHR_GITHUB_ORGS` are set, in `<workspace root>/github-issue/<rule>/<owner%2Frepo%23n>`, and their agents work the issue with the `github_get_issue` and `github_add_comment` tools, which act only on the agent's own issue — a limit on the tools, not on a shell-capable agent that can read `GITHUB_TOKEN_FILE` (see `src/rules/github-issue-type.ts` and `src/tools/github-issue.ts`). Rules naming `resourceProvider: "jira-idea"` take JQL but staff only Jira Product Discovery ideas (issue type `Idea` in a `product_discovery` project), in `<workspace root>/jira-idea/<rule>/<IDEA>`, with the `jira_idea_get`, `jira_idea_github_issues` and `jira_idea_add_comment` tools. A `jira-idea` rule's `inwardConnectionRules` may name `github-issue` rules: its agents then hear changes to GitHub issues those rules match that the idea links to through a Jira remote link (read-only). When both providers run, `github_link_jira_idea` and `jira_idea_link_github_issue` let an agent create that remote link on request, only between resources those same rules currently match (`src/tools/idea-github-link.ts`). `jira-work` rules never staff an idea however broad their JQL (see `src/resources/jira-idea.ts` and `docs/jira-idea.md`). Rules naming `resourceProvider: "zendesk-ticket"` take Zendesk search syntax and are staffed only when `BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK=agents-can-read-the-zendesk-token`, `ZENDESK_SUBDOMAIN` and an owner-only `ZENDESK_OAUTH_TOKEN_FILE` (an OAuth token; email/API-token auth is refused) are set, in `<workspace root>/zendesk-ticket/<rule>/<subdomain%23id>`, with `zendesk_get_ticket` and `zendesk_add_internal_note`, whose only write is a private internal note. Agents run shell commands as the daemon's user and can read that token, so the tool limit is not a security boundary; Zendesk's account permissions are (see `docs/zendesk-ticket.md`). The daemon refuses to start while agents from the old `<workspace root>/<ISSUE>` layout are still running (see `src/daemon/legacy-preflight.ts`).
2. **Runs one agent per (rule, matched ticket)** — while a rule's query returns a ticket, a [herdr](https://herdr.dev) agent works it via [`@brooswit/drovr`](https://github.com/brooswit-factory/drovr), in `<workspace root>/jira-work/<rule>/<ISSUE>`; when the query stops returning it, the agent is stopped. Two rules matching one ticket run two independent agents. A rule's `childRule` makes its agents hear changes to tickets that rule matches which already `Implements` their ticket; its `inwardConnectionRules` do the same over an existing `Relates` link, one way only — the rules it lists do not hear it back unless they list it too (read-only; Butchr never creates links). A rule may set `staffed: false` to make it an OBSERVER: it is still searched every poll, so its matches are visible to that relationship walk, but it never gets an agent — a match from a `staffed: false` rule never reaches staffing, label sync, or the parked/abandoned detectors. This exists so one daemon can hear about a ticket a DIFFERENT daemon staffs (e.g. an Epic/Task/Bug daemon and a Story/Sub-task daemon splitting one Jira project): give the listening daemon its own `staffed: false` rule whose query matches the other daemon's ticket, and name it as a `childRule`/`inwardConnectionRules` target as usual. A `staffed: false` rule may declare neither `brief` nor `agentPreferences` (rejected at validation time — both are meaningless without an agent). Workspaces from before rules (`<workspace root>/<ISSUE>`) are left untouched and never adopted.
3. **Pushes updates to those agents** — over MCP ([`@brooswit/thatch`](https://www.npmjs.com/package/@brooswit/thatch)): agents connect to the daemon identifying which issue they work on, and the daemon channels ticket/comment/link changes up the Implements chain to the right one.
4. **Shows a live view** — a webapp listing the active agents; click one and butchr opens a terminal window running `herdr agent attach` on it, so you drop straight into that agent's shell. No browser extension, no embedded terminal — terminals are real herdr terminals.

Change detection is [`@brooswit/sundry`](https://www.npmjs.com/package/@brooswit/sundry)'s `watch` over a Jira JQL feed. Blocking agent prompts are handled through herdr's own `blocked` detection + `send_keys` (herdr owns the terminal; butchr reads and answers).

## Architecture

```
one Elysia process
├── /mcp          agents connect here (thatch), identifying via x-issue (ticket) + x-butchr-agent (rule agent) headers
├── /agents,/health   read-only live view
└── loops (landing incrementally)
    ├── rules         every enabled rule's JQL → one desired agent per (rule, ticket)
    ├── reconcile     desired rule agents ↔ herdr agents: spawn / stop
    └── notify        ticket/comment/link change → thatch channel → the agent for whatever that ticket implements
```

`src/`: `config` · `atlassian` (Jira client) · `daemon` (the app + notify) · `web` (live view). More loops land as their own modules.

## Install & run

On each machine:

```
npm i -g @brooswit/butchr     # or pin a version
cp .env.example .env          # fill in ATLASSIAN_SITE / EMAIL / TOKEN_FILE
butchr                        # reads .env / the environment
```

As of 0.10.0, also set `BUTCHR_ASSIGNEE_STORY` and `BUTCHR_ASSIGNEE_TASK` (Atlassian accountIds) in `.env` before deploying — `jira_create_issue` assigns a Story/Task by role from these, and REFUSES to create one of that type if its role is unset and the caller passed no explicit `assignee`. Epics are unaffected.

Optionally set `BUTCHR_CAPTURE_DIR` to change where the session-limit watcher durably captures a pane's ANSI-stripped text when its own detection is inconclusive (the phrase is present but unrecognised, or recognised with no parseable reset time) — default `.captures` under the workspace root (`BUTCHR_WORKSPACES`, or `~/butchr-workspaces`). Bounded to at most one capture per issue/trigger/pane incarnation and 50 files total (oldest evicted first); an operator turns a capture into a test fixture by deleting its `# `-prefixed header block.

herdr's own `blocked` classification is not the only blocked-detector: a pane herdr reports idle/done continuously for `BUTCHR_IDLE_DIALOG_MINUTES` (default 2) whose text parses as a dialog at the END of the pane is treated as blocked too — read, auto-answered if the shape is known, escalated to the pane's own ticket otherwise (an unrecognised idle-blocked dialog escalating, rather than freezing the agent silently, is the whole point — see `src/agents/idle-dialog.ts`). Every escalation additionally captures the full pane text to the same `BUTCHR_CAPTURE_DIR`, under an `<ISSUE>-escalation-<timestamp>.txt` name, and the Jira comment references that path (never the raw text) so the next unrecognised dialog can be fixtured from the escalation itself.

From source (development):

```
bun run start
```

**Label-write permission.** butchr writes `agent:*`/`pr:*` labels quietly (`notifyUsers=false`) so watchers aren't spammed on every status flip — but Jira Cloud only honours that for an account holding the **Administrator** project role (or global Administer Jira) on the board's project. Grant the daemon's Atlassian account that role on each project it labels tickets in. Without it, labels still sync — nothing is disabled — but every label change sends the ticket's watchers a Jira notification, and the daemon says so once at startup, e.g.:

```
[labels] KAN: account booswrit@gmail.com lacks ADMINISTER_PROJECTS — label writes will NOTIFY watchers. Remedy: grant booswrit@gmail.com the Administrator project role on KAN, or accept notifying label writes.
```

No config knob is needed — the daemon detects this per project automatically. Current state as of 2026-08-28: `brooswit` is a site admin (has it everywhere); `booswrit` was granted the KAN Administrator role.

## Development

```
bun run check    # generate + typecheck + tests + coverage ≥90%   (what CI runs)
```
`bun run check` is the single verification command — run it in full, not step by step. It runs `tsc` under `bun --bun` rather than through a shebang-resolved `node`, so no particular node version is required. Before the gate runs, it prints a one-line preflight naming the runtimes actually in use (e.g. `preflight: bun 1.4.0, node v12.22.9, tsc 5.6.3 (typecheck runs under bun)`); paste that line along with the rest of the output when reporting a gate result.

Every `src/` change needs a `changelog.d/<TICKET>.md` fragment (CI enforces it) — see `changelog.d/README.md`. The version is assigned at merge, not on a branch: do not bump `package.json` or add a dated `CHANGELOG.md` heading yourself.

Predecessor (300 releases of history) preserved at [`brooswit/butchr-legacy`](https://github.com/brooswit/butchr-legacy).
