import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * FACTORY-432: bundles `dashboard-app/` (the React 19 dashboard) into
 * `dist/web/` — a sibling of `dist/butchr.js` (see scripts/build/build.ts),
 * which `src/web/static-assets.ts`'s `resolveWebRoot` expects. Not yet
 * consumed by any served page (src/web/view.ts's `/` and `/configurations`
 * are untouched) — this Task stands up the pipeline only.
 */
export default defineConfig({
  root: "dashboard-app",
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
