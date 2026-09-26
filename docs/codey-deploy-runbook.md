# Codey Butchr deploy/restart runbook (BUTCHR-465, story BUTCHR-396, epic BUTCHR-391)

**Who runs this:** `manager-factory-butchr`, on Codey. **Servy (where this
document was written) has no access to Codey and never connects to it — no
ssh, no curl, nothing.** This document only ever *writes instructions*; you
execute every command in it yourself, on Codey, and record what actually
happened. Never touch Zippy/zipzoom — out of scope entirely.

This runbook covers ONE thing: getting the new Butchr build onto Codey's
`butchr.service` safely — build, health check, automatic rollback, restart,
recovery verification, and the hand-off to the real-Rocket.Chat check. It
does **not** cover the agent migration/cutover itself (Nexus, Bakr,
Candlestix) — that is `docs/codey-migration-runbook.md` (BUTCHR-466), a
separate task, and it runs strictly **after** this one, per BUTCHR-396's
Execution model ("Codey deploy step... happens BEFORE any agent cutover
step").

**Every fact below that names a host, port, unit, path or pid is a
DEFAULT/EXAMPLE unless this document says otherwise — never trust a value
copied from a different machine.** Resolve every one of them yourself, live,
on Codey, using the discovery commands in §1. This is the same trap this
repo's own `docs/deploy-delivery-mechanism.md` names: "more than one butchr
daemon runs on the host under different Unix users"; the `journalctl`
system-vs-`--user` trap is real too (a system-level `journalctl -u <unit>`
against a **user** unit silently prints `-- No entries --`, not a
permission error — always use `journalctl --user -u <unit>`).

## Failure policy (applies to every step below, stated once so it isn't
## repeated eleven times)

**If any step's actual output does not match its stated expected output:
STOP. Do not proceed to the next step. Roll back per that step's own
rollback instructions (or, once armed, let the watchdog in §3 do it).**
Record the failure in the evidence template (§10) exactly as it happened —
a failed step with an honest "FAIL: <what actually happened>" is useful
evidence; a silently-skipped or fudged step is not.

---

## 1. Preconditions: discover the Codey-specific facts (do NOT guess)

This repo's own `docs/deploy-delivery-mechanism.md` establishes, from direct
measurement on Servy's own daemons, that **butchr has no in-process deploy
path at all** — no `systemctl` call anywhere in `src/` or `scripts/`, no
timer unit checked in anywhere in this repository. Delivery there is one
external action: `git pull -q --ff-only origin main` immediately followed by
a unit restart. **That measurement is from Servy's daemons, not Codey's** —
verify every fact below on Codey itself before relying on it; a host can
differ.

Fill in this worksheet with real, discovered values. Every command below
this line uses these as shell variables — set them for real in your shell
before running anything else in this document.

### 1.1 Confirm the unit name and how it actually launches Butchr

```
systemctl --user status butchr.service
systemctl --user cat butchr.service
```

**Expected output:** a unit exists (status is `active (running)` or
similar — if it's not running at all, that's itself Open Question material,
not a reason to guess); `cat` prints the real unit file, including
`ExecStart=` and `WorkingDirectory=`.

**Read `ExecStart=` carefully — it decides which of the two build modes
below applies:**
- If it runs `bun run src/daemon/index.ts`, `bun start`, or similar —
  **source-run mode**: no separate build artifact, the process reads its
  own sha from git at start (`shaProvenance: "git-at-start"` in `/health`,
  see §1.3). This is what was measured on Servy's daemons.
- If it runs `dist/butchr.js` (or a path ending in that) directly —
  **built mode**: the sha is baked in at build time (`shaProvenance:
  "baked"`), and `bun run build` (`scripts/build/build.ts`) must run as
  part of the deploy, not just `git pull` + `bun install`.

**If `ExecStart=` names neither shape recognisably, STOP and record it as an
Open Question (§12) rather than guessing which mode applies** — the two
modes need different deploy commands (§2), and this decides `watchdog.ts
arm`'s own required `--mode source|built` flag (§3.3).

**Rollback for this step:** none needed — this is read-only.
**Evidence:** paste both commands' full output.

### 1.2 The install directory and its git remote

```
INSTALL_DIR=<WorkingDirectory= value from 1.1, or wherever ExecStart's script path resolves from>
git -C "$INSTALL_DIR" remote -v
git -C "$INSTALL_DIR" rev-parse HEAD
git -C "$INSTALL_DIR" status --porcelain
```

**Expected output:** `origin` pointing at
`https://github.com/brooswit-factory/butchr.git` (fetch and push); a real
40-character sha; **`status --porcelain` prints NOTHING** — an empty
result confirms the checkout is clean. **If `status --porcelain` prints
anything, STOP** — this checkout has uncommitted local changes, and `git
reset --hard` (the rollback mechanism in §3) would destroy them silently.
Do not proceed until this is resolved (commit, stash, or escalate — do not
guess which).

**Rollback:** none — read-only.
**Evidence:** paste all three commands' output, including confirmation the
third was empty.

### 1.3 The port, from the running daemon's own `/health`

```
PORT=<discover: grep the unit file from 1.1 for BUTCHR_PORT=, or check your own ENVIRONMENT.md if this IS your own daemon's workspace>
curl -sf "http://127.0.0.1:$PORT/health" | jq .
```

**Expected output:** valid JSON with at minimum `ok` (boolean) and, if this
daemon has BUTCHR-54/329 (everything on `main` as of this writing does),
`build: {sha, shaProvenance, version, pid, unit, journalctl}` and
`currency: {checkedAt, verdict: {status: "current"|"stale"|"unknown", ...}}`.
**Record the pre-deploy `build.sha` — this is `PREV_SHA`, the rollback
target for §3.** `config.ts`'s own documented default is `BUTCHR_PORT=7717`
when unset (see `.env.example`) — a plausible fallback to TRY, never a
value to assume without the `curl` above actually answering on it.

**Rollback:** none — read-only.
**Evidence:** paste the full `/health` JSON; state `PREV_SHA` explicitly in
your evidence (§10) — every later step's rollback depends on this exact
value being right.

### 1.4 The user account this unit runs as, and systemd-run availability

```
whoami
systemctl --user show butchr.service -p User 2>/dev/null; echo "(a --user unit runs as the invoking user; the property above is normally empty/absent, which is expected, not an error)"
systemd-run --user --version >/dev/null && echo "systemd-run: available"
loginctl show-user "$(whoami)" -p Linger
```

**Expected output:** a username; `systemd-run --version` succeeds (needed
for §3's automatic rollback — a transient scheduled unit); `Linger=yes` is
what lets the user's systemd instance (and therefore a pending watchdog
timer) keep running across a logout — **if it prints `Linger=no`, record
this as an Open Question: the automatic rollback in §3 may not survive a
logout of this account, which is exactly the "must not depend on the
manager surviving" property this whole mechanism exists for.** This is not
this document's call to silently work around — flag it.

**Rollback:** none — read-only.
**Evidence:** paste all four commands' output, including the Linger value
verbatim.

### 1.5 The evidence and heads-up destinations (already decided, not open)

- **Evidence and deploy/cutover timing → `admin-assembly`** (BUTCHR-396's
  Execution model, "Ownership and evidence").
- **Heads-up immediately before the restart → `#team-brooswit-factory`**
  (§4.1 below gives the exact text).

---

## 2. Build

Set `$INSTALL_DIR` from §1.2. **Do this from a directory you can afford to
have `git reset --hard` applied to later (§3) — that is precisely why §1.2
made you confirm the tree is clean first.**

### 2.1 Fetch and fast-forward

```
cd "$INSTALL_DIR"
git fetch origin
git log --oneline "HEAD..origin/main" | head -20
git pull -q --ff-only origin main
NEW_SHA=$(git rev-parse HEAD)
echo "PREV_SHA=$PREV_SHA  NEW_SHA=$NEW_SHA"
```

**Expected output:** the `log` line lists the commits about to be applied
(sanity-check these are what you expect — an unexpectedly large or small
list is worth a second look before proceeding); `pull --ff-only` succeeds
silently or prints a fast-forward summary; `NEW_SHA` is a real, different
sha from `PREV_SHA` (identical shas means nothing changed — see the Open
Question in §12 about whether that should still trigger a restart).
**This is the exact command form measured as this repo's own real-world
deploy mechanism** (`docs/deploy-delivery-mechanism.md` §2) — deliberately
reused rather than a fresh invention.

**If `--ff-only` fails** (the local checkout has diverged from
`origin/main` — commits here that aren't on `origin/main`, e.g. from manual
intervention): **STOP.** Do not force, rebase, or reset. This is an Open
Question for `admin-assembly`, not something to resolve by guessing.

**Rollback:** `git reset --hard "$PREV_SHA"` (nothing has restarted yet, so
this alone is sufficient — no service restart needed to "undo" a fetch/pull
that hasn't been loaded into a running process).
**Evidence:** the commit list, `PREV_SHA`, `NEW_SHA`, and confirmation the
pull succeeded cleanly.

### 2.2 Dependencies

```
bun install --frozen-lockfile
```

**Expected output:** installs cleanly (or reports "up to date" if
`bun.lock` didn't change). **`--frozen-lockfile` is deliberate**: it fails
loudly if `bun.lock` and `package.json` disagree, rather than silently
resolving new versions on a production deploy.

**If this fails:** STOP, run `git reset --hard "$PREV_SHA"` in
`$INSTALL_DIR`, and re-run `bun install --frozen-lockfile` to restore the
previous dependency tree before touching anything else.
**Evidence:** the command's full output.

### 2.3 Built-mode only (skip entirely if §1.1 found source-run mode)

```
bun run build
git -C "$INSTALL_DIR" log -1 --format=%H  # confirm this is still $NEW_SHA — build.ts reads git at BUILD time
```

**Expected output:** `built dist/butchr.js (sha=$NEW_SHA, ...)` and
`built dist/butchr-mcp.js` (see `scripts/build/build.ts`) — **the sha
printed here must equal `$NEW_SHA`**; if it doesn't, something changed the
checkout between §2.1 and here, which is itself a failure (STOP, do not
proceed with a stale-looking build).

**Rollback:** same as §2.2 (`git reset --hard "$PREV_SHA"`, then rebuild —
`bun run build` from the restored `$PREV_SHA` regenerates the previous
`dist/`).
**Evidence:** the build command's output, and the confirmation sha check.

---

## 3. Arm the automatic rollback watchdog — BEFORE restarting

This is the mechanism BUTCHR-396 requires: **automatic rollback that does
not depend on the manager surviving the restart.** The restart takes down
every Codey project manager, including whichever one is running this
runbook (§4) — so the thing that decides "did this deploy actually work"
and acts on it must be a *separate* piece of real init infrastructure, not
this agent's own process. `scripts/deploy/watchdog.ts` (added by this task,
tested in `test/unit/deploy-watchdog.test.ts` and
`test/unit/deploy-rollback-decision.test.ts`) plus a **transient
`systemd-run --user --on-active=...` timer** — ordinary systemd, answering
to the user's own systemd instance, not to butchr.service or to this
agent — is that mechanism.

**Trigger conditions, stated explicitly (only one of the two things the
story's own wording names is actually automated here):** the watchdog
checks **`/health` only** — `ok`, and `build.sha` matching the deployed
sha — exactly once, at `$WINDOW_SEC` after arming. It does **not** check
"manager check-in": whether `manager-factory-butchr` (or Bakr's or
Candlestix's manager) has confirmed in the `#team-brooswit-factory` thread
is a separate, human-paced signal, handled by §5's ~10-minute
director-escalation instead — this process has no reliable way to observe
a chat confirmation, and folding it into a 5-minute automatic timer would
either fire far too early (a manager can legitimately take longer than 5
minutes to respawn and post) or not at all. **So: a broken daemon build
rolls back automatically and fast (within `$WINDOW_SEC`); a manager that
doesn't check in escalates to a human, on its own, slower timeline.** Do
not conflate the two when explaining a failure in your evidence.

**What actually gets restored on a rollback, restated from
`scripts/deploy/watchdog.ts`'s own doc comment so it isn't taken as "just a
`git reset`":** `git reset --hard <prevSha>`, then `bun install
--frozen-lockfile` (dependencies are never restored by git alone), then —
**only** when this deploy is in built mode (§1.1) — `bun run build`
(`dist/` is gitignored, so a bare reset leaves the just-built BAD
`dist/butchr.js` in place and a restart would just reload the same broken
build), then `systemctl --user restart <unit>`, then a SECOND `/health`
fetch to verify the rollback itself actually landed on a healthy
`prevSha` — recorded in the state file as `rollbackVerified`, and signalled
by the watchdog's own exit code: `1` means rolled back and verified; `3`
(more serious) means the rollback ran but the restored build still isn't
healthy either, which needs a human immediately (see §6's "if this does
not match" for what to do when you observe a `3`).

### 3.1 Choose the state file path and the window

```
STATE_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/butchr/deploy-watchdog/butchr.service.json"
WINDOW_SEC=300   # 5 minutes — see rationale below; adjust if you have reason to
```

**Rationale for the 300s default:** `docs/linked-eventing-deploy-verification.md`
§1 measured a real restart-to-`/health`-current cycle on this same fleet
completing well under 3 minutes end to end (including, in one observed
case, a second restart to pick up a config edit). 5 minutes gives headroom
over that measurement without leaving Codey on a broken build for long.
**If your own discovery in §1 suggests Codey's restart is slower (larger
`node_modules`, a cold `bun install`, etc.), raise `WINDOW_SEC`
accordingly and say why in your evidence — this is a judgement call this
runbook deliberately leaves to you, the one actually watching it happen.**

### 3.2 Rehearse it first, on a THROWAWAY state file, through a REAL transient timer, before touching the real one

**Do this before §3.3 and before the real restart in §4 — this is the
"test it before the real restart" requirement.** Two things need proving,
separately: (a) the decision logic behaves — covered by `--dry-run`
directly; (b) the actual scheduling path (`systemd-run` → the user's
systemd instance → your `bun` binary, found via ITS OWN PATH, not this
shell's) works at all. **(b) is the part a bare `check --dry-run` from
your own shell can never prove** — a transient unit runs in the user
manager's environment, where `bun` (often installed under `~/.bun/bin`) is
frequently NOT on `PATH`; if that's the case, the real timer would fire,
fail with "command not found", and silently roll back nothing. This
runbook does not assume your shell's `PATH` matches systemd's — it proves
it, once, here.

**(a) Decision logic, via `--dry-run` directly:**

```
TEST_STATE_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/butchr/deploy-watchdog/REHEARSAL.json"
bun run "$INSTALL_DIR/scripts/deploy/watchdog.ts" arm \
  --state-file "$TEST_STATE_FILE" --install-dir "$INSTALL_DIR" --unit butchr.service \
  --port "$PORT" --prev-sha "$PREV_SHA" --expected-sha 0000000000000000000000000000000000dead \
  --window-sec 300 --mode "<source|built, from §1.1>"
bun run "$INSTALL_DIR/scripts/deploy/watchdog.ts" check --state-file "$TEST_STATE_FILE" --dry-run
```

**Expected output:** `check --dry-run` prints `decision: rollback —
running build sha ... does not match the deployed sha 0000...dead` (the
fake expected sha can never match the real running build, forcing the
rollback branch on purpose), followed by `DRY RUN — would run:` lines for
`git reset --hard`, `bun install --frozen-lockfile`, `bun run build` (only
if `--mode built`), and `systemctl --user restart` — **confirm all of them
name the right `$INSTALL_DIR`/`$PREV_SHA`/unit** — and exits `1`.

**(b) The real scheduling path, through an actual `systemd-run` transient
timer, with a short delay and `--dry-run` on the scheduled job itself so
nothing real happens even if everything fires correctly:**

```
REHEARSAL_UNIT=butchr-deploy-watchdog-REHEARSAL
systemd-run --user --on-active=10 --unit="$REHEARSAL_UNIT" -- \
  "$(command -v bun)" run "$INSTALL_DIR/scripts/deploy/watchdog.ts" check --state-file "$TEST_STATE_FILE" --dry-run
sleep 15
journalctl --user -u "$REHEARSAL_UNIT" --no-pager
```

**Expected output:** the journal for `$REHEARSAL_UNIT` contains the SAME
`decision: rollback — ...` and `DRY RUN — would run: ...` lines as (a)
above — proving the transient unit found `bun`, resolved the script path,
and ran it to completion. **If the journal instead shows
`/usr/bin/env: 'bun': No such file or directory` (or `$REHEARSAL_UNIT`
never appears in `systemctl --user list-units --all` at all): STOP —**
this is exactly the PATH failure mode this rehearsal exists to catch. Do
not proceed to §3.3 until this rehearsal passes; `arm` (§3.3) prints its
`systemd-run` command using this SAME process's own absolute `bun` path
(`process.execPath`, never a bare `bun`) for exactly this reason, but that
alone does not prove the user manager can reach that absolute path either
— this rehearsal is the actual proof.

```
systemctl --user stop "$REHEARSAL_UNIT" 2>/dev/null   # in case it's still listed as a completed transient unit
rm -f "$TEST_STATE_FILE"   # cleanup — this was a rehearsal only
```

**Rollback:** none needed — `--dry-run` never touches git, bun-install,
bun-build, or systemctl by construction (see
`test/unit/deploy-watchdog.test.ts`'s `"check --dry-run: ... NEVER calls
git/bun/systemctl"` test) — that is true whether it runs directly or,
as in (b), through a real transient systemd unit.
**Evidence:** paste (a)'s and (b)'s full output (including the journal
capture), and state explicitly that you deleted the rehearsal state file
and confirmed no `$REHEARSAL_UNIT` remains pending afterward.

### 3.3 Arm for real

```
bun run "$INSTALL_DIR/scripts/deploy/watchdog.ts" arm \
  --state-file "$STATE_FILE" --install-dir "$INSTALL_DIR" --unit butchr.service \
  --port "$PORT" --prev-sha "$PREV_SHA" --expected-sha "$NEW_SHA" --window-sec "$WINDOW_SEC" \
  --mode "<source|built, from §1.1 — SAME value you rehearsed with in §3.2>"
```

**Expected output:** `armed: $STATE_FILE` followed by the field summary
(including `mode=...`) and a
`systemd-run --user --on-active=$WINDOW_SEC --unit=butchr-deploy-watchdog-butchr -- <absolute path to bun> run $INSTALL_DIR/scripts/deploy/watchdog.ts check --state-file $STATE_FILE`
line — **the bun path is printed as `arm`'s own `process.execPath`, an
absolute path, never a bare `bun` (this is what §3.2(b) rehearsed working);
copy that exact printed command, do not retype it by hand.**

**If `arm` refuses** (identical prev/expected sha, a non-numeric
`--window-sec`, an out-of-range `--port`, a `--mode` that isn't exactly
`source` or `built`): fix the input named in the error and re-run; this is
a usage error, not a deploy failure — nothing has restarted yet.
**Rollback:** none — arming only writes a state file; delete it
(`rm -f "$STATE_FILE"`) if you decide not to proceed with this deploy at
all.
**Evidence:** the full `arm` output, and the exact `systemd-run` command
you're about to run next (§3.4).

### 3.4 Schedule the check — run the exact command §3.3 printed

```
<paste the systemd-run command §3.3 printed, verbatim>
systemctl --user list-timers --all | grep butchr-deploy-watchdog
```

**Expected output:** `systemd-run` prints
`Running timer as unit: butchr-deploy-watchdog-butchr.timer` (and a paired
`.service`); `list-timers` shows it pending, roughly `$WINDOW_SEC` seconds
from now.

**Rollback:** `systemctl --user stop butchr-deploy-watchdog-butchr.timer`
cancels it outright (also done automatically by §7's `disarm` step on
success).
**Evidence:** both commands' output.

---

## 4. The restart

**Do not restart until §3.4's timer is confirmed pending.** Once armed and
scheduled, the restart itself is safe to perform even if this agent is
about to be killed by it — that is the entire point of §3.

### 4.1 Heads-up — post this EXACT text to `#team-brooswit-factory` first

> Deploying Butchr to Codey's `butchr.service` now — build `$NEW_SHA`
> (previous: `$PREV_SHA`). This restart will take down every Codey project
> manager, including this one (manager-factory-butchr). An automatic
> rollback watchdog is armed (window: `$WINDOW_SEC`s) — if `/health` isn't
> current within that window it will `git reset --hard` back to
> `$PREV_SHA` and restart `butchr.service` again on its own, no human
> needed. Butchr, Bakr and Candlestix managers: please confirm in this
> thread once you're back. If not all three have confirmed within ~10
> minutes, please escalate to Brooswit.

**Evidence:** the exact posted text (with real shas substituted), the
channel, and the timestamp.

### 4.2 Restart

```
systemctl --user restart butchr.service
```

**Expected output:** the command itself is silent on success. Confirm via
`systemctl --user status butchr.service` → `active (running)`, a recent
`ExecMainStartTimestamp`.

**Rollback:** do nothing manually — §3's armed watchdog is already
scheduled to check and, if needed, roll back automatically at
`$WINDOW_SEC`. (You may also roll back manually and immediately, per §6's
"if this does not match" instructions, if you observe a failure before the
timer fires and are still around to act on it.)
**Evidence:** `status` output, and the restart timestamp.

---

## 5. Confirm each manager is back (Execution model requirement)

In the SAME `#team-brooswit-factory` thread from §4.1: wait for
`manager-factory-butchr` (yourself, once respawned), `manager-factory-bakr`
and `manager-factory-candlestix` to each confirm. **If all three have not
confirmed within ~10 minutes, the director escalates to Brooswit** — this
is the director's action, not something this runbook automates; state
plainly in your evidence whether escalation was needed and, if so, that you
notified the director.

**Rollback:** N/A — this step is observational. A manager that never comes
back is itself evidence a rollback may be needed; defer to §6's health
check for the actual verdict (see §3's "Trigger conditions" note — this
step's own ~10-minute escalation and the watchdog's `$WINDOW_SEC` auto-check
are deliberately separate mechanisms, not the same thing).
**Evidence:** screenshot or copy of the thread showing all three
confirmations (or the escalation, if it came to that) with timestamps.

---

## 6. Health check after restart

```
curl -sf "http://127.0.0.1:$PORT/health" | jq .
```

**Expected output:** `ok: true`; `build.sha == "$NEW_SHA"` (built mode:
`build.shaProvenance == "baked"`; source-run mode:
`"git-at-start"` — whichever §1.1 determined); `build.shaDirty == false`.
`currency.verdict.status` should read `"current"` once `origin/main` has
been re-resolved locally — a fresh `"unknown"` right after a restart (the
tracker's own cache, `createCurrencyTracker`, computes lazily) is not
itself a failure; re-curl after a few seconds if you want to confirm it
firms up to `"current"`.

**If this does not match:** do nothing manually — let §3's watchdog fire at
`$WINDOW_SEC` and roll back on its own. **If you want to resolve it sooner
than the window** (you can already tell it's broken, e.g. `curl` gets
connection-refused): you may run the FULL rollback sequence yourself right
now — not just a bare reset (§3's own "what actually gets restored" note
explains why `dist/`/`node_modules` need restoring too):
`git -C "$INSTALL_DIR" reset --hard "$PREV_SHA"`, then
`bun install --frozen-lockfile` (in `$INSTALL_DIR`), then — mode `built`
only — `bun run build`, then `systemctl --user restart butchr.service`,
then re-`curl` `/health` yourself to confirm it's actually healthy on
`$PREV_SHA` before calling it done. Either way, run
`bun run "$INSTALL_DIR/scripts/deploy/watchdog.ts" disarm --state-file "$STATE_FILE" --timer-unit butchr-deploy-watchdog-butchr.timer --reason "manual rollback before window"`
so the still-pending timer doesn't fire a second, redundant rollback later.

**If instead you're reading this because the ARMED WATCHDOG ALREADY FIRED**
(you see its journal entry, or `disarm` reports the state is already
disarmed with a `rolled back: ...` reason): check `state.rollbackVerified`
(`bun run "$INSTALL_DIR/scripts/deploy/watchdog.ts" status --state-file
"$STATE_FILE"` prints the whole state file). **`true`/exit code `1`:** the
known-good build is back and confirmed healthy — proceed to §7. **`false`/
exit code `3`:** the rollback ran but even `$PREV_SHA` isn't coming up
healthy — this is no longer a deploy problem this runbook can resolve
automatically; STOP, do not retry the watchdog or re-run any command in
this document speculatively, and escalate to `admin-assembly` immediately
with the full `/health` output (or lack of one) and the watchdog's own
journal (`journalctl --user -u butchr-deploy-watchdog-butchr`).
**Evidence:** the full `/health` JSON (or the `status` output, if the
watchdog already acted on its own), and — if you rolled back manually —
the disarm command's output too.

---

## 7. Disarm the watchdog once healthy

```
bun run "$INSTALL_DIR/scripts/deploy/watchdog.ts" disarm \
  --state-file "$STATE_FILE" --timer-unit butchr-deploy-watchdog-butchr.timer \
  --reason "confirmed healthy at $(date -u +%FT%TZ) — build $NEW_SHA, /health ok"
systemctl --user list-timers --all | grep butchr-deploy-watchdog || echo "confirmed: no pending watchdog timer"
```

**Expected output:** `disarm` prints `$STATE_FILE: disarmed (...)` and
`stopped pending timer butchr-deploy-watchdog-butchr.timer`; the
`list-timers` grep finds nothing (the `|| echo` fallback fires).

**Do NOT skip this.** If you leave the timer armed after confirming health
yourself, it still fires at `$WINDOW_SEC` and re-checks — harmless in
principle (a second `check` against an already-healthy, unchanged build
just marks itself healthy again, per `decideRollback`'s own idempotent
"already disarmed" / matching-sha "healthy" branches), but disarming
explicitly is the honest record that a human looked and confirmed, rather
than "nothing happened to contradict it."

**Rollback:** N/A — this step only cancels a pending safety net once you've
confirmed you don't need it.
**Evidence:** both commands' output.

---

## 8. Restart-and-recovery verification (Part B step 5)

Confirms: **sentinel-role agents are unaffected by the admission cap**,
**workers are still capped**, and **agents recover with no duplicates**.

### 8.1 Admission snapshot

```
curl -sf "http://127.0.0.1:$PORT/health" | jq '{cap: .admission.cap, residency: .admission.residency, sentinels: .admission.sentinels}'
```

**Expected output:** `cap` matches your `BUTCHR_MAX_AGENTS` config (check
the unit's `Environment=` if unsure); `residency` and `sentinels` are BOTH
non-null integers (`null` on either means no trusted census has completed
yet post-restart — re-run after a few seconds rather than treating a
transient `null` as a failure) and `sentinels` is reported **separately**
from `residency` — this is BUTCHR-398's whole point: a full complement of
sentinel agents (Nexus, the 3 directors, the MUD players once unfrozen)
must never show up inside the capped `residency` count. **If a definition
you know to be `role: "sentinel"` is instead inflating `residency`, STOP —
that is exactly the regression this check exists to catch, not a fleet
issue to route around.**

**Rollback:** this alone is not a deploy-failure signal in the sense
§3/§7 mean (nothing here justifies a code rollback) — but it IS a signal
this deploy did not achieve what BUTCHR-396 needs; escalate rather than
declare Part B done.
**Evidence:** the jq output.

### 8.2 No duplicate agents

```
herdr agent list --json | jq -r '.agents[].name' | sort | uniq -d
```

**Expected output:** **empty** — `uniq -d` only prints names that appear
more than once. Any line here names a duplicate agent (same resource
staffed by two panes at once) and is a failure.

**Rollback:** if duplicates appear, this is very likely a legacy-preflight
or residency-race issue, not something `git reset --hard` fixes by itself
— investigate (`src/daemon/legacy-preflight.ts`,
`src/agents/residency-census.ts`) before declaring this step done; do not
paper over a duplicate by killing one pane without understanding why it
exists.
**Evidence:** the full command output (even though expected-empty, paste
the empty result explicitly — "I ran it and it was empty" is the evidence,
not its absence from your report).

### 8.3 Workers still capped, sentinels are not

If any `role: "sentinel"` definitions are already staffed on Codey at this
point (before BUTCHR-466's cutover work lands, likely none yet — this
sub-step is for whenever sentinels DO exist there): confirm via
`journalctl --user -u butchr.service` (per your OWN discovered unit name,
`--user` always — see the trap named at the top of this document) for the
startup line each rule logs its `role`/capacity setting at, per BUTCHR-396's
own acceptance requirement ("a loud warning for an unflagged ticket-worker
rule" — its absence for your rules files is itself the expected, healthy
case).

```
journalctl --user -u butchr.service --since "-5 minutes" | grep -i "role\|sentinel\|capacity"
```

**Expected output:** no loud warnings about an unflagged ticket-worker rule
losing its cap; any startup lines naming `role` match what each rules
file / session definition actually declares.

**Rollback:** N/A — observational.
**Evidence:** the matched journal lines (or explicit confirmation none
matched, if that's the correct expectation for this Codey deploy's current
rules/definitions).

---

## 9. Real-RC verification hand-off

**Do not re-derive or duplicate this — `docs/real-rc-verification-runbook.md`
(written by S4/BUTCHR-395) is the actual runbook; run it in full, in order,
now that the new build is live and healthy.** This section is only the
checklist of terms Nexus and the director imposed, so you can confirm
you've satisfied every one of them before/while you run it — not a
substitute for reading that document's own ten sections.

- [ ] **Notify Nexus in `#ask-helpdesk` when this step begins** (before any
      test account is created) — see that runbook's §2.
- [ ] **Use the provisioner PAT file Nexus names on Codey — never a shared
      admin token** — §1.1–1.3.
- [ ] **Test accounts use the `butchr-test-` prefix EXACTLY** — §4.
- [ ] **At most 5 concurrent test accounts** (tighter than this codebase's
      own general `ROCKETCHAT_TEMPORARY_CAP_THRESHOLD=8` safety default —
      this 5 is Nexus's specific term for this verification run, not a
      value to relax) — §3.
- [ ] **Test users create no DMs or rooms themselves**; a DM sent TO a test
      user is allowed, but gets deleted along with the user — **capture
      evidence (message exports/screenshots + journal lines) BEFORE
      cleanup**, not after — §4, §9.
- [ ] **Test rooms are owned by the provisioner and explicitly deleted** —
      §4, §9.
- [ ] **Seat count recorded before and after** — §3, §10.
- [ ] **Creation AND deletion of every test account recorded, with
      verification the account and its integration are actually gone —
      not just that a delete call was issued** — §9, §10.
- [ ] The runbook's own §7 (Claude and Codex each receiving and answering a
      channel message) and §8 (the mud-bridge-bound Claude case) both run
      against THIS deploy's live build.

**Rollback:** if the real-RC verification itself fails, that is NOT
necessarily a reason to roll back this code deploy (the failure may be
RC-side, credential-side, or Nexus-policy-side) — follow that runbook's own
§9 "if cleanup fails partway" guidance, and treat a code-level rollback as
a separate decision gated on whether the deploy itself (this document) is
implicated.
**Evidence:** everything that runbook's own §10 (Evidence) already
specifies — post it to `admin-assembly` alongside this deploy's evidence,
cross-referenced by `$NEW_SHA`.

---

## 10. Evidence template

Fill in one row per step above; post the completed table to
`admin-assembly` (plus the §4.1 heads-up and §5 confirmations, already
posted live to `#team-brooswit-factory`).

| Step | Command run | Output (or link to full paste) | Timestamp (UTC) | Pass/Fail |
|---|---|---|---|---|
| 1.1 | | | | |
| 1.2 | | | | |
| 1.3 | | | | |
| 1.4 | | | | |
| 2.1 | | | | |
| 2.2 | | | | |
| 2.3 (built mode only) | | | | |
| 3.2 (rehearsal) | | | | |
| 3.3 | | | | |
| 3.4 | | | | |
| 4.1 (heads-up text posted) | | | | |
| 4.2 | | | | |
| 5 (three confirmations) | | | | |
| 6 | | | | |
| 7 | | | | |
| 8.1 | | | | |
| 8.2 | | | | |
| 8.3 | | | | |
| 9 (real-RC hand-off, full checklist) | | | | |

`PREV_SHA`: ______  `NEW_SHA`: ______  `WINDOW_SEC`: ______
`INSTALL_DIR`: ______  `PORT`: ______  `unit`: ______

---

## 11. Testing the watchdog mechanism itself (already done by this task, restated for the record)

`scripts/deploy/rollback-decision.ts` is the pure healthy/rollback/no-op
decision (`decideRollback`), unit-tested in
`test/unit/deploy-rollback-decision.test.ts` against: a healthy match, an
unreachable `/health`, `ok: false`, a sha mismatch, a missing `build.sha`,
and an already-disarmed state. `scripts/deploy/watchdog.ts`'s CLI (`arm`,
`check`, `disarm`, `status`) is unit-tested in
`test/unit/deploy-watchdog.test.ts` against a fake in-memory IO —
including, specifically: `--dry-run` NEVER calls the injected
git/bun/systemctl functions; a real (non-dry-run) unhealthy check in
`source` mode calls `git reset --hard` → `bun install --frozen-lockfile` →
`systemctl --user restart`, in that order, and never calls the build step;
the same in `built` mode ALSO calls the build step, between install and
restart; a rollback that re-verifies healthy on `prevSha` sets
`rollbackVerified: true` and exits `1`; a rollback whose post-rollback
`/health` is still bad sets `rollbackVerified: false` and exits `3`
(distinctly, not conflated with a verified rollback); and `arm` prints its
suggested `systemd-run` command using an ABSOLUTE bun path, never a bare
`bun`. `bun run check` (this repo's full gate) passes with these included.
§3.2 of this runbook additionally rehearses the real `systemd-run`
scheduling path itself (not just the decision logic) before every actual
deploy — the unit tests prove the code's logic; that rehearsal proves the
Codey-specific environment (PATH, systemd-run availability) the code
actually has to run in.

---

## 12. Open Questions (do not guess — discover them per §1, then record the
## answer here before relying on it elsewhere)

1. **Install directory, unit name, and launch mode (source-run vs
   built)** on Codey — §1.1/§1.2. This document assumes `butchr.service`
   as the unit name (matching this Story's own wording throughout
   BUTCHR-396) but that is Servy's naming convention, not a verified Codey
   fact until you've run §1.1.
2. **Port** — §1.3. `7717` is `config.ts`'s documented default when
   `BUTCHR_PORT` is unset; Codey's actual daemon may set it explicitly (as
   at least one Servy daemon does, per that daemon's own `ENVIRONMENT.md`
   — not evidence for Codey's value).
3. **`loginctl ... Linger` for the account running `butchr.service`** —
   §1.4. If `Linger=no`, the automatic-rollback timer's ability to survive
   a logout is unverified; flag rather than assume it's fine.
4. **Whether a no-op deploy (`PREV_SHA == NEW_SHA`, nothing new on
   `origin/main`) should still restart the unit.** This runbook assumes
   "no" (the watchdog's own `arm` refuses identical prev/expected shas —
   §3.3) — restarting a daemon that changed nothing carries the same
   duplicate-agent/recovery risk as any other restart for zero benefit.
   Confirmed by this document, not yet confirmed by BUTCHR-396's own
   description one way or the other.
5. **`BUTCHR_MAX_AGENTS` on Codey's unit** — needed to sanity-check §8.1's
   `admission.cap` reading against configuration rather than only against
   itself.
