import { spawnSync } from "node:child_process";

/**
 * FACTORY-1043 review finding: `chmodSync(path, 0o600)` does not narrow NTFS ACLs — it
 * only toggles the read-only DOS attribute. Native ZIPZOOM evidence showed a control-panel
 * directory left with an inherited RX grant for an unrelated local group
 * (`ZIPZOOM\CodexSandboxUsers`) alongside the owning user/SYSTEM/Administrators, because
 * nothing in this codebase ever narrowed the directory's ACL on Windows. `icacls` (shipped
 * with every Windows install, no new dependency) is the mechanism used here: `lockDownAcl`
 * resets a path to exactly {current user, SYSTEM, Administrators} full control with
 * inheritance disabled, called right after every control-panel directory/file create or
 * rewrite; `verifyPrivateAcl` re-reads a path's effective ACL and refuses (mirroring the
 * POSIX `unsafeGroupOtherBits` refusal) if any OTHER principal has any access at all —
 * catching a directory/file that predates this fix, or whose ACL was independently loosened
 * since. Both are no-ops on every platform but win32.
 *
 * UNVERIFIED ON REAL WINDOWS: this module's icacls invocation and output-parsing were
 * authored and tested (via the injectable `AclIo` seam) without access to an actual
 * Windows machine. Native validation of this exact lockdown/verify behavior is required
 * before it can be trusted for real credentials.
 */
export interface AclIo {
  /** Runs `icacls` with the given arguments; returns combined stdout, throws on a nonzero exit. */
  run(args: string[]): string;
}

export function defaultAclIo(): AclIo {
  return {
    run(args: string[]): string {
      const result = spawnSync("icacls", args, { encoding: "utf8", windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) throw Error(`icacls ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
      return result.stdout ?? "";
    },
  };
}

/** The current Windows user, unqualified — icacls resolves a bare account name against the local machine. */
function currentWindowsUser(): string {
  const user = process.env.USERNAME;
  if (!user) throw Error("Cannot determine current Windows user (USERNAME is unset) to restrict an ACL");
  return user;
}

const ADMINISTRATORS_SID = "*S-1-5-32-544";

/**
 * Resets `path`'s ACL to exactly {current user, SYSTEM, Administrators} full control,
 * with inheritance from the parent disabled. `/grant:r` REPLACES every existing explicit
 * grant with the ones listed (rather than adding to them), and `/inheritance:r` removes
 * every inherited entry — together they leave nothing else with access. Idempotent and
 * safe to call on every startup, including against a pre-existing directory/file created
 * before this fix shipped.
 */
export function lockDownAcl(path: string, io: AclIo = defaultAclIo()): void {
  if (process.platform !== "win32") return;
  const user = currentWindowsUser();
  io.run([path, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`, "SYSTEM:(OI)(CI)F", `${ADMINISTRATORS_SID}:(OI)(CI)F`]);
}

const ALLOWED_PRINCIPAL_SUFFIXES = ["\\SYSTEM", "\\ADMINISTRATORS"];

function isAllowedPrincipal(principal: string, owner: string): boolean {
  const upper = principal.trim().toUpperCase();
  if (upper === owner.toUpperCase()) return true;
  if (upper === "SYSTEM" || upper === "NT AUTHORITY\\SYSTEM") return true;
  if (upper === "BUILTIN\\ADMINISTRATORS" || upper === ADMINISTRATORS_SID) return true;
  return ALLOWED_PRINCIPAL_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

/**
 * Parses `icacls <path>`'s own listing format: a first line `<path> <PRINCIPAL>:(flags...)`,
 * then zero or more continuation lines of just `<spaces><PRINCIPAL>:(flags...)` (one ACE per
 * line; a principal with multiple ACEs repeats its own name), until a blank line or the
 * trailing "Successfully processed..." summary. Returns the distinct principal names found.
 */
export function parseIcaclsPrincipals(output: string, path: string): string[] {
  const principals: string[] = [];
  const lines = output.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw.trim() || /^Successfully processed/i.test(raw.trim())) continue;
    const withoutPath = raw.startsWith(path) ? raw.slice(path.length) : raw;
    const match = withoutPath.match(/^\s*(.+?):\(/);
    if (!match) continue;
    principals.push(match[1]!.trim());
  }
  return principals;
}

/**
 * Throws if any principal other than the current user, SYSTEM, or Administrators has any
 * access to `path`, mirroring the refusal `unsafeGroupOtherBits` gives on POSIX for a
 * group/other-readable file. A no-op on every platform but win32.
 */
export function verifyPrivateAcl(path: string, io: AclIo = defaultAclIo()): void {
  if (process.platform !== "win32") return;
  const owner = currentWindowsUser();
  const output = io.run([path]);
  for (const principal of parseIcaclsPrincipals(output, path)) {
    if (!isAllowedPrincipal(principal, owner)) throw Error(`Unsafe Windows ACL on ${path}: unexpected principal "${principal}" has access`);
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
