<#
.SYNOPSIS
FACTORY-560: installs Butchr + herdr as a native Windows autostart — a
Scheduled Task that starts `herdr server` then the butchr daemon
(`bun run src/daemon/index.ts`) at logon, restarting on failure, with
stdout/stderr going to rotating log files instead of journald.

.DESCRIPTION
Deliberately thin, mirroring `scripts/wsl-host/install.sh`'s own split: it
confirms `bun` is on PATH (installing it from https://bun.sh/install if
not), runs `scripts/windows-host/cli.ts install` for everything that CAN be
proven correct under `bun test` (the `herdr` prerequisite check, the log
directory, the env file — see that file's own doc comment), and THEN
registers the Scheduled Task itself with `Register-ScheduledTask` — a
PowerShell-only cmdlet with no standalone executable, so it cannot live in
the tested CLI and is real, untested PowerShell here, the same "the one
genuinely Windows-only step stays real PowerShell" split
`docs/windows-wsl-host.md` documents for `Register-WslHostTask.ps1`.

**Requirements from the zippy spike (FACTORY-560's own comment), built in:**

1. **Runs in the user's own interactive logon session, non-elevated.**
   `-Principal` is `LogonType Interactive, RunLevel Limited`, trigger
   `AtLogOn` for the invoking user — never elevated. This is a hard
   requirement, not a default: herdr on Windows refuses shared clients that
   inherit administrator privileges (the spike's own report: "herdr 0.9.3
   started elevated ... plain codex refuses"). Do NOT run this script, or
   the task it creates, from an elevated/ssh session.
2. **herdr starts before the daemon.** The task's action is
   `<bun> run <repoDir>\scripts\windows-host\launcher.ts`
   (`launcher.ts`'s own doc comment has the full ordering rationale) — never
   the daemon directly. The daemon itself already refuses to start until
   herdr answers (`src/daemon/missing-rules-preflight.ts`'s "Refusing to
   start ... Start herdr and retry"); the launcher just makes the ordering
   automatic instead of manual.
3. **No admin rights required**, by construction: `Register-ScheduledTask`
   with `RunLevel Limited` and a logon-type that needs no stored password
   does not require an elevated PowerShell session to register.
4. **No credentials in this script or the task definition.** Secrets live
   only in `butchr.env` (created empty by `cli.ts install`, referenced by
   `launcher.ts`'s own env-file parsing — see that file's `parseEnvFile`),
   never inlined into the task's action string or this script.

.PARAMETER RepoDir
Absolute path to an existing clone of this repo (becomes the daemon's own
working directory). Required.

.PARAMETER TaskName
Scheduled task name. Default: `Butchr-Native`. Generic and overridable —
this script never touches a task under any other name.

.PARAMETER BunBin
Absolute path to the `bun` executable the task should run. Defaults to
whichever `bun` this script bootstrapped/found on PATH.

.PARAMETER HerdrBin
The herdr command/path the launcher should run (`<HerdrBin> server`).
Default: `herdr` (resolved against PATH at task-run time).

.PARAMETER EnvFile
Where the daemon's secrets live. Default: `%APPDATA%\butchr\butchr.env`
(created empty, 0600-equivalent intent — see the known limitation about
NTFS ACLs in `docs/windows-native-host.md`).

.PARAMETER LogDir
Where rotating logs live. Default: `%LOCALAPPDATA%\butchr\logs`.

.PARAMETER Port
The daemon's own port, forwarded to nothing by this script directly but
documented so `verify.ps1 -Port` matches. Default: 7717.

.PARAMETER HerdrGraceSeconds
Seconds `launcher.ts` waits after starting herdr before starting the
daemon. Default: 5. See `launcher.ts`'s own doc comment for why this is a
fixed grace period, not a readiness poll.

.PARAMETER RunWhetherLoggedOnOrNot
Optional, documented, OFF by default. Switches the task's logon type from
`Interactive` (needs an actual logged-on session — the spike-validated
default, see requirement 1 above) to `S4U` (no stored password, but runs in
a NON-interactive session — Session 0, not the user's own desktop) and the
trigger from `AtLogOn` to `AtStartup`, so the task starts even with nobody
logged on. **This mode is NOT what the zippy spike validated** — herdr's
own behavior in a non-interactive Session 0 is unverified from this
workspace (no Windows host here at all); treat it as documented, optional,
and unproven, never as the recommended path, until it's been run for real.

.PARAMETER DryRun
Print what would be registered/changed without touching the Task Scheduler
or writing any file.

.EXAMPLE
./install.ps1 -RepoDir C:\butchr

.EXAMPLE
./install.ps1 -RepoDir C:\butchr -TaskName Butchr-Native-Zippy -DryRun
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoDir,

    [string]$TaskName = "Butchr-Native",
    [string]$BunBin,
    [string]$HerdrBin = "herdr",
    [string]$EnvFile,
    [string]$LogDir,
    [int]$Port = 7717,
    [int]$HerdrGraceSeconds = 5,
    [switch]$RunWhetherLoggedOnOrNot,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "bun not found on PATH — installing from https://bun.sh/install ..." -ForegroundColor Yellow
    powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex"
    $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Write-Error "bun install appeared to succeed but 'bun' is still not on PATH — add %USERPROFILE%\.bun\bin to PATH and re-run this script."
        exit 1
    }
}

if (-not $BunBin) { $BunBin = (Get-Command bun).Source }

# --- Step 1: everything the tested CLI can decide (herdr prereq, log dir, env file). ---
$cliArgs = @("run", "$ScriptDir\cli.ts", "install")
if ($EnvFile) { $cliArgs += @("--env-file", $EnvFile) }
if ($LogDir) { $cliArgs += @("--log-dir", $LogDir) }
if ($DryRun) { $cliArgs += "--dry-run" }
& $BunBin @cliArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "scripts/windows-host/cli.ts install failed (exit $LASTEXITCODE) — see [next-step]/[error] lines above."
    exit $LASTEXITCODE
}

# Resolve the same defaults cli.ts itself would have used, so the task's
# action always points at the log file launcher.ts will actually write to.
if (-not $EnvFile) { $EnvFile = "$env:APPDATA\butchr\butchr.env" }
if (-not $LogDir) { $LogDir = "$env:LOCALAPPDATA\butchr\logs" }

# --- Step 2: register the Scheduled Task (real PowerShell — see .DESCRIPTION). ---
$launcherArgs = @(
    "run", "$RepoDir\scripts\windows-host\launcher.ts",
    "--repo-dir", $RepoDir,
    "--bun-bin", $BunBin,
    "--herdr-bin", $HerdrBin,
    "--env-file", $EnvFile,
    "--log-dir", $LogDir,
    "--task-name", $TaskName,
    "--herdr-grace-seconds", $HerdrGraceSeconds
) -join " "

$action = New-ScheduledTaskAction -Execute $BunBin -Argument $launcherArgs -WorkingDirectory $RepoDir

if ($RunWhetherLoggedOnOrNot) {
    Write-Host "-RunWhetherLoggedOnOrNot: using LogonType S4U + trigger AtStartup — UNVERIFIED from this workspace (no Windows host here). See this script's own -RunWhetherLoggedOnOrNot parameter help before relying on it." -ForegroundColor Yellow
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
} else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)   # 0 = no time limit; the daemon is meant to run forever, same reasoning Register-WslHostTask.ps1 documents for its own held process

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($PSCmdlet.ShouldProcess($TaskName, "Register scheduled task ($BunBin run launcher.ts ...)")) {
    if ($DryRun) {
        Write-Host "[-DryRun] would $(if ($existing) { 'replace' } else { 'register' }) scheduled task '$TaskName' running: $BunBin $launcherArgs"
    } else {
        if ($existing) {
            Write-Host "Task '$TaskName' already exists — replacing it (idempotent: same name, fresh definition, no duplicate task)."
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
            -Description "Starts herdr then the Butchr daemon natively on Windows (FACTORY-560) — restarts itself (up to 999 times, 1 min apart) on failure. Managed independently of any other scheduled task on this host." | Out-Null
        Write-Host "Registered scheduled task '$TaskName'."
        Write-Host "Run it now with: schtasks /run /tn `"$TaskName`""
        Write-Host "Check it with:    .\verify.ps1 -Port $Port -TaskName $TaskName"
    }
} else {
    Write-Host "[-WhatIf] would $(if ($existing) { 'replace' } else { 'register' }) scheduled task '$TaskName'."
}
