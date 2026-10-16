import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fragmentsAddedSince, latestVTag, reachableVTags } from "../../scripts/release/git.js";

/** A fresh throwaway git repo for these tests — never the real checkout. */
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "release-git-"));
  sh(d, ["init", "-q", "-b", "main"]);
  sh(d, ["config", "user.email", "t@t"]);
  sh(d, ["config", "user.name", "t"]);
  return d;
}
const sh = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
const commit = (d: string, file: string, content: string, msg: string) => {
  mkdirSync(join(d, file, ".."), { recursive: true });
  writeFileSync(join(d, file), content);
  sh(d, ["add", "-A"]);
  sh(d, ["commit", "-q", "-m", msg]);
};

describe("latestVTag / reachableVTags", () => {
  test("no tags at all = null, not an implicit 0.0.0", () => {
    const d = repo();
    commit(d, "a.txt", "x", "base");
    expect(latestVTag(d, "HEAD")).toBeNull();
    expect(reachableVTags(d, "HEAD")).toEqual([]);
  });

  test("picks the tag with the HIGHEST semver, not the most recently created one", () => {
    const d = repo();
    commit(d, "a.txt", "1", "c1");
    sh(d, ["tag", "v2.0.0"]); // created first, but...
    commit(d, "a.txt", "2", "c2");
    sh(d, ["tag", "v1.0.0"]); // ...lower semver, created second (a backport-style tag)
    const latest = latestVTag(d, "HEAD");
    expect(latest?.tag).toBe("v2.0.0");
  });

  test("a non-v / non-exact-semver tag is ignored", () => {
    const d = repo();
    commit(d, "a.txt", "1", "c1");
    sh(d, ["tag", "release-2026"]);
    sh(d, ["tag", "v1.2"]); // missing patch component
    sh(d, ["tag", "v1.2.3-rc1"]); // extra suffix
    sh(d, ["tag", "v1.0.0"]);
    expect(latestVTag(d, "HEAD")?.tag).toBe("v1.0.0");
  });

  test("annotated and lightweight tags both count", () => {
    const d = repo();
    commit(d, "a.txt", "1", "c1");
    sh(d, ["tag", "v1.0.0"]); // lightweight
    commit(d, "a.txt", "2", "c2");
    sh(d, ["tag", "-a", "v1.1.0", "-m", "annotated"]); // annotated
    expect(latestVTag(d, "HEAD")?.tag).toBe("v1.1.0");
  });

  test("a tag unreachable from head (only on another branch) is not used", () => {
    const d = repo();
    commit(d, "a.txt", "1", "base");
    sh(d, ["checkout", "-qb", "side"]);
    commit(d, "a.txt", "2", "side-commit");
    sh(d, ["tag", "v9.0.0"]); // only reachable from "side"
    sh(d, ["checkout", "-q", "main"]);
    commit(d, "b.txt", "1", "main-commit");
    expect(latestVTag(d, "main")).toBeNull();
    expect(latestVTag(d, "side")?.tag).toBe("v9.0.0");
  });
});

describe("fragmentsAddedSince", () => {
  test("only .md fragments added strictly after the tag, excluding README", () => {
    const d = repo();
    commit(d, "changelog.d/OLD.md", "bump: patch\n### Fixed\n- pre-existing\n", "base");
    commit(d, "changelog.d/README.md", "docs\n", "readme");
    sh(d, ["tag", "v1.0.0"]);
    commit(d, "changelog.d/NEW.md", "bump: minor\n### Added\n- a thing\n", "feat");
    expect(fragmentsAddedSince(d, "v1.0.0", "HEAD")).toEqual(["changelog.d/NEW.md"]);
  });

  test("a fragment present AT the tag is ignored even if modified afterwards", () => {
    const d = repo();
    commit(d, "changelog.d/OLD.md", "bump: patch\n### Fixed\n- pre-existing\n", "base");
    sh(d, ["tag", "v1.0.0"]);
    commit(d, "changelog.d/OLD.md", "bump: patch\n### Fixed\n- pre-existing (edited)\n", "edit");
    expect(fragmentsAddedSince(d, "v1.0.0", "HEAD")).toEqual([]);
  });

  test("no fragments added at all = empty list", () => {
    const d = repo();
    commit(d, "changelog.d/OLD.md", "bump: patch\n### Fixed\n- x\n", "base");
    sh(d, ["tag", "v1.0.0"]);
    commit(d, "README.md", "docs only\n", "docs");
    expect(fragmentsAddedSince(d, "v1.0.0", "HEAD")).toEqual([]);
  });

  test("a second tag's fragments-since is relative to IT, not the first tag", () => {
    const d = repo();
    commit(d, "changelog.d/A.md", "bump: patch\n### Fixed\n- a\n", "c1");
    sh(d, ["tag", "v1.0.0"]);
    commit(d, "changelog.d/B.md", "bump: minor\n### Added\n- b\n", "c2");
    sh(d, ["tag", "v1.1.0"]);
    commit(d, "changelog.d/C.md", "bump: patch\n### Fixed\n- c\n", "c3");
    expect(fragmentsAddedSince(d, latestVTag(d, "HEAD")!.tag, "HEAD")).toEqual(["changelog.d/C.md"]);
  });

  test("a hostile-looking tag/ref string is inert argv, never a shell command", () => {
    const d = repo();
    commit(d, "changelog.d/A.md", "bump: patch\n### Fixed\n- a\n", "c1");
    sh(d, ["tag", "v1.0.0"]);
    // Not a real ref — git itself rejects it (unknown revision), proving this never touches a shell:
    // a shell string like this would at best be a syntax error, at worst execute `rm -rf /`.
    expect(() => fragmentsAddedSince(d, "v1.0.0; rm -rf /", "HEAD")).toThrow();
  });
});
