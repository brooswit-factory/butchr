/**
 * FACTORY-664 — best-effort, read-only `systemctl --user show butchr.service
 * -p DropInPaths -p EnvironmentFiles`, to say WHERE this daemon's environment
 * comes from (a drop-in file, an EnvironmentFile=, or neither). A FIXED
 * argv — no user input, no shell interpolation, ever. Any failure (no
 * systemd, no systemctl, the unit not found, a timeout) resolves to
 * `undefined`, never thrown — this is a nice-to-have hint, never a reason to
 * fail `GET /api/settings`.
 */
import { execFile } from "node:child_process";
import type { UnitHint } from "./settings-api.js";

const TIMEOUT_MS = 2000;

/** Parses `systemctl show`'s `Key=value1 value2 ...` lines (space-separated for multi-value properties like `DropInPaths`/`EnvironmentFiles`). */
export function parseSystemctlShow(output: string): UnitHint {
  const dropInPaths: string[] = [];
  const environmentFiles: string[] = [];
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const values = value.length > 0 ? value.split(/\s+/) : [];
    if (key === "DropInPaths") dropInPaths.push(...values);
    else if (key === "EnvironmentFiles") environmentFiles.push(...values);
  }
  return { dropInPaths, environmentFiles };
}

/** Real production read: never throws, never rejects — resolves `undefined` on any failure. */
export function readUnitHint(unit = "butchr.service"): Promise<UnitHint | undefined> {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", "show", unit, "-p", "DropInPaths", "-p", "EnvironmentFiles"], { timeout: TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      try {
        resolve(parseSystemctlShow(stdout));
      } catch {
        resolve(undefined);
      }
    });
  });
}
