# The fleet's identity model, as measured

**Measured 2026-09-02 06:58–07:15 UTC** (`date -u` in the measuring session,
Task tier, workspace `BUTCHR-106`, host `servyboi`). Every claim below is
tagged **MEASURED** (a command run in that session, output reported),
**CITED** (a claim from a ticket/comment/agent, not re-run — attributed,
dated, and noting whether the source itself measured it first-hand or is
also relaying a citation), or **INFERRED** (a conclusion reasoned from the
other two, with its premises named).

## Read this before trusting this page

**A fresh measurement beats this page.** Account logins and role env vars are
deployment configuration and change with no code change at all. Re-run these,
and compare:

1. **Your own role map.** From the daemon whose Jira credentials you actually
   run under (find its pid the way this page did, below): `tr '\0' '\n' <
   /proc/<pid>/environ | grep BUTCHR_ASSIGNEE`. *Falsifies this page's D1 row
   for that daemon* if any value differs from what's recorded here, or if a
   variable listed here as unset now appears.
2. **Any hop's verdict**, without needing daemon access at all: pull the two
   tickets on either side of the hop with `jira_get_issue` and compare
   `assignee.accountId` (boss ticket vs worker ticket). *Falsifies* the
   recorded verdict if equality/inequality has flipped.
3. **Which daemons exist on this host**: `ss -ltnp | grep butchr` for listening
   ports, `ps -eo pid,user,args | grep 'bun run src/daemon'` for owning
   processes regardless of which user can attribute the socket. *Falsifies*
   this page's daemon count if it differs from two, or if a listener now
   resolves to a Unix user not named here.
4. **H3's textual claim**: `git grep -n BUTCHR_ASSIGNEE_EPIC` in your own
   checkout of this repo, at whatever commit you actually have. *Falsifies*
   the H3 verdict below if the guidance now states the epic→task constraint,
   or states the constraints generally.

## The role map is PER-DAEMON, not global — H1

**H1 (per-daemon role maps that can disagree): CONFIRMED**, by direct
measurement of two live daemons on this one host that give different answers
for `BUTCHR_ASSIGNEE_EPIC`. See the daemon table below. Anyone using a value
from this page for their OWN daemon without checking their own
`ENVIRONMENT.md`/`/proc/<pid>/environ` is doing the thing this ticket exists
to stop.

*Falsification, stated in advance:* H1 would be refuted if every daemon
readable from this host reported an identical role map, or if there were
provably only one daemon in the fleet. Neither holds — see below.

**DO NOT STOP AT COMPARING ROLE VARIABLES — read the wrinkle below first.**
Daemon B's own case shows a role-variable-only comparison would have MISSED
its collision entirely: `BUTCHR_ASSIGNEE_EPIC` is unset there, so a check
that only diffs `_EPIC` against `_TASK` finds "no epic variable, not
comparable" and reports a clean page that is wrong. The quantity that
actually matters is the **effective account a live ticket of that tier ends
up assigned to**, not whether a same-named env var happens to be set. See
"The wrinkle" under D1, and note D2 below is built on ticket assignees for
exactly this reason, not on env-var diffs.

## D1 — Daemon enumeration and the per-daemon role map

**How daemons were enumerated, and what each method would miss (all MEASURED
this session):**

- `ss -ltnp` — lists listening sockets and, when the *listening* process is
  owned by the querying Unix user, its pid. **Blind spot:** a socket owned by
  a different Unix user shows up with an empty `Process` column — invisible
  ownership, not invisible existence. This is exactly what happened for port
  7718 below.
- `ps -eo pid,user,args | grep 'bun run src/daemon/index.ts'` — lists the
  daemon's own process line for EVERY Unix user on the host, because `ps` on
  this host is not restricted per-user. **Blind spot:** this is a process
  snapshot, not a config read — it gives you the pid and owning user, not the
  environment. It is also specific to this daemon's exact launch command;
  a differently-invoked daemon binary would not match the grep.
- `/proc/<pid>/environ` — the actual config, but readable only if you own the
  process (or are root). **Blind spot:** exactly the boundary this ticket is
  about — see the booswrit row.
- `systemctl --user status butchr.service` / `journalctl --user -u
  butchr.service` — authoritative for the CALLING user's own unit; running
  the equivalent for another user's unit requires being that user (or root
  with `machinectl`/`sudo -u`, not used here — see "What I did not do,
  deliberately" below).
- Each workspace's own `ENVIRONMENT.md` — written by that workspace's daemon
  from its own process at **workspace-build time**. **Blind spot found
  live:** this is a snapshot, not a live read. `BUTCHR-62`'s workspace
  records daemon pid `507430`; `BUTCHR-100`'s and this ticket's own workspace
  (`BUTCHR-106`), built later, both record pid `695036` — same host, same
  port (7717), same Unix user, different pid, because `systemctl` restarted
  the unit between builds (confirmed: `systemctl --user status
  butchr.service` here reports `Active: active (running) since Tue
  2026-09-01 21:43:04 PDT`, i.e. after `BUTCHR-62`'s build and before
  `BUTCHR-100`'s and this ticket's). **A cited pid can be stale even for your
  OWN daemon identity — check the live pid, don't just trust a file.**

**Two daemons found on `servyboi`:**

| | Daemon A (mine) | Daemon B |
|---|---|---|
| Unix user | `wroosbit` — MEASURED, `whoami`/`id` this session: `uid=1001(wroosbit)` | `booswrit` — MEASURED via `ps -eo pid,user,args`: pid 710855 owned by `booswrit`; **not** independently confirmed from its own `/proc/<pid>/environ` (see below) |
| host | `servyboi` — MEASURED, `hostname` this session | `servyboi` — INFERRED (same host as Daemon A; booswrit's process appears in this same host's `ps` output) |
| port | `7717` — MEASURED: `ss -ltnp` shows `*:7717` owned by `bun,pid=695036`, and `/proc/695036/environ` has `BUTCHR_PORT=7717` | `7718` — CITED, from `BUTCHR-99`'s own `ENVIRONMENT.md` (booswrit daemon's self-report, quoted to me in this ticket's brief). Corroborated MEASURED: my own `ss -ltnp` shows a second listener `*:7718` with **no attributable owning process** — the exact blind spot the brief predicted |
| systemd unit | `butchr.service` (user unit) — MEASURED via my own `ENVIRONMENT.md` and `systemctl --user status` | `butchr.service` — CITED from `BUTCHR-99`'s `ENVIRONMENT.md`; not independently checkable by me (that's `booswrit`'s user-unit table, and `systemctl --user` only shows the calling user's units) |
| live daemon pid | `695036` — MEASURED, `systemctl --user status butchr.service` → `Main PID: 695036 (bun)`, confirmed also in `ss -ltnp` and `ps aux` | `710855` — MEASURED via unprivileged `ps -eo pid,user,args`, which lists other users' command lines on this host; matches the pid `BUTCHR-99`'s own `ENVIRONMENT.md` cites (CITED, for the value; MEASURED, for the pid's live existence and owning user) |
| `BUTCHR_ASSIGNEE_STORY` | SET = `712020:e160cf60-6480-44de-8554-af5b81c584e2` — MEASURED, `tr '\0' '\n' < /proc/695036/environ \| grep BUTCHR` | **not readable from here** — tried `tr '\0' '\n' < /proc/710855/environ`, got `Permission denied` (MEASURED, this session — process is owned by `booswrit`, I am `wroosbit`). Vantage that WOULD work: a process running as Unix user `booswrit` (e.g. any of the `booswrit`-owned agent sessions already running on this host), or root |
| `BUTCHR_ASSIGNEE_TASK` | SET = `712020:619ec5ec-2e92-492f-8979-91ccda318230` — MEASURED, same read | not readable from here — same blind spot as above |
| `BUTCHR_ASSIGNEE_EPIC` | **UNSET** — MEASURED: the `grep BUTCHR` on `/proc/695036/environ` returns `BUTCHR_PORT`, `BUTCHR_GITHUB_ORGS`, `BUTCHR_ASSIGNEE_STORY`, `BUTCHR_ASSIGNEE_TASK` and nothing else; no `BUTCHR_ASSIGNEE_EPIC` line at all | **CITED as SET**, to `712020:619ec5ec-2e92-492f-8979-91ccda318230` (same value as Daemon A's `BUTCHR_ASSIGNEE_TASK`) — per the project tier's own description on `BUTCHR-100`'s ticket ("...was set for the first time in the deploy that staffed me..."), itself sourced from that daemon's own process. Not independently readable by me — see blind spot above |
| other identity vars found | `BUTCHR_GITHUB_ORGS=brooswit-factory,brooswit-minecraft`, `ATLASSIAN_TOKEN_FILE`, `GITHUB_TOKEN_FILE` (paths only; contents not read) — MEASURED | not readable from here |

**This is the direct, live confirmation of H1**: Daemon A (mine, port 7717)
has `BUTCHR_ASSIGNEE_EPIC` unset, MEASURED directly. The project tier's own
ticket description asserts that the daemon which staffed it (almost
certainly Daemon B, since the project-tier and story-tier agent sessions on
this host run as `booswrit` — see the process table in H2 below) had
`BUTCHR_ASSIGNEE_EPIC` **set**. Two daemons, same host, disagreeing on
whether a role variable is even defined. `BUTCHR-100`'s own comment
(2026-09-01, on `BUTCHR-100`) independently reports the identical
Daemon-A-side measurement (`STORY`/`TASK` set, `EPIC` unset) from its own
workspace, which is served by the same port-7717 daemon as this one — its
`ENVIRONMENT.md` names pid `695036` too, once accounting for the restart
noted above.

**What I did not do, deliberately:** this host grants `wroosbit` passwordless
`sudo`, which could read `/proc/710855/environ` across the Unix-user
boundary. I did not use it. The boundary being unreadable from the Task
tier's own vantage is itself the fact this section is measuring, and the
account separation this whole document is about is a Unix/GitHub/Jira
identity boundary, not merely a Linux filesystem permission to be routed
around with a different tool. The correct vantage point for that read is a
process actually running as `booswrit`, several of which are already live on
this host (see the H2 process table) — not a privilege escalation from mine.

### The wrinkle: a role-variable comparison would have missed the collision

**CITED, from `BUTCHR-100` (the Epic tier), which measured this first-hand
on its own daemon on 2026-09-02 and reported it to `BUTCHR-99`, which
relayed it here** — I did not and could not run this myself (it needs
`/proc/<pid>/environ` on the daemon serving the Epic tier, which is
`booswrit`'s, per the blind spot above). Two checks:

- **Check B**: `BUTCHR-100` compared its own daemon's `BUTCHR_ASSIGNEE_TASK`
  against `BUTCHR-100`'s own ticket `assignee.accountId`. Both
  `712020:619ec5ec-2e92-492f-8979-91ccda318230`, identical. *Falsification,
  as `BUTCHR-100` stated it before running:* had they differed, an Epic on
  that daemon adopting a Task would land on a different account and the hop
  would work. They did not differ.
- **The load-bearing part**: on that same daemon, `BUTCHR_ASSIGNEE_EPIC` is
  **unset** — yet `BUTCHR-100` (an Epic-tier ticket) is assigned
  `619ec5ec` regardless. Its assignment therefore did **not** come from
  that daemon's `_EPIC` role variable (there isn't one to source it from).
  **The collision is not "the epic role variable equals the task role
  variable" — it is "the account the Epic actually runs as equals that
  daemon's task role", by whatever mechanism actually staffed that
  particular Epic** (this document does not have visibility into what that
  mechanism was — an explicit `assignee` override on the creating call is
  one candidate, per this repo's own tool docs for `jira_create_issue`/
  `new_worker`, but that is **INFERRED**, not confirmed here).

**Consequence, stated plainly:** a check that diffs role variables against
each other, and treats an unset variable as "not comparable", would find no
`_EPIC` value on this daemon, report a clean page, and be wrong — this is
the general shape of a silently-wrong answer this whole epic is about. This
is exactly why D2 below is built on **live ticket assignees** (the
*effective* account a tier's work actually lands under) rather than on
env-var diffs — the env-var table above is a useful, and here genuinely
incomplete, corroborating layer, never the primary instrument.

It is also independent evidence for H1: a role map with `_EPIC` unset, on a
daemon whose Epic-tier ticket is nonetheless assigned, means a tier's
*effective* identity is sometimes not recoverable from that daemon's role
map at all — you have to read a live ticket.

### Atlassian accountId → display name → GitHub login

**No single tier can produce this whole table alone** — each row needs
either the Task tier's own co-location (which only a Task can do for
itself) or another tier doing the equivalent for its own account and
reporting it. This table is therefore necessarily a collaboration across
tiers, assembled here from three separate first-hand measurements, not one:

| accountId | Atlassian display name | how established | GitHub login | how established |
|---|---|---|---|---|
| `712020:619ec5ec-2e92-492f-8979-91ccda318230` | "Wroos Bit" | MEASURED — `jira_get_issue("BUTCHR-106")` (this ticket), `assignee.displayName` | `wroosbit` | MEASURED by **co-location, this session**: I run as this account (I am the assignee of `BUTCHR-106`) and, in this same session, `gh api user -q .login` → `wroosbit`. This is the strongest correspondence method available anywhere in this fleet — first-hand, same session, both sides read directly. **Independently corroborated**: `BUTCHR-100` (the Epic tier, which also resolves to this same account) ran the identical co-location check in its own session on 2026-09-02 ("Check A" in its report) — `gh api user -q .login` → `wroosbit` there too — and cross-checked it against PR #170's live `author` field, also `wroosbit`. CITED here, but the source measured it first-hand, at the source, not inferred from artefacts the way an outside tier would have to |
| `712020:e160cf60-6480-44de-8554-af5b81c584e2` | "boos writ" | MEASURED — `jira_get_issue("BUTCHR-99")`, `assignee.displayName` | `booswrit` | **CITED from `BUTCHR-99`, which measured this first-hand by co-location in its own session** (`whoami`/`id` → `booswrit`, `gh api user -q .login` → `booswrit`, 2026-09-02) — not inferred by me, and not something I can run myself (I cannot execute `gh api user` as this account). Corroborated by an artefact I did measure this session: `gh pr view 167 --json author,reviews` shows PR #167 (author `wroosbit`/Task) `APPROVED` by GitHub login `booswrit`, consistent with the Story-tier account reviewing Task-tier work |

## H2 — more than one daemon, different Unix users, one partly invisible

**CONFIRMED**, by direct measurement, and I demonstrated the second half of
it first-hand as instructed.

- Two live `bun run src/daemon/index.ts` processes exist on this host right
  now — MEASURED via `ps -eo pid,ppid,user,args`: pid `695036` owned by
  `wroosbit`, pid `710855` owned by `booswrit`.
- Port 7718 is listed by my own unprivileged `ss -ltnp` with **no attributable
  process** — MEASURED, this session. That is the exact "visible socket,
  invisible owner" blind spot both `ENVIRONMENT.md` and this ticket's brief
  describe, reproduced live rather than taken on faith.
- **I am the Task tier; my own agent process runs as Unix user `wroosbit`**
  — MEASURED, `whoami`. The agent process for `BUTCHR-99` (Story tier, my
  boss) runs as Unix user `booswrit` — MEASURED via `ps aux`, which lists
  `booswrit 712903 ... /home/booswrit/butchr-workspaces/BUTCHR-99/mcp.json
  ... server:butchr`. **Task and Story, adjacent tiers in my own review
  chain, run as different Unix users on the same host, established
  first-hand in this session** — this is H2's second half, demonstrated
  rather than cited.
- Also visible in that same `ps aux` listing (all MEASURED, one snapshot):
  `wroosbit` runs the agent processes for `BUTCHR-62` (Epic), `BUTCHR-100`
  (Epic), and this ticket (`BUTCHR-106`, Task); `booswrit` runs `BUTCHR-68`
  (Story), `BUTCHR` (the project tier itself), `BUTCHR-99` (Story), and
  `BUTCHR-103` (Story). Every Epic- and Task-tier agent process observed at
  measurement time ran as `wroosbit`; every Story- and project-tier agent
  process observed ran as `booswrit`. This lines up exactly with which
  daemon (A or B) each of those tickets' `ENVIRONMENT.md` cites — INFERRED
  from the two measured lists together.

*Falsification, stated in advance:* H2 would be refuted by exactly one
butchr listener on the host, or by every listener being attributable to a
single Unix user from an unprivileged vantage. Neither holds.

## H3 — the repo's operator guidance names one constraint, not both

**CONFIRMED**, by grep, at a named commit.

Checked in this session: `git grep -n BUTCHR_ASSIGNEE_EPIC` on
`origin/BUTCHR-99` at commit `36db3e4f8af47f8bea4106a240b376ca57e2715b`
(2026-09-01, the branch this PR targets). The `.env.example` block reads
(quoted verbatim, MEASURED):

```
# new_worker/adopt_worker staffing for a PROJECT caller's Epic (BUTCHR-71).
# Unset REFUSES the call, per-verb, naming this variable — never falls back
# to BUTCHR_ASSIGNEE_STORY/TASK. MUST NOT be the same account as this
# daemon's own project-lead identity: a project approving an epic
# (finish_worker/tell_worker) is the cross-account review hop the whole
# project-tier identity design exists for, and GitHub refuses a PR approval
# from the PR's own author. BUTCHR-62's doc records the epic-tier account
# measured on 2026-09-01 as 712020:619ec5ec-2e92-492f-8979-91ccda318230
# ("Wroos Bit") — the SAME account already used above for
# BUTCHR_ASSIGNEE_TASK, since that is the daemon that already runs the epic
# tier. Re-verify before trusting this value; it is cited, not measured, by
# whoever last wrote this file.
# BUTCHR_ASSIGNEE_EPIC=712020:619ec5ec-2e92-492f-8979-91ccda318230
```

This states exactly one pairwise constraint — project-lead ≠ epic — and is
silent on epic ≠ task, the hop that actually broke (`BUTCHR-99`/`BUTCHR-62`,
PR #170). The commented-out suggested value is, byte-for-byte, the same
account the same file already assigns to `BUTCHR_ASSIGNEE_TASK` six lines
above — flagged in its own comment as "cited, not measured" (the file's own
words). The comment block is self-aware about the collision it's suggesting
(it names the account collision explicitly) but does not state that
epic-vs-task is *also* a constraint that must hold — an operator who follows
this file literally, with no other context, sets up exactly the collision
this whole document is about, without the file ever saying not to.

*Falsification, stated in advance:* refuted if this text stated the
epic→task constraint too, or stated the constraints generally rather than
for one hop. Neither is the case in this checkout at this commit —
re-run the `git grep` above at your own commit to check whether this has
since been corrected (`BUTCHR-103`'s scope, per `BUTCHR-100`'s own ticket).

## D2 — Hop inventory

**Primary method** (per `BUTCHR-99`'s guidance on this ticket, refining an
earlier creator-vs-assignee method it explicitly superseded): compare the
Jira `assignee.accountId` of the boss ticket against the `assignee.accountId`
of the worker ticket, for a boss/worker pair connected by a real Implements
link, read fresh with `jira_get_issue` in this session. This needs no daemon
access at all, which is why it also covers hops whose daemon is unreadable
from here. It measures the **Atlassian account**, which is what a GitHub PR
review turns on **once you also know the Atlassian-account → GitHub-login
correspondence** (given above) — that second correspondence is a separate,
weaker claim and is called out per-hop below.

For `project→epic`, there is no worker-side "assignee" (a project has no
ticket), so the applicable reading is the epic's `creator` (who ran
`new_worker`/`adopt_worker` to bring it into being) vs the epic's own
`assignee` — the same method `BUTCHR-62` used on `BUTCHR-100`, re-measured
here rather than copied.

**Check 1** (`gh pr view <n> --json author -q .author.login` on a
Task-authored PR, vs the Epic tier's own `gh api user -q .login` — tests
whether the Epic/Task GitHub-login collision is real, independent of the
Jira-account comparison): the Task side is MEASURED by me, this session,
by co-location (see the accountId table above). The Epic side is CITED
from `BUTCHR-100`'s own "Check A", which measured it first-hand at the
source (its own `gh api user -q .login`, cross-checked against PR #170's
live author) rather than inferring it from artefacts — the original ticket
told me this could only be inferred; that is superseded. Both sides read
`wroosbit`. *Falsification, stated in advance:* had the two logins
differed, the collision claim would be wrong and reportable as REFUTED.
They did not differ.

| hop | reviewer tier's account | author tier's account | measurement | verdict | falsification (stated in advance) |
|---|---|---|---|---|---|
| project → epic | `e160cf60` ("boos writ") — `BUTCHR-100.creator.accountId`, MEASURED via `jira_get_issue("BUTCHR-100")` this session | `619ec5ec` ("Wroos Bit") — `BUTCHR-100.assignee.accountId`, same call | live ticket read, this session | **cross-account** | equal accountIds on a re-read would flip this to same-account |
| epic → story | `619ec5ec` — `BUTCHR-100.assignee.accountId` | `e160cf60` — `BUTCHR-99.assignee.accountId`, MEASURED via `jira_get_issue("BUTCHR-99")` this session | live ticket read, this session | **cross-account** | equal accountIds on a re-read would flip this |
| story → task | `e160cf60` — `BUTCHR-99.assignee.accountId` | `619ec5ec` — `BUTCHR-106.assignee.accountId`, MEASURED via `jira_get_issue("BUTCHR-106")` this session (this is my own ticket) | live ticket read, this session, **plus** a live GitHub artefact: PR #167 (author `wroosbit`/Task) was `APPROVED` by `booswrit`/Story — MEASURED, `gh pr view 167 --json author,reviews` this session | **cross-account** (structural). **GitHub-layer live confirmation for THIS PR is outstanding** — `BUTCHR-99` reviews this ticket's own PR with `gh pr review --approve` after this document is published; the outcome was not yet known when this was written, and is not pre-written here. Check the `[review]` line on `BUTCHR-106` for the live result. | equal accountIds, or `BUTCHR-99`'s own review of this PR being refused with "cannot approve your own pull request", would flip this |
| epic → task (the `adopt_worker` shortcut) | `619ec5ec` — `BUTCHR-100.assignee.accountId` | `619ec5ec` — `BUTCHR-106.assignee.accountId` | live ticket read, this session — **EQUAL** | **same-account — guarantee ABSENT** | unequal accountIds on a re-read would refute the central collision this whole epic is about |
| epic → task, Check 2 | — | — | **NOT EXECUTABLE FROM THE TASK TIER** (I cannot call `adopt_worker` and am not an Epic) — **and its substance is nonetheless settled, CITED from `BUTCHR-100`, which measured Check B first-hand on 2026-09-02 (see "The wrinkle" under D1): an Epic on its own daemon adopting a Task still resolves to the Epic's own account (`619ec5ec` = `619ec5ec`), so staffing is not fixed.** The *literal* live form (adopt a Task, PR, attempt `gh pr review --approve` today) was deliberately **not** re-run, for two stated reasons, not silently skipped: (1) factual — PR #170 is merged and `gh pr list --state open` on this repo returns none authored by the Task account, so there is currently no open PR to attempt an approval against; (2) principled — even given an open PR, a *successful* approval is the one outcome the check exists to catch, and running it live would leave a real GitHub approval on someone else's unreviewed work, damaging the exact guarantee under test, for a result (GitHub's own documented "cannot approve your own PR" rule) that isn't in doubt and says nothing about butchr's own staffing. Re-runnable, in its literal live form, by any Epic-tier agent at a moment an open Task-authored PR exists | — | if a live re-run of the literal form ever SUCCEEDS, or if a future Check B on any daemon finds the Epic and Task accounts DIFFER, report it to `BUTCHR-99` as REFUTED immediately, not folded in quietly |
| story → story (adopt_worker on a peer Story) | n/a | n/a | **not measured on a real ticket** — reasoned from source, see below | **same-account by construction — not-currently-reachable in observed practice** | reachable, and would need re-verifying against real tickets, the day a Story orphan gets adopted by another Story |
| task → task (adopt_worker on a peer Task) | n/a | n/a | **not measured on a real ticket** — reasoned from source, see below | **same-account by construction — not-currently-reachable in observed practice** | same as above |

### A hop this list misses, found by reading the code (not by ticket citation)

The ticket brief invites checking "whether a tier ever reviews its own tier,
and whether `adopt_worker` creates hops that `new_worker` does not." It does,
and the mechanism is broader than the one already-known Epic→Task collision.

**MEASURED**, by reading `adopt_worker`'s implementation in this checkout
(`git show origin/BUTCHR-99:src/tools/relationship.ts`,
`origin/BUTCHR-99:src/tools/defs.ts`, commit `36db3e4f8af47f8bea4106a240b376ca57e2715b`
— grep the symbol `adoptWorker` yourself rather than trusting a line number
from this page):

- `requireCaller()` (`src/tools/defs.ts`) resolves the caller's own identity
  from its `x-issue` header and does **no tier-based gating** for
  `adopt_worker` — the only three verbs gated by caller shape at all are
  `submit_to_boss`, `finish_without_a_boss`, and `file_where_it_belongs`
  (named explicitly in a comment at that gate).
- `adoptWorker()`'s non-project path (`src/tools/relationship.ts`) assigns
  the **adopted** ticket strictly by **its own** issuetype (`Story` →
  `roles.story`, `Task` → `roles.task`) and never inspects who the
  **adopting caller** is, beyond confirming it isn't already someone else's
  worker.

So the rule that produced the Epic→Task collision is not special to Epic and
Task — it is: **whichever account the adopted ticket's issuetype resolves
to, that becomes the adopted ticket's identity, full stop, regardless of the
adopting caller's own tier or account.** A collision exists whenever the
adopting caller's own account equals the role-account the adopted ticket
would get. Today that is true for exactly one pairing (Epic and Task both
resolve to `619ec5ec`), which is why Epic→Task is the one observed
collision — but the SAME code path means a Story adopting an orphan Story
(→ `roles.story`, which is the adopting Story's own account too) or a Task
adopting an orphan Task (→ `roles.task`, same as itself) would collide by
construction, independent of which accounts are allocated where — this is
not a same-account-today artifact of allocation, it's true for **any**
same-issuetype adoption because a role always agrees with its own tier's
account. I did not find a Story-adopts-Story or Task-adopts-Task on any real
ticket to measure live, so I list these as **not-currently-reachable in
observed practice** rather than inventing a live verdict — but they are
reachable in principle by the same tool call already in use for the known
collision, with no code change required.

## D3 — Constraint set and the minimum-account argument

Written as `reviewer.account ≠ author.account` per hop, using this
document's own D2 verdicts:

```
project ≠ epic     (measured: e160cf60 ≠ 619ec5ec — holds)
epic    ≠ story    (measured: 619ec5ec ≠ e160cf60 — holds)
story   ≠ task     (measured: e160cf60 ≠ 619ec5ec — holds)
epic    ≠ task     (measured: 619ec5ec  = 619ec5ec — VIOLATED)
```

plus, from the code-level finding above, the general rule `adopt_worker`
actually enforces: for any two tiers X and Y where X can adopt a Y-typed
orphan (every non-project tier can adopt a Story or Task orphan; a project
can only adopt an Epic orphan), the constraint `X.account ≠ role(Y-typed
ticket).account` must hold for that adoption path to be safe. Restricted to
the four named tiers, that reduces to the same four lines above **plus**
`story ≠ story` and `task ≠ task` (trivially false for any single-account
tier, i.e. structurally unsatisfiable by definition — a same-issuetype
adoption is never cross-account under any allocation, so it is excluded from
the graph-colouring question below and named instead as an inherent gap: the
system's guarantee does not, and cannot, cover a same-tier peer adoption).

**The graph-colouring argument** (BUTCHR-100's, written to be attacked):
model `{project, epic, story, task}` as vertices, each real review hop as an
edge forbidding its endpoints from sharing an account. The minimum number of
distinct accounts the fleet needs is the chromatic number of that graph.

- The three chain hops (`project–epic`, `epic–story`, `story–task`) form a
  path. A path is bipartite (2-colourable): alternate two accounts down the
  chain (`project`=A, `epic`=B, `story`=A, `task`=B) and every **chain** edge
  is satisfied. **This is, in fact, exactly what is deployed today** —
  MEASURED: `project` and `story` both resolve to `e160cf60`; `epic` and
  `task` both resolve to `619ec5ec`. Two accounts, alternating, and the three
  chain hops all measure cross-account for exactly that reason — not by
  coincidence of three separate lucky draws, but because two colours
  alternated over a path of four nodes satisfy every edge in the path by
  construction.
- The **shortcut edge** `epic–task` (via `adopt_worker`, skipping `story`)
  connects positions 2 and 4 in that alternation — same colour, same
  account, by construction. **This is exactly the collision found.** It is
  not an allocation mistake within the 2-colour scheme; it is what a 2-colour
  alternation always does to any edge that connects two same-parity, non-
  adjacent nodes on the path.

**Is the shortcut edge a real dependency, or merely a permitted one?** This
is the question `BUTCHR-100` explicitly invites attacking, and I think the
evidence says it is real, not contrived: `adopt_worker` is the documented,
supported mechanism for any tier to take ownership of an ORPHAN of the
adoptable type, and this is not a hypothetical — `BUTCHR-96` (a real orphan
Task) was actually adopted by `BUTCHR-62` (a real Epic) in the ordinary
course of clearing orphans, producing a real PR (#170) and a real,
production `gh pr review --approve` refusal (CITED, `BUTCHR-99`/`BUTCHR-62`,
re-confirmed this session as MEASURED via `gh pr view 170`). Nothing about
that sequence required an unusual or discouraged code path — an orphan Task
existing at a moment when only Epic-tier agents are free to adopt it is an
ordinary scheduling fact, not an edge case. On that basis: **`epic ≠ task`
is a constraint the fleet depends on, not one it merely permits**, and with
it, `epic`, `story`, and `task` are pairwise-adjacent (`epic–story` from the
normal chain, `story–task` from the normal chain, `epic–task` from the
adoption shortcut just argued for) — a triangle, chromatic number 3.
**Two accounts are therefore provably insufficient to cover epic, story, and
task simultaneously, under any allocation, as long as the adoption shortcut
counts as depended-upon** — this is BUTCHR-100's argument and I did not find
a way to break it; if you disagree, the load-bearing premise to attack is
the one in this paragraph (that `BUTCHR-96`'s adoption was ordinary, not an
edge case), not the graph theory, which follows immediately once that
premise is granted.

Including `project` (pairwise-adjacent to `epic` only, on current evidence —
I did not find or reason to a `project–story` or `project–task` real hop:
`adoptProjectWorker`'s own code path, read this session, refuses any
adopted type but Epic for a project caller, so the code forecloses those two
edges rather than merely leaving them unobserved) does not raise the
chromatic number past 3: `project` can share `epic`'s non-conflicting colour
class, i.e. reuse either the `story` or `task` account, same as it already
does (`project` and `story` share `e160cf60` today, satisfying `project ≠
epic` since `epic` is the other colour).

**Minimum accounts the facts force, stated plainly:** if `epic ≠ task` is a
depended-upon constraint (argued above from a real, already-occurred
adoption, not merely a measurement), **3 distinct accounts are required** —
epic, story, and task must be pairwise distinct; project can reuse either
epic's or task's off-triangle color, e.g. story's or another dedicated one.
The fleet currently runs on 2. **This document states only what the facts
force and does not choose which 3 accounts, or which tier gets a new one —
that allocation decision is explicitly out of this ticket's scope
(`BUTCHR-104`, shelved pending this document and pending `BUTCHR-62`'s
close).**

If a reader rejects the premise above — if `epic ≠ task` is judged a hop the
fleet merely *permits* rather than *depends on* (e.g. if a future change
made `adopt_worker` refuse cross-tier adoption, or if the fleet's real
scheduling means an orphan Task is always eventually adopted by a Story, not
an Epic, making the direct Epic-adopts-Task path theoretical only) — then
the triangle collapses to the original path, which is 2-colourable, and 2
accounts are provably sufficient. **The measured allocation already
achieves that lower bound if and only if that premise holds.** State which
premise you're relying on before citing "2" or "3" from this page.

## Confluence

`BUTCHR-99`'s own Confluence doc will carry the copy of this page, published
by `BUTCHR-99` from the merged version of this file — not from this PR
directly (`set_doc` only ever writes the caller's own doc). This file is
written to stand alone as that page's source.
