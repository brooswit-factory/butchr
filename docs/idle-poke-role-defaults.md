# Idle-poke per-role defaults and rollout (FACTORY-842, epic FACTORY-836)

Builds on the idle-poke config surface FACTORY-844/846 added to `Rule`
(`src/rules/rules.ts`): `idlePokeMinutes` (number, optional, no resolved
default), `idlePokeMessage` (string, optional, non-empty when present), and
`idlePokeEnabled` (boolean, always resolved, defaults to `true`). This ticket
is CONFIG ONLY — nothing in the daemon reads these fields yet
(`src/agents/stall-remediation.ts` is unchanged); the engine is FACTORY-845.

## Why role defaults must be shipped explicitly, not left absent

`idlePokeMinutes` has **no resolved default on an absent field** — a rule
that sets nothing keeps today's GLOBAL `stalledMinutes`
(`BUTCHR_STALLED_MINUTES`, default 10, `src/config/config.ts`), not the
epic's 30-minute figure. FACTORY-844/846 made that choice deliberately:
resolving absent to 30 would silently retime every existing install's live
stall wake from 10 to 30 (verify at `src/rules/rules.ts`'s own
`DEFAULT_IDLE_POKE_MINUTES` doc comment and `parseRules`, which never
assigns that constant onto a parsed rule).

Consequence: the epic's declared per-role minutes are only real where
**shipped config explicitly carries them**. `docs/rules.example.json`
ships every role's default as an explicit `idlePokeMinutes` value for
exactly this reason — see the table below and
`test/unit/rules-example.test.ts`'s assertions against it.

## Precedence (stated explicitly, per FACTORY-836's instruction)

There is no separate "role default" layer in the schema. A rule's own
`idlePokeMinutes`/`idlePokeEnabled` — whether that value is the role default
this ticket ships, or an operator's own later edit of the same field in
their live `rules.json` — is simply **the value on that rule**. The only
fallback is:

1. **Rule value** (shipped role default, or an operator's override of it —
   indistinguishable to `parseRules`/the engine, both are just "set").
2. **Absent → global `stalledMinutes`** (default 10), unchanged from
   today.

An override is not a separate mechanism to wire — it is editing the same
field FACTORY-844/846 already added, through the existing rules.json /
rules API / Rules-page write path. See
`test/unit/rules.test.ts`'s "per-role idle-poke defaults" describe block for
this proven directly against `parseRules`.

## The per-role defaults shipped in `docs/rules.example.json`

| role | rule id | `idlePokeMinutes` | source |
|---|---|---|---|
| Task | `tasks` | 10 | epic FACTORY-836 |
| Story | `stories` | 60 (1h) | epic FACTORY-836 |
| Epic | `epics` | 240 (4h) | epic FACTORY-836 |
| Bug | `bugs` | 30 | not named by the epic's role list — carries the epic-wide default (`DEFAULT_IDLE_POKE_MINUTES`) explicitly, same reasoning as the "absent" section above: leaving it absent would mean 10 (the global), not the epic's declared baseline |
| Sub-task | `subtasks` | 30 | same reasoning as Bug |

All five keep `idlePokeEnabled` at its default (`true`, on) — nothing in
the epic's role list asks for any of these off. Verify directly against
`docs/rules.example.json` and `test/unit/rules-example.test.ts` at your own
base commit — do not trust this table over the file itself if they ever
disagree.

## project / manager (epic group 2)

A `Rule` can carry `idlePokeMinutes` for a `jira-project` resource exactly
as it can for `jira-work` — the field is provider-generic (verify at
`src/rules/rules.ts`'s `RULE_FIELDS`/validation, which gates on no
`resourceProvider`). This is **not** added to `docs/rules.example.json`:
that file is fixed by BUTCHR-400 to one `jira-work` rule per ticket-worker
role only (verify at `changelog.d/BUTCHR-400.md` and
`test/unit/rules-example.test.ts`'s own assertions — every rule in that
file is `jira-work`, every query contains `assignee = currentUser()`,
neither of which a `jira-project` rule satisfies). Adding a `jira-project`
rule there would contradict that ticket's deliberate, tested scope, so the
project/manager default is documented here instead, as its own example:

```json
{
  "id": "project-managers",
  "resourceProvider": "jira-project",
  "query": "{\"leadAccountId\":\"me\"}",
  "brief": "@builtin:project",
  "idlePokeMinutes": 720
}
```

720 minutes = 12h, the epic's declared project/manager default. This shape
is proven to parse/validate in
`test/unit/rules.test.ts` ("a jira-project (project/manager) rule example
...").

**This value is INERT today.** `src/agents/pinned-active.ts` — the
project-tier's own stall mechanism (there is no Jira issue/label to carry
the issue-tier's `agent:stalled` label for a bare Jira PROJECT resource, so
this module exists as that tier's separate detector; verify at that file's
own header comment and `src/daemon/loop.ts`'s `ReconcileOptions.checkPinnedActive`
doc comment, "Wired into the PROJECT loop ONLY") reads only the global
`config.stalledMinutes` today. Setting `idlePokeMinutes` on a
`project-managers` rule changes nothing in a running daemon until FACTORY-845
wires a per-rule read into that path. Documenting it now, inert, is
deliberate — FACTORY-845 reads the field name from here rather than
inventing one later.

## director, advisors, admins, utility sessions (epic group 3) — not configurable

`director`, `advisors`, `admins`, `dialog-monitor`/`genius`/`buddy` and
other utility sessions are not `Rule` resources at all. They run as
`SessionDefinition` manifests (`src/resources/session-definition.ts`, one
JSON file per agent under the `session-definitions/` directory, loaded by
`src/daemon/session-definitions-loop.ts`) — a schema FACTORY-844/846 never
touched, and today has no `idlePokeMinutes`/`idlePokeMessage`/
`idlePokeEnabled` field at all (verify against `docs/managed-sessions.md`'s
field table).

**Can a poke reach a `SessionDefinition` agent today, through any path?
No.** Verified directly against this repo's `src/daemon/index.ts`:
neither existing stall mechanism is wired into the managed-sessions loop.

- `src/agents/stalled.ts`/`stall-remediation.ts` is invoked only via
  `createLabelSync`'s `syncLabels`, which is wired into the ISSUE-tier
  `runResourceLoop` call alone — that call site's own comment states
  "`syncLabels` only ever processes Jira issues (only the issue
  `runResourceLoop` call wires `syncLabels` in at all...)". It is never
  passed to `startManagedSessionsLoop`.
- `src/agents/pinned-active.ts` is, per its own and `ReconcileOptions
  .checkPinnedActive`'s doc comments (`src/daemon/loop.ts`), "Wired into
  the PROJECT loop ONLY". Also never passed to `startManagedSessionsLoop`.
- `startManagedSessionsLoop`'s own call site and `ManagedSessionsLoopDeps`
  (`src/daemon/session-definitions-loop.ts`) carry admission, crash-loop,
  resume-waiting/resume-preserved and restored-pane-escalation hooks —
  no stall/poke hook of any kind.

So utility sessions are off **by construction**, not merely by an unset
config flag — stronger than, and not in conflict with, the epic's "utility
sessions: poke off" requirement. Making this configurable at all needs a
`SessionDefinition` schema extension, which is out of this ticket's scope
(the epic directed: ship groups 1-2 only, do not touch `SessionDefinition`).
That work is tracked as its own ticket, FACTORY-926 ("Idle poke for
SessionDefinition agents") — this doc points there rather than duplicating
scope. Do not treat this section as that ticket's spec; verify FACTORY-926
itself for its current scope before starting it.

## Rollout: how this reaches a running fleet

This is a config-surface PR; it changes no running daemon by itself. What
can be verified in this repo about rollout:

- `docs/rules.example.json` is, per `changelog.d/BUTCHR-400.md`'s own
  description, "the canonical example rules file every deploy provisions
  its rules file from." That is the mechanism by which the role defaults
  in this doc reach a real install's `rules.json`: an install's rules file
  is provisioned FROM this example file at deploy time, not read from it
  directly at runtime (the daemon never reads `docs/rules.example.json`
  itself outside tests — verify with `git grep -r "rules.example.json" src/`,
  which has no hits).
- Beyond "provisioned from this file at deploy," this repo does not contain
  admin-assembly's own deploy tooling or process, so this doc cannot verify
  further mechanics (how/when a provisioning run happens, whether an
  existing install's `rules.json` is diffed/merged against a changed
  example rather than only used for fresh installs, or anything about
  the `jira-project` project/manager example above — which, since it is
  not IN `docs/rules.example.json`, is not provisioned by that mechanism at
  all and needs its own deploy step this repo does not describe). Treat
  the project/manager rollout as **not yet specified** rather than assume
  it follows the same path.
- Applying any of this to a live/shared daemon, or restarting one, is out
  of this ticket's scope — stated here, not performed.
