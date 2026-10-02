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

describe("extractRunnerFileTargets — FACTORY-640 (round 2 of FACTORY-636's review): bare bun test/run has no target, no false ENOENT veto", () => {
  test("bun test with no file argument at all reports no target", () => {
    expect(extractRunnerFileTargets("bun test")).toEqual([]);
  });

  test("bun test with only flags (no file) still reports no target", () => {
    expect(extractRunnerFileTargets("bun test --watch")).toEqual([]);
  });

  test("bun run <script> with no file argument reports no target", () => {
    expect(extractRunnerFileTargets("bun run typecheck")).toEqual([]);
  });

  test("the review's exact repro: a multi-line description must not be read as the file argument", () => {
    // Previously: the whole multi-line command was regexed with `\s+`
    // (which matches `\n`), so "Run" (from the second line) was captured as
    // the file target. Per-segment extraction means this command's first
    // segment is just "bun test" with nothing after it on that line.
    const targets = extractRunnerFileTargets("bun test\nRun the new test");
    expect(targets.some((t) => t.kind === "file" && t.path === "Run")).toBe(false);
  });

  test("bun test <file> still extracts the real file target (narrowness preserved)", () => {
    expect(extractRunnerFileTargets("bun test ./a.test.ts")).toEqual([{ kind: "file", path: "./a.test.ts" }]);
  });
});

describe("extractRunnerFileTargets — FACTORY-640: flag tokens are no longer misread as file targets", () => {
  test("node --version has no target", () => {
    expect(extractRunnerFileTargets("node --version")).toEqual([]);
  });

  test("node -v has no target", () => {
    expect(extractRunnerFileTargets("node -v")).toEqual([]);
  });

  test("python3 --version has no target", () => {
    expect(extractRunnerFileTargets("python3 --version")).toEqual([]);
  });

  test("python3 -m pytest has no target (pytest is a module name, not a file)", () => {
    expect(extractRunnerFileTargets("python3 -m pytest")).toEqual([]);
  });

  test("bash -l deploy.sh still extracts deploy.sh, skipping the -l flag", () => {
    expect(extractRunnerFileTargets("bash -l deploy.sh")).toEqual([{ kind: "file", path: "deploy.sh" }]);
  });

  test("node script.js still extracts the real file target", () => {
    expect(extractRunnerFileTargets("node script.js")).toEqual([{ kind: "file", path: "script.js" }]);
  });
});

describe("extractRunnerFileTargets — FACTORY-640: node -e/-p/--eval and python -c report no file target (routed to inline-body inspection instead)", () => {
  test("node -e reports no file target", () => {
    expect(extractRunnerFileTargets('node -e "console.log(1)"')).toEqual([]);
  });

  test("node --eval reports no file target", () => {
    expect(extractRunnerFileTargets('node --eval "console.log(1)"')).toEqual([]);
  });

  test("node -p reports no file target", () => {
    expect(extractRunnerFileTargets('node -p "1+1"')).toEqual([]);
  });

  test("python -c reports no file target", () => {
    expect(extractRunnerFileTargets('python -c "print(1)"')).toEqual([]);
  });

  test("python3 -c reports no file target", () => {
    expect(extractRunnerFileTargets('python3 -c "print(1)"')).toEqual([]);
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

  test("bare `bun test` (whole tree, no file argument) is approved — FACTORY-640 reverses the prior fail-closed call", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({ request: "bun test", cwd: workspace });
    expect(verdict.approve).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });
});

describe("classifyFileExecutionRisk — FACTORY-640: bare bun test/run approved, flag-token false vetoes fixed", () => {
  function mkWorkspace(): string {
    return mkdtempSync(join(tmpdir(), "veto-unit-workspace-"));
  }

  test("bun test --coverage is approved", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({ request: "bun test --coverage", cwd: workspace });
    expect(verdict.approve).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("bun run typecheck is approved", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({ request: "bun run typecheck", cwd: workspace });
    expect(verdict.approve).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("node --version is approved, not vetoed as an unreadable file target", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({ request: "node --version", cwd: workspace });
    expect(verdict.approve).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("node -v is approved", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({ request: "node -v", cwd: workspace });
    expect(verdict.approve).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("python3 --version is approved", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({ request: "python3 --version", cwd: workspace });
    expect(verdict.approve).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("python3 -m pytest is approved, not vetoed on 'pytest' as a bogus file target", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({ request: "python3 -m pytest", cwd: workspace });
    expect(verdict.approve).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("bash -l deploy.sh still inspects deploy.sh and vetoes it when destructive", async () => {
    const workspace = mkWorkspace();
    writeFileSync(join(workspace, "deploy.sh"), "rm -rf ~\n");
    const verdict = await classifyFileExecutionRisk({ request: "bash -l deploy.sh", cwd: workspace });
    expect(verdict.approve).toBe(false);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("bash -l deploy.sh is approved when deploy.sh is benign", async () => {
    const workspace = mkWorkspace();
    writeFileSync(join(workspace, "deploy.sh"), "echo deploying\n");
    const verdict = await classifyFileExecutionRisk({ request: "bash -l deploy.sh", cwd: workspace });
    expect(verdict.approve).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });
});

describe("classifyFileExecutionRisk — FACTORY-640: node -e/python -c inline bodies routed to inline-body inspection, vetoed for that reason specifically", () => {
  function mkWorkspace(): string {
    return mkdtempSync(join(tmpdir(), "veto-unit-workspace-"));
  }

  test("node -e with a destructive inline body is vetoed FOR THE INLINE-BODY REASON, not approved by accident", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({
      request: `node -e "require('child_process').execSync('rm -rf $HOME')"`,
      cwd: workspace,
    });
    expect(verdict.approve).toBe(false);
    if (!verdict.approve) {
      expect(verdict.reason).toMatch(/inline script body/);
      expect(verdict.pattern).toBe("rm -rf against $HOME/root/wildcard");
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  test("python -c with a destructive inline body is vetoed FOR THE INLINE-BODY REASON", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({
      request: `python3 -c "import os; os.system('rm -rf $HOME')"`,
      cwd: workspace,
    });
    expect(verdict.approve).toBe(false);
    if (!verdict.approve) {
      expect(verdict.reason).toMatch(/inline script body/);
      expect(verdict.pattern).toBe("rm -rf against $HOME/root/wildcard");
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  test("a benign node -e body is still approved", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({ request: `node -e "console.log('hello')"`, cwd: workspace });
    expect(verdict.approve).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("a benign python -c body is still approved", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({ request: `python3 -c "print('hello')"`, cwd: workspace });
    expect(verdict.approve).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("dynamic fail-closed is preserved for a genuinely unknowable target like xargs sh", async () => {
    const workspace = mkWorkspace();
    const verdict = await classifyFileExecutionRisk({ request: "find . -name '*.sh' | xargs sh", cwd: workspace });
    expect(verdict.approve).toBe(false);
    rmSync(workspace, { recursive: true, force: true });
  });
});
