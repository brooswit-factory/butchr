/**
 * FACTORY-614: `dashboard-app/` now bundles `@launchpad-ui/components`
 * (0.25.0) and `@launchpad-ui/tokens` (0.19.0) into `dist/web/` — both
 * Apache-2.0, which requires the NOTICE/LICENSE text to travel with the
 * bundled code, not just sit in this repo's own devDependency lockfile.
 *
 * REVIEW FIX (first pass walked only the declared `dependencies` closure
 * of the two LaunchPad roots via `createRequire().resolve` — plausible,
 * but WRONG: review on butchr#614 built with `vite build --sourcemap` and
 * read the emitted map's `node_modules` sources, finding 12 packages
 * actually bundled against only 16 covered by the declared-closure walk,
 * missing `react`/`react-dom`/`scheduler`/`react-router` (MIT) and
 * `react-aria-components` (Apache-2.0) — all five reach the bundle
 * through PEER dependencies, which a `dependencies`-only walk from the
 * two LaunchPad roots structurally cannot see. `collectThirdPartyPackagesForBundle`
 * is the fix: it takes the REAL set of bundled module ids Vite's own
 * `generateBundle` hook reports (`vite.config.ts`'s plugin passes
 * `chunk.modules`'s keys), and resolves each `node_modules/<pkg>` segment
 * directly off disk — the exact installed instance that was actually
 * bundled, not a second, possibly-different resolution of the same name.
 * `collectThirdPartyPackages` (the original declared-closure walk) is kept
 * as a FALLBACK/CROSS-CHECK ONLY, unioned in afterward, per the review's
 * own instruction — it can still catch something the bundled-module-id
 * list misses (e.g. a side-effect-only asset a future bundler
 * configuration doesn't surface as a module id), but it is no longer the
 * primary signal.
 *
 * Pure (no writes) and exported as plain functions — unlike
 * `scripts/build/build.ts`, importing this module must not run anything
 * (see `scripts/load/inventory.ts`'s `RUNS_ON_IMPORT` — this file is
 * deliberately NOT on that list), so `vite.config.ts`'s own plugin is the
 * only thing that ever calls these and writes a result to disk.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ThirdPartyPackage {
  name: string;
  version: string;
  license: string;
  licenseText: string;
}

const DECLARED_CLOSURE_ROOTS = ["@launchpad-ui/components", "@launchpad-ui/tokens"] as const;
const LICENSE_FILE_CANDIDATES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE", "NOTICE.md"];

function findLicenseText(pkgDir: string): string {
  for (const name of LICENSE_FILE_CANDIDATES) {
    const path = join(pkgDir, name);
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
  }
  return "(no LICENSE/NOTICE file found in this package)";
}

function readPackageInfo(name: string, dir: string): ThirdPartyPackage {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license?: string; dependencies?: Record<string, string> };
  return { name, version: pkg.version, license: pkg.license ?? "UNKNOWN", licenseText: findLicenseText(dir) };
}

/** Walks `name`'s own `dependencies` (never `devDependencies`/`peerDependencies` — those don't ship, and are exactly what this walk alone was found to miss) transitively, resolved relative to `fromDir` so hoisted layouts resolve exactly like Node/bun would at runtime. */
function walkDeclaredClosure(name: string, fromDir: string, resolve: (specifier: string, fromDir: string) => string, seen: Map<string, ThirdPartyPackage>): void {
  if (seen.has(name)) return;
  const pkgJsonPath = resolve(`${name}/package.json`, fromDir);
  const dir = dirname(pkgJsonPath);
  seen.set(name, readPackageInfo(name, dir));
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { dependencies?: Record<string, string> };
  for (const dep of Object.keys(pkg.dependencies ?? {})) walkDeclaredClosure(dep, dir, resolve, seen);
}

/** FALLBACK/CROSS-CHECK ONLY — see this module's own header for why this alone is not sufficient. */
export function collectThirdPartyPackages(repoRoot: string): ThirdPartyPackage[] {
  const require = createRequire(join(repoRoot, "package.json"));
  const resolve = (specifier: string, fromDir: string) => require.resolve(specifier, { paths: [fromDir] });
  const seen = new Map<string, ThirdPartyPackage>();
  for (const root of DECLARED_CLOSURE_ROOTS) walkDeclaredClosure(root, repoRoot, resolve, seen);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const LAST_NODE_MODULES_SEGMENT = /node_modules\/((?:@[^/]+\/[^/]+)|[^/]+)(?=\/|$)/g;

/**
 * Finds the package a bundled MODULE ID (an absolute file path, as Vite
 * reports it) came from — the LAST `node_modules/<pkg>` segment, so a
 * nested, non-hoisted copy (`node_modules/a/node_modules/b/...`) resolves
 * to the inner package `b` that actually owns the bundled code, not the
 * outer one that merely happens to contain it. `null` for an id with no
 * `node_modules` segment at all (this app's own source files) or whose
 * matched name starts with `.` (a bundler-internal pseudo-package, e.g.
 * a `.vite` cache dir — never a real published package). Rollup marks a
 * plugin-synthesized virtual module id with a leading NUL byte — observed
 * in practice for an internal `.../node_modules/react/package.json`
 * bookkeeping entry, not real runtime code — which `readFileSync` refuses
 * outright (a path containing a NUL byte), so it is stripped before
 * matching; the real `node_modules/<pkg>` directory underneath still
 * resolves correctly either way.
 */
export function packageAtModuleId(rawId: string): { name: string; dir: string } | null {
  const id = rawId.replace(/\0/g, "");
  let last: RegExpExecArray | null = null;
  LAST_NODE_MODULES_SEGMENT.lastIndex = 0;
  for (let m = LAST_NODE_MODULES_SEGMENT.exec(id); m; m = LAST_NODE_MODULES_SEGMENT.exec(id)) last = m;
  if (!last || last[1]!.startsWith(".")) return null;
  return { name: last[1]!, dir: id.slice(0, last.index + last[0].length) };
}

/** Every distinct package name `moduleIds` resolves to via `packageAtModuleId`, in first-seen order. */
export function bundledPackageNames(moduleIds: readonly string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const id of moduleIds) {
    const info = packageAtModuleId(id);
    if (info && !seen.has(info.name)) {
      seen.add(info.name);
      names.push(info.name);
    }
  }
  return names;
}

/**
 * THE primary signal (see this module's header): resolves every package
 * Vite's own bundled module ids point at, directly off disk, then unions
 * in the declared-closure walk as a fallback only.
 */
export function collectThirdPartyPackagesForBundle(repoRoot: string, moduleIds: readonly string[]): ThirdPartyPackage[] {
  const seen = new Map<string, ThirdPartyPackage>();
  for (const id of moduleIds) {
    const info = packageAtModuleId(id);
    if (info && !seen.has(info.name)) seen.set(info.name, readPackageInfo(info.name, info.dir));
  }
  for (const pkg of collectThirdPartyPackages(repoRoot)) {
    if (!seen.has(pkg.name)) seen.set(pkg.name, pkg);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The build-level guarantee the review asked for: throws (failing the
 * build, when called from `vite.config.ts`'s `closeBundle`) if ANY
 * actually-bundled package — per `moduleIds`, the same signal
 * `collectThirdPartyPackagesForBundle` itself resolves from — is absent
 * from `packages`. This is what makes "the notices file is missing a
 * bundled package" a build failure instead of a silent gap next time
 * something new gets pulled in.
 */
export function assertAllBundledPackagesCovered(moduleIds: readonly string[], packages: readonly ThirdPartyPackage[]): void {
  const covered = new Set(packages.map((p) => p.name));
  const missing = bundledPackageNames(moduleIds).filter((name) => !covered.has(name));
  if (missing.length > 0) {
    throw new Error(`dist/web/THIRD_PARTY_NOTICES.txt is missing ${missing.length} actually-bundled package(s): ${missing.sort().join(", ")}`);
  }
}

export function renderThirdPartyNotices(packages: readonly ThirdPartyPackage[]): string {
  const header =
    "Third-party notices\n" +
    "====================\n" +
    "This bundle includes code from the following packages (every package\n" +
    "Vite's own build actually bundled, resolved from its module ids —\n" +
    "see scripts/build/web-notices.ts for exactly how this list is computed).\n\n";
  const entries = packages.map((p) => `--------------------------------------------------------------------\n${p.name}@${p.version} (${p.license})\n--------------------------------------------------------------------\n${p.licenseText}\n`);
  return header + entries.join("\n");
}

export function collectThirdPartyNoticesForBundle(repoRoot: string, moduleIds: readonly string[]): string {
  const packages = collectThirdPartyPackagesForBundle(repoRoot, moduleIds);
  assertAllBundledPackagesCovered(moduleIds, packages);
  return renderThirdPartyNotices(packages);
}
