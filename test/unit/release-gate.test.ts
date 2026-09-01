import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { evaluate, requiresRelease, type Facts } from "../../scripts/release/gate.js";
import { parseFragment, type Fragment } from "../../scripts/release/fragments.js";

const ROOT = join(import.meta.dir, "..", "..");

const frag = (path: string, body: string): Fragment => parseFragment(path, body);
const log = (versions: string[] = ["0.1.0"]) => "# Changelog\n" + versions.map((v) => `## [${v}] - 2026-08-24\n### Fixed\n- x\n`).join("");

const base: Facts = {
  version: "0.1.0",
  baseVersion: "0.1.0",
  changedFiles: ["src/a.ts"],
  changelog: log(),
  baseChangelog: log(),
  schemaChanged: false,
  newFragments: [frag("changelog.d/X.md", "bump: patch\n### Fixed\n- a bug\n")],
  today: "2026-08-24",
};
const failing = (f: Partial<Facts>) => evaluate({ ...base, ...f }).verdicts.filter((v) => !v.ok).map((v) => v.reason);

describe("release gate (version at merge, changelog.d fragments)", () => {
  test("happy path: gated change, unchanged version, one fragment, no new heading — passes", () => {
    const r = evaluate(base);
    expect(r.ok, JSON.stringify(r.verdicts)).toBe(true);
    expect(r.bump).toBe("patch");
  });

  test("docs-only PR is exempt and must NOT bump the version", () => {
    expect(evaluate({ ...base, changedFiles: ["README.md"], newFragments: [] }).ok).toBe(true);
    expect(failing({ changedFiles: ["README.md"], version: "0.2.0", newFragments: [] })[0]).toMatch(/version is assigned at MERGE time, not on a branch/);
  });

  test("gated change with no fragment fails, naming exactly what to add", () => {
    const reasons = failing({ newFragments: [] });
    expect(reasons.some((r) => /no changelog\.d\/ fragment was added/.test(r) && /changelog\.d\/<TICKET>\.md/.test(r) && /bump: major\|minor\|patch/.test(r))).toBe(true);
  });

  test("a branch that bumps package.json's version fails, telling the author to remove it", () => {
    const reasons = failing({ version: "0.1.1" });
    expect(reasons.some((r) => /remove the bump/.test(r) && /assigned at MERGE time/.test(r))).toBe(true);
  });

  test("a branch that adds a dated CHANGELOG heading fails", () => {
    const reasons = failing({ changelog: log(["0.2.0", "0.1.0"]) });
    expect(reasons.some((r) => /new "## \[0\.2\.0\] - 2026-08-24" heading/.test(r) && /release workflow writes/.test(r))).toBe(true);
  });

  test("BREAKING content without bump: major fails; bump: major without BREAKING content fails", () => {
    expect(failing({ newFragments: [frag("x.md", "bump: minor\n### BREAKING\n- oops\n")] })[0]).toMatch(/requires "bump: major"/);
    expect(failing({ newFragments: [frag("x.md", "bump: major\n### Added\n- new thing\n")] })[0]).toMatch(/no ### BREAKING section/);
  });
  test("BREAKING content WITH bump: major passes that check", () => {
    const r = evaluate({ ...base, newFragments: [frag("x.md", "bump: major\n### BREAKING\n- all new\n")] });
    expect(r.ok, JSON.stringify(r.verdicts)).toBe(true);
    expect(r.bump).toBe("major");
  });

  test("a fragment with no valid bump line fails, in isolation from the BREAKING checks", () => {
    expect(failing({ newFragments: [frag("x.md", "### Fixed\n- x\n")] })[0]).toMatch(/no valid "bump: major\|minor\|patch"/);
  });

  test("a fragment with a valid bump but no bullets under any known section fails", () => {
    const reasons = failing({ newFragments: [frag("x.md", "bump: patch\n")] });
    expect(reasons.some((r) => /x\.md has no bullets under a known section/.test(r) && /BREAKING\/Added\/Changed\/Fixed\/Removed/.test(r))).toBe(true);
  });
  test("a fragment with a valid bump but a bullet under an UNRECOGNIZED section still fails (not a known section)", () => {
    const reasons = failing({ newFragments: [frag("x.md", "bump: patch\n### Notes\n- unrelated\n")] });
    expect(reasons.some((r) => /x\.md has no bullets under a known section/.test(r))).toBe(true);
  });
  test("a fragment with a valid bump and at least one bullet passes the content check", () => {
    expect(evaluate({ ...base, newFragments: [frag("x.md", "bump: patch\n### Fixed\n- a fix\n")] }).ok).toBe(true);
  });

  test("schema drift requires fragments to declare at least minor", () => {
    expect(failing({ schemaChanged: true })[0]).toMatch(/at least a MINOR bump/); // base fragment declares patch
    expect(evaluate({ ...base, schemaChanged: true, newFragments: [frag("x.md", "bump: minor\n### Added\n- a\n")] }).ok).toBe(true);
    expect(evaluate({ ...base, schemaChanged: true, newFragments: [frag("x.md", "bump: major\n### BREAKING\n- a\n")] }).ok).toBe(true);
  });
  test("schema drift with multiple fragments: only the HIGHEST needs to clear minor", () => {
    const r = evaluate({ ...base, schemaChanged: true, newFragments: [frag("a.md", "bump: patch\n### Fixed\n- x\n"), frag("b.md", "bump: minor\n### Added\n- y\n")] });
    expect(r.ok, JSON.stringify(r.verdicts)).toBe(true);
  });

  test("multiple fragments in one PR are all individually validated", () => {
    const reasons = failing({ newFragments: [frag("a.md", "bump: patch\n### Fixed\n- x\n"), frag("b.md", "bump: minor\n### BREAKING\n- y\n")] });
    expect(reasons.some((r) => /b\.md.*requires "bump: major"/.test(r))).toBe(true);
  });

  test("ungated pass hints when the branch is behind base's tip, and stays silent when it isn't", () => {
    const behind = evaluate({ ...base, changedFiles: ["README.md"], newFragments: [], baseTipVersion: "0.2.0" });
    expect(behind.ok).toBe(true);
    expect(behind.verdicts[0]!.reason).toBe("no gated files changed; no release required (branch is behind base 0.2.0 — merge main when convenient)");
    const current = evaluate({ ...base, changedFiles: ["README.md"], newFragments: [], baseTipVersion: "0.1.0" });
    expect(current.verdicts[0]!.reason).toBe("no gated files changed; no release required");
  });

  test("no gated files changed still passes even with a fragment present (fragment isn't required, but isn't forbidden either)", () => {
    expect(evaluate({ ...base, changedFiles: ["README.md"] }).ok).toBe(true);
  });

  test("a briefs-only change with no fragment fails, naming exactly what to add (BUTCHR-55)", () => {
    const reasons = failing({ changedFiles: ["briefs/task.md"], newFragments: [] });
    expect(reasons.some((r) => /no changelog\.d\/ fragment was added/.test(r) && /changelog\.d\/<TICKET>\.md/.test(r) && /bump: major\|minor\|patch/.test(r))).toBe(true);
  });

  test("a briefs-only change with a fragment passes, same as any other gated change (BUTCHR-55)", () => {
    expect(evaluate({ ...base, changedFiles: ["briefs/task.md"] }).ok).toBe(true);
  });
});

/**
 * Generalises the BUTCHR-55 fix: rather than re-asserting the five briefs by
 * name, this walks EVERY file under src/, regardless of extension, for a
 * build-time asset import (an `import ... from "<path>" with { type: ... }`
 * attribute — the same shape `grep -rn 'with *{ *type:' src/` finds) and
 * asserts `requiresRelease` covers whatever path it resolves to. The
 * ASSET_IMPORT regex is what decides whether a file contributes a path, not
 * its extension — a non-code file simply contributes nothing, so there is no
 * extension allowlist to go stale (BUTCHR-72). A future embedded asset
 * placed outside src/, schema/, package.json or briefs/ — in a .ts file or
 * any other — fails this test instead of silently reopening the hole this
 * ticket closed.
 *
 * TRADE MADE DELIBERATELY (BUTCHR-72): walking every file, not just code
 * files, means ASSET_IMPORT — unanchored, and matched against raw file text
 * — can also match an illustrative example inside a prose/doc file (e.g. a
 * .md file's code fence showing the import syntax), not just a real import.
 * Confirmed: an example whose relative path resolves to somewhere already
 * under src/ stays green (harmless — src/ is gated regardless); one whose
 * relative path resolves outside src/ to an ungated location fails this
 * test even though nothing real imports anything. That is the accepted
 * failure direction — failing loud on a correct file, never silently
 * missing a real asset import — because there is no filter that is right
 * forever, and a false negative here is the defect this ticket exists to
 * close. If this test ever goes red on a file that isn't a real import,
 * either gate the illustrative path or move the example so its relative
 * path stays inside src/.
 */
describe("every build-time asset import reachable from src/ is a gated path (BUTCHR-55)", () => {
  const ASSET_IMPORT = /from\s+["']([^"']+)["']\s+with\s*\{[^}]*type:[^}]*\}/g;

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { out.push(...walk(p)); continue; }
      out.push(p);
    }
    return out;
  }

  function embeddedAssetPaths(): string[] {
    const found: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(ASSET_IMPORT)) {
        found.push(relative(ROOT, join(dirname(file), m[1]!)));
      }
    }
    return found;
  }

  test("the finder actually finds something — a vacuous scan would pass the coverage test for the wrong reason", () => {
    expect(embeddedAssetPaths().length).toBeGreaterThan(0);
  });

  test("every build-time embedded asset import is covered by requiresRelease", () => {
    const uncovered = embeddedAssetPaths().filter((p) => !requiresRelease([p]));
    expect(uncovered, `these build-time embedded assets are NOT on the gated path list, so a change to them ships silently: ${uncovered.join(", ")}`).toEqual([]);
  });
});
