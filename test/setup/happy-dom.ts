/**
 * FACTORY-614: scoped DOM registration for the dashboard-app component
 * tests ONLY — deliberately NOT added to `bunfig.toml`'s global `preload`
 * list, unlike `./isolated-workspaces.ts`. `@happy-dom/global-registrator`
 * replaces `globalThis.fetch`/`Request`/`Response`/etc with its own
 * implementations; registering it for the WHOLE suite would risk changing
 * fetch behavior for every other test in this repo that touches a network
 * boundary, for the sake of a handful of files that need `document`. Each
 * `.test.tsx` file instead calls `withDom()` itself (register in
 * `beforeAll`, unmount/drain/unregister in `afterAll`), so the blast radius is exactly
 * that one file's test run.
 */
import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup } from "@testing-library/react";
import { createRequire } from "node:module";
const scheduler = createRequire(import.meta.url)("scheduler") as {
  unstable_IdlePriority: number;
  unstable_scheduleCallback: (priority: number, callback: () => void) => unknown;
};

export function withDom(): void {
  beforeAll(() => {
    GlobalRegistrator.register();
  });
  afterAll(async () => {
    try {
      // Unmount roots and flush React's act queue while window still exists.
      // The idle-priority barrier also drains already-posted scheduler work,
      // including passive callbacks queued outside act. A sleep cannot prove
      // that work completed when a full suite competes for the event loop.
      await act(async () => {
        cleanup();
        await new Promise<void>((resolve) => scheduler.unstable_scheduleCallback(scheduler.unstable_IdlePriority, resolve));
      });
    } finally {
      await GlobalRegistrator.unregister();
    }
  });
}
