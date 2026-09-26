<#
.SYNOPSIS
FACTORY-64: Windows-side health check for a Butchr WSL host. Distinguishes
"WSL itself isn't up" from "WSL is up but the daemon inside it isn't" —
only this script can observe the first case at all (from inside WSL, WSL is
definitionally up), so it is deliberately the ONLY thing this script decides
for itself; everything past that is delegated to `cli.ts verify` running
INSIDE the distro, so there is exactly one source of truth for the
daemon-level classification (see health.ts's own doc comment) rather than a
second, drifting reimplementation in PowerShell.

.DESCRIPTION
Real PowerShell against real `wsl.exe` — like Register-WslHostTask.ps1, this
cannot be exercised from this Linux workspace; see docs/windows-wsl-host.md's
"what was and wasn't tested off-Windows" section. The exit code always
matches the one health.ts's WSL_HEALTH_EXIT_CODES table defines: 2 = WSL
down, 1 = daemon down, 0 = healthy — this script adds the exit code 2 case
itself (it's the one case cli.ts can never observe, by construction) and
otherwise just forwards cli.ts's own exit code and printed lines verbatim.

.PARAMETER DistroName
The WSL distro to check (e.g. "Ubuntu"). Required.

.PARAMETER User
The Linux user to run the check as inside the distro. Defaults to the
distro's own configured default user if omitted.

.PARAMETER RepoDir
Absolute WSL-side path to the butchr checkout (e.g. `/home/broos/.local/share/butchr/runtime-<sha>`)
containing scripts/wsl-host/cli.ts. Required.

.EXAMPLE
./Verify-WslHost.ps1 -DistroName Ubuntu -User broos -RepoDir /home/broos/.local/share/butchr/runtime-abc1234
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DistroName,

    [string]$User,

    [Parameter(Mandatory = $true)]
    [string]$RepoDir
)

$ErrorActionPreference = "Stop"

function Test-DistroInstalled {
    $listed = & wsl.exe -l -q 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    # `wsl -l -q` prints UTF-16 with embedded NULs on some Windows builds; strip them before comparing names.
    $names = $listed | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ -ne "" }
    return $names -contains $DistroName
}

function Test-DistroRunning {
    $verbose = & wsl.exe -l -v 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    $line = $verbose | ForEach-Object { ($_ -replace "`0", "") } | Where-Object { $_ -match [regex]::Escape($DistroName) }
    return ($line -match "Running")
}

if (-not (Test-DistroInstalled)) {
    Write-Host "WSL: DOWN (distro '$DistroName' not installed)"
    exit 2
}
if (-not (Test-DistroRunning)) {
    Write-Host "WSL: DOWN (distro '$DistroName' not running)"
    exit 2
}

$userArgs = @("-d", $DistroName)
if ($User) { $userArgs += @("-u", $User) }
$verifyCommand = "bun run '$RepoDir/scripts/wsl-host/cli.ts' verify"
$output = & wsl.exe @userArgs -- bash -lc $verifyCommand 2>&1
$code = $LASTEXITCODE

$output | ForEach-Object { Write-Host $_ }
exit $code
