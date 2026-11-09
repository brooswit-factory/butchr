import { spawnSync } from "node:child_process";

/**
 * FACTORY-1043: real Windows ACL enforcement for the control-panel directory/files,
 * replacing the POSIX-only `unsafeGroupOtherBits` bypass on win32. Rebuilt twice already
 * from native-Windows findings (ZIPZOOM, via Tayne) on the previous two attempts:
 *
 * Round 1 (icacls text parsing, reverted at commit dccd1ca9): `(OI)(CI)` inheritance flags
 * produced no effective ACE at all on a plain FILE target; the printed owner name was
 * domain-qualified while this process's own unqualified name was not, so a naive string
 * compare rejected the legitimate owner; `icacls`'s own exit code could be 0 on output this
 * module couldn't parse, which must never be read as "nothing to flag".
 *
 * Round 2 (this file's prior version, commit 76b693d9/69ab70bf/5674459d): `Set-Acl` with an
 * ACL object derived from `Get-Acl` threw "...SeSecurityPrivilege privilege which is
 * required..." on native Windows as a regular (non-elevated) user — `Get-Acl`'s returned
 * object carries Owner/Group/Audit sections that `Set-Acl` re-persists even when those
 * fields are untouched, and persisting Owner/Audit needs privileges an ordinary user
 * lacks. `verifyPrivateAcl`'s schema validation also silently accepted malformed input
 * (a missing `rules` field, an empty `ownerSid`, a rule object missing `sid`/
 * `accessControlType` was SKIPPED rather than flagged) — found independently, natively,
 * by directly invoking the exported function with injected payloads. And `ownerSid` was
 * populated from the CURRENT PROCESS's own identity, never the inspected object's actual
 * security-descriptor owner — so an object silently owned by an unrelated account would
 * never be caught. Calling `lockDownAcl` on every `writeDurableFile` write was also far
 * too slow (each call shells out to a real PowerShell process) and, by unconditionally
 * resetting an EXISTING directory's ACL on every startup, silently overwrote whatever a
 * prior installation's ACL was rather than verifying it or refusing to proceed.
 *
 * This version:
 * - `lockDownAcl` builds a FRESH `FileSecurity`/`DirectorySecurity` object (never derived
 *   from `Get-Acl`) with ONLY the DACL populated — `Set-Acl` on that touches nothing an
 *   unprivileged owner can't already change, and reads back its own result
 *   (`verifyPrivateAcl`) before returning, so a silent partial failure is caught
 *   immediately rather than discovered later.
 * - Only ever called for a path THIS code is creating for the first time (a brand-new
 *   directory, the sqlite lock file's first creation) — never on every ordinary write.
 *   An EXISTING path (a pre-existing directory from an older install, in particular) is
 *   only ever VERIFIED, never silently relocked; an unsafe existing ACL is a refusal
 *   (`unsafeWindowsAcl`/`verifyPrivateAcl` throwing), for the caller to act on, exactly
 *   like every other "Unsafe ... file" refusal in this codebase.
 *
 * (An earlier version of this comment claimed a brand-new file written under an
 * already-locked-down directory inherits that directory's ACL automatically — DISPROVEN
 * natively: a directory locked down exactly as intended can still report
 * `InheritanceFlags=None` on its own ACEs, so nothing propagates; see `writeDurableFile`'s
 * own doc comment in writer.ts for the confirmed exposure and why every write now locks
 * its own file down explicitly instead of trusting inheritance.)
 * - `verifyPrivateAcl` validates the FULL expected shape strictly (SID syntax via regex,
 *   `accessControlType` exactly `Allow`/`Deny`) and fails closed (`ok:false`) the moment
 *   anything doesn't match, rather than treating a missing/malformed field as absent.
 * - Checks the object's OWN security-descriptor owner (`ownerSid`, from `$acl.Owner`)
 *   against the allowed set, SEPARATELY from the current process's own identity
 *   (`currentUserSid`, used only to build that allowed set) — an object silently owned by
 *   an unrelated account is flagged even if its ACEs otherwise look fine.
 * - SIDs throughout, never display names — immune to domain/locale qualification.
 * - `Get-Item -LiteralPath $path).PSIsContainer` distinguishes file vs. directory, since
 *   only a directory's ACEs should carry container/object-inherit flags.
 * - The path is passed via `$env:BUTCHR_ACL_PATH`, never interpolated into script text.
 *
 * UNVERIFIED ON REAL WINDOWS beyond what's noted above — authored and unit-tested (via the
 * injectable `AclIo` seam) without direct access to a Windows machine. Native validation
 * against a disposable fixture is requested before this can be trusted for real
 * credentials; see the PR for exact commands.
 */
export interface AclIo {
  /** Runs the given PowerShell script (the path is available to it as $env:BUTCHR_ACL_PATH) and returns its stdout. Throws on a nonzero exit or a spawn failure. */
  run(script: string, path: string): string;
}

export function defaultAclIo(): AclIo {
  return {
    run(script: string, path: string): string {
      // pwsh (PowerShell 7+), not the legacy Windows PowerShell 5.1 `powershell.exe`: the
      // latter failed to autoload the module providing Get-Acl/Set-Acl on native Windows
      // CI (FACTORY-1043) — "CouldNotAutoloadMatchingModule" — while pwsh is already what
      // this repo's own CI steps run on the exact same runner image.
      const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
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
const SID_PATTERN = /^S-1-\d+(-\d+)+$/;

// Built fresh, never derived from Get-Acl: an ACL object populated by Get-Acl carries
// Owner/Group/Audit sections that Set-Acl re-persists even when untouched, and
// persisting those needs privileges an ordinary (non-elevated) user does not have —
// confirmed natively (FACTORY-1043 round 2): "...SeSecurityPrivilege privilege which is
// required for this operation". A brand-new ObjectSecurity instance has none of that.
const LOCKDOWN_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = $env:BUTCHR_ACL_PATH
$isDir = (Get-Item -LiteralPath $path).PSIsContainer
$acl = if ($isDir) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
$acl.SetAccessRuleProtection($true, $false)
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
  $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  # The typed GetOwner/GetAccessRules overloads, not the .Owner/.Access properties: on
  # native Windows (FACTORY-1043 round 3, confirmed), .Owner returns a plain
  # System.String with no .Translate method — asking for SecurityIdentifier explicitly
  # here returns the SID directly, with no ambiguity about what shape came back.
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [PSCustomObject]@{ sid = $_.IdentityReference.Value; accessControlType = $_.AccessControlType.ToString() }
  })
  $result = [PSCustomObject]@{ ok = $true; currentUserSid = $currentUserSid; ownerSid = $ownerSid; rules = $rules }
  Write-Output ($result | ConvertTo-Json -Compress -Depth 5)
} catch {
  Write-Output (([PSCustomObject]@{ ok = $false; error = $_.Exception.Message }) | ConvertTo-Json -Compress)
}
`;

interface AclRule { sid: string; accessControlType: "Allow" | "Deny" }
interface VerifyResultOk { ok: true; currentUserSid: string; ownerSid: string; rules: AclRule[] }
interface VerifyResultErr { ok: false; error: string }

function isValidSid(value: unknown): value is string {
  return typeof value === "string" && SID_PATTERN.test(value);
}

function isValidRule(value: unknown): value is AclRule {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return isValidSid(r.sid) && (r.accessControlType === "Allow" || r.accessControlType === "Deny");
}

/**
 * Validates the FULL expected shape strictly — every field present, every SID
 * syntactically valid, every rule's `accessControlType` exactly `Allow`/`Deny` — and fails
 * closed (returns `ok:false`) the instant anything doesn't match, rather than treating a
 * missing/malformed field as merely absent (native testing independently found the prior
 * version silently accepting a missing `rules` field, an empty `ownerSid`, and a
 * malformed rule object by skipping it instead of flagging it).
 */
export function parseVerifyResultForTest(output: string): VerifyResultOk | VerifyResultErr {
  return parseVerifyResult(output);
}

function parseVerifyResult(output: string): VerifyResultOk | VerifyResultErr {
  let parsed: unknown;
  try { parsed = JSON.parse(output.trim()); } catch (e) { return { ok: false, error: `unparseable ACL inspection output: ${(e as Error).message}: ${output}` }; }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: `unexpected ACL inspection output shape: ${output}` };
  const value = parsed as Record<string, unknown>;
  if (value.ok === false) return { ok: false, error: typeof value.error === "string" ? value.error : `malformed error result: ${output}` };
  if (value.ok !== true) return { ok: false, error: `unexpected ACL inspection output shape: ${output}` };
  if (!isValidSid(value.currentUserSid)) return { ok: false, error: `missing or invalid currentUserSid: ${output}` };
  if (!isValidSid(value.ownerSid)) return { ok: false, error: `missing or invalid ownerSid: ${output}` };
  if (value.rules === undefined || value.rules === null) return { ok: false, error: `missing rules field: ${output}` };
  const rawRules = Array.isArray(value.rules) ? value.rules : [value.rules];
  const rules: AclRule[] = [];
  for (const raw of rawRules) {
    if (!isValidRule(raw)) return { ok: false, error: `malformed ACL rule entry: ${JSON.stringify(raw)}` };
    rules.push(raw);
  }
  return { ok: true, currentUserSid: value.currentUserSid, ownerSid: value.ownerSid, rules };
}

/**
 * Resets `path`'s ACL to exactly {current user, SYSTEM, Administrators} full control, with
 * inheritance from the parent disabled. Call this ONLY for a path being created for the
 * first time — never against a pre-existing path (verify it instead; see this module's
 * own header comment for why).
 *
 * `readback`, true by default, re-reads the result and throws if it isn't actually safe (a
 * silent partial failure must never be mistaken for success) — doubling the PowerShell
 * invocations for this call, which is fine for the low-frequency callers (the
 * control-panel directory itself, the sqlite writer lock's first creation) this defaults
 * for. `writeDurableFile`'s own per-write lockdown passes `false`: it runs on every
 * ordinary write, confirmed natively to make the readback's extra PowerShell process a
 * real, broad latency problem there — a lockdown that silently failed to apply still gets
 * caught at the next READ of that file via `unsafeWindowsAcl`, so skipping the immediate
 * double-check on the hot write path is a deliberate, bounded tradeoff, not a silent gap.
 */
export function lockDownAcl(path: string, io: AclIo = defaultAclIo(), readback: boolean = true): void {
  if (process.platform !== "win32") return;
  io.run(LOCKDOWN_SCRIPT, path);
  if (readback) verifyPrivateAcl(path, io);
}

/**
 * Throws if `path`'s own security-descriptor owner, or any Allow ACE, names a principal
 * other than the current user, SYSTEM, or Administrators (by SID — immune to domain/
 * locale-qualified display-name differences), mirroring the refusal `unsafeGroupOtherBits`
 * gives on POSIX for a group/other-readable file. A Deny rule for an unrelated principal
 * is never flagged — it only restricts further, never grants access. FAILS CLOSED: a
 * PowerShell failure or any output that doesn't validate against the full expected shape
 * is treated as unsafe, never as "nothing to flag". A no-op on every platform but win32.
 */
export function verifyPrivateAcl(path: string, io: AclIo = defaultAclIo()): void {
  if (process.platform !== "win32") return;
  const output = io.run(VERIFY_SCRIPT, path);
  const result = parseVerifyResult(output);
  if (!result.ok) throw Error(`Unsafe Windows ACL on ${path}: could not inspect it (failing closed): ${result.error}`);
  const allowed = new Set([result.currentUserSid, SYSTEM_SID, ADMINISTRATORS_SID]);
  if (!allowed.has(result.ownerSid)) throw Error(`Unsafe Windows ACL on ${path}: unexpected owner ${result.ownerSid}`);
  for (const rule of result.rules) {
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
