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
| `temporary` | create-if-missing | `stop`/`archive`: unprovision (delete user + revoke its managed token). `respawn`/`daemon-restart`: no-op — same agent identity coming back, not it stopping |
| `permanent` | create-if-missing, or adopt if it already exists | always a no-op that says so, for every reason including `stop`/`archive` |

`releaseAccount(agentKey, "archive")` is BUTCHR-394's (S3 archive) entry
point into this module — its name and this shape (`ReleaseReason` including
`"archive"`) are stable for that ticket to call.

## `ensureAccount` / `releaseAccount` contract

```ts
ensureAccount(agentKey: string, policy: AccountPolicy): Promise<EnsureAccountResult>
```

`EnsureAccountResult` is one of:

- `{ ok: true, policy: "none" }`
- `{ ok: true, policy: "temporary" | "permanent", rcUserId, username, token, created }` —
  `token` is a freshly-issued Rocket.Chat Personal Access Token (see "The
  managed integration resource" below); a launcher uses `{ userId: rcUserId,
  authToken: token }` as RC's own `X-User-Id`/`X-Auth-Token` header pair.
  `created` is `true` only when this call actually created the RC user
  (`false` for every adoption, including a lost-record recovery).
- `{ ok: false, reason: "rc-not-configured" | "cap-reached" | "not-managed", message }` —
  a REFUSAL, never a thrown error, for every condition a caller must handle
  without a crash: no RC config, the guardrail, or (defensively — should
  never actually happen, since the username is always self-derived) a
  username collision with something not carrying butchr's own marker.

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
anything: acting on the list (the actual sweep) is for the follow-up task
and S5's retirement of legacy Bakr/Candlestix accounts.

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

## The managed integration resource: a Personal Access Token

The "managed integration resource" the ticket asks this module to define and
clean up is exactly one Rocket.Chat Personal Access Token per managed user,
under the fixed name `RC_MANAGED_TOKEN_NAME` (`"butchr-managed"`,
`src/resources/rocketchat.ts`) — never a parameter, never a per-call name, so
there is exactly one to find and remove. `ensureAccount` revokes-then-issues
it on every call (so a launcher always gets currently-valid connection
material, and a stale token from a previous session is never left live).
**This is a rotation contract, stated explicitly for BUTCHR-412 (the
follow-up wiring task) to design against:** every successful `ensureAccount`
call invalidates whatever managed token that agent held before, including
one an already-running agent is actively using — calling `ensureAccount`
again for a still-running agent (a duplicate start, a respawn that re-ensures
before checking whether an account already exists, anything of that shape)
silently pulls the rug out from under it. BUTCHR-412 must either treat
`ensureAccount`'s token as good for exactly one launch and never call it
again while that launch is live, or accept that re-calling it means
reissuing the running agent's connection material too — this module does not
decide that for it, but it must not be assumed tokens are stable across
repeat calls.

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
agent key to `{ agentKey, rcUserId, username, policy, createdAt }` — living
at the workspace ROOT, not inside any per-agent workspace directory.

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

`Config.rocketchat?: { url, adminUserId, adminTokenFile, userCapThreshold }`
— OPTIONAL, same all-or-nothing shape `github` already has: present only
when `ROCKETCHAT_URL`, `ROCKETCHAT_ADMIN_USER_ID` and
`ROCKETCHAT_ADMIN_TOKEN_FILE` are ALL set. A daemon with none of these set,
and no rule using `account !== "none"`, behaves exactly as it did before
this task landed.

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

## What `docs/execution-modes.md` said before this task

That doc's `account` section previously read: "**Not yet implemented (a
later story, S4):** creating, attaching, or tearing down an actual
Rocket.Chat account. The field is validated and stored only." This task IS
that S4 lifecycle module (the client and the manager) — that line has been
corrected to point here. Wiring `ensureAccount`/`releaseAccount` into actual
agent start/stop is still not done; that remains the follow-up task's job,
now that this module exists for it to call.
