import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherFacts } from "../../scripts/release/facts.js";
import { evaluate } from "../../scripts/release/gate.js";

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
describe("gatherFacts reads git", () => {
  test("versions, changed files, schemaChanged, base changelog", () => {
    const d = repo(); const cwd = process.cwd(); process.chdir(d);
    try {
      const f = gatherFacts("main");
      expect(f.version).toBe("0.1.1"); expect(f.baseVersion).toBe("0.1.0");
      expect(f.changedFiles.sort()).toEqual(["CHANGELOG.md", "package.json", "schema/herdr-api.schema.json", "src/a.ts"]);
      expect(f.schemaChanged).toBe(true);
      expect(f.baseChangelog).toContain("[0.1.0]"); expect(f.baseChangelog).not.toContain("[0.1.1]");
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
    try { expect(gatherFacts("main").baseVersion).toBe("0.0.0"); } finally { process.chdir(cwd); }
  }, 20_000);
});

describe("gatherFacts.newFragments", () => {
  test("only changelog.d/*.md files ADDED by this branch — not README.md, not files merely modified", () => {
    const d = mkdtempSync(join(tmpdir(), "facts-frag-")); const sh = (c: string) => execSync(c, { cwd: d, stdio: "ignore" });
    sh("git init -q -b main && git config user.email t@t && git config user.name t");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@probe/none-such-pkg-zz", version: "0.5.0" }));
    writeFileSync(join(d, "CHANGELOG.md"), "# C\n## [0.5.0] - 2026-01-01\n### Added\n- a\n");
    execSync("mkdir -p changelog.d", { cwd: d });
    writeFileSync(join(d, "changelog.d/README.md"), "format docs\n");
    writeFileSync(join(d, "changelog.d/OLD.md"), "bump: patch\n### Fixed\n- pre-existing\n");
    sh("git add -A && git commit -qm base");
    sh("git checkout -qb feat");
    writeFileSync(join(d, "changelog.d/NEW.md"), "bump: minor\n### Added\n- a new thing\n"); // added by this branch
    writeFileSync(join(d, "changelog.d/OLD.md"), "bump: patch\n### Fixed\n- pre-existing (edited)\n"); // merely modified
    sh("git add -A && git commit -qm feat");
    const cwd = process.cwd(); process.chdir(d);
    try {
      const f = gatherFacts("main");
      expect(f.newFragments.map((x) => x.path)).toEqual(["changelog.d/NEW.md"]);
      expect(f.newFragments[0]!.bump).toBe("minor");
      expect(f.newFragments[0]!.sections.Added).toEqual(["a new thing"]);
    } finally { process.chdir(cwd); }
  }, 20_000);

  test("no changelog.d/ directory at all reads as no new fragments, not a crash", () => {
    const d = mkdtempSync(join(tmpdir(), "facts-nofrag-")); const sh = (c: string) => execSync(c, { cwd: d, stdio: "ignore" });
    sh("git init -q -b main && git config user.email t@t && git config user.name t");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@probe/none-such-pkg-zz", version: "0.5.0" }));
    writeFileSync(join(d, "CHANGELOG.md"), "# C\n## [0.5.0] - 2026-01-01\n### Added\n- a\n");
    sh("git add -A && git commit -qm base");
    sh("git checkout -qb feat"); writeFileSync(join(d, "README.md"), "docs\n"); sh("git add -A && git commit -qm docs");
    const cwd = process.cwd(); process.chdir(d);
    try { expect(gatherFacts("main").newFragments).toEqual([]); } finally { process.chdir(cwd); }
  }, 20_000);
});

describe("gatherFacts.baseVersion is merge-base relative (KAN-788)", () => {
  test("a stale branch (base moved ahead while the branch only touched an ungated file) reads as no-release-required, not a downgrade", () => {
    const d = mkdtempSync(join(tmpdir(), "facts-stale-")); const sh = (c: string) => execSync(c, { cwd: d, stdio: "ignore" });
    sh("git init -q -b main && git config user.email t@t && git config user.name t");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@probe/none-such-pkg-zz", version: "0.5.0" }));
    writeFileSync(join(d, "CHANGELOG.md"), "# C\n## [0.5.0] - 2026-01-01\n### Added\n- a\n");
    sh("git add -A && git commit -qm base");
    sh("git checkout -qb feat");
    writeFileSync(join(d, "README.md"), "docs only\n"); // ungated — branch's own diff never touches package.json/src/schema
    sh("git add -A && git commit -qm docs");
    sh("git checkout -q main");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@probe/none-such-pkg-zz", version: "0.6.0" }));
    writeFileSync(join(d, "CHANGELOG.md"), "# C\n## [0.6.0] - 2026-01-02\n### Added\n- b\n## [0.5.0] - 2026-01-01\n### Added\n- a\n");
    sh("git add -A && git commit -qm main-bump"); // main moves on while feat sits still
    sh("git checkout -q feat");
    const cwd = process.cwd(); process.chdir(d);
    try {
      const f = gatherFacts("main");
      expect(f.version).toBe("0.5.0");
      expect(f.baseVersion).toBe("0.5.0"); // merge-base version, NOT main's tip 0.6.0
      expect(f.baseTipVersion).toBe("0.6.0");
      const r = evaluate(f);
      expect(r.required).toBe(false);
      expect(r.ok, JSON.stringify(r.verdicts)).toBe(true);
      expect(r.verdicts[0]!.reason).not.toMatch(/version changed/);
      expect(r.verdicts[0]!.reason).toMatch(/no gated files changed; no release required/);
    } finally { process.chdir(cwd); }
  }, 20_000);

  test("a genuine downgrade on a branch that IS at the merge-base still fails — the fix must not blunt the real check", () => {
    const d = mkdtempSync(join(tmpdir(), "facts-downgrade-")); const sh = (c: string) => execSync(c, { cwd: d, stdio: "ignore" });
    sh("git init -q -b main && git config user.email t@t && git config user.name t");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@probe/none-such-pkg-zz", version: "0.5.0" }));
    writeFileSync(join(d, "CHANGELOG.md"), "# C\n## [0.5.0] - 2026-01-01\n### Added\n- a\n");
    sh("git add -A && git commit -qm base");
    sh("git checkout -qb feat");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@probe/none-such-pkg-zz", version: "0.4.0" })); // own commit lowers the version
    sh("git add -A && git commit -qm oops-downgrade"); // main never moves — branch IS at the merge-base
    const cwd = process.cwd(); process.chdir(d);
    try {
      const f = gatherFacts("main");
      expect(f.baseVersion).toBe("0.5.0");
      expect(f.baseTipVersion).toBe("0.5.0"); // not stale: merge-base === base tip
      const r = evaluate(f);
      expect(r.ok).toBe(false);
      expect(r.verdicts.some((v) => !v.ok && /0\.5\.0 → 0\.4\.0/.test(v.reason))).toBe(true);
    } finally { process.chdir(cwd); }
  }, 20_000);
});
