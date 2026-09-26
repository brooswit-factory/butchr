<#
.SYNOPSIS
FACTORY-64: registers a Windows scheduled task that starts a WSL distro (and
the butchr/herdr systemd user units inside it) at logon, so a Butchr WSL
host survives a reboot without an interactive shell.

.DESCRIPTION
This is real PowerShell against real Windows APIs (Register-ScheduledTask) —
it cannot be exercised or unit-tested from this Linux workspace at all; see
docs/windows-wsl-host.md's own "what was and wasn't tested off-Windows"
section. Keep it deliberately small and readable instead of clever, since
nothing here can be proven by a test run in this repo's own CI.

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

Action: `wsl.exe -d <DistroName> -u <User> -- systemctl --user start
butchr.service herdr.service`. WSL2 does not keep a distro's VM up on its
own — it shuts down once nothing is using it (see the doc's "WSL idle
shutdown" troubleshooting entry) — so this action both starts the distro (a
side effect of any `wsl.exe` invocation reaching it) and starts the two
units inside it; `Register-WslHostTask.ps1 -RepeatMinutes` (default 30) also
adds a repeating trigger that re-runs the same action periodically, which is
what actually keeps the VM alive across WSL's own idle-shutdown timer, not
just the one logon-time kick.

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

.PARAMETER RepeatMinutes
How often, after the logon trigger fires once, to re-run the same start
action — this is what actually counters WSL's own idle-shutdown, not the
one-shot logon trigger alone. Default 30. Pass 0 to disable repetition
(logon-only).

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

    [string]$TaskName = "Butchr-WSL",

    [int]$RepeatMinutes = 30
)

$ErrorActionPreference = "Stop"

$userArgs = @("-d", $DistroName)
if ($User) { $userArgs += @("-u", $User) }
$innerCommand = "systemctl --user start butchr.service herdr.service"
$actionArgs = ($userArgs + @("--", "bash", "-lc", "`"$innerCommand`"")) -join " "

$action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument $actionArgs
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$triggers = @($logonTrigger)
if ($RepeatMinutes -gt 0) {
    # A repeating trigger needs its own base time + repetition interval; reuse AtLogOn's shape but attach a repetition so the action re-fires periodically for as long as the session is active, which is what actually keeps the WSL VM from idling out between logons.
    $repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes) -RepetitionDuration ([TimeSpan]::MaxValue)
    $triggers += $repeatTrigger
}

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($PSCmdlet.ShouldProcess($TaskName, "Register scheduled task (wsl.exe -d $DistroName ...)")) {
    if ($existing) {
        Write-Host "Task '$TaskName' already exists — replacing it (idempotent: same name, fresh definition, no duplicate task)."
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description "Starts WSL distro '$DistroName' and its butchr/herdr systemd user units (FACTORY-64). Mirrors the role of the hand-built zippy host's own boot task; managed independently of any other scheduled task on this host." | Out-Null
    $repeatNote = if ($RepeatMinutes -gt 0) { " + every $RepeatMinutes min" } else { "" }
    Write-Host "Registered scheduled task '$TaskName' (trigger: AtLogOn$repeatNote)."
} else {
    Write-Host "[-WhatIf] would $(if ($existing) { 'replace' } else { 'register' }) scheduled task '$TaskName' running: wsl.exe $actionArgs"
}
