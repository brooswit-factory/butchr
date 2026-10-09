# Idle-poke for SessionDefinition agents (FACTORY-926, epic FACTORY-836)

Companion to `docs/idle-poke-role-defaults.md` (FACTORY-842, groups 1-2:
`Rule`-backed resources). This doc covers **group 3**: `director`,
`advisors`, `admins`, and utility sessions (`dialog-monitor`, `genius`,
`buddy` and equivalents) — agents that run as `SessionDefinition` manifests
(`src/resources/session-definition.ts`, one JSON file per agent under the
well-known definitions directory, `sessionDefinitionsPath()`), not `Rule`
resources, and so could not share FACTORY-844/846's schema work directly.

## The safety question, answered first (FACTORY-926 acceptance 1)

**Can a poke reach a `SessionDefinition` agent today, through any path? NO —
unreachable by construction.** Posted with code evidence on FACTORY-942
before any schema change (ticket comment, verify there for the full citation
trail); restated briefly here because it is what makes everything below
config-only rather than a live behaviour change:

- The idle-poke engine's only call site (`idlePoke.check(...)`) is inside
  `syncLabels` (`src/labels/sync.ts`), in a loop over `issues: readonly
  JiraIssue[]` keyed on a Jira issue key.
- `syncLabels` is wired only into the ISSUE-tier loop
  (`src/daemon/index.ts`), fed by `RuleMatch` units whose `issue: JiraIssue`
  field is required and hard-typed (`src/rules/resource-type.ts`) — there is
  no variant that carries a `SessionDefinition`/filesystem resource instead.
- Managed-session agents are matched through an entirely separate pipeline
  (`SessionDefinitionMatch`, `src/rules/session-definition-type.ts`, no
  `issue` field at all) and run under their own dedicated loop
  (`startManagedSessionsLoop`, `src/daemon/session-definitions-loop.ts`),
  whose own `ManagedSessionsLoopDeps` names no `idlePoke`/`syncLabels`
  field, and whose call site in `index.ts` passes neither.
  `test/unit/session-definition-idle-poke.test.ts` pins both of these
  (structurally, against the source) and additionally runs
  `startManagedSessionsLoop` for real against a definition with
  `idlePokeEnabled: true` to prove `deliver` is never called from
  idleness alone — the acceptance-4 "test that would fail if a utility
  session received a poke."

This story's job, per FACTORY-926, is therefore to make that unreachability
**explicit, configurable, and tested** — not to fix a live gap. Everything
below is CONFIG-ONLY / INERT today, the same status group 2's
(`jira-project`) `idlePokeMinutes` has in `docs/idle-poke-role-defaults.md`:
present so an operator's manifest can carry the value, and so a future
engine change has the right field name already chosen, but nothing in this
daemon reads it yet.

## The schema change

`SessionDefinition` (`src/resources/session-definition.ts`) gained three
fields, REUSED VERBATIM from `Rule.idlePokeMinutes`/`idlePokeMessage`/
`idlePokeEnabled` (`src/rules/rules.ts`, FACTORY-844/846) — same names, same
validation, same precedence discipline:

| field | type | resolved default when absent |
|---|---|---|
| `idlePokeMinutes` | positive number, optional | **none** — stays absent; see below |
| `idlePokeMessage` | non-empty string, optional | **none** — stays absent |
| `idlePokeEnabled` | boolean, optional | **`true`** — always resolved by `parseSessionDefinition`, mirroring `parseRules` |

There is no separate "role default" layer here either, same as
`docs/idle-poke-role-defaults.md`'s own precedence section: a definition's
`idlePokeMinutes`/`idlePokeEnabled` is simply the value on that definition —
shipped default or an operator's own later edit, indistinguishable to the
parser. The one difference from the `Rule` case: a `Rule` with no
`idlePokeMinutes` falls back to the global `stalledMinutes`. A
`SessionDefinition` has **no such fallback to fall back to** — no issue-tier
poll ever reaches it at all (see the safety question above), so an absent
`idlePokeMinutes` here does not mean "poked at some other interval," it
means "not read by anything," identically to an explicit value until an
engine exists to read either.

## The shipped per-role defaults (FACTORY-926 acceptance 2/3)

This repo ships no general-purpose "provision a fresh session-definitions
directory" mechanism the way `docs/rules.example.json` provisions
`rules.json` (verify: `git grep -rn "rules.example.json" src/` has no
runtime hits either — that file is deploy-tooling input, not daemon input).
Session-definition manifests are hand-authored per operator in their own
`session-definitions/` directory; `docs/codey-session-definitions.example/`
is a **staged migration proxy for one specific, named live fleet**
(BUTCHR-391/396/408's Codey cutover — see that directory's own test,
`test/unit/codey-session-definitions-example.test.ts`, and its own
provenance caveat), not a generic schema showcase, so this ticket does not
add fields to it: doing so would misrepresent what was actually verified
against that live fleet's real manifests.

The defaults below are instead the field VALUES this story is required to
ship, shown as the JSON an operator adds to their own definition file for
each role. No role→interval table is compiled into daemon logic anywhere —
these are plain data, to be pasted into a manifest, exactly like group 2's
`jira-project` example in `docs/idle-poke-role-defaults.md`.

| role | `idlePokeMinutes` | `idlePokeEnabled` | source |
|---|---|---|---|
| `director` | 1440 (24h) | (absent — defaults to `true`) | epic FACTORY-836 |
| `advisors` | 120 (2h) | (absent — defaults to `true`) | epic FACTORY-836 |
| `admins` | 240 (4h) | (absent — defaults to `true`) | Brooswit's proposal, epic FACTORY-836 |
| `dialog-monitor`, `genius`, `buddy` and other utility sessions | (absent — not applicable) | `false` | epic FACTORY-836, Brooswit's explicit instruction |
| any other definition in this schema | an appropriate interval, or `idlePokeEnabled: false` | — | operator judgment, same as any other field this schema leaves to the operator |

Worked example for a director-shaped definition:

```json
{
  "workingDirectory": "~/.local/state/candlestix/agents/example",
  "brief": "You are director-example. ...",
  "vendor": "claude",
  "tier": "tier1",
  "permissionMode": "auto",
  "execution": "persistent",
  "account": "permanent",
  "role": "sentinel",
  "frozen": false,
  "idlePokeMinutes": 1440
}
```

Worked example for an advisor-shaped definition:

```json
{
  "workingDirectory": "~/.local/state/candlestix/agents/example-advisor",
  "brief": "You are advisor-example. ...",
  "vendor": "claude",
  "tier": "tier1",
  "permissionMode": "auto",
  "execution": "persistent",
  "account": "none",
  "role": "sentinel",
  "frozen": false,
  "idlePokeMinutes": 120
}
```

Worked example for an admin-shaped definition:

```json
{
  "workingDirectory": "~/.local/state/candlestix/agents/example-admin",
  "brief": "You are admin-example. ...",
  "vendor": "claude",
  "tier": "tier1",
  "permissionMode": "auto",
  "execution": "persistent",
  "account": "permanent",
  "role": "sentinel",
  "frozen": false,
  "idlePokeMinutes": 240
}
```

Worked example for a utility-session definition (`dialog-monitor`, `genius`,
`buddy` and equivalents) — **the un-pokeable guarantee is this one field**,
never a code special case and never reliance on today's unreachability
persisting by accident:

```json
{
  "workingDirectory": "~/.local/state/candlestix/agents/example-utility",
  "brief": "You are dialog-monitor. ...",
  "vendor": "claude",
  "tier": "tier1",
  "permissionMode": "auto",
  "execution": "persistent",
  "account": "none",
  "role": "sentinel",
  "frozen": false,
  "idlePokeEnabled": false
}
```

## Rollout: what applying this to a live fleet requires (FACTORY-926 acceptance 6)

This is a schema/config-surface PR. It changes no running daemon by itself —
`sessionDefinitionProblems`/`parseSessionDefinition` accept the three new
fields, and nothing else in this repo reads them (see the safety question
above). Reaching a real, running fleet needs, in order:

1. **An operator (or admin-assembly) edits each live manifest directly.**
   Unlike `rules.json`, there is no provisioning-from-example mechanism for
   `session-definitions/` in this repo — each live file under
   `sessionDefinitionsPath()` (default
   `$XDG_CONFIG_HOME/butchr/session-definitions`, overridable via
   `BUTCHR_SESSION_DEFINITIONS_DIR`) needs the appropriate block above added
   by hand (or by whatever tooling admin-assembly already uses to manage
   that directory — this repo does not contain or describe one).
2. **A daemon restart.** Definition files are read once per poll by
   `startManagedSessionsLoop` (`MANAGED_SESSIONS_POLL_MS`, 15s) — unlike
   `rules.json` (read once at startup), a definition EDIT is picked up on
   the very next poll, no restart required, PROVIDED the daemon process
   is already running this story's merged code (an older binary would
   reject an unknown field via `sessionDefinitionProblems`'s own
   "has unknown field" check, so an old daemon must not be handed a
   manifest carrying these fields yet — upgrade the daemon first).
3. **Nothing to verify "it worked" yet, by design.** Because no engine
   reads these fields today, there is no live behaviour change to confirm —
   a definition with `idlePokeMinutes` set will not start receiving pokes,
   and one with `idlePokeEnabled: false` is no safer than it already was
   (see the safety question above: already unreachable by construction).
   The only thing to verify post-rollout is that the daemon's poll log
   shows no new "unknown field" rejection for any edited manifest — i.e.
   that the upgrade in step 2 actually happened before step 1's edits
   reached a running daemon.
4. **A future engine change** (out of this story's scope, same as group 2's
   `jira-project` wiring is FACTORY-845's scope, not FACTORY-839's) is what
   would ever make these fields live. That change inherits the field names
   and precedence documented here, and must preserve
   `test/unit/session-definition-idle-poke.test.ts`'s own un-pokeable
   assertions for any definition that still carries `idlePokeEnabled: false`.

**Not performed by this ticket:** applying this config to any live
manifest, restarting or deploying any shared daemon — admin-assembly's job,
per the epic (FACTORY-836) and the FACTORY-738 precedent
`docs/idle-poke-role-defaults.md` cites for the same boundary.
