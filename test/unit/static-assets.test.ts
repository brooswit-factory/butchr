import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAssetPath, resolveWebRoot, serveStaticAsset } from "../../src/web/static-assets.js";

// FACTORY-613 (replays FACTORY-432 / PR #546): a real built-app shape
// (index.html + a hashed asset under assets/), same layout
// `vite.config.ts`'s `build.outDir` actually produces — never a hand-picked
// filename that happens to match the handler's logic.
const root = mkdtempSync(join(tmpdir(), "butchr-web-root-"));
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html><div>dashboard app</div>");
writeFileSync(join(root, "assets", "index-abc123.js"), "console.log('hi')");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resolveAssetPath", () => {
  test("an extensionless path (the bare mount point, or a client-side route) falls back to index.html", () => {
    expect(resolveAssetPath(root, "/")).toBe(join(root, "index.html"));
    expect(resolveAssetPath(root, "/some/client/route")).toBe(join(root, "index.html"));
  });
  test("a path with a real extension resolves under root unchanged", () => {
    expect(resolveAssetPath(root, "/assets/index-abc123.js")).toBe(join(root, "assets/index-abc123.js"));
  });
  // Traversal only bites on a path WITH an extension: an extensionless
  // traversal attempt (no real file to point at anyway) falls back to
  // index.html first, same as any other extensionless path — still safely
  // inside root, just via the SPA-fallback branch rather than this guard.
  test("path traversal on a path with an extension is refused, never resolved outside root", () => {
    expect(resolveAssetPath(root, "/../../etc/passwd.conf")).toBeNull();
    expect(resolveAssetPath(root, "/assets/../../../etc/passwd.js")).toBeNull();
  });
});

describe("serveStaticAsset", () => {
  test("serves index.html for the bare mount point", async () => {
    const res = await serveStaticAsset(root, "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dashboard app");
  });
  test("serves a real built asset by its hashed path", async () => {
    const res = await serveStaticAsset(root, "/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("console.log");
  });
  test("404s (never crashes) for a missing file", async () => {
    const res = await serveStaticAsset(root, "/assets/does-not-exist.js");
    expect(res.status).toBe(404);
  });
  test("404s (never crashes) for a path-traversal attempt", async () => {
    const res = await serveStaticAsset(root, "/assets/../../../etc/passwd.js");
    expect(res.status).toBe(404);
  });
});

describe("resolveWebRoot", () => {
  test("prefers the bundled-shape sibling (moduleDir/web) when it exists", () => {
    const bundledParent = mkdtempSync(join(tmpdir(), "butchr-bundled-"));
    mkdirSync(join(bundledParent, "web"));
    try {
      expect(resolveWebRoot(bundledParent)).toBe(join(bundledParent, "web"));
    } finally {
      rmSync(bundledParent, { recursive: true, force: true });
    }
  });
  test("falls back to the from-source shape (moduleDir/../../dist/web) when the bundled sibling doesn't exist", () => {
    const empty = mkdtempSync(join(tmpdir(), "butchr-fromsource-"));
    try {
      expect(resolveWebRoot(empty)).toBe(join(empty, "..", "..", "dist", "web"));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
