# zippy-windows-dev: a Windows-native Codex agent (FACTORY-563, epic FACTORY-555)

Scope for this pass (manager comment on FACTORY-563, 2026-09-30, narrowing
the ticket's own description): what a Codex-vendored agent needs to run
unattended on zippy (a native-Windows Butchr host — no WSL, see
`docs/windows-native-host.md`), plus what admin-assembly still has to do by
hand. **Nothing here spawns, runs, or activates anything** — it is a
Windows-safe `jira-work` rule example and a managed-session definition
example, both shipped `enabled: false`, plus the setup steps a human/
admin-assembly must still perform before either is switched on for real.

**Draft consumer:** rule id `runeleague-tasks`, query `project = GK AND
labels = runeleague AND issuetype = Task AND status IN ("In Progress","In
Review")` — see the rule example below.

## Why `vendor: "codex"` + `permissionMode: "bypassPermissions"`, today

Read the field table in [`docs/managed-sessions.md`](managed-sessions.md)
and its "Per-vendor launch differences" section directly before trusting
anything below — this doc doesn't re-derive that schema, only applies it.

As of this checkout, `permissionMode` on a `vendor: "codex"` managed-session
definition is **validated and stored, but silently not forwarded** to the
Codex launch — `agentLaunchConfig`'s Codex branch (`src/agents/argv.ts`)
never reads `spec.permissionMode` at all. A `jira-project`-owned agent gets
`bypassApprovalsAndSandbox: false` (manual); every other Codex launch —
including one from a managed-session definition or a plain `jira-work`
rule — gets drovr's own default, which is the bypass flag
(`--dangerously-bypass-approvals-and-sandbox`), regardless of what
`permissionMode` says. That is a two-case rule keyed on the calling
resource provider, not on `permissionMode` — confirmed by
[FACTORY-576's own triage comment](https://wroosbit.atlassian.net/browse/FACTORY-576),
which also corrects an earlier premise that `lizardMode` played a role
here: it structurally cannot — it never sets a launch field for Codex at
all (see `docs/managed-sessions.md`'s "Lizard mode" section for what it
actually does).

**FACTORY-576 (story FACTORY-577, in progress in parallel with this
ticket) makes `permissionMode` honored for Codex**, mapping it the way this
example already assumes: `bypassPermissions` → the bypass flag (today's
behavior for a non-`jira-project` Codex launch, made explicit rather than
incidental); any other explicit value → manual approval
(`bypassApprovalsAndSandbox: false`). **Verify FACTORY-576/577 actually
landed on your checkout before trusting that this example's
`permissionMode` field does anything** — `git log --oneline --grep
FACTORY-576` (or -577) against your own `main`. Until it lands, a
`vendor: "codex"` definition's `permissionMode` is accepted but ignored,
and actual launch mode for anything not `jira-project`-owned is the bypass
flag regardless — i.e. the field in this example is future-correct, not
presently load-bearing, for either the rule or the session-definition
form.

Do **not** set `strictMcpConfig` on a `vendor: "codex"` definition — it is
hard-rejected at manifest load for that vendor (`docs/managed-sessions.md`,
"Per-vendor launch differences"), unlike `permissionMode`'s silent-no-op
treatment above.

## 1. `jira-work` rule example

The known draft consumer (`runeleague-tasks`) is a rule-engine agent, not a
managed session — `agentPreferences: [{ "harness": "codex" }]` is how a
rule picks Codex over the default harness ordering
(`src/agents/herd.ts`'s `providerOrder`), same shape every other rule in
[`docs/rules.example.json`](rules.example.json) uses for its own
`agents`/`brief` fields. Full file:
[`docs/zippy-codex-agent.example.json`](zippy-codex-agent.example.json).

```json
{
  "id": "runeleague-tasks",
  "enabled": false,
  "resourceProvider": "jira-work",
  "query": "project = GK AND labels = runeleague AND issuetype = Task AND status IN (\"In Progress\", \"In Review\")",
  "brief": "@builtin:task",
  "agentPreferences": [{ "harness": "codex" }],
  "permissionMode": "bypassPermissions"
}
```

Notes:

- `enabled: false` ships it inert — admin-assembly (or whoever owns
  `%USERPROFILE%\butchr\rules.json` on zippy) flips it on deliberately,
  after reading "Setup runbook" below. **Do not touch codey's `rules.json`**
  — this is zippy's own file, a different host (per FACTORY-563's own
  scope comment).
- `agentPreferences[].harness: "codex"` is a *preference*, not an
  exclusive pin — see `docs/execution-modes.md` and `AgentPreference`'s own
  doc comment (`src/rules/rules.ts`) for how a rule's ranked harness list
  interacts with fallback. If this host only ever wants Codex, that's a
  one-entry list, as above.
- `Rule.permissionMode` is validated at manifest load for every
  `resourceProvider`/harness combination (no Codex-vendor rejection, unlike
  a managed-session definition's `strictMcpConfig`) but is documented
  **Claude-only** as of this checkout (`src/rules/rules.ts`'s own doc
  comment on `RULE_PERMISSION_MODES`) — silently unforwarded to a Codex
  launch for the same reason `SessionDefinition.permissionMode` is, until
  FACTORY-576/577 lands. It's included here anyway so the rule is
  future-correct the same way the session definition below is — verify
  against your own checkout, same caveat as above.
- `brief: "@builtin:task"` reuses the shipped Task brief
  (`briefs/task.md`) verbatim — same content this repo's own tasks agents
  (including the one that wrote this doc) run under. Swap it for a
  ticket-shape-specific brief only if GK's `runeleague`-labeled tasks need
  something `@builtin:task` doesn't already say.

## 2. Managed-session definition example

For a persistent/standalone Codex agent on zippy (not a `jira-work`
rule-spawned ticket worker) — a director, a query agent, anything whose
lifecycle isn't "one agent per matching Jira ticket." Field-by-field:
`docs/managed-sessions.md`'s table, not this doc.

```json
{
  "workingDirectory": "~/<placeholder-path>",
  "brief": "<placeholder: this agent's role>",
  "vendor": "codex",
  "tier": "tier2",
  "permissionMode": "bypassPermissions",
  "execution": "persistent",
  "role": "worker",
  "frozen": true
}
```

Notes:

- `frozen: true` is this example's own version of the rule's
  `enabled: false` — "valid, but runs no agent" (`docs/managed-sessions.md`,
  "Eligible = valid, not frozen"). A managed-session definition has no
  `enabled` field; `frozen` is the equivalent switch. Flip it only after
  the runbook below is actually done.
- `workingDirectory` is left a placeholder deliberately — this doc has no
  basis to invent a real one for a session nobody has specified the role
  of yet. Pick a WSL-style `~/...`-relative path if this session's own
  tooling is cross-platform (Bun/Node/git, all of which run natively on
  zippy per FACTORY-563's own scope comment); there is no WSL boundary on
  zippy to reason about the way `docs/windows-wsl-agent-guide.md` section 2
  does for a WSL host — that doc doesn't apply here at all (zippy is
  native, not WSL).
- Do **not** hand-construct a `C:\...` workspace path for this field or any
  other — `workingDirectory` is where a managed-session agent is told to
  `cd`, a value you choose; it is unrelated to the auto-computed rule-engine
  workspace directory discussed next.

## Workspace layout: the flat, percent-encoded leaf (FACTORY-570)

This section is **informational, not something either example JSON
configures** — a rule-engine agent's own on-disk workspace directory (under
`%USERPROFILE%\butchr-workspaces` per this ticket's own scope comment) is
computed automatically by `src/agents/workspace.ts`, not named by any field
in `docs/rules.example.json` or this doc's rule example.

FACTORY-570 fixed a real bug in that computation on Windows:
`newLayoutDirFor`'s short-id leaf builder assumed a `/`-separated resource
id; a Windows-shaped one (backslash-joined, carrying a drive letter and
colon) has no `/` at all, so the old code returned nearly the whole raw
path as a single "leaf" and joined it verbatim onto the workspace root —
producing an invalid nested-drive-letter path and an `ENOENT` on every
poll. `isValidLeaf` now additionally rejects `:` and `\` when
`platform === "win32"` (native Linux/macOS behavior is unchanged — this is
platform-gated, not a global tightening), which makes a Windows-shaped
candidate leaf invalid and falls back to `legacyLeaf`: a single, flat,
fully percent-encoded segment (`encodeURIComponent(resourceId)`) — exactly
the pre-existing fallback every other provider already uses when its own
short-id form doesn't apply. Verify this against `src/agents/workspace.ts`
and `src/agents/agent-key.ts` in your own checkout (`isValidLeaf`,
`legacyLeaf`, `candidateLeaf`) before relying on the description above —
this doc doesn't re-paste the implementation, only explains the shape you
should expect to see under `%USERPROFILE%\butchr-workspaces\jira-work\<rule
id>\<percent-encoded leaf>` on a real zippy host.

## Setup runbook — admin-assembly only

Everything below needs a human (or admin-assembly acting with real
credentials/host access) on zippy itself. Nothing in this ticket, this doc,
or either example JSON performs any of it.

1. Confirm FACTORY-576/577 has actually landed on the `main` this rules
   file / session definition will run against, before relying on either
   example's `permissionMode` field to do anything for a Codex launch —
   `git log --oneline --grep FACTORY-576` against zippy's own checkout.
2. Place the rule (section 1) into zippy's own
   `%USERPROFILE%\butchr\rules.json` (per FACTORY-563's scope comment —
   **not** codey's `rules.json`) and flip `enabled: true` only once the
   query/brief/harness choice above has actually been reviewed for this
   host's real workload.
3. If a persistent/standalone Codex session (section 2) is actually wanted
   on this host, fill in its real `workingDirectory`/`brief`, place it
   under this host's `sessionDefinitionsPath()` (see
   `docs/managed-sessions.md`), and flip `frozen: false` — again, only
   after review.
4. Confirm `Codex CLI 0.159.2` (named in FACTORY-563's own scope comment)
   is actually on PATH for the account the butchr daemon runs as
   (`Get-Command codex` from an ordinary, non-elevated PowerShell prompt —
   same verification shape `docs/windows-native-host.md`'s own
   troubleshooting section uses for `herdr`), and that it's logged in.
5. If GK's `runeleague`-labeled tasks need Unity build tooling reachable
   from the same host, do the Unity build-environment install/licensing
   steps in `docs/windows-native-host.md`'s own "Unity build environment"
   section (added alongside this ticket) — that section has its own,
   separate admin-only runbook; don't conflate the two.
