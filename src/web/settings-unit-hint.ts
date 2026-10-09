/**
 * FACTORY-664 — best-effort, read-only `systemctl --user show butchr.service
 * -p DropInPaths -p EnvironmentFiles`, to say WHERE this daemon's environment
 * comes from (a drop-in file, an EnvironmentFile=, or neither). A FIXED
 * argv — no user input, no shell interpolation, ever. Any failure (no
 * systemd, no systemctl, the unit not found, a timeout) resolves to
 * `undefined`, never thrown — this is a nice-to-have hint, never a reason to
 * fail `GET /api/settings`.
 *
 * FACTORY-694 item 6: this value is effectively static for the life of the
 * process (the unit's drop-ins/EnvironmentFiles don't change without a
 * daemon restart, which re-execs this module from scratch anyway) — yet
 * every `GET /api/settings` call spawned a fresh `systemctl` child process
 * to re-read it. `createCachedUnitHint` wraps `readUnitHint` with a ~30s TTL
 * memo (one shared instance, built once at startup — see `src/daemon/
 * index.ts`): a request within the TTL of the last read gets the cached
 * value with NO new spawn, and concurrent requests during a cache miss
 * share the one in-flight read rather than each spawning their own.
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

const UNIT_HINT_TTL_MS = 30_000;

/**
 * FACTORY-694 item 6: wraps `read` (defaults to `readUnitHint`) with a TTL
 * memo — one shared instance, reused across every `GET /api/settings` call
 * for this process's lifetime (see `src/daemon/index.ts`'s one call site).
 * A failed read (`undefined`) is cached too, same TTL: a host with no
 * systemd stays a no-op `undefined` for 30s rather than re-spawning
 * `systemctl` on every single request. Concurrent calls during a cache miss
 * share the SAME in-flight promise — a burst of requests spawns exactly one
 * `systemctl` child, never one per request. `now` is injectable for tests
 * only; production uses `Date.now`.
 */
export function createCachedUnitHint(read: (unit?: string) => Promise<UnitHint | undefined> = readUnitHint, ttlMs = UNIT_HINT_TTL_MS, now: () => number = Date.now): (unit?: string) => Promise<UnitHint | undefined> {
  let cachedAt = -Infinity;
  let cachedValue: UnitHint | undefined;
  let inFlight: Promise<UnitHint | undefined> | null = null;
  return (unit?: string): Promise<UnitHint | undefined> => {
    const n = now();
    if (n - cachedAt < ttlMs) return Promise.resolve(cachedValue);
    if (inFlight) return inFlight;
    inFlight = read(unit).then((value) => {
      cachedValue = value;
      cachedAt = now();
      inFlight = null;
      return value;
    });
    return inFlight;
  };
}
