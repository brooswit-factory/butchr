import { spawnSync } from "node:child_process";

/**
 * FACTORY-1043: real Windows ACL enforcement for the control-panel directory/files,
 * replacing the POSIX-only `unsafeGroupOtherBits` bypass on win32. A first attempt built
 * on `icacls` text output (reverted, commit dccd1ca9) was independently disproven on
 * native Windows three ways: `(OI)(CI)` inheritance flags produce no effective ACE at all
 * on a plain FILE target (only meaningful on a container); the printed owner name is
 * domain-qualified (`ZIPZOOM\broos`) while this process's own unqualified name is not, so
 * a naive string compare rejects the legitimate owner; and `icacls`'s own exit code can be
 * 0 on output this module couldn't parse, which must never be read as "nothing to flag".
 *
 * This version uses PowerShell's .NET-backed `Get-Acl`/`Set-Acl` instead of `icacls`:
 * - SIDs (`IdentityReference.Translate([SecurityIdentifier])`), never display names —
 *   immune to domain/locale qualification differences.
 * - `Get-Item -LiteralPath $path).PSIsContainer` distinguishes file vs. directory, since
 *   ONLY a directory's ACEs should carry container/object-inherit flags; a file's must not.
 * - Structured JSON output (`ConvertTo-Json`), not text scraping.
 * - A PowerShell/parse failure is NEVER treated as "no rules to flag" — `verifyPrivateAcl`
 *   throws on any unparseable or `ok:false` result (fail CLOSED, the opposite of the prior
 *   attempt's silent pass-through on malformed output).
 *
 * Path is passed via an environment variable, not interpolated into the script text, so a
 * path containing quotes/special characters can never be read as PowerShell syntax.
 *
 * UNVERIFIED ON REAL WINDOWS: authored and tested (via the injectable `AclIo` seam) without
 * access to an actual Windows machine. Native validation against a disposable fixture is
 * requested before this can be trusted for real credentials — see the PR for the exact
 * commands.
 */
export interface AclIo {
  /** Runs the given PowerShell script (the path is available to it as $env:BUTCHR_ACL_PATH) and returns its stdout. Throws on a nonzero exit or a spawn failure. */
  run(script: string, path: string): string;
}

export function defaultAclIo(): AclIo {
  return {
    run(script: string, path: string): string {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, BUTCHR_ACL_PATH: path },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw Error(`powershell ACL script failed (exit ${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
      return result.stdout ?? "";
    },
  };
}

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";

const LOCKDOWN_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = $env:BUTCHR_ACL_PATH
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($acl.Access)) { $acl.RemoveAccessRule($existing) | Out-Null }
$isDir = (Get-Item -LiteralPath $path).PSIsContainer
$inheritFlags = if ($isDir) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('${SYSTEM_SID}')
$admins = New-Object System.Security.Principal.SecurityIdentifier('${ADMINISTRATORS_SID}')
foreach ($sid in @($owner, $system, $admins)) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritFlags, 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl
`;

const VERIFY_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $path = $env:BUTCHR_ACL_PATH
  $acl = Get-Acl -LiteralPath $path
  $ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $rules = @($acl.Access | ForEach-Object {
    [PSCustomObject]@{
      sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      accessControlType = $_.AccessControlType.ToString()
    }
  })
  $result = [PSCustomObject]@{ ok = $true; ownerSid = $ownerSid; rules = $rules }
  Write-Output ($result | ConvertTo-Json -Compress -Depth 5)
} catch {
  Write-Output (([PSCustomObject]@{ ok = $false; error = $_.Exception.Message }) | ConvertTo-Json -Compress)
}
`;

interface VerifyResultOk { ok: true; ownerSid: string; rules: { sid: string; accessControlType: string }[] | { sid: string; accessControlType: string } | null }
interface VerifyResultErr { ok: false; error: string }

/** Exported only for direct unit testing of the parse/fail-closed contract itself. */
export function parseVerifyResultForTest(output: string): VerifyResultOk | VerifyResultErr {
  return parseVerifyResult(output);
}

function parseVerifyResult(output: string): VerifyResultOk | VerifyResultErr {
  let parsed: unknown;
  try { parsed = JSON.parse(output.trim()); } catch (e) { return { ok: false, error: `unparseable ACL inspection output: ${(e as Error).message}: ${output}` }; }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: `unexpected ACL inspection output shape: ${output}` };
  const value = parsed as Record<string, unknown>;
  if (value.ok === true && typeof value.ownerSid === "string") return value as unknown as VerifyResultOk;
  if (value.ok === false && typeof value.error === "string") return value as unknown as VerifyResultErr;
  return { ok: false, error: `unexpected ACL inspection output shape: ${output}` };
}

/**
 * Resets `path`'s ACL to exactly {current user, SYSTEM, Administrators} full control, with
 * inheritance from the parent disabled. Idempotent and safe to call on every write/startup,
 * including against a pre-existing directory/file created before this fix shipped. Call
 * BEFORE writing anything sensitive to a fresh path — this fixes the ACL, it doesn't wait
 * for a problem to be detected first.
 */
export function lockDownAcl(path: string, io: AclIo = defaultAclIo()): void {
  if (process.platform !== "win32") return;
  io.run(LOCKDOWN_SCRIPT, path);
}

/**
 * Throws if `path`'s effective ACL grants any Allow access to a principal other than the
 * current user, SYSTEM, or Administrators (by SID — immune to domain/locale-qualified
 * display-name differences), mirroring the refusal `unsafeGroupOtherBits` gives on POSIX
 * for a group/other-readable file. FAILS CLOSED: a PowerShell failure or any output this
 * can't parse as the expected shape is treated as unsafe, never as "nothing to flag". A
 * no-op on every platform but win32.
 */
export function verifyPrivateAcl(path: string, io: AclIo = defaultAclIo()): void {
  if (process.platform !== "win32") return;
  const output = io.run(VERIFY_SCRIPT, path);
  const result = parseVerifyResult(output);
  if (!result.ok) throw Error(`Unsafe Windows ACL on ${path}: could not inspect it (failing closed): ${result.error}`);
  const allowed = new Set([result.ownerSid, SYSTEM_SID, ADMINISTRATORS_SID]);
  const rules = result.rules == null ? [] : Array.isArray(result.rules) ? result.rules : [result.rules];
  for (const rule of rules) {
    if (rule.accessControlType !== "Allow") continue;
    if (!allowed.has(rule.sid)) throw Error(`Unsafe Windows ACL on ${path}: unexpected principal ${rule.sid} has access`);
  }
}

/** `true` if `verifyPrivateAcl` would refuse `path`; `false` (never throws) on every platform but win32. */
export function unsafeWindowsAcl(path: string, io: AclIo = defaultAclIo()): boolean {
  if (process.platform !== "win32") return false;
  try {
    verifyPrivateAcl(path, io);
    return false;
  } catch {
    return true;
  }
}
