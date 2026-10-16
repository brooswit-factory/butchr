# Windows native host install (FACTORY-560, epic FACTORY-555)

Turns "run Butchr + herdr directly on Windows" into a scripted,
repeatable install: a Scheduled Task that starts `herdr server` then the
butchr daemon at logon, restarts on failure, logs to rotating files instead
of journald, and a Windows-native `windows-task` diagnostics kind so an
agent working on a Windows host can find its own logs without `systemctl`/
`journalctl` existing at all. This is the **native** path — no WSL, no
Linux environment anywhere — distinct from `docs/windows-wsl-host.md`
(FACTORY-64), which runs Butchr+herdr *inside* WSL. Follow this doc if
you're installing directly onto Windows; follow that one if your host runs
WSL and you want the Linux-native systemd path inside it.

**This workspace has no Windows host at all.** Everything in this doc about
what a Windows Scheduled Task, `tasklist`, or PowerShell actually does when
run for real is design intent reasoned from documented behavior, proven
correct only at the *logic* level (see "What was and wasn't tested" below)
— the same honesty `docs/windows-wsl-host.md` already states for its own
PowerShell scripts, and for the same reason: nothing here can be exercised
against a real Windows host from this repo's own CI or this ticket's own
agent.

## Hard constraints

- **Non-elevated, interactive-session only, by default.** The spike this
  ticket's own comment relays found that herdr on Windows refuses a shared
  client that inherited administrator privileges — starting herdr from an
  elevated (or ssh) session breaks it. `install.ps1`'s default
  `-LogonType Interactive -RunLevel Limited` + `AtLogOn` trigger needs no
  stored password and never elevates. The optional `-RunWhetherLoggedOnOrNot`
  switch trades this for `LogonType S4U` (also no stored password, but a
  non-interactive Session 0) — **unverified**, off by default; see
  `install.ps1`'s own parameter help before using it.
- **herdr starts before the daemon, always.** The daemon already refuses to
  start until herdr answers (`src/daemon/missing-rules-preflight.ts`'s
  "Refusing to start ... Start herdr and retry"); `launcher.ts` (the task's
  actual action) starts herdr, waits a fixed grace period, then starts the
  daemon — see `launcher.ts`'s own doc comment for why this is a grace
  period and not a readiness poll.
- **No admin rights required**, and none of these scripts request
  elevation.
- **No credentials in any script or task definition.** Secrets live only in
  `butchr.env`, created empty by `cli.ts install`, read by `launcher.ts`'s
  own `parseEnvFile` and merged into the daemon's environment at spawn
  time — never inlined into the Scheduled Task's action string or any file
  in this repo.
- This install never touches a Scheduled Task other than the one named by
  `-TaskName` (default `Butchr-Native`) — `install.ps1`/`uninstall.ps1` both
  only ever register/replace/unregister that one name, by construction.

## Design choice: why the real logic lives in `cli.ts`/`launcher.ts`, not the `.ps1` files

Same split `scripts/wsl-host/install.sh` already uses for the WSL path,
adapted for a host with no cross-boundary `wsl.exe` exec to route through:
`install.ps1`/`uninstall.ps1`/`verify.ps1` are deliberately thin. Everything
that CAN be proven correct under `bun test` — the `herdr` prerequisite
check, creating the log directory and the env file, and `verify`'s
herdr/health classification (`scripts/windows-host/health.ts`'s
`classifyWindowsHostHealth`, mirroring `scripts/wsl-host/health.ts`'s own
tri-state design) — lives in `scripts/windows-host/cli.ts`, exercised by
`test/unit/windows-host-cli.test.ts`/`test/unit/windows-host-health.test.ts`
against injected fakes, no real Windows APIs anywhere. `launcher.ts` (the
task's actual action — starts herdr, waits, starts the daemon, rotates
logs, sets the two `BUTCHR_WINDOWS_*` env vars) is tested the same way
(`test/unit/windows-host-launcher.test.ts`) via an injected `LauncherIo`.

What does NOT live in TypeScript: registering/unregistering the Scheduled
Task itself. `Register-ScheduledTask`/`Unregister-ScheduledTask` are
PowerShell-only cmdlets with no standalone executable to shell out to, so
that one step stays real, untested PowerShell in `install.ps1`/
`uninstall.ps1` — the exact same "the one genuinely Windows-only step stays
real PowerShell, everything else lives in a tested CLI" split
`docs/windows-wsl-host.md` documents for `Register-WslHostTask.ps1`.

## Step-by-step install

Run this **on the Windows host itself**, from an ordinary (non-elevated,
non-ssh) PowerShell prompt, in the account that should run the daemon:

```powershell
# 1. Clone the repo (skip if you already have a checkout), then:
cd C:\butchr
bun install

# 2. See what would happen first — this changes nothing:
.\scripts\windows-host\install.ps1 -RepoDir C:\butchr -DryRun

# 3. Run it for real:
.\scripts\windows-host\install.ps1 -RepoDir C:\butchr
```

Read the `[next-step]` lines: `herdr` is **not auto-installed** (this repo
doesn't vendor or build it — same story as the WSL path; see
https://herdr.dev), and the created `butchr.env` starts empty — fill in
`ATLASSIAN_SITE`/`ATLASSIAN_EMAIL`/`ATLASSIAN_TOKEN_FILE` (or
`ATLASSIAN_TOKEN`) before the daemon can start successfully (see the known
limitation `docs/windows-wsl-host.md` already documents for the same
`config.ts` requirement — it applies here unchanged, this story doesn't
touch it).

Useful parameters (`Get-Help .\install.ps1 -Full` prints everything):

- `-TaskName <name>` — default `Butchr-Native`; pass a host-scoped name
  (e.g. `Butchr-Native-Zippy`) if this host runs another supervisor's own
  scheduled tasks too, same reasoning `docs/windows-wsl-host.md`'s own
  "Scheduled task name collisions" section gives for `Butchr-WSL`.
- `-EnvFile <path>` / `-LogDir <path>` — override the defaults
  (`%APPDATA%\butchr\butchr.env`, `%LOCALAPPDATA%\butchr\logs`).
- `-HerdrGraceSeconds <n>` — default 5; how long `launcher.ts` waits after
  starting herdr before starting the daemon.
- `-DryRun` — print the plan, touch nothing.

Idempotency: re-running `install.ps1` never overwrites `butchr.env`, never
duplicates the log directory, and replaces (never duplicates) an
already-registered task under the same `-TaskName`.

## Running it now / checking it

```powershell
schtasks /run /tn "Butchr-Native"
.\scripts\windows-host\verify.ps1
```

`verify.ps1` prints the Scheduled Task's own last-run info, then one of
three states (same exit-code contract `scripts/windows-host/health.ts`
defines, `WINDOWS_HOST_HEALTH_EXIT_CODES`):

| state | exit code | example output | meaning |
|---|---|---|---|
| herdr down | 2 | `herdr: DOWN (no herdr process found)` | herdr isn't running at all — nothing past this can be trusted, the daemon cannot have started successfully without it |
| daemon down | 1 | `herdr: UP, daemon: DOWN (/health did not answer)` | herdr is up, but the daemon's own `/health` doesn't answer or reports `ok: false` — the printed reason names which, and the last ~40 lines of `butchr.log` are printed below it |
| healthy | 0 | `herdr: UP, daemon: UP (/health reports ok)` | both are fine |

herdr-down is checked **first** and short-circuits everything else — the
same "the more fundamental prerequisite's failure is never reported as the
narrower one" shape `scripts/wsl-host/health.ts`'s own wsl-down/daemon-down
split uses.

## Diagnostics without systemd/journalctl (`windows-task` kind)

`src/agents/ground-truth.ts`'s `SystemdInfo` gained a fourth kind,
`windows-task`, for exactly this host shape. `launcher.ts` sets two env
vars on the daemon's own process before spawning it —
`BUTCHR_WINDOWS_TASK_NAME` (the task name) and `BUTCHR_WINDOWS_LOG_FILE`
(the daemon's own rotating log path) — and
`parseWindowsTaskEnv`/`readSystemdInfo` read them back on a Windows host
the same way `parseCgroup` reads a systemd unit's own cgroup membership on
Linux. `groundTruthText` (the block written into a workspace's own
`ENVIRONMENT.md`/`CLAUDE.md`) relabels the two affected lines for this kind
— `scheduled task: <name>` and `diagnostics: Get-Content -Path "<log file>"
-Tail 200 -Wait` — rather than calling a Scheduled Task a "systemd unit" or
a `Get-Content` invocation "journalctl"; every other kind (`user`, `system`,
`none`) keeps its original label and wording unchanged.
`toBuildReport`/`/health`'s own `build` field, and
`scripts/audit-alias-calls.ts`'s cross-user journal tooling, need no
`windows-task`-specific branch at all: that kind reuses the exact same
`unit`/`journalctl` field shape the two systemd kinds already use (see
`SystemdInfo`'s own doc comment in `ground-truth.ts` for why), so every
existing caller that narrows on `kind !== "none"` keeps compiling and
behaving sensibly.

A daemon started by hand (`bun run src/daemon/index.ts` from an ordinary
terminal, not via the Scheduled Task) never claims a task/log file it
doesn't have — `parseWindowsTaskEnv` requires BOTH env vars, non-blank, or
it's an honest `{ kind: "none" }`, the same "never a guessed unit" rule
`parseCgroup` already follows.

## Log rotation

`launcher.ts` rotates `herdr.log`/`butchr.log` (under `-LogDir`) once a
file reaches `-MaxLogBytes` (10 MiB by default) — exactly one backup
generation is kept (`<name>.log.old`, overwritten on the next rotation),
checked once at launcher start (task restart, or the next logon, is what
re-triggers the check — there is no in-process size watcher). This is
simpler than systemd-journald's own built-in rotation/retention policy by
design: there is no Windows-native equivalent this install can defer to,
so it implements the minimum that keeps a single runaway log from growing
unbounded, not a full retention scheme.

## Token/secret handling

- `butchr.env` is created **empty**, only if absent — a real, already-filled
  -in file is never touched by a re-run of `install.ps1`.
- **Known limitation, unlike the Linux/WSL path:** `install.ps1` does not
  set an NTFS ACL on `butchr.env` (Unix's `chmod 0600`, which
  `scripts/wsl-host/cli.ts` does set, has no direct Windows-native
  equivalent this script applies for you). Restrict the file's permissions
  to your own account yourself (right-click → Properties → Security, or
  `icacls`) if this host is shared with other users.
- Nothing here ever writes a credential into a script, the Scheduled Task's
  action string, or this doc — `launcher.ts` reads `butchr.env` by path
  only, at spawn time.

## Coexisting with another supervisor on the same host

Same ownership-boundary shape `docs/windows-wsl-host.md` documents for the
WSL host, simplified for having no WSL layer at all:

| | Butchr's install owns | The other supervisor owns |
|---|---|---|
| Scheduled Task | Exactly one task, named by `-TaskName` (default `Butchr-Native`) — `install.ps1`/`uninstall.ps1` never enumerate or touch any other task | Its own task(s), under whatever name(s) it chooses |
| Credentials | `butchr.env` only | Its own separate credential store |
| Logs | `-LogDir` (default `%LOCALAPPDATA%\butchr\logs`) | Its own logs, wherever it puts them |

Pick a host-scoped `-TaskName` (e.g. `Butchr-Native-Zippy`) on a host that
already runs, or will run, another supervisor's own tasks — the generic
default can otherwise collide by name with something unrelated on a
differently-managed host.

## Troubleshooting

- **`herdr: DOWN` right after a fresh install/logon** — `launcher.ts`'s
  grace period (default 5s) may simply not have been long enough yet on
  this host; re-run `verify.ps1` a few seconds later before assuming
  anything is broken. If it persists, confirm `herdr` is actually on PATH
  for the account the task runs as (`Get-Command herdr` from an ordinary,
  non-elevated PowerShell prompt logged in as that account).
- **daemon down with a missing-Atlassian-credentials-shaped log tail** —
  same known limitation `docs/windows-wsl-host.md` documents (FACTORY-65,
  `src/config/config.ts`'s unconditional `required(...)` calls) — verify
  against that file directly, since it can change after this doc is
  written.
- **task never fires** — confirm it's actually registered
  (`Get-ScheduledTask -TaskName Butchr-Native`) and that you're logging on
  interactively (the default `LogonType Interactive` needs an actual logon
  event, not a remote/ssh session — see "Hard constraints" above).
- **`powershell`/`cmd` interop failures from a herdr-owned pane** — this is
  the native-Windows host; the WSL-specific `WSL_INTEROP`/systemd-drop-in
  workaround `docs/windows-wsl-host.md` describes does not apply here at
  all (there is no WSL layer to lose the socket for) — if you see something
  that looks like that symptom on a native host, it is a different problem
  and should be investigated fresh, not treated as the same known issue.

## Unity build environment (headless WebGL, FACTORY-563)

Out of scope here: actually running a build. This section is a checklist
for admin-assembly to get zippy able to run one by hand later (GK-8,
project GK, epic GK-7); FACTORY-563 documents and scripts the checklist
only. Everything below needs a human with real zippy access and Brooswit's
own Unity credentials — nothing in this repo can perform any of it.

**Target:** Unity **6000.0.20f1** — the version already running the manual
GoodKnight builds referenced from GK-1 through GK-5 (per GK-8's own ticket
comments); confirm this is still the version installed on zippy before
trusting it, since a local Editor upgrade wouldn't be visible from this
repo.

### 1. Unity Hub + Editor + WebGL module

Install via [Unity Hub's own CLI](https://docs.unity3d.com/hub/manual/HubCLI.html)
(`unityhub` on PATH once Hub itself is installed) rather than the GUI
installer, so this step is scriptable and repeatable:

```powershell
unityhub -- --headless install --version 6000.0.20f1 --module webgl --changeset <changeset-for-6000.0.20f1>
```

The `--changeset` value is Editor-version-specific and not reproduced here
— Unity Hub's own release-notes/archive page for `6000.0.20f1` names it;
look it up at install time rather than trusting a copied value that could
already be stale. `scripts/windows-host/verify-unity-build-env.ps1` (below)
checks whether an Editor at this version, with the WebGL module, is
already present — run it first; it may already be done.

### 2. License activation (`.ulf`)

**The license file and `UNITY_PASSWORD` are Brooswit's — never commit
either to git, paste either into a Jira/Confluence comment, or post either
into chat.** Per GK-8's own comment thread: a Unity Personal entitlement
(`UnityEntitlementLicense.xml`) already exists on zippy from prior manual
Editor use, but that XML is **not** the `.ulf` format a scripted/CI
activation needs — generating the actual `.ulf` requires Unity Hub's own
`Preferences > Licenses > Add > Get a free personal license` flow (click Add
even if Hub already shows a licence: Hub can show one without writing the
file). The manual `.alf` route (`-createManualActivationFile`, upload at
https://license.unity3d.com/manual) is NOT supported for Unity Personal per
the Unity 6 manual; GameCI documents only an unverified browser dev-tools
workaround for it. Never put the password on a command line.

Once obtained, the `.ulf` goes at Unity's own default per-machine license
location — `C:\ProgramData\Unity\Unity_lic.ulf` (the script also accepts the `config\` variant) — **never** inside
this repo or `%USERPROFILE%\butchr*`. `scripts/windows-host/verify-unity-build-env.ps1`
checks for its presence at that path (existence only — it never reads or
prints license content) and reports missing/present, nothing more.

### 3. `git-lfs`

GoodKnight's own asset pipeline (per GK-8's build notes) needs `git-lfs` on
PATH for a clone/checkout to pull real asset content rather than pointer
files:

```powershell
winget install -e --id GitHub.GitLFS
git lfs install
```

### 4. Smoke build command

**Placeholder — GoodKnight PR #4's own CI workflow was not reachable from
this checkout** (private repo, `brooswit-unity/GoodKnight`; `gh pr view 4
--repo brooswit-unity/GoodKnight` returned "Could not resolve to a
Repository" against this session's own `gh` auth) to copy its real
`-executeMethod` target. Verify the actual method name against that PR's
CI workflow file directly before using this for anything beyond a dry read
of the pattern:

```powershell
& "C:\Program Files\Unity\Hub\Editor\6000.0.20f1\Editor\Unity.exe" `
  -batchmode -nographics -quit `
  -projectPath "<path-to-GoodKnight-checkout>" `
  -executeMethod GoodKnight.Build.WebGLReleaseBuild `
  -logFile -
```

`-logFile -` streams the log to stdout instead of Unity's default log file
— useful for a first, interactive smoke run; drop it (or point it at a real
path) for anything unattended. This command is **not run by FACTORY-563**
— per that ticket's own scope comment, running the build is explicitly out
of scope for this pass; a later ticket exercises it for real and reports
the actual command/duration/output path.

### Runbook — admin-assembly only

1. Confirm the Unity Editor version currently installed on zippy still
   matches `6000.0.20f1` (or update the target above if it's moved on).
2. Run `.\scripts\windows-host\verify-unity-build-env.ps1` first — it may
   already report Hub/Editor/module/git-lfs present and only the `.ulf`
   missing, narrowing what's actually left.
3. Install Unity Hub + the `6000.0.20f1` Editor + WebGL module (section 1)
   if the checklist script reports them missing.
4. Obtain `UNITY_PASSWORD` from Brooswit directly (never relayed through a
   ticket/chat) and generate/place the real `.ulf` (section 2) — this step
   cannot be delegated to a scripted flow without a human present for the
   manual-activation upload step.
5. Install `git-lfs` (section 3) if the checklist script reports it
   missing, and run `git lfs pull` inside the GoodKnight checkout once
   cloned.
6. Verify the real `-executeMethod` target against GoodKnight PR #4's own
   CI workflow (section 4) — this doc's value is a placeholder.
7. Only once 1-6 are done: run the smoke command (section 4) by hand, once,
   to confirm the environment actually builds — this is the first point at
   which anything in this checklist actually invokes Unity. Report the
   exact command, duration, and output path on whichever ticket picks that
   up next (not this one).

## What was and wasn't tested off-Windows

This workspace has no Windows host at all — nothing here was exercised
against a real one. What **was** tested, under plain `bun test` on Linux:

- `src/agents/ground-truth.ts`'s `parseWindowsTaskEnv` and the
  `windows-task`-aware branches of `groundTruthText` — every case (both
  vars present, either missing, blank/whitespace-only, neither set) —
  plus `build-identity.ts#toBuildReport` flattening a `windows-task`
  `SystemdInfo` the same way it flattens a systemd one.
- `scripts/windows-host/health.ts#classifyWindowsHostHealth` — every one of
  the three states, including both "herdr presence unknown" and "`/health`
  unreachable," proven never to fall through to `healthy` by accident.
- `scripts/windows-host/cli.ts` — `install`/`verify` against an injected,
  in-memory fake (no real `tasklist`, no real filesystem): a fresh install
  creates the log dir and env file and reports herdr as a next-step when
  not found on PATH; a second run reports both as skipped and never
  overwrites a real-looking env file; `--dry-run` makes zero writes;
  `verify` correctly classifies herdr-not-found, herdr-presence-unknown
  (`tasklist` itself failing), daemon-down (with the log tail surfaced),
  and healthy, and honours `--port`/`--herdr-process-name`/`--log-file`.
- `scripts/windows-host/launcher.ts` — `parseEnvFile` (comments, blank
  lines, quoted values, a stray line with no `=`, a value containing its
  own `=`) and `planLogRotation` as pure functions; `runLauncher`'s own
  ORDERING (herdr spawned, then the grace sleep, then the daemon — never
  any other order), that the daemon's env always carries
  `BUTCHR_WINDOWS_TASK_NAME`/`BUTCHR_WINDOWS_LOG_FILE` merged with the env
  file's own vars, that a log at/over `-MaxLogBytes` is rotated and one
  under it is left alone, and that the daemon's own exit code is returned
  verbatim — all against an injected `LauncherIo`, no real process spawned.

What was **not**, and cannot be, tested here: any real `Register-
ScheduledTask`/`Unregister-ScheduledTask`/`tasklist` invocation, the bun
bootstrap in `install.ps1`/`verify.ps1` (the `irm bun.sh/install.ps1 | iex`
line itself), any real herdr process or its actual startup timing (so
`-HerdrGraceSeconds`'s default of 5 is a starting guess, not a measured
value), and all three `.ps1` files end-to-end — none can run at all outside
a real Windows host. In particular, the `-RunWhetherLoggedOnOrNot` /
`LogonType S4U` path is reasoning about documented Task Scheduler behavior,
not an observed result, and herdr's own behavior in a non-interactive
Session 0 (rather than the spike-validated interactive session) is
unverified — treat it as a documented option, not a recommendation, until
it's been run for real. If you run this install and something here turns
out wrong, that observation wins — update this doc, don't trust it over
what you just measured.

The same honesty applies to the "Unity build environment" section above:
`scripts/windows-host/verify-unity-build-env.ps1` only does read-only
existence checks (`Get-Command`, `Test-Path`), never invokes Unity or
Unity Hub, and was exercised here only as plain PowerShell syntax-checked
by `Get-Command -Syntax`/manual read — no real Unity Hub, Editor, or `.ulf`
was available to check it against. The `-executeMethod` target and
`--changeset` value are explicitly flagged placeholders above, not
observed facts; treat the whole Unity section as unverified until someone
with zippy access runs it for real and reports back what was wrong.
