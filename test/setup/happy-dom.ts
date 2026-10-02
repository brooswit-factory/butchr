/**
 * FACTORY-614: scoped DOM registration for the dashboard-app component
 * tests ONLY — deliberately NOT added to `bunfig.toml`'s global `preload`
 * list, unlike `./isolated-workspaces.ts`. `@happy-dom/global-registrator`
 * replaces `globalThis.fetch`/`Request`/`Response`/etc with its own
 * implementations; registering it for the WHOLE suite would risk changing
 * fetch behavior for every other test in this repo that touches a network
 * boundary, for the sake of a handful of files that need `document`. Each
 * `.test.tsx` file instead calls `withDom()` itself (register in
 * `beforeAll`, unregister in `afterAll`), so the blast radius is exactly
 * that one file's test run.
 */
import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function withDom(): void {
  beforeAll(() => {
    GlobalRegistrator.register();
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });
}
