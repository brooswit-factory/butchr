import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { collectThirdPartyNotices } from "./scripts/build/web-notices.js";

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
 */
const thirdPartyNoticesPlugin = (): Plugin => ({
  name: "butchr-third-party-notices",
  closeBundle() {
    writeFileSync(join(import.meta.dirname, "dist", "web", "THIRD_PARTY_NOTICES.txt"), collectThirdPartyNotices(import.meta.dirname));
  },
});

export default defineConfig({
  root: "dashboard-app",
  plugins: [react(), thirdPartyNoticesPlugin()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
