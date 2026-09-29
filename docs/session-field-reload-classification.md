# Managed-session definition fields: hot-reload / resume / fresh-restart classification

**CORRECTION NOTICE (FACTORY-411, 2026-09-28), from live measurement, not
a re-read.** This doc's original entries for `permissionMode`,
`strictMcpConfig`, and `mcpServers`' `channel` flag (for a managed-session
agent) classified them as **"C, detected via `checkArgv`."** That
detection claim is wrong: `staleIssues()` builds `expected` for these three
fields from a workspace bookkeeping file `buildWorkspace()` writes only at
spawn or post-resume, never refreshed from the live definition on an
ordinary poll — so a live edit to any of them can never make `checkArgv`
fail, and `staleIssues()` never reports the agent as stale for that reason
at all. Confirmed by direct observation (a live definition edit left
unresolved for 1h45m against a healthy, continuously-polling daemon) as
well as by source reading; the codebase's own doc comment at
`src/daemon/index.ts` (on why `lizardMode` is read live) independently
names this as deliberate FACTORY-43 behaviour, not an oversight. Corrected
in place at each field's own entry below and in the summary table; the
original text is kept underneath each correction as history, not to be
trusted for detection. See FACTORY-411's PR for the full write-up.

FACTORY-413 (story FACTORY-410, epic FACTORY-394). A survey, not an
implementation: for every field of a managed-session definition
(`SessionDefinition`, `src/resources/session-definition.ts`), what actually
happens to a *currently running* managed-session agent when that field
changes in its definition file, classified as:

- **(A) hot-reload in place** — the change takes effect with zero process
  restart; the running Claude/Codex process keeps going.
- **(B) resume with new flags** — the process restarts, but the
  conversation/session is preserved (the mechanism FACTORY-312/FACTORY-314
  built).
- **(C) fresh process, session lost** — a full stop-then-spawn, a brand new
  session, no conversation carried over.

Two heads matter and are cited throughout, never conflated:

- **`main` @ `c501b61`** (`git log --oneline -1`, read 2026-09-28) — what is
  actually deployed today. **This repo has no `resumeInPlace`/`resumable`
  concept on `main` at all** (`grep -rn "resumeInPlace\|resumable"
  src/agents/herd.ts src/daemon/loop.ts` on `main`: zero matches). So on
  `main` as it stands right now, **every** field in this table is
  functionally class C: any staleness at all — including a bare
  model/effort change — is a full `herd.stop()` + `herd.spawn()`, a fresh
  process, session lost. There is no exception.
- **`origin/FACTORY-314` @ `e5e959e5d92aaf98300a0cd2d3c086b2c2b73965`** (PR
  [#513](https://github.com/brooswit-factory/butchr/pull/513), fetched and
  read 2026-09-28; confirmed current via `gh pr view 513 --json
  headRefOid`) — the *unmerged* branch that adds the model/effort
  resume-in-place mechanism. **This PR is NOT approved and NOT merged.**
  Its last formal GitHub review is `APPROVED @ e5e959e` (wroosbit, story
  level), but the epic (FACTORY-73) posted `CHANGES_REQUESTED @ e5e959e` as
  a **PR comment**, not a formal review state — GitHub refused a formal
  review because the epic agent and the PR author share the same GitHub
  account (`booswrit`). Treat that comment as binding on the merge exactly
  as a formal CHANGES_REQUESTED would be (per FACTORY-312 comment
  `27225`/FACTORY-410 comment `27227`, both read directly, not through
  `jira_search`).

The table below classifies each field **as the FACTORY-314 mechanism is
currently written on that branch** — that is the epic's own stated
reference point and the only place a "B" class exists anywhere in this
codebase — while stating plainly, per field, that on `main` today the field
is C regardless. Where the branch and `main` would classify a field the
same way (C either way), that's called out too.

## The precondition on the entire class-B set

Before reading the per-field table: **every class-B classification below is
conditional on the identity mechanism FACTORY-314 built being trustworthy,
and at the head read above, it is not, for a case its own tests do not
cover.**

Verified directly against `origin/FACTORY-314` @ `e5e959e` (source reading,
not inference — see `src/agents/workspace.ts` lines ~1049-1131 and
`src/agents/herd.ts`'s `spawnExclusive` success block):

- `.butchr-session-id.json` (`persistDiscoveredSessionId`) is **only ever
  written, never invalidated**. `grep -rn "unlink\|rm(" src/agents/workspace.ts
  src/agents/herd.ts` on this branch: no match — there is no code path that
  ever deletes or overwrites this file with "unknown" on a failed discovery.
- On a fresh spawn, `HerdrHerd.spawnExclusive` retries
  `discoverClaudeSessionId` up to `SESSION_DISCOVERY_ATTEMPTS` (15) times,
  and on total failure only **logs a WARNING** — the `else` branch does not
  touch the persisted file at all.
- Consequence, confirmed by tracing the code (not yet by a live repro): if
  workspace `W` had a *prior* successful discovery (file = session `S1`),
  is later fresh-restarted for any unrelated reason, and picks a new native
  session `S2`, and *this* discovery attempt loses the race against
  transcript-file creation (the exact race `SESSION_DISCOVERY_ATTEMPTS`
  exists to bound, not eliminate — see that constant's own doc comment),
  the file on disk still says `S1`. `claudeTranscriptExists` is an
  `existsSync` check only — `S1`'s transcript is still sitting in the same
  per-cwd project folder, so it passes. A later model/effort change then
  `/exit`s the live `S2` agent and relaunches with `--resume S1` — silently
  resuming the *finished pre-restart* conversation, reporting "session
  preserved," while `S2`'s actual work is gone.
- Ran the branch's own test suite to check for coverage of exactly this
  sequence (`bun test test/unit/herd.test.ts` at `e5e959e`, from a
  dedicated worktree, `bun install` against the pinned `@brooswit/drovr@0.16.3`):
  **112 pass / 0 fail**. The one test that exercises a failed discovery
  (`"success line names the issue..."`, `test/unit/herd.test.ts:320`) does
  so against a **fresh** fake workspace with no prior transcript at all — it
  proves the WARNING log line fires, not that a *stale* id is ever cleared.
  No test in the suite asserts `resumeInPlace()` returns `"unresumable"`
  after this specific prior-success-then-failed-rediscovery sequence. A
  green gate here is evidence the covered behavior works, not evidence this
  gap is closed (per this ticket's own evidence-ranking rule).

This is exactly the third trap the epic flagged (FACTORY-312 comment
`27225`, relayed to this ticket via FACTORY-410 comment `27227` and a
`correct_worker` update to FACTORY-413 itself, both read directly): **it is
still live at the head this survey reads.** Every "B" below inherits it —
read each as "B, provided the session-identity mechanism resolves the
correct session," which today it is not guaranteed to do in the sequence
above. Fixing it is FACTORY-314's own scope, not this survey's; it is
stated here as a precondition, not fixed.

## Per-field classification

Fields enumerated from `DEFINITION_FIELDS` and the `SessionDefinition`
interface, `src/resources/session-definition.ts` (both read at `main` @
`c501b61`, unaffected by PR #513 — that branch touches no field
definitions, only the launch/respawn path) — 17 fields, all covered below.

### `modelPower`, `effort`, `tier` (deprecated) — **B**, on the FACTORY-314 branch only; **C on `main` today**

**Evidence: branch source reading + branch test execution (112/112 pass,
`test/unit/herd.test.ts`), not a fresh live-pane experiment of my own** — the
live-pane proof already exists in FACTORY-314's own ticket history (comment
`25963`: a real throwaway `herdr` pane, marker phrase recalled after a real
`--model`/`--effort` change) and re-running it would not add information
beyond what the epic's own re-verification already established at this same
head (FACTORY-312, comment timestamped 2026-09-27T21:17:58-0700: "I also
re-ran the targeted suite myself at e5e959e: 243 pass/0 fail" — read
directly via `jira_get_issue`, not `jira_search`).

All three resolve through `effectiveAgent()` (`src/resources/session-definition.ts`)
to one `(model, effort?)` pair regardless of which of the two mutually
exclusive shapes (`tier` vs. `modelPower`+`effort`) a definition uses, so
they share one mechanism and one classification. On the FACTORY-314 branch:
`HerdrHerd.staleIssues()` (`src/agents/herd.ts`) compares the persisted
`workspaceModel`/`workspaceEffort` against what the definition/rule
*currently* resolves to (`resolvedAgentOf`, live, never cached); a mismatch
sets `StaleAgent.resumable = true` (Claude only — the *only* push site that
ever sets it). `reconcileNow` (`src/daemon/loop.ts`) tries
`herd.resumeInPlace(spec)` first for any `resumable` stale issue, which
`/exit`s the pane once confirmed idle, waits for a real shell prompt, and
relaunches the **same pane** with `--resume <persisted-id>` plus the new
model/effort and the full flag set — proven (branch: `resumeInPlaceExclusive`,
`src/agents/herd.ts`) to keep the same native session id when it works.

On `main` today: none of `resumeInPlace`, `resumable`, or the
`resolvedAgentOf` staleness comparison exist (confirmed by grep, see top of
this doc) — a model/effort change is caught by a *different*, simpler
comparison that still exists on `main`
(`argv lacks --model/--effort matching...`) and unconditionally falls to
`herd.stop()`+`herd.spawn()`. **C on `main`, no exception.**

Subject to the class-B precondition above.

### `permissionMode` — **undetected/inert as a live edit, not "C, detected via `checkArgv`"**

**CORRECTION (FACTORY-411, live measurement, 2026-09-28) — the original
entry below is WRONG about detection and is kept underneath, unedited, as
history.** It reasoned from `checkManagedAgentArgv`'s own comparison logic
without checking what `staleIssues()` actually feeds it as `expected` for
this field. Read live at `src/agents/herd.ts`: the `permissionMode` used to
build `expected` is `workspacePermissionMode(cwd)` — the value
`buildWorkspace()` persisted to `.butchr-permission-mode.json` at the
agent's own last spawn (or last successful `resumeInPlace`), never a fresh
read of the CURRENT definition. `buildWorkspace()` is the file's *only*
writer (`src/agents/workspace.ts`) and runs *only* at spawn or at
`resumeInPlace()`'s own post-success re-persist — never on an ordinary poll
of an already-running, non-stale agent. So `expected` and the running
process's *real* argv are built from the same frozen snapshot and can never
diverge from a live definition edit alone: `checkArgv` returns `ok: true`
forever, and `staleIssues()` never reports this agent as stale for a
`permissionMode` change, regardless of `resumable`. **Confirmed by direct
observation**, not just by re-reading the code differently: a throwaway
managed-session agent's definition was edited from `permissionMode:
"default"` to `"acceptEdits"` and left running against a healthy,
continuously-polling daemon (`/health` confirmed `pollLoop: ok` throughout)
for 1h45m; `.butchr-permission-mode.json` never changed from `"default"`
and the running process's argv never changed either. Contrast with
`modelPower`/`effort` immediately above, whose comparison uses
`resolvedAgentOf(...)`, a callback re-resolved live every poll from the
CURRENT definition/rule — the live-vs-frozen-snapshot split is the whole
difference. The codebase's own doc comment (`src/daemon/index.ts`, on why
`lizardMode` is read live) independently confirms this is DELIBERATE
FACTORY-43 behaviour, not an oversight: "...deliberately LIVE rather than
persisted-at-spawn the way `permissionMode`/`strictMcpConfig` are."
**Correct classification: undetected/inert, same category as `mcpServers`'
non-channel content below — a class B candidate cannot be built on top of
a `checkArgv` failure that never fires.** See FACTORY-411's own PR for the
full write-up.

--- original entry below, kept as history, NOT to be trusted for detection ---

**Evidence: source reading.** `permissionMode` reaches `agentLaunchConfig`
(`src/agents/argv.ts`) as a real Claude CLI flag (`--permission-mode`),
which is one of `REQUIRED_CLAUDE_FLAGS` compared by `checkManagedAgentArgv`
(`@brooswit/drovr@0.16.3`, the exact version pinned by
`origin/FACTORY-314`'s own `package.json` — confirmed by installing that
branch's dependencies into a dedicated worktree and reading the compiled
source directly, `node_modules/@brooswit/drovr/dist/index.js:8199-8251`:
`REQUIRED_CLAUDE_FLAGS = ["--permission-mode", "--mcp-config",
CLAUDE_DEVELOPMENT_CHANNELS_FLAG]`). A definition's `permissionMode` edit
makes `staleIssues()`'s `checkArgv(expected, proc.argv)` fail with `argv
lacks --permission-mode <new value>` — this is a `checkArgv` failure, which
happens *before* (and independently of) the one `resumable`-setting push
site described above. **`StaleAgent.resumable` is never set for a
`checkArgv` failure, on the FACTORY-314 branch or on `main`** — it falls to
the ordinary `herd.stop()`+`herd.spawn()` fresh path unconditionally, even
on the branch that has `resumeInPlace`.

**The concrete reason a fresh process is unavoidable *today*:** not a
technical limit of native `--resume` (FACTORY-314's own Step 0 test proved
`claude --resume` tolerates a full flag change, model/effort included,
together — this is a *scope* limit of the mechanism as built, not a
`claude` CLI limit) — the `resumable` flag is set at exactly one push site
in `staleIssues()`, and only for the model/effort comparison. Nothing else
routes through it. See Finding 2 below for whether/how this could change.

### `strictMcpConfig` — **undetected/inert as a live edit, not "C, detected via `checkArgv`"**

**CORRECTION (FACTORY-411, live measurement, 2026-09-28) — same correction
as `permissionMode` immediately above, same mechanism.** `expected`'s
`strictMcpConfig` is `workspaceStrictMcpConfig(cwd)`, read back from
`.butchr-strict-mcp-config.json`, written only by `buildWorkspace()` at
spawn/post-resume — never refreshed from a live definition edit on an
ordinary poll. A `strictMcpConfig` edit alone can never make `checkArgv`
fail, so it is never detected as stale, not "C, detected." **Correct
classification: undetected/inert.** See the `permissionMode` correction
above for the full reasoning and the live measurement; not repeated here
to avoid two sources of truth for the same evidence.

--- original entry below, kept as history, NOT to be trusted for detection ---

**Evidence: source reading**, same mechanism as `permissionMode`.
`strictMcpConfig: true` adds `--strict-mcp-config`
(`CLAUDE_STRICT_MCP_FLAG`), also compared directly by
`checkManagedAgentArgv` (drovr source, same lines as above — `if
(expected.includes(CLAUDE_STRICT_MCP_FLAG) && !observed.includes(...))
missing.push(...)`). Same `checkArgv`-failure path, same "no `resumable`
ever set" conclusion, same fresh-restart-always-today reason as
`permissionMode`.

### `mcpServers` — **undetected/inert for a `channel`-flag edit too (for a managed session), not just for everything else**

**CORRECTION (FACTORY-411, live measurement, 2026-09-28), scoped precisely:
this correction applies to a MANAGED-SESSION agent's `channel`-flag edit
specifically (point 1 below) — points 2 and 3's own conclusions ("undetected"
for non-channel content, and the pre-relaunch `mcp.json`-staleness risk)
were already correct and are unchanged.** Point 1 below reasoned from
`checkManagedAgentArgv`'s own comparison logic without checking what
`staleIssues()` feeds it as `expected.mcpServers` for a managed session.
Read live at `src/agents/herd.ts`: for a managed-session agent specifically,
`expected`'s `mcpServers` is `workspaceMcpServers(cwd) ?? []` — read back
from a bookkeeping file `buildWorkspace()` writes only at spawn or at
`resumeInPlace()`'s own post-success re-persist, never refreshed from the
CURRENT definition on an ordinary poll (same shape, same writer function,
same live-measurement method as the `permissionMode` correction above — see
that entry for the 1h45m observation this reasoning is checked against, not
repeated here). A managed-session `channel:true` add/remove therefore can
never make `checkArgv` fail either: `resumable` never gets a chance to
matter because `staleIssues()` never reports this agent as stale for a
`channel`-flag edit in the first place. **A rule-engine agent's
`mcpServers` (via `mcpBindingsOf`, the non-managed-session branch of the
same ternary) is unaffected by this correction — that path already reads
live from the rule, per its own doc comment in `herd.ts`; this correction
is about the managed-session branch only, which is FACTORY-411/FACTORY-424's
entire candidate set.** Correct classification for the managed-session
`channel`-flag case: undetected/inert, same category as point 2's
non-channel content — the whole field is now one category for a managed
session, not split.

--- original entry below, kept as history, NOT to be trusted for detection ---

**Evidence: source reading**, three separate seams inspected:

1. **A `channel: true` entry's presence/absence** feeds
   `boundChannels(spec)` (`src/agents/argv.ts`) into Claude's
   `--dangerously-load-development-channels` flag, which
   `checkManagedAgentArgv` explicitly compares by VALUE SET (drovr source,
   `developmentChannelValues`) — so adding/removing a channel-flagged
   server is caught by `checkArgv`, same as `permissionMode`/
   `strictMcpConfig` above: a `checkArgv` failure, `resumable` never set,
   **C today, on both heads.**
2. **Any other content of `mcpServers`** (a tool-only binding with
   `channel: false`/absent, a URL change, a header-env-var change) reaches
   only `mcp.json` **content** (`buildWorkspace`, `src/agents/workspace.ts`,
   lines ~784-818) — not argv at all. `buildWorkspace()` is called *only*
   from the actual launch path (`spawnExclusive`'s `prepare()` callback,
   and, on the branch, `resumeInPlace()`'s own post-success re-persist) —
   **never on an ordinary poll for an already-running, non-stale agent.**
   `checkArgv` never inspects `mcp.json`'s content, only argv. So this
   class of edit is **not detected as staleness by anything in this
   codebase today** — the live process's `mcp.json` on disk goes stale
   (still has the old bindings) and stays that way indefinitely, until the
   workspace happens to be rebuilt for some *unrelated* reason (any other
   stale reason firing, or a manual restart). This is a genuine gap, not a
   classification of "how fields B/C work" — flagged here because the
   ticket's completeness requirement applies to the *whole* field, not just
   its channel-flag half.
3. Even for a `channel:true` add that *does* get caught (case 1) and, on
   the branch, hypothetically routed through a widened `resumable` (it
   isn't, today — see Finding 2): `resumeInPlace()` builds the relaunch
   argv directly from `spec` via `agentStartParams` (so the channel FLAG
   would be correct), but never calls `buildWorkspace()` to regenerate
   `mcp.json` **before** relaunching — only after a confirmed-alive
   relaunch. So the relaunched process would read the **stale** `mcp.json`
   content on its very first turn even though its argv already claims the
   new channel. Relevant to Finding 2, not to today's classification (which
   stays C either way).

### `lizardMode` — **A**

**Evidence: source reading** (two independent doc-commented seams,
`src/resources/session-definition.ts`'s `lizardMode` field doc comment and
`src/rules/session-definition-type.ts`'s `ManagedSessionResourceDeps.lizardModes`
doc comment, both explicit and detailed, plus confirmed by tracing the
actual read site). `lizardMode` **never reaches `SpawnSpec`, launch argv, or
any persisted-at-spawn file at all.** It is read fresh, every poll, into
`managedSessionLizardModes` (a `Map`, rebuilt from scratch each
`searchSessionDefinitions()` call — `src/daemon/index.ts:1609`), consulted
live by the daemon's separate permission-answer timer
(`src/agents/permission-answer-loop.ts`) to decide whether to
auto-answer a tool-permission dialog on that agent's pane *this tick*.
Toggling it in the manifest changes behavior on the very next
permission-answer poll (~15s), with the agent's process never touched.
Unaffected by the FACTORY-314 branch (that PR does not touch this field or
`session-definition-type.ts` at all — confirmed: `git diff
origin/main...origin/FACTORY-314 --stat` lists no such file).

### `execution` — **A, but inert** (no restart because nothing currently reads it to change behavior)

**Evidence: source reading.** `execution: ExecutionMode` is parsed,
validated, and stored on `SessionDefinition` (reused verbatim from `Rule`),
but the field's own doc comment states plainly: "execution-mode
RECONCILIATION for an individual definition is not implemented by this
ticket... the built-in query itself always runs `swarm`"
(`builtinManagedSessionsRule`, `src/rules/session-definition-type.ts`, fixed
`execution: "swarm"` on the *rule*, never varied per definition). Editing
this field on a live definition changes nothing observable today — not
because it hot-reloads, but because nothing in the daemon consults a
definition's own `execution` value to decide anything at all yet. Included
here for completeness (the ticket's own bar: "a field you silently omitted
is the one that will lose a session later") rather than as a meaningful
"A".

### `account` (the `AccountPolicy`, e.g. `"none"`) — **undetected/inert today; would be C if it were ever detected**

**Evidence: source reading**, `src/agents/account-lifecycle.ts` and
`src/daemon/loop.ts`'s `reconcileNow`. Account provisioning
(`ensure(spec)`) and release (`release(id, reason)`) are called **only** at
the moment an issue is actually spawned or stopped (`plan.spawn`/
`plan.respawn`/`plan.stop` in `reconcileNow`) — never on a per-poll basis
for an issue that is already running and not otherwise stale. `staleIssues()`
recomputes `accountName` fresh every poll (`this.accountNameOf?.(issue)`)
but that value is folded into the *managed-session* `expected` argv
reconstruction only insofar as it affects `mcpIdentityHeaders`/`mcp.json`
content (not argv) via `resolveAccountHeader` — never a CLI flag
`checkArgv` compares. So an `account` policy edit on a live, otherwise-not-stale
agent has **no detectable effect at all**: the account is neither
reprovisioned nor released until the agent is restarted for some *other*
reason. If it ever were wired to trigger a restart, that restart could not
be class B: `resumeInPlace()` (branch) builds its relaunch directly from
`cwd`/`spec`, entirely bypassing `AccountLifecycleHooks.ensure()` (it isn't
called anywhere in `resumeInPlaceExclusive`) — provisioning a *different*
account for an in-place resume was never built and isn't a mechanical
extension (see Finding 4). **C, if/when this gap is ever closed; today,
neither.**

### `role` — **A**

**Evidence: source reading**, `src/rules/session-definition-type.ts`
(`ManagedSessionResourceDeps.roles`, `discovery.search`'s fill site) and
`src/daemon/index.ts` (`managedSessionRoles` map, `roleOfAgent`'s
consultation of it). Rebuilt from scratch every poll from that poll's
eligible matches; consulted only by the fleet-capacity admission classifier
(`roleOfAgent`) to decide whether an agent counts against `config.maxAgents`.
Never reaches argv, never persisted at spawn, no restart concept involved
at all — a `role` edit changes admission-accounting on the very next poll.

### `frozen` — **not a restart at all; a stop (true) or a fresh spawn from cold (false)**

**Evidence: source reading**, `src/rules/session-definition-type.ts`
(`searchSessionDefinitions` excludes a `frozen: true` definition from the
eligible set entirely) and `src/resources/session-freeze.ts`'s own doc
comment (`reconcileNow` "drops a frozen id from `desired` before BOTH its
spawn and its stop decision, unconditionally"). Setting `frozen: true` on a
running agent's definition removes it from `desired` on the next poll —
`reconcileNow` calls `herd.stop()` with **no replacement spawned**: this
isn't "the process restarts," it's "the process is stopped and stays
stopped." Setting it back to `false` makes the definition eligible again;
the next poll's ordinary `plan.spawn` path launches it **fresh** — there is
no live process to resume from (it's been stopped), so this is necessarily
class C when it happens, for the same reason any cold-start is C: nothing
to `--resume` against. Not applicable to Finding 2 (there is no "resume
while frozen" scenario to generalize into).

### `mcpServers` — see above (split field)

### `freezeControllers` — **A**

**Evidence: source reading**, `docs/managed-sessions.md`'s own "Two freeze
gates" section (lines ~406-433, cited in full because it states the poll
cadence explicitly) and `src/tools/session-freeze-tools.ts`'s authorization
check (which reads the CURRENT manifest's `freezeControllers`/
`unfreezeControllers` at MCP-tool-call time, not a persisted/cached copy).
Grant changes take effect "within one poll (`MANAGED_SESSIONS_POLL_MS` =
15s)" per that doc's own text, with **no CLI verb to change a grant** other
than editing the manifest directly — the daemon's own poll is *the*
mechanism, and it never touches the granted-or-grantee agent's process at
all. No restart, no argv, no persisted state.

### `unfreezeControllers` — **A**

Same mechanism and evidence as `freezeControllers` immediately above — a
deliberately separate list (per that field's own doc comment: freezing and
unfreezing are independent grants), identical live/no-restart behavior.

### `linkedEventingProjects` — **A**

**Evidence: source reading**, `src/rules/session-definition-type.ts`'s
`createManagedSessionResourceType`. `sessionDefinitionProjectMatches(m)` is
re-derived from `latest` (this poll's fresh matches) on every single poll's
`discovery.related()` call — no caching across polls, no persisted state,
no argv, no process interaction of any kind. Adding/removing a project ref
changes which Jira projects get linked-eventing watches on the very next
poll.

### `workingDirectory` — **A, but daemon-enforced only as a notice, not as an automatic apply**

**Evidence: source reading**, three seams: `SpawnSpec.cwd`'s own extensive
doc comment (`src/agents/workspace.ts`, PR #394 review round 3 — the
process's OS-level cwd is **always** `workspaceDirFor(issue)`, *never*
`spec.cwd`, for two independent, load-bearing reasons documented there:
`ManagedHerdrLifecycle` hard-requires a fixed `cwd` per pane, and
`runningIssues()`'s reverse-mapping assumes the fixed `workspaceDirFor`
shape); `kickoffFor()` (`src/agents/argv.ts`), which embeds `spec.cwd` into
the **one-time kickoff prompt only** ("cd there before doing anything
else"), never resent; and `checkManagedAgentArgv`'s comparison list
(above), which never includes the kickoff positional at all — confirmed
directly in the drovr source (`REQUIRED_CLAUDE_FLAGS` has no prompt/
positional entry) and independently confirmed by `staleIssues()`'s own
`expected` reconstruction, which builds its comparison spec with **no
`brief`/`cwd` at all** (`{key: issue, issuetype: "task", summary: "", ...}`
— neither field is set, so `kickoffFor` inside that reconstruction falls
straight through to the generic string, and the comparison never depends on
`workingDirectory` either way). So: a `workingDirectory` edit is **never**
seen by `checkArgv`, so it never forces a restart — genuinely A. But it is
also never *pushed* to the running agent by the daemon: the process's own
OS cwd was never there to begin with, and the one place the agent ever
learned the intended directory was its own now-long-past kickoff turn. The
definition-file's content diff IS detected (`createSessionDefinitionEventRules`'s
`observed()`, `[resource.size, resource.mtimeMs]`) and does trigger a
generic nudge into the pane (`deliver`/`notifyAgent`+`herd.nudge`,
`src/daemon/index.ts:1612-1616`) — but that nudge is a generic "this
changed" notice (`changeNudge`, `src/agents/change-nudge.ts`), not an
instruction naming the new directory; the running agent has to notice and
re-read its own definition file to act on it. No restart either way — A,
with that caveat stated plainly rather than implied.

### `brief` — **A, same caveat as `workingDirectory`**

**Evidence: source reading**, same three seams. `spec.brief` is written
once to `brief.md` at spawn/build time (`buildWorkspace`,
`src/agents/workspace.ts` line ~783) and otherwise only reaches the agent
through the one-time kickoff prompt (`kickoffFor`) exactly as
`workingDirectory` does, with the identical "not part of `checkArgv`'s
comparison, not resent automatically" evidence. A `brief` edit is A (never
forces a restart) with the same "detected only as a generic nudge, not
automatically applied" caveat.

### `vendor` — **undetected today; necessarily C whenever it eventually is**

**Evidence: source reading.** This is the most surprising finding in this
survey, stated carefully because it's a structural property, not a bug in
one branch: `staleIssues()` (`src/agents/herd.ts`) determines the
"expected" argv for comparison using `providerOfPane(pane)` — **the
REAL, currently-observed provider running in that pane** — never the
definition's own current `vendor` value. So the comparison is, by
construction, "does this pane's argv match what a launch of *its own
observed* provider would look like" — it can never detect "the definition
now wants a *different* provider than what's actually running," because it
never asks that question. Grepped for any other seam that might catch it
(`grep -n "vendor" src/agents/herd.ts src/daemon/loop.ts`: zero matches in
either file) and found none. So editing `vendor` on a live managed-session
agent's definition has **no observable effect at all** while that agent
keeps running — it silently continues under the *original* vendor
indefinitely, until stopped for an unrelated reason, at which point the
*next* spawn (an ordinary fresh spawn, reading the *then-current*
definition) picks up the new vendor. When that eventually happens, it is
necessarily class C: Claude's `--resume` and Codex have no shared or
cross-compatible session concept — no mechanism in this codebase (or, so
far as this survey found, in `@brooswit/drovr`) resumes a Codex
conversation as a Claude one or vice versa, so a genuine vendor switch can
never be anything but a cold start once it does take effect.

## Required finding 2: can FACTORY-314's mechanism generalize to the class-B fields as-is?

**No — it needs changing, in four concrete ways, and it only ever
generalizes within the Claude provider.** (There is currently exactly one
class-B *group* — `modelPower`/`effort`/`tier` — so "the class-B fields"
here means the fields identified above as *candidates* for B if the
mechanism were extended: `permissionMode`, `strictMcpConfig`, and the
`channel` half of `mcpServers`.)

1. **Fix the invalidation gap first (the precondition section above).**
   This is the most load-bearing point: every additional field routed
   through `resumeInPlace()` inherits the same session-identity trust
   problem. Generalizing the *set of reasons* that can trigger a resume
   without first fixing *whether a resume resumes the right conversation*
   multiplies the blast radius of a defect that already exists for exactly
   one field group today.
2. **Fix the pre-relaunch ordering for anything that changes file content,
   not just argv.** `resumeInPlace()` (branch) calls `buildWorkspace()`
   only *after* a confirmed-alive relaunch, to persist the new
   model/effort for the *next* comparison — it never regenerates
   `mcp.json`/other workspace files *before* the relaunch. For
   `permissionMode`/`strictMcpConfig` this happens to be harmless (they are
   pure CLI flags read straight from `spec` by `agentStartParams`, no file
   content involved). For `mcpServers`, it is not: the channel flag would
   be correct on relaunch (also straight from `spec`), but the relaunched
   process would still read the **stale** `mcp.json` on its very first
   turn, since that file is only rewritten *after* the relaunch already
   started. A field that changes file content needs `buildWorkspace()`
   moved before the relaunch attempt for that field's class-B path to be
   honest.
3. **Widen `StaleAgent.resumable` deliberately, not blanket.** Today,
   `resumable` is set at exactly one push site, after `checkArgv` has
   already passed. Generalizing means some `checkArgv` failures (a
   `permissionMode`/`strictMcpConfig`/`mcpServers`-channel mismatch) need
   to become resumable while others (Codex MCP isolation-inventory
   staleness, any future flag that turns out not to be resume-safe) must
   not. That is a deliberate per-reason classification inside
   `staleIssues()`, not a one-line change — and it needs its own Step-0-style
   verification per flag (the same rigor FACTORY-314 applied to
   model/effort: does `claude --resume` really tolerate *this* flag
   changing together with `--resume`? The full-flag-set case was tested;
   individual flags changing in combination with every other flag were
   not exhaustively tested).
4. **The mechanism is Claude-only by construction, and there is no
   evidence it extends to Codex.** `resumeInPlace()`'s `providerOfPane(...)
   !== "claude"` check returns `"unresumable"` unconditionally for any other
   provider; `agentStartParams`'s `--resume` append is gated on `agent.provider
   === "claude"`. No `--resume`-equivalent for Codex was tested anywhere in
   FACTORY-314's own comment history (its Step 0 test was Claude-only). So
   even a fully generalized version of this mechanism would only ever move
   Claude-vendor definitions' `permissionMode`/`strictMcpConfig`/`mcpServers`
   fields toward B — a Codex definition's equivalent fields stay C
   regardless of any of this work, until/unless a Codex-side resume
   primitive is found and verified the same way.

`account` and `vendor` are **not** candidates for this generalization at
all in their current form — see their own rows above: neither is even
*detected* as stale today, so there is no staleness event for
`resumeInPlace()` to intercept. Making them resumable would first require
building the detection this survey found missing, which is a different
piece of work than extending `resumeInPlace()` to more `checkArgv` reasons.

## Required finding 3: which fields are class A?

Genuinely no restart, ever, for this field alone: **`lizardMode`,
`execution`** (inert rather than meaningfully hot-reloaded — see its own
row), **`role`, `freezeControllers`, `unfreezeControllers`,
`linkedEventingProjects`, `workingDirectory`, `brief`** (the last two with
the stated "detected only as a generic nudge, not automatically applied"
caveat).

That is **8 of 17 fields** — the honest answer here is not "none," but it
is also not "every field behaves like a true, actively-applied hot-reload":
two of the eight (`workingDirectory`, `brief`) are A only in the narrow
sense that they never force a restart; a live agent does not actually
*receive* the new value without noticing a generic nudge and re-reading its
own definition file itself, which the daemon does not verify happens. One
more (`execution`) is A only because nothing reads the field yet, not
because a live update mechanism exists. Genuinely, unconditionally
"applied live, no restart, no caveat" is a five-field subset: `lizardMode`,
`role`, `freezeControllers`, `unfreezeControllers`, `linkedEventingProjects`.

## Required finding 4: ordering/risk note for generalizing class B

Cheapest and lowest-risk first, based on how much of Finding 2's four gaps
each one actually needs closed:

1. **`permissionMode` — cheap.** Pure CLI flag, straight from `spec`, no
   file-content dependency (point 2 doesn't apply), no external side
   effect. Needs only points 1 and 3.
2. **`strictMcpConfig` — cheap, same reasons as `permissionMode`.** It
   toggles a flag that changes how Claude reads the *existing* `mcp.json`,
   not the file's content itself — no pre-relaunch rebuild needed. Needs
   only points 1 and 3.
3. **`mcpServers` (the `channel` flag itself) — medium.** The argv half
   (which channels are bound) is cheap like the two above; the **content**
   half (does the relaunched process actually have the new/changed tool
   binding available before its first post-resume turn) needs point 2 done
   properly, so this field can't be called cheap as a whole even though
   its detection story is the same shape as 1 and 2.
4. **`mcpServers` (non-channel content) — higher effort.** Needs a NEW
   staleness detector built first (there is none today — see that field's
   own row), plus point 2. Not a "generalize the existing reason," a
   genuinely new comparison.
5. **`account` — high risk, do this last if at all as part of this
   mechanism.** Provisioning/release is an external side effect (a real
   Rocket.Chat account, token rotation via Nexus) with its own async,
   retryable, ordering-sensitive lifecycle (`AccountLifecycleHooks`,
   `src/agents/account-lifecycle.ts`) that `resumeInPlace()` does not touch
   at all today. Folding account changes into an in-place resume risks
   either leaking a provisioned account (no release path exists in that
   method) or racing the existing retry-queue discipline `reconcileNow`
   already depends on. This needs its own design pass, not a mechanical
   extension of points 1-3, and detection would need to be built from
   scratch (see that field's own row).
6. **`vendor` — not generalizable to B at all; the real follow-on work is
   detection, not resumability**, and is orthogonal to everything above.
   Whatever gets built, a vendor switch is always class C when it takes
   effect (no cross-provider resume concept exists anywhere this survey
   found) — the only thing worth fixing here is that it currently is not
   even *detected*, which is a `staleIssues()` gap unrelated to
   `resumeInPlace()`.
7. **`workingDirectory`/`brief` — a different mechanism, not an extension
   of `resumeInPlace()` at all.** These never force a restart today and
   don't need to; what they lack is a *content-push* (send the agent an
   instruction naming what changed, not just a generic "something
   changed" nudge) — more naturally an improvement to
   `change-nudge.ts`/`deliver` than anything touching
   `herd.resumeInPlace()`. Out of scope for "generalize the resume
   mechanism," in scope for FACTORY-394's broader "hot-reload" framing.
8. **`frozen` — not applicable.** No sensible "resume while freezing/
   unfreezing" interpretation exists; freezing is a stop, unfreezing is a
   cold start, by design.

## Summary table

| field | class (branch @ `e5e959e`) | class (`main` @ `c501b61`) | evidence |
|---|---|---|---|
| `modelPower` | B, subject to the precondition | C | branch source + branch test execution (112/112) |
| `effort` | B, subject to the precondition | C | branch source + branch test execution (112/112) |
| `tier` (deprecated) | B, subject to the precondition | C | branch source + branch test execution (112/112) |
| `permissionMode` | **undetected/inert (CORRECTED, was "C" — see entry)** | **undetected/inert (CORRECTED, was "C" — see entry)** | FACTORY-411 live measurement (1h45m observed), supersedes original source reading |
| `strictMcpConfig` | **undetected/inert (CORRECTED, was "C" — see entry)** | **undetected/inert (CORRECTED, was "C" — see entry)** | FACTORY-411 live measurement, same mechanism as `permissionMode`, supersedes original source reading |
| `mcpServers` (`channel` flag, managed session) | **undetected/inert (CORRECTED, was "C" — see entry)** | **undetected/inert (CORRECTED, was "C" — see entry)** | FACTORY-411 live measurement, supersedes original source reading — rule-engine `mcpServers` (non-managed-session) unaffected |
| `mcpServers` (other content) | undetected/inert | undetected/inert | source reading (`buildWorkspace` call sites) |
| `lizardMode` | A | A | source reading (doc comments + read site) |
| `execution` | A (inert) | A (inert) | source reading (unread field) |
| `account` | undetected/inert (would be C) | undetected/inert (would be C) | source reading (`account-lifecycle.ts`) |
| `role` | A | A | source reading (`roleOfAgent` map) |
| `frozen` | stop (true) / fresh spawn (false), not "a restart" | same | source reading (`session-freeze.ts`, `reconcileNow`) |
| `freezeControllers` | A | A | source reading (`docs/managed-sessions.md`, tool auth check) |
| `unfreezeControllers` | A | A | source reading (same as above) |
| `linkedEventingProjects` | A | A | source reading (`related()`, re-derived every poll) |
| `workingDirectory` | A, nudge-only | A, nudge-only | source reading (`SpawnSpec.cwd`, `kickoffFor`, `checkArgv`) |
| `brief` | A, nudge-only | A, nudge-only | source reading (same seams as above) |
| `vendor` | undetected (would be C) | undetected (would be C) | source reading (`staleIssues()`'s self-referential provider comparison) |
