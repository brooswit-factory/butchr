# Codey migration runbook: Bakr/Candlestix → Butchr agent cutover

BUTCHR-466 (task of story BUTCHR-396 "S5", epic BUTCHR-391). **This document
is a runbook, not code — it was written by a Servy task agent with no Codey
access and no live-daemon access (BUTCHR-368/BUTCHR-391 hard gate), never by
running anything against a real Codey host.** It is executed by
**manager-factory-bakr** (Bakr-side steps), **manager-factory-candlestix**
(Candlestix-side steps) and **manager-factory-butchr** (staging the Butchr
definitions and running the staging/verification steps), who do have Codey
and live-daemon access, per the epic's own Execution model (BUTCHR-391,
"Servy has NO access to Codey and must not attempt to connect to it, at any
point"). If anything below disagrees with the code, the inventory, or the
epic's own comment history on the host you are actually running against, that
disagreement wins — verify every citation yourself before acting on it (the
same working agreement this factory's `CLAUDE.md` and the ASSIST Confluence
space, `https://wroosbit.atlassian.net/wiki/spaces/ASSIST`, both describe).

**Trust your own environment, not this document, for facts about your own
host.** Read your own `ENVIRONMENT.md`/daemon process for your daemon's
systemd unit, host, port and `journalctl` command. Every path, id, and
Rocket.Chat username below is either copied from a cited BAKR-63/CNDLX-45
comment (a read-only inventory produced by an agent that DID have Codey
access, not observed first-hand by this doc's author) or an explicit
placeholder marked **FILL IN** — re-verify every cited fact against your own
live host before staging anything, never trust this document as the
authoritative source for a live value.

**Evidence and timing for every step in this runbook go to `admin-assembly`**
(BUTCHR-391 comments 23592/23594 — ownership of fleet/hardware/deployment
oversight moved there from the director) — see "Evidence" (§8) for the
template. Where a step also has its own required posting location (Nexus's
`#ask-helpdesk` heads-up, BUTCHR-396's own evidence list), that is named
explicitly in the step.

## 0. Where staged definitions actually live on Codey — OPEN QUESTION, discover first

`sessionDefinitionsPath()` (`src/resources/session-definition.ts`) resolves,
in order: `BUTCHR_SESSION_DEFINITIONS_DIR` (explicit override) else
`$XDG_CONFIG_HOME/butchr/session-definitions` else
`~/.config/butchr/session-definitions` (`docs/managed-sessions.md`, "The
well-known directory") — **this daemon's own resolution, on Codey, is not
something this document's author can see or verify** (no Codey/live-daemon
access). Before staging anything in §3, **manager-factory-butchr must
determine and record Codey's real, resolved value**:

```
# On Codey, as the butchr.service user:
$ systemctl --user show butchr.service -p Environment    # shows the unit's own env, if set there
$ echo "$XDG_CONFIG_HOME"                                  # the shell's own value — may differ from the unit's
$ cat /proc/$(pgrep -f 'node.*butchr|bun.*butchr' | head -1)/environ | tr '\0' '\n' | grep -E '^(BUTCHR_SESSION_DEFINITIONS_DIR|XDG_CONFIG_HOME)='
```

Record the resolved absolute path (and, separately, `sessionArchiveDir()`'s
own resolution — `BUTCHR_SESSION_ARCHIVE_DIR`, else `<definitions-dir>-archive`,
`docs/managed-sessions.md` "The archive directory") on BUTCHR-396's evidence
as the very first entry, before any `butchr session create` call in §3 — a
mismatch between the shell you run `butchr session` from and the daemon's own
resolved directory is a known, silent-unless-you-check failure mode
(`docs/managed-sessions.md` "Shell/daemon environment mismatch": a
definitions-directory mismatch fails loudly as "no definition named ... in
&lt;dir&gt;", but a freeze-store-root-only mismatch does NOT fail loudly —
print and compare the resolved directories every time, per that section).

**Rollback**: nothing is created yet at this step — it is read-only discovery.

## 1. Inventory

### 1.1 Bakr — done, on BAKR-63

The full 22-agent Bakr inventory (source, state, MCPs, RC selector, proposed
disposition) is BAKR-63 comment 23524, refined to a final, fully-decided
22-of-22 disposition in comments 23529/23530. **Nothing further to collect
here** — §2 below reconciles that disposition against the epic's later
one-rule-per-directory refinement. If a fresh Bakr inventory is ever needed
(e.g. after a respawn with no memory of the above), the exact read-only
commands are in BAKR-63 comment 23524's own "Sources" line:
`~/.local/state/bakr/agents.json`, each workspace's `.mcp.json` (server
names/transports/flags only, never secret values), and the live argv of any
running agent (`ps -o pid,args= -p &lt;pid&gt;` for a Bakr-launched Claude
process).

### 1.2 Candlestix — MCP column still pending, exact commands

CNDLX-45 comment 23525 ("Codey inventory v1") has the full 13-agent
role/vendor/tier/permission-mode/RC-user/state table, but its own text
records one open item: **the MCP server names/transports/notification-flags
column** — blocked at the time on a local credential-review gate, since
resolved (Brooswit's approval, CNDLX-45 comment 23515, msg
`mMBTgwsLKMuPkv6rC`: reading the agents' credential-bearing `mcp.json` files
is approved for this purpose, recording only server names/commands/transports
and notification flags — **never a secret value**). manager-factory-candlestix
completes this column with:

```
# For each of the 13 agents' workspaces (~/.local/state/candlestix/agents/<id>/):
$ jq '{mcpServers: (.mcpServers // {} | to_entries | map({name: .key, command: .value.command, args: .value.args, transport: (.value.url // .value.command | if . then (if (.value.url) then "http" else "stdio" end) else null end)}))}' <id>/mcp.json
# For the 10 MUD players specifically, also read the pre-daemon file:
$ cat <id>/mcp.wss-before-daemon.json | jq '{mcpServers: (.mcpServers // {} | keys)}'
# Notification flags: whichever of the agent's own launch argv/config marks a server "notifying" —
# cross-reference against the BAKR-63 inventory's own (n)/(q) convention (comment 23524) for consistency.
```

Post the completed column as a new comment on CNDLX-45 (never edit the
existing 23525 comment) — the same "append, don't rewrite" convention every
other correction on these tickets already follows. Also confirm, per CNDLX-45's
own still-open item: **the Rocket.Chat usernames of the minecraft and mud
directors**, currently only "inferred, not verified" per comment 23525's own
table (`director-brooswit-minecraft`/`director-brooswit-mud`) — verify by
reading the account name the running process's own `x-rocketr-account` header
resolves to (`ps -o pid,args= -p &lt;pid&gt;` if it reaches Codex-style argv, or
the account bound in that agent's own `mcp.json`/`rocketr` connection state),
not by trusting the inferred name.

**Rollback**: read-only, nothing to roll back.

## 2. Mapping — old agent → Butchr definition or explicit retirement

**Reconciled with the one-rule-per-directory refinement** (BUTCHR-391 comment
24003, restated in comment 24007 and on BUTCHR-396 comment 24571): every
Bakr/Candlestix agent that is kept becomes **one managed-session DEFINITION
FILE** under the well-known session-definitions directory (§0) — never a
new, individually-configured `rules.json` `Rule` entry. This is not a
compromise: the built-in `managed-sessions` rule (`docs/managed-sessions.md`,
BUTCHR-408) is already **one filesystem rule**, and it already runs exactly
**one agent per eligible (valid, not frozen) definition file** — which is
precisely "one filesystem rule with one agent per directory" once you read
"directory" as "the definition's own `workingDirectory`," not as "one
`rules.json` rule per agent." A definition's own `execution`/`account`/`role`
fields (persistent/permanent/sentinel, in every row below) are what carry
Nexus's/each director's/each MUD player's own settings — **from its own
directory's definition**, exactly as the refinement says — never from a
shared rule default.

**Non-goal, unconditional for every row below** (BUTCHR-391 epic decision,
"Non-goal: no boss/worker relationship model for query-based agents"): none of
these 14 definitions gets an `Implements` link, `report_to_boss`/
`ask_boss`/`submit_to_boss`, or a `childRule`/`inwardConnectionRules` wiring —
they are query-based (filesystem-provider) agents, not jira-work ticket
agents. Where a definition needs Jira/Confluence, it gets the
operator-configured Atlassian MCP connection instead (see §3's `atlassian`
binding on Nexus/the 3 directors) — never Butchr's `jira_*`/`confluence_*`
tools or boss verbs.

| Old agent (Bakr/Candlestix id) | Source | Butchr disposition |
|---|---|---|
| `admin-brooswit-nexus` (@n0y45b5r4f2ydey7nc) | BAKR-63 c23524/23530 | **Managed-session definition**, `execution: persistent`, `account: permanent`, `role: sentinel`, rocketr (channel) + Atlassian MCP. Staged and cut over **FIRST**. See `docs/codey-session-definitions.example/admin-brooswit-nexus.json`. |
| 13 Bakr `lead-*` (`bakr-resident`→`lead-bakr`, `butchr`→`lead-butchr`, `lead-candlestix`, `lead-drovr`, `factory-dashboard`→`lead-factory-dashboard`, `rocketr`→`lead-rocketr`, `lead-gbln`, `lead-dynamic-atmosphere`, `lead-dynamic-population`, `lead-rinth`, `lead-schematic`, `lead-sickos`, `thatch`→`lead-thatch`) | BAKR-63 c23524/23530 | **No new definition — already replaced** by the corresponding Butchr `jira-project` PM. Retire the Bakr entry only after confirming that PM is live (see §4.2). |
| `brooswit-factory` (@5vvhmskvc5bawvvnwq), `brooswit-minecraft` (@n53w2n4srwx2g1pgzz) | BAKR-63 c23524/23530, CNDLX-45 c23528 | **No new definition** — superseded by `director-brooswit-factory`/`director-brooswit-minecraft` per the Candlestix `migration-source.json` files (confirmed on CNDLX-45 c23528). Retire in Bakr with no replacement of their own. |
| `brooswit` (@r9h9dpyxmwkyrjv00q) | BAKR-63 c23530 | **Retire, no Butchr definition** — Brooswit's explicit decision (relayed, msg `GqCACWixC7c4KkoQi`). |
| `yappr-3`, and 4 archived (`rocketchat`, `drovr-2`, `drovr-3`, `yappr-2`) | BAKR-63 c23524/23530 | **Retire.** `yappr-3`'s slot was the real, already-retired yappr messaging service — never carry `yappr` into a Butchr definition (this is DIFFERENT from the MUD players' `yappr`-named channel slot below, which is the mud-mcp bridge, not the yappr service — do not conflate the two). Old Bakr `"off"` → Butchr `frozen: true`; old `"archived"` → Butchr's own archive directory (`butchr session archive`), never a live definition at all. None of these 5 had a live process (all `off`/`archived` already), so there is no live handshake step for them beyond marking them retired/archived in Bakr's own record (§4.2). |
| `director-brooswit-factory` (@01m32mcw3vjzfaa19j) | CNDLX-45 c23525/description | **Managed-session definition**, `execution: persistent`, `account: permanent`, `role: sentinel`, rocketr (channel) + Atlassian MCP, `permissionMode: auto`. **BLOCKED ON S7/BUTCHR-453** for the `--strict-mcp-config` property — see §4.4's explicit gate. Migrates **LAST**, with the other 2 directors. See `docs/codey-session-definitions.example/director-brooswit-factory.json`. |
| `director-brooswit-minecraft` (@01m32mcw3yj20qnw0c) | CNDLX-45 c23525/description | Same shape as `director-brooswit-factory`, same BLOCKED-ON-S7 gate. See `.../director-brooswit-minecraft.json`. |
| `director-brooswit-mud` (@01m32mxkxg1ejzz995) | CNDLX-45 c23525/description | Same shape, same BLOCKED-ON-S7 gate. Also the sole `freezeControllers` grantee on every MUD-player definition below — keep its own workspace subtrees (`infrastructure/`, `mud-mcp/`, `nexus-mud/`, `roleplayers/`, `candlestix-attach`) intact; nothing here deletes or restructures them. See `.../director-brooswit-mud.json`. |
| 10 `mud-player-{aelric,bressa,corvin,della,edrin,fenna,garrick,hestia,ivor,junia}` | CNDLX-45 c23525/23532/23534 | **Managed-session definitions**, `execution: persistent`, `frozen: true` (kept frozen — old Bakr/Candlestix `"off"` maps to Butchr `frozen`), `account: none`, `role: sentinel` (exempts them from the fleet cap once/if ever unfrozen — see `docs/managed-sessions.md` "role → fleet-capacity admission"; frozen definitions are never in the eligible set regardless, per "Eligible = valid, not frozen"), `tier: tier1`. Channel server is the **mud-mcp bridge** — the slot historically named `yappr` in their old config **is the bridge itself, never the retired yappr service, and must NEVER become a `rocketr` binding** (CNDLX-45 c23532/23534 — this reversed an earlier rocketr+permanent proposal the director explicitly rejected). `freezeControllers: ["director-brooswit-mud"]`; **no `unfreezeControllers`** — CNDLX-45's own decision defers whether the director may also unfreeze them to a separate, later judgment call (`docs/managed-sessions.md` "Delegated freeze/unfreeze": "whether it may also UNFREEZE them is a separate, explicit judgment call... not a byproduct of this ticket"). See `docs/codey-session-definitions.example/mud-player-*.json`. |

Every row above accounts for all 22 Bakr + 13 Candlestix = 35 old agents:
1 (Nexus) + 13 (lead-\*) + 2 (factory/minecraft, superseded) + 1 (brooswit)
+ 5 (yappr-3 + 4 archived) = 22 Bakr, and 3 (directors) + 10 (MUD players) =
13 Candlestix. 14 of the 35 get a new Butchr managed-session definition;
the other 21 are retirements with no new definition (13 already covered by
existing Butchr PMs, 8 covered by nothing at all).

## 3. Staged definitions

The 14 definitions above are drafted at
`docs/codey-session-definitions.example/*.json` in this repo, one file per
agent, named for `butchr session create`/`show`/`freeze` to use directly
(basename, with or without `.json`). **They are validated through the real
loader** (`parseSessionDefinitionFile`) in
`test/unit/codey-session-definitions-example.test.ts` — that test proves
every file parses and carries the right `execution`/`account`/`role`/
`frozen`/MCP shape from §2's table; it proves nothing about whether a
placeholder value (below) is the real one.

**Before copying any of these into Codey's real session-definitions
directory (§0), replace every placeholder:**

- `workingDirectory` — Nexus's (`~/Projects/rocketchat`) is BAKR-63 c23524's
  own value; the 3 directors' (`~/.local/state/candlestix/agents/<id>/`,
  literal ids from CNDLX-45 c23525's table) are given in full there. **The 10
  MUD players' ids are NOT independently verified here** — CNDLX-45 c23525's
  own table renders 9 of the 10 ids as an ellipsis-shortened shared prefix
  (only `mud-player-aelric`'s id, `01m3328tx4eqcfk581`, is given in full);
  this runbook's `mud-player-{bressa,corvin,della,edrin,fenna,garrick,hestia,
  ivor,junia}.json` therefore each carry an explicit
  `UNVERIFIED-ID-for-<name>-see-runbook-open-questions` placeholder directory
  rather than a guessed reconstruction of the truncated id. **Confirm each of
  these 9 directory names against your own live
  `~/.local/state/candlestix/agents.json` before staging** — do not trust a
  pattern-completed guess at the missing suffix.
- `mcpServers[].url` for `rocketr` and `atlassian` (`https://rocketr.internal.example/mcp`,
  `https://atlassian-mcp.internal.example/mcp`) — placeholders. Get rocketr's
  real MCP endpoint from Nexus/rocketr's own operator (same "not this
  runbook's to assert" caveat `docs/real-rc-verification-runbook.md`'s §6
  already carries for the identical field), and the Atlassian MCP endpoint
  from admin-assembly/whoever operates it — this is the "operator-configured
  Atlassian MCP connection" the epic's own non-goal section requires, and
  this repo's docs do not describe its provisioning (see Open Questions, §9).
- `mcpServers[].url` for `mud-mcp` (`https://mud-bridge.internal.example/mcp`)
  — get the real endpoint from whoever operates the shared mud-mcp HTTP
  daemon (CNDLX-45 c23532); the 10 MUD-player files all share one placeholder
  value, update all 10 together if it changes.
- `mcpServers[].headersEnvVar` on each `atlassian` binding
  (`*_ATLASSIAN_MCP_HEADERS`) — pick real, distinct env-var names on the
  daemon's own process per `docs/mcp-server-bindings.md`'s "Headers are by
  reference, never inline" discipline; never a literal header value in the
  definition file.

**None of the 3 director definitions sets a strict-MCP-config field** — no
such field exists in `src/resources/session-definition.ts` today (verified
live against `origin/main` while writing this runbook; BUTCHR-453/S7, which
adds it, is still In Progress — see §4.4). `permissionMode: "auto"` alone is
staged and stageable today; the strict-MCP half of "permission mode auto with
strict MCP config" is not, and this is exactly why §4.4 gates the directors'
cutover, not their staging.

**Rollback**: nothing is live yet — these are files in a git repo, not a
Codey artifact. Rollback for the actual `butchr session create` step is in
§4.1's own per-step rollback.

## 4. Staging + verification

For each of the 14 definitions in §2/§3, once its placeholders (§3) are
replaced with real values:

### 4.1 Stage it

```
$ butchr session create <name> \
    --working-directory '<real workingDirectory>' \
    --brief '<the brief text from the .example file>' \
    --vendor claude --tier <tier> --permission-mode auto \
    --execution persistent --account <none|permanent> --role sentinel \
    --mcp-servers '<the mcpServers JSON array from the .example file, with real urls/env-vars>' \
    [--freeze-controllers director-brooswit-mud]   # MUD players only
```

(`butchr session create` refuses outright if a definition of that name
already exists in either the active or archive directory —
`docs/managed-sessions.md` "Archive/unarchive"'s own collision-check note —
so a repeat run is safe to attempt and simply tells you if it's already
there.) For a MUD-player definition, **immediately follow creation with**:

```
$ butchr session freeze <name>
```

so it starts life frozen (matching old Bakr `"off"` → Butchr `frozen`) —
`create` itself has no `--frozen` flag to set this at creation time (verify
against your own build's `butchr session create --help`; if one has been
added since this runbook was written, use it instead and skip this second
step).

**Expected**: `butchr session show <name>` prints the definition back with
every field matching §2's table, and (once the daemon's next poll runs,
≤`MANAGED_SESSIONS_POLL_MS` = 15s later) `butchr session list` shows it as
eligible (or, for a MUD player, correctly excluded as frozen).

**Rollback**: `rm` the definition file directly (there is no `butchr session
delete` verb as of this runbook — verify; if the CLI now has one, prefer it).
Nothing was ever enabled for cutover at this step, so removing the file is a
complete, safe rollback with no live-agent side effect.

### 4.2 Verify every MCP: connection + a real tool call

For each definition's `rocketr`/`atlassian`/`mud-mcp` binding: confirm the
daemon's `mcp.json` for that agent lists it (`buildWorkspace`'s output,
`docs/mcp-server-bindings.md` "Launch wiring" § Claude), and have the running
agent make one real tool call against it (e.g. rocketr: post a message to a
channel it's bound to and confirm delivery; atlassian: read one issue/page it
has access to; mud-mcp: call `mud_status` and confirm a real response) — not
just that the connection handshakes. Record each as pass/fail with the actual
request/response shape (no secret values) in the evidence (§8).

For the 13 already-replaced Bakr `lead-*` PMs (§2's second row): **"confirm
each PM live" means exactly this same MCP-plus-liveness check against the
EXISTING Butchr `jira-project` PM**, not a new definition — `ps`/`butchr`
status output showing the PM process running, plus one real Jira/Confluence
tool call succeeding through it.

### 4.3 Channel delivery

- **Claude + Codex over rocketr**: bind the same rocketr server to one Claude
  and one Codex test agent (or reuse Nexus's/a director's own binding once
  staged) and confirm each receives a pushed channel message —
  `docs/mcp-server-bindings.md` "Evidence of event-driven delivery" and
  `docs/codex-channel-relay.md` are the precedent for what this evidence
  looks like (a `<channel source="rocketr" ...>` frame for Claude; a
  `[notify] codex channel relay: ...` daemon log line, never mislabeled
  "Claude channel," for Codex). **This runbook does not duplicate the full
  real-RC verification protocol** — `docs/real-rc-verification-runbook.md`
  (§§6-7) is the authoritative, step-by-step version of this exact check,
  including Nexus's test-account terms; run that runbook's §§1-3, 6-7 for
  the actual real-RC evidence, and reference its own evidence output here
  rather than re-deriving it.
- **Claude over the mud bridge**: `docs/real-rc-verification-runbook.md` §8
  is the authoritative version of this check too (no RC account, a real
  herdr-managed PTY pane, a timestamped push→observe→turn-starts sequence
  with zero polling and zero additional input) — run it against a staged
  MUD-player definition (unfrozen just long enough to verify, per §4.5's own
  narrow exception, then re-frozen) or an equivalent disposable
  `mud-mcp`-bound test definition, and reference its evidence output here.

### 4.4 The 3 Candlestix directors — BLOCKED ON S7/BUTCHR-453, do not execute yet

**Do not stage these for cutover, and do not run §5's handshake for them,
until BOTH of the following are true:**

1. **BUTCHR-453 (S7) has landed** — as of this runbook being written,
   BUTCHR-453 is **In Progress** (its own Task, BUTCHR-463, is investigating
   the Drovr-side change; verify current status yourself with
   `jira_get_issue` before relying on this line, since it will go stale).
   S7's own DoD is: a Drovr-side `--strict-mcp-config` launch option, a new
   managed-session manifest field that reaches it (name TBD — check
   `src/resources/session-definition.ts` at the time S7 lands; it does not
   exist as of this runbook), a test proving a Claude launch with it set
   emits the flag, and a documented Codex behavior (S7's own working plan:
   reject-at-manifest-load, not silent-ignore).
2. **The strict-MCP property is verified REAL on the actual staged director
   definition, not merely that `permissionMode` reads `"auto"`.** `"auto"`
   alone is already stageable today (§3) and says nothing about whether MCP
   discovery is strict — confirm the new field is set AND that a live
   director agent launched with it actually receives
   `--strict-mcp-config` in its own argv (`ps -o pid,args=` for that pane),
   not just that the manifest field parses.

**If this step is somehow reached before S7 lands, STOP and flag it on
BUTCHR-391** — do not improvise a workaround (e.g. shipping the directors
with `auto` alone and treating strict-MCP as "close enough"); the whole
point of gating here is that a director without it has silently lost a
security property relative to its old Candlestix configuration.

### 4.5 A note on verifying a FROZEN MUD-player definition

A frozen definition runs no agent at all (`docs/managed-sessions.md`
"Eligible = valid, not frozen") — so §4.2/§4.3's "real tool call" checks
cannot be performed against it while it stays frozen. Options, in order of
preference: (a) have `director-brooswit-mud` briefly `unfreeze_session` one
player, verify, then `freeze_session` it again — this exercises the real
delegated-freeze mechanism as a side effect, which is itself worth recording
as evidence; or (b) verify the shared `mud-mcp` binding's connectivity and
tool surface against a disposable, unfrozen test definition instead, and
note in the evidence that the real MUD-player definitions themselves were
never briefly unfrozen. **Either way, record which option was used** — do
not silently skip verification because the definition is frozen by design.

## 5. Cutover handshake

**Per agent**: (1) Butchr confirms the replacement is live and §4-verified
with evidence; (2) the old project's manager (Bakr or Candlestix) turns off
the old agent; (3) confirm no duplicate owners (§7); (4) retire the old
Rocket.Chat user in favor of a Butchr-managed account where one applies.
**Order is fixed**: Nexus → remaining Bakr retirements + `bakr.service` stop
→ MUD players → the 3 directors + `candlestix.service` stop. Every step is
gated on its own readiness+evidence, not a fresh authorization ask — cutover
itself was pre-authorized "whenever it's ready" (BUTCHR-391 comment 23586).
**Any failure at any step: STOP, roll back to the old supervisor, do not
proceed to the next step until resolved.**

### 5.1 Nexus — FIRST

1. Heads-up in `#ask-helpdesk`, **immediately before** moving Nexus (Nexus
   goes briefly silent during the move — schedule clear of its own account
   or channel work, BUTCHR-391 comment 23592).
2. Precondition: the Butchr `admin-brooswit-nexus` definition is staged,
   `persistent`, `permanent` account, rocketr verified (§4.2/4.3).
3. Snapshot `~/.local/state/bakr/agents.json` and `bakr status --json`
   (BAKR-63 comment 23586's own runbook).
4. `bakr admin-brooswit-nexus off`.
5. Confirm: the Bakr pane for Nexus is gone; exactly one Nexus process runs
   (Butchr's — see §7's duplicate check); the Nexus RC account still
   responds (`curl` a `users.info` lookup, or an actual message round-trip).
6. **Rollback**: `bakr admin-brooswit-nexus on`, then report the failure on
   BUTCHR-396 and admin-assembly.

### 5.2 Remaining Bakr retirements, then `bakr.service` stops

1. Precondition: every one of the 13 `lead-*` PMs confirmed live (§4.2's own
   note on this).
2. Mark the 8 no-new-definition agents (`brooswit-factory`,
   `brooswit-minecraft`, `brooswit`, `yappr-3`, and the 4 archived agents)
   retired/archived in Bakr's own record. None had a live process, so this
   is a record update, not a live stop.
3. `systemctl --user stop bakr.service`, then
   `systemctl --user disable bakr.service`.
4. Confirm with `ps` and Butchr's own status/dashboard that no agent is
   supervised twice (§7).
5. **Rollback**: `systemctl --user enable --now bakr.service`, then report.

### 5.3 The 10 MUD players

**Acceptance is different from every other row**: each definition exists and
**stays frozen** — role, MCPs and the mud-mcp bridge binding intact, **no RC
account**. There is no "turn it on" step here; unfreezing is explicitly out
of scope for this migration (§2's own note). The Candlestix-side action per
player is: confirm the Butchr definition exists and is correctly frozen
(§4.1's `show` output), then mark that player's entry retired in
Candlestix's own record — **do not stop the underlying Candlestix session
process for a player until its Butchr definition is confirmed frozen-and-
correct**, since a frozen-but-wrong Butchr definition with the Candlestix
original also stopped would leave nobody actually able to unfreeze the right
thing later.

**Rollback per player**: `butchr session archive <name>` (removes it from the
eligible set entirely, equivalent to not having migrated it) or simply leave
the old Candlestix session running alongside a still-frozen Butchr
definition (frozen means no live agent, so no duplicate-owner risk from
leaving both) while the discrepancy is investigated.

### 5.4 The 3 directors — LAST, gated on §4.4

**Do not start this section until §4.4's BOTH conditions are met.** Then, per
director (`director-brooswit-factory` first per its own "migrates last, with
the other 2" note, remaining 2 in either order, `director-brooswit-factory`
never before `director-brooswit-minecraft`/`director-brooswit-mud` per
CNDLX-45's own per-row notes — verify no ordering constraint was added since
this runbook was written):

1. Precondition: staged, `persistent`, `permanent` account, `auto` +
   verified-real strict-MCP (§4.4), rocketr + Atlassian MCP verified (§4.2).
2. Confirm via Candlestix's own tmux/process listing
   (`candlestix-<id>` panes per CNDLX-45 c23525) that the old director
   session is the one being retired, then stop it through Candlestix's own
   mechanism (verify the exact command against Candlestix's own CLI/docs —
   not captured in this runbook, since this document's author has no
   Candlestix-side tooling reference beyond the Jira inventory).
3. Confirm no duplicate owner (§7).
4. Retire the director's old RC account in favor of the Butchr-managed one.
5. Once all 3 directors are cut over: `systemctl --user stop
   candlestix.service`, then `systemctl --user disable candlestix.service`.
6. **Rollback**: restart the old director session through Candlestix's own
   mechanism (or `systemctl --user enable --now candlestix.service` if the
   whole service was already stopped), then report.

## 6. Preservation

Both bundles were already created (BAKR-63 comment 23529;
CNDLX-45 description/comment 23525) — the commands below let you **verify**
what already exists, or **recreate** it if a respawn/investigation needs a
fresh one. **No remote push, ever, for either** — both stay strictly local to
their own manager's workspace.

### 6.1 Bakr — `preserve/bakr-checkout-9d52f7c/` (BAKR manager workspace)

```
# Verify what's already there:
$ cd <BAKR manager workspace>/preserve/bakr-checkout-9d52f7c/
$ sha256sum -c SHA256SUMS

# Recreate, only if needed (from ~/code/brooswit-factory/bakr, HEAD 9d52f7c, working tree UNCHANGED):
$ git -C ~/code/brooswit-factory/bakr bundle create bakr-all-refs.bundle --all
$ git -C ~/code/brooswit-factory/bakr diff HEAD > uncommitted-tracked.patch
$ tar -C ~/code/brooswit-factory/bakr -czf untracked-files.tgz \
    docs src/fallback src/instance-freeze.ts test/integration/fallback.test.ts vendor \
    .claude/worktrees/bakr-launch-channels .claude/worktrees/per-directory-channels
$ sha256sum bakr-all-refs.bundle uncommitted-tracked.patch untracked-files.tgz > SHA256SUMS
$ git -C ~/code/brooswit-factory/bakr status --porcelain   # must be identical before/after — confirm nothing was touched
```

### 6.2 Candlestix — `preserve/candlestix-runtime-f198ae1/` (CNDLX manager workspace)

```
# Verify what's already there:
$ cd <CNDLX manager workspace>/preserve/candlestix-runtime-f198ae1/
$ sha256sum -c SHA256SUMS

# Recreate, only if needed (from ~/.local/share/candlestix/runtime-f198ae1, feat/codex-channel-agents, head 5bc1abc):
$ git -C ~/.local/share/candlestix/runtime-f198ae1 bundle create feat-codex-channel-agents.bundle --all
$ git -C ~/.local/share/candlestix/runtime-f198ae1 diff HEAD > uncommitted.patch
$ tar -C ~/.local/share/candlestix/runtime-f198ae1 -czf untracked.tgz \
    bin/confirm-dev-channels.sh vendor/brooswit-drovr-freeze.tgz
$ sha256sum feat-codex-channel-agents.bundle uncommitted.patch untracked.tgz > SHA256SUMS
```

Disposition of both unpublished runtimes (already agreed, recorded for
completeness — see BAKR-63 comment 23526 and CNDLX-45 comment 23525's own
"Unpublished runtime disposition"): `instance-freeze.ts` idea → ported to S3
(BUTCHR-394, done); Candlestix's tier→model mapping → ported to S2
(BUTCHR-393/`docs/managed-sessions.md`'s own tier table, done, with the
CAVEAT that doc already carries: unverified against the live file, since
neither preserved bundle above was reachable from this build host when that
table was ported — see `docs/managed-sessions.md` "Tier -> model mapping").
Bakr's Codex-fallback runtime and Candlestix's Codex channel/steering
delivery → reference material for S4/BUTCHR-359. Bakr's quota-trigger and
platform-storage-paths code, and Candlestix's long-lived-lifecycle-timeout
commits → shelved, not ported. Nothing was discarded — everything not ported
still exists in the bundle above.

## 7. No-duplicate-agents check (run after EVERY cutover step in §5)

```
# On Codey:
$ ps -eo pid,ppid,args | grep -iE 'claude|codex' | grep -v grep   # every live agent process
$ bakr status --json 2>/dev/null | jq '[.[] | select(.state=="on")]'         # every Bakr-supervised agent still "on"
$ candlestix agents.json equivalent listing (verify Candlestix's own status command)
$ butchr session list                                                        # every Butchr-eligible managed-session agent
```

**Expected, after every step**: the union of "Bakr on" + "Candlestix live" +
"Butchr eligible, not frozen" processes for the agent just cut over contains
**exactly one** entry — the new Butchr one, never both. **Fails as**: two
processes for the same logical agent (the old supervisor's stop didn't
actually land — investigate before proceeding, per the epic's own "if a step
fails, stop and roll back" rule) or zero processes where one is expected
(the Butchr side didn't actually come up — same rule, roll back to the OLD
supervisor, don't leave the agent with neither).

## 8. Evidence template

For each cutover step (§5), record on **BUTCHR-396** and **admin-assembly**
(per BUTCHR-391 comments 23592/23594):

```
## Cutover evidence: <agent name>
- Step: <§ number, e.g. "5.1 Nexus">
- Timestamp (UTC): <when the old agent was turned off>
- Precondition evidence: <link to the §4.2/4.3 MCP+channel verification for this agent>
- Old-supervisor stop command + output: <exact command run, exact output>
- No-duplicate-agents check (§7) output, before and after
- New Rocket.Chat account (if applicable): derived username, created/adopted, old account's own retirement/replacement status
- Result: PASS | FAILED-ROLLED-BACK (if the latter, link the rollback evidence and the follow-up)
```

For §0/§1's discovery/inventory steps and §6's preservation, a simpler
record (what was read/created, the resolved path or bundle/hash, timestamp)
suffices — no live-agent state changed.

## 9. Open questions (do not guess — ask, then record the answer here before relying on it)

1. **The Atlassian MCP connection's real endpoint and credential mechanism**
   for Nexus and the 3 directors — this repo's docs describe `rocketr`'s
   `accountHeader` mechanism in detail but say nothing about how the
   "operator-configured Atlassian MCP connection" the epic's non-goal
   section requires is itself provisioned (a shared endpoint with a
   per-agent header, like rocketr? A separate credential per agent? Ask
   admin-assembly/whoever operates it, do not assume it mirrors rocketr's
   shape.
2. **The 9 unverified MUD-player directory ids** (§3) — confirm each against
   the live `~/.local/state/candlestix/agents.json` before staging; do not
   trust a pattern-completed guess at CNDLX-45 c23525's ellipsis-shortened
   ids.
3. **Nexus's own rocketr binding** (`docs/codey-session-definitions.example/admin-brooswit-nexus.json`)
   — every other agent's rocketr binding uses the non-secret `accountHeader`
   mechanism alone (BUTCHR-412's corrected credential design: "an agent
   never holds a Rocket.Chat credential"). Nexus is different: BAKR-63/
   CNDLX-45 both note "RC admin credentials belong to NEXUS," meaning Nexus's
   OWN agent may need broader, directly-held RC admin authority to actually
   operate rocketr (create/register other accounts), not just an
   account-name header identifying it as one more rocketr client. Confirm
   with Nexus whether its own managed-session definition needs a DIFFERENT
   binding shape (e.g. an additional `headersEnvVar`-backed admin credential)
   before staging it as written.
4. **Exact Candlestix session-stop command** (§5.4 step 2) — this runbook
   does not have Candlestix's own CLI/docs to cite; manager-factory-candlestix
   should supply and record the actual command used, the first time §5.4 is
   executed, so a future re-run of this runbook has a real citation instead
   of this placeholder note.
5. **Ordering among the 3 directors** (§5.4) — CNDLX-45's per-row notes say
   `director-brooswit-factory` "migrates last" and the other two go "with the
   directors (last)," which this runbook reads as "as a group, after
   everything else" without a strict internal order. Confirm no stricter
   internal ordering was decided elsewhere before treating "any order within
   the group" as settled.
6. **The exact new manifest field name for strict-MCP-config** (§4.4) —
   BUTCHR-453/S7 had not landed as of this runbook being written; re-verify
   the field's real name and shape against `src/resources/session-
   definition.ts` once it does, rather than assuming a name.
