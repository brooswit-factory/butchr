# Windows/WSL host install (FACTORY-64, story FACTORY-59, epic FACTORY-58)

Turns the hand-built "zippy" Windows host (Butchr + herdr inside WSL Ubuntu,
admin-assembly, 2026-09-26) into a documented, scripted, repeatable install —
so a **second** Windows host is a install you can follow, not tribal
knowledge. This is the native-Linux/systemd install path
(`docs/codey-deploy-runbook.md`, the Linux unit `butchr.service`) adapted for
a host whose only Linux environment is WSL. **A native Windows pane backend
is explicitly out of scope** — herdr is Linux-only; this entire setup runs
Butchr and herdr *inside* WSL, with Windows only responsible for keeping the
WSL VM (and the daemon inside it) alive across a reboot/logon.

**Everything in this doc that names a fact about the zippy host itself
(its wsl.conf contents, its unit layout, its tool locations) is a
SECONDHAND REPORT** — relayed from admin-assembly's own comment on the
epic (FACTORY-58), not something this story's own agent observed directly
(the hard constraint below is explicit: never touch zippy's live runtime).
Treat it as the shape this install reproduces, not as a verified fact about
any specific live host.

## Hard constraints (carried over from the story, restated here since a
## reader of this doc may not have read the ticket)

- This install never touches codey's, Servy's, or zippy's live runtimes,
  services, or scheduled tasks. It creates and manages exactly one
  Windows scheduled task, named `Butchr-WSL` by default (override with
  `-TaskName`) — never `Candlestix-Zippy` or `USRR-Zippy`, which belong to
  a different host and a different owner (admin-assembly) entirely.
- Secrets live only in token files: `butchr.env` / `managed-sessions.env`,
  created empty and `0600`, referenced by the systemd unit's
  `EnvironmentFile=`, never written into a script, a unit file, or this
  doc.
- The existing Linux install/systemd path and its docs
  (`docs/codey-deploy-runbook.md`, `scripts/deploy/*`) are unchanged by
  this story — see this ticket's PR description for exactly how that was
  confirmed (`bun run check` green, `git diff --stat` showing no changes
  to those files).

## Design choice: why a bash *wrapper* around a TypeScript CLI, not a
## standalone bash script

The ticket's own default expectation is "a bash script for the WSL-side and
a PowerShell script for the Windows-side." There is a real bash script
(`scripts/wsl-host/install.sh`) and a real PowerShell script
(`scripts/wsl-host/Register-WslHostTask.ps1`) — but the WSL-side script is
deliberately **thin**: it only confirms `bun` is on `PATH` (installing it
from https://bun.sh/install if not) and then execs into
`scripts/wsl-host/cli.ts`. Every actual decision — which prerequisites are
missing, how `/etc/wsl.conf` gets edited, what the two systemd units look
like, whether an env file already exists, how a health check result is
classified — lives in that TypeScript CLI instead, with every shell-out,
file read/write, and network fetch reached through one injected `WslHostIo`
object (`defaultIo()` is the only place any of it is real). This is the
**same pattern this repo's own `scripts/deploy/watchdog.ts` already uses**
for the Linux deploy path — reused here rather than reinvented, because it
is exactly what lets `test/unit/wsl-host-*.test.ts` prove the logic correct
under plain `bun test`, with no real WSL distro, no root, and no real herdr
binary anywhere in this workspace. A pure-bash script doing the same work
would not be meaningfully unit-testable at all under this repo's own
`bun run check` gate.

## Prerequisites

Checked/installed by `scripts/wsl-host/cli.ts install`, matching the zippy
inventory:

| tool | how it's handled |
|---|---|
| `bun` | auto-installed by `install.sh`'s own bootstrap (https://bun.sh/install) before `cli.ts` even runs |
| `git` | auto-installed via `apt-get install -y git` if missing |
| `claude` | **not auto-installed** — detected only. Needs interactive login, which this script cannot do headlessly; reported as a next-step |
| `codex` | same as `claude` — detected only, next-step if missing or its login state can't be confirmed |
| `herdr` | **not auto-installed** — this repo does not vendor or build herdr (checked: no herdr binary under `scripts/vendor/` or `vendor/`; `vendor/brooswit-drovr-freeze.tgz` is an unrelated dependency). Provide one via `--herdr-bin <path>`, or place it yourself at `~/.local/bin/herdr` before running `install` — see https://herdr.dev (this repo's own `README.md` already links it) |

You also need, before running anything here: **WSL2 with an Ubuntu distro
already installed** (`wsl --install -d Ubuntu` from an elevated Windows
PowerShell, then reboot if prompted — standard WSL setup, not something this
story's scripts do), and **an existing clone of this repo inside that
distro** — `install.sh` operates on an existing checkout (the same
"assume the checkout already exists" shape
`docs/codey-deploy-runbook.md`'s own §1.2 uses for the Linux host), it does
not clone the repo for you.

## Step-by-step install

All of this runs **inside the WSL distro** (open the "Ubuntu" app, or
`wsl.exe -d Ubuntu` from a Windows terminal), as the user the daemon should
run as:

```bash
# 1. Clone the repo (skip if you already have a checkout)
mkdir -p ~/.local/share/butchr
git clone https://github.com/brooswit-factory/butchr.git ~/.local/share/butchr/runtime-$(date +%s)
cd ~/.local/share/butchr/runtime-*   # the directory git clone just created
bun install

# 2. Run the installer (see it out first — this changes nothing on disk):
bash scripts/wsl-host/install.sh install --repo-dir "$(pwd)" --dry-run

# 3. Run it for real:
bash scripts/wsl-host/install.sh install --repo-dir "$(pwd)" --default-user "$(whoami)"
```

Read every `[next-step]` line in the output — they are not failures, they
are the things this script genuinely cannot do for you (authenticate
`claude`/`codex`, supply a herdr binary if you didn't pass `--herdr-bin`,
fill in real credentials in the two env files it created empty).

`--repo-dir` becomes the running unit's own `WorkingDirectory=` — pass the
directory you cloned into (`$(pwd)` from inside it, as above). Naming it a
version-stamped directory (`runtime-<short-sha>` in the zippy report, a
timestamp above since this repo has no build step that stamps a short sha
onto the checkout itself) means a future upgrade can clone a fresh checkout
alongside the old one and cut over, rather than `git pull`-ing a running
daemon's own working tree in place — the same reasoning
`docs/codey-deploy-runbook.md` documents for the Linux host's own deploy
step, just without that runbook's build-artifact machinery (this install
always runs source-run mode: `ExecStart=bun run src/daemon/index.ts`, never
a `dist/butchr.js` build).

Useful flags (`bun run scripts/wsl-host/cli.ts install --help` prints the
full, current list):

- `--herdr-bin <path>` — copy a herdr binary you already have into
  `~/.local/bin/herdr` (chmod `+x`), instead of relying on one already being
  there.
- `--config-dir <path>` — where `butchr.env`/`managed-sessions.env` live.
  Defaults to `~/.config/butchr`, a **stable** location independent of the
  versioned `--repo-dir` checkout, deliberately: re-running `install`
  against a fresh checkout (an upgrade) must never orphan or require
  re-entering real credentials.
- `--no-start` — write the units but don't `enable --now` them (useful the
  first time, before `butchr.env` has real credentials in it — see the
  known limitation below).
- `--dry-run` — print the plan, touch nothing.

Idempotency: **re-running `install` makes no destructive changes.**
`/etc/wsl.conf` is edited in place (no duplicate `systemd=true` line, ever —
`test/unit/wsl-host-wsl-conf.test.ts` proves this directly on plain
strings), the two systemd units are rewritten only when their rendered
content actually differs, and `butchr.env`/`managed-sessions.env` are
**never overwritten** once they exist, so a real credential you filled in
survives every future re-run (`test/unit/wsl-host-cli.test.ts`'s
"re-running on an already-installed host" case proves this end-to-end with
injected fakes).

## The systemd units, and why they look like this

Both are **user** units (`~/.config/systemd/user/`), reusing the Linux
host's own unit **name**, `butchr.service` — so an operator who already
knows the Linux path recognises this one immediately (`docs/
codey-deploy-runbook.md` names `butchr.service` throughout). A user unit
needs two things WSL doesn't give you by default, both of which `install`
checks/handles:

1. **`systemd` enabled inside the distro at all** — `/etc/wsl.conf` needs
   `[boot]\nsystemd=true`. `install` edits this file idempotently (see
   above); **a WSL restart is required for it to take effect on a distro
   that didn't already have it** — from Windows, `wsl --shutdown`, then
   reopen the distro.
2. **Lingering enabled for the account**, so the user's own systemd
   instance (and so `butchr.service`/`herdr.service`) keeps running even
   with nobody logged into that WSL session — `loginctl enable-linger
   <user>`, run by `install` every time (itself idempotent: re-enabling an
   already-lingering user is a no-op, not an error).

`butchr.service` (rendered by `scripts/wsl-host/units.ts#renderButchrUnit`):

```ini
[Unit]
Description=Butchr daemon (WSL host)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=<--repo-dir, expanded>
EnvironmentFile=-<config-dir>/butchr.env
EnvironmentFile=-<config-dir>/managed-sessions.env
ExecStart=<bun binary> run src/daemon/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

`EnvironmentFile=-<path>` (leading `-`) makes a **missing** file a silent
no-op for systemd, never a reason the unit refuses to start — deliberate,
since `install` writes the unit before the operator has necessarily filled
in real credentials into the (already-created, empty, `0600`) env files.
`ExecStart` uses the **absolute** `bun` path this process itself ran under
(the same PATH trap `scripts/deploy/watchdog.ts`'s own doc comment names for
its `systemd-run` command — a systemd user unit's own environment is not
guaranteed to include `~/.bun/bin` on `PATH`).

`herdr.service` (`renderHerdrUnit`) plus a `LimitNOFILE` drop-in
(`renderHerdrLimitNofileDropin`, `~/.config/systemd/user/herdr.service.d/
limit-nofile.conf`, raised to 65536 by default) — matching the zippy
report's own "`herdr.service` user unit plus a `LimitNOFILE` drop-in"
shape. herdr holds one pane/pty per running agent, so the default
per-process file-descriptor limit (often 1024) is worth raising explicitly
up front rather than discovering the ceiling live during a busy fleet.

## The Windows autostart task, and why it looks like this

`scripts/wsl-host/Register-WslHostTask.ps1`, run **on Windows** (not inside
WSL), from an elevated or ordinary PowerShell prompt as the account that
should own the task:

```powershell
./Register-WslHostTask.ps1 -DistroName Ubuntu -User <the WSL login user>
# or, to see what it would do first:
./Register-WslHostTask.ps1 -DistroName Ubuntu -User <user> -WhatIf
```

It registers one scheduled task (default name `Butchr-WSL`, generic and
overridable via `-TaskName` — **never** `Candlestix-Zippy`/`USRR-Zippy`, per
the hard constraint above), whose action is:

```
wsl.exe -d <DistroName> -u <User> -- bash -lc "systemctl --user start butchr.service herdr.service"
```

**Trigger: `AtLogOn` for `-User`, plus (by default) a repeating trigger
every 30 minutes (`-RepeatMinutes`, 0 to disable) — not `AtStartup`.** This
is a deliberate choice: a true boot-time (before any interactive logon)
trigger needs a **stored password** (or a gMSA) for the task's run-as
account, which is a materially bigger secret-handling surface than this
story's own "secrets stay in 0600 token files" rule is scoped to cover.
`AtLogOn` needs no stored credential at all — it runs as the
already-authenticated logged-on user — at the cost of "the WSL VM only
comes up once someone logs on," which matches the zippy report's own
framing ("keep the WSL VM up") rather than "start before any login exists."
WSL2 does not keep its VM running on its own once nothing is using it (see
"WSL idle shutdown" below) — the repeating trigger is what actually counters
that between logons, not the one-shot logon trigger alone, since every firing
of the same `wsl.exe` action both wakes the VM (a side effect of any
`wsl.exe` invocation reaching it) and re-confirms the two units are started.
If your host genuinely needs a true no-logon boot start, that's a
deliberately different, higher-privilege setup this script does not attempt
— see "Troubleshooting" below.

`Register-WslHostTask.ps1` is idempotent: re-running it against an
already-registered `-TaskName` unregisters and replaces it with a fresh
definition rather than leaving two tasks of the same name (Windows doesn't
allow that anyway, but this makes the *replace* explicit and visible in the
script's own output) — it **never** touches a task of any other name.

## Health check

Two ways to run it, from two different vantage points, on purpose — only
one of them can actually observe "is WSL itself up at all," since from
*inside* WSL, WSL is definitionally up:

**From Windows** (the one that can see "WSL down"):

```powershell
./Verify-WslHost.ps1 -DistroName Ubuntu -User <user> -RepoDir /home/<user>/.local/share/butchr/runtime-<...>
```

**From inside WSL** (assumes WSL is up, since you're running commands
inside it — only distinguishes daemon-down vs healthy):

```bash
bun run scripts/wsl-host/cli.ts verify
```

Both print one of exactly three states, with the SAME wording and exit code
either way (`Verify-WslHost.ps1` delegates everything except "is WSL up" to
the Linux-side `cli.ts verify`, so there is one source of truth for the
daemon-level verdict, not two drifting reimplementations):

| state | exit code | example output | meaning |
|---|---|---|---|
| WSL down | 2 | `WSL: DOWN (distro not running)` | the distro itself isn't up — nothing inside it can be checked at all |
| daemon down | 1 | `WSL: UP, daemon: DOWN (butchr.service is not active)` | WSL is up, but systemd isn't active, the unit isn't active, the port doesn't answer, or `/health` reports `ok: false` — the printed reason names which |
| healthy | 0 | `WSL: UP, daemon: UP (/health reports ok)` | both are fine |

A "daemon down" verdict caused by an inactive/failed unit also prints the
last ~20 lines of `journalctl --user -u butchr.service` — this is how you
tell an ordinary crash apart from the known limitation below, which looks
identical from `systemctl is-active` alone.

`scripts/wsl-host/health.ts`'s classification is unit-tested directly
(`test/unit/wsl-host-health.test.ts`) against every one of the states above,
including the two "can't tell" cases (`systemdActive: null`, `health: null`)
— both are treated as **daemon-down**, never silently assumed healthy, the
same governing rule `scripts/deploy/rollback-decision.ts` already documents
for the Linux watchdog ("an unreachable /health is treated exactly like an
unhealthy one").

## Known limitation: Atlassian credentials are currently required at startup

As of this writing, `src/config/config.ts` unconditionally calls
`required(...)` on `ATLASSIAN_SITE`/`ATLASSIAN_EMAIL`/`ATLASSIAN_TOKEN`(`_FILE`)
at daemon startup — **verify this yourself against that file**, since it is
exactly the kind of thing that can change after this doc is written. A
managed-sessions-only host (this story's own target shape: a Codex singleton
query-agent plus a director session, no Jira-driven ticket work at all)
still needs these set today, or the daemon crashes on startup — which, from
`systemctl --user is-active`/`cli.ts verify` alone, looks identical to any
other startup crash (**`daemon-down`**, not a fourth state). This is
tracked separately as **FACTORY-65** ("Allow Butchr to start without
Atlassian credentials on managed-sessions-only hosts") — explicitly **not**
implemented by this story. Until FACTORY-65 ships, `butchr.env` on a
Windows/WSL host needs real Atlassian credentials even if the host never
does any Jira-driven work, and a "daemon down" verdict with a journal tail
mentioning `ATLASSIAN_SITE`/`ATLASSIAN_EMAIL`/`ATLASSIAN_TOKEN` in it means
exactly this, not a bug in this install.

## Networking: WSL2 is NAT, not mirrored

Per the zippy report: WSL2 networking here is **NAT mode**, so a
Windows-side `127.0.0.1` service (the zippy report specifically names the
"rocketr bridges") is **not reachable from inside WSL**, and — the direction
that matters for this doc — a WSL-internal `127.0.0.1:<port>` is not
generally reachable from Windows either, without extra port-forwarding this
install does not set up. This is why the health check design above never
fetches `/health` from the Windows side directly: `Verify-WslHost.ps1`
always reaches the daemon's `/health` endpoint by executing `cli.ts verify`
*inside* the distro via `wsl.exe`, never by curling the port from Windows.
If your distro instead uses WSL's newer "mirrored" networking mode, this
constraint may not apply to you — this doc does not assume mirrored mode,
since the zippy report explicitly named NAT.

## Managed sessions on this host

A WSL host is expected to run the same two kinds of managed session the
zippy report names — a Codex singleton query-agent
(`dev-windows-zippy`-shaped) and a director session
(`director-brooswit-unity`-shaped) — configured exactly the way
**`docs/managed-sessions.md`** already documents in full (manifest format,
the `BUTCHR_SESSION_DEFINITIONS_DIR` env var, `vendor`/`tier`/`role`, the
`butchr session` CLI). This doc does not repeat any of that — see that doc
directly. `managed-sessions.env` (created empty by `install`, referenced by
`butchr.service`'s `EnvironmentFile=`) is where `BUTCHR_SESSION_DEFINITIONS_DIR`
and `BUTCHR_AGENT_PROVIDER=codex` (the zippy report's own choice of default
provider — set `claude` instead if that's what your host's sessions should
default to) belong.

## Token/secret handling

- `butchr.env` and `managed-sessions.env` are created **empty and `0600`**
  by `install` — **only if absent**; a real, already-filled-in file is
  never touched. Fill in `ATLASSIAN_SITE`/`ATLASSIAN_EMAIL`/
  `ATLASSIAN_TOKEN_FILE` (preferred over inline `ATLASSIAN_TOKEN` — see
  `.env.example`) at minimum, plus anything `managed-sessions.env` needs
  for your session definitions.
- Nothing here ever writes a credential value into a script, a systemd unit
  file, or this doc — units reference the two env files by path only
  (`EnvironmentFile=`), never inline a secret.
- Point a token *file* var (`ATLASSIAN_TOKEN_FILE`, `GITHUB_TOKEN_FILE`, …)
  at a file outside this repo's own checkout, same as `.env.example`
  already recommends for the Linux path.

## Troubleshooting

- **`systemd not enabled inside WSL`** — symptom: `systemctl --user ...`
  fails entirely (not "unit not found," the whole systemd user instance
  isn't there). Check `/etc/wsl.conf` has `[boot]\nsystemd=true` (`install`
  sets this, but only takes effect after a WSL restart). Fix: `wsl --shutdown`
  from Windows, then reopen the distro.
- **`linger off`** — symptom: the daemon stops as soon as the WSL window/
  session that started it closes. Check: `loginctl show-user <user> -p
  Linger` should read `Linger=yes`. Fix: `loginctl enable-linger <user>`
  (`install` already runs this — re-running `install` is the simplest fix
  if it somehow got disabled).
- **`WSL idle shutdown`** — symptom: the daemon was healthy, then
  `Verify-WslHost.ps1` reports `WSL: DOWN` with nobody having touched
  anything — WSL2 shuts its VM down once nothing is actively using it.
  This is exactly what the Windows scheduled task's repeating trigger
  (`-RepeatMinutes`, default 30) exists to counter; if it's disabled
  (`-RepeatMinutes 0`) or the task isn't registered at all, the VM will idle
  out between logons.
- **`distro not found`** — symptom: `wsl.exe -d <name>` (or
  `Verify-WslHost.ps1 -DistroName <name>`) fails immediately. Check the
  exact registered name with `wsl -l -q` from Windows — it must match
  `-DistroName`/`-TaskName`'s target byte-for-byte (case matters on some
  Windows builds).
- **`daemon down with an Atlassian-credentials-shaped journal tail`** — see
  "Known limitation" above (FACTORY-65) before assuming this install is
  broken.

## What was and wasn't tested off-Windows

This workspace has no Windows host and no real WSL distro at all — nothing
here was exercised against a real Windows/WSL environment. What **was**
tested, under plain `bun test` on Linux:

- `scripts/wsl-host/wsl-conf.ts` (`ensureWslConf`) — every idempotency case
  (empty file, already-correct, wrong value rewritten in place, adding
  `[user] default=` alongside an existing `[boot]` section, preserving
  unrelated sections/comments) against plain strings.
- `scripts/wsl-host/units.ts` — both systemd units and the `LimitNOFILE`
  drop-in render deterministically from given inputs.
- `scripts/wsl-host/health.ts` (`classifyWslHealth`) — every one of the
  three states, including both "couldn't determine" cases, proven never to
  fall through to `healthy` by accident.
- `scripts/wsl-host/cli.ts` (`install`/`verify`) — full CLI behavior against
  an **injected, in-memory** filesystem/exec fake: a fresh install writes
  every expected file and reports herdr as a next-step when no binary is
  available; `--herdr-bin` copies and chmods it; a missing `--herdr-bin`
  path is reported as an error without crashing the rest of the run; a
  second `install` run against the same (simulated) host reports every
  already-correct step as `skipped` and — critically — never overwrites an
  env file that already has real-looking credentials in it; `--dry-run`
  makes zero writes; a missing prerequisite is a `next-step`, never a
  failure; `verify` correctly classifies systemd-not-running,
  unit-inactive-with-journal-tail, and healthy, and honours `--port`/
  `--unit`.

What was **not**, and cannot be, tested here: `install.sh`'s own bun
bootstrap (the `curl | bash` line itself), any real `apt-get`/`loginctl`/
`systemctl` invocation, any real WSL distro state transition, and both
PowerShell scripts end-to-end (`Register-WslHostTask.ps1`,
`Verify-WslHost.ps1`) — neither can run at all outside a real Windows host.
Treat every claim in this doc about what happens ON a Windows/WSL host as a
design intent proven correct at the *logic* level, not as something
observed working end-to-end. If you run this install for real and something
in this doc turns out wrong, that observation wins — update this doc, don't
trust it over what you just measured (same rule this factory's own ASSIST
space documents for every other doc like it).
