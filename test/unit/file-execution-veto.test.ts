import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFileExecutionRisk, extractRunnerFileTargets, matchDestructivePattern } from "../../src/agents/file-execution-veto.js";

// FACTORY-638 review round 1: "Test 1 passes only because its fixture is
// the bare string `x; rm -rf ~`, not the actual shape (rm inside a
// template/string literal). The regression test proves a toy, not the
// incident." These are the exact four MISS cases the review ran against
// the first pass's `matchDestructivePattern` and reported as misses — every
// one must now match.
describe("matchDestructivePattern — FACTORY-638 review round 1: delimiter-defeated rm targets", () => {
  test("rm inside a bun $ shell template (the actual FACTORY-625 diagnosis shape)", () => {
    const hit = matchDestructivePattern("await $`x; rm -rf ~`;");
    expect(hit?.name).toBe("rm -rf against $HOME/root/wildcard");
  });

  test('sh -c "x; rm -rf ~" embedded as a quoted string inside file content', () => {
    const hit = matchDestructivePattern('exec(\'sh -c "x; rm -rf ~"\');');
    expect(hit?.name).toBe("rm -rf against $HOME/root/wildcard");
  });

  test('exec("rm -rf $HOME")', () => {
    const hit = matchDestructivePattern('exec("rm -rf $HOME");');
    expect(hit?.name).toBe("rm -rf against $HOME/root/wildcard");
  });

  test("rm -rf ~) — a bare trailing close-paren from surrounding syntax", () => {
    const hit = matchDestructivePattern("foo(rm -rf ~)");
    expect(hit?.name).toBe("rm -rf against $HOME/root/wildcard");
  });

  test("still does not false-positive on a target that merely CONTAINS ~ as a substring, once delimiters are stripped", () => {
    expect(matchDestructivePattern("rm -rf ~backup-dir")).toBeNull();
    expect(matchDestructivePattern("rm -rf ./build")).toBeNull();
  });
});

describe("extractRunnerFileTargets — FACTORY-638 review round 1: inspect ALL targets, not just the first", () => {
  test("a compound command naming two files reports both", () => {
    const targets = extractRunnerFileTargets("sh ok.sh; sh evil.sh");
    expect(targets).toEqual([
      { kind: "file", path: "ok.sh" },
      { kind: "file", path: "evil.sh" },
    ]);
  });

  test("&&-joined runners are both reported", () => {
    const targets = extractRunnerFileTargets("node ok.js && node evil.js");
    expect(targets).toEqual([
      { kind: "file", path: "ok.js" },
      { kind: "file", path: "evil.js" },
    ]);
  });
});

describe("extractRunnerFileTargets — FACTORY-638 review round 1: bare bun test/run fails closed instead of being silently approved", () => {
  test("bun test with no file argument at all is dynamic, not none", () => {
    expect(extractRunnerFileTargets("bun test")).toEqual([{ kind: "dynamic", detail: "bun test with no explicit file argument runs the whole tree/script list, uninspected" }]);
  });

  test("bun test with only flags (no file) is still dynamic", () => {
    expect(extractRunnerFileTargets("bun test --watch")).toEqual([{ kind: "dynamic", detail: "bun test with no explicit file argument runs the whole tree/script list, uninspected" }]);
  });

  test("the review's exact repro: a multi-line description must not be read as the file argument", () => {
    // Previously: the whole multi-line command was regexed with `\s+`
    // (which matches `\n`), so "Run" (from the second line) was captured as
    // the file target. Per-segment extraction means this command's first
    // segment is just "bun test" with nothing after it on that line.
    const targets = extractRunnerFileTargets("bun test\nRun the new test");
    expect(targets[0]).toEqual({ kind: "dynamic", detail: "bun test with no explicit file argument runs the whole tree/script list, uninspected" });
    expect(targets.some((t) => t.kind === "file" && t.path === "Run")).toBe(false);
  });

  test("bun test <file> still extracts the real file target (narrowness preserved)", () => {
    expect(extractRunnerFileTargets("bun test ./a.test.ts")).toEqual([{ kind: "file", path: "./a.test.ts" }]);
  });
});

describe("classifyFileExecutionRisk — end-to-end against the review's regression shapes", () => {
  function mkWorkspace(): string {
    return mkdtempSync(join(tmpdir(), "veto-unit-workspace-"));
  }

  test("a file containing `await $`x; rm -rf ~`;` run via bun test is NOT approved", async () => {
    const workspace = mkWorkspace();
    const file = join(workspace, "evil.test.ts");
    writeFileSync(file, "await $`x; rm -rf ~`;\n");
    const verdict = await classifyFileExecutionRisk({ request: `bun test ${file}`, cwd: workspace });
    expect(verdict.approve).toBe(false);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("a file containing exec(\"rm -rf $HOME\") run via node is NOT approved", async () => {
    const workspace = mkWorkspace();
    const file = join(workspace, "evil.js");
    writeFileSync(file, 'exec("rm -rf $HOME");\n');
    const verdict = await classifyFileExecutionRisk({ request: `node ${file}`, cwd: workspace });
    expect(verdict.approve).toBe(false);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("a compound command's SECOND file target is caught even though the first is benign", async () => {
    const workspace = mkWorkspace();
    writeFileSync(join(workspace, "ok.sh"), "echo fine\n");
    writeFileSync(join(workspace, "evil.sh"), "rm -rf ~\n");
    const verdict = await classifyFileExecutionRisk({ request: "sh ok.sh; sh evil.sh", cwd: workspace });
    expect(verdict.approve).toBe(false);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("bare `bun test` (whole tree, no file argument) is never approved", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({ request: "bun test", cwd: workspace });
    expect(verdict.approve).toBe(false);
    rmSync(workspace, { recursive: true, force: true });
  });
});
