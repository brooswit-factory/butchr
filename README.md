# butchr

Agents support selectable Claude (default) and Codex providers. See
[provider configuration and deployment](docs/agent-providers.md).

The software factory, rewritten. A single local daemon that:

1. **Runs your resource-agent rules** — each rule is a JQL query plus a brief and agent preferences, read from `BUTCHR_RULES_FILE` or `$XDG_CONFIG_HOME/butchr/rules.json` (when the default file is absent, or its `rules` array is empty, nothing is staffed — there are no built-in rules; a `BUTCHR_RULES_FILE` that does not exist stops the daemon at startup). See `src/rules/rules.ts` for the schema, and provision a new deploy's rules file starting from [`docs/rules.example.json`](docs/rules.example.json) — see "Rules file" below for the convention it encodes and how to apply an edit. Rules may also name `resourceProvider: "github-issue"` with a GitHub issue search query; those are staffed only when `GITHUB_TOKEN_FILE` and `BUTCHR_GITHUB_ORGS` are set, in `<workspace root>/github-issue/<rule>/<owner%2Frepo%23n>`, and their agents work the issue with the `github_get_issue` and `github_add_comment` tools, which act only on the agent's own issue — a limit on the tools, not on a shell-capable agent that can read `GITHUB_TOKEN_FILE` (see `src/rules/github-issue-type.ts` and `src/tools/github-issue.ts`). Rules naming `resourceProvider: "jira-idea"` take JQL but staff only Jira Product Discovery ideas (issue type `Idea` in a `product_discovery` project), in `<workspace root>/jira-idea/<rule>/<IDEA>`, with the `jira_idea_get`, `jira_idea_github_issues` and `jira_idea_add_comment` tools. A `jira-idea` rule's `inwardConnectionRules` may name `github-issue` rules: its agents then hear changes to GitHub issues those rules match that the idea links to through a Jira remote link (read-only). When both providers run, `github_link_jira_idea` and `jira_idea_link_github_issue` let an agent create that remote link on request, only between resources those same rules currently match (`src/tools/idea-github-link.ts`). `jira-work` rules never staff an idea however broad their JQL (see `src/resources/jira-idea.ts` and `docs/jira-idea.md`). Rules naming `resourceProvider: "zendesk-ticket"` take Zendesk search syntax and are staffed only when `BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK=agents-can-read-the-zendesk-token`, `ZENDESK_SUBDOMAIN` and an owner-only `ZENDESK_OAUTH_TOKEN_FILE` (an OAuth token; email/API-token auth is refused) are set, in `<workspace root>/zendesk-ticket/<rule>/<subdomain%23id>`, with `zendesk_get_ticket` and `zendesk_add_internal_note`, whose only write is a private internal note. Agents run shell commands as the daemon's user and can read that token, so the tool limit is not a security boundary; Zendesk's account permissions are (see `docs/zendesk-ticket.md`). Rules naming `resourceProvider: "filesystem"` take a small JSON query (root, file-or-directory `kind`, an optional basename glob, a recursion depth, and an optional extension/hasEntry predicate — see `docs/filesystem.md`) and need no external credential, staffed in `<workspace root>/filesystem/<rule>/<percent-encoded-canonical-path>`; there is no general-purpose butchr MCP tool for it — an agent reads and edits its file or directory directly with its own file tools, and Jira/Confluence/GitHub/Zendesk tools all refuse it (the one exception, `freeze_session`/`unfreeze_session`, is scoped to managed-session agents specifically — see below). The daemon refuses to start while agents from the old `<workspace root>/<ISSUE>` layout are still running (see `src/daemon/legacy-preflight.ts`). Alongside your own rules, the daemon always runs one BUILT-IN `filesystem` query (never read from `rules.json`, not user-editable) over a well-known managed-session definitions directory (`BUTCHR_SESSION_DEFINITIONS_DIR`, else `$XDG_CONFIG_HOME/butchr/session-definitions`) — one JSON manifest per Butchr-managed agent (a Bakr directory agent, a Candlestix session), each defining its own working directory, vendor, model tier, permission mode and more; one agent per eligible (valid, not frozen) manifest, invalid ones logged and skipped rather than staffed or silently dropped. A definition's own `freezeControllers`/`unfreezeControllers` fields may name OTHER managed-session definitions whose agent may call the butchr `freeze_session`/`unfreeze_session` MCP tools against it — the only butchr MCP tools any filesystem-provider agent ever gets, scoped per-definition and server-side by caller identity, never by anything the caller argues (`src/tools/session-freeze-tools.ts`). See `docs/managed-sessions.md`. For the concrete Bakr/Candlestix → managed-session mapping and cutover runbook this feeds (BUTCHR-391/BUTCHR-396), see `docs/codey-migration-runbook.md` and the staged example definitions in `docs/codey-session-definitions.example/`.
2. **Runs one agent per (rule, matched ticket)** — while a rule's query returns a ticket, a [herdr](https://herdr.dev) agent works it via [`@brooswit/drovr`](https://github.com/brooswit-factory/drovr), in `<workspace root>/jira-work/<rule>/<ISSUE>`; when the query stops returning it, the agent is stopped. Two rules matching one ticket run two independent agents. A boss hears its implementer over `Implements` on the link alone (routed to every rule matching the boss ticket; no rule configuration is consulted) — a rule's `childRule` does NOT gate this (PR #372; see the `BUTCHR-388` header comment in `src/rules/resource-type.ts`) and today only names, for documentation/validation purposes, which rule a child created by this rule's agent is meant to match. `inwardConnectionRules` still gates the *sideways* case: over an existing `Relates` link, one way only — the rules it lists do not hear it back unless they list it too (read-only; Butchr never creates links). A `childRule`/`inwardConnectionRules` value naming a rule id absent from the **same rules file** is a hard load error today (`src/rules/rules.ts`'s `parseRules` refuses to start the daemon, naming the bad id) — a typo can't reach runtime, though today no rules file declares `childRule` at all, so this check cannot fire from a real rules file. `unresolvedRelationships` (also in `src/rules/rules.ts`), logged once at startup and listed under `/health`, is a separate, purely existence-based safety net over *any* enabled `jira-work` rule set, including one assembled some other way than a single `loadRules()` call — it does not ask whether the missing id is staffed, observed, or enabled, and it does not restore any routing effect to `childRule`. It is expected to be empty/absent under every rules file that loads today; it starts finding real gaps once something (e.g. cross-daemon `BUTCHR-402` observer rules) lets a rule set carry a reference `parseRules` doesn't reject. Workspaces from before rules (`<workspace root>/<ISSUE>`) are left untouched and never adopted.
3. **Pushes updates to those agents** — over MCP ([`@brooswit/thatch`](https://www.npmjs.com/package/@brooswit/thatch)): agents connect to the daemon identifying which issue they work on, and the daemon channels ticket/comment/link changes up the Implements chain to the right one.
4. **Shows a live view** — a webapp listing the active agents; click one and butchr opens a terminal window running `herdr agent attach` on it, so you drop straight into that agent's shell. No browser extension, no embedded terminal — terminals are real herdr terminals.

Change detection is [`@brooswit/sundry`](https://www.npmjs.com/package/@brooswit/sundry)'s `watch` over a Jira JQL feed. Blocking agent prompts are handled through herdr's own `blocked` detection + `send_keys` (herdr owns the terminal; butchr reads and answers).

## Rules file

**Convention: every ticket-worker (`jira-work`) rule in the example defaults to `In Progress` / `In Review`.** A query like `assignee = currentUser() AND issuetype = Task AND statusCategory != Done` also matches `To Do` — it takes a capacity slot for a ticket nobody is working yet, and a ticket moved *into* `To Do` wakes that agent instead of stopping it. `status IN ("In Progress", "In Review")` avoids that by default. [`docs/rules.example.json`](docs/rules.example.json) is the canonical starting point: one `jira-work` rule per role (`epics`, `stories`, `tasks`, `bugs`, `subtasks`), each `assignee = currentUser()` plus an `issuetype` clause plus `status IN ("In Progress", "In Review")`. It loads through the real loader/validator in `test/unit/rules-example.test.ts`, which also asserts every rule in it keeps this shape — copy it as your rules file's starting point and add provider rules (`github-issue`, `jira-idea`, `zendesk-ticket`) or adjust the JQL as needed. The query is the only place a status choice lives, and it stays fully operator-configurable: an operator who wants a rule to also match `To Do` (or any other status) simply writes that query. Butchr does not gate, prevent, or warn against it — there is no code-level status gate in `jira-work` staffing and none is planned.

**Capacity naming.** Every rule above carries no capacity flag: the schema's `role: "worker" | "sentinel"` field (`src/rules/rules.ts`) defaults to `"worker"`, so a ticket-worker rule needs no field at all — that is why `docs/rules.example.json` has no `role` on any rule, and it should stay that way. Only an always-on agent is ever flagged `role: "sentinel"`.

**Where the file actually lives — resolving a discrepancy on purpose.** The code's own default, unconditionally, straight from `src/rules/rules.ts`'s `rulesPath()` (the only place this is decided): `BUTCHR_RULES_FILE` when set, else `$XDG_CONFIG_HOME/butchr/rules.json`, else `~/.config/butchr/rules.json`. That is what an unconfigured daemon reads, and it is what this README described before this section existed. Separately, `~/.config/butchr-new/resource-rules.json` has been cited elsewhere (BUTCHR-399's own description; a test comment at the time of writing, `test/unit/rule-engine.test.ts`, calls the live rules file `resource-rules.json`) as what booswrit's and wroosbit's live daemons actually run with — a **different** directory name and filename from the code's default. `rulesPath()` has no `butchr-new` or `resource-rules.json` branch anywhere, so that path is not a second default the code knows about; the only way a daemon reads from it is an explicit `BUTCHR_RULES_FILE` set in that daemon's own unit/environment, which this repository cannot see or verify. **Do not assume either path for a deploy you don't operate** — read that daemon's actual `BUTCHR_RULES_FILE` (or its unit's environment) yourself; a stale line number or a since-changed unit make both citations above worth re-checking rather than trusting verbatim.

**Applying a change.** The file is read once at startup (`loadRules`, called from `src/daemon/index.ts`); there is no reload path, so an edit needs a daemon restart to take effect. A restart is cheap and does **not** stop every worker: each reconcile poll — including the daemon's first poll after restarting — diffs the rules' current matches against herdr's own live agent list, not against any daemon-side memory of what was running before (`src/reconcile/plan.ts`, `src/daemon/loop.ts`). A resident agent whose ticket still matches the same rule after the restart is therefore simply never touched — left running, pane and all, exactly as if nothing happened; only an agent whose ticket no longer matches any enabled rule is stopped, and a newly-matching ticket gets a freshly spawned agent. Tightening a rule's JQL to exclude `To Do` and restarting stops only the agents working `To Do` tickets under that rule — every `In Progress`/`In Review` agent it already had stays up.

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

A managed-session definition may opt into "lizard mode" (`lizardMode: true`, paired with `permissionMode: "default"`): a separate, standalone 20s timer (`src/agents/permission-answer-loop.ts`) auto-answers Claude's own tool-permission dialog ("Do you want to proceed?") on that agent's pane only — no other pane is ever touched — pressing the "always allow" stored-rule option only when it is unambiguously that option (`@brooswit/drovr`'s `autoAnswerPermissions`), so an agent kept in manual mode is cleared within one tick instead of sitting frozen until a human notices. Every attempt is audited to `BUTCHR_PERMISSION_AUDIT_PATH` (default `.permission-audit.jsonl` under the workspace root), and the journal names the agent and tool for each one. See [`docs/managed-sessions.md`](docs/managed-sessions.md)'s "Lizard mode" section and [`docs/permission-answer-loop.md`](docs/permission-answer-loop.md) for the field, cadence/timeout reasoning, and how this avoids double-answering with the two detectors above.

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

Free-form project resource agents are available through `jira-project` rules;
see [project selection, interactive use, and optional MCP connections](docs/project-agents.md).

A resource agent (or an operator, via `butchr link list|add|remove`) can
maintain its own butchr-managed sensor set — typed references across six
provider kinds (`jira-work-item`, `jira-project`, `confluence-page`,
`github-issue`, `filesystem`, `webpage`) — independent of any
provider-native links a future adapter may merge in; see
[`ResourceRef`, the managed-link collection, and the merge contract](docs/resource-links.md).

A resource's provider can be asked which capability categories it actually
supports today (`query`, `read`, `snapshot`, `comments`, `links`,
`createTask`) via `supports`/`capabilitiesOf`
(`src/resources/capabilities.ts`); invoking an unsupported capability throws
a typed `UnsupportedCapabilityError`. Comments (`readComments`/`addComment`,
`src/resources/comments.ts`) are implemented for `jira-work-item` only today.
See [provider capability declaration, the comments capability, and the
8×6 provider inventory](docs/provider-capabilities.md).
