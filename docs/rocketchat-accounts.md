# Rocket.Chat account lifecycle (BUTCHR-395/S4)

BUTCHR-410, story BUTCHR-395, epic BUTCHR-391. This ships the Rocket.Chat
(RC) REST client and an idempotent account manager as a **standalone,
well-tested module** — `src/resources/rocketchat.ts` (the client + admin
auth loading) and `src/accounts/manager.ts` + `src/accounts/identity.ts`
(the policy/persistence layer). **Nothing here is wired into the herd,
the reconciler, or agent start/stop** — a follow-up task does that. This
doc describes the contract that follow-up task builds on.

`Rule.account` (`"none" | "temporary" | "permanent"`, `src/rules/rules.ts`,
landed pure-plumbing by BUTCHR-392/BUTCHR-397 — see `docs/execution-modes.md`)
is validated and stored today but read by nothing; this task is what makes it
mean something, once wired in.

## Why delete, not deactivate

`releaseAccount` on a `temporary` account calls RC's user-DELETE endpoint,
not deactivation. Rocket.Chat's own 50-user allowance (the guardrail this
task implements) is a seat count, and the whole point of a `temporary`
account is that it has a bounded footprint under load — an agent that starts
and stops repeatedly must give its seat back, not accumulate deactivated
corpses that still occupy one. Deactivating would defeat that: the seat
count never goes down, so a fleet of short-lived temporary agents would walk
the guardrail up to its cap and then start refusing new ones for a workload
that, at any given moment, needs far fewer than 50 concurrent accounts.
`permanent` accounts are simply never released (see "The four policies"
below), so this tradeoff never applies to them.

The cost: account persistence does not guarantee conversation history for a
`temporary` account (deleting the RC user deletes it along with everything
else RC associates with that identity) — this is a real limitation, stated
here rather than promised away, exactly as the ticket asks. `permanent`
accounts, never deleted, do not have this problem.

## Identity mapping (`src/accounts/identity.ts`)

`rcUsernameFor(agentKey)` derives a Rocket.Chat username from an agent key
(`<provider>:<ruleId>:<resourceId>`, including the query-level
`<provider>:<ruleId>:%40query` form — see `src/rules/agent-key.ts`):

```
butchr_<sanitized-and-truncated-agent-key>_<sha256-prefix>
```

- **Deterministic**: the same agent key always produces the same username,
  across restarts, without needing the persistence record (see "Persistence"
  below for exactly when this matters).
- **RC-safe charset**: only `[A-Za-z0-9._-]` — anything else (the agent
  key's own `:` separators, and `%` from a percent-escaped resource id)
  collapses to `-`.
- **Length-bounded**: capped at `RC_USERNAME_MAX` (60) — a conservative,
  self-imposed bound, not a claimed Rocket.Chat limit; this codebase has no
  authoritative RC version to cite one against.
- **Collision-proof, unconditionally** — not merely "when truncating": the
  10-hex-char `sha256` prefix of the *whole* agent key is always appended,
  because sanitization is lossy even for a short key. `jira-work:foo-bar:x`
  and `jira-work:foo:bar-x` sanitize to the identical string once `:` and
  the hyphen are indistinguishable; only the hash tells them apart. The
  ticket's own ask ("hash suffix when truncating") covers the truncated
  case; this closes the untruncated one too, since it's just as real.
- **Reversible enough to recognise a managed account**: `RC_MANAGED_PREFIX`
  (`butchr_`) is a fixed prefix, checked with `isManagedUsername`. This is
  the ONLY signal `manager.ts` ever consults before a destructive call
  (delete, token revoke) — see "The managed-marker guard" below.
- **Configurable, BUTCHR-412 (BUTCHR-391 comment 24003 item "naming
  convention")**: both `rcUsernameFor` and `isManagedUsername` take an
  optional `prefix` param, defaulting to `RC_MANAGED_PREFIX`. A daemon
  overrides it via `Config.rocketchat.managedPrefix`
  (`ROCKETCHAT_MANAGED_PREFIX`), threaded into `AccountManagerDeps.managedPrefix`.
  The derivation itself (hash, truncation, charset) is unchanged either way —
  only the fixed prefix string moves. **The actual convention is a
  conversation with Nexus, not settled by this ticket** — BUTCHR-391's own
  text says so explicitly, and this task does not block on it; it ships the
  knob so that conversation has something to land on.

**Why a username prefix, not a custom field.** RC supports per-user custom
fields, which would also work as a marker — but a custom field must already
be *defined* in RC's own admin settings before it can be set on a user, an
out-of-band dependency this module has no way to verify or provision, and a
missing definition fails in ways that are easy to get wrong silently. A
username prefix needs nothing on the RC side at all: it's checkable with a
string comparison, by this module, with the same client used for everything
else. That self-containedness is why it won this decision.

## The four policies

| `account` | on `ensureAccount` | on `releaseAccount(reason)` |
|---|---|---|
| `none` | no-op, `{ ok: true, policy: "none" }` — never touches the store or the client | no-op (nothing was ever created, so there is nothing to release; the store lookup finds no record and says so) |
| `temporary` | create-if-missing (subject to BOTH the 50-user guardrail AND, on an actual create, the temporary-account cap — see below); a still-valid token is reused, never rotated | `stop`/`archive`: unprovision (delete user + revoke its managed token + remove its local token file). `respawn`/`daemon-restart`: no-op — same agent identity coming back, not it stopping |
| `permanent` | create-if-missing, or adopt if it already exists (never subject to the temporary-account cap); a still-valid token is reused, never rotated | always a no-op that says so, for every reason including `stop`/`archive` |

`releaseAccount(agentKey, "archive")` is BUTCHR-394's (S3 archive) entry
point into this module — its name and this shape (`ReleaseReason` including
`"archive"`) are stable for that ticket to call.

## `ensureAccount` / `releaseAccount` contract

```ts
ensureAccount(agentKey: string, policy: AccountPolicy): Promise<EnsureAccountResult>
```

`EnsureAccountResult` is one of:

- `{ ok: true, policy: "none" }`
- `{ ok: true, policy: "temporary" | "permanent", rcUserId, username, tokenFile, created, rotated }` —
  **BUTCHR-412 corrected credential design: `tokenFile` is a PATH to a 0600
  file this call wrote the managed token into, never the token value
  itself** (see "Token minting and the Nexus hand-off" below; the original
  `token: string` field is gone). `created` is `true` only when this call
  actually created the RC user (`false` for every adoption, including a
  lost-record recovery). `rotated` is `true` only when this call actually
  minted a fresh token (a brand-new user, or an existing one whose recorded
  token file was missing/invalid) — `false` means an existing, still-valid
  token file was reused untouched, no RC token API call at all (see "Token
  rotation, corrected" below).
- `{ ok: false, reason: "rc-not-configured" | "cap-reached" | "temporary-cap-reached" | "not-managed", message }` —
  a REFUSAL, never a thrown error, for every condition a caller must handle
  without a crash: no RC config, the 50-user guardrail, the SEPARATE
  temporary-account cap (BUTCHR-412 item 5, below — never returned for
  `permanent`), or (defensively — should never actually happen, since the
  username is always self-derived) a username collision with something not
  carrying butchr's own marker.

```ts
releaseAccount(agentKey: string, reason: ReleaseReason): Promise<ReleaseAccountResult>
```

`ReleaseAccountResult` is one of:

- `{ ok: true, released: true }` — a `temporary` account was actually
  unprovisioned.
- `{ ok: true, released: false, note }` — a no-op, with the reason stated
  (no record, a retaining policy, or a non-unprovisioning reason).
- `{ ok: false, reason: "rc-not-configured" | "not-managed", message }`.

```ts
reconcileOrphans(agentExists: (agentKey: string) => boolean | Promise<boolean>): Promise<AccountRecord[]>
```

Lists every managed account this daemon's store knows about whose
`agentExists` reads false — a pure, read-only listing. It does not delete
anything: acting on the list (the actual sweep) is `src/agents/account-orphan-sweep.ts`'s.

```ts
manifestEntries(): Promise<NexusManifestEntry[]>
```

BUTCHR-412: every currently-recorded managed account with a token file on
record, as `{ account: <username>, tokenFile: <path> }` pairs — never a
token value. `src/agents/account-lifecycle.ts`'s `publishBatch` batches this
into one `NexusManifestPublisher.publish()` call per reconcile poll — see
"Token minting and the Nexus hand-off" below.

## Race-safety: two layers

"Repeated startup must never create duplicate accounts" is met two ways:

1. **In-process**: `createAccountManager` closes over a per-agent-key lock
   (a promise chain) — two concurrent `ensureAccount("X", …)` calls in the
   SAME process run one after the other, never interleaved, so the second
   always sees the first's result before deciding whether to create.
2. **Cross-process backstop**: if two DIFFERENT processes (or daemons) race
   anyway, Rocket.Chat's own username-uniqueness constraint is the real
   guard — `createUser` for an already-taken username fails, and
   `ensureAccount` catches exactly that failure and falls back to
   `getUserByUsername` to adopt whichever process won, rather than
   surfacing the race as an error or attempting to create a second time.

## The 50-user guardrail

Before ANY new RC user is created (never on an adoption or a lost-record
recovery — those create nothing), `ensureAccount` calls `countUsers()` and
refuses with `{ ok: false, reason: "cap-reached", message }` at or over
`userCapThreshold` — configurable via `ROCKETCHAT_USER_CAP_THRESHOLD`,
defaulting to **45**. The default sits below the real 50-user allowance
deliberately (see `src/config/config.ts`'s own comment): a threshold at or
above 50 would let the very last create that trips it succeed, which is the
opposite of "refuse BEFORE the cap is hit". 45 leaves 5 seats of headroom for
human operators and any surviving legacy Bakr/Candlestix accounts this
module never touches (see "The managed-marker guard"). `loadConfig` rejects
a configured threshold that is not a positive integer below 50.

## The temporary-account cap (BUTCHR-412, BUTCHR-391 comment 23999)

A SEPARATE, tighter cap from the 50-user guardrail above: about 10 of RC's
50 seats are free, shared between auto-provisioned `temporary` accounts and
S5's own `butchr-test-*` cap (5, Nexus's own limit, not enforced by this
module). `AccountManagerDeps.tempAccountCapThreshold` — configurable via
`ROCKETCHAT_TEMPORARY_CAP_THRESHOLD`, defaulting to **8** — bounds how many
`temporary` `AccountRecord`s may exist AT ONCE. Checked ONLY on the same
"about to create a new RC user" path the 50-user guardrail checks (never on
an adopt/reuse for an agent that already has a record), and ONLY for
`policy === "temporary"`:

- Reached: `{ ok: false, reason: "temporary-cap-reached", message }` —
  logged and withheld by `account-lifecycle.ts`'s `ensure` exactly like a
  `cap-reached` refusal (see "Decision: withheld, not degraded" below);
  retried the next poll, never exceeding the limit, never failing silently.
- A `permanent` account is NEVER refused for this reason, and an existing
  `permanent` account is never counted toward it — only the count of
  `AccountRecord`s whose `policy === "temporary"` matters.

## The managed integration resource: a Personal Access Token

The "managed integration resource" the ticket asks this module to define and
clean up is exactly one Rocket.Chat Personal Access Token per managed user,
under the fixed name `RC_MANAGED_TOKEN_NAME` (`"butchr-managed"`,
`src/resources/rocketchat.ts`) — never a parameter, never a per-call name, so
there is exactly one to find and remove.

**TOKEN ROTATION, CORRECTED (BUTCHR-412, BUTCHR-391 comment 24007 item 3;
supersedes the ORIGINAL contract below, kept for history).** The original
contract — `ensureAccount` revokes-then-issues the token on EVERY call —
conflicts with the corrected S4 credential design: Nexus registers a managed
account's token with rocketr ONCE, so a routine re-ensure (a respawn, a
permanent account's adopt-on-every-start, a daemon restart) would silently
invalidate what rocketr already has, breaking that agent's connection with
no local symptom. Fixed: `ensureAccount` now REUSES an existing, still-valid
recorded token file (`AccountRecord.tokenFile`) UNTOUCHED — no revoke, no
regenerate, no RC token API call of any kind — and only mints a fresh token
(`EnsureAccountResult.rotated: true`) when there is no recorded token file
yet (a brand-new user, or a lost-record recovery) or the recorded one is
missing/unreadable/empty (`tokenFileValid`, `src/accounts/manager.ts`). A
still-valid reuse DOES still make one READ-ONLY RC call
(`getUserByUsername`) to confirm the recorded user is still there — this is
NOT a rotation call and never touches the token; it exists specifically to
preserve "Stale-record recovery" below (a KEEP behaviour) for the case where
the recorded token file survives but the RC user itself was deleted
out-of-band — without it, that case would silently go undetected forever,
since the original contract's own detection mechanism WAS the now-removed
unconditional revoke call. See "Wiring" below for what changed in
`src/agents/account-lifecycle.ts`/`SpawnSpec` because of this.

**ORIGINAL CONTRACT (superseded, kept for history):** `ensureAccount`
revoked-then-issued the token on every call (so a launcher always got
currently-valid connection material, and a stale token from a previous
session was never left live) — stated explicitly for BUTCHR-412 (the
follow-up wiring task) to design against. That is exactly the assumption
BUTCHR-412 found could not hold once Nexus/rocketr entered the picture, and
fixed as described above.

`releaseAccount` revokes it explicitly before deleting the user, even though
deleting the user would also destroy it — the explicit revoke is what makes
"the exact set of managed integration resources removed" auditable from the
client's own method names rather than implicit in a delete's side effects.

Webhooks were considered and rejected: this task creates no RC integration
beyond the account and its one token, so there is nothing else to clean up.
If a follow-up task adds a managed webhook or another integration resource
per account, its teardown belongs in `releaseAccount` alongside the token
revoke, and its name should say so here.

## The managed-marker guard

Before ANY destructive call (`deleteUser`, `revokeManagedToken` in
`releaseAccount`), the manager checks `isManagedUsername(record.username)`
AND that the username still matches what `rcUsernameFor(agentKey)` would
derive today. Both should be tautological — the manager only ever wrote
usernames it derived itself — but the check exists specifically so that a
corrupted or hand-edited persistence record (or a future bug that writes the
wrong username into a record) can never cause this module to delete a human's
account, or a legacy Bakr/Candlestix one. A mismatch refuses with `{ ok:
false, reason: "not-managed", message }` rather than proceeding.

**A named limitation, not closed by this guard:** the marker is the
`RC_MANAGED_PREFIX` username prefix ALONE — there is no second, independent
signal (a custom field, a tag) backing it up (see "Why a username prefix, not
a custom field" above for why a custom field was rejected). A human — or a
pre-existing Bakr/Candlestix — account that happens to already be named
exactly the string `rcUsernameFor` would derive for some agent key would be
silently adopted as though butchr had created it: `getUserByUsername` cannot
distinguish "an account I created" from "an account that happens to carry my
naming scheme". This is considered acceptable because the derived username
embeds a 10-hex-char hash of the full agent key (see "Identity mapping"
above), making an accidental real-world collision astronomically unlikely —
but it is a probabilistic argument, not a guarantee, and is recorded here as
a known, accepted gap rather than left implicit.

## Persistence (`src/accounts/manager.ts`'s `createFileAccountStore`)

One JSON file, `<workspace root>/.butchr-rc-accounts.json` — a flat map from
agent key to `{ agentKey, rcUserId, username, policy, createdAt, tokenFile }`
— living at the workspace ROOT, not inside any per-agent workspace
directory. `tokenFile` (BUTCHR-412) is a PATH to that account's 0600 token
file (`AccountManagerDeps.tokenDir` — see "Config" below); this store file
itself never holds a token value.

**Why not a per-agent workspace file.** The obvious alternative — a
`.butchr-rc-account.json` inside each agent's own `workspaceDirFor(agentKey)`
directory, alongside `.butchr-agy.json`/`.butchr-codex-isolation.json` — was
rejected for two reasons: `buildWorkspace` (`src/agents/workspace.ts`)
rewrites several files in that directory on every spawn (though it would
leave a differently-named file alone), and a per-agent directory may not
exist yet the first time `ensureAccount` runs for that agent (account
provisioning is meant to happen at or before agent start, and the exact
ordering is the follow-up task's to decide). A single root-anchored file:

- Exists once, independent of any agent's own spawn lifecycle.
- Survives agent stop, respawn, and daemon restart, because nothing else in
  this codebase ever reads or writes it.
- Makes `reconcileOrphans` one file read instead of a walk over every
  per-rule, per-resource workspace subdirectory.

**A read failure is never silently "empty".** Only a genuinely missing file
(`ENOENT`) reads as no records. Anything else — a truncated write, disk
corruption, anything `JSON.parse` rejects — throws loudly instead of being
swallowed. An earlier version of this module treated every read failure as
empty; a reviewer found that a corrupted file would then have its very next
`set` call silently rewrite it with only that one record, forgetting every
other managed account (a real Rocket.Chat seat leak against the 50-user
guardrail, invisible until someone noticed accounts they thought existed did
not). Writes are also atomic (temp file + rename), so this module's own
writes can never produce the corruption in the first place — a reader only
ever sees either the previous complete file or the next one, never a partial
one.

**Lost-record recovery.** `ensureAccount` never trusts a MISSING store record
alone: when `store.get(agentKey)` returns null, it falls back to
`client.getUserByUsername(rcUsernameFor(agentKey))` before deciding whether
to create — Rocket.Chat is the source of truth, and the derived username
means the record's loss (a wiped file, a moved workspace root, whatever) is
recoverable without creating a duplicate, exactly as the ticket requires.

**Stale-record recovery.** A record can also be wrong without being
missing: it can point at an RC user that is simply gone (deleted out-of-band
by an operator, or by a prior `releaseAccount` call that deleted the RC user
but was interrupted before it could clear the record). `ensureAccount`
detects this the moment it tries to act on that user (revoking/reissuing its
managed token) and gets RC's own "no such user" refusal back: it drops the
stale record and resolves fresh — falling through to the same
lookup-by-username-then-create path a missing record takes — rather than
failing that call, and every subsequent `ensureAccount` for the same agent,
forever. This recovery is not a loop: the retry never trusts a record, so it
terminates after at most one extra attempt.

**`releaseAccount` is idempotent for the same reason.** `stop`/`archive` can
legitimately be called more than once for the same agent (a retry, two
callers racing, BUTCHR-412's own stop path being called from more than one
place) — if the RC user is already gone by the time `releaseAccount` runs
(its own earlier call succeeded but the process died before clearing the
record; or, as above, something else removed the user), the revoke/delete
calls' own "no such user" refusal is treated as "already released", and the
stale record is cleared, rather than surfacing as a failure that leaves an
orphaned, un-clearable record behind.

## Config (`src/config/config.ts`)

`Config.rocketchat?: { url, adminUserId, adminTokenFile, userCapThreshold,
temporaryAccountCapThreshold, tokenDir, nexusManifestFile, managedPrefix? }`
— OPTIONAL, same all-or-nothing shape `github` already has: present only
when `ROCKETCHAT_URL`, `ROCKETCHAT_ADMIN_USER_ID` and
`ROCKETCHAT_ADMIN_TOKEN_FILE` are ALL set. A daemon with none of these set,
and no rule using `account !== "none"`, behaves exactly as it did before
this task landed. The four BUTCHR-412 fields
(`temporaryAccountCapThreshold`/`tokenDir`/`nexusManifestFile`/`managedPrefix`)
always get a computed default when `rocketchat` is present at all — see
below — so an operator only ever sets `ROCKETCHAT_URL`/`ROCKETCHAT_ADMIN_USER_ID`/
`ROCKETCHAT_ADMIN_TOKEN_FILE` to get sensible defaults for everything else.

`adminTokenFile` in `Config` is a **path**, never the token's contents —
`loadConfig`'s `readFile` parameter stays the simple "return this file's
text" shape every other section already uses; it never `stat`s a file or
checks permissions. The actual secret load, WITH the owner-only-file
permission check, is `src/resources/rocketchat.ts`'s `loadRocketChatAuth`
(mirroring `loadZendeskAuth` almost exactly): a regular file, owned by the
daemon's user or root, mode rejecting any group/other access, holding
exactly one printable-ASCII token. `loadRocketChatAuth` is called by
whichever code actually builds an RC client — out of scope here, since
wiring is the follow-up task's job — not by `loadConfig` itself, so that a
malformed-but-irrelevant `ROCKETCHAT_ADMIN_TOKEN_FILE` (e.g. a typo'd path)
never crashes a daemon whose rules never touch `account`.

Env vars: `ROCKETCHAT_URL` (e.g. `https://chat.example.com`),
`ROCKETCHAT_ADMIN_USER_ID` (not a secret — an RC user id),
`ROCKETCHAT_ADMIN_TOKEN_FILE` (a Personal Access Token file, same permission
discipline as `ZENDESK_OAUTH_TOKEN_FILE`), `ROCKETCHAT_USER_CAP_THRESHOLD`
(optional, default 45).

BUTCHR-412 adds four more, each optional with a computed default:

- `ROCKETCHAT_TEMPORARY_CAP_THRESHOLD` (default **8**) — see "The
  temporary-account cap" above.
- `ROCKETCHAT_TOKEN_DIR` (default `<workspace root>/.butchr-rc-tokens`) —
  where each managed account's 0600 token file lives; a daemon-owned
  directory, never inside any agent's own workspace.
- `ROCKETCHAT_NEXUS_MANIFEST_FILE` (default `<workspace root>/.butchr-rc-nexus-manifest.json`)
  — where the batched Nexus hand-off manifest is published; see "Token
  minting and the Nexus hand-off" below.
- `ROCKETCHAT_MANAGED_PREFIX` (default: `RC_MANAGED_PREFIX`, `"butchr_"`) —
  see "Identity mapping" above for why this is a knob, not yet a settled
  convention.

## What `docs/execution-modes.md` said before this task

That doc's `account` section previously read: "**Not yet implemented (a
later story, S4):** creating, attaching, or tearing down an actual
Rocket.Chat account. The field is validated and stored only." This task IS
that S4 lifecycle module (the client and the manager) — that line has been
corrected to point here. Wiring `ensureAccount`/`releaseAccount` into actual
agent start/stop is still not done; that remains the follow-up task's job,
now that this module exists for it to call.

## Wiring (BUTCHR-412, and BUTCHR-460 for managed sessions)

The follow-up task above is done. `src/agents/account-lifecycle.ts` wires
`ensureAccount`/`releaseAccount` into `reconcileNow` (`src/daemon/loop.ts`)
as two hooks, `ensure`/`release`, added to `ReconcileOptions.account` and
threaded through every rule loop (`src/daemon/index.ts`: jira-work,
github-issue, jira-idea, zendesk-ticket, AND — BUTCHR-460 — the built-in
managed-sessions loop) as ONE shared instance, over ONE shared
`AccountManager` — same "fleet-wide, not per-tier" discipline
`admissionController` already has, and for the same reason: one Rocket.Chat
seat budget, one store file.

**Managed sessions get the identical `ensure`/`release` contract described
below, with one addition — see "Archive release (BUTCHR-460)" further down.**
A managed-session definition's own `account` field (validated the same way a
`Rule`'s is — see `docs/managed-sessions.md`) drives `ensureAccount`/
`releaseAccount` exactly like any other provider's rule-level `account` does;
`accountPolicyOf` (`src/daemon/index.ts`) resolves it from the per-poll
`managedSessionAccountPolicies` map (rebuilt every poll from each eligible
definition's own `account` field — the same seam `managedSessionRoles`
already uses for `role`) rather than from a `Rule`, since the built-in
managed-sessions rule is ONE shared `Rule` (fixed `account: "none"`) for
every heterogeneous definition file. **One STARTUP-TIME caveat, honestly
named rather than left implicit:** whether `accountLifecycle` is built AT
ALL (see "DORMANT UNLESS..." above this section in the source) is decided
ONCE, from a snapshot of the definitions directory taken at daemon start —
same "root resolution happens once at daemon startup, not live" precedent
`docs/managed-sessions.md`'s own root-resolution section already documents.
A definition ADDED (or edited to newly request an account) after that
snapshot, on a daemon where no `rules.json` rule ALSO wants Rocket.Chat,
does not retroactively wake the subsystem up until the next restart — same
class of gap as any other definitions-directory change needing a restart to
be picked up by anything that isn't the poll loop itself.

**`ensure(spec)`** runs for exactly the ids about to be spawned — the
ordinary spawn loop's `admitted` set (already excludes every resident agent,
BUTCHR-287) and the respawn loop's stale-argv replacement — NEVER for an
already-running agent. `ensure` resolves to the `SpawnSpec` to actually hand
to `herd.spawn`, augmented with `spec.rocketchatAccount` (the agent's own,
non-secret Rocket.Chat account NAME — never a credential; see "Credential
design, corrected" below) when the id's rule wants an account — or `null` to
WITHHOLD the spawn entirely this poll when `ensureAccount` refuses (no RC
configured, either cap, a non-managed collision). **Decision: withheld, not
degraded.** An agent whose rule asked
for an account and didn't get one does not start anyway with no way to talk
to Rocket.Chat — it doesn't start at all, loudly (a `WARNING: [account]`
journal line always; a Jira comment too, for jira-work/jira-idea, via the
same `speakOnOwnChannel` seam `checkReconcileFailure` already uses — reusing
that hook's own audible-failure plumbing rather than a second one).
github-issue/zendesk-ticket get the journal line only (no generic
comment-writing seam is wired at this layer for either yet — a residual gap,
named rather than silently accepted).

**`release(id, reason)`** is called for a genuine `plan.stop` id
(`"stop"`, after `herd.stop` itself succeeds — never before, and never at
all if `herd.stop` throws) and for a stale-argv respawn's own interim stop
(`"respawn"`) — always calling the manager regardless of the id's CURRENT
rule policy, because the STORE's record, not today's rule config, decides
whether there is anything to release (a rule edited to `"none"` after
provisioning must still release the account it already made). This one
`plan.stop` call site is also where `stand_down`+`check_in`'s own exit
(`src/agents/check-in-exit.ts`, `src/agents/stand-down.ts`), a
singleton dropping to zero matches, and a persistent rule's freeze
(`enabled: false`) all land — none of those has its own direct `herd.stop()`
call; each works by removing an id from `atRest`/`desired` so it falls into
the SAME `plan.stop` diff `reconcileNow` already computes every poll. One
hook, every one of those paths covered by construction, not by a
per-mechanism special case.

**A failed `release` is retried, not lost (review round 1, blocking finding
2).** By the time `release` runs, `herd.stop` has already succeeded — the
agent is gone. If the underlying `releaseAccount` call then THROWS (a
transient Rocket.Chat failure; its own "user not found" is already caught
and treated as success), the id is no longer `running`, so it can never
again land in a future poll's `plan.stop` on its own — there is no natural
retry path through the ordinary reconcile diff the way any other spawn/stop
failure gets one. `release` never lets that throw escape: it queues the id
in an in-memory map instead, and a new `retryPendingReleases` hook — called
once per poll by `reconcileNow`, at the very top, independent of `plan.stop`
— keeps retrying every queued id until the manager confirms it one way or
the other. `ensure` cancels a queued release for the SAME id before
proceeding (the account is being actively reused — `ensureAccount` will
correctly ADOPT the still-live RC user, since the earlier release never
actually completed, so a stale queued release must not go on to delete it
out from under the now-running agent). This is the FAST recovery path
(next poll, seconds to a minute); the periodic orphan sweep below is the
SLOW, crash-safe backstop for the same failure mode across a daemon
restart, which drops the in-memory queue but not the store's own record.

**Archive release (BUTCHR-460).** `butchr session archive` (S3, BUTCHR-394)
moves a managed-session definition file out of the active directory — the
next poll, `searchSessionDefinitions` no longer lists it, so it drops out of
`desired` and falls into the SAME `plan.stop` diff described above, `release`
included, exactly like any other definition that stops being desired
(deleted outright, edited invalid, frozen). That alone already releases a
`temporary` account correctly — but always reports reason `"stop"`, which is
accurate (nothing here is wrong) but not the SPECIFIC, already-modeled reason
(`ReleaseReason` has carried `"archive"` distinctly since BUTCHR-410) an
archive actually is. `src/agents/managed-session-account-release.ts`'s
`wireManagedSessionArchiveRelease` sits in front of `release`, for the
managed-sessions loop ONLY, and upgrades a `"stop"` call to `"archive"` the
moment it can positively confirm the definition now exists, under its exact
original basename, in the archive directory (`sessionArchiveDir`,
`src/resources/session-archive.ts` — the one function every archive-
directory caller resolves through). This also catches an archive done by
hand-moving the file (indistinguishable, from this check's point of view,
from one done through the CLI) — something no CLI-side hook could ever see.
`stop` and `archive` behave IDENTICALLY in `releaseAccount` itself (both
unprovision a `temporary` account, retain a `permanent` one) — this
distinction is purely for the audit trail (the `[account] ... released
(archive)` log line, and an equally honest `WARNING: [account] ... release
(archive) failed — ... queued for retry` line on the failure path above,
which this wrapper does not change at all: a queued/retried archive release
is still retried by the SAME `retryPendingReleases` mechanism, with reason
`"archive"` preserved through the retry).

**Why not `archiveSessionDefinition`'s own `onArchived` hook instead.**
`butchr session archive` is a credential-free, daemon-free CLI process
(`src/cli/session-cli.ts`'s own top comment) — it has no Rocket.Chat client,
account store, or Nexus manifest publisher. Wiring release there (the
design question's "Option 1") would mean a SECOND process writing
`.butchr-rc-accounts.json` with no cross-process lock (the account manager's
own in-process keyed lock, "Race-safety" above, does not span processes),
and the Nexus hand-off manifest is only ever republished by the daemon's own
per-poll batch (`publishBatch`, "Batch provisioning" below) — a CLI-side
release would leave a released account listed in the manifest until some
UNRELATED later batch happened to republish it. `onArchived` stays a
documented no-op (`src/cli/session-cli.ts`'s `defaultIo()`); the real release
is entirely daemon-side, described above.

**Deliberately NOT wired**: `watchSessionLimits`'s own `herd.stop()` call
(`src/daemon/index.ts`) — a session-limit close is the same agent identity,
about to resume once its limit resets, exactly the "about to be reused"
case the ticket's own DoD calls out; releasing there would unprovision a
temporary account for an agent that is coming right back.

**The self-exit path** (`HerdrHerd.closeStranded`, a crash/`/exit`/quota
close that never goes through `herd.stop()`/`plan.stop` at all) gets its own
release call from `createReaper`'s new optional `release` hook
(`src/agents/reap.ts`), fired with the closed workspace's own label (its
agent key) right after a successful close, reason `"stop"` — a reap IS a
genuine stop. A release failure there is logged and swallowed, never fails
the reap.

**Daemon shutdown**: still no stop handler — confirmed unchanged by this
task, and correctly so: agents keep running under herdr regardless of this
process's own lifetime, so nothing should be released just because the
daemon restarts (this is exactly why `"daemon-restart"` never unprovisions).
The residual gap this leaves is an account whose agent genuinely stopped
existing with no reaper run in between (a daemon crash before any reap poll
observed it, or an account orphaned by an earlier bug) — `reconcileOrphans`
is the read-only backstop named above for exactly this.

`src/agents/account-orphan-sweep.ts`'s `createAccountOrphanSweep` is the SAFE
wrapper `src/daemon/index.ts` wires around it (once at startup, then every 30
minutes) — a first pass acted on a single `herd.runningIssues()` snapshot
directly and was rejected in review (round 1, blocking finding 1): `HerdrHerd.byIssue()`,
which `runningIssues()` is built on, deliberately DROPS an id from that
snapshot whenever two live panes currently share its workspace path (the
ordinary overlap during a respawn or a quota-recovery pane replacement) —
reading as "not running" for reasons that have nothing to do with whether
the agent is actually there, which a single-snapshot sweep could act on
destructively. Two independent layers fix this:

1. **`herd.residentIssues()`, not `runningIssues()`.** It groups panes by
   workspace directory rather than requiring a uniquely-attributed pane the
   way `byIssue()` does, and reads "resident" the instant ANY owned pane
   shows a live claude process — exactly the ambiguous-pane shape above,
   correctly resolved (pinned directly at the residency-census layer:
   `test/unit/residency-census.test.ts`'s `aggregateVerdict(["dead","live","unknown"])
   === "resident"`). It also THROWS rather than returning `[]` on a
   `pane.list()` failure; the sweep treats that as "observed nothing
   reliable this round," never as "everything is gone."
2. **A minimum record age (10 minutes) and a two-consecutive-sweep grace**
   before any release — protects a genuinely live, but freshly-created,
   agent (a brief window where `residentIssues()` still reads "unknown," not
   yet "resident," before its pane reports a recognisable process) far more
   generously than that window could ever last.

Never releases on an unreliable read either way: a failed `residentIssues()`
or `reconcileOrphans` call leaves every tracked streak untouched — not
reset, not advanced — so a transient herdr hiccup costs a delay, never a
false release.

## Credential design, corrected (BUTCHR-412, BUTCHR-391 comment 24007)

**This section describes the CURRENT design.** An earlier round of this
ticket delivered the provisioned account's `{ rcUserId, token }` (RC's own
`X-User-Id`/`X-Auth-Token` pair) plus `url` to the agent as a dedicated 0600
file (`.butchr-rocketchat.json`, `RC_ACCOUNT_FILE`) inside its own workspace
directory, which the agent itself read. **That design is superseded and
removed — nothing in this codebase writes that file any more.** The
corrected design, from the epic's own late-arriving requirement (BUTCHR-391
comment 24007, itself correcting comment 24003's credential-handoff point):

> Agents never hold a Rocket.Chat credential. rocketr is a bridge: every
> token lives centrally in rocketr. An agent's MCP binding only names its
> account, in the header `x-rocketr-account`.

**What changed, concretely:**

- `SpawnSpec.rocketchat: { url, rcUserId, username, token }` → `SpawnSpec.rocketchatAccount: string`
  (`src/agents/workspace.ts`) — just the account NAME, never a credential of
  any shape. `account-lifecycle.ts`'s `ensure` sets it from
  `EnsureAccountResult.username` alone; `EnsureAccountResult` itself carries
  no token value at all any more (see "Token rotation, corrected" above).
- `RC_ACCOUNT_FILE`/`.butchr-rocketchat.json` is REMOVED outright (the
  "prefer removing it" branch of the ticket's own two options) — `buildWorkspace`
  no longer writes, chmods, or unlinks any such file. No RC token value ever
  reaches an agent's workspace directory, argv, mcp.json, logs, or brief.md/
  ENVIRONMENT.md — there is simply no code path left that could put one
  there.
- **How the account name reaches the agent instead**: `McpServerBinding`
  (BUTCHR-411, `src/rules/rules.ts`) gains `accountHeader?: string` — a
  binding names a header (e.g. `"x-rocketr-account"`), and
  `resolveAccountHeader` (`src/agents/workspace.ts`) fills its VALUE from
  `spec.rocketchatAccount` at `buildWorkspace` time, merged into that
  binding's `mcp.json` headers alongside (or instead of) `headersEnvVar`'s
  own resolution. A rule that wants its agents to talk to rocketr therefore
  names ONE `mcpServers` entry pointing at rocketr's own MCP endpoint, with
  `accountHeader: "x-rocketr-account"` — no separate mechanism, no second
  file.

**Why extend `McpServerBinding` rather than fork a second mechanism (the
ticket's own explicit ask).** BUTCHR-411's existing `headersEnvVar` resolves
ONE static value per RULE from the daemon's own environment, read fresh at
every launch but identical across every agent that rule spawns — it cannot
express "a different value per AGENT," which is exactly what an account name
is. Rather than invent a competing binding shape for this one case,
`accountHeader` rides the SAME `McpServerBinding`/`mcp.json`-header pipeline
`headersEnvVar` already established, as a second, independent resolution
source for the SAME `headers` object (`buildWorkspace` merges
`resolveMcpServerHeaders(binding)` and `resolveAccountHeader(binding, spec.rocketchatAccount)`
into one object per binding) — a rule can use either, both, or neither on
the same binding.

**Why the account name is safe where the token was not (the ticket's own
required justification).** `headersEnvVar`'s values are deliberately kept
out of Codex argv/journal entirely (see that field's own doc comment,
`src/rules/rules.ts`) because they are typically secrets (bearer tokens) —
process argv is world-readable via `/proc`, and a daemon log line has
historically echoed observed argv verbatim (the `[reconcile] ... respawned
... (was: <argv>)` line named in BUTCHR-411's own review). An
`accountHeader` value is a Rocket.Chat/rocketr account NAME — the exact
non-secret identifier this whole redesign exists to make the ONLY thing
that ever moves. It carries no more sensitivity than the ticket key or agent
key that already appear in every log line and every workspace file today.
`buildWorkspace`'s own `hasSecretHeaders`/chmod-0600 logic (below) reflects
this: an `accountHeader` resolution alone never tightens `mcp.json`'s
permissions, only a `headersEnvVar` resolution does. **Narrowed scope,
stated honestly**: no caller resolves EITHER kind of header for a Codex
launch today (`boundCodexServers`, `src/agents/argv.ts`, never resolves
headers for either mechanism) — allowing `accountHeader` through Codex's own
argv-stripping specifically is S6's to design (BUTCHR-419/420, per BUTCHR-391
comment 24007's own "what this changes elsewhere" list), not built here.

**mcp.json permission tightening, unchanged in spirit.** `buildWorkspace`
still chmods `mcp.json` to 0600 whenever ANY binding resolves a
`headersEnvVar` value (potentially a secret) — untouched by this ticket. An
`accountHeader`-only resolution (no `headersEnvVar` on that binding) leaves
`mcp.json` at its ordinary permissions, since there is nothing secret in it.

## Token minting and the Nexus hand-off (BUTCHR-412, BUTCHR-391 comment 24007 item 2)

Butchr still MINTS the token (revoke-then-generate, or reuse — see "Token
rotation, corrected" above) — it just never hands the value to the agent.
Instead:

1. `ensureAccount` writes the freshly-minted token to a 0600 file at
   `<tokenDir>/<username>.token` (`AccountManagerDeps.tokenDir`, a
   configurable, daemon-owned directory — `ROCKETCHAT_TOKEN_DIR`, default
   `<workspace root>/.butchr-rc-tokens` — never inside any agent's own
   workspace).
2. `AccountRecord.tokenFile` (the store) and `EnsureAccountResult.tokenFile`
   (the call's own return) both carry that PATH, never the token value.
3. `AccountManager.manifestEntries()` reads the store and returns every
   `{ account, tokenFile }` pair currently on record.
4. `src/agents/account-lifecycle.ts`'s `publishBatch()` writes those pairs,
   via `createFileNexusManifestPublisher` (`src/accounts/nexus-manifest.ts`),
   to a SECOND 0600 file — the Nexus hand-off manifest
   (`ROCKETCHAT_NEXUS_MANIFEST_FILE`, default
   `<workspace root>/.butchr-rc-nexus-manifest.json`) — a full snapshot, at
   most once per batch (see "Batch provisioning" below). Nexus reads this
   file and registers each account with rocketr; butchr never talks to
   rocketr directly, and the manifest never carries a token value, only the
   token FILE'S path (which Nexus's own privileged process can then read).

**Test coverage's own falsifier**: no token value ever appears in a log
line, argv, the manifest file, a ticket comment, or any agent-readable file
— only inside a 0600 token file this module itself wrote, and only ever
referenced elsewhere by path.

## Batch provisioning (BUTCHR-412, BUTCHR-391 comment 24007 item "batch provisioning")

Each rocketr registration reconnects the WHOLE fleet, per Nexus's own terms
(BUTCHR-391 comment 24007) — so publishing the manifest once per agent start
would reconnect rocketr once per agent, unacceptable at any real fleet size.
`account-lifecycle.ts` closes over a single `dirty` flag: `ensure` sets it
only when `EnsureAccountResult.rotated` is `true` (a fresh token was
actually minted — an adopt-with-a-still-valid-token `ensure` never sets it),
and `release` sets it only when `result.released` is `true` (an account was
actually deleted). `publishBatch()` — called EXACTLY ONCE by `reconcileNow`
per poll, at the very end, after every `ensure`/`release` that poll made
(`src/daemon/loop.ts`) — publishes the full current `manifestEntries()`
snapshot IF AND ONLY IF `dirty`, then clears it; a publish failure leaves
`dirty` set so the NEXT batch retries, never silently dropping a change. The
periodic orphan sweep (`src/agents/account-orphan-sweep.ts`, its own
independent timer) calls the SAME shared instance's `publishBatch()` once
after its own round, for the same one-poll-one-publish discipline on ITS
release path too — the two never double-publish because they share the same
`dirty` flag on the ONE `AccountLifecycleHooks` instance both are wired
against.

**Test coverage's own falsifier**: N agents starting (or releasing) within
one `reconcileNow` poll produce exactly ONE `manifestPublisher.publish()`
call, listing all N — never N separate calls, and never a call at all when
nothing this poll actually changed.

**Cap refusal is visible, not silent** — see "Decision: withheld, not
degraded" above; tested end to end (`test/unit/account-lifecycle.test.ts`).

## Provisioning-failure policy — restated as THE policy (BUTCHR-412 item 6)

Unchanged from the first round, restated here explicitly per BUTCHR-391's
own ask: **withhold, never degrade.** ANY `ensureAccount` refusal (no RC
configured, the 50-user guardrail, the temporary-account cap, a non-managed
collision) withholds the spawn entirely — an agent whose rule requires an
account never starts without one. There is no "start it anyway, chat-less"
path anywhere in this codebase. See "Decision: withheld, not degraded" above
for the audible side of this (a journal line always; a Jira comment for
jira-work/jira-idea).

## Provisioning is for new agents only (BUTCHR-412 item 8, BUTCHR-391 "Butchr provisions new agents only")

Unchanged, restated: `ensureAccount` never rewrites or adopts an RC user that
does not already carry butchr's own `RC_MANAGED_PREFIX` marker (or its
configured override) — see "The managed-marker guard" above. An operator's
own hand-made account, or an existing Nexus/Bakr/Candlestix account with a
different naming scheme, is never touched, never adopted, and never
released, regardless of what an agent's rule policy asks for. Interpretation
for this ticket: this refusal (`not-managed`) IS the enforcement mechanism
for "provisions new agents only" — there is no separate opt-in/allowlist,
because a managed username is only ever produced by this module's own
deterministic derivation (`rcUsernameFor`), so an account this module did
NOT create can never accidentally collide with (and be silently adopted as)
one it manages, short of the astronomically-unlikely hash collision named in
"A named limitation, not closed by this guard" above. Adopting Nexus's
pre-existing hand-made accounts (BUTCHR-391 comment 23997: "Brooswit's
decision... deferred until after the 1 Oct reset") is explicitly out of
scope here and remains so.

## Human access is unaffected (BUTCHR-412 item 9)

Nothing in this ticket's design prevents a human from DMing a running
agent's Rocket.Chat account — there is nothing to build: the account exists
for the agent's whole run (a `temporary` account is released only on a
genuine stop, never merely because it's idle), and rocketr relays messages
by account regardless of who initiates the conversation. The corrected
credential design (agent never holds a token) does not change this either —
rocketr, not the agent's own MCP connection, is what a human's DM actually
reaches.

## Concurrency: both caps are check-and-reserve, not check-then-create (BUTCHR-412 review round 3, blocking)

`reconcileNow` runs `ensure` for every admitted agent under ONE `Promise.all`
(`src/daemon/loop.ts`) — DIFFERENT agent keys, so `ensureAccount`'s own
per-agent-key lock (`makeKeyedLock`) does nothing to protect a cap check
shared ACROSS keys. A bare "read the count, compare to the threshold, then
create" is not atomic with respect to a concurrent caller doing the exact
same read before either has created anything: every concurrent call can
observe the SAME pre-creation count and all decide to proceed, overshooting
the cap (reproduced in review: 12 concurrent temporary ensures against a cap
of 8 created all 12).

Fixed with an in-memory reservation (`reservedTotal` for the RC-wide
`userCapThreshold`, `reservedTemporary` for the temporary-account cap),
serialized by the SAME `withLock` helper already used for per-agent-key
locking, keyed under a reserved constant (`\u0000cap`, a string no
real agent key — always `provider:rule:resource` — can ever collide with).
`reserveCapacitySlot` reads the current count PLUS the in-flight
reservations and increments atomically; the reservation is released — in a
`finally`, exactly once — only AFTER the new record is actually persisted
(the success path) or once the attempt has definitively failed (nothing will
ever be persisted for it). This closes the exact gap a bare count-then-create
misses: at every instant, either the STORE (temporary cap) or the live
`countUsers()` PLUS the reservation (RC-wide cap) — never neither — accounts
for a slot from the moment a caller decides to create it.

**Why the two caps needed different persisted-count sources, and why that's
fine.** The temporary cap's "already exists" count is `deps.store.list()` —
a purely local, immediately-consistent read this module fully controls, so
each successive concurrent call's fresh read already reflects every prior
call's now-persisted record on its own, and the reservation only needs to
cover the brief pre-persistence window. The RC-wide cap's count is
`client.countUsers()` — Rocket.Chat's own live count — assumed to be
read-after-write consistent for a create this SAME admin credential just
made (a reasonable assumption for a REST API against one server); the
reservation covers the same pre-persistence window for THAT source instead.
Neither cap's fix depends on the other ever becoming stale or unreliable —
each is provably correct on its own terms. (A permanently non-advancing
`countUsers()` — e.g. an RC deployment with truly eventual-consistent reads —
is not a scenario this fix (or the original design) claims to cover; the
reservation only ever bridges REAL concurrent in-flight creates, not a
source of truth that has stopped advancing at all.)

## Residual gaps in reuse-not-rotate (BUTCHR-412 review round 3, non-blocking)

Stated honestly per the review's own ask, rather than left implicit:

- **A token revoked on the RC side (an admin removes the PAT out-of-band) is
  never noticed and never re-minted.** "Valid" token reuse
  (`tokenFileValid`) means only "the recorded file reads back non-empty"
  plus a read-only `getUserByUsername` existence check — neither actually
  calls RC to confirm the TOKEN itself still works. An agent (or Nexus, via
  rocketr) would only discover this the same way any expired-credential
  failure surfaces today — this module has no active token-liveness probe,
  by design (adding one would mean either a live RC call on every
  `ensureAccount`, defeating the whole point of "reuse without touching RC,"
  or a separate polling mechanism nothing here currently has a seam for).
- **A released `temporary` account simply disappears from the manifest with
  no explicit signal that Nexus should unregister it from rocketr.**
  `publishBatch` republishes the full, current `manifestEntries()` snapshot
  whenever a release marks the batch dirty, so the released account's entry
  is genuinely gone from the next manifest Nexus reads — but nothing tells
  Nexus WHY an entry vanished (released vs. some other cause), and nothing
  confirms Nexus actually unregistered it from rocketr in response. Both are
  accepted, documented gaps for this ticket's scope — closing either is a
  Nexus-side or S5-side follow-up, not a `reconcileNow`/`account-lifecycle.ts`
  change.

**Tests.** `test/fixtures/rocketchat-fakes.ts` is the reusable fake-RC
harness (a fake `AccountStore`, a fake `RocketChatClient`, a fake
`NexusManifestPublisher`, and `baseAccountManagerDeps`/`freshTokenDir` —
`createAccountManager` now writes REAL 0600 token files, so every test gets
its own isolated scratch `tokenDir`) — shared by `test/unit/rc-account-manager.test.ts`
(this module's own unit tests: create/adopt/stale-recovery as before, PLUS
BUTCHR-412's own new coverage — "token rotation" reuses a still-valid token
file untouched (no revoke/generate calls), mints fresh on a missing/empty
one, a read-only `getUserByUsername` liveness check still catches an
out-of-band RC deletion even on the reuse path; "temporary-account cap"
withholds at the threshold, never for `permanent`, never on an adopt/reuse
path; "manifestEntries" lists every `{account, tokenFile}` pair and never a
token value; release cleans up the token file, not just the store record)
and this task's `test/unit/account-lifecycle.test.ts` (the hook contract in
isolation: `spec.rocketchatAccount` carries only the account name, the
pending-release retry — a throwing release is queued and never rethrown,
`retryPendingReleases` drains it, `ensure` cancels a queued release for the
same id — and BUTCHR-412's own `publishBatch` batching: a no-op batch never
publishes, a still-valid-token adopt never marks it dirty, N ensures within
one batch publish exactly once listing all N, a publish failure leaves it
dirty for the next batch to retry) and `test/unit/account-reconcile-matrix.test.ts`
(the full 3x3 `{swarm,singleton,persistent} x {none,temporary,permanent}`
grid, run through the REAL `reconcileNow`, proving the account layer never
branches on execution mode at all — the 3x3 is genuinely 3 independent
repetitions of one 3-way behaviour). `test/unit/account-orphan-sweep.test.ts`
covers the safe sweep directly, per the review's own required list: a
resident agent is never released, an id `residentIssues()` reports absent is
never released until the grace rule clears it, a mid-spawn (too-young)
record is never released, a genuinely gone agent IS released after two
consecutive absent sweeps, a permanent account is never touched, a failing
`residentIssues()`/`reconcileOrphans()` releases nothing and leaves any
in-progress streak untouched, and (BUTCHR-412) `publishBatch` is called
exactly once per sweep round when wired, and is a documented no-op when
omitted. `test/unit/reap.test.ts` covers the self-exit release hook;
`test/unit/workspace.test.ts` covers `resolveAccountHeader`/`spec.rocketchatAccount`
wiring into `mcp.json` (never tightening permissions by itself, combining
correctly with a `headersEnvVar` on the same binding, omitted entirely when
absent) and asserts `.butchr-rocketchat.json` is never written by anything;
`test/unit/rules.test.ts`/`test/unit/session-definition.test.ts` cover
`McpServerBinding.accountHeader`'s own validation (a valid HTTP header name,
combines with `headersEnvVar`, rejects a malformed one); `test/unit/loop.test.ts`
covers `reconcileNow`'s own call sites (ensure-before-spawn withholding,
release-after-stop, ensure-before-respawn leaving a refused stale agent
running rather than stopping it with nothing to replace it,
`retryPendingReleases` called exactly once per poll, and (BUTCHR-412)
`publishBatch` called exactly once per poll, after `retryPendingReleases`
and every `ensure`/`release`); `test/unit/config.test.ts` covers the four new
`Config.rocketchat` fields and their env vars/defaults.

**BUTCHR-460's own coverage.** `test/unit/managed-session-account-release.test.ts`
covers `wireManagedSessionArchiveRelease` directly: a `"stop"` release for a
managed-session id upgrades to `"archive"` exactly when the archive
directory holds a same-basename file, stays `"stop"` when it does not
(deleted/invalidated/frozen, not archived), never upgrades a `"respawn"`
release or a non-managed-session id's `"stop"` even against a coincidentally
matching path, honours `BUTCHR_SESSION_ARCHIVE_DIR`, and passes
`ensure`/`retryPendingReleases`/`publishBatch` straight through unchanged.
`test/unit/session-definition-type.test.ts` covers the `accountPolicies` map
(cleared and rebuilt every search from each eligible match's own manifest
`account` field, same discipline `roles` already has — a frozen/removed
definition's policy does not linger). No test seeds a live daemon or a real
Rocket.Chat server for any of this — the managed-sessions loop's own
`account`/`accountPolicies` wiring and the archive-detection wrapper are both
exercised entirely through the fake-RC harness and injected fakes, same
discipline as every other test in this file's own list.
