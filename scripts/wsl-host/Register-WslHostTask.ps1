<#
.SYNOPSIS
FACTORY-64: registers a Windows scheduled task that starts a WSL distro (and
the butchr/herdr systemd user units inside it) at logon, and HOLDS it up
afterward, so a Butchr WSL host survives a reboot without an interactive
shell.

.DESCRIPTION
This is real PowerShell against real Windows APIs (Register-ScheduledTask) —
it cannot be exercised or unit-tested from this Linux workspace at all; see
docs/windows-wsl-host.md's own "what was and wasn't tested off-Windows"
section, which also says plainly that the keep-alive mechanism below is a
design intent, not something observed working on a real host. Keep it
deliberately small and readable instead of clever, since nothing here can be
proven by a test run in this repo's own CI.

Trigger: AtLogOn for -User, not AtStartup. This is a deliberate choice, not
an oversight: an AtStartup trigger that must run before any user logs on
needs a STORED PASSWORD (or a gMSA), a materially bigger secret-handling
surface than this story's "secrets stay in token files, 0600, referenced by
EnvironmentFile=" rule is scoped to cover. AtLogOn for a specific user needs
no stored credential at all (it runs *as* the already-authenticated logged-on
user) at the cost of "the WSL VM only comes up once someone logs on" rather
than at boot proper — acceptable for a workstation-shaped host that's
expected to have an interactive session anyway (this mirrors the zippy
report's own framing: "keep the WSL VM up", not "start before any login").
If your host genuinely needs a true boot-time (no-logon) start, that is a
deliberately DIFFERENT, higher-privilege setup this script does not attempt
— see the doc's troubleshooting section.

Action: a SINGLE, HELD invocation —
    wsl.exe -d <DistroName> -u <User> -- bash -lc
        "systemctl --user start butchr.service herdr.service; exec sleep infinity"
— never a fire-and-forget one. This was a review finding on the first
version of this script: a `wsl.exe` invocation that starts the units and
then RETURNS does not keep the VM up by itself (WSL2 shuts its VM down once
nothing is actively using it — see the doc's "WSL idle shutdown"
troubleshooting entry) — re-running that same short-lived command on a
timer does not reliably counter it either, since the VM can still idle out
in the gap between runs. `exec sleep infinity` makes the `wsl.exe` process
itself long-lived, so as long as THAT process is alive, WSL has an active
client and does not idle-shut-down; `-RestartCount`/`-RestartInterval`
below make the TASK restart it (re-running the whole action, including the
`systemctl --user start` — harmless on an already-active unit) if it's ever
killed for any reason, and `-ExecutionTimeLimit` is explicitly disabled
because Task Scheduler's own DEFAULT limit (3 days) would otherwise kill
this intentionally-forever process on its own schedule.

Never touches any scheduled task other than the one named by -TaskName
(default `Butchr-WSL`, generic and overridable — never "Candlestix-Zippy" or
"USRR-Zippy", per this story's own hard constraint).

.PARAMETER DistroName
The WSL distro to start (e.g. "Ubuntu"). Required.

.PARAMETER User
The Linux user inside the distro to run the systemctl command as. Defaults
to the distro's own configured default user (omit -u entirely) if not given.

.PARAMETER TaskName
Scheduled task name. Default: Butchr-WSL. Generic and overridable by design
— see the module doc comment above.

.PARAMETER WhatIf
Standard PowerShell -WhatIf: print what would be registered/changed without
touching the Task Scheduler at all.

.EXAMPLE
./Register-WslHostTask.ps1 -DistroName Ubuntu -User broos

.EXAMPLE
./Register-WslHostTask.ps1 -DistroName Ubuntu -User broos -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$DistroName,

    [string]$User,

    [string]$TaskName = "Butchr-WSL"
)

$ErrorActionPreference = "Stop"

$userArgs = @("-d", $DistroName)
if ($User) { $userArgs += @("-u", $User) }
# `exec sleep infinity` replaces the shell with a process that never exits on
# its own — this is what keeps `wsl.exe` (and so the WSL VM) alive, not a
# periodic re-invocation. `systemctl --user start` on an already-active unit
# is a harmless no-op, so re-running the whole line after a restart is safe.
$innerCommand = "systemctl --user start butchr.service herdr.service; exec sleep infinity"
$actionArgs = ($userArgs + @("--", "bash", "-lc", "`"$innerCommand`"")) -join " "

$action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument $actionArgs
$trigger = New-ScheduledTaskTrigger -AtLogOn

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)   # 0 = no time limit; Task Scheduler's own default (3 days) would otherwise kill this intentionally-forever process

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($PSCmdlet.ShouldProcess($TaskName, "Register scheduled task (wsl.exe -d $DistroName ...)")) {
    if ($existing) {
        Write-Host "Task '$TaskName' already exists — replacing it (idempotent: same name, fresh definition, no duplicate task)."
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Starts and HOLDS UP WSL distro '$DistroName' and its butchr/herdr systemd user units (FACTORY-64) — restarts itself (up to 999 times, 1 min apart) if the held process ever dies. Mirrors the role of the hand-built zippy host's own boot task; managed independently of any other scheduled task on this host." | Out-Null
    Write-Host "Registered scheduled task '$TaskName' (trigger: AtLogOn; holds the WSL session open via a long-lived process, auto-restarted on failure)."
} else {
    Write-Host "[-WhatIf] would $(if ($existing) { 'replace' } else { 'register' }) scheduled task '$TaskName' running: wsl.exe $actionArgs"
}
