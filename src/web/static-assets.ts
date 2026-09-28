import { existsSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * FACTORY-432: serves the Vite-built dashboard app (`dashboard-app/`,
 * `vite.config.ts`). New plumbing only — nothing on `/` or `/configurations`
 * (src/web/view.ts) links to `/dashboard-app` yet; a later Story in the
 * epic (FACTORY-427) points real pages at these assets once they exist.
 */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Where the built web app lives, relative to THIS SOURCE FILE'S OWN resolved
 * location — never `process.cwd()`, same discipline as
 * `src/agents/build-identity.ts`'s `MODULE_DIR` (a systemd unit's
 * `WorkingDirectory=` can point anywhere).
 *
 * Two candidates because `Bun.build` (scripts/build/build.ts) flattens every
 * source file into one output at `dist/butchr.js`: bundled, THIS file's own
 * dir becomes `dist/`, so the build's `dist/web` output is the sibling
 * `./web`. Running from source (`bun run src/daemon/index.ts`, no build
 * step) keeps the real `src/web/` nesting instead, so the same `dist/web`
 * is two levels up. Whichever candidate exists on disk wins; if neither does
 * (web app not built yet) the bundled-shape candidate is returned anyway and
 * every request 404s (see `serveStaticAsset`) — never a crash, never a guess.
 */
export function resolveWebRoot(moduleDir: string = MODULE_DIR): string {
  const bundled = join(moduleDir, "web");
  const fromSource = join(moduleDir, "..", "..", "dist", "web");
  return existsSync(bundled) ? bundled : fromSource;
}

/**
 * Resolves a `/dashboard-app`-relative request path to a file inside `root`.
 * Returns `null` (never throws) for a path that would escape `root` via
 * `..` segments. A path with no file extension — the bare mount point, or a
 * client-side route Vite's own build doesn't have a literal file for — falls
 * back to `index.html`, the SPA convention `vite.config.ts`'s `build.outDir`
 * output expects.
 */
export function resolveAssetPath(root: string, requestPath: string): string | null {
  const rel = requestPath.replace(/^\/+/, "");
  const withExt = /\.[a-zA-Z0-9]+$/.test(rel) ? rel : "index.html";
  const normalized = normalize(withExt);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.startsWith("/")) return null;
  return join(root, normalized);
}

/** Serves one `/dashboard-app` request. 404 (never a crash) when the path escapes `root` or the file is missing — expected, not an error, until the web app is actually built. */
export async function serveStaticAsset(root: string, requestPath: string): Promise<Response> {
  const path = resolveAssetPath(root, requestPath);
  if (!path) return new Response("not found", { status: 404 });
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file);
}
