import { describe, expect, test } from "bun:test";
import { collectThirdPartyPackages, renderThirdPartyNotices } from "../../scripts/build/web-notices.js";

const ROOT = new URL("../..", import.meta.url).pathname;

describe("collectThirdPartyPackages — FACTORY-614", () => {
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

describe("renderThirdPartyNotices — FACTORY-614", () => {
  test("renders one section per package, each carrying its own name@version(license) and license text", () => {
    const text = renderThirdPartyNotices([{ name: "pkg-a", version: "1.0.0", license: "Apache-2.0", licenseText: "LICENSE BODY" }]);
    expect(text).toContain("pkg-a@1.0.0 (Apache-2.0)");
    expect(text).toContain("LICENSE BODY");
  });
});
