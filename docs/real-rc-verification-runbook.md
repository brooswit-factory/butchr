# Real Rocket.Chat verification runbook (BUTCHR-395/S4 → S5 Codey staging)

BUTCHR-415 (task of story BUTCHR-395, epic BUTCHR-391). **This document is a
runbook, not code.** It was written by a Servy task agent with no Codey
access, no live Rocket.Chat (RC) access, and no live-daemon access
(BUTCHR-368) — every command, variable name, path and default below was
verified by reading the merged source on `origin/BUTCHR-395`, cited inline,
never by running it against a real RC. It is **executed later, in S5 Codey
staging, by manager-factory-butchr**, who does have Codey and RC access
(BUTCHR-391 comments 23817/23821; BUTCHR-395 comments 23819/23824 — verify
each citation on the ticket it actually names, not by assumption). If anything below disagrees
with the code on the branch you are actually running, the code wins — verify
the citation yourself before acting on it, per this factory's own working
agreement (`docs/../CLAUDE.md`'s "Writing for another agent" section, and the
ASSIST Confluence space, `https://wroosbit.atlassian.net/wiki/spaces/ASSIST`).

**Unlike the tasks that produced the code this runbook exercises, you (the
Codey manager) are expected to touch a real, live daemon and a real,
production Rocket.Chat.** That is the entire point of this gate — do not
mistake anything below for a suggestion to build a fake-RC test instead.

**Trust your own environment, not this document, for facts about your own
host.** Read your own `ENVIRONMENT.md`/daemon process for your daemon's
systemd unit, host, port and `journalctl` command; nothing below assumes a
specific one. Read the code at the commit you are actually running for any
line number or file path cited here — line numbers rot, symbol names and
`docs/*.md` section titles are the stable anchors used throughout.

## 0. What "verified" means here, and what this runbook does not cover

There is no staging Rocket.Chat — only production, `https://chat.brooswit.nexus`
(BUTCHR-391 comment 23817, BUTCHR-395 comment 23819; ~33-40 of 50 seats in use
depending on which comment you read — **re-count live yourself in Step 3**, do
not trust either number as current). "Verified against a real Rocket.Chat"
therefore means: temporary, clearly-named test accounts on that live system,
cleaned up afterwards, approved in advance (BUTCHR-391 comment 23821,
BUTCHR-395 comment 23824). Every step below that touches RC is a live-system
action against production — treat it with the same care you would any other
production change.

**BUTCHR-460 (archive → account release, PR #428) has now MERGED** into
`BUTCHR-395` (`d7aa251`, merged 2026-09-26) — verify this is still true for
whatever commit you are actually running (`gh pr view 428 --repo
brooswit-factory/butchr --json state,mergedAt`) before trusting Step 4's
archive subsection below, which is written against that merged code.

**Design docs this runbook is written against** (read them yourself before
running anything — they are the actual contract, this is a walkthrough of
it): `docs/rocketchat-accounts.md` (BUTCHR-410/412 — the account manager,
credential design, caps, batching, token reuse), `docs/codex-channel-relay.md`
(BUTCHR-413 — the Codex wake/reply path and its own "Real-RC gate"
observables), `docs/mcp-server-bindings.md` (BUTCHR-411 — `Rule.mcpServers`,
`accountHeader`, Codex argv safety), `docs/managed-sessions.md` (BUTCHR-408 —
managed-session definitions, for the Nexus/directors/MUD-player identities
S5's own mapping names), `docs/execution-modes.md` (BUTCHR-397/398 —
`execution`/`account`/`role`).

**BUTCHR-460 (archive → account release, PR #428) merged into `BUTCHR-395`
as `d7aa251`** — Step 4's archive subsection is written against that merged
code (`src/agents/managed-session-account-release.ts`,
`docs/rocketchat-accounts.md`'s "Archive release (BUTCHR-460)" section,
`docs/managed-sessions.md`'s "Archive/unarchive" section). If you are running
against a checkout where 460 has since been reverted or materially changed,
that subsection no longer applies as written — re-verify against your own
checkout's code before trusting it.

## 1. Preconditions and credentials

### 1.1 The provisioner account and its token

Butchr never uses a shared admin token belonging to some other identity —
it is configured with its **own** dedicated Rocket.Chat account and Personal
Access Token, read from a **file path**, never inline. Verified in
`src/resources/rocketchat.ts`'s `loadRocketChatAuth` and
`src/config/config.ts` (~line 403-427):

| Env var | Meaning | Default |
|---|---|---|
| `ROCKETCHAT_URL` | RC base URL, e.g. `https://chat.brooswit.nexus` | none (RC subsystem stays entirely dormant without it) |
| `ROCKETCHAT_ADMIN_USER_ID` | The provisioner account's RC user id (not a secret) | none |
| `ROCKETCHAT_ADMIN_TOKEN_FILE` | Path to a file holding the provisioner's PAT, and nothing else | none |
| `ROCKETCHAT_USER_CAP_THRESHOLD` | The 50-user guardrail (Step 3) | `45` |
| `ROCKETCHAT_TEMPORARY_CAP_THRESHOLD` | The separate temporary-account cap (Step 3/4) | `8` |
| `ROCKETCHAT_TOKEN_DIR` | Where each managed account's 0600 token file is written | `<workspace root>/.butchr-rc-tokens` |
| `ROCKETCHAT_NEXUS_MANIFEST_FILE` | Where the batched Nexus hand-off manifest is published | `<workspace root>/.butchr-rc-nexus-manifest.json` |
| `ROCKETCHAT_MANAGED_PREFIX` | The managed-username marker/naming-convention prefix | `butchr_` (`RC_MANAGED_PREFIX`, `src/accounts/identity.ts`) |

`<workspace root>` is `$BUTCHR_WORKSPACES`, else `~/butchr-workspaces`
(`workspaceRoot()`, `src/agents/workspace.ts`) — **your** daemon's own value,
verify with `echo "$BUTCHR_WORKSPACES"` in the daemon's own environment or by
reading its systemd unit file, not by assuming the default.

**All three of `ROCKETCHAT_URL`/`ROCKETCHAT_ADMIN_USER_ID`/
`ROCKETCHAT_ADMIN_TOKEN_FILE` must be set, or none of this activates at all**
(`Config.rocketchat` is `undefined` otherwise — `src/config/config.ts`
~line 403) — a daemon with none of these set, and no rule/definition using
`account !== "none"`, behaves exactly as it did before S4 shipped. Setting
only one or two is not a partial activation; it is the same as setting none.

**Token file discipline** (`loadRocketChatAuth`, `src/resources/rocketchat.ts`
lines 68-84 — this is the exact set of checks that will make Step 1 FAIL if
not met, in order):
- The path must exist and be a regular file (not a symlink target that isn't
  a file, not a directory) — `ENOENT`/non-file → `"... cannot be read"` /
  `"... is not a regular file"`.
- Mode must reject group/other access: `st.mode & 0o077` must be `0` — i.e.
  `chmod 600` (or stricter). A `644`/`640`/group-readable file is refused
  with the exact offending octal mode named in the error.
- Owned by the daemon's own uid, or root — a file owned by a different user
  is refused even if its mode happens to be `600`.
- The file's trimmed content must be non-empty, and every character must be
  printable ASCII (`/[^\x21-\x7e]/` rejects it) — i.e. exactly one token, no
  trailing structure, no JSON wrapper, no second line.

**How to ask Nexus for it** (per BUTCHR-391 comment 23821, BUTCHR-395 comment 23824, and the
epic's `#ask-helpdesk` convention): request it there, as a **file path or
environment variable only** — never ask for the token value to be pasted
into this ticket, a PR, a comment, or chat. Nexus creates the provisioner
account and mints its token; you never see the raw value transit anything
this factory keeps a durable record of.

### 1.2 The provisioner's minimal permission list — owed to Nexus

The account manager's RC client (`createRocketChatClient`,
`src/resources/rocketchat.ts` lines 128-183) makes **exactly six** distinct
REST calls, and no others — this is the complete, closed set the
provisioner's role must cover:

| REST call | Client method | Why the module calls it |
|---|---|---|
| `GET /api/v1/users.info?username=` | `getUserByUsername` | Adoption, lost-record recovery, and the stale-record liveness check on token reuse (`docs/rocketchat-accounts.md` "Lost-record recovery" / "Stale-record recovery" / "Token rotation, corrected") |
| `GET /api/v1/users.list?count=1` | `countUsers` | The 50-user guardrail (Step 3) |
| `POST /api/v1/users.create` | `createUser` | Provisioning a new temporary or permanent account |
| `POST /api/v1/users.delete` | `deleteUser` | Unprovisioning a temporary account (`releaseAccount`) |
| `POST /api/v1/users.generatePersonalAccessToken` | `generateManagedToken` | Minting the one `"butchr-managed"` PAT (`RC_MANAGED_TOKEN_NAME`) per managed user |
| `POST /api/v1/users.removePersonalAccessToken` | `revokeManagedToken` | Revoking that PAT before deleting the user |

**This repo has no live Rocket.Chat instance to confirm RC's own internal
permission-name mapping for each endpoint against** — do not treat any
specific RC permission name below as verified; it is Nexus's own RC admin
panel that has the authoritative mapping for the version actually deployed.
What can be said with confidence, from the shape of the calls themselves: the
role needs create/delete-user rights, PAT-management rights scoped to *other*
users (every mint/revoke call passes `userId`, never operating on the
provisioner's own account), and read access to full user info and the total
user count. It needs **no** other capability — no channel/room administration,
no message-posting rights, no ability to manage roles/permissions itself, no
webhook/integration management beyond the one PAT type it already creates.
Ask Nexus to grant the narrowest built-in or custom role that covers exactly
this list, and verify afterward (Step 1.3) that it can do no more.

### 1.3 Verify the credential works and is exactly this narrow

Before creating anything, confirm the loaded credential:

```
$ curl -sS -H "X-Auth-Token: $(cat "$ROCKETCHAT_ADMIN_TOKEN_FILE")" \
       -H "X-User-Id: $ROCKETCHAT_ADMIN_USER_ID" \
       "$ROCKETCHAT_URL/api/v1/users.list?count=1"
```

**Expected**: `{"users":[...],"count":1,"offset":0,"total":<N>,"success":true}`.
**Fails as**: HTTP 401 (bad token/user id pair — recheck what Nexus handed
you), HTTP 403 or a body with `"success":false` and an RC error naming a
missing permission (the role is narrower than the six calls above — ask
Nexus to widen it, don't work around it), or a connection failure (wrong
`ROCKETCHAT_URL`, or you're not on a network path to production RC from
Codey).

Then confirm the role is **not** wider than intended: attempt an action the
account manager never performs, e.g. `GET /api/v1/channels.list` or
`POST /api/v1/im.create` with the same credential, and confirm RC refuses it
(`403`/`success:false`). This is not a functional requirement of the code —
it is a defense-in-depth check that Nexus's role grant matches what was
asked for, worth doing once before you rely on it repeatedly.

### 1.4 Configuration specific to THIS verification run

Two of the defaults above should be **overridden for the duration of this
gate only** (revert them afterward, or scope them to a config file used only
while this runbook is active) — this is not a general recommendation for
Butchr's steady-state RC configuration, which is a separate, still-open
conversation with Nexus (BUTCHR-391 comment 24003: "the actual convention is
a conversation with Nexus, not settled by this ticket"):

- **`ROCKETCHAT_MANAGED_PREFIX=butchr-test-`** — Nexus's terms (BUTCHR-391
  comment 23997/23999) require every test account's username to carry the
  exact prefix `butchr-test-`. `rcUsernameFor`/`isManagedUsername`
  (`src/accounts/identity.ts`) take this as a parameter with
  `RC_MANAGED_PREFIX` (`"butchr_"`) as their only hard-coded default —
  overriding `Config.rocketchat.managedPrefix` for this run makes every
  account this runbook creates carry Nexus's required prefix by construction,
  rather than relying on manual naming discipline. `rcUsernameFor`'s budget
  arithmetic (`RC_USERNAME_MAX - prefix.length - 1 - hash.length`, all in
  `src/accounts/identity.ts`) comfortably accommodates a 12-character prefix
  (`60 - 12 - 1 - 10 = 37` characters of budget for the sanitized agent key).
- **`ROCKETCHAT_TEMPORARY_CAP_THRESHOLD=5`** — Nexus's terms cap test
  accounts at 5 concurrent (BUTCHR-391 comment 23997). Setting the code's own
  temporary-account cap (`AccountManagerDeps.tempAccountCapThreshold`,
  default 8) to 5 for this run makes that limit enforced by `ensureAccount`
  itself (a `temporary-cap-reached` refusal, `docs/rocketchat-accounts.md`
  "The temporary-account cap") rather than only by operator discipline.
  `loadConfig` requires this to be a positive integer (`src/config/config.ts`
  line 424); leave `ROCKETCHAT_USER_CAP_THRESHOLD` at its default (45) or
  lower, never at/above 50.

Everything this runbook provisions is, by construction, a test account under
these two settings — there is no separate "test mode" flag; the prefix and
cap overrides ARE the test mode for this run.

## 2. Tell Nexus before any test account exists

BUTCHR-391 comment 23821 (director, corrected in BUTCHR-395 comment 23824): **Nexus is told
before any test account is created** — post in `#ask-helpdesk` that you are
about to run the S4 real-RC verification gate, naming the `butchr-test-`
prefix, the account count you expect to create (at most 5, per Step 4/7/8's
own count), and the approximate window. This is a distinct step from asking
for the provisioner credential (Step 1.1) — do both, in that order (get and
verify the credential first, since a heads-up with no ability to actually
proceed yet is not useful to Nexus), but do not create anything before
notifying.

### The DM/room terms, and where they leave an open question

Nexus's terms (BUTCHR-391 comment 23997) say **test accounts create no DMs or
rooms**, because deleting a user also deletes any room it solely owns. A
later correction (comment 24007, restated in comment 23999's own thread)
narrows this: **a DM *to* a `butchr-test-*` user is allowed** — "It is
deleted with the user, so capture all S5 evidence (screenshots or message
exports, and journal lines) before cleaning up test accounts." Reading both
together, the terms distinguish who *originates* the room:

- **Allowed, per Nexus's own correction**: a non-test account (a human, or
  the shared `rocketr` channel identity) opens a DM to a test account's RC
  user; the test account's own agent replies inside that already-existing
  room. The room was not created by the test account.
- **Not covered by either comment, and not to be guessed**: whether a test
  account's agent may be the one to *open* a new DM (e.g., to reply by
  starting a fresh conversation rather than replying in an existing thread),
  and whether a test account may be *added to* the shared `rocketr` channel
  (an existing room, not one it creates) to receive/post a channel message.

**Do not resolve this by assumption.** For every observable in Steps 7-8
that needs a DM or a channel post, design the check to stay within the
literal terms first (a non-test account or an existing shared channel
originates the message; the test account only replies within it), and for
any observable that cannot be built that way, list it explicitly as
**"requires explicit approval from Nexus before running"** with this exact
question: *"For the S4/S5 real-RC gate, may a `butchr-test-*` account be
added as a member of the existing shared `rocketr` channel (not create a new
one), and may it originate a reply that is technically a new DM room rather
than a reply inside an existing one? Both actions are outside what comments
23997/24007 explicitly covered."* Ask this in `#ask-helpdesk` before running
whichever of Steps 7-8 would otherwise depend on the answer, and record
Nexus's answer on this runbook's own evidence trail (Step 10) once given —
do not proceed on a guess.

## 3. Seat safety

Count current users **before creating anything**, using the same call the
guardrail itself uses:

```
$ curl -sS -H "X-Auth-Token: $(cat "$ROCKETCHAT_ADMIN_TOKEN_FILE")" \
       -H "X-User-Id: $ROCKETCHAT_ADMIN_USER_ID" \
       "$ROCKETCHAT_URL/api/v1/users.list?count=1" | jq .total
```

Record this number as **baseline** — Step 9's cleanup verification compares
the post-cleanup count against it.

**Two independent, separately-configured caps**, both in
`src/accounts/manager.ts`/`createAccountManager`, both checked ONLY on an
actual create (never on an adopt/reuse — `docs/rocketchat-accounts.md` "The
50-user guardrail" / "The temporary-account cap"):

1. **The RC-wide guardrail**, `userCapThreshold` (`ROCKETCHAT_USER_CAP_THRESHOLD`,
   default 45, must load as a positive integer below 50 or `loadConfig`
   throws at startup — `src/config/config.ts` line 418). Applies to every
   `ensureAccount` call, `temporary` or `permanent` alike.
2. **The temporary-account cap**, `tempAccountCapThreshold`
   (`ROCKETCHAT_TEMPORARY_CAP_THRESHOLD`, set to 5 for this run per Step 1.4).
   Applies ONLY to a `"temporary"`-policy create; a `permanent` account is
   never refused for this reason and never counted toward it
   (`docs/rocketchat-accounts.md` "The temporary-account cap").

Both are **check-and-reserve, not check-then-create**
(`docs/rocketchat-accounts.md` "Concurrency: both caps are check-and-reserve")
— concurrent creates cannot overshoot either cap even under load, per
BUTCHR-412's round-3 review fix (`reserveCapacitySlot`, `src/accounts/manager.ts`).

**How the refusal is visible, and what it means when it fires**: `ensureAccount`
returns `{ ok: false, reason: "cap-reached" | "temporary-cap-reached", message }`
— never a thrown error. `src/agents/account-lifecycle.ts`'s `ensure()`
withholds the spawn entirely (never starts the agent chat-less) and logs a
`WARNING: [account]` journal line always, plus a Jira comment for
jira-work/jira-idea agents (`docs/rocketchat-accounts.md` "Decision:
withheld, not degraded"). To see this fire on purpose (a deliberate test of
the guardrail, not an accident): temporarily set `ROCKETCHAT_TEMPORARY_CAP_THRESHOLD`
to a number at or below however many temporary test accounts you already
have provisioned, attempt to start one more, and confirm (a) the new agent
does not start, (b) the journal line appears, (c) nothing was created (the
seat count from the curl command above is unchanged). Revert the threshold
to 5 afterward.

**What would make this step FAIL to protect the seat budget**: a threshold
misconfigured above 50 (rejected at daemon startup, so this fails loud, not
silent); running two daemons against the same RC instance with independent,
uncoordinated caps (the reservation is in-process only — verify you are not
staging this gate from two daemons at once); or trusting a stale `total`
read across a long gap between counting and creating (the reservation
mechanism covers concurrent creates within one daemon, not a human reading
the count minutes before acting on it — re-read it close to when you act).

## 4. Temporary account lifecycle

**Mechanism that is wired and testable today** (BUTCHR-412, merged): a
`jira-work`/`github-issue`/`jira-idea`/`zendesk-ticket` rule (`src/rules/rules.ts`)
with `"account": "temporary"`, bound to a disposable, narrowly-scoped resource
your daemon already has a rule loop for (a scratch ticket/issue you control —
this runbook does not prescribe which provider, since it cannot see your
daemon's own `rules.json`; pick whichever is least disruptive to stage
against on Codey). Add `"mcpServers"` naming rocketr per Step 6's shape.

**Managed-session accounts are wired too** (BUTCHR-460, merged as `d7aa251`):
a managed-session definition (`docs/managed-sessions.md`) with `"account":
"temporary"|"permanent"` provisions a real account through the identical
`ensure`/`release` contract described below — `accountPolicyOf`
(`src/daemon/index.ts`) resolves each eligible definition's own `account`
field via the per-poll `managedSessionAccountPolicies` map, and
`accountLifecycle` is now ALWAYS constructed (the RC HTTP client itself still
stays `null`, and every `ensureAccount` call for a policy other than
`"none"` still visibly refuses with `"rc-not-configured"`, when
`ROCKETCHAT_*` is unconfigured — `docs/rocketchat-accounts.md`'s "Wiring"
section). **Use this route** — `butchr session create <name> --account
temporary|permanent ...` (`src/cli/session-cli.ts`) — for the real
Nexus/directors/MUD-player identities named in the S5 mapping (BUTCHR-391
comment 23527); the rule-based path above remains the one to use for any
provider a managed-session definition doesn't cover.

### Create on first start, once

Start the agent (`herd`'s ordinary reconcile spawn path picks up the new
rule). **Expected**: exactly one new RC user appears
(`GET /api/v1/users.info?username=<derived>` returns it — derive the expected
username yourself with `rcUsernameFor(agentKey, "butchr-test-")`'s algorithm:
sanitize the agent key to `[A-Za-z0-9._-]`, truncate to the budget computed in
Step 1.4, append `_` + the first 10 hex characters of `sha256(agentKey)`);
the daemon's own store file
(`<workspace root>/.butchr-rc-accounts.json`, or `$ROCKETCHAT_...` — no, this
one has no env override, it's `createFileAccountStore`'s hard-coded default
path, `src/accounts/manager.ts` line 424) gains one record; a 0600 file
appears at `$ROCKETCHAT_TOKEN_DIR/<username>.token`.

**No duplicate on repeated start/respawn**: stop and restart the same agent
(or trigger a respawn) several times in a row. **Expected**: the user count
from Step 3 increases by exactly 1 total across all of this, never more —
`ensureAccount`'s create-if-missing/adopt logic (`docs/rocketchat-accounts.md`
"Race-safety: two layers") means every subsequent call adopts the same RC
user rather than creating a second one. **Fails as**: a second RC user with a
different derived suffix would mean the agent key itself changed between
starts (a bug elsewhere, not in this module) — the account manager cannot
create two accounts for the identical agent key by design.

### Token file, 0600

```
$ stat -c '%a %U' "$ROCKETCHAT_TOKEN_DIR/<username>.token"
```

**Expected**: `600 <daemon-user>`. **Fails as**: any other mode is a defect
in `src/accounts/manager.ts`'s token-writing path (BUTCHR-412's own review
finding on this exact point) — do not proceed to hand this off to Nexus if
this check fails; file it, don't work around it.

### The Nexus hand-off manifest, published once per batch

```
$ cat "$ROCKETCHAT_NEXUS_MANIFEST_FILE"
```

**Expected**: `[{"account": "<username>", "tokenFile": "<path>"}, ...]`,
mode `600`, sorted by account name (`createFileNexusManifestPublisher`,
`src/accounts/nexus-manifest.ts`), **never a token value anywhere in this
file**. **The batching observable**: start several agents whose rules all
request an account within the same reconcile poll window (a handful of
seconds apart is enough — `reconcileNow`'s own poll cadence). **Expected**:
the manifest is written exactly once for that batch, not once per agent —
confirm by watching the file's mtime (`stat -c %Y`) or, more reliably, by
adding a temporary log line count if your daemon build logs `publishBatch`
calls (`src/agents/account-lifecycle.ts`'s own "batch provisioning" test
coverage names the exact assertion: N ensures within one poll → exactly one
`publish()` call).

### Respawn / daemon restart does not rotate a still-valid token or unprovision

Restart the whole daemon process (a real Codey deploy/restart, not a rule
edit). **Expected**: the account's token file content is **byte-identical**
before and after (`diff` the file, or its sha256, across the restart) — a
still-valid recorded token is reused untouched, no revoke/regenerate RC call
at all (`EnsureAccountResult.rotated: false`,
`docs/rocketchat-accounts.md` "Token rotation, corrected"). **Fails as**: a
changed token content means either the file was missing/invalid (check your
own restart procedure didn't clear `$ROCKETCHAT_TOKEN_DIR`) or a regression
in the reuse-not-rotate contract — file it, this is exactly the failure mode
BUTCHR-412 was built to prevent (it would silently break Nexus's already-
registered rocketr connection).

### Unprovision on every stop path

Stop the agent (disable its rule, or let a singleton/query rule's match count
drop to zero, or use `stand_down`). **Expected**: the RC user is deleted
(`GET /api/v1/users.info?username=<derived>` now 404s / returns RC's "user
not found"), the token file is removed, the store record is cleared, and the
NEXT manifest publish no longer lists this account. **Rollback if this
fails**: `docs/rocketchat-accounts.md`'s "A failed `release` is retried, not
lost" — a thrown release is queued in-memory and retried every poll
(`retryPendingReleases`); if the daemon restarts before that retry lands, the
periodic orphan sweep (Step 9) is the slow backstop. Confirm which one
actually cleaned it up rather than assuming either did.

### Archive: released with reason `"archive"`, not just `"stop"` (BUTCHR-460, merged `d7aa251`)

Archiving a managed-session definition (`butchr session archive <name>`, or
hand-moving its file into the archive directory) moves the file out of the
active definitions directory; the daemon's own next poll (within
`MANAGED_SESSIONS_POLL_MS` = 15s, `docs/managed-sessions.md`'s
"Archive/unarchive" section) no longer lists it, so it drops out of
`desired` and is released through the SAME shared `AccountLifecycleHooks`
every other provider uses. `src/agents/managed-session-account-release.ts`'s
`wireManagedSessionArchiveRelease` upgrades that release's reason from the
generic `"stop"` to `releaseAccount`'s own named entry point, `"archive"`
(`ReleaseReason`, `docs/rocketchat-accounts.md`'s "The four policies"), the
moment it can positively confirm a file of the definition's exact original
basename now exists in the archive directory (`sessionArchiveDir`,
`src/resources/session-archive.ts`) — this also catches an archive done by
hand-moving the file, not only one done through the CLI. `stop` and
`archive` behave IDENTICALLY in `releaseAccount` itself (both unprovision a
`temporary` account, retain a `permanent` one) — the distinction is purely
for the audit trail.

**Observable**: archive a `temporary`-account definition; within one poll,
confirm (a) the daemon journal's `[account] ... released (archive)` line
(not `(stop)`), and (b) the same RC-user-deleted / token-file-gone /
manifest-entry-removed result Step 4's "Unprovision on every stop path"
already checks — same commands, same expected result, only the audit-line
reason differs. Archive a `permanent`-account definition: confirm the
account is retained (same check as Step 5). `unarchive <name>` moves the
file back under its exact original basename; confirm the SAME agent (the
same derived RC username — identity is keyed off the file path,
`docs/managed-sessions.md`'s "The identity rule, and why it's load-bearing")
is recreated on the next poll, never a second, duplicate one. Repeat
archive → unarchive → archive once more; confirm no double-release and no
leaked account on any cycle.

**A named, non-blocking limitation** (`docs/rocketchat-accounts.md`'s
"Archive release (BUTCHR-460)" section): the archive-vs-stop check has no
memory of WHICH move put a file at the archive path — only that one is
there right now. A stale copy left in the archive directory some other way
(an operator's own copy, a leftover from an interrupted move) can make a
LATER, genuinely-ordinary stop of the same basename (deleted/invalidated/
frozen, not archived) mis-log as `"archive"`. This never changes WHETHER a
`temporary` account is released — only the audit line's accuracy in that
narrow case — worth noting in your evidence if you see it, not a reason to
distrust the release itself.

**Fails as**: the RC user surviving past one poll after archive means either
the definition didn't actually leave the active directory's listing (check
`sessionArchiveDir`/`assertArchiveDirDisjoint` didn't refuse, and that the
basename matches exactly) or a genuine regression in the release wiring —
file it, don't work around it.

## 5. Permanent account lifecycle

Same rule/definition shape as Step 4, `"account": "permanent"`. **Expected**:
create-if-missing on first start (identical create path); on every
subsequent restart, stop, or archive-equivalent, `releaseAccount` is called
but is **always** a no-op that says so (`{ ok: true, released: false, note }`,
`docs/rocketchat-accounts.md` "The four policies" — `permanent`'s
`releaseAccount` column reads "always a no-op that says so, for every
reason including stop/archive"). Confirm by stopping and restarting a
`permanent`-policy agent and checking that its RC user, token file, and
manifest entry are all still present and **unchanged** across the cycle —
same byte-identical-token-file check as Step 4's respawn case, since a
permanent account's "adopt on every start" path reuses the same still-valid
token check:

```
$ curl -sS -H "X-Auth-Token: $(cat "$ROCKETCHAT_ADMIN_TOKEN_FILE")" \
       -H "X-User-Id: $ROCKETCHAT_ADMIN_USER_ID" \
       "$ROCKETCHAT_URL/api/v1/users.info?username=<derived-permanent-username>" | jq .user.active
$ sha256sum "$ROCKETCHAT_TOKEN_DIR/<derived-permanent-username>.token"   # before
# ... stop, restart the agent ...
$ curl -sS -H "X-Auth-Token: $(cat "$ROCKETCHAT_ADMIN_TOKEN_FILE")" \
       -H "X-User-Id: $ROCKETCHAT_ADMIN_USER_ID" \
       "$ROCKETCHAT_URL/api/v1/users.info?username=<derived-permanent-username>" | jq .user.active
$ sha256sum "$ROCKETCHAT_TOKEN_DIR/<derived-permanent-username>.token"   # after — must match the "before" hash
```

**Fails as**: the RC user disappearing on any stop/archive
reason is a policy-matrix regression — `permanent` must never be deleted by
butchr, ever, under any `ReleaseReason`.

## 6. Registration hand-off with Nexus

After Step 4/5 populate the manifest, hand it to Nexus per the process named
in BUTCHR-391 comment 24007: **Nexus reads the manifest and registers each
account with rocketr**; butchr never talks to rocketr directly. Concretely:
notify Nexus (in the same `#ask-helpdesk` thread as Step 2) that the manifest
at `$ROCKETCHAT_NEXUS_MANIFEST_FILE` has entries ready, and wait for
confirmation the registration happened before proceeding to Step 7 — a
rocketr connection with an unregistered account name will simply not
identify correctly, which is not a code defect to chase, it's an expected
consequence of not yet completing this hand-off.

### The `x-rocketr-account` binding

Add rocketr as a bound MCP server on the SAME rule/definition, so the agent
can both use rocketr as a tool AND (for Claude) receive its channel pushes:

```jsonc
{
  "mcpServers": [
    {
      "name": "rocketr",
      "type": "http",
      "url": "<rocketr's real MCP endpoint — get this from Nexus/rocketr's own operator, not this runbook>",
      "accountHeader": "x-rocketr-account",
      "channel": true
    }
  ]
}
```

`accountHeader`'s value is filled in automatically, per-agent, from
`SpawnSpec.rocketchatAccount` — **never write a literal account name into
this config yourself**; it is resolved at launch time
(`resolveAccountHeader`, `src/agents/workspace.ts`) from whatever
`ensureAccount` actually provisioned for that specific agent
(`docs/rocketchat-accounts.md` "Credential design, corrected"). The header
name `x-rocketr-account` is this codebase's own choice — confirm it against
whatever Nexus/rocketr's own operator says the real bridge actually expects;
`docs/codex-channel-relay.md`'s own "What this ticket did NOT verify" section
names this exact assumption as unconfirmed against a real rocketr.

### Checks that no token value is ever agent-readable

```
$ ps -eo pid,args | grep -i rocket           # expect: no bearer/token string, account name only (Codex bound-server config)
$ cat <agent-workspace>/mcp.json | jq .      # expect: headers carry x-rocketr-account : "<username>", no Authorization/token value
$ stat -c %a <agent-workspace>/mcp.json      # expect: 0600 ONLY if this binding ALSO resolves a headersEnvVar secret (accountHeader alone never tightens permissions — docs/mcp-server-bindings.md)
$ grep -ri "token" <daemon-journal-for-this-window>   # expect: no match carrying an actual token value; "tokenFile" path mentions are fine
```

**Fails as**: any bearer/PAT value appearing in `ps`, `mcp.json`'s literal
content beyond the account name, or a journal line — this is exactly the
class of defect BUTCHR-412's corrected credential design exists to make
structurally impossible (`docs/rocketchat-accounts.md` "Token minting and the
Nexus hand-off" — "Test coverage's own falsifier: no token value ever
appears in a log line, argv, the manifest file, a ticket comment, or any
agent-readable file"). If you find one, stop and treat it as a real security
incident, not a runbook footnote.

## 7. Claude and Codex agents each receiving a message and answering it

Subject to Step 2's DM/room constraint — design each check to stay within
the literal terms (a non-test identity or the existing shared channel
originates the message) unless Nexus has explicitly answered the open
question in Step 2.

### Claude

Nothing in this repo needs to run for Claude beyond the binding in Step 6 —
`docs/codex-channel-relay.md`'s "The gap this closes": Claude's own CLI,
launched with `--dangerously-load-development-channels=server:rocketr`
(from `channel: true` on the binding, `agentLaunchConfig`/`src/agents/argv.ts`),
opens the notification stream directly. **Observable**: send a message
through rocketr addressed to this agent's own account (a channel post to the
shared channel, or — if Nexus has approved it per Step 2 — a DM); the agent's
session transcript shows a `<channel source="rocketr" ...>` frame arriving
unprompted, and a reply is posted back through rocketr's own MCP tool. **This
repo's own precedent for what this evidence looks like**: `docs/mcp-server-bindings.md`'s
"Evidence of event-driven delivery" section already describes this exact
frame shape arriving for `server:butchr` in production, twice, during
BUTCHR-411's own work — the same mechanism, a different server name.

### Codex

Woken by `src/notify/codex-channel-relay.ts` — the daemon's own held-open
connection to rocketr turns a push into exactly one `herd.nudge(issue, text)`
call, never a poll (`docs/codex-channel-relay.md`, "Design decision 2").
**Observable, per BUTCHR-413's own PR #392 "Real-RC gate" list** (verify this
list is still current against the merged code before treating it as
gospel — it is a design document's own prediction, not yet exercised against
a real rocketr):

- A message posted to the shared `rocketr` channel appears, within seconds
  and with **no** polling delay, as a turn in each bound Codex agent's
  session — daemon logs read `[notify] codex channel relay: <issue> ← <binding>: ...`
  (never a "Claude channel" label — that label would mean this ran for a
  Claude agent by mistake).
- If Step 2's DM question is answered favorably: a DM to a Codex agent's own
  RC account reaches that one agent only, not every agent bound to the same
  `rocketr` binding — this depends on `rocketr` actually routing by the
  `x-rocketr-account` identity, unconfirmed until this exact check runs.
- The Codex agent replies through rocketr's own MCP tool, identified by its
  own `x-rocketr-account` header — confirm `rocketr` accepts that as
  sufficient identification (this is the one thing no test in this repo
  could ever confirm, since `rocketr` doesn't exist in the test
  environment).
- Sending the identical message twice (a client retry) produces exactly one
  prompt/turn, not two (`dedupKeyOf`'s 5-minute window,
  `docs/codex-channel-relay.md` "Design decision 3" — note the documented gap:
  this only catches an exact repeat, or one carrying a stable message id from
  rocketr; an edited-and-resent message with no id is NOT deduplicated,
  by design).
- A busy Codex agent that receives a push is not double-prompted; its queued
  turn starts once it goes idle (`herd.nudge`'s own pre-existing contract,
  not new here — reused, not reimplemented, per `docs/codex-channel-relay.md`).

**What would make this step FAIL**: no turn appears at all (check the daemon
actually holds the rocketr connection open — `keepChannelSource`'s
reconnect/backoff state, and that the rule's binding really has `channel: true`
and Codex is the observed provider, `Herd.providerOf`); a turn appears with
the wrong content (dedup or account-identity mismatch — compare the
delivered account name against `rcUsernameFor` computed for that exact
agent key); or a DM reaching every bound agent instead of one (an
`x-rocketr-account` mismatch, or `rocketr` not routing by that header the
way this design assumes — this is the "real `rocketr`'s own behavior" gap
named as unconfirmed throughout `docs/codex-channel-relay.md`).

## 8. Claude bound to a non-Rocket.Chat MCP channel server, no RC account, no polling

This is a **separate** observable from Steps 6-7 — it needs no Rocket.Chat
account at all (`"account": "none"`), and it closes a gap Steps 11 named
explicitly as unclosed by any prior task: BUTCHR-411's own PR #387 could not
conclusively verify a live, no-further-input wake from outside the daemon
(`docs/mcp-server-bindings.md` "Evidence of event-driven delivery: what was
verified, and what wasn't" — the `--bg` vs. real herdr-PTY-pane residency
gap), because BUTCHR-368 forbids touching the live daemon from that ticket's
own environment. **You, running this in real Codey staging with real daemon
access, do not have that restriction** — this is exactly where that gate is
meant to close.

### Config

```jsonc
{
  "id": "<a narrow, disposable rule/definition — never a production-critical one for this test>",
  "account": "none",
  "mcpServers": [
    { "name": "<a non-RC channel server you actually have available — e.g. mud-mcp, or an equivalent staged for this purpose>",
      "type": "http",
      "url": "<its real endpoint>",
      "channel": true
    }
  ]
}
```

Verify against your OWN daemon's rules/definitions which non-RC channel
server is actually available to bind — this runbook cannot name one for you
without asserting a fact about your environment it has no way to confirm
(the mud-mcp bridge is the concrete example this codebase's docs use, per
`docs/mcp-server-bindings.md`'s worked example, but whether it — or an
equivalent — is reachable from Codey is yours to check, not this runbook's
to assume).

### What to capture as evidence

Precisely because the prior gap was "could not conclusively verify... with
no further input from outside the daemon," the evidence here must rule that
out explicitly:

1. **No RC account exists for this agent** — confirm no matching username
   under any prefix appears via `users.info`/the account store; this agent's
   rule specifies `"account": "none"` and never touched `ensureAccount`
   (`docs/execution-modes.md`: "`account` is not a prerequisite for
   event-driven delivery" — verify the log/store shows nothing for this
   agent key).
2. **A real, herdr-managed PTY pane** (`claude agents --json` should show
   this agent's `"kind": "interactive"`, not `"background"` — the exact
   distinction BUTCHR-411's own unresolved gap turned on).
3. Send one event through the bound channel server. **Timestamp it.**
4. Observe the daemon's own connection accept/relay it (a log line naming
   the binding and the event, with **no** gap where a poll would have had to
   run for the agent to notice — confirm by inspecting the bound-server
   client code path itself for the absence of any polling loop, not just by
   the timing looking fast: `mud_status`/`mud_read`-style polling tools, if
   your channel server exposes any, must never be the thing that surfaced
   this event).
5. Observe the agent's own session transcript show a new turn starting from
   the pushed content, with **zero** additional input from you or anything
   outside the daemon between steps 3 and 5 — no manual nudge, no second
   message, no daemon restart in between.
6. Record the elapsed time between the timestamp in (3) and the turn's start
   in (5) — a large or unbounded gap is itself evidence against "no
   polling," even if a turn eventually appears.

**What would make this step FAIL**: a turn that only appears after some
other trigger (a restart, a manual nudge, a second message) — that is
exactly the ambiguity this step exists to remove, and should be reported as
NOT closing the gap, rather than papered over. A turn that never appears at
all despite the connection showing the push delivered at the transport layer
points at the same herdr-PTY-residency question BUTCHR-411 left open — worth
its own follow-up ticket if it recurs here, not a silent retry loop.

## 9. Cleanup

For every account this runbook created (Steps 4, 5's test instances if any
were made non-permanently for this gate, 7, 8):

1. Stop the agent (the same mechanism Step 4 verified releases a temporary
   account). Wait for the release to actually land — check:
   ```
   $ curl -sS -H "X-Auth-Token: $(cat "$ROCKETCHAT_ADMIN_TOKEN_FILE")" \
          -H "X-User-Id: $ROCKETCHAT_ADMIN_USER_ID" \
          "$ROCKETCHAT_URL/api/v1/users.info?username=<derived>"
   ```
   **Expected**: `{"success":false,"error":"User not found."}` (or
   equivalent RC "not found" body) — not just that the stop command
   returned.
2. If any release failed and was queued (Step 4's retry path), wait for the
   next poll and re-check, or force it by restarting the daemon (the orphan
   sweep, below, is the backstop if this still doesn't clear it).
3. Confirm the token file at `$ROCKETCHAT_TOKEN_DIR/<username>.token` is
   gone: `test -e "$ROCKETCHAT_TOKEN_DIR/<username>.token" && echo STILL THERE || echo gone`.
4. Confirm the account no longer appears in
   `$ROCKETCHAT_NEXUS_MANIFEST_FILE` after the next batch publish:
   `jq '.[] | select(.account == "<username>")' "$ROCKETCHAT_NEXUS_MANIFEST_FILE"`
   should print nothing.
5. Re-run Step 3's count command; **the total must equal the Step 3
   baseline**, exactly:
   ```
   $ curl -sS -H "X-Auth-Token: $(cat "$ROCKETCHAT_ADMIN_TOKEN_FILE")" \
          -H "X-User-Id: $ROCKETCHAT_ADMIN_USER_ID" \
          "$ROCKETCHAT_URL/api/v1/users.list?count=1" | jq .total
   ```
   A mismatch means an account this runbook created (or
   one it didn't — see the orphan sweep below) was not actually cleaned up;
   do not close this gate until it matches.
6. **Tell Nexus to unregister the cleaned-up accounts from rocketr** —
   `docs/rocketchat-accounts.md`'s own named, accepted gap: "nothing tells
   Nexus WHY an entry vanished... and nothing confirms Nexus actually
   unregistered it from rocketr in response" ("Residual gaps in
   reuse-not-rotate"). Butchr does not, and structurally cannot, signal this
   on its own — it is a manual `#ask-helpdesk` step, every time.

### If cleanup fails partway

Two mechanisms exist, covering different failure windows, and **neither
covers everything**:

- **The retry queue** (`docs/rocketchat-accounts.md` "A failed `release` is
  retried, not lost"): a `releaseAccount` call that throws after `herd.stop`
  already succeeded is queued in-memory and retried every poll
  (`retryPendingReleases`, seconds to a minute). Covers a transient RC
  failure while the daemon keeps running. **Does not cover**: the queue is
  in-memory — a daemon restart before the retry lands drops it (the store's
  own record survives, though — nothing is silently forgotten permanently).
- **The periodic orphan sweep** (`src/agents/account-orphan-sweep.ts`; once
  at startup, then every 30 minutes) is the slow, crash-safe backstop for
  exactly that gap, and for a daemon restart in general (which has no stop
  handler at all — `docs/rocketchat-accounts.md` "Daemon shutdown"). It only
  releases an account after (a) a real per-pane liveness check
  (`residentIssues()`, immune to the ambiguous-pane false positive a raw
  snapshot has) says the agent is gone, (b) the record is at least 10 minutes
  old, and (c) it reads as gone on two consecutive sweeps 30 minutes apart —
  i.e., **up to roughly an hour** in the worst case before an orphaned
  temporary account is swept. **Does not cover**: `permanent` accounts
  (never released by design, so an accidentally-`permanent` test account is
  NOT this sweep's job — you must clean those up manually), and it releases
  nothing on an unreliable read (a failing `residentIssues()`/
  `reconcileOrphans()` call leaves every streak untouched rather than
  guessing).

**Never leave orphan seats.** If, after the sweep's worst-case window, an
account created by this runbook still exists, delete it manually via the
same REST calls the client uses (`users.removePersonalAccessToken` then
`users.delete`, mirroring `releaseAccount`'s own order) using the
provisioner credential, and clear its store/manifest entries by hand — but
only after confirming the daemon's own mechanisms have genuinely stopped
trying (check the daemon's journal for repeated release-retry log lines
before concluding it's stuck).

## 10. Evidence

**Destination**: per BUTCHR-391's own comment history (23593/23596: fleet
cutover oversight and its evidence moved to admin-assembly; 23821, and
BUTCHR-395 comment 23824: "Creation and cleanup are both recorded in the S5
evidence" — S5 is BUTCHR-396), post evidence against **BUTCHR-396's evidence
list**, and check
BUTCHR-396's own current comments for whether admin-assembly wants a copy
posted anywhere else by the time you run this — the ownership changed once
already (23585 → 23593) and may have moved again since this runbook was
written; verify the current destination on BUTCHR-396 itself rather than
trusting this line as still current.

**What to capture, for both creation and cleanup, no secret values ever
included**:

- Step 3's before/after user counts (baseline and post-cleanup).
- Step 1.3's credential-scope check result.
- Nexus's `#ask-helpdesk` heads-up timestamp/link (Step 2), and their answer
  to the DM/room open question if you had to ask it.
- Per created account: derived username, `created`/`rotated` outcome from
  the `ensureAccount` result, token-file mode/ownership (never content),
  manifest-publish timestamp.
- Step 6's `ps`/`mcp.json`/journal greps showing no token value anywhere
  agent-readable.
- Step 7's Claude and Codex transcripts/log lines showing each message
  received and answered, with timestamps establishing "no polling delay."
- Step 8's full timestamp sequence (push sent → daemon observed → turn
  started), and the `claude agents --json` `"kind"` field for that agent.
- Step 9's per-account release confirmation and final count-matches-baseline
  check.
- Nexus's confirmation that rocketr registration (Step 6) and
  unregistration (Step 9) both actually happened.

**Screenshots/message exports of any DM must be captured before Step 9's
cleanup runs** — Nexus's own term (BUTCHR-391 comment 24007): a DM to a
`butchr-test-*` account is deleted along with the account, irrecoverably.

## Mapping table: merged task's "Real-RC gate" observable → runbook step

| Source | Observable | Runbook step |
|---|---|---|
| BUTCHR-412 (PR #390) | Token file mode 0600, content matches the manifest's `tokenFile` path | 4 |
| BUTCHR-412 (PR #390) | Manifest file mode 0600, never contains a token value | 4, 6 |
| BUTCHR-412 (PR #390) | rocketr can relay a message using an account registered purely from the manifest | 6, 7 |
| BUTCHR-412 (PR #390) | A respawn/restart does not break registration (reused-token path never rotates) | 4 |
| BUTCHR-413 (PR #392) | RC message to shared channel reaches each bound Claude/Codex agent within seconds, no polling | 7 |
| BUTCHR-413 (PR #392) | RC DM to a Codex agent's account reaches only that agent | 7 (subject to Step 2's open question) |
| BUTCHR-413 (PR #392) | A Codex agent can call rocketr's own tools to reply, identified by `x-rocketr-account` | 6, 7 |
| BUTCHR-413 (PR #392) | Identical message sent twice → exactly one prompt/turn | 7 |
| BUTCHR-413 (PR #392) | A busy Codex agent is not double-prompted; queued turn starts once idle | 7 |
| BUTCHR-413 (PR #392) | Daemon logs read `[notify] codex channel relay: ...`, never mislabeled "Claude channel" | 7 |
| BUTCHR-413 (PR #392) | No RC credential in `ps`/argv/journal/`mcp.json` permissions | 6 |
| BUTCHR-411 (PR #387) | A live, no-further-input wake for a Claude agent bound to a channel server, from outside the daemon, without touching it — NOT closed by #387 itself | 8 |
| BUTCHR-391 comments 23997/23999/24007 | Test-account terms: prefix, cap, no DM/room origination by test accounts, DM reception allowed | 1.4, 2, 4 |
| BUTCHR-391 comment 23821, BUTCHR-395 comment 23824 | Nexus told before creation; headroom checked; explicit cleanup with verification; creation+cleanup recorded as evidence | 2, 3, 9, 10 |
| BUTCHR-460 (PR #428, merged as `d7aa251`) | Archive triggers temporary-account release (reason `"archive"`, not just `"stop"`) | 4 |

## Open questions (do not guess — ask, then record the answer here before relying on it)

1. **The DM/room tension** (Step 2): may a `butchr-test-*` account be added
   to the existing shared `rocketr` channel, and may it originate what is
   technically a new DM room rather than replying inside an existing one?
   Ask in `#ask-helpdesk`, exact question given in Step 2.
2. **The provisioner's exact RC permission names** (Step 1.2): this repo can
   name the six REST calls needing coverage but not RC's own internal
   permission-name mapping for the version Nexus runs — confirm with Nexus
   directly against Nexus's own admin panel.
3. **The steady-state managed-username prefix convention** — out of scope
   for this gate (Step 1.4 only overrides it for this run), but still an
   open conversation with Nexus per BUTCHR-391 comment 24003; do not confuse
   this run's `butchr-test-` override with a settled production answer.
