# butchr

The software factory, rewritten. A single local daemon that:

1. **Watches your Jira** — the tickets assigned to the account that owns the API token, and the items they link to.
2. **Runs an agent per active ticket** — when a ticket is In Progress or In Review, it spins up a [herdr](https://herdr.dev) agent (via [`@brooswit/herdr-sdk`](https://www.npmjs.com/package/@brooswit/herdr-sdk)).
3. **Pushes updates to those agents** — over MCP ([`@brooswit/thatch`](https://www.npmjs.com/package/@brooswit/thatch)): agents connect to the daemon identifying which issue they work on, and the daemon channels ticket/comment/link changes to the right one.
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
    └── notify        ticket/comment/link change → thatch channel → the agent on that issue
```

`src/`: `config` · `atlassian` (Jira client) · `daemon` (the app + notify) · `web` (live view). More loops land as their own modules.

## Install & run

On each machine:

```
npm i -g @brooswit/butchr     # or pin a version
cp .env.example .env          # fill in ATLASSIAN_SITE / EMAIL / TOKEN_FILE
butchr                        # reads .env / the environment
```

From source (development):

```
bun run start
```

## Development

```
bun run check    # generate + typecheck + tests + coverage ≥90%   (what CI runs)
```
Every `src/` change needs a `CHANGELOG.md` entry and a version bump (CI enforces it).

Predecessor (300 releases of history) preserved at [`brooswit/butchr-legacy`](https://github.com/brooswit/butchr-legacy).
