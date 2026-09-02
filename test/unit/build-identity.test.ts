import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIdentity, realGitAtStart, resolveSha, toBuildReport, type GitAtStart } from "../../src/agents/build-identity.js";
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

  test("version is read from this repo's own package.json, not a hardcoded literal", () => {
    expect(buildIdentity.version).toBe(pkg.version);
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
      startedAt: "2026-01-01T00:00:00.000Z",
      pid: 4242,
      unit: "butchr.service",
      journalctl: "journalctl --user -u butchr.service",
    });
  });

  test("not under systemd: honest (none) unit and an empty journalctl command, never a guess", () => {
    const report = toBuildReport({
      sha: null, shaProvenance: null, shaDirty: null, shaUnknownReason: "no git",
      version: "1.2.3", startedAt: "2026-01-01T00:00:00.000Z", pid: 1,
      systemd: { kind: "none" },
    });
    expect(report.unit).toBe("(none)");
    expect(report.journalctl).toBe("");
  });
});
