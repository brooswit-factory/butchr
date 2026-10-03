import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeTagRelease } from "../../scripts/release/compute-tag-release.js";

/** End-to-end: a real throwaway git repo (init, commits, annotated and lightweight tags, fragments before/after the tag) — never the real checkout. */
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "tag-release-"));
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

describe("computeTagRelease", () => {
  test("no v* tag at all: refuses with a clear message rather than guessing 0.0.0", () => {
    const d = repo();
    commit(d, "changelog.d/A.md", "bump: patch\n### Fixed\n- a\n", "c1");
    expect(() => computeTagRelease(d, "HEAD")).toThrow(/no "v\*" tag/);
  });

  test("no fragments since the tag: release is null, baseTag is reported", () => {
    const d = repo();
    commit(d, "changelog.d/OLD.md", "bump: patch\n### Fixed\n- pre-existing\n", "base");
    sh(d, ["tag", "v1.0.0"]); // lightweight
    commit(d, "README.md", "docs only\n", "docs");
    const r = computeTagRelease(d, "HEAD");
    expect(r.baseTag).toBe("v1.0.0");
    expect(r.release).toBeNull();
  });

  test("fragments present AT the tag are ignored by construction — the ~200 pre-existing fragments never count", () => {
    const d = repo();
    for (let i = 0; i < 5; i++) commit(d, `changelog.d/OLD${i}.md`, "bump: major\n### BREAKING\n- old\n", `old ${i}`);
    sh(d, ["tag", "-a", "v1.0.0", "-m", "v1.0.0"]); // annotated, at a commit with 5 pre-existing fragments
    commit(d, "changelog.d/NEW.md", "bump: patch\n### Fixed\n- a real fix\n", "feat");
    const r = computeTagRelease(d, "HEAD");
    expect(r.baseTag).toBe("v1.0.0");
    expect(r.release!.version).toBe("1.0.1"); // patch only — the 5 old major/BREAKING fragments never counted
    expect(r.release!.consumed).toEqual(["changelog.d/NEW.md"]);
  });

  test("patch-only fragment since the tag", () => {
    const d = repo();
    commit(d, "a.txt", "x", "base");
    sh(d, ["tag", "v2.3.4"]);
    commit(d, "changelog.d/A.md", "bump: patch\n### Fixed\n- fix\n", "feat");
    expect(computeTagRelease(d, "HEAD").release!.version).toBe("2.3.5");
  });

  test("minor beats patch among fragments since the tag", () => {
    const d = repo();
    commit(d, "a.txt", "x", "base");
    sh(d, ["tag", "v2.3.4"]);
    commit(d, "changelog.d/A.md", "bump: patch\n### Fixed\n- fix\n", "f1");
    commit(d, "changelog.d/B.md", "bump: minor\n### Added\n- feat\n", "f2");
    expect(computeTagRelease(d, "HEAD").release!.version).toBe("2.4.0");
  });

  test("major beats minor among fragments since the tag", () => {
    const d = repo();
    commit(d, "a.txt", "x", "base");
    sh(d, ["tag", "v2.3.4"]);
    commit(d, "changelog.d/A.md", "bump: minor\n### Added\n- feat\n", "f1");
    commit(d, "changelog.d/B.md", "bump: major\n### BREAKING\n- break\n", "f2");
    expect(computeTagRelease(d, "HEAD").release!.version).toBe("3.0.0");
  });

  test("a tag made LATER for an earlier version (backport) never wins over a higher semver tag", () => {
    const d = repo();
    commit(d, "a.txt", "1", "c1");
    sh(d, ["tag", "v2.0.0"]); // higher semver, created first
    commit(d, "a.txt", "2", "c2");
    sh(d, ["tag", "v1.5.0"]); // lower semver, created second (e.g. a backport tag on an older line)
    commit(d, "changelog.d/A.md", "bump: patch\n### Fixed\n- fix\n", "feat");
    expect(computeTagRelease(d, "HEAD").baseTag).toBe("v2.0.0");
  });

  test("a non-v tag is ignored entirely", () => {
    const d = repo();
    commit(d, "a.txt", "x", "base");
    sh(d, ["tag", "release-2026"]);
    sh(d, ["tag", "v1.0.0"]);
    commit(d, "changelog.d/A.md", "bump: patch\n### Fixed\n- fix\n", "feat");
    expect(computeTagRelease(d, "HEAD").baseTag).toBe("v1.0.0");
  });

  test("a hostile-looking argument never reaches a shell — it fails as an invalid git revision, nothing worse", () => {
    const d = repo();
    commit(d, "changelog.d/A.md", "bump: patch\n### Fixed\n- a\n", "c1");
    sh(d, ["tag", "v1.0.0"]);
    expect(() => computeTagRelease(d, "HEAD; touch /tmp/release-git-pwned-marker")).toThrow();
    expect(existsSync("/tmp/release-git-pwned-marker")).toBe(false);
  });
});
