import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeBuildCurrency,
  realCurrencyGit,
  renderBuildCurrencyLines,
  resolveCurrency,
  type CurrencyGit,
  type CurrencyVerdict,
  type GitOpResult,
  type RunningBuild,
} from "../../src/agents/build-currency.js";

/** A fully-successful fake CurrencyGit, overridable per test via spread. */
function fakeGit(overrides: Partial<CurrencyGit>): CurrencyGit {
  const base: CurrencyGit = {
    treeOf: () => ({ ok: true, tree: "tree-same" }),
    resolveRef: () => ({ ok: true, sha: "b".repeat(40) }),
    refUpdatedAt: () => ({ ok: true, iso: "2026-09-01T00:00:00.000Z" }),
    commitsBetween: () => ({ ok: true, count: 0 }),
  };
  return { ...base, ...overrides };
}

const CLEAN: RunningBuild = { sha: "a".repeat(40), shaDirty: false, shaUnknownReason: null };

describe("resolveCurrency — pure, given an injected CurrencyGit", () => {
  test("sha null: unknown, chaining shaUnknownReason — never a guess", () => {
    const v = resolveCurrency({ sha: null, shaDirty: null, shaUnknownReason: "no git" }, fakeGit({}));
    expect(v.status).toBe("unknown");
    if (v.status === "unknown") expect(v.reason).toContain("no git");
  });

  test("shaDirty true: unknown — a dirty sha does not describe what's running, so it can never be `current`", () => {
    const v = resolveCurrency({ sha: "a".repeat(40), shaDirty: true, shaUnknownReason: null }, fakeGit({}));
    expect(v.status).toBe("unknown");
  });

  test("no refs/remotes/origin/main resolvable: unknown with that reason (covers both 'no such ref' and 'no repo at all' — same failure shape, distinct message from real git)", () => {
    const v = resolveCurrency(CLEAN, fakeGit({ resolveRef: () => ({ ok: false, error: "fatal: no such ref" }) }));
    expect(v.status).toBe("unknown");
    if (v.status === "unknown") expect(v.reason).toContain("fatal: no such ref");
  });

  test("running sha has no readable tree (deployed from a different clone): unknown, not a crash", () => {
    const v = resolveCurrency(
      CLEAN,
      fakeGit({ treeOf: (ref) => (ref === CLEAN.sha ? { ok: false, error: "bad object" } : { ok: true, tree: "t" }) }),
    );
    expect(v.status).toBe("unknown");
    if (v.status === "unknown") expect(v.reason).toContain("bad object");
  });

  // THE SQUASH TRAP: running sha is NOT an ancestor of base (ancestry would
  // say "diverged" or fail outright), but the tree hash matches exactly —
  // this MUST be `current`. An ancestry-based implementation (`git merge-base
  // --is-ancestor` / rev-list) gets this wrong because a squash merge changes
  // history shape while landing identical content.
  test("squash case: trees identical, ancestry would say NO — must be current", () => {
    const v = resolveCurrency(
      CLEAN,
      fakeGit({
        treeOf: () => ({ ok: true, tree: "SAME-TREE" }),
        // if resolveCurrency ever calls commitsBetween on the current path, make it obviously non-ancestor
        commitsBetween: () => ({ ok: true, count: 999 }),
      }),
    );
    expect(v.status).toBe("current");
  });

  test("trees differ: never current, regardless of ancestry counts", () => {
    let calls = 0;
    const v = resolveCurrency(
      CLEAN,
      fakeGit({
        treeOf: () => {
          calls++;
          return { ok: true, tree: calls === 1 ? "running-tree" : "base-tree" };
        },
      }),
    );
    expect(v.status).toBe("stale");
  });

  // REQUIREMENT 2 (added after filing): THE trap this ticket's own first
  // draft fell into. Naive implementation this kills: `if (tree1 === tree2)
  // return current` with no freshness gate at all — a base ref nobody has
  // fetched in a week compares byte-equal to a running build a hundred
  // commits behind and confidently reports `current`. Trees matching is
  // necessary but NOT sufficient; the base's own freshness must also be
  // determinable, or the verdict must be `unknown`, never `current`.
  test("trees identical but base freshness is undeterminable: unknown, NOT current", () => {
    const v = resolveCurrency(
      CLEAN,
      fakeGit({
        treeOf: () => ({ ok: true, tree: "SAME-TREE" }),
        refUpdatedAt: () => ({ ok: false, error: "no reflog file or loose ref file found — likely packed, reflogs disabled" }),
      }),
    );
    expect(v.status).toBe("unknown");
    if (v.status === "unknown") {
      expect(v.reason).toContain("freshness");
      expect(v.reason).not.toContain("CURRENT");
    }
  });

  test("commitsAhead === 0: renders as behind, never diverged", () => {
    let n = 0;
    const v = resolveCurrency(
      CLEAN,
      fakeGit({
        treeOf: () => {
          n++;
          return { ok: true, tree: n === 1 ? "running" : "base" };
        },
        commitsBetween: (from) => (from === CLEAN.sha ? { ok: true, count: 3 } : { ok: true, count: 0 }),
      }),
    );
    expect(v.status).toBe("stale");
    if (v.status === "stale") {
      expect(v.commitsAhead).toBe(0);
      expect(v.commitsBehind).toBe(3);
    }
  });

  test("commitsAhead > 0: diverged — must carry both numbers, and the ticket's own trap: this must NOT collapse to a 'behind by N' rendering", () => {
    let n = 0;
    const v = resolveCurrency(
      CLEAN,
      fakeGit({
        treeOf: () => {
          n++;
          return { ok: true, tree: n === 1 ? "running" : "base" };
        },
        commitsBetween: (from) => (from === CLEAN.sha ? { ok: true, count: 2 } : { ok: true, count: 5 }),
      }),
    );
    expect(v.status).toBe("stale");
    if (v.status === "stale") {
      expect(v.commitsAhead).toBe(5);
      expect(v.commitsBehind).toBe(2);
      const lines = renderBuildCurrencyLines({ sha: CLEAN.sha, shaProvenance: "git-at-start", shaDirty: false, version: "1.0.0" }, v).join("\n");
      expect(lines).toContain("DIVERGED");
      expect(lines).not.toContain("- currency: STALE — behind"); // that exact prefix is reserved for the commitsAhead===0 case
    }
  });

  test("shaDirty null (undeterminable): can still be current/stale, but the qualifier must say so", () => {
    const v = resolveCurrency(
      { sha: "a".repeat(40), shaDirty: null, shaUnknownReason: null },
      fakeGit({}),
    );
    expect(v.status).toBe("current");
    if (v.status === "current") expect(v.dirtyUndeterminable).toBe(true);
  });

  test("git call that throws is still caught by the fake's contract (never lets an exception escape resolveCurrency itself)", () => {
    const g: CurrencyGit = fakeGit({
      refUpdatedAt: (): GitOpResult<{ iso: string }> => ({ ok: false, error: "no reflog" }),
    });
    expect(() => resolveCurrency(CLEAN, g)).not.toThrow();
  });
});

describe("renderBuildCurrencyLines — the un-collapsibility guarantee", () => {
  const build = { sha: "a".repeat(40), shaProvenance: "git-at-start" as const, shaDirty: false, version: "1.0.0" };
  const currentVerdict: CurrencyVerdict = {
    status: "current",
    base: { ref: "refs/remotes/origin/main", sha: "b".repeat(40), updatedAt: "2026-09-01T00:00:00.000Z", updatedAtUnknownReason: null },
    dirtyUndeterminable: false,
  };
  const unknownVerdict: CurrencyVerdict = { status: "unknown", reason: "no local refs/remotes/origin/main to compare against" };

  test("current rendering contains the literal token CURRENT", () => {
    expect(renderBuildCurrencyLines(build, currentVerdict).join("\n")).toContain("CURRENT");
  });

  // THE GUARD THIS TICKET IS HARSHEST ABOUT: pin that `unknown`'s rendering
  // can never be mistaken for `current`'s by a reader skimming for the word.
  // Naive implementation this kills: any renderer that falls through to a
  // shared "matches ref content-for-content" line regardless of status, or
  // that only distinguishes verdicts by a lowercase/prose word instead of a
  // dedicated, uncollapsed literal.
  test("unknown rendering NEVER contains the word CURRENT's rendering uses", () => {
    const unknownText = renderBuildCurrencyLines(build, unknownVerdict).join("\n");
    expect(unknownText).not.toContain("CURRENT");
    expect(unknownText).toContain("UNKNOWN");
  });

  test("stale-behind rendering: 'behind by N', not diverged", () => {
    const v: CurrencyVerdict = {
      status: "stale",
      commitsBehind: 4,
      commitsAhead: 0,
      base: { ref: "refs/remotes/origin/main", sha: "b".repeat(40), updatedAt: null, updatedAtUnknownReason: "no reflog" },
      dirtyUndeterminable: false,
    };
    const text = renderBuildCurrencyLines(build, v).join("\n");
    expect(text).toContain("STALE");
    expect(text).toContain("behind");
    expect(text).not.toContain("DIVERGED");
    expect(text).not.toContain("CURRENT");
  });
});

describe("realCurrencyGit — real git, real temp repo, no mocking", () => {
  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "butchr-build-currency-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(dir, "f.txt"), "one\n");
    git("add", "f.txt");
    git("commit", "-q", "-m", "first");
    return dir;
  }

  test("resolveRef/treeOf against a real HEAD: current when compared against itself", () => {
    const dir = initRepo();
    try {
      const g = realCurrencyGit(dir);
      const head = g.resolveRef("HEAD");
      expect(head.ok).toBe(true);
      if (!head.ok) return;
      const t1 = g.treeOf(head.sha);
      const t2 = g.treeOf("HEAD");
      expect(t1.ok && t2.ok).toBe(true);
      if (t1.ok && t2.ok) expect(t1.tree).toBe(t2.tree);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no such ref: an honest error, never a guessed sha", () => {
    const dir = initRepo();
    try {
      const g = realCurrencyGit(dir);
      const r = g.resolveRef("refs/remotes/origin/main");
      expect(r.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no git repository at all: every op fails honestly, nothing throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-build-currency-no-git-"));
    try {
      const g = realCurrencyGit(dir);
      expect(g.resolveRef("refs/remotes/origin/main").ok).toBe(false);
      expect(g.treeOf("HEAD").ok).toBe(false);
      expect(g.commitsBetween("a", "b").ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refUpdatedAt: real reflog file, a real ISO timestamp — not a guess", () => {
    const dir = initRepo();
    try {
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: dir });
      const r = realCurrencyGit(dir).refUpdatedAt("refs/remotes/origin/main");
      expect(r.ok).toBe(true);
      if (r.ok) expect(new Date(r.iso).toISOString()).toBe(r.iso);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("commitsBetween: real ancestry count over two real commits", () => {
    const dir = initRepo();
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      const first = git("rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "f.txt"), "one\ntwo\n");
      git("add", "f.txt");
      git("commit", "-q", "-m", "second");
      const second = git("rev-parse", "HEAD").trim();
      const r = realCurrencyGit(dir).commitsBetween(first, second);
      expect(r).toEqual({ ok: true, count: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // End-to-end through resolveCurrency itself, real git throughout — not a
  // fixture round-trip. This is the "at least one real run" the ticket asks
  // for at the resolveCurrency layer (the operator script,
  // scripts/verify-workspace-ground-truth.ts, is the real run at the
  // rendered-ENVIRONMENT.md layer).
  test("end-to-end, real repo: origin/main pointing at HEAD -> current", () => {
    const dir = initRepo();
    try {
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: dir });
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      const v = resolveCurrency({ sha: head, shaDirty: false, shaUnknownReason: null }, realCurrencyGit(dir));
      expect(v.status).toBe("current");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("end-to-end, real repo: origin/main one commit ahead -> stale, behind by 1", () => {
    const dir = initRepo();
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      const first = git("rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "f.txt"), "one\ntwo\n");
      git("add", "f.txt");
      git("commit", "-q", "-m", "second");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      const v = resolveCurrency({ sha: first, shaDirty: false, shaUnknownReason: null }, realCurrencyGit(dir));
      expect(v.status).toBe("stale");
      if (v.status === "stale") {
        expect(v.commitsAhead).toBe(0);
        expect(v.commitsBehind).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("computeBuildCurrency — the real wrapper buildWorkspace calls", () => {
  test("never throws, even against this test process's own directory (whatever git state that happens to be)", () => {
    expect(() => computeBuildCurrency(CLEAN)).not.toThrow();
  });

  test("sha null in, unknown out, no git ever consulted", () => {
    const v = computeBuildCurrency({ sha: null, shaDirty: null, shaUnknownReason: "npm install, no .git" });
    expect(v.status).toBe("unknown");
    if (v.status === "unknown") expect(v.reason).toContain("npm install, no .git");
  });
});

// NEVER-THROWS MUST NOT BECOME NEVER-SAYS (added after filing): a failure to
// compute has to RENDER — as `unknown`, with its reason, in the text an
// agent actually reads. Naive implementation this kills: `groundTruthText`
// (or some caller) catching a currency failure and simply omitting the
// section — which reads, to a skimming agent, exactly like everything being
// fine (the same "confident zero" failure mode this epic exists to stop).
describe("every git call fails: the currency section still RENDERS, never vanishes", () => {
  const ALWAYS_FAILS: CurrencyGit = {
    treeOf: () => ({ ok: false, error: "git not on PATH" }),
    resolveRef: () => ({ ok: false, error: "git not on PATH" }),
    refUpdatedAt: () => ({ ok: false, error: "git not on PATH" }),
    commitsBetween: () => ({ ok: false, error: "git not on PATH" }),
  };

  test("resolveCurrency over an all-failing git: unknown, with the real reason, not a thrown exception", () => {
    const v = resolveCurrency(CLEAN, ALWAYS_FAILS);
    expect(v.status).toBe("unknown");
    if (v.status === "unknown") expect(v.reason).toContain("git not on PATH");
  });

  test("the RENDERED block still contains a currency line naming UNKNOWN and the reason — never silently omitted", () => {
    const v = resolveCurrency(CLEAN, ALWAYS_FAILS);
    const rendered = renderBuildCurrencyLines({ sha: CLEAN.sha, shaProvenance: "git-at-start", shaDirty: false, version: "1.0.0" }, v).join("\n");
    expect(rendered).toContain("- currency: UNKNOWN");
    expect(rendered).toContain("git not on PATH");
  });
});
