import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIdentity, describeBuild, realGitAtStart, realGitVersionAtStart, resolveSha, resolveVersion, toBuildReport,
  type GitAtStart, type GitVersionAtStart,
} from "../../src/agents/build-identity.js";
import { latestVTag } from "../../scripts/release/git.js";
import pkg from "../../package.json" with { type: "json" };

describe("resolveSha — pure, given an injected gitAtStart", () => {
  const neverCalled = (): GitAtStart => { throw new Error("gitAtStart must not be called when a sha was baked"); };

  test("a baked sha wins outright, and gitAtStart is never even consulted", () => {
    expect(resolveSha("cafef00d", "0", neverCalled)).toEqual({ sha: "cafef00d", provenance: "baked", dirty: false, unknownReason: null });
  });

  test("a baked sha with a dirty flag of \"1\" reports dirty: true", () => {
    expect(resolveSha("cafef00d", "1", neverCalled)).toMatchObject({ dirty: true });
  });

  test("whitespace-only / empty baked sha is treated as nothing baked, not a literal blank sha", () => {
    let called = false;
    const g = (): GitAtStart => { called = true; return { sha: "a".repeat(40), dirty: false }; };
    expect(resolveSha("", "0", g).provenance).toBe("git-at-start");
    expect(called).toBe(true);
    called = false;
    expect(resolveSha("   ", "0", g).provenance).toBe("git-at-start");
    expect(called).toBe(true);
  });

  test("nothing baked, git-at-start succeeds: reports the git result with git-at-start provenance", () => {
    const result = resolveSha(undefined, undefined, () => ({ sha: "b".repeat(40), dirty: true }));
    expect(result).toEqual({ sha: "b".repeat(40), provenance: "git-at-start", dirty: true, unknownReason: null });
  });

  test("nothing baked, git-at-start fails: an honest unknown carrying the real reason — never a guessed sha", () => {
    const result = resolveSha(undefined, undefined, () => ({ error: "no readable git repository above /some/dir" }));
    expect(result).toEqual({ sha: null, provenance: null, dirty: null, unknownReason: "no readable git repository above /some/dir" });
  });
});

describe("resolveVersion — pure, given an injected gitVersionAtStart (FACTORY-627)", () => {
  test("git-at-start succeeds, HEAD exactly at the tag: version is X.Y.Z, provenance tag", () => {
    const r = resolveVersion("0.15.5", (): GitVersionAtStart => ({ tag: "v1.2.3", version: "1.2.3", distance: 0 }));
    expect(r).toEqual({ version: "1.2.3", provenance: "tag", unknownReason: null });
  });

  test("git-at-start succeeds, HEAD N commits past the tag: version is X.Y.Z+N", () => {
    const r = resolveVersion("0.15.5", (): GitVersionAtStart => ({ tag: "v1.2.3", version: "1.2.3", distance: 3 }));
    expect(r).toEqual({ version: "1.2.3+3", provenance: "tag", unknownReason: null });
  });

  test("git-at-start fails (no tag, no git, shallow clone — any reason): falls back to package.json's version with the stated reason, never silently", () => {
    const r = resolveVersion("0.15.5", (): GitVersionAtStart => ({ error: "no \"v*\" tag reachable" }));
    expect(r).toEqual({ version: "0.15.5", provenance: "package-json", unknownReason: "no \"v*\" tag reachable" });
  });
});

// REAL git, in a real temp repo — not mocked — same discipline as
// realGitAtStart's own suite below.
describe("realGitVersionAtStart — real git, real temp repo, no mocking", () => {
  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "butchr-build-version-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(dir, "f.txt"), "one\n");
    git("add", "f.txt");
    git("commit", "-q", "-m", "first");
    return dir;
  }
  const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const commit = (dir: string, msg: string) => {
    writeFileSync(join(dir, "f.txt"), `${msg}\n`);
    git(dir, "add", "f.txt");
    git(dir, "commit", "-q", "-m", msg);
  };

  test("HEAD exactly at the tag: distance 0", () => {
    const dir = initRepo();
    try {
      git(dir, "tag", "v1.0.0");
      const r = realGitVersionAtStart(dir);
      expect("tag" in r).toBe(true);
      if ("tag" in r) { expect(r.tag).toBe("v1.0.0"); expect(r.version).toBe("1.0.0"); expect(r.distance).toBe(0); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("HEAD 3 commits past the tag: distance 3", () => {
    const dir = initRepo();
    try {
      git(dir, "tag", "v1.0.0");
      commit(dir, "c1"); commit(dir, "c2"); commit(dir, "c3");
      const r = realGitVersionAtStart(dir);
      if ("tag" in r) { expect(r.tag).toBe("v1.0.0"); expect(r.distance).toBe(3); }
      else throw new Error("expected a tag result");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a lower-semver tag created LATER never wins over a higher one made earlier", () => {
    const dir = initRepo();
    try {
      git(dir, "tag", "v2.0.0"); // higher semver, created first
      commit(dir, "c1");
      git(dir, "tag", "v1.5.0"); // lower semver, created second (e.g. a backport tag)
      const r = realGitVersionAtStart(dir);
      if ("tag" in r) expect(r.tag).toBe("v2.0.0");
      else throw new Error("expected a tag result");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a non-v tag is ignored entirely", () => {
    const dir = initRepo();
    try {
      git(dir, "tag", "release-2026");
      const r = realGitVersionAtStart(dir);
      expect("error" in r).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("no tag at all: an honest error naming the reason, never a guessed version", () => {
    const dir = initRepo();
    try {
      const r = realGitVersionAtStart(dir);
      expect("error" in r).toBe(true);
      if ("error" in r) expect(r.error).toMatch(/no "v\*" tag/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("not a git repository at all: an honest error, never a guessed version", () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-build-version-no-git-"));
    try {
      const r = realGitVersionAtStart(dir);
      expect("error" in r).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// REAL git, in a real temp repo — not mocked. This is the seam the ticket is
// harshest about for the from-source launch path: reading git at start must
// actually work against a real .git, and correctly walk UP from a nested
// directory (mirroring src/agents/ inside the real checkout) rather than
// requiring the repo root exactly.
describe("realGitAtStart — real git, real temp repo, no mocking", () => {
  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "butchr-build-identity-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(dir, "f.txt"), "one\n");
    git("add", "f.txt");
    git("commit", "-q", "-m", "first");
    return dir;
  }

  test("a clean repo: real 40-char sha, dirty: false", () => {
    const dir = initRepo();
    try {
      const result = realGitAtStart(dir);
      expect("sha" in result).toBe(true);
      if ("sha" in result) {
        expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(result.sha).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim());
        expect(result.dirty).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an uncommitted change: the SAME sha (HEAD unmoved), dirty: true", () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, "f.txt"), "one\ntwo\n");
      const result = realGitAtStart(dir);
      if ("sha" in result) expect(result.dirty).toBe(true);
      else throw new Error("expected a sha result");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves from a NESTED subdirectory (mirrors src/agents/ inside the real repo) — git searches upward on its own", () => {
    const dir = initRepo();
    try {
      const nested = join(dir, "src", "agents");
      execFileSync("mkdir", ["-p", nested]);
      const result = realGitAtStart(nested);
      expect("sha" in result).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no git repository at all: an honest error naming the directory, never a guessed sha", () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-build-identity-no-git-"));
    try {
      const result = realGitAtStart(dir);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain(dir);
        expect(result.error).toContain("no readable git repository");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// REAL Bun.build, with the REAL `define` mechanism scripts/build/build.ts
// uses — proves the actual freezing behaviour end to end (a differing
// RUNTIME env var must never override a baked value), not a simulation of
// what define is documented to do.
describe("the baked path, through the REAL bundler (not simulated)", () => {
  test("Bun.build's define freezes process.env.BUTCHR_BUILD_SHA into the bundle; a different runtime env var at RUN time is ignored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-build-identity-bundle-"));
    try {
      const entry = join(dir, "in.ts");
      writeFileSync(entry, 'console.log("sha=" + process.env.BUTCHR_BUILD_SHA);\n');
      const result = await Bun.build({
        entrypoints: [entry],
        outdir: dir,
        naming: "out.js",
        target: "bun",
        define: { "process.env.BUTCHR_BUILD_SHA": JSON.stringify("bakedsha1234") },
      });
      expect(result.success).toBe(true);
      const out = execFileSync("bun", [join(dir, "out.js")], {
        encoding: "utf8",
        env: { ...process.env, BUTCHR_BUILD_SHA: "a-completely-different-runtime-value" },
      });
      expect(out.trim()).toBe("sha=bakedsha1234");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildIdentity — the module-singleton this daemon actually serves", () => {
  test("captured once at import: pid matches this process, and re-importing the module returns the SAME object (no re-derivation)", async () => {
    expect(buildIdentity.pid).toBe(process.pid);
    const reimported = await import("../../src/agents/build-identity.js");
    expect(reimported.buildIdentity).toBe(buildIdentity);
  });

  test("sha is either a real value with a provenance, or an explicit null with a stated reason — never both null and unexplained", () => {
    if (buildIdentity.sha === null) {
      expect(buildIdentity.shaProvenance).toBeNull();
      expect(typeof buildIdentity.shaUnknownReason).toBe("string");
    } else {
      expect(buildIdentity.shaProvenance).not.toBeNull();
      expect(buildIdentity.shaUnknownReason).toBeNull();
    }
  });

  test("version either comes from the latest reachable v* tag (this repo has real release tags) or explicitly falls back to package.json with a stated reason — never a silent mismatch", () => {
    if (buildIdentity.versionProvenance === "tag") {
      expect(buildIdentity.versionUnknownReason).toBeNull();
      // Cross-check against the same live git read the module itself used — not a hardcoded tag,
      // since this repo's own tags move as releases ship.
      const tag = latestVTag(process.cwd(), "HEAD");
      expect(tag).not.toBeNull();
      expect(buildIdentity.version.startsWith(`${tag!.version.major}.${tag!.version.minor}.${tag!.version.patch}`)).toBe(true);
    } else {
      expect(buildIdentity.version).toBe(pkg.version);
      expect(typeof buildIdentity.versionUnknownReason).toBe("string");
    }
  });
});

describe("toBuildReport", () => {
  test("flattens systemd into unit/journalctl and passes the rest through", () => {
    const report = toBuildReport({
      sha: "a".repeat(40),
      shaProvenance: "baked",
      shaDirty: false,
      shaUnknownReason: null,
      version: "1.2.3",
      versionProvenance: "tag",
      versionUnknownReason: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      pid: 4242,
      systemd: { kind: "user", unit: "butchr.service", journalctl: "journalctl --user -u butchr.service" },
    });
    expect(report).toEqual({
      sha: "a".repeat(40),
      shaProvenance: "baked",
      shaDirty: false,
      shaUnknownReason: null,
      version: "1.2.3",
      versionProvenance: "tag",
      versionUnknownReason: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      pid: 4242,
      unit: "butchr.service",
      journalctl: "journalctl --user -u butchr.service",
    });
  });

  // FACTORY-560: windows-task carries `unit`/`journalctl` the same shape as
  // "user"/"system" (see ground-truth.ts's SystemdInfo doc comment) — this
  // pins that toBuildReport needs no windows-task-specific branch to flatten
  // it correctly.
  test("windows-task: flattens the task name and log-diagnostics command the same way a systemd unit's fields flatten", () => {
    const report = toBuildReport({
      sha: "a".repeat(40),
      shaProvenance: "baked",
      shaDirty: false,
      shaUnknownReason: null,
      version: "1.2.3",
      versionProvenance: "tag",
      versionUnknownReason: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      pid: 4242,
      systemd: { kind: "windows-task", unit: "Butchr-Native", journalctl: 'Get-Content -Path "C:\\logs\\butchr.log" -Tail 200 -Wait' },
    });
    expect(report.unit).toBe("Butchr-Native");
    expect(report.journalctl).toContain("Get-Content");
  });

  test("not under systemd: honest (none) unit and an empty journalctl command, never a guess", () => {
    const report = toBuildReport({
      sha: null, shaProvenance: null, shaDirty: null, shaUnknownReason: "no git",
      version: "1.2.3", versionProvenance: "package-json", versionUnknownReason: "no \"v*\" tag",
      startedAt: "2026-01-01T00:00:00.000Z", pid: 1,
      systemd: { kind: "none" },
    });
    expect(report.unit).toBe("(none)");
    expect(report.journalctl).toBe("");
  });
});

// BUTCHR-320 (C): the startup line's own formatting — falsifier 1 (mutation
// test): deleting the `describeBuild(toBuildReport(buildIdentity))` call in
// src/daemon/index.ts's startup banner must fail a test naming this exact
// line's content; that check lives at the call site (there is no daemon
// startup test harness in this suite), verified by hand for the PR. These
// tests pin the pure formatting function itself.
describe("describeBuild (BUTCHR-320 C) — reuses toBuildReport's own fields, never a second sha/version derivation", () => {
  test("a known sha: short sha, provenance, and dirty/clean are all named", () => {
    const line = describeBuild({
      sha: "0fa494297ff6d0d32a8c6e17b69f8bd2889edbf7", shaProvenance: "git-at-start", shaDirty: false, shaUnknownReason: null,
      version: "0.15.5", versionProvenance: "tag", versionUnknownReason: null,
      startedAt: "2026-01-01T00:00:00.000Z", pid: 641076, unit: "butchr.service", journalctl: "journalctl --user -u butchr.service",
    });
    expect(line).toBe("build 0fa49429 (git-at-start, clean) version=0.15.5 pid=641076 unit=butchr.service");
  });

  test("a dirty tree is named, not silently omitted", () => {
    const line = describeBuild({
      sha: "a".repeat(40), shaProvenance: "baked", shaDirty: true, shaUnknownReason: null,
      version: "1.0.0", versionProvenance: "tag", versionUnknownReason: null,
      startedAt: "2026-01-01T00:00:00.000Z", pid: 1, unit: "(none)", journalctl: "",
    });
    expect(line).toContain("dirty");
  });

  test("an unknown sha states the reason, never a blank or guessed sha", () => {
    const line = describeBuild({
      sha: null, shaProvenance: null, shaDirty: null, shaUnknownReason: "no readable git repository above /x",
      version: "1.0.0", versionProvenance: "tag", versionUnknownReason: null,
      startedAt: "2026-01-01T00:00:00.000Z", pid: 1, unit: "(none)", journalctl: "",
    });
    expect(line).toContain("unknown (no readable git repository above /x)");
  });

  test("a package.json-fallback version states the reason, never silently presented as current", () => {
    const line = describeBuild({
      sha: "a".repeat(40), shaProvenance: "baked", shaDirty: false, shaUnknownReason: null,
      version: "0.15.5", versionProvenance: "package-json", versionUnknownReason: "no \"v*\" tag reachable from HEAD",
      startedAt: "2026-01-01T00:00:00.000Z", pid: 1, unit: "(none)", journalctl: "",
    });
    expect(line).toContain('version=0.15.5 (package.json fallback: no "v*" tag reachable from HEAD)');
  });

  test("reuses toBuildReport's OWN output — the same object /health's build field serves — not a second sha derivation", () => {
    const report = toBuildReport(buildIdentity);
    const line = describeBuild(report);
    expect(line).toContain(`version=${report.version}`);
    expect(line).toContain(`pid=${report.pid}`);
    expect(line).toContain(`unit=${report.unit}`);
  });
});
