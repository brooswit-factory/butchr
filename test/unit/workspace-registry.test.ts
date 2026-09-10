import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_REGISTRY, type WorkspaceRegistryEntry } from "../../src/workspace/registry.js";
import {
  findWorkspacePlaceholders,
  findUnregisteredWorkspacePlaceholders,
  formatUnregisteredWorkspacePlaceholderError,
  KNOWN_NON_WORKSPACE_PLACEHOLDER_LITERALS,
  scanTemplatesForWorkspacePlaceholders,
  WORKSPACE_BLIND_SPOTS,
  type WorkspacePlaceholderHit,
} from "../../src/workspace/workspace-scan.js";
import { WORKSPACE_PLACEHOLDERS } from "../../src/agents/workspace.js";
import { assertBlindSpotCoverage, withTempFixture, witnessBlindSpot } from "../../src/media/blind-spot.js";

const ROOT = join(import.meta.dir, "..", "..");

describe("WORKSPACE_REGISTRY shape (every entry declares a real withdrawal owner)", () => {
  const nonEmpty = (s: string) => expect(s.trim().length).toBeGreaterThan(0);

  for (const [name, entry] of Object.entries(WORKSPACE_REGISTRY) as [string, WorkspaceRegistryEntry][]) {
    test(`${name}: appliedBy and notes are non-empty prose`, () => {
      nonEmpty(entry.appliedBy);
      nonEmpty(entry.notes);
    });
    test(`${name}: withdrawnBy is either a non-empty string, or null with a non-empty neverWithdrawnReason`, () => {
      if (entry.withdrawnBy === null) {
        nonEmpty(entry.neverWithdrawnReason);
      } else {
        expect(typeof entry.withdrawnBy).toBe("string");
        nonEmpty(entry.withdrawnBy);
      }
    });
  }
});

describe("WORKSPACE_REGISTRY contents (verified against the code that writes each record, not copied from any ticket)", () => {
  test("exactly five registered placeholders today, matching WORKSPACE_PLACEHOLDERS — a change here means interpolate()'s substitution table changed; update deliberately, not by reflex", () => {
    expect(Object.keys(WORKSPACE_REGISTRY).sort()).toEqual([...WORKSPACE_PLACEHOLDERS].sort());
  });
  test("KEY and TYPE are declared never-withdrawn — time-invariant / never written, for DIFFERENT reasons (not the same boilerplate reason copy-pasted)", () => {
    expect(WORKSPACE_REGISTRY.KEY.withdrawnBy).toBeNull();
    expect(WORKSPACE_REGISTRY.TYPE.withdrawnBy).toBeNull();
    if (WORKSPACE_REGISTRY.KEY.withdrawnBy === null && WORKSPACE_REGISTRY.TYPE.withdrawnBy === null) {
      expect(WORKSPACE_REGISTRY.KEY.neverWithdrawnReason).not.toBe(WORKSPACE_REGISTRY.TYPE.neverWithdrawnReason);
    }
  });
  test("SUMMARY has a real withdrawal mechanism (correctWorker's best-effort brief.md rewrite)", () => {
    expect(WORKSPACE_REGISTRY.SUMMARY.withdrawnBy).not.toBeNull();
    expect(WORKSPACE_REGISTRY.SUMMARY.withdrawnBy).toContain("correctWorker");
  });
  test("PARENT is declared never-withdrawn for a reason distinct from KEY/TYPE — a residual re-parent gap, not immutability or non-use", () => {
    expect(WORKSPACE_REGISTRY.PARENT.withdrawnBy).toBeNull();
    if (WORKSPACE_REGISTRY.PARENT.withdrawnBy === null) {
      expect(WORKSPACE_REGISTRY.PARENT.neverWithdrawnReason).toContain("re-parent");
    }
  });
  test("GROUND_TRUTH is declared never-withdrawn, and its reason names the honesty concession (a timestamp, not a machine check)", () => {
    expect(WORKSPACE_REGISTRY.GROUND_TRUTH.withdrawnBy).toBeNull();
    if (WORKSPACE_REGISTRY.GROUND_TRUTH.withdrawnBy === null) {
      expect(WORKSPACE_REGISTRY.GROUND_TRUTH.neverWithdrawnReason).toContain("measured at");
    }
  });
});

describe("findWorkspacePlaceholders — the text-shape scan", () => {
  test("finds a bare {{NAME}} placeholder", () => {
    expect(findWorkspacePlaceholders("briefs/x.md", "hello {{KEY}} world")).toEqual([{ file: "briefs/x.md", line: 1, name: "KEY" }]);
  });
  test("finds more than one placeholder on the same line", () => {
    expect(findWorkspacePlaceholders("briefs/x.md", "{{KEY}}: {{SUMMARY}}").map((h) => h.name)).toEqual(["KEY", "SUMMARY"]);
  });
  test("does NOT match a lowercase or mixed-case brace pair — the name must be all-caps", () => {
    expect(findWorkspacePlaceholders("briefs/x.md", "{{key}} {{Key}}")).toEqual([]);
  });
  test("PATTERN, NOT TODAY'S FIVE NAMES: a brand-new placeholder name is caught too", () => {
    expect(findWorkspacePlaceholders("briefs/x.md", "{{BRAND_NEW_THING}}").map((h) => h.name)).toEqual(["BRAND_NEW_THING"]);
  });
  test("reports the correct 1-indexed line for a hit past the first line", () => {
    const src = ["line one", "line two", "{{KEY}} on line three"].join("\n");
    expect(findWorkspacePlaceholders("briefs/x.md", src)).toEqual([{ file: "briefs/x.md", line: 3, name: "KEY" }]);
  });
});

describe("findUnregisteredWorkspacePlaceholders", () => {
  const registered = new Set(["KEY"]);
  const exclusions = [{ file: "briefs/example.md", name: "LIKE_THIS", reason: "test fixture exclusion" }];

  test("keeps only hits whose name is neither registered nor a known exclusion", () => {
    const hits: WorkspacePlaceholderHit[] = [
      { file: "briefs/task.md", line: 1, name: "KEY" },
      { file: "briefs/example.md", line: 5, name: "LIKE_THIS" },
      { file: "briefs/rogue.md", line: 9, name: "ROGUE" },
    ];
    expect(findUnregisteredWorkspacePlaceholders(hits, registered, exclusions)).toEqual([{ file: "briefs/rogue.md", line: 9, name: "ROGUE" }]);
  });
  test("an exclusion is scoped to its exact (file, name) pair — the same name in a DIFFERENT file is still unregistered", () => {
    const hits: WorkspacePlaceholderHit[] = [{ file: "briefs/elsewhere.md", line: 1, name: "LIKE_THIS" }];
    expect(findUnregisteredWorkspacePlaceholders(hits, registered, exclusions)).toEqual(hits);
  });
  test("empty input or everything registered yields no findings", () => {
    expect(findUnregisteredWorkspacePlaceholders([], registered, exclusions)).toEqual([]);
    expect(findUnregisteredWorkspacePlaceholders([{ file: "a.md", line: 1, name: "KEY" }], registered, exclusions)).toEqual([]);
  });
});

describe("formatUnregisteredWorkspacePlaceholderError", () => {
  const msg = formatUnregisteredWorkspacePlaceholderError([{ file: "briefs/rogue.md", line: 9, name: "ROGUE" }]);

  test("names the offending file, line, and placeholder", () => {
    expect(msg).toContain("briefs/rogue.md:9");
    expect(msg).toContain("{{ROGUE}}");
  });
  test("points at the registration file and the required field", () => {
    expect(msg).toContain("src/workspace/registry.ts");
    expect(msg).toContain("withdrawnBy");
  });
  test("states that a written, permanent-never-withdrawn reason is expressible", () => {
    expect(msg).toContain("neverWithdrawnReason");
  });
  test("points at the type-level door and the exclusion file", () => {
    expect(msg).toContain("WORKSPACE_PLACEHOLDERS");
    expect(msg).toContain("workspace-scan.ts");
  });
});

describe("the actual automatic check — this IS the falsifier, run for real against briefs/ on every `bun test`", () => {
  const hits = scanTemplatesForWorkspacePlaceholders(join(ROOT, "briefs"), ROOT);
  const registeredNames = new Set(WORKSPACE_PLACEHOLDERS as readonly string[]);

  test("every {{PLACEHOLDER}} in briefs/ is either registered or a documented exclusion", () => {
    const unregistered = findUnregisteredWorkspacePlaceholders(hits, registeredNames);
    if (unregistered.length > 0) throw new Error(formatUnregisteredWorkspacePlaceholderError(unregistered));
    expect(unregistered).toEqual([]);
  });

  test("finds {{KEY}} and {{SUMMARY}} in task.md, and {{PARENT}} restored there by BUTCHR-169's source fix", () => {
    expect(hits.some((h) => h.name === "KEY" && h.file === "briefs/task.md")).toBe(true);
    expect(hits.some((h) => h.name === "SUMMARY" && h.file === "briefs/task.md")).toBe(true);
    expect(hits.some((h) => h.name === "PARENT" && h.file === "briefs/task.md")).toBe(true);
  });

  test("{{GROUND_TRUTH}} is found ONLY in CLAUDE.md — the false half of correct_worker's old claim, fixed by this ticket", () => {
    const groundTruthHits = hits.filter((h) => h.name === "GROUND_TRUTH");
    expect(groundTruthHits).toEqual([{ file: "briefs/CLAUDE.md", line: 12, name: "GROUND_TRUTH" }]);
  });

  test("{{TYPE}} appears in NO template today — matches WORKSPACE_REGISTRY.TYPE's own claim, re-verified here rather than trusted", () => {
    expect(hits.some((h) => h.name === "TYPE")).toBe(false);
  });

  // A stale exclusion would hide silently — this fails loudly instead of
  // letting KNOWN_NON_WORKSPACE_PLACEHOLDER_LITERALS accumulate dead entries
  // nobody notices.
  test("every KNOWN_NON_WORKSPACE_PLACEHOLDER_LITERALS entry matches a real hit in briefs/ today", () => {
    for (const exclusion of KNOWN_NON_WORKSPACE_PLACEHOLDER_LITERALS) {
      expect(hits.some((h) => h.file === exclusion.file && h.name === exclusion.name)).toBe(true);
    }
  });

  test("INJECTED FALSIFIER (this epic's own falsifier, restated for this medium): a bare unregistered placeholder added under briefs/ would fail this check", () => {
    const injected: WorkspacePlaceholderHit = { file: "briefs/example-injected.md", line: 1, name: "ROGUE" };
    const unregistered = findUnregisteredWorkspacePlaceholders([...hits, injected], registeredNames);
    expect(unregistered).toEqual([injected]);
  });
});

/**
 * BUTCHR-224 — WORKSPACE_BLIND_SPOTS, EXECUTABLE WITNESSES WITH PAIRED
 * POSITIVE CONTROLS. Each `test()` below calls `witnessBlindSpot` with the
 * exact id `src/workspace/workspace-scan.ts`'s `WORKSPACE_BLIND_SPOTS`
 * declares for that entry. TWO entries (`nonTemplateWriteSites`,
 * `mergedNotDeployed`) are `witness: null` with a written `noWitnessReason`
 * instead — see that file's own comment on WORKSPACE_BLIND_SPOTS for why
 * they are two DIFFERENT kinds of unwitnessable, not the same gap named
 * twice. Neither needs a test here; `assertBlindSpotCoverage` only demands
 * execution for entries that declare a witness id.
 */
describe("WORKSPACE_BLIND_SPOTS witnesses (BUTCHR-224)", () => {
  test("secondTemplatesDirectory — an identical placeholder in a sibling directory is invisible to scanTemplatesForWorkspacePlaceholders when it is only pointed at briefs/; the same placeholder under briefs/ IS found", () => {
    withTempFixture((root) => {
      mkdirSync(join(root, "briefs"));
      mkdirSync(join(root, "other-briefs"));
      writeFileSync(join(root, "briefs", "registered.md"), "hello {{ROGUE}} world");
      writeFileSync(join(root, "other-briefs", "rogue.md"), "hello {{ROGUE}} world");
      const scanHits = scanTemplatesForWorkspacePlaceholders(join(root, "briefs"), root);
      witnessBlindSpot("workspace:second-templates-directory", {
        silence: () => {
          expect(scanHits.some((h) => h.file === "other-briefs/rogue.md")).toBe(false);
        },
        positiveControl: () => {
          expect(scanHits.some((h) => h.name === "ROGUE" && h.file === "briefs/registered.md")).toBe(true);
        },
      });
    });
  });

  test("nonRecursiveSubdirectory — an identical placeholder in a subdirectory of briefs/ is invisible to scanTemplatesForWorkspacePlaceholders (non-recursive); the same placeholder directly under briefs/ IS found", () => {
    withTempFixture((root) => {
      mkdirSync(join(root, "briefs"));
      mkdirSync(join(root, "briefs", "sub"));
      writeFileSync(join(root, "briefs", "top.md"), "hello {{ROGUE}} world");
      writeFileSync(join(root, "briefs", "sub", "nested.md"), "hello {{ROGUE}} world");
      const scanHits = scanTemplatesForWorkspacePlaceholders(join(root, "briefs"), root);
      witnessBlindSpot("workspace:non-recursive-subdirectory", {
        silence: () => {
          expect(scanHits.some((h) => h.file === "briefs/sub/nested.md")).toBe(false);
        },
        positiveControl: () => {
          expect(scanHits.some((h) => h.name === "ROGUE" && h.file === "briefs/top.md")).toBe(true);
        },
      });
    });
  });

  test("nonMdFiles — an identical placeholder in a non-.md file under briefs/ is invisible to scanTemplatesForWorkspacePlaceholders; the same placeholder in a .md file IS found", () => {
    withTempFixture((root) => {
      mkdirSync(join(root, "briefs"));
      writeFileSync(join(root, "briefs", "real.md"), "hello {{ROGUE}} world");
      writeFileSync(join(root, "briefs", "real.txt"), "hello {{ROGUE}} world");
      const scanHits = scanTemplatesForWorkspacePlaceholders(join(root, "briefs"), root);
      witnessBlindSpot("workspace:non-md-files", {
        silence: () => {
          expect(scanHits.some((h) => h.file === "briefs/real.txt")).toBe(false);
        },
        positiveControl: () => {
          expect(scanHits.some((h) => h.name === "ROGUE" && h.file === "briefs/real.md")).toBe(true);
        },
      });
    });
  });

  test("placeholderLookalike — a placeholder-shaped hit that is NOT a live interpolation target is silenced ONLY by an explicit KNOWN_NON_WORKSPACE_PLACEHOLDER_LITERALS-shaped exclusion; the identical shape in a DIFFERENT, unexcluded file is still flagged", () => {
    const exclusions = [{ file: "briefs/example.md", name: "LIKE_THIS", reason: "test witness — a worked documentation example, not a real placeholder" }];
    witnessBlindSpot("workspace:placeholder-lookalike", {
      silence: () => {
        const hits: WorkspacePlaceholderHit[] = [{ file: "briefs/example.md", line: 1, name: "LIKE_THIS" }];
        expect(findUnregisteredWorkspacePlaceholders(hits, new Set(), exclusions)).toEqual([]);
      },
      positiveControl: () => {
        const hits: WorkspacePlaceholderHit[] = [{ file: "briefs/elsewhere.md", line: 1, name: "LIKE_THIS" }];
        expect(findUnregisteredWorkspacePlaceholders(hits, new Set(), exclusions)).toEqual(hits);
      },
    });
  });

  test("COVERAGE (must run after every witness above in this same file — see src/media/blind-spot.ts, 'THE ORDERING HAZARD'): every WORKSPACE_BLIND_SPOTS entry's declared witness id was actually executed, or it declares a written noWitnessReason instead", () => {
    assertBlindSpotCoverage("WORKSPACE_BLIND_SPOTS", WORKSPACE_BLIND_SPOTS);
  });

  test("exactly two entries are witness: null today (nonTemplateWriteSites, mergedNotDeployed) — a change here means a blind spot became witnessable or a new unwitnessable one was added; update this pin deliberately, not by reflex", () => {
    const unwitnessed = Object.entries(WORKSPACE_BLIND_SPOTS)
      .filter(([, entry]) => entry.witness === null)
      .map(([key]) => key)
      .sort();
    expect(unwitnessed).toEqual(["mergedNotDeployed", "nonTemplateWriteSites"]);
  });

  test("the two witness: null entries give DIFFERENT reasons — this is not one gap named twice", () => {
    const nonTemplate = WORKSPACE_BLIND_SPOTS.nonTemplateWriteSites;
    const mergedNotDeployed = WORKSPACE_BLIND_SPOTS.mergedNotDeployed;
    expect(nonTemplate.witness).toBeNull();
    expect(mergedNotDeployed.witness).toBeNull();
    if (nonTemplate.witness === null && mergedNotDeployed.witness === null) {
      expect(nonTemplate.noWitnessReason).not.toBe(mergedNotDeployed.noWitnessReason);
      expect(mergedNotDeployed.noWitnessReason.toLowerCase()).toContain("deployed");
    }
  });
});

/**
 * THE TYPE-LEVEL DOOR, PROVEN RATHER THAN ASSERTED — same technique as
 * test/unit/header-registry.test.ts and test/unit/labels-registry.test.ts:
 * `@ts-expect-error` requires the very next statement to fail to typecheck,
 * or `bun run typecheck` itself fails ("Unused '@ts-expect-error' directive"),
 * so these are a real, CI-enforced compile-time test, not a claim trusted on
 * faith.
 */
describe("WorkspaceRegistryEntry — type-level shape (compile-time, verified by `bun run typecheck`)", () => {
  test("a valid deliberately-permanent entry compiles", () => {
    const neverWithdrawn: WorkspaceRegistryEntry = {
      appliedBy: "example only — not a real registered record",
      notes: "demonstrates the withdrawnBy: null shape",
      withdrawnBy: null,
      neverWithdrawnReason: "example reason: replace with a real, human-written justification when actually declaring a permanent record",
    };
    expect(neverWithdrawn.withdrawnBy).toBeNull();
  });

  test("omitting withdrawnBy entirely does not compile", () => {
    // @ts-expect-error — withdrawnBy is required; every WorkspaceRegistryEntry branch demands it.
    const missing: WorkspaceRegistryEntry = { appliedBy: "x", notes: "x" };
    expect(missing).toBeDefined();
  });

  test("withdrawnBy: null without neverWithdrawnReason does not compile", () => {
    // @ts-expect-error — the withdrawnBy: null branch requires a non-empty neverWithdrawnReason.
    const missingReason: WorkspaceRegistryEntry = { appliedBy: "x", notes: "x", withdrawnBy: null };
    expect(missingReason).toBeDefined();
  });

  test("extending WORKSPACE_PLACEHOLDERS without a matching WORKSPACE_REGISTRY entry does not compile — proven structurally: WORKSPACE_REGISTRY's own declared type is Record<WorkspacePlaceholder, WorkspaceRegistryEntry>, so this file's very first import (WORKSPACE_REGISTRY typechecking against that Record type today) already IS the compile-time proof that every current member has an entry; a future member with none would fail that same assignment, not a new check.", () => {
    expect(Object.keys(WORKSPACE_REGISTRY).sort()).toEqual([...WORKSPACE_PLACEHOLDERS].sort());
  });
});
