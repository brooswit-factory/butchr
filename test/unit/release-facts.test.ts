import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherFacts } from "../../scripts/release/facts.js";

/** A throwaway git repo: main has 0.1.0; a branch bumps to 0.1.1 and touches src/ + the schema. */
function repo() {
  const d = mkdtempSync(join(tmpdir(), "facts-"));
  const sh = (c: string) => execSync(c, { cwd: d, stdio: "ignore" });
  sh("git init -q -b main && git config user.email t@t && git config user.name t");
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@probe/none-such-pkg-zz", version: "0.1.0" }));
  writeFileSync(join(d, "CHANGELOG.md"), "# C\n## [0.1.0] - 2026-01-01\n### Added\n- a\n");
  sh("mkdir -p src schema && echo x > src/a.ts && echo '{}' > schema/herdr-api.schema.json && git add -A && git commit -qm base");
  sh("git checkout -qb feat");
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@probe/none-such-pkg-zz", version: "0.1.1" }));
  writeFileSync(join(d, "CHANGELOG.md"), "# C\n## [0.1.1] - 2026-01-02\n### Fixed\n- b\n## [0.1.0] - 2026-01-01\n### Added\n- a\n");
  sh("echo y > src/a.ts && echo '{\"v\":2}' > schema/herdr-api.schema.json && git add -A && git commit -qm bump");
  return d;
}
describe("gatherFacts reads git + registry", () => {
  test("versions, changed files, schemaChanged, base changelog, unpublished registry → null", () => {
    const d = repo(); const cwd = process.cwd(); process.chdir(d);
    try {
      const f = gatherFacts("main", "@probe/none-such-pkg-zz");
      expect(f.version).toBe("0.1.1"); expect(f.baseVersion).toBe("0.1.0");
      expect(f.changedFiles.sort()).toEqual(["CHANGELOG.md", "package.json", "schema/herdr-api.schema.json", "src/a.ts"]);
      expect(f.schemaChanged).toBe(true);
      expect(f.baseChangelog).toContain("[0.1.0]"); expect(f.baseChangelog).not.toContain("[0.1.1]");
      expect(f.registryLatest).toBeNull();
      expect(f.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally { process.chdir(cwd); }
  }, 20_000);
  test("a base commit that has no package.json reads as 0.0.0", () => {
    const d = mkdtempSync(join(tmpdir(), "facts-")); const sh = (c: string) => execSync(c, { cwd: d, stdio: "ignore" });
    sh("git init -q -b main && git config user.email t@t && git config user.name t");
    writeFileSync(join(d, "CHANGELOG.md"), "# C\n"); sh("git add -A && git commit -qm root");   // root: no package.json
    sh("git checkout -qb feat"); writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@probe/none-such-pkg-zz", version: "0.1.0" }));
    sh("git add -A && git commit -qm add-pkg");
    const cwd = process.cwd(); process.chdir(d);
    try { expect(gatherFacts("main", "@probe/none-such-pkg-zz").baseVersion).toBe("0.0.0"); } finally { process.chdir(cwd); }
  }, 20_000);
});
