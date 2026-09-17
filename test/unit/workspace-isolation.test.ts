import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { workspaceRoot } from "../../src/agents/workspace.js";
import { testWorkspaceRoot } from "../setup/isolated-workspaces.js";

const realDefault = join(homedir(), "butchr-workspaces");
const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

// Regression guard: unit tests once wrote into the real ~/butchr-workspaces
// whenever BUTCHR_WORKSPACES was unset. The test preload must keep every
// test on a temp root and put it back after a test clobbers it.
describe("test workspace isolation", () => {
  // Captured at load time, like the describe-scope `workspaceRoot()` calls in herd tests.
  const loadTimeRoot = workspaceRoot();

  test("the preload is wired into bunfig.toml", () => {
    expect(readFileSync(join(import.meta.dir, "../../bunfig.toml"), "utf8")).toContain('preload = ["./test/setup/isolated-workspaces.ts"]');
  });

  test("workspaceRoot() is the test temp root, at load time and in a test, never the real default", () => {
    expect(loadTimeRoot).toBe(testWorkspaceRoot);
    expect(workspaceRoot()).toBe(testWorkspaceRoot);
    expect(testWorkspaceRoot).not.toBe(realDefault);
    expect(inside(testWorkspaceRoot, tmpdir())).toBe(true);
    delete process.env.BUTCHR_WORKSPACES;
  });

  test("a test that deleted BUTCHR_WORKSPACES does not leak the default into the next test", () => {
    expect(process.env.BUTCHR_WORKSPACES).toBe(testWorkspaceRoot);
    process.env.BUTCHR_WORKSPACES = realDefault;
  });

  test("a test that pointed BUTCHR_WORKSPACES at the real default is restored afterwards", () => {
    expect(workspaceRoot()).toBe(testWorkspaceRoot);
  });
});
