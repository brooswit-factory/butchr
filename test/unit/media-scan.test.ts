import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  findUnexplainedRegistryModules,
  formatUnexpectedRegistryModulesError,
  KNOWN_NON_MEDIUM_REGISTRY_MODULES,
  listRegistryModules,
} from "../../src/media/media-scan.js";
import { MEDIA_REGISTRY } from "../../src/media/registry.js";

const ROOT = join(import.meta.dir, "..", "..");

describe("listRegistryModules", () => {
  test("finds a registry.ts one level under a directory, ignores everything else", () => {
    // Uses the real repo tree rather than a synthetic fixture directory — the
    // convention this scans for (src/<dir>/registry.ts) is defined by the
    // real repo layout, and label-scan.ts/header-scan.ts's own tests take
    // the same approach for their own "scan the real tree" describe block.
    const modules = listRegistryModules(join(ROOT, "src"), ROOT);
    expect(modules).toContain("src/labels/registry.ts");
    expect(modules).toContain("src/headers/registry.ts");
    expect(modules).toContain("src/workspace/registry.ts");
    expect(modules).toContain("src/media/registry.ts");
    expect(modules.every((m) => m.endsWith("/registry.ts"))).toBe(true);
  });
});

describe("findUnexplainedRegistryModules", () => {
  const exclusions = [{ path: "src/media/registry.ts", reason: "test fixture exclusion" }];

  test("keeps only modules that are not a known exclusion", () => {
    const modules = ["src/labels/registry.ts", "src/media/registry.ts", "src/rogue/registry.ts"];
    expect(findUnexplainedRegistryModules(modules, exclusions)).toEqual(["src/labels/registry.ts", "src/rogue/registry.ts"]);
  });

  test("empty input or everything excluded yields no findings", () => {
    expect(findUnexplainedRegistryModules([], exclusions)).toEqual([]);
    expect(findUnexplainedRegistryModules(["src/media/registry.ts"], exclusions)).toEqual([]);
  });
});

describe("formatUnexpectedRegistryModulesError", () => {
  const msg = formatUnexpectedRegistryModulesError(["src/rogue/registry.ts"], ["src/labels/registry.ts"]);

  test("names the found and expected sets", () => {
    expect(msg).toContain("src/rogue/registry.ts");
    expect(msg).toContain("src/labels/registry.ts");
  });
  test("points at MEDIA_REGISTRY and the exclusion file", () => {
    expect(msg).toContain("MEDIA_REGISTRY");
    expect(msg).toContain("media-scan.ts");
  });
});

describe("the actual automatic check — this IS the falsifier, run for real against src/ on every `bun test`", () => {
  const modules = listRegistryModules(join(ROOT, "src"), ROOT);
  const explained = findUnexplainedRegistryModules(modules);

  test("matches exactly the three file-backed media registries — labels, headers, workspace. The fourth medium (docTitle, MEDIA_REGISTRY's own key) has no registry.ts of its own — see that entry's detector: null / noDetectorReason — and is declared here by hand, not discovered by this check; that is this check's own named blind spot (src/media/media-scan.ts's header).", () => {
    if (explained.length !== 3) throw new Error(formatUnexpectedRegistryModulesError(explained, ["src/headers/registry.ts", "src/labels/registry.ts", "src/workspace/registry.ts"]));
    expect(explained).toEqual(["src/headers/registry.ts", "src/labels/registry.ts", "src/workspace/registry.ts"]);
  });

  test("src/media/registry.ts itself is excluded, with a written reason, not special-cased away silently", () => {
    expect(KNOWN_NON_MEDIUM_REGISTRY_MODULES.some((e) => e.path === "src/media/registry.ts")).toBe(true);
    expect(KNOWN_NON_MEDIUM_REGISTRY_MODULES.find((e) => e.path === "src/media/registry.ts")!.reason.length).toBeGreaterThan(0);
  });

  test("MEDIA_REGISTRY declares exactly one more medium (docTitle) than there are file-backed registry modules — the gap this check cannot close on its own", () => {
    expect(Object.keys(MEDIA_REGISTRY).length).toBe(explained.length + 1);
  });

  test("INJECTED FALSIFIER (this ticket's own falsifier, restated as an in-memory regression pin — see the PR body for the real, run-and-reverted construction of src/example-injected/registry.ts on disk): a new registry module with no MEDIA_REGISTRY entry is caught", () => {
    const injected = [...modules, "src/example-injected/registry.ts"].sort();
    const unexplained = findUnexplainedRegistryModules(injected);
    expect(unexplained).toContain("src/example-injected/registry.ts");
  });
});
