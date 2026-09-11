import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeBuildCurrency,
  fetchHeadRecordsBaseSha,
  normaliseRemoteUrl,
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
    refChangedAt: () => ({ ok: true, iso: "2026-09-01T00:00:00.000Z" }),
    lastFetchedAt: () => ({ ok: true, iso: "2026-09-01T00:05:00.000Z" }),
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
  // necessary but NOT sufficient; the base's own change-time must also be
  // determinable, or the verdict must be `unknown`, never `current`.
  test("trees identical but the base ref's own change-time is undeterminable: unknown, NOT current", () => {
    const v = resolveCurrency(
      CLEAN,
      fakeGit({
        treeOf: () => ({ ok: true, tree: "SAME-TREE" }),
        refChangedAt: () => ({ ok: false, error: "no reflog file or loose ref file found — likely packed, reflogs disabled" }),
      }),
    );
    expect(v.status).toBe("unknown");
    if (v.status === "unknown") {
      expect(v.reason).toContain("change-time");
      expect(v.reason).not.toContain("CURRENT");
    }
  });

  // REVIEW FINDING (added after Requirement 2 first shipped): change-time
  // alone can't distinguish "fetched five minutes ago, unchanged" from
  // "never fetched, unchanged" — a fetch that changes nothing never touches
  // the reflog. Naive implementation this kills: gating `current` on
  // `refChangedAt` alone (the ORIGINAL Requirement 2 fix) and ignoring
  // fetch-recency entirely — trees identical, change-time known, but this
  // checkout's own last-fetch time is undeterminable must ALSO be `unknown`,
  // not `current`.
  test("trees identical, change-time known, but this checkout's own last-fetch time is undeterminable: unknown, NOT current", () => {
    const v = resolveCurrency(
      CLEAN,
      fakeGit({
        treeOf: () => ({ ok: true, tree: "SAME-TREE" }),
        lastFetchedAt: () => ({ ok: false, error: "no FETCH_HEAD — this checkout has apparently never fetched from a remote" }),
      }),
    );
    expect(v.status).toBe("unknown");
    if (v.status === "unknown") {
      expect(v.reason).toContain("last-fetch");
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
      refChangedAt: (): GitOpResult<{ iso: string }> => ({ ok: false, error: "no reflog" }),
    });
    expect(() => resolveCurrency(CLEAN, g)).not.toThrow();
  });
});

describe("renderBuildCurrencyLines — the un-collapsibility guarantee", () => {
  const build = { sha: "a".repeat(40), shaProvenance: "git-at-start" as const, shaDirty: false, version: "1.0.0" };
  const currentVerdict: CurrencyVerdict = {
    status: "current",
    base: {
      ref: "refs/remotes/origin/main",
      sha: "b".repeat(40),
      changedAt: "2026-09-01T00:00:00.000Z",
      changedAtUnknownReason: null,
      fetchedAt: "2026-09-01T00:05:00.000Z",
      fetchedAtUnknownReason: null,
    },
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
      base: {
        ref: "refs/remotes/origin/main",
        sha: "b".repeat(40),
        changedAt: null,
        changedAtUnknownReason: "no reflog",
        fetchedAt: "2026-09-01T00:05:00.000Z",
        fetchedAtUnknownReason: null,
      },
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
      expect(g.refChangedAt("refs/remotes/origin/main").ok).toBe(false);
      expect(g.lastFetchedAt("origin", "main", "a".repeat(40)).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refChangedAt: real reflog file, a real ISO timestamp — not a guess", () => {
    const dir = initRepo();
    try {
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: dir });
      const r = realCurrencyGit(dir).refChangedAt("refs/remotes/origin/main");
      expect(r.ok).toBe(true);
      if (r.ok) expect(new Date(r.iso).toISOString()).toBe(r.iso);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lastFetchedAt: a checkout that has never fetched — honest failure, never a guess", () => {
    const dir = initRepo();
    try {
      // BUTCHR-163: an origin must exist for this test to exercise what it
      // claims. Without one the failure is "no remote.origin.url", which is a
      // DIFFERENT honest failure — so the fixture would no longer be testing
      // "never fetched" at all.
      execFileSync("git", ["remote", "add", "origin", "https://example.invalid/o/r.git"], { cwd: dir });
      const r = realCurrencyGit(dir).lastFetchedAt("origin", "main", "a".repeat(40));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("never fetched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lastFetchedAt: no origin remote at all is its own honest failure, distinct from never-fetched", () => {
    const dir = initRepo();
    try {
      const r = realCurrencyGit(dir).lastFetchedAt("origin", "main", "a".repeat(40));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("remote.origin.url");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // REAL `git fetch`, against a REAL second repo acting as the remote — not
  // simulated. Proves FETCH_HEAD's mtime actually moves on a real fetch, and
  // that `lastFetchedAt` reads it correctly.
  //
  // MEASURED, NOT ASSUMED: this test originally asserted `git clone` itself
  // writes FETCH_HEAD. It doesn't — verified live: a fresh `git clone` in
  // this environment leaves no FETCH_HEAD at all; only an actual `git fetch`
  // (clone does not run one internally here) creates it. Good thing to have
  // gotten wrong in a test rather than asserted in prose: it means a
  // freshly-cloned-but-never-fetched-since checkout correctly renders
  // `unknown` rather than a false `current` — exactly Requirement 2's intent.
  test("lastFetchedAt: absent right after clone, present after a real `git fetch`", () => {
    const remote = mkdtempSync(join(tmpdir(), "butchr-build-currency-remote-"));
    const clone = mkdtempSync(join(tmpdir(), "butchr-build-currency-clone-"));
    try {
      const gitIn = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      gitIn(remote, "init", "-q", "-b", "main");
      gitIn(remote, "config", "user.email", "test@example.com");
      gitIn(remote, "config", "user.name", "test");
      writeFileSync(join(remote, "f.txt"), "one\n");
      gitIn(remote, "add", "f.txt");
      gitIn(remote, "commit", "-q", "-m", "first");

      gitIn(tmpdir(), "clone", "-q", remote, clone);
      const before = realCurrencyGit(clone).lastFetchedAt("origin", "main", baseShaOf(clone));
      expect(before.ok).toBe(false);

      gitIn(clone, "fetch", "-q", "origin"); // a real, even no-op, fetch
      const after = realCurrencyGit(clone).lastFetchedAt("origin", "main", baseShaOf(clone));
      expect(after.ok).toBe(true);
    } finally {
      rmSync(remote, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
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
  test("end-to-end, real repo: origin/main pointing at HEAD, and this checkout has fetched -> current", () => {
    const dir = initRepo();
    try {
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: dir });
      // A real fetch marker — see the `lastFetchedAt` tests above for why a
      // ref pointed at HEAD by hand isn't enough on its own any more: this
      // repo needs to look like it has ALSO actually fetched.
      //
      // BUTCHR-163: an EMPTY FETCH_HEAD used to be enough here, because the
      // old implementation read only the file's mtime and never its content.
      // It now has to be a real record naming origin's URL and the base
      // branch — which is what an actual fetch would have written. Note the
      // configured URL carries `.git` and the record does NOT, exactly as
      // measured on this repo: this fixture therefore also pins the
      // normalisation, and would fail against a naive string equality.
      execFileSync("git", ["remote", "add", "origin", "https://example.invalid/o/r.git"], { cwd: dir });
      const head0 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      writeFileSync(join(dir, ".git", "FETCH_HEAD"), `${head0}\t\tbranch 'main' of https://example.invalid/o/r\n`);
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      const v = resolveCurrency({ sha: head, shaDirty: false, shaUnknownReason: null }, realCurrencyGit(dir));
      expect(v.status).toBe("current");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Real-git counterpart to the fake-git "last-fetch time is undeterminable"
  // unit test above: a repo whose base ref was set by hand (`update-ref`,
  // never a real fetch) has no FETCH_HEAD at all — must be `unknown`, not a
  // false `current`, even though the trees genuinely match.
  test("end-to-end, real repo: origin/main pointing at HEAD, but this checkout has NEVER fetched -> unknown, not current", () => {
    const dir = initRepo();
    try {
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: dir });
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      const v = resolveCurrency({ sha: head, shaDirty: false, shaUnknownReason: null }, realCurrencyGit(dir));
      expect(v.status).toBe("unknown");
      if (v.status === "unknown") expect(v.reason).toContain("last-fetch");
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
    refChangedAt: () => ({ ok: false, error: "git not on PATH" }),
    lastFetchedAt: () => ({ ok: false, error: "git not on PATH" }),
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

// ---------------------------------------------------------------------------
// BUTCHR-163: the two fetch-recency defects, and the decision that the base's
// age must be inseparable from the verdict line.
//
// EVERY test below was verified to FAIL against the pre-fix code (the bare
// `statSync(<common-dir>/FETCH_HEAD).mtime` implementation and the trailing-
// sentence-only rendering). A test that passes on the old code proves nothing
// here, which is why each fixture's STARTING state differs from the state
// under test — the same mistake that produced the original wrong comment
// (measuring in a main checkout, where the distinction under test cannot
// appear) must not be rebuilt in a fixture.
// ---------------------------------------------------------------------------

/**
 * What `refs/remotes/origin/main` currently holds in `dir` — the sha
 * `lastFetchedAt` now requires a FETCH_HEAD record to name. Reading it from
 * the repo rather than hard-coding it is deliberate: a hard-coded sha would
 * make these fixtures pass for the wrong reason.
 */
function baseShaOf(dir: string): string {
  return execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: dir, encoding: "utf8" }).trim();
}

describe("BUTCHR-163 — normaliseRemoteUrl", () => {
  // MEASURED on this repo: remote.origin.url carries `.git`, and 0 of 273
  // FETCH_HEAD lines do. Exact equality therefore matches NOTHING, degrading
  // every verdict to a principled-looking `unknown` that is indistinguishable
  // from an honest one. This is the single most important test in this file.
  test("the .git suffix git strips when recording a fetch source is normalised away", () => {
    expect(normaliseRemoteUrl("https://github.com/o/r.git")).toBe(normaliseRemoteUrl("https://github.com/o/r"));
  });

  test("a trailing slash is normalised away too", () => {
    expect(normaliseRemoteUrl("https://github.com/o/r/")).toBe("https://github.com/o/r");
  });

  test("genuinely different remotes still differ — normalisation must not collapse them", () => {
    expect(normaliseRemoteUrl("https://github.com/o/r.git")).not.toBe(normaliseRemoteUrl("https://github.com/o/OTHER.git"));
  });
});

describe("BUTCHR-163 — fetchHeadRecordsBaseSha parses the real FETCH_HEAD shapes", () => {
  const URL_NO_SUFFIX = "https://github.com/o/r";
  // Both shapes are present in this repo's own FETCH_HEAD: the for-merge line
  // has an EMPTY middle field, the rest carry `not-for-merge`.
  const FOR_MERGE = `${"a".repeat(40)}\t\tbranch 'main' of ${URL_NO_SUFFIX}`;
  const NOT_FOR_MERGE = `${"b".repeat(40)}\tnot-for-merge\tbranch 'main' of ${URL_NO_SUFFIX}`;

  test("matches the for-merge line, whose middle tab-separated field is EMPTY", () => {
    expect(fetchHeadRecordsBaseSha(FOR_MERGE, URL_NO_SUFFIX, "main", "a".repeat(40))).toBe(true);
  });

  test("matches a not-for-merge line", () => {
    expect(fetchHeadRecordsBaseSha(NOT_FOR_MERGE, URL_NO_SUFFIX, "main", "b".repeat(40))).toBe(true);
  });

  test("matches when the CONFIGURED url carries .git but the record does not — the measured mismatch", () => {
    expect(fetchHeadRecordsBaseSha(NOT_FOR_MERGE, normaliseRemoteUrl("https://github.com/o/r.git"), "main", "b".repeat(40))).toBe(true);
  });

  test("a record for ANOTHER BRANCH of the right remote is not evidence about main", () => {
    const other = `${"c".repeat(40)}\tnot-for-merge\tbranch 'BUTCHR-144' of ${URL_NO_SUFFIX}`;
    expect(fetchHeadRecordsBaseSha(other, URL_NO_SUFFIX, "main", "c".repeat(40))).toBe(false);
  });

  test("DEFECT 2: a record for another REMOTE is not evidence, even for the right branch", () => {
    const otherRemote = `${"d".repeat(40)}\tnot-for-merge\tbranch 'main' of https://github.com/o/ELSEWHERE`;
    expect(fetchHeadRecordsBaseSha(otherRemote, URL_NO_SUFFIX, "main", "d".repeat(40))).toBe(false);
  });

  // THE REVIEW FINDING, at the unit layer. A record can name origin's own URL
  // and the base branch and STILL not be evidence about the base, because a
  // fetch BY URL writes exactly that line without moving the tracking ref.
  test("a record naming the right remote and branch but a DIFFERENT sha is NOT evidence", () => {
    expect(fetchHeadRecordsBaseSha(NOT_FOR_MERGE, URL_NO_SUFFIX, "main", "e".repeat(40))).toBe(false);
  });

  test("the sha comparison is case-insensitive, since git's own output casing is not a contract", () => {
    expect(fetchHeadRecordsBaseSha(NOT_FOR_MERGE, URL_NO_SUFFIX, "main", "B".repeat(40))).toBe(true);
  });

  test("garbage and empty input are false, never a throw", () => {
    expect(() => fetchHeadRecordsBaseSha("", URL_NO_SUFFIX, "main", "a".repeat(40))).not.toThrow();
    expect(fetchHeadRecordsBaseSha("", URL_NO_SUFFIX, "main", "a".repeat(40))).toBe(false);
    expect(fetchHeadRecordsBaseSha("no tabs here at all", URL_NO_SUFFIX, "main", "a".repeat(40))).toBe(false);
  });
});

describe("BUTCHR-163 — realCurrencyGit.lastFetchedAt against real git", () => {
  /** A clone of `remote` that has fetched it, plus a linked worktree. */
  function cloneWithRemote(): { clone: string; remote: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "butchr-163-"));
    const remote = join(root, "remote.git");
    const clone = join(root, "clone");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const seed = join(root, "seed");
    execFileSync("git", ["clone", "-q", remote, seed]);
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
    g(seed, "config", "user.email", "t@example.com");
    g(seed, "config", "user.name", "t");
    g(seed, "commit", "-q", "--allow-empty", "-m", "first");
    g(seed, "push", "-q", "origin", "HEAD:main");
    execFileSync("git", ["clone", "-q", remote, clone]);
    return { clone, remote, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  test("a fetch of origin/main is found, and reported as an ISO timestamp", () => {
    const { clone, cleanup } = cloneWithRemote();
    try {
      execFileSync("git", ["fetch", "-q", "origin"], { cwd: clone });
      const r = realCurrencyGit(clone).lastFetchedAt("origin", "main", baseShaOf(clone));
      expect(r.ok).toBe(true);
      if (r.ok) expect(Number.isNaN(Date.parse(r.iso))).toBe(false);
    } finally {
      cleanup();
    }
  });

  // DEFECT 1. Starting state differs from the state under test: the clone's
  // own FETCH_HEAD is REMOVED first, so the only evidence that can satisfy
  // this test is the one written inside the linked worktree. The pre-fix
  // implementation read only the common dir and therefore could not see it.
  test("DEFECT 1: a fetch performed INSIDE A LINKED WORKTREE still counts", () => {
    const { clone, cleanup } = cloneWithRemote();
    try {
      execFileSync("git", ["fetch", "-q", "origin"], { cwd: clone });
      const wt = join(clone, "..", "wt");
      execFileSync("git", ["worktree", "add", "-q", wt, "-b", "feature"], { cwd: clone });
      // Remove the common-dir record, so ONLY the worktree's can answer.
      rmSync(join(clone, ".git", "FETCH_HEAD"), { force: true });
      execFileSync("git", ["fetch", "-q", "origin"], { cwd: wt });
      expect(existsSync(join(clone, ".git", "FETCH_HEAD"))).toBe(false); // the asymmetry, pinned
      const r = realCurrencyGit(clone).lastFetchedAt("origin", "main", baseShaOf(clone));
      expect(r.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  // DEFECT 2 — the false-green. Starting state: a clone that HAS fetched
  // origin/main (so the naive mtime check would succeed). Then a fetch of a
  // DIFFERENT remote overwrites every FETCH_HEAD with records naming that
  // other remote. The mtime is now fresh and means nothing about origin.
  test("DEFECT 2: a fetch of a DIFFERENT remote does not count as origin freshness", () => {
    const { clone, remote, cleanup } = cloneWithRemote();
    const otherRoot = mkdtempSync(join(tmpdir(), "butchr-163-other-"));
    try {
      execFileSync("git", ["fetch", "-q", "origin"], { cwd: clone });
      const other = join(otherRoot, "other.git");
      execFileSync("git", ["clone", "-q", "--bare", remote, other]);
      execFileSync("git", ["remote", "add", "other", other], { cwd: clone });
      rmSync(join(clone, ".git", "FETCH_HEAD"), { force: true });
      execFileSync("git", ["fetch", "-q", "other"], { cwd: clone });
      // The bare mtime is fresh — the pre-fix code returned ok:true here.
      expect(existsSync(join(clone, ".git", "FETCH_HEAD"))).toBe(true);
      const r = realCurrencyGit(clone).lastFetchedAt("origin", "main", baseShaOf(clone));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("none recorded branch 'main'");
    } finally {
      cleanup();
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  test("a clone that never fetched reports could-not-check, with a reason, never a guess", () => {
    const { clone, cleanup } = cloneWithRemote();
    try {
      rmSync(join(clone, ".git", "FETCH_HEAD"), { force: true });
      const r = realCurrencyGit(clone).lastFetchedAt("origin", "main", baseShaOf(clone));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  // DEFECT 4 — found IN REVIEW of the fix for defects 1 and 2, and the reason
  // naming the URL and branch was not enough on its own.
  //
  // `git fetch <url> main` — by URL, not by remote NAME — writes a record
  // naming origin's own URL and `main`, but git updates
  // refs/remotes/origin/main only for a fetch that goes through the
  // configured remote. So the record read as origin/main freshness while the
  // ref stayed behind, and the gate walked to a false CURRENT.
  //
  // THE FIXTURE'S STARTING STATE DIFFERS FROM THE STATE UNDER TEST, and here
  // that is not a formality — it is why the earlier tests missed this:
  // origin/main must have a REAL REFLOG, created by an actual ref-moving
  // `git fetch origin`. Without one, `refChangedAt` fails and the verdict
  // stops at `unknown` for an unrelated reason, so the test would pass
  // against the broken code and prove nothing.
  test("DEFECT 4: a fetch BY URL freshens FETCH_HEAD without moving the ref, and must not count", () => {
    const { clone, remote, cleanup } = cloneWithRemote();
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
    try {
      const seed = join(remote, "..", "seed");
      // A real, ref-moving fetch first: this is what gives origin/main a reflog.
      g(seed, "commit", "-q", "--allow-empty", "-m", "second");
      g(seed, "push", "-q", "origin", "HEAD:main");
      g(clone, "fetch", "-q", "origin");
      const refAfterRealFetch = baseShaOf(clone);

      // Now the remote advances AGAIN, and the clone fetches BY URL.
      g(seed, "commit", "-q", "--allow-empty", "-m", "third");
      g(seed, "push", "-q", "origin", "HEAD:main");
      const url = g(clone, "config", "--get", "remote.origin.url").trim();
      g(clone, "fetch", "-q", url, "main");

      // The preconditions this test depends on — asserted, not assumed.
      expect(baseShaOf(clone)).toBe(refAfterRealFetch); // the ref did NOT move
      const record = readFileSync(join(clone, ".git", "FETCH_HEAD"), "utf8");
      expect(record).toContain("branch 'main' of"); // it DOES look like origin/main
      expect(record).not.toContain(refAfterRealFetch); // recording a newer sha

      // The verdict must not claim freshness the ref does not have.
      const r = realCurrencyGit(clone).lastFetchedAt("origin", "main", baseShaOf(clone));
      expect(r.ok).toBe(false);

      // And end-to-end: a build matching the STALE ref must not render current.
      const v = resolveCurrency({ sha: baseShaOf(clone), shaDirty: false, shaUnknownReason: null }, realCurrencyGit(clone));
      expect(v.status).toBe("unknown");
      expect(renderBuildCurrencyLines({ sha: baseShaOf(clone), shaProvenance: "git-at-start", shaDirty: false, version: "0" }, v).join("\n")).not.toContain("CURRENT");
    } finally {
      cleanup();
    }
  });

  test("an unknown remote name is an honest failure, never a throw", () => {
    const { clone, cleanup } = cloneWithRemote();
    try {
      const g = realCurrencyGit(clone);
      expect(() => g.lastFetchedAt("nosuchremote", "main", baseShaOf(clone))).not.toThrow();
      expect(g.lastFetchedAt("nosuchremote", "main", baseShaOf(clone)).ok).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("BUTCHR-163 — decision (i): the base's age is inseparable from the verdict", () => {
  const build = { sha: "a".repeat(40), shaProvenance: "git-at-start" as const, shaDirty: false, version: "1.0.0" };
  const base = {
    ref: "refs/remotes/origin/main",
    sha: "b".repeat(40),
    changedAt: "2026-09-01T00:00:00.000Z",
    changedAtUnknownReason: null,
    fetchedAt: "2026-09-01T00:05:00.000Z",
    fetchedAtUnknownReason: null,
  };

  // The pre-fix renderer put the age ONLY in the trailing `comparison base:`
  // sentence. These assert it on the verdict line itself — the line a reader
  // skimming for `CURRENT` actually reads.
  test("the CURRENT line itself carries the base's last-fetched time", () => {
    const v: CurrencyVerdict = { status: "current", base, dirtyUndeterminable: false };
    const currencyLine = renderBuildCurrencyLines(build, v).find((l) => l.includes("currency:"))!;
    expect(currencyLine).toContain("CURRENT");
    expect(currencyLine).toContain(base.fetchedAt);
  });

  test("the STALE line itself carries it too", () => {
    const v: CurrencyVerdict = { status: "stale", commitsBehind: 48, commitsAhead: 0, base, dirtyUndeterminable: false };
    const currencyLine = renderBuildCurrencyLines(build, v).find((l) => l.includes("currency:"))!;
    expect(currencyLine).toContain("STALE");
    expect(currencyLine).toContain(base.fetchedAt);
  });

  test("the un-collapsibility guarantee still holds: UNKNOWN never contains the CURRENT token", () => {
    const v: CurrencyVerdict = { status: "unknown", reason: "no qualifying FETCH_HEAD record" };
    expect(renderBuildCurrencyLines(build, v).join("\n")).not.toContain("CURRENT");
  });
});
