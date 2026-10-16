import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";

// FACTORY-686: found by a real-browser pass of the Rules page. Through the
// REAL liveView (with its CSP / `X-Content-Type-Options: nosniff`
// `onAfterHandle` hook), every `/dashboard-app*` response lost its
// content-type, so a browser refused to run the module script and the app
// rendered blank. A unit test of `serveStaticAsset` alone could not see it
// (the header was dropped by the hook, not by the function): this goes
// through the app, exactly as a browser does.
const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;
const root = mkdtempSync(join(tmpdir(), "butchr-route-headers-"));
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html><div id=root></div>");
writeFileSync(join(root, "assets", "index-abc.js"), "console.log('x')");
writeFileSync(join(root, "assets", "index-abc.css"), "body{}");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function app() {
  const unused = () => { throw new Error("unused"); };
  return liveView(fakeMcp, { state: unused, open: unused, openPane: unused, health: unused, dashboard: unused, header: unused, resourceLink: unused, configInventory: unused, dashboardAppRoot: root } as unknown as ViewDeps);
}
const get = (path: string) => app().handle(new Request(`http://127.0.0.1:7717${path}`));

describe("/dashboard-app* through the real liveView keeps its content-type next to the security headers", () => {
  for (const [path, type] of [
    ["/dashboard-app", /^text\/html/],
    ["/dashboard-app/", /^text\/html/],
    ["/dashboard-app/rules", /^text\/html/], // a client-side route (deep link / refresh)
    ["/dashboard-app/assets/index-abc.js", /javascript/],
    ["/dashboard-app/assets/index-abc.css", /text\/css/],
  ] as const) {
    test(`${path}: content-type present, nosniff and CSP still applied`, async () => {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(type);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    });
  }
});
