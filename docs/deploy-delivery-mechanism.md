# How a commit on `main` reaches a running daemon — measurement (BUTCHR-274, epic BUTCHR-301)

Answers, by direct measurement and controlled experiment, the question
"when a commit lands on `main`, by what mechanism (if any) does a
running butchr daemon come to be executing it, and how long does that
take?" Establishes it **in code and in the deploy driver's own
definition**, not by inferring a mechanism from reflog timing.

**The short answer.** butchr has **no in-process deploy path at all** —
the daemon cannot fetch, pull, check out, or restart itself, and only
ever *reads* git state to report its own build identity and currency.
Delivery is done entirely by **one external sweep** that, per daemon in
sequence, runs `git pull -q --ff-only origin main` and then restarts the
unit; the two halves land in the **same second**, so they are one action,
not two. That sweep ran hourly at `:43` on 2026-09-01, continued at
irregular times through 2026-09-02 21:51:25, and then **stopped**. Its
invoker is **not in this repository** and was **not visible from the
account the measurement was taken from**. The latency from merge to
execution is therefore **"until a person acts", unbounded by
construction**; the worst gap actually observed is **seven days with no
restart at all**.

**No deploy mechanism is proposed or built by this document.** The
options analysis lives on BUTCHR-274's Confluence doc, where the epic
makes the decision. This file records *what is true*, so the next reader
does not have to re-derive it.

## Why this document is written defensively

This question produced **four public retractions in a single day** on
BUTCHR-274, all of them the same mistake in different clothes:
**reporting a _not-yet_ as a _never_.**

1. A ref was read **inside the gap between a restart and its first
   pull**, and a not-yet was filed as a permanent stall.
2. `origin/main` was called "frozen for 5h32m" when, for most of that
   window, **`main` had not moved** — there was nothing to fetch, and a
   correctly-working fetch would have left the ref untouched.
3. **Found here, and not previously known:** reflog entries were counted
   as driver runs. **A pull that finds nothing new changes no ref, so it
   writes no reflog entry at all — yet it still restarts the daemon.**
   The reflog therefore *systematically under-counts* sweep runs.

So: **every conclusion below carries the observation that would falsify
it**, and every measurement names its command, its checkout, and its
wall-clock time. Where a question has no answer, it says "not
established, and here is what could not be seen" rather than offering a
plausible guess.

**Two standing cautions for anyone re-running this.**

- **Environment facts are not transferable.** Host, port, unit, journal
  command and pid below were measured from one process. Resolve your own
  from **your own workspace's `ENVIRONMENT.md`**, which your daemon
  writes from its own process. More than one butchr daemon runs on the
  host under different Unix users; see "Which daemon each finding
  covers".
- **`FETCH_HEAD`'s worktree semantics are git-version-sensitive.** Every
  ref experiment here was run at **git 2.43.0**, stated so you can
  re-run it rather than inherit it.

## Method, and this document's own footprint

**Every live daemon checkout was treated as read-only: no checkout,
pull, reset, and no `git fetch`** — a fetch writes precisely the refs
whose writers this document identifies, so one would have destroyed the
evidence. All ref-mutating experiments ran in a **throwaway clone with
its own bare upstream** under a scratchpad, never against this
repository or its remote.

BUTCHR-274 created **one linked worktree** of a daemon checkout at
**2026-09-10 17:46:29 -0700** (branch `BUTCHR-274`). That writes a
branch ref and worktree metadata, performs no fetch, and touches neither
`refs/remotes/origin/main` nor any `FETCH_HEAD`. **That claim is
independently checkable from the artefact itself**: the worktree's
private git dir contains no `FETCH_HEAD` file, which it would if anyone
had fetched inside it.

## 1. Is there an in-process deploy path? No.

Read at `88cfde11ed00dd90c0b21fed9b179d45bfc68840` (verify paths at your
own commit):

- **Every** git call site in `src/` is accounted for: `build-identity.ts`
  (`rev-parse HEAD`; `status --porcelain`) and `build-currency.ts` (one
  `execFileSync` helper behind `rev-parse`/`rev-list` calls).
- A complete literal census of git subcommands passed anywhere in `src/`
  yields **only** `status`, `rev-parse`, `rev-list`. No `fetch`, `pull`,
  `checkout`, `reset`, `clone`.
- **`systemctl` appears nowhere in this repository** — not `src/`, not
  `scripts/`, not any `.sh` or `.json`. Neither does `--ff-only`.
- The only two `Bun.spawn` sites (both `src/daemon/index.ts`) spawn a
  terminal running `herdr agent attach`; the second's argv comes from
  `resolveAttach`, which yields a pane-attach command.

**So the daemon cannot deploy itself. It reads git state only.**

**How the obvious falsifier was closed.** A literal grep for git words
would miss an argv assembled indirectly — an array built from variables,
a template string, a helper taking the subcommand as a parameter. So
*every process-spawning primitive* was enumerated instead
(`execFileSync`, `execSync`, `spawnSync`, `spawn(`, `Bun.spawn`,
`child_process`, `` $` ``) and each site read. There are five, all
described above.

**Falsifier still open:** a spawn reached through a *dependency* rather
than this repository's own source. `node_modules` was not audited.

## 2. What pulls, and what restarts? One external sweep does both.

**The pull and the restart are a single action — for sweep events, with
one measured exception.** On the daemon whose journal this author could
read, **every** `pull -q --ff-only origin main` reflog timestamp has a
systemd `Stopping`+`Started` pair **in the same second**. Those restarts
appear as explicit `Stopping → Stopped → Started` sequences — what a
commanded `systemctl restart` produces, not systemd's own `Scheduled
restart job` wording.

**The same holds on the other daemon, and this part was measured by epic
BUTCHR-301 from that daemon's own user journal — a source this author's
account could not read** (`journalctl --user -u butchr.service`, read
2026-09-11 ~01:31Z; provenance stated because it is not this author's
measurement):

- **15 of the 16** pulls in that daemon's `main` reflog between
  2026-08-30 and 2026-09-10 have a unit restart **within one second**.
  The only non-same-second pair is its 12:24:20 pull against a 12:24:21
  restart.
- **The exception that qualifies the claim: 2026-09-02 22:26:47 is a pull
  with NO restart at all** on that daemon. So "one action" is true of
  *sweep* events; a **pull-without-restart also genuinely occurred**, and
  its consequence is measured below.

**It sweeps both daemons in sequence, the other user's first.** Pairing
the two checkouts' `main` reflogs gives **13 reflog-visible pairs**, the
other user's always first, deltas **+1s to +16s**, ordering never
reversed (09-01 13:31, 15:43, 16:43, 17:43, 18:43, 20:43, 21:43; 09-02
07:21, 07:58, 10:21, 12:24; 09-10 10:36, 13:09).

The falsifier pre-registered for this — *if earlier pairs are minutes
apart, it is a person typing two commands rather than one script* — **did
not fire on a single pair.**

**Sweep count, spelled out so that two different sixteens in this
document are never read as one.** 13 sweeps are visible as a pull in
*both* reflogs. **Three more** — 09-02 13:21:04, 21:22:50, 21:51:25 — are
sweeps in which the other daemon restarted with no reflog entry,
established in review from its journal: **16 sweep events in total.**
Separately, and coincidentally sharing the number, that daemon's own
`main` reflog holds **16 pulls** between 2026-08-30 and 2026-09-10, of
which 15 restart within one second. **The two counts measure different
things.**

**Four pulls look unpaired in the reflogs — and for three of them that
appearance is WRONG. Corrected in review, by the trap this very document
names one section below.** The three are 09-02 13:21:04, 21:22:50 and
21:51:25. Epic BUTCHR-301, reading the *other* daemon's own user journal
(unreadable from this author's account), found that at **each** of those
three timestamps that daemon has a `Stopping → Stopped → Started`
sequence **in the same second**, with **no entry in its `main` reflog**.
By this document's own rule — *a pull that finds nothing new writes no
reflog entry yet still restarts* — those three are **joint sweeps whose
other-side pull was a no-op**, not independent actions.

**An earlier draft of this document inferred "the two daemons were acted
on independently — what individual intervention looks like" from that
reflog silence. That inference is retracted.** It is the same
not-yet-versus-never error this document warns about, committed against
its own warning, and it is recorded rather than quietly deleted because
the inference was *evidence about what invokes the sweep* — the hinge of
the epic's decision. Removing it makes the single-driver reading
**stronger**, not weaker: there is now less sign of per-daemon manual
action than this document first claimed.

**The one genuinely independent event is 2026-09-02 22:26:47 on the other
daemon — a pull with NO restart.** Its next unit start is the 2026-09-10
10:24:36 boot. **So that daemon pulled new code and then ran the OLD code
for the following week** — the "HEAD is not necessarily what a long-lived
process loaded" case, measured rather than hypothesised.

The other checkout's pulls before 2026-08-30 19:43:49 are unpairable
because the second clone did not exist yet; that is expected, not an
anomaly. And the procedure itself changed once: entries read `pull -q` up
to 2026-08-28 17:08:11 and `pull -q --ff-only origin main` from
2026-08-28 18:22:14.

**The hourly `:43` driver was real, and its end can be dated.**
Restart-confirmed sweeps at 09-01 15:43, 16:43, 17:43, 18:43, 20:43,
21:43 and **23:43** — 19:43 and 22:43 absent. **The last `:43` sweep was
2026-09-01 23:43:42**; note it is visible *only* as a restart, because
that pull found nothing new and wrote no reflog entry. Sweeps continued
at irregular times through **2026-09-02 21:51:25** and then stopped, with
**zero restarts of any kind** until **2026-09-09 18:10:13**.

**Both halves occur separately, and both are now measured.**
*Restart-without-pull*, on the daemon whose journal this author read:
09-09 18:10:13; 09-10 11:12:40, 11:12:55, 11:27:48, 11:51:52 — recovery
restarts that reload the *same* code. *Pull-without-restart*, on the
other daemon, measured by the epic: **09-02 22:26:47**, after which that
daemon kept running its previously-loaded code until the 09-10 10:24:36
boot. A pull without a restart leaves old code running; a restart without
a pull reloads the same code. **Neither half implies the other, and this
fleet has produced both.**

**One honest exception to "every restart was externally commanded":** the
journal does contain 4 systemd `Scheduled restart job` events, **all**
between 08-30 19:44:40 and 19:44:56 — a provisioning-time crashloop.
None since; `NRestarts=0` today, with `Restart=always` set.

### The invoker: not found. Where it was looked for.

**Checked, empty or absent:** the account's crontab (`no crontab for
<user>`); its user timers (one unrelated cache-clean timer); its
butchr-related user units (`butchr.service` and `herdr.service` only —
**no timer unit**); `/etc/cron.d` (stock `anacron`, `e2scrub_all`,
`.placeholder`); `/etc/cron.hourly` (empty); `/etc/crontab` (stock
Debian `run-parts`); no `butchr`/`ff-only` match in `/etc/cron*` or
`/etc/systemd/system`; no deploy script under `/usr/local/bin`,
`/usr/local/sbin`, `/opt`, `/srv`; and nothing in this repository (§1).

**Could NOT be seen, so genuinely not ruled out:**
`/var/spool/cron/crontabs/` (**Permission denied — another user's
crontab could hold the sweep**); `crontab -l -u <other user>` ("must be
privileged to use -u"); the other fleet users' home directory listings;
and `sudo -n true`, which failed with "a password is required" **despite
the ASSIST fleet page mentioning passwordless root on this host** — that
page's claim did not hold for the account used, so test it rather than
assume it.

Note the trap the ASSIST page warns about and which was respected here:
for a systemd **user** unit, the system-level `journalctl -u <unit>`
(without `--user`) prints `-- No entries --`, **not** a permission error.
Use the exact command from your own `ENVIRONMENT.md`.

**Conclusion, bounded honestly: the sweep is not in this repository and
was not visible from the account used.** That is consistent with the
ASSIST page's model — a deploy "triggered by an epic posting a deploy
cue, never by the assistant's own judgement", per daemon `git pull
--ff-only origin main` then `systemctl --user restart butchr` — *and*
equally consistent with a cron owned by a user whose spool is
unreadable. **Which of the two it is was NOT established.**

**Highest-value next measurement:** read `/var/spool/cron/crontabs/` as
root, or the other accounts' user timers. If a timer exists, the `:43`
cadence and its disappearance become a broken-scheduler story; if none
exists, the operator-cue model stands.

## 3. What writes `refs/remotes/origin/main` and `FETCH_HEAD`?

Both previously-open anomalies are now **reproduced in a controlled
experiment** at **git 2.43.0**.

### (a) A fetch in a linked worktree writes only the *per-worktree* `FETCH_HEAD`

Fetching from inside a linked worktree updated the **shared**
`refs/remotes/origin/main` (reflog entry in the common dir) and wrote
**only** `.git/worktrees/<name>/FETCH_HEAD`. The common-dir
`.git/FETCH_HEAD` was **never created**. From inside a linked worktree,
`git rev-parse --git-path FETCH_HEAD` resolves to the *per-worktree*
path. Control: a fetch in the *main* worktree does write
`.git/FETCH_HEAD`.

**That fully explains anomaly (a)** — `origin/main` advancing while the
top-level `FETCH_HEAD` stands still. The checkout studied had ~19 linked
worktrees, one per agent workspace, and its `origin/main` reflog carries
at least four command spellings (`fetch origin`, `fetch origin --quiet`,
`fetch origin main`, `pull -q --ff-only origin main`) — far more than one
scheduled driver would produce. Per-worktree `FETCH_HEAD` mtimes matched
individual reflog entries to within a fraction of a second while the
top-level file did not move.

> **This refutes a comment in this repository's own source.** The comment
> above `resolveGitCommonDir` in `src/agents/build-currency.ts` asserts
> that `FETCH_HEAD` was "measured living under `--git-common-dir`, NOT
> the per-worktree `--git-dir`", and therefore that a fetch in one
> worktree "updates `FETCH_HEAD` for every worktree sharing this common
> dir". **At git 2.43.0 that is false.** `lastFetchedAt()` stats the
> common-dir `FETCH_HEAD`, so **it only ever observes fetches run in the
> MAIN worktree**, while most fetching in this fleet happens in linked
> worktrees. Direction of the resulting error: the clone looks like it
> **fetched longer ago than it did**.
>
> This document deliberately does **not** change that code. Correcting
> the comment without correcting `lastFetchedAt()` would leave a file
> whose prose is right and whose behaviour is wrong — strictly more
> misleading than today. The signal and its consumers belong to
> BUTCHR-163 (visibility); this is recorded here so that work starts from
> the truth.

**Falsifier:** a different git version — re-run before relying on it.
Also, a *removed* worktree takes its `FETCH_HEAD` with it, so a missing
per-worktree file never by itself clears this candidate.

### (b) Two mechanisms leave `origin/main` behind while the objects arrive

Both reproduced:

- **`git fetch origin <sha>`** writes `FETCH_HEAD`, brings the commit
  objects into the store, and leaves `refs/remotes/origin/main` at the
  older commit. Verified with `git cat-file -t <new sha>` reporting
  `commit` while the tracking ref had not moved. **This is the shape of
  an ordinary PR review fetch** (`gh pr checkout`, or any fetch addressed
  by sha), which agents perform constantly.
- **`git fetch <url> <branch>`** — fetching an explicit URL rather than
  the named remote — likewise writes `FETCH_HEAD` (whose content names
  that URL) without touching `refs/remotes/origin/main`.

**Together these explain the reported anomaly (b)** — "a fetch that ran
and left `origin/main` behind commits that already existed".

**Which of the two produced the specific historical observation cannot
be determined, and this is a permanent evidence loss, not an unfinished
task:** `FETCH_HEAD` is **overwritten on every fetch**, so only the most
recent fetch per worktree survives as evidence. A field read of every
current `FETCH_HEAD` on the studied checkout found **3824 lines naming
exactly one source URL** (this repository's own remote) and **no
sha-or-tag line at all** — every line was `branch '<name>' of <url>`. So
neither mechanism is evidenced *right now*, which neither confirms nor
refutes the earlier event.

**Read `FETCH_HEAD` contents, not just mtimes** — the content names the
source URL and branch, and it is the only thing that distinguishes these
cases.

### Candidates resolved

- **REFUTED:** "an explicit *refspec* writes `FETCH_HEAD` but not the
  tracking ref." At 2.43.0, `git fetch origin main` **does** update
  `origin/main`, and so does
  `git fetch origin refs/heads/main:refs/remotes/origin/sidecar`.
- **CONFIRMED: the build-currency path never fetches.** Every git call it
  makes is `rev-parse` or `rev-list`; its module documentation forbids a
  network call because it runs on the agent-spawn path and would hang a
  spawn. Its own ground-truth text was right about this.
- **CONFIRMED as a major writer:** agents fetching — in their own linked
  worktrees, and by sha during review.
- **NOT established:** attribution of every historical fetch to a
  specific worktree or ticket. Worktree-to-workspace mapping makes this
  possible in principle (`git worktree list` plus the directory name) but
  was not done for all ~19.
- **A recorded dead end:** the reflog's identity field **cannot** separate
  driver from agent — it is uniform within an account, being the checkout
  owner's git config. It would only distinguish a pull run as root or as
  a different user.

### Consequences for any freshness check

1. **Do not read the common-dir `FETCH_HEAD` as a clone-wide "when did we
   last fetch" signal.** At 2.43.0 it sees only main-worktree fetches.
2. **Never infer `origin/main`'s trustworthiness from `FETCH_HEAD`'s
   freshness.** (b) makes them independent: a PR-sha fetch moves one and
   not the other, so a fresh `FETCH_HEAD` beside a stale `origin/main`
   can produce a **false CURRENT** verdict.
3. A local mtime cannot answer "is `origin/main` current". Comparing
   against the **real remote** (e.g. `git ls-remote`) would, but **that is
   a network call, and the build-currency path forbids network work
   because it runs on the agent-spawn path and a hang there hangs a
   spawn** — so this is **an input to BUTCHR-163's design decision, not a
   recommendation from here**. The alternative that needs no network is to
   derive freshness from `FETCH_HEAD`'s **contents** rather than its
   mtime, which is the direction BUTCHR-163's own first PR already takes.
   Either way, the signal should report *unknown* rather than imply
   currency it cannot establish.

## 4. Latency: until a person acts, and unbounded by construction

Delivery needs **both** halves: the commit must reach the checkout's
`main` ref, **and** a restart must load it into the long-lived process.
Nothing inside butchr does either (§1); the only thing that does both is
the external sweep, whose invoker was not found (§2). A mechanism that
does only one half has *infinite* latency for the other.

**Measured, labelled as one sample:** the sweep had not run since
**2026-09-10 13:09:44**. At 2026-09-11 01:11Z the daemon was executing
`0fa49429` while its own `origin/main` stood **75 commits** ahead, with
`main` demonstrably moving throughout that window — so this is **not**
the not-yet-versus-never error; something was continuously available to
pull. **Worst gaps actually observed, attributed per daemon** — the
figures differ, so neither should be quoted as "the fleet's":
**2026-09-02 21:51:25 → 2026-09-09 18:10:13 (~6.9 days)** on the daemon
this author measured, and **2026-09-02 21:51:25 → 2026-09-10 10:24:36
(~7.5 days, ending in a boot rather than a deploy)** on the other, as
measured by the epic from that daemon's own journal — it has **no**
09-09 18:10:13 restart at all.

**Falsifier:** a cron in the unreadable `/var/spool/cron/crontabs/` still
firing would make this "bounded in design but currently broken" rather
than "unbounded by design". The delivered behaviour is identical either
way, and in both cases nothing in this repository performs the deploy.

## Which daemon each finding covers

- **The daemon named by the measuring workspace's own `ENVIRONMENT.md`**
  — everything above: both reflogs, the systemd journal, unit properties
  (`Restart=`, `NRestarts`, `ExecMainStartTimestamp`,
  `WorkingDirectory`), `/health`, and `/proc/<pid>/cwd`, which confirms
  the checkout the live process actually runs from rather than assuming
  it.
- **The other fleet user's daemon** — its `main` and `origin/main`
  reflogs **are readable by exact path**. Note carefully: its home
  directory could not be *listed*, but traversal into known paths was
  permitted, so **a denied `ls` is not proof a checkout is unreadable**.
  Its pull times, the pairing, the spelling change and the
  multi-day gaps are therefore **measured** for it. **Not readable from
  this author's account:** its user journal (hence its restart history),
  its unit properties, its `/proc/<pid>/cwd`, its crontab.

  **That restart history is no longer inferred — it was MEASURED in
  review by epic BUTCHR-301, which could read that daemon's own journal.**
  An earlier draft of this document said "it restarted at T is INFERRED
  from the same-second pairing"; for this daemon that is now superseded by
  direct measurement (15 of 16 pulls restart within one second; the
  2026-09-02 22:26:47 pull has no restart; there is no 09-09 18:10:13
  restart). **The provenance is stated wherever those figures appear,
  because they are not this author's measurements** — a later reader
  checking them must know whose journal to open.

Nothing here is generalised to "the fleet" beyond what each bullet
states.
