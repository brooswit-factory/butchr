/**
 * FACTORY-569: a test fixture that needs "some absolute path" (not a
 * specific real one) must never hardcode a POSIX literal like `/home/x` —
 * FACTORY-558 made filesystem/session-definition validation platform-aware,
 * so a POSIX-shaped literal is correctly REJECTED once the suite actually
 * runs on win32. `absPath("home", "x")` gives the platform-native
 * equivalent instead: `/home/x` on posix, `C:\home\x` on win32.
 *
 * Mirrors `pathModuleFor` (src/resources/filesystem-query.ts) — same
 * injectable-`platform`-defaulting-to-`process.platform` pattern — so a host
 * running posix gets byte-identical output to the literal it replaces, and
 * the fixture is still correct the day this suite actually runs on win32.
 */
import { posix, win32 } from "node:path";

/** Platform-native root a fixture path is built from: `/` on posix, `C:\` on win32. Exported for callers that need to assert against the bare root itself. */
export function nativeRoot(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "C:\\" : "/";
}

/** `absPath("home", "x")` → `/home/x` (posix) or `C:\home\x` (win32). Segments are logical names, never containing a separator of either flavor. */
export function absPath(...segments: string[]): string {
  return absPathOn(process.platform, ...segments);
}

/** `absPath` with an explicit platform — for the rare fixture that must assert both shapes at once rather than just whatever the host happens to be. */
export function absPathOn(platform: NodeJS.Platform, ...segments: string[]): string {
  const p = platform === "win32" ? win32 : posix;
  return p.join(nativeRoot(platform), ...segments);
}
