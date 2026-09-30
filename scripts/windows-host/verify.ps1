<#
.SYNOPSIS
FACTORY-560: health check for a native-Windows Butchr host — herdr running,
then the daemon's own `/health`, no journalctl involved anywhere.

.DESCRIPTION
Thin bootstrap into `scripts/windows-host/cli.ts verify`, mirroring
`install.ps1`'s own split: confirms `bun` is on PATH, then forwards
everything else — checking whether a herdr process is running (`tasklist`),
fetching `/health` directly from `127.0.0.1` (no WSL NAT boundary to work
around on a native host, unlike `Verify-WslHost.ps1`), classifying the
result, and tailing the daemon's own rotating log on a "daemon-down"
verdict — to that tested CLI (`scripts/windows-host/health.ts`'s
`classifyWindowsHostHealth`, unit-tested directly). The exit code always
matches `WINDOWS_HOST_HEALTH_EXIT_CODES`: 2 = herdr down, 1 = daemon down,
0 = healthy.

Also prints the Scheduled Task's own last-run info (`Get-ScheduledTaskInfo`)
as supplementary context — never folded into the exit code, since a task
that hasn't fired yet (nobody has logged on since install) looks identical,
from the task's own state alone, to one that fired and failed; the
herdr/health check above is the real source of truth for "is this host
healthy right now."

.PARAMETER Port
The daemon's own port. Default: 7717 — verify this against your own
`ENVIRONMENT.md`/`butchr.env`, since either can override it.

.PARAMETER TaskName
Scheduled task name to report `Get-ScheduledTaskInfo` for. Default:
`Butchr-Native`.

.PARAMETER HerdrProcessName
The process image name `tasklist` should look for. Default: `herdr.exe`.

.PARAMETER LogFile
Daemon log file to tail on a "daemon-down" verdict. Default:
`%LOCALAPPDATA%\butchr\logs\butchr.log`.

.EXAMPLE
./verify.ps1

.EXAMPLE
./verify.ps1 -Port 7719 -TaskName Butchr-Native-Zippy
#>
[CmdletBinding()]
param(
    [int]$Port = 7717,
    [string]$TaskName = "Butchr-Native",
    [string]$HerdrProcessName = "herdr.exe",
    [string]$LogFile
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "bun not found on PATH — install it (https://bun.sh/install) before running verify.ps1."
    exit 2
}

$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
if ($taskInfo) {
    Write-Host "Scheduled task '$TaskName': last run $($taskInfo.LastRunTime), last result $($taskInfo.LastTaskResult), next run $($taskInfo.NextRunTime)"
} else {
    Write-Host "Scheduled task '$TaskName' is not registered — run install.ps1 first."
}

$cliArgs = @("run", "$ScriptDir\cli.ts", "verify", "--port", $Port, "--herdr-process-name", $HerdrProcessName)
if ($LogFile) { $cliArgs += @("--log-file", $LogFile) }
bun @cliArgs
exit $LASTEXITCODE
