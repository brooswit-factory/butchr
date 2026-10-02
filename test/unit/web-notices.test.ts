import { describe, expect, test } from "bun:test";
import {
  assertAllBundledPackagesCovered,
  bundledPackageNames,
  collectThirdPartyNoticesForBundle,
  collectThirdPartyPackages,
  collectThirdPartyPackagesForBundle,
  packageAtModuleId,
  renderThirdPartyNotices,
  type ThirdPartyPackage,
} from "../../scripts/build/web-notices.js";

const ROOT = new URL("../..", import.meta.url).pathname;

describe("packageAtModuleId (pure) — FACTORY-614", () => {
  test("unscoped package", () => {
    expect(packageAtModuleId("/repo/node_modules/react-dom/index.js")).toEqual({ name: "react-dom", dir: "/repo/node_modules/react-dom" });
  });

  test("scoped package", () => {
    expect(packageAtModuleId("/repo/node_modules/@launchpad-ui/tokens/dist/index.es.js")).toEqual({ name: "@launchpad-ui/tokens", dir: "/repo/node_modules/@launchpad-ui/tokens" });
  });

  test("nested, non-hoisted copy resolves to the INNER package that actually owns the bundled code", () => {
    expect(packageAtModuleId("/repo/node_modules/a/node_modules/b/index.js")).toEqual({ name: "b", dir: "/repo/node_modules/a/node_modules/b" });
  });

  test("REVIEW FIX: a Rollup virtual id (leading NUL byte) still resolves — must not crash, and must not keep the NUL in `dir`", () => {
    const result = packageAtModuleId("\0/repo/node_modules/react/package.json");
    expect(result).toEqual({ name: "react", dir: "/repo/node_modules/react" });
    expect(result?.dir.includes("\0")).toBe(false);
  });

  test("no node_modules segment at all (this app's own source) -> null", () => {
    expect(packageAtModuleId("/repo/dashboard-app/src/App.tsx")).toBeNull();
  });

  test("a bundler-internal pseudo-package starting with '.' -> null, never mistaken for a real published package", () => {
    expect(packageAtModuleId("/repo/node_modules/.vite/deps/react.js")).toBeNull();
  });
});

describe("bundledPackageNames (pure) — FACTORY-614", () => {
  test("deduplicates, first-seen order, skips non-package ids", () => {
    const ids = ["/repo/dashboard-app/src/App.tsx", "/repo/node_modules/react/index.js", "/repo/node_modules/react-dom/index.js", "/repo/node_modules/react/jsx-runtime.js"];
    expect(bundledPackageNames(ids)).toEqual(["react", "react-dom"]);
  });
});

describe("collectThirdPartyPackagesForBundle — FACTORY-614 (review fix)", () => {
  test("resolves a package from a bundled module id even though it is NOT in the two LaunchPad roots' declared `dependencies` closure — the exact gap the review found (react/react-dom/scheduler/react-router/react-aria-components reach the bundle only via peer deps)", () => {
    const moduleIds = [join(ROOT, "node_modules/react-dom/index.js"), join(ROOT, "node_modules/react-router/dist/development/index.js")];
    const packages = collectThirdPartyPackagesForBundle(ROOT, moduleIds);
    const names = packages.map((p) => p.name);
    expect(names).toContain("react-dom");
    expect(names).toContain("react-router");
    // Neither is reachable from the declared-closure walk alone:
    const declaredOnly = collectThirdPartyPackages(ROOT).map((p) => p.name);
    expect(declaredOnly).not.toContain("react-dom");
    expect(declaredOnly).not.toContain("react-router");
  });

  test("still includes the declared-closure packages even when no module id points at them (fallback/cross-check union)", () => {
    const packages = collectThirdPartyPackagesForBundle(ROOT, []);
    expect(packages.map((p) => p.name)).toContain("@launchpad-ui/tokens");
  });

  test("a package reachable BOTH ways is not duplicated", () => {
    const moduleIds = [join(ROOT, "node_modules/@launchpad-ui/tokens/dist/index.es.js")];
    const packages = collectThirdPartyPackagesForBundle(ROOT, moduleIds);
    expect(packages.filter((p) => p.name === "@launchpad-ui/tokens").length).toBe(1);
  });
});

describe("assertAllBundledPackagesCovered — FACTORY-614 (the build-level guarantee the review required)", () => {
  const covered: ThirdPartyPackage[] = [{ name: "react-dom", version: "19.3.0", license: "MIT", licenseText: "x" }];

  test("passes silently when every bundled package is covered", () => {
    expect(() => assertAllBundledPackagesCovered(["/repo/node_modules/react-dom/index.js"], covered)).not.toThrow();
  });

  test("MUTATION CHECK: throws naming the missing package when a bundled package is NOT in the notices — this is exactly the defect the review found live (dist/web/THIRD_PARTY_NOTICES.txt silently missing 5 bundled packages)", () => {
    expect(() => assertAllBundledPackagesCovered(["/repo/node_modules/react-dom/index.js", "/repo/node_modules/scheduler/index.js"], covered)).toThrow(/scheduler/);
  });
});

describe("collectThirdPartyPackages (fallback/cross-check only) — FACTORY-614", () => {
  test("includes both direct LaunchPad roots, each Apache-2.0, with real non-empty license text", () => {
    const packages = collectThirdPartyPackages(ROOT);
    const components = packages.find((p) => p.name === "@launchpad-ui/components");
    const tokens = packages.find((p) => p.name === "@launchpad-ui/tokens");
    expect(components).toBeDefined();
    expect(tokens).toBeDefined();
    expect(components?.version).toBe("0.25.0");
    expect(tokens?.version).toBe("0.19.0");
    expect(components?.license).toBe("Apache-2.0");
    expect(tokens?.license).toBe("Apache-2.0");
    expect(components?.licenseText.length).toBeGreaterThan(0);
    expect(components?.licenseText).not.toContain("no LICENSE/NOTICE file found");
  });

  test("walks past the two roots into their own real runtime dependencies, deduplicated by name", () => {
    const packages = collectThirdPartyPackages(ROOT);
    const names = packages.map((p) => p.name);
    expect(names).toContain("@internationalized/date");
    expect(new Set(names).size).toBe(names.length);
  });

  test("MUTATION CHECK: a mutation that walks devDependencies too (code this never ships) would pull in build/test-only tooling like 'typescript' — must never appear here", () => {
    const packages = collectThirdPartyPackages(ROOT);
    expect(packages.some((p) => p.name === "typescript")).toBe(false);
  });
});

describe("collectThirdPartyNoticesForBundle (the function vite.config.ts actually calls) — FACTORY-614", () => {
  test("end to end: resolves + asserts + renders, finding a package only reachable via a bundled module id (react-dom) alongside the declared-closure fallback (@launchpad-ui/tokens)", () => {
    const text = collectThirdPartyNoticesForBundle(ROOT, [join(ROOT, "node_modules/react-dom/index.js")]);
    expect(text).toContain("react-dom@");
    expect(text).toContain("@launchpad-ui/tokens@0.19.0");
  });
});

describe("renderThirdPartyNotices — FACTORY-614", () => {
  test("renders one section per package, each carrying its own name@version(license) and license text", () => {
    const text = renderThirdPartyNotices([{ name: "pkg-a", version: "1.0.0", license: "Apache-2.0", licenseText: "LICENSE BODY" }]);
    expect(text).toContain("pkg-a@1.0.0 (Apache-2.0)");
    expect(text).toContain("LICENSE BODY");
  });
});

function join(a: string, b: string): string {
  return a.replace(/\/+$/, "") + "/" + b;
}
