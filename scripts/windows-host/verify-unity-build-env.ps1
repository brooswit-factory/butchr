<#
.SYNOPSIS
FACTORY-563: read-only checklist for the headless Unity WebGL build
environment on zippy (GK-8, project GK, epic GK-7). Reports what is
already present and what admin-assembly still has to install/activate by
hand — see docs/windows-native-host.md's "Unity build environment"
section for the full runbook this script is one step of.

.DESCRIPTION
Every check here is read-only: `Get-Command`, `Test-Path`, `Get-ChildItem`.
This script never installs, activates, downloads, or invokes Unity or
Unity Hub, and never reads or prints license file CONTENT — only whether
the file exists at its expected path. Running a real build is explicitly
out of scope for FACTORY-563 (see docs/windows-native-host.md) and this
script does not do it either.

Unverified against a real Windows host — see this script's own doc-comment
cross-reference in docs/windows-native-host.md ("What was and wasn't
tested off-Windows"). If a path or command name below turns out wrong on
a real zippy, that observation wins — fix this script, don't trust it.

.PARAMETER UnityVersion
Editor version to look for under the Hub's default install root. Default:
6000.0.20f1 (docs/windows-native-host.md's own target — verify it's still
current before trusting this default).

.PARAMETER HubEditorRoot
Root directory Unity Hub installs Editors under. Default:
C:\Program Files\Unity\Hub\Editor.

.PARAMETER LicenseFile
Path Unity's own per-machine `.ulf` activation is expected at. Default:
C:\ProgramData\Unity\config\Unity_lic.ulf. This script only checks
existence — it never opens or prints this file.

.EXAMPLE
./verify-unity-build-env.ps1

.EXAMPLE
./verify-unity-build-env.ps1 -UnityVersion 6000.0.20f1
#>
[CmdletBinding()]
param(
    [string]$UnityVersion = "6000.0.20f1",
    [string]$HubEditorRoot = "C:\Program Files\Unity\Hub\Editor",
    [string]$LicenseFile = "C:\ProgramData\Unity\config\Unity_lic.ulf"
)

$ErrorActionPreference = "Stop"
$missing = @()

Write-Host "Unity build environment checklist (read-only; installs/activates nothing)"
Write-Host "=========================================================================="

# 1. Unity Hub CLI on PATH
$hub = Get-Command unityhub -ErrorAction SilentlyContinue
if ($hub) {
    Write-Host "[ok]      unityhub found on PATH ($($hub.Source))"
} else {
    Write-Host "[missing] unityhub not found on PATH — install Unity Hub first (see docs/windows-native-host.md, section 1)"
    $missing += "unity-hub"
}

# 2. Editor + WebGL module, by directory shape
$editorRoot = Join-Path $HubEditorRoot $UnityVersion
$editorExe = Join-Path $editorRoot "Editor\Unity.exe"
$webglModule = Join-Path $editorRoot "Editor\Data\PlaybackEngines\WebGLSupport"
if (Test-Path $editorExe) {
    Write-Host "[ok]      Unity $UnityVersion editor found ($editorExe)"
} else {
    Write-Host "[missing] Unity $UnityVersion editor not found at $editorExe — install via Unity Hub (section 1)"
    $missing += "unity-editor-$UnityVersion"
}
if (Test-Path $webglModule) {
    Write-Host "[ok]      WebGL module found ($webglModule)"
} else {
    Write-Host "[missing] WebGL module not found at $webglModule — install it via Unity Hub alongside the editor (section 1)"
    $missing += "webgl-module"
}

# 3. License activation file (existence only — never opened)
if (Test-Path $LicenseFile) {
    Write-Host "[ok]      license file present ($LicenseFile) — presence only, not validated as a working activation"
} else {
    Write-Host "[missing] license file not found at $LicenseFile — see docs/windows-native-host.md section 2 (needs Brooswit's UNITY_PASSWORD; not scriptable end-to-end)"
    $missing += "unity-license"
}

# 4. git-lfs on PATH
$lfs = Get-Command git-lfs -ErrorAction SilentlyContinue
if ($lfs) {
    Write-Host "[ok]      git-lfs found on PATH ($($lfs.Source))"
} else {
    Write-Host "[missing] git-lfs not found on PATH — winget install -e --id GitHub.GitLFS (section 3)"
    $missing += "git-lfs"
}

Write-Host "=========================================================================="
if ($missing.Count -eq 0) {
    Write-Host "All checked prerequisites present. This does NOT confirm the license actually activates, or that a build succeeds — see docs/windows-native-host.md's runbook step 7 (run the smoke command by hand)."
    exit 0
} else {
    Write-Host "Missing: $($missing -join ', ')"
    Write-Host "See docs/windows-native-host.md's 'Unity build environment' section for what each of these needs."
    exit 1
}
