import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LABEL_REGISTRY, REGISTERED_LABELS, type LabelRegistryEntry } from "../../src/labels/registry.js";
import {
  findLabelLiterals,
  findUnregisteredLabelLiterals,
  formatUnregisteredLabelError,
  KNOWN_NON_LABEL_LITERALS,
  LABEL_BLIND_SPOTS,
  scanDirForLabelLiterals,
  type LabelLiteralHit,
} from "../../src/labels/label-scan.js";
import { assertBlindSpotCoverage, withTempFixture, witnessBlindSpot } from "../../src/media/blind-spot.js";

const ROOT = join(import.meta.dir, "..", "..");

describe("LABEL_REGISTRY shape (AC-1/AC-3: every entry declares a real withdrawal owner)", () => {
  const nonEmpty = (s: string) => expect(s.trim().length).toBeGreaterThan(0);

  for (const [label, entry] of Object.entries(LABEL_REGISTRY) as [string, LabelRegistryEntry][]) {
    test(`${label}: appliedBy and notes are non-empty prose`, () => {
      nonEmpty(entry.appliedBy);
      nonEmpty(entry.notes);
    });
    test(`${label}: withdrawnBy is either a non-empty string, or null with a non-empty neverWithdrawnReason`, () => {
      if (entry.withdrawnBy === null) {
        nonEmpty(entry.neverWithdrawnReason);
      } else {
        expect(typeof entry.withdrawnBy).toBe("string");
        nonEmpty(entry.withdrawnBy);
      }
    });
  }
});

describe("LABEL_REGISTRY contents (verified against the code that writes each label, not copied from any ticket)", () => {
  test("the agent:* family — all five mutually exclusive mapAgentStatus/stalled values", () => {
    for (const l of ["agent:working", "agent:idle", "agent:blocked", "agent:stalled", "agent:none"]) {
      expect(LABEL_REGISTRY[l as keyof typeof LABEL_REGISTRY]).toBeDefined();
    }
  });
  test("the pr:* family — all four PrState values", () => {
    for (const l of ["pr:open", "pr:approved", "pr:changes-requested", "pr:merged"]) {
      expect(LABEL_REGISTRY[l as keyof typeof LABEL_REGISTRY]).toBeDefined();
    }
  });
  test("the two verb-owned labels", () => {
    expect(LABEL_REGISTRY["butchr:shelved"]).toBeDefined();
    expect(LABEL_REGISTRY["butchr:orphan"]).toBeDefined();
  });
  test("exactly 11 registered labels — no more, no fewer (a change here means a label was added or removed; update this count deliberately, not by reflex)", () => {
    expect(REGISTERED_LABELS.size).toBe(11);
  });
  // AC-6: this registry describes labels butchr writes; it must never become
  // a list of labels butchr enforces onto tickets it doesn't own.
  test("AC-6: every registered label is under butchr's own namespaces — never a human label", () => {
    for (const label of REGISTERED_LABELS) {
      expect(/^(agent|pr|butchr):/.test(label)).toBe(true);
    }
  });
  // AC-5: butchr:shelved's documented treatment (verb-owned, NOT daemon-owned)
  // must not be re-described here as daemon-owned — that's a different bug
  // from "unregistered" but just as real, so pin it directly against the
  // registry's own prose rather than trusting a human to keep it in sync.
  test("AC-5: butchr:shelved's registry entry does not claim daemon ownership", () => {
    const entry = LABEL_REGISTRY["butchr:shelved"];
    expect(entry.appliedBy.toLowerCase()).not.toContain("daemon");
    expect(entry.notes).toContain("NOT daemon-owned");
  });
});

describe("findLabelLiterals — the parser-based scan (AC-2 mechanism)", () => {
  test("finds a bare whole-string label literal", () => {
    const hits = findLabelLiterals("src/example.ts", 'export const FOO_LABEL = "butchr:foo";');
    expect(hits).toEqual([{ file: "src/example.ts", line: 1, text: "butchr:foo" }]);
  });

  test("finds a label literal written as a template literal with no substitution", () => {
    const hits = findLabelLiterals("src/example.ts", "export const FOO_LABEL = `butchr:foo`;");
    expect(hits.map((h) => h.text)).toEqual(["butchr:foo"]);
  });

  test("does NOT match a label mentioned inside a longer prose string", () => {
    const hits = findLabelLiterals("src/example.ts", 'const msg = "the label butchr:shelved is exempt";');
    expect(hits).toEqual([]);
  });

  test("does NOT match a comment-marker literal like [butchr:parked] — brackets make the whole string not match", () => {
    const hits = findLabelLiterals("src/example.ts", 'const MARKER = "[butchr:parked]";');
    expect(hits).toEqual([]);
  });

  test("does NOT match a mention inside a /** JSDoc */ comment — comments are not string-literal AST nodes", () => {
    const hits = findLabelLiterals("src/example.ts", "/** writes butchr:shelved on shelve */\nexport const x = 1;");
    expect(hits).toEqual([]);
  });

  // This is the case a text regex gets wrong and a real parser gets right:
  // SWEEP_JQL (src/labels/sweep.ts) is a SINGLE single-quoted string whose
  // JQL text contains literal double-quote characters around "agent:working"
  // etc. A regex scanning raw text sees what looks like a standalone
  // double-quoted string literal there; the real TS parser correctly reads
  // the whole thing as the text of the outer single-quoted string, with the
  // inner quote characters as ordinary characters, never as a nested literal.
  test("does NOT match a label-shaped substring embedded inside a larger JQL string (the SWEEP_JQL shape)", () => {
    const jql =
      'const SWEEP_JQL = \'assignee = currentUser() AND status NOT IN ("In Progress", "In Review") AND labels IN ("agent:working", "agent:idle", "agent:blocked", "agent:none")\';';
    expect(findLabelLiterals("src/labels/sweep.ts", jql)).toEqual([]);
  });

  test("reports the correct 1-indexed line for a hit past the first line", () => {
    const src = ["// header", "// more header", 'export const X = "pr:open";'].join("\n");
    const hits = findLabelLiterals("src/x.ts", src);
    expect(hits).toEqual([{ file: "src/x.ts", line: 3, text: "pr:open" }]);
  });
});

describe("findUnregisteredLabelLiterals", () => {
  const registered = new Set(["agent:working"]);
  const exclusions = [{ file: "src/tools/docs.ts", text: "butchr:doc", reason: "test fixture exclusion" }];

  test("keeps only hits that are neither registered nor a known exclusion", () => {
    const hits: LabelLiteralHit[] = [
      { file: "src/labels/sync.ts", line: 1, text: "agent:working" },
      { file: "src/tools/docs.ts", line: 5, text: "butchr:doc" },
      { file: "src/tools/rogue.ts", line: 9, text: "butchr:rogue" },
    ];
    expect(findUnregisteredLabelLiterals(hits, registered, exclusions)).toEqual([{ file: "src/tools/rogue.ts", line: 9, text: "butchr:rogue" }]);
  });

  test("an exclusion is scoped to its exact (file, text) pair — the same literal in a DIFFERENT file is still unregistered", () => {
    const hits: LabelLiteralHit[] = [{ file: "src/tools/somewhere-else.ts", line: 1, text: "butchr:doc" }];
    expect(findUnregisteredLabelLiterals(hits, registered, exclusions)).toEqual(hits);
  });

  test("empty input, everything registered, or everything excluded all yield no findings", () => {
    expect(findUnregisteredLabelLiterals([], registered, exclusions)).toEqual([]);
    expect(findUnregisteredLabelLiterals([{ file: "a.ts", line: 1, text: "agent:working" }], registered, exclusions)).toEqual([]);
  });
});

describe("formatUnregisteredLabelError (AC-4: legible to an agent who has never read this ticket)", () => {
  const msg = formatUnregisteredLabelError([{ file: "src/tools/rogue.ts", line: 9, text: "butchr:rogue" }]);

  test("names the offending file, line, and literal", () => {
    expect(msg).toContain("src/tools/rogue.ts:9");
    expect(msg).toContain('"butchr:rogue"');
  });
  test("points at the registration file and the required field", () => {
    expect(msg).toContain("src/labels/registry.ts");
    expect(msg).toContain("withdrawnBy");
  });
  test("states that a written, permanent-never-withdrawn reason is expressible", () => {
    expect(msg).toContain("neverWithdrawnReason");
  });
  test("points at the exclusion file for a genuine false positive", () => {
    expect(msg).toContain("label-scan.ts");
  });
});

describe("the actual automatic check — this IS the falsifier (AC-2), run for real against src/ on every `bun test`", () => {
  const hits = scanDirForLabelLiterals(join(ROOT, "src"), ROOT);

  test("every butchr-namespaced label literal in src/ is either registered or a documented non-label exclusion", () => {
    const unregistered = findUnregisteredLabelLiterals(hits, REGISTERED_LABELS);
    if (unregistered.length > 0) throw new Error(formatUnregisteredLabelError(unregistered));
    expect(unregistered).toEqual([]);
  });

  // A stale exclusion (nothing in the real tree matches it any more) would
  // hide silently — this fails loudly instead of letting KNOWN_NON_LABEL_LITERALS
  // accumulate dead entries nobody notices.
  test("every KNOWN_NON_LABEL_LITERALS entry matches a real literal in src/ today", () => {
    for (const exclusion of KNOWN_NON_LABEL_LITERALS) {
      const found = hits.some((h) => h.file === exclusion.file && h.text === exclusion.text);
      expect(found).toBe(true);
    }
  });
});

/**
 * BUTCHR-224 — LABEL_BLIND_SPOTS, EXECUTABLE WITNESSES WITH PAIRED POSITIVE
 * CONTROLS. Each `test()` below calls `witnessBlindSpot` with the exact id
 * `src/labels/label-scan.ts`'s `LABEL_BLIND_SPOTS` declares for that entry.
 * See `src/media/blind-spot.ts` for why the pairing itself (silence +
 * positiveControl) is structural rather than a convention to remember.
 */
describe("LABEL_BLIND_SPOTS witnesses (BUTCHR-224)", () => {
  test("concatenationAndInterpolation — a label built by AGENT_PREFIX-style concatenation, or by template interpolation, is invisible; the identical value as a single whole literal IS found", () => {
    witnessBlindSpot("label:concatenation-and-interpolation", {
      silence: () => {
        expect(findLabelLiterals("src/example.ts", 'const AGENT_PREFIX = "agent:"; const x = AGENT_PREFIX + "working";')).toEqual([]);
        expect(findLabelLiterals("src/example.ts", "const PR_PREFIX = `pr:`; const state = `open`; const x = `${PR_PREFIX}${state}`;")).toEqual([]);
      },
      positiveControl: () => {
        const hits = findLabelLiterals("src/example.ts", 'const x = "agent:working";');
        expect(hits.map((h) => h.text)).toEqual(["agent:working"]);
      },
    });
  });

  test("unscannedDirectories — an identical label literal under test/ is invisible to scanDirForLabelLiterals when it is only pointed at src/; the same literal under src/ IS found", () => {
    withTempFixture((root) => {
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, "test"));
      writeFileSync(join(root, "src", "example.ts"), 'export const X = "butchr:rogue";');
      writeFileSync(join(root, "test", "example.ts"), 'export const X = "butchr:rogue";');
      const scanHits = scanDirForLabelLiterals(join(root, "src"), root);
      witnessBlindSpot("label:unscanned-directories", {
        silence: () => {
          expect(scanHits.some((h) => h.file === "test/example.ts")).toBe(false);
        },
        positiveControl: () => {
          expect(scanHits.some((h) => h.text === "butchr:rogue" && h.file === "src/example.ts")).toBe(true);
        },
      });
    });
  });

  test("nonLabelLookalike — a label-shaped literal that is NOT a real Jira label is silenced ONLY by an explicit KNOWN_NON_LABEL_LITERALS-shaped exclusion; the identical shape in a DIFFERENT, unexcluded file is still flagged", () => {
    const exclusions = [{ file: "src/tools/lookalike.ts", text: "butchr:not-a-real-label", reason: "test witness — a hypothetical id/marker, not a Jira label" }];
    witnessBlindSpot("label:non-label-lookalike", {
      silence: () => {
        const hits: LabelLiteralHit[] = [{ file: "src/tools/lookalike.ts", line: 1, text: "butchr:not-a-real-label" }];
        expect(findUnregisteredLabelLiterals(hits, new Set(), exclusions)).toEqual([]);
      },
      positiveControl: () => {
        const hits: LabelLiteralHit[] = [{ file: "src/tools/elsewhere.ts", line: 1, text: "butchr:not-a-real-label" }];
        expect(findUnregisteredLabelLiterals(hits, new Set(), exclusions)).toEqual(hits);
      },
    });
  });

  test("nonTsFiles — an identical label literal in a non-.ts file under src/ is invisible to scanDirForLabelLiterals; the same literal in a .ts file IS found", () => {
    withTempFixture((root) => {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "example.ts"), 'export const X = "butchr:rogue";');
      writeFileSync(join(root, "src", "example.md"), 'export const X = "butchr:rogue";');
      const scanHits = scanDirForLabelLiterals(join(root, "src"), root);
      witnessBlindSpot("label:non-ts-files", {
        silence: () => {
          expect(scanHits.some((h) => h.file === "src/example.md")).toBe(false);
        },
        positiveControl: () => {
          expect(scanHits.some((h) => h.text === "butchr:rogue" && h.file === "src/example.ts")).toBe(true);
        },
      });
    });
  });

  test("COVERAGE (must run after every witness above in this same file — see src/media/blind-spot.ts, 'THE ORDERING HAZARD'): every LABEL_BLIND_SPOTS entry's declared witness id was actually executed, or it declares a written noWitnessReason instead", () => {
    assertBlindSpotCoverage("LABEL_BLIND_SPOTS", LABEL_BLIND_SPOTS);
  });
});

/**
 * THE TYPE-LEVEL DOOR, PROVEN RATHER THAN ASSERTED: `@ts-expect-error`
 * requires the very next statement to fail to typecheck, or `bun run
 * typecheck` itself fails ("Unused '@ts-expect-error' directive") — so these
 * three lines are a real, CI-enforced compile-time test of
 * LabelRegistryEntry's shape, not a claim trusted on faith. See
 * src/labels/registry.ts's header for what each shape means.
 */
describe("LabelRegistryEntry — type-level shape (compile-time, verified by `bun run typecheck`)", () => {
  test("a valid deliberately-permanent entry compiles", () => {
    const neverWithdrawn: LabelRegistryEntry = {
      appliedBy: "example only — not a real registered label",
      notes: "demonstrates the withdrawnBy: null shape",
      withdrawnBy: null,
      neverWithdrawnReason: "example reason: replace with a real, human-written justification when actually declaring a permanent label",
    };
    expect(neverWithdrawn.withdrawnBy).toBeNull();
  });

  test("omitting withdrawnBy entirely does not compile", () => {
    // @ts-expect-error — withdrawnBy is required; every LabelRegistryEntry branch demands it.
    const missing: LabelRegistryEntry = { appliedBy: "x", notes: "x" };
    expect(missing).toBeDefined();
  });

  test("withdrawnBy: null without neverWithdrawnReason does not compile", () => {
    // @ts-expect-error — the withdrawnBy: null branch requires a non-empty neverWithdrawnReason.
    const missingReason: LabelRegistryEntry = { appliedBy: "x", notes: "x", withdrawnBy: null };
    expect(missingReason).toBeDefined();
  });
});
