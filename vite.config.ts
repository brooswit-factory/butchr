import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { collectThirdPartyNoticesForBundle } from "./scripts/build/web-notices.js";

/**
 * FACTORY-613 (replays FACTORY-432 / PR #546): bundles `dashboard-app/` (the
 * React 19 dashboard) into `dist/web/` — a sibling of `dist/butchr.js` (see
 * scripts/build/build.ts), which `src/web/static-assets.ts`'s
 * `resolveWebRoot` expects.
 *
 * FACTORY-614: `@launchpad-ui/components`/`@launchpad-ui/tokens` (both
 * Apache-2.0) are now bundled into that same `dist/web/`, so this build
 * must emit a notices file alongside it. Done as a plugin (not a separate
 * `bun run` step) so `vite build` alone — the one command
 * `scripts/build/build.ts` already calls — always produces a complete
 * `dist/web/`, with no second script to remember to run.
 *
 * REVIEW FIX: `generateBundle` is the hook that actually sees every output
 * chunk's real `modules` map — the review on butchr#614 found the first
 * pass's declared-dependency-closure walk missed five packages (react,
 * react-dom, scheduler, react-router, react-aria-components) that reach
 * the bundle only through PEER dependencies. Collecting every chunk's
 * module ids here and resolving packages from THOSE (see
 * `web-notices.ts`'s own header) is what actually matches what shipped;
 * `closeBundle` then fails the build (via `assertAllBundledPackagesCovered`,
 * inside `collectThirdPartyNoticesForBundle`) if any bundled package is
 * still missing, rather than writing a silently incomplete file.
 */
const thirdPartyNoticesPlugin = (): Plugin => {
  const moduleIds: string[] = [];
  return {
    name: "butchr-third-party-notices",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === "chunk") moduleIds.push(...Object.keys(chunk.modules));
      }
    },
    closeBundle() {
      // FACTORY-927 (review round 1, item 1 — a CI failure traced here,
      // not caused by that ticket's own diff): `closeBundle` is documented
      // to run after `writeBundle` (i.e. after `dist/web` already has
      // every chunk written to it), but was observed, on an otherwise
      // unmodified build, to sometimes fire before `outDir` exists —
      // `writeFileSync` below then fails on a MISSING DIRECTORY, not a
      // missing file, which is this plugin's own output path's problem to
      // guard against regardless of why the ordering slipped. `mkdirSync`
      // is idempotent (`recursive: true`) and a no-op on the normal path
      // where the directory already exists.
      const dir = join(import.meta.dirname, "dist", "web");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "THIRD_PARTY_NOTICES.txt"), collectThirdPartyNoticesForBundle(import.meta.dirname, moduleIds));
    },
  };
};

export default defineConfig({
  root: "dashboard-app",
  // FACTORY-642: the app is served under /dashboard-app/ (src/web/view.ts
  // registers /dashboard-app and /dashboard-app/*), but with no `base` Vite
  // emitted asset URLs from `/` instead — `/assets/*` 404s because nothing
  // serves assets there, only under `/dashboard-app/assets/*`.
  base: "/dashboard-app/",
  plugins: [react(), thirdPartyNoticesPlugin()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
