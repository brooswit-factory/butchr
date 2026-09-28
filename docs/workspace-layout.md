# Workspace directory layout, lossless key resolution, and the memory-slug migration (FACTORY-118, implementing FACTORY-91, epic FACTORY-83)

`docs/execution-modes.md`'s "Workspace DIRECTORY layout" section is the
short pointer into this document from the file most people read first. This
document is the full story: the hazard, the design decisions this ticket had
to make, the empirical verification of Claude Code's own slug algorithm, the
required Servy proof (with its negative control), the callers updated, and
the operator deploy runbook.

## The hazard

Claude Code keys each agent's memory and transcripts on its cwd:
`~/.claude/projects/<slug-of-cwd>`, where the slug is (empirically confirmed
below) every non-alphanumeric character of the RESOLVED absolute path
replaced with `-`. Renaming a workspace directory changes that slug. No
migration or symlink logic existed anywhere in this codebase before this
ticket — a plain `mv` of a workspace directory silently cuts the agent off
from every prior conversation the next time it resumes, with no error and no
warning.

FACTORY-90 (merged) gave every resource provider a short display id and
applied it to the herdr workspace **label** only — free text, never
load-bearing. This ticket applies the SAME short id to the on-disk
**directory** leaf, which IS load-bearing for the reasons above, so simply
reusing FACTORY-90's naming was not enough; four additional hazards
(Addenda A1-A6 below) had to be closed first.

## Design decisions (the Addendum, restated with reasoning)

**A1 — the leaf is the provider's short id alone.** `baseDisplayLabel`
combines a short id with the rule id for a herdr LABEL
(`"<shortId> · <ruleId>"`), but a workspace path already carries the rule id
as its own directory segment (`<provider>/<ruleId>/<leaf>`) — appending it
into the leaf too would duplicate it. Only the leaf changes; the three-level
shape is unchanged, which is what lets a caller tell an old-layout directory
apart from a new one by DEPTH matching being irrelevant (both are
three-deep) and CONTENT of the leaf mattering instead.
`jira-work`/`jira-idea`/`jira-project` have identity short ids (the short id
already equals the resource id), so those three providers see **no
directory change and no filesystem write at all** — verified by
`workspace-migration.test.ts`'s own dedicated test and by this ticket's own
dry run against this daemon's real fleet (see "Proof on Servy" below: 227 of
227 real workspaces here already report `no-change`, meaning production
traffic on this host is presently 100% jira-work).

**A2 — a short id is not guaranteed to be a safe path segment.** Short ids
are free text: `filesystemShortDisplayId` returns the whole resourceId
verbatim for a path with no non-empty segments (e.g. `/`); GitHub/Zendesk
fall back to the raw resourceId when a ref fails to parse (which can contain
`/`); the managed-session id strips `.json` from a filename, so a
degenerate name like `.json` alone could come out empty. `isValidLeaf`
(`src/agents/workspace.ts`) is the one gate every candidate leaf passes
through: empty, `.`, `..`, containing `/` or NUL, or over
`MAX_ENCODED_SEGMENT_BYTES` all fail it and fall back to the legacy
percent-encoded leaf instead — never a leaf that could make `join()` return
the rule directory itself or escape it. `:`, `#`, spaces and non-ASCII are
all valid single-path-segment bytes and are left alone. Tested with hostile
short ids (empty, `.`, `..`, `/`, `a/b`, NUL, over-long, non-ASCII) proving
the resulting directory is always strictly inside `<root>/<provider>/<ruleId>/`.

**A3 — names are sticky, chosen once, never recompute-and-rename.**
`resolveDisplayLabels`'s bare-vs-suffixed tie-break depends on which OTHER
keys currently exist, so a herdr LABEL can legitimately change over time —
fine for disposable text, not for a directory holding memory, transcripts
and git worktrees. `newLayoutDirFor` therefore never reuses that tie-break:
a leaf is chosen once, at first claim (`ensureWorkspaceDir`) or at one-time
legacy migration, and the choice is authoritative from then on via the
bookkeeping stamp (A6) — removing some OTHER colliding resource later never
triggers a rename.

**A4 — Claude Code's own slug is lossy, so two different DIRECTORIES can
share one memory slug even when their directory names differ** (every
non-alphanumeric character becomes the same `-`): `a:b` and `a-b`, `x#1` and
`x-1`. `newLayoutDirFor`'s `slugCollides` check treats "same slug as any
other known workspace directory under this root" as a collision needing the
same deterministic suffix A3 uses, with its own test. old-slug==new-slug and
old-dir==new-dir are both clean no-op successes, never errors.

**A5 — never rename under a live agent.** See "Renaming a live workspace"
below for the empirical evidence this is actually safe when the OTHER half
(migrating the CLAUDE MEMORY SLUG) waits for the agent to no longer be live
at the old path; the fleet-stability tests (`test/unit/herd.test.ts`,
`test/unit/missing-rules-preflight.test.ts`) prove a mixed fleet of
old-layout and new-layout agents is recognised identically, stably, across
repeated polls — the FACTORY-47/FACTORY-75 class of bug (an infinite
stop/respawn loop from a decode mismatch), in a new place.

**A6 — an in-directory bookkeeping record is a hint, never an authority.**
An agent (or a stray `git clean`/`rm`) can edit or copy `.butchr-agent-key.json`.
`agentIdOfWorkspacePath` accepts a recorded key only when the directory's
OWN location is one of that key's legitimate leaf forms (bare short id, that
short id's own collision suffix, or the legacy encoded leaf) — anything else
is "unrecognised", never "belongs to another key", and never a duplicate
spawn.

## Callers updated

Every real code-level caller of `agentIdOfWorkspacePath` /
`ruleAgentIdOfWorkspacePath` / `workspaceDirFor` on this branch (verify
yourself — a caller set drifts as the codebase does):
`src/agents/herd.ts`, `src/agents/reap.ts`, `src/agents/residency-census.ts`,
`src/agents/resource-connections.ts`, `src/daemon/index.ts`,
`src/daemon/legacy-preflight.ts`, `src/daemon/missing-rules-preflight.ts`,
`src/tools/relationship.ts` — plus one this ticket's own caller-list audit
initially missed: **`src/mcp/workspace.ts`'s `bridgeWorkspace`**, which had
its own hand-rolled segment-decode (`segments.join(":")`) completely
bypassing `agentIdOfWorkspacePath`. A short-leaf workspace's AGY-bridged MCP
connection would have been rejected as "Not a factory workspace" — found by
this ticket's own test suite (a pre-existing zendesk MCP identity test
started failing once its workspace used a real short leaf) and fixed to
delegate to the shared resolver, a strict superset of the old behavior.
`src/agents/permission-answer-loop.ts` gets its own pane-to-agent resolution
injected as `eligiblePanes` from `daemon/index.ts`, so it is covered through
that file rather than calling either function itself.
`src/accounts/manager.ts` keeps Rocket.Chat token files in a daemon-owned
`tokenDir` "never inside any agent's own workspace directory" (its own doc
comment), keyed by agent key rather than by path — confirmed no migration
needed there.

## Empirical slug verification

`claudeProjectSlug` (`src/agents/workspace.ts`):

```ts
export function claudeProjectSlug(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}
```

Verified two ways: against `@brooswit/drovr`'s own independent
reimplementation (`src/native-transcript.ts`, the identical formula at both
its own call sites), and — more importantly — empirically against the real
`claude` CLI on this host (Servy), which is what actually matters. Four real
sessions were started under real `claude -p` invocations at hand-built
directories and their resulting `~/.claude/projects/<slug>` names compared
against the formula above:

| input path shape | naive formula matches real Claude Code? |
|---|---|
| dots, underscore, `%`, `~` (e.g. `.../a.dots_under%score~tilde`) | YES, exact match |
| non-ASCII / multi-byte Unicode (e.g. `.../b-unicode-café-日本語`) | YES, exact match |
| resolved path ≤ 200 chars | YES, exact match (both cases above) |
| resolved path > 200 chars | **NO** — see below |

**The over-200-character case, in detail.** Two real sessions were started
at hand-built paths whose naive slug came out to 356 characters. Real Claude
Code's actual directory name in both cases was:

```
<naive-slug's first 200 characters><-><6-character suffix>
```

e.g. `...-scratchpad-slugtest-cxxx...xxx` (200 chars) `-rv9rp9`, and a
second, independently-built long path producing `...-htx70k`. The 6-character
suffix does **not** match the first 6 hex characters of an md5, sha1, or
sha256 digest of either the raw resolved path or the naive slug string
itself — checked directly, all six combinations negative. Real Claude Code's
suffix algorithm for an over-length path is therefore **not reproducible by
this codebase**, and `claudeProjectSlug` does not try to. Two consequences,
both implemented and tested:

- **Finding an EXISTING over-length slug directory** (the OLD side of a
  migration, which may already exist from a real prior session):
  `findClaudeProjectDir` (`src/agents/workspace-migration.ts`) falls back to
  a PREFIX match — any real directory under `~/.claude/projects` whose name
  starts with the naive slug's first 200 characters followed by `-` is
  treated as the same project. Proven against the real, live example above
  during the Servy proof (see below): the migration located and moved the
  real truncated+suffixed directory correctly, on the first try, with no
  manual intervention.
- **Computing a NEW over-length slug directory** (the destination side of a
  migration) **cannot** be done correctly — there is no way to reproduce a
  suffix this codebase has never been able to derive. `migrateClaudeProjectSlug`
  therefore REFUSES loudly (throws, naming both paths) rather than silently
  writing the transcript into a directory Claude Code will never read from
  again. This is not a hypothetical: an early version of this migration
  computed the naive (untruncated) name for the new side unconditionally,
  and a live Servy run below caught it doing exactly that — the transcript
  physically moved, but `claude --continue` at the new cwd started a fresh,
  empty conversation, because real Claude Code was looking for its own
  truncated+hashed name instead. Fixed before this ticket shipped; the
  regression test (`test/unit/workspace-migration.test.ts`, "refuses...
  when the NEW cwd's own naive slug exceeds the truncation length") pins it
  permanently. In practice this is a low-probability edge for a NEW
  short-leaf path — the whole point of this ticket is shortening leaves, and
  a production `workspaceRoot()` is a short, fixed prefix — but it remains a
  real, tested limitation worth knowing about rather than silently ignoring.

## Renaming a live workspace

POSIX `rename(2)` on a directory a live process has as its cwd does not
disturb that process — its OWN open file descriptors and its OS-level
notion of "current directory" are unaffected by the directory's name
changing elsewhere in the tree. A Claude Code session with an already-open
transcript file descriptor keeps writing through it by inode, not by path,
so an in-flight session's own writes are unaffected by moving
`~/.claude/projects/<old-slug>` out from under it. Only a LATER
`--resume`/`--continue` invocation, which re-derives the slug from its cwd
at that later moment, needs the slug to have already moved by then — which
is exactly why Addendum A5's rule (never rename while a live agent still has
the OLD path as its cwd) is the right safety margin: it is not that renaming
mid-session is unsafe for the CURRENT session, it is that the slug move must
land before the NEXT resume, and the simplest way to guarantee that
ordering is to do both halves only once the agent is no longer live at the
old path.

## Proof on Servy (required; performed, not merely asserted)

Using this daemon's own real `claude` CLI on Servy, under a scratch root
(never any real workspace, never any other agent's live pane):

1. **Setup.** A real `filesystem`-provider agent key
   (`filesystem:servyproof:%2Ftmp%2Ffactory118-proof%2Fsession-definitions%2Fadmin-assembly.json`)
   was hand-built at its pre-migration old-layout directory under
   `/tmp/factory118-proof/root` (never through `ensureWorkspaceDir`, which
   always computes the NEW short leaf — this is what a genuinely
   not-yet-migrated real workspace looks like on disk).
2. **A real session, a real codeword.**
   ```
   $ cd /tmp/factory118-proof/root/filesystem/servyproof/%2Ftmp%2Ffactory118-proof%2Fsession-definitions%2Fadmin-assembly.json
   $ claude -p "Remember this exact codeword for later: PLATYPUS-MERIDIAN-4471. Just acknowledge you've stored it, one sentence." --dangerously-skip-permissions
   Stored — the codeword is PLATYPUS-MERIDIAN-4471.
   ```
   Confirmed on disk: `~/.claude/projects/-tmp-factory118-proof-root-filesystem-servyproof--2Ftmp-2Ffactory118-proof-2Fsession-definitions-2Fadmin-assembly-json/f2483cda-....jsonl` contains `PLATYPUS-MERIDIAN-4471` (grepped directly).
3. **Negative control, performed FIRST, on an independent copy of the tree**
   (never touching the real proof directory): a plain `mv` of the directory
   to its new short-leaf name, with NO slug migration.
   ```
   $ claude --continue -p "What was the exact codeword I told you to remember earlier? Reply with just the codeword."
   You didn't tell me a codeword — this is the first message in our
   conversation, and I have no earlier context from you.
   ```
   Confirms the hazard is real, and that the proof below actually
   distinguishes "migrated" from "not migrated" rather than trivially
   succeeding either way. Cleaned up immediately after.
4. **The real forward migration**, via the actual `migrateWorkspaceLayout`
   function (not a hand-rolled `mv`):
   ```
   migrateWorkspaceLayout("filesystem:servyproof:%2Ftmp%2Ffactory118-proof%2Fsession-definitions%2Fadmin-assembly.json", "/tmp/factory118-proof/root")
   => {
     outcome: "migrated",
     oldDir: ".../filesystem/servyproof/%2Ftmp%2Ffactory118-proof%2Fsession-definitions%2Fadmin-assembly.json",
     newDir: ".../filesystem/servyproof/session-definitions:admin-assembly.json",
     slug: {
       outcome: "moved",
       oldSlugDir: "~/.claude/projects/-tmp-factory118-proof-root-filesystem-servyproof--2Ftmp-2Ffactory118-proof-2Fsession-definitions-2Fadmin-assembly-json",
       newSlugDir: "~/.claude/projects/-tmp-factory118-proof-root-filesystem-servyproof-session-definitions-admin-assembly-json",
     },
     repairedWorktrees: [],
   }
   ```
5. **Resume at the NEW cwd — full memory continuity:**
   ```
   $ cd /tmp/factory118-proof/root/filesystem/servyproof/session-definitions:admin-assembly.json
   $ claude --continue -p "What was the exact codeword I told you to remember earlier? Reply with just the codeword."
   PLATYPUS-MERIDIAN-4471
   ```
6. **The reverse migration**, via `reverseMigrateWorkspaceLayout`, restoring
   the exact old directory and old slug — and the round trip confirmed the
   same way:
   ```
   $ cd /tmp/factory118-proof/root/filesystem/servyproof/%2Ftmp%2Ffactory118-proof%2Fsession-definitions%2Fadmin-assembly.json
   $ claude --continue -p "What was the exact codeword I told you to remember earlier? Reply with just the codeword."
   PLATYPUS-MERIDIAN-4471
   ```
   The restored old-layout directory's bookkeeping stamp was confirmed
   removed (`ls -la` showed only `.`/`..` — the reversal's own documented
   requirement, since `workspaceDirFor`'s "not yet migrated" branch
   recognises an old-layout directory specifically by the ABSENCE of that
   stamp).
7. **Cleanup.** All scratch directories under `/tmp/factory118-proof*` and
   their corresponding `~/.claude/projects/*` entries were removed after the
   proof. Nothing under this daemon's real `~/butchr-workspaces` or any
   other agent's pane was touched at any point.

This same proof run is also what caught the over-200-character slug-move
bug described above: an earlier attempt used a scratch root nested deep
enough under this session's own `/tmp/claude-*` scratchpad path that the
resulting slug crossed the 200-character truncation threshold, and the
"resume" step above returned a fresh, empty conversation instead of the
codeword — the fix (refuse rather than guess, described above) was made and
verified before the successful run transcribed above.

## The `/proc` cwd empirical finding (herdr's own tracked cwd)

Not yet independently re-verified on THIS run — Addendum A0's own directive
to trust each read over a stale one applies here too: verify empirically on
your own daemon (`readlink /proc/<pid>/cwd` on a live agent's PID before and
after a real `migrateWorkspaceLayout` call) before relying on this section
if it matters for your own work. What the migration functions themselves
assume, and what a real `rename(2)` guarantees at the OS level regardless of
this codebase: a running process's `/proc/<pid>/cwd` symlink follows a
directory rename transparently (the kernel resolves it by inode, same
mechanism as the open-file-descriptor argument above) — herdr, which reports
a pane's `cwd` by reading this same symlink, would therefore report the NEW
path immediately after a rename with no restart needed. This is a property
of `rename(2)` and `/proc`, not of anything butchr does — cited here for
completeness, not as a claim unique to this ticket's own testing.

## Other path-keyed state investigated

- **`~/.claude.json`** (Claude Code's own per-project trust/tool-approval
  state, one entry per project keyed by absolute path, in ONE file shared by
  every Claude Code session on the host): `migrateClaudeSettingsEntry`
  exists, is idempotent/reversible/non-overwriting like the directory and
  slug halves, and is covered by its own tests — but is deliberately NOT
  called automatically by `migrateWorkspaceLayout`. Reasoning: unlike the
  slug directory (dedicated to one cwd, nothing else ever writes there),
  this file is read-modify-written by EVERY session on the host, so an
  automatic move on every migration has a real, if narrow, chance of losing
  a different session's own concurrent settings flush. What is lost if an
  operator never runs this step is real but recoverable UX friction (Claude
  Code re-asks its ordinary startup trust dialog and first-use
  tool-permission prompts once at the new path — both already auto-answered
  for a supervised agent by this codebase's own `chooseStartupAnswer` and
  lizard-mode permission loop), never silent data loss. Opt-in via
  `scripts/migrate-workspace-layout.ts --include-claude-settings`, run at a
  quiet moment for the whole host (see the runbook below).
- **Rocket.Chat account state** (`src/accounts/manager.ts`): token files
  live in a daemon-owned `tokenDir`, explicitly "never inside any agent's
  own workspace directory" (that module's own doc comment), keyed by agent
  key rather than by path. No migration needed.
- **herdr's own tracked pane/workspace cwd**: see the `/proc` section above.
- **`~/.claude/todos`, shell snapshots, `statsig`-style state**: not
  path-keyed by this workspace's directory name in any way this
  investigation found reason to touch — Claude Code's own per-session state
  beyond the project slug directory itself, out of this ticket's scope.
- **MCP config referencing absolute workspace paths** (`mcp.json`,
  `--mcp-config` paths): these files live INSIDE the workspace directory
  itself and travel for free with the atomic rename, exactly like
  `CLAUDE.md`/`brief.md`/`.butchr-*.json` — verified by
  `workspace-migration.test.ts`'s own `populate()` helper, which writes all
  of these into a fixture directory and asserts every one survives a
  migration byte-for-byte.
- **Git worktrees** inside a migrated directory: `repairGitWorktrees`
  (`git worktree repair`, run from the NEW location) fixes both the
  worktree's own `.git` file and the canonical clone's back-reference —
  covered by its own test ("an atomic directory rename breaks a worktree's
  absolute-path back-references; migrateWorkspaceLayout repairs them").

## FACTORY-41 (Backlog, not started, not a blocker)

FACTORY-41 proposes a `cwd:` field in managed-session definitions so an
agent launches in a configured directory instead of Butchr's own bookkeeping
directory. If implemented, such an agent's Claude Code slug would depend on
its OWN configured directory's name — stable, independent of Butchr's
bookkeeping-directory naming — and this ticket's whole migration would
simply not apply to it going forward. Not implemented here; noted for the
record per this ticket's own requirement.

## Operator deploy runbook

See `scripts/migrate-workspace-layout.ts`'s own header comment for the
full step-by-step (kept there, next to the tool, so it cannot drift out of
sync with what the script actually does). Summary:

1. Deploy the new build. Nothing migrates automatically — an unmigrated
   workspace stays fully recognised at its old path indefinitely.
2. `bun run scripts/migrate-workspace-layout.ts` (dry run) — review the
   printed plan.
3. `bun run scripts/migrate-workspace-layout.ts --execute` — migrates every
   safe-to-migrate line; anything with a live agent is skipped this round
   (Addendum A5), not treated as an error.
4. Re-run step 3 later to pick up anything skipped as live once those
   agents have since stopped or restarted — no time limit, no urgency.
5. `--include-claude-settings` only at a quiet moment for the whole host,
   per the narrow shared-file race described above.

**Rollback**, if ever needed: `reverseMigrateWorkspaceLayout` is the exact
inverse and is exercised by the round-trip test and the live Servy proof
above — the same idempotent/reversible/never-overwrite-non-empty guarantees
apply in both directions. There is no dedicated `--reverse` flag on the
script in this ticket (out of scope — "keep your PR focused"); an operator
who needs to reverse a specific workspace can call
`reverseMigrateWorkspaceLayout(key, root)` directly (e.g. via `bun run` with
a one-line script, the same way this ticket's own Servy proof did).
