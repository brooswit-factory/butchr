# butchr

The software factory, rewritten. A single local daemon that:

1. **Watches your Jira** — the tickets assigned to the account that owns the API token, and whatever those tickets implement (task→story→epic; the Jira parent field is membership only).
2. **Runs an agent per active ticket** — when a ticket is In Progress or In Review, it spins up a [herdr](https://herdr.dev) agent (via [`@brooswit/herdr-sdk`](https://www.npmjs.com/package/@brooswit/herdr-sdk)).
3. **Pushes updates to those agents** — over MCP ([`@brooswit/thatch`](https://www.npmjs.com/package/@brooswit/thatch)): agents connect to the daemon identifying which issue they work on, and the daemon channels ticket/comment/link changes up the Implements chain to the right one.
4. **Shows a live view** — a webapp listing the active agents; click one and butchr opens a terminal window running `herdr agent attach` on it, so you drop straight into that agent's shell. No browser extension, no embedded terminal — terminals are real herdr terminals.

Change detection is [`@brooswit/sundry`](https://www.npmjs.com/package/@brooswit/sundry)'s `watch` over a Jira JQL feed. Blocking agent prompts are handled through herdr's own `blocked` detection + `send_keys` (herdr owns the terminal; butchr reads and answers).

## Architecture

```
one Elysia process
├── /mcp          agents connect here (thatch), identifying via x-issue header
├── /agents,/health   read-only live view
└── loops (landing incrementally)
    ├── jira-watch    sundry.watch over `assignee = currentUser() AND updated >= cursor`
    ├── reconcile     desired (In Progress/In Review) ↔ herdr agents: spawn / stop
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
