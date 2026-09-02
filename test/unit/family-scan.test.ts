import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  findFamilyCollisions,
  findUnexplainedFamilyCollisions,
  formatFamilyCollisionError,
  KNOWN_FAMILY_COLLISION_EXCLUSIONS,
  scanDirForFamilyCollisions,
  type Family,
  type FamilyCollisionHit,
} from "../../src/media/family-scan.js";
import { ALL_AGENT_LABEL_KEYS, isPrLabel } from "../../src/labels/plan.js";
import { REGISTERED_LABELS } from "../../src/labels/registry.js";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * The two real families in this codebase with a value-level anchor and a
 * real selection consumer — built here, not inside src/media/family-scan.ts
 * itself (that file stays leaf-pure and parametrized, same discipline
 * label-scan.ts/header-scan.ts use for their own `registered` sets — see
 * this file's own imports for where the wiring actually happens). pr:*
 * has no anchor of its own equivalent to ALL_AGENT_LABEL_KEYS (PrState is a
 * bare type, not backed by a value-level Record) — REGISTERED_LABELS
 * (src/labels/registry.ts), filtered to the pr: prefix, is the derived
 * stand-in; see src/media/family-scan.ts's own header for why that is
 * still "derived, not hand-enumerated" despite PrState's own gap.
 */
const AGENT_FAMILY: Family = { name: "agent:*", members: new Set(ALL_AGENT_LABEL_KEYS) };
const PR_FAMILY: Family = { name: "pr:*", members: new Set([...REGISTERED_LABELS].filter(isPrLabel)) };
const FAMILIES: readonly Family[] = [AGENT_FAMILY, PR_FAMILY];

describe("findFamilyCollisions — the parser-based scan", () => {
  test("finds a literal hand-enumerating two distinct agent:* members", () => {
    const hits = findFamilyCollisions("src/example.ts", 'const X = "agent:working agent:idle";', FAMILIES);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.family).toBe("agent:*");
    expect(hits[0]!.matchedMembers).toEqual(["agent:idle", "agent:working"]);
  });

  test("does NOT flag a literal containing only ONE family member — this is label-scan.ts's job, not this scanner's", () => {
    expect(findFamilyCollisions("src/example.ts", 'const X = "agent:working";', FAMILIES)).toEqual([]);
  });

  test("does NOT flag a literal with a single member repeated — still only one DISTINCT member", () => {
    expect(findFamilyCollisions("src/example.ts", 'const X = "agent:working agent:working";', FAMILIES)).toEqual([]);
  });

  test("does NOT flag a literal mixing members from DIFFERENT families — two members, but not two of the SAME family", () => {
    expect(findFamilyCollisions("src/example.ts", 'const X = "agent:working pr:open";', FAMILIES)).toEqual([]);
  });

  test("finds a literal hand-enumerating three distinct pr:* members", () => {
    const hits = findFamilyCollisions("src/example.ts", 'const X = "pr:open pr:approved pr:merged";', FAMILIES);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.family).toBe("pr:*");
    expect(hits[0]!.matchedMembers).toEqual(["pr:approved", "pr:merged", "pr:open"]);
  });

  test("does NOT match a mention inside a /** JSDoc */ comment — comments are not string-literal AST nodes", () => {
    expect(findFamilyCollisions("src/example.ts", "/** agent:working and agent:idle both apply */\nexport const x = 1;", FAMILIES)).toEqual([]);
  });

  // THE ACTUAL LIVE SHAPE THIS SCANNER EXISTS TO CATCH: the pre-BUTCHR-155
  // SWEEP_JQL, reconstructed here as a fixture (never against the real
  // src/labels/sweep.ts file in this test — that reconstruction was done,
  // run for real, and reverted manually for this ticket's PR; see this
  // ticket's PR body for that actual output).
  test("THE SWEEP_JQL SHAPE: a single hand-written JQL literal enumerating four of the five agent:* members is caught, naming exactly those four", () => {
    const jql =
      'const SWEEP_JQL = `assignee = currentUser() AND status NOT IN ("In Progress", "In Review") AND labels IN ("agent:working", "agent:idle", "agent:blocked", "agent:none")`;';
    const hits = findFamilyCollisions("src/labels/sweep.ts", jql, FAMILIES);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.family).toBe("agent:*");
    expect(hits[0]!.matchedMembers).toEqual(["agent:blocked", "agent:idle", "agent:none", "agent:working"]);
  });

  test("THE DERIVED FORM OF THE SAME SWEEP_JQL — built from ALL_AGENT_LABEL_KEYS via .map()/.join(), no literal anywhere contains two members — is NOT caught, proving this scanner reads source shape, not runtime behaviour", () => {
    const derived =
      'const SWEEP_JQL = `assignee = currentUser() AND labels IN (${ALL_AGENT_LABEL_KEYS.map((l) => `"${l}"`).join(", ")})`;';
    expect(findFamilyCollisions("src/labels/sweep.ts", derived, FAMILIES)).toEqual([]);
  });

  test("reports the correct 1-indexed line for a hit past the first line", () => {
    const src = ["// header", "// more header", 'const X = "agent:working agent:idle";'].join("\n");
    const hits = findFamilyCollisions("src/x.ts", src, FAMILIES);
    expect(hits).toEqual([{ file: "src/x.ts", line: 3, family: "agent:*", matchedMembers: ["agent:idle", "agent:working"], text: "agent:working agent:idle" }]);
  });
});

describe("findUnexplainedFamilyCollisions", () => {
  const exclusions = [{ file: "src/tools/rogue.ts", family: "agent:*", matchedMembersKey: "agent:idle,agent:working", reason: "test fixture exclusion" }];

  test("keeps only hits that are not a known exclusion", () => {
    const hits: FamilyCollisionHit[] = [
      { file: "src/tools/rogue.ts", line: 1, family: "agent:*", matchedMembers: ["agent:idle", "agent:working"], text: "..." },
      { file: "src/tools/other.ts", line: 5, family: "pr:*", matchedMembers: ["pr:open", "pr:merged"], text: "..." },
    ];
    expect(findUnexplainedFamilyCollisions(hits, exclusions)).toEqual([hits[1]!]);
  });

  test("an exclusion is scoped to its exact (file, family, matchedMembers) triple — the same file/family with a DIFFERENT matched set is still unexplained", () => {
    const hits: FamilyCollisionHit[] = [{ file: "src/tools/rogue.ts", line: 1, family: "agent:*", matchedMembers: ["agent:blocked", "agent:none", "agent:working"], text: "..." }];
    expect(findUnexplainedFamilyCollisions(hits, exclusions)).toEqual(hits);
  });

  test("empty input or everything excluded yields no findings", () => {
    expect(findUnexplainedFamilyCollisions([], exclusions)).toEqual([]);
  });
});

describe("formatFamilyCollisionError", () => {
  const msg = formatFamilyCollisionError([{ file: "src/labels/sweep.ts", line: 25, family: "agent:*", matchedMembers: ["agent:blocked", "agent:idle", "agent:none", "agent:working"], text: "..." }]);

  test("names the offending file, line, family, and matched members", () => {
    expect(msg).toContain("src/labels/sweep.ts:25");
    expect(msg).toContain("agent:*");
    expect(msg).toContain("agent:working");
  });
  test("points at the mechanism to fix it (derive from the anchor) and the exclusion file", () => {
    expect(msg).toContain("derive");
    expect(msg).toContain("family-scan.ts");
  });
});

describe("the actual automatic check — this IS the falsifier, run for real against src/ on every `bun test`", () => {
  const hits = scanDirForFamilyCollisions(join(ROOT, "src"), ROOT, FAMILIES);

  test("no string literal in src/ today hand-enumerates two or more members of the agent:*/pr:* families — re-measured live, not assumed", () => {
    const unexplained = findUnexplainedFamilyCollisions(hits);
    if (unexplained.length > 0) throw new Error(formatFamilyCollisionError(unexplained));
    expect(unexplained).toEqual([]);
  });

  test("every KNOWN_FAMILY_COLLISION_EXCLUSIONS entry matches a real hit in src/ today — empty today, so vacuously true, but this fails loudly instead of letting a stale exclusion accumulate silently", () => {
    for (const exclusion of KNOWN_FAMILY_COLLISION_EXCLUSIONS) {
      const found = hits.some(
        (h) => h.file === exclusion.file && h.family === exclusion.family && [...h.matchedMembers].sort().join(",") === exclusion.matchedMembersKey,
      );
      expect(found).toBe(true);
    }
  });

  test("INJECTED FALSIFIER (this ticket's own falsifier, restated as an in-memory regression pin — see the PR body for the real, run-and-reverted construction against src/labels/sweep.ts): a hand-enumerated collision added to the real hit set is caught", () => {
    const injected: FamilyCollisionHit = { file: "src/example-injected.ts", line: 1, family: "agent:*", matchedMembers: ["agent:idle", "agent:working"], text: "agent:working agent:idle" };
    const unexplained = findUnexplainedFamilyCollisions([...hits, injected]);
    expect(unexplained).toEqual([injected]);
  });
});
