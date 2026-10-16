<#
.SYNOPSIS
FACTORY-560: unregisters the Butchr native-Windows Scheduled Task.

.DESCRIPTION
Real PowerShell, like `install.ps1`'s own task-registration step —
`Unregister-ScheduledTask` is a PowerShell-only cmdlet, no standalone
executable to shell out to from a tested CLI. Touches ONLY the task named
`-TaskName` (default `Butchr-Native`, matching `install.ps1`'s own default)
— it never enumerates or removes any other scheduled task on this host, by
construction: there is no code path here that lists tasks other than the
one name it was given.

**Does not delete `butchr.env`, `managed-sessions.env` (if present), or the
log directory** — same reasoning `docs/windows-wsl-host.md` gives for never
overwriting an env file: an operator's real credentials, and the host's own
diagnostic history, should never vanish just because the autostart task
did. Pass `-RemoveLogs` to also delete the log directory if you want a
clean slate; there is no flag to remove the env file — delete it yourself
if that's really what you want.

.PARAMETER TaskName
Scheduled task name to unregister. Default: `Butchr-Native`.

.PARAMETER LogDir
Only consulted if `-RemoveLogs` is passed. Default: `%LOCALAPPDATA%\butchr\logs`.

.PARAMETER RemoveLogs
Also delete the log directory. Off by default — logs are diagnostic
history, not disposable by default.

.PARAMETER WhatIf
Standard PowerShell -WhatIf.

.EXAMPLE
./uninstall.ps1

.EXAMPLE
./uninstall.ps1 -TaskName Butchr-Native-Zippy -RemoveLogs -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = "Butchr-Native",
    [string]$LogDir,
    [switch]$RemoveLogs
)

$ErrorActionPreference = "Stop"

if (-not $LogDir) { $LogDir = "$env:LOCALAPPDATA\butchr\logs" }

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Task '$TaskName' is not registered — nothing to do (idempotent: uninstall on an already-uninstalled host is a no-op, not an error)."
} elseif ($PSCmdlet.ShouldProcess($TaskName, "Unregister scheduled task")) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Unregistered scheduled task '$TaskName'."
} else {
    Write-Host "[-WhatIf] would unregister scheduled task '$TaskName'."
}

if ($RemoveLogs) {
    if (Test-Path $LogDir) {
        if ($PSCmdlet.ShouldProcess($LogDir, "Remove log directory")) {
            Remove-Item -Path $LogDir -Recurse -Force
            Write-Host "Removed log directory $LogDir."
        } else {
            Write-Host "[-WhatIf] would remove log directory $LogDir."
        }
    } else {
        Write-Host "Log directory $LogDir does not exist — nothing to remove."
    }
}

Write-Host "butchr.env (and managed-sessions.env, if present) were NOT touched — delete them yourself if you no longer need the stored credentials."
