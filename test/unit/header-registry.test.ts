import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HEADER_REGISTRY, REGISTERED_HEADER_TAGS, type HeaderRegistryEntry } from "../../src/headers/registry.js";
import {
  findHeaderTagLiterals,
  findUnregisteredHeaderTagLiterals,
  formatUnregisteredHeaderTagError,
  KNOWN_NON_HEADER_LITERALS,
  scanDirForHeaderTagLiterals,
  type HeaderTagLiteralHit,
} from "../../src/headers/header-scan.js";
import { HEADER_TAGS } from "../../src/tools/relationship.js";

const ROOT = join(import.meta.dir, "..", "..");

describe("HEADER_REGISTRY shape (every entry declares a real withdrawal owner)", () => {
  const nonEmpty = (s: string) => expect(s.trim().length).toBeGreaterThan(0);

  for (const [tag, entry] of Object.entries(HEADER_REGISTRY) as [string, HeaderRegistryEntry][]) {
    test(`${tag}: appliedBy and notes are non-empty prose`, () => {
      nonEmpty(entry.appliedBy);
      nonEmpty(entry.notes);
    });
    test(`${tag}: withdrawnBy is either a non-empty string, or null with a non-empty neverWithdrawnReason`, () => {
      if (entry.withdrawnBy === null) {
        nonEmpty(entry.neverWithdrawnReason);
      } else {
        expect(typeof entry.withdrawnBy).toBe("string");
        nonEmpty(entry.withdrawnBy);
      }
    });
  }
});

describe("HEADER_REGISTRY contents (verified against the code that writes/withdraws each header, not copied from any ticket)", () => {
  test("the [ORPHAN] header is registered", () => {
    expect(HEADER_REGISTRY.orphan).toBeDefined();
    expect(HEADER_REGISTRY.orphan.withdrawnBy).not.toBeNull();
  });
  test("the [ADOPTED] successor header is registered — added in review (BUTCHR-157) after it shipped undeclared and invisible to this scanner", () => {
    expect(HEADER_REGISTRY.adopted).toBeDefined();
    expect(HEADER_REGISTRY.adopted.withdrawnBy).toBeNull();
  });
  test("exactly two registered header kinds today — a change here means a header was added or removed; update deliberately, not by reflex", () => {
    expect(REGISTERED_HEADER_TAGS.size).toBe(2);
    expect(REGISTERED_HEADER_TAGS.has(HEADER_TAGS.orphan)).toBe(true);
    expect(REGISTERED_HEADER_TAGS.has(HEADER_TAGS.adopted)).toBe(true);
  });
});

describe("findHeaderTagLiterals — the parser-based scan", () => {
  test("finds a bare bracketed-all-caps-tag literal", () => {
    const hits = findHeaderTagLiterals("src/example.ts", 'export const X = "[ORPHAN] This ticket has no boss.";');
    expect(hits).toEqual([{ file: "src/example.ts", line: 1, tag: "ORPHAN", text: "[ORPHAN] This ticket has no boss." }]);
  });

  test("does NOT match a lowercase-bracket marker like [correction] — the tag must be all-caps", () => {
    expect(findHeaderTagLiterals("src/example.ts", 'export const X = "[correction] why: ...";')).toEqual([]);
  });

  test("does NOT match a mention inside a /** JSDoc */ comment — comments are not string-literal AST nodes", () => {
    expect(findHeaderTagLiterals("src/example.ts", "/** writes [ORPHAN] on file */\nexport const x = 1;")).toEqual([]);
  });

  test("PATTERN, NOT TODAY'S LITERAL: a DIFFERENT bracketed all-caps tag is caught too — the exact trap this ticket exists to avoid", () => {
    const hits = findHeaderTagLiterals("src/example.ts", 'export const X = "[SHELVED] This ticket has been shelved on purpose.";');
    expect(hits.map((h) => h.tag)).toEqual(["SHELVED"]);
  });

  test("reports the correct 1-indexed line for a hit past the first line", () => {
    const src = ["// header", "// more header", 'export const X = "[ORPHAN] foo";'].join("\n");
    expect(findHeaderTagLiterals("src/x.ts", src)).toEqual([{ file: "src/x.ts", line: 3, tag: "ORPHAN", text: "[ORPHAN] foo" }]);
  });

  // REGRESSION, BUTCHR-157 REVIEW: this ticket's OWN first draft shipped a
  // header (`[ADOPTED]`) built as a template literal WITH substitutions —
  // `ts.isStringLiteralLike` matches StringLiteral and
  // NoSubstitutionTemplateLiteral, but NOT a TemplateExpression — and it
  // went undetected by this exact scanner until human review. This pins
  // BOTH halves of that lesson so it can never silently regress: the
  // dangerous case really is invisible, and the fix (hoisting the tag into
  // its own whole-literal constant) really is what makes it visible again.
  test("a template literal WITH substitutions is INVISIBLE to this scanner — the exact shape that shipped undeclared in this ticket's first draft, caught in review", () => {
    const withSubstitution = 'const x = `[ADOPTED] This ticket has a boss (${callerKey}).`;';
    expect(findHeaderTagLiterals("src/example.ts", withSubstitution)).toEqual([]);
  });

  test("hoisting the tag-bearing prefix into its own whole-literal constant makes it visible again — the actual fix", () => {
    const hoisted = ['const ADOPTED_HEADER_OPEN_LINE = "[ADOPTED] This ticket was adopted.";', "const x = `${ADOPTED_HEADER_OPEN_LINE}\\nAdopted by: ${callerKey}.`;"].join("\n");
    const hits = findHeaderTagLiterals("src/example.ts", hoisted);
    expect(hits.map((h) => h.tag)).toEqual(["ADOPTED"]);
  });
});

describe("findUnregisteredHeaderTagLiterals", () => {
  const registered = new Set(["ORPHAN"]);
  const exclusions = [{ file: "src/tools/somewhere.ts", text: "[NOTAHEADER] shape only", reason: "test fixture exclusion" }];

  test("keeps only hits whose tag is neither registered nor a known exclusion", () => {
    const hits: HeaderTagLiteralHit[] = [
      { file: "src/tools/relationship.ts", line: 1, tag: "ORPHAN", text: "[ORPHAN] ..." },
      { file: "src/tools/somewhere.ts", line: 5, tag: "NOTAHEADER", text: "[NOTAHEADER] shape only" },
      { file: "src/tools/rogue.ts", line: 9, tag: "ROGUE", text: "[ROGUE] a new undeclared header" },
    ];
    expect(findUnregisteredHeaderTagLiterals(hits, registered, exclusions)).toEqual([{ file: "src/tools/rogue.ts", line: 9, tag: "ROGUE", text: "[ROGUE] a new undeclared header" }]);
  });

  test("an exclusion is scoped to its exact (file, text) pair — the same tag in a DIFFERENT file is still unregistered", () => {
    const hits: HeaderTagLiteralHit[] = [{ file: "src/tools/elsewhere.ts", line: 1, tag: "NOTAHEADER", text: "[NOTAHEADER] shape only" }];
    expect(findUnregisteredHeaderTagLiterals(hits, registered, exclusions)).toEqual(hits);
  });

  test("empty input or everything registered yields no findings", () => {
    expect(findUnregisteredHeaderTagLiterals([], registered, exclusions)).toEqual([]);
    expect(findUnregisteredHeaderTagLiterals([{ file: "a.ts", line: 1, tag: "ORPHAN", text: "[ORPHAN] x" }], registered, exclusions)).toEqual([]);
  });
});

describe("formatUnregisteredHeaderTagError", () => {
  const msg = formatUnregisteredHeaderTagError([{ file: "src/tools/rogue.ts", line: 9, tag: "ROGUE", text: "[ROGUE] a new undeclared header" }]);

  test("names the offending file, line, and tag text", () => {
    expect(msg).toContain("src/tools/rogue.ts:9");
    expect(msg).toContain("[ROGUE]");
  });
  test("points at the registration file and the required field", () => {
    expect(msg).toContain("src/headers/registry.ts");
    expect(msg).toContain("withdrawnBy");
  });
  test("states that a written, permanent-never-withdrawn reason is expressible", () => {
    expect(msg).toContain("neverWithdrawnReason");
  });
  test("points at the type-level door and the exclusion file", () => {
    expect(msg).toContain("DescriptionHeaderKind");
    expect(msg).toContain("header-scan.ts");
  });
});

describe("the actual automatic check — this IS the falsifier, run for real against src/ on every `bun test`", () => {
  const hits = scanDirForHeaderTagLiterals(join(ROOT, "src"), ROOT);

  test("every bracketed-all-caps-tag literal in src/ is either registered or a documented non-header exclusion", () => {
    const unregistered = findUnregisteredHeaderTagLiterals(hits, REGISTERED_HEADER_TAGS);
    if (unregistered.length > 0) throw new Error(formatUnregisteredHeaderTagError(unregistered));
    expect(unregistered).toEqual([]);
  });

  test("finds both real header literals in src/tools/relationship.ts", () => {
    expect(hits.some((h) => h.tag === "ORPHAN" && h.file === "src/tools/relationship.ts")).toBe(true);
    expect(hits.some((h) => h.tag === "ADOPTED" && h.file === "src/tools/relationship.ts")).toBe(true);
  });

  // A stale exclusion would hide silently — this fails loudly instead of
  // letting KNOWN_NON_HEADER_LITERALS accumulate dead entries nobody notices.
  test("every KNOWN_NON_HEADER_LITERALS entry matches a real literal in src/ today", () => {
    for (const exclusion of KNOWN_NON_HEADER_LITERALS) {
      expect(hits.some((h) => h.file === exclusion.file && h.text === exclusion.text)).toBe(true);
    }
  });

  test("INJECTED FALSIFIER (BUTCHR-150's own falsifier, restated for this medium): a bare unregistered header-shaped literal added under src/ would fail this check", () => {
    const injected: HeaderTagLiteralHit = { file: "src/example-injected.ts", line: 1, tag: "ROGUE", text: "[ROGUE] not declared anywhere" };
    const unregistered = findUnregisteredHeaderTagLiterals([...hits, injected], REGISTERED_HEADER_TAGS);
    expect(unregistered).toEqual([injected]);
  });
});

/**
 * THE TYPE-LEVEL DOOR, PROVEN RATHER THAN ASSERTED — same technique as
 * test/unit/labels-registry.test.ts: `@ts-expect-error` requires the very
 * next statement to fail to typecheck, or `bun run typecheck` itself fails
 * ("Unused '@ts-expect-error' directive"), so these are a real, CI-enforced
 * compile-time test of HeaderRegistryEntry's shape, not a claim trusted on
 * faith.
 */
describe("HeaderRegistryEntry — type-level shape (compile-time, verified by `bun run typecheck`)", () => {
  test("a valid deliberately-permanent entry compiles", () => {
    const neverWithdrawn: HeaderRegistryEntry = {
      appliedBy: "example only — not a real registered header",
      notes: "demonstrates the withdrawnBy: null shape",
      withdrawnBy: null,
      neverWithdrawnReason: "example reason: replace with a real, human-written justification when actually declaring a permanent header",
    };
    expect(neverWithdrawn.withdrawnBy).toBeNull();
  });

  test("omitting withdrawnBy entirely does not compile", () => {
    // @ts-expect-error — withdrawnBy is required; every HeaderRegistryEntry branch demands it.
    const missing: HeaderRegistryEntry = { appliedBy: "x", notes: "x" };
    expect(missing).toBeDefined();
  });

  test("withdrawnBy: null without neverWithdrawnReason does not compile", () => {
    // @ts-expect-error — the withdrawnBy: null branch requires a non-empty neverWithdrawnReason.
    const missingReason: HeaderRegistryEntry = { appliedBy: "x", notes: "x", withdrawnBy: null };
    expect(missingReason).toBeDefined();
  });

  test("extending DescriptionHeaderKind without a matching HEADER_REGISTRY entry does not compile — proven structurally, not re-asserted: HEADER_REGISTRY's own declared type is Record<DescriptionHeaderKind, HeaderRegistryEntry>, so this file's very first import (HEADER_REGISTRY typechecking against that Record type today) already IS the compile-time proof that every current member has an entry; a future member with none would fail that same assignment, not a new check.", () => {
    expect(Object.keys(HEADER_REGISTRY).sort()).toEqual(["adopted", "orphan"]);
  });
});
