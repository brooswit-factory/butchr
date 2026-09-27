import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import { claudeProjectSlug, newLayoutDirFor, readBookkeptAgentKey, workspaceDirFor, writeBookkeptAgentKey } from "../../src/agents/workspace.js";
import {
  migrateClaudeProjectSlug,
  migrateClaudeSettingsEntry,
  migrateWorkspaceLayout,
  repairGitWorktrees,
  reverseMigrateWorkspaceLayout,
} from "../../src/agents/workspace-migration.js";

// Every test below passes its OWN explicit root/home/claudeJsonPath — never
// the real ~/.claude or ~/.claude.json (FACTORY-118's own requirement). Each
// helper registers its temp dir for cleanup so a thrown assertion never
// leaks one test's fixtures into the next.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function claudeSlugDir(home: string, cwd: string): string {
  return join(home, ".claude", "projects", claudeProjectSlug(cwd));
}

function writeTranscript(home: string, cwd: string, name: string, content: string): string {
  const dir = claudeSlugDir(home, cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
  return dir;
}

/** A pre-FACTORY-118 old-layout workspace dir for `key`, exactly as `migrateWorkspaceLayout` computes it: `<root>/<provider>/<ruleId>/<resourceId>`. */
function oldDirFor(root: string, key: string): string {
  return join(root, ...key.split(":"));
}

/** Populates a workspace dir with the bookkeeping files FACTORY-118's own ticket names, so a migration test proves they travel for free via the atomic rename. */
function populate(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), "claude-md-content");
  writeFileSync(join(dir, "brief.md"), "brief-content");
  writeFileSync(join(dir, "mcp.json"), "{}");
  writeFileSync(join(dir, "ENVIRONMENT.md"), "env-content");
  writeFileSync(join(dir, ".butchr-permission-mode.json"), '"default"');
}

const KEY = (resourceId: string, ruleId = "triage") => encodeAgentKey({ resourceProvider: "jira-work", ruleId, resourceId });

describe("claudeProjectSlug — pinned to drovr's own algorithm", () => {
  test("exact literal pin: every non-alphanumeric character becomes '-'", () => {
    // Hand-computed, not derived via the same formula under test, so a shared bug in both sides can't hide.
    expect(claudeProjectSlug("/home/user/proj.name_2")).toBe("-home-user-proj-name-2");
  });

  test("matches drovr's native-transcript.ts formula for '.', '_', '%', '~', and non-ASCII characters", () => {
    // Same regex drovr's src/native-transcript.ts uses at both its own call sites
    // (resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-")) — verified by reading that file directly.
    const drovrFormula = (cwd: string) => resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    for (const p of ["/a/b.c_d%e~f/g", "/home/brooswit/日本語/résumé", "/a/~b/%2Fc"]) {
      expect(claudeProjectSlug(p)).toBe(drovrFormula(p));
    }
  });

  test("resolves a relative-looking path before slugging, same as drovr's resolve(cwd)", () => {
    expect(claudeProjectSlug("relative/dir")).toBe(resolve("relative/dir").replace(/[^a-zA-Z0-9]/g, "-"));
  });
});

describe("migrateClaudeProjectSlug", () => {
  test("moves an existing slug dir to the new cwd's slug location", () => {
    const home = tempDir("butchr-slug-home-");
    const oldCwd = tempDir("butchr-old-cwd-");
    const newCwd = tempDir("butchr-new-cwd-");
    writeTranscript(home, oldCwd, "t.jsonl", "codeword-1");

    const result = migrateClaudeProjectSlug(oldCwd, newCwd, home);
    expect(result.outcome).toBe("moved");
    expect(existsSync(claudeSlugDir(home, oldCwd))).toBe(false);
    expect(readFileSync(join(claudeSlugDir(home, newCwd), "t.jsonl"), "utf8")).toBe("codeword-1");
  });

  test("no old slug present: reports no-old-slug, not an error", () => {
    const home = tempDir("butchr-slug-home-");
    const oldCwd = tempDir("butchr-old-cwd-"); // never had a transcript
    const newCwd = tempDir("butchr-new-cwd-");
    const result = migrateClaudeProjectSlug(oldCwd, newCwd, home);
    expect(result).toEqual({ outcome: "no-old-slug", oldSlugDir: null, newSlugDir: claudeSlugDir(home, newCwd) });
  });

  test("same cwd resolved twice: already-migrated, touches nothing", () => {
    const home = tempDir("butchr-slug-home-");
    const cwd = tempDir("butchr-cwd-");
    writeTranscript(home, cwd, "t.jsonl", "x");
    const result = migrateClaudeProjectSlug(cwd, cwd, home);
    expect(result.outcome).toBe("already-migrated");
    expect(readFileSync(join(claudeSlugDir(home, cwd), "t.jsonl"), "utf8")).toBe("x");
  });

  test("never overwrites a non-empty target slug dir: refuses loudly, leaves BOTH sides untouched", () => {
    const home = tempDir("butchr-slug-home-");
    const oldCwd = tempDir("butchr-old-cwd-");
    const newCwd = tempDir("butchr-new-cwd-");
    writeTranscript(home, oldCwd, "old.jsonl", "old-content");
    writeTranscript(home, newCwd, "new.jsonl", "new-content");

    expect(() => migrateClaudeProjectSlug(oldCwd, newCwd, home)).toThrow(/non-empty/);
    expect(readFileSync(join(claudeSlugDir(home, oldCwd), "old.jsonl"), "utf8")).toBe("old-content");
    expect(readFileSync(join(claudeSlugDir(home, newCwd), "new.jsonl"), "utf8")).toBe("new-content");
  });

  test("an EMPTY target slug dir (e.g. a fresh session already created after a restart) is safe to proceed through", () => {
    const home = tempDir("butchr-slug-home-");
    const oldCwd = tempDir("butchr-old-cwd-");
    const newCwd = tempDir("butchr-new-cwd-");
    writeTranscript(home, oldCwd, "old.jsonl", "old-content");
    mkdirSync(claudeSlugDir(home, newCwd), { recursive: true }); // present but empty — nothing to lose

    const result = migrateClaudeProjectSlug(oldCwd, newCwd, home);
    expect(result.outcome).toBe("moved");
    expect(readFileSync(join(claudeSlugDir(home, newCwd), "old.jsonl"), "utf8")).toBe("old-content");
  });

  test("idempotent (re-run after done is a no-op) and reversible (forward then reverse restores exactly)", () => {
    const home = tempDir("butchr-slug-home-");
    const oldCwd = tempDir("butchr-old-cwd-");
    const newCwd = tempDir("butchr-new-cwd-");
    writeTranscript(home, oldCwd, "t.jsonl", "codeword-roundtrip");

    expect(migrateClaudeProjectSlug(oldCwd, newCwd, home).outcome).toBe("moved");
    // idempotent: running again (same direction) after it already finished
    const again = migrateClaudeProjectSlug(oldCwd, newCwd, home);
    expect(again.outcome).toBe("no-old-slug");
    expect(readFileSync(join(claudeSlugDir(home, newCwd), "t.jsonl"), "utf8")).toBe("codeword-roundtrip");
    // reversible: swap the args back
    const reversed = migrateClaudeProjectSlug(newCwd, oldCwd, home);
    expect(reversed.outcome).toBe("moved");
    expect(readFileSync(join(claudeSlugDir(home, oldCwd), "t.jsonl"), "utf8")).toBe("codeword-roundtrip");
    expect(existsSync(claudeSlugDir(home, newCwd))).toBe(false);
  });

  test("long-path truncation fallback: locates a real Claude-Code-shaped truncated+suffixed slug dir that claudeProjectSlug alone cannot reproduce, by prefix match", () => {
    const home = tempDir("butchr-slug-home-");
    const oldCwd = "/" + "a".repeat(60) + "/" + "b".repeat(60) + "/" + "c".repeat(60) + "/" + "d".repeat(60);
    const fullSlug = claudeProjectSlug(oldCwd);
    expect(fullSlug.length).toBeGreaterThan(200);
    // The empirically-observed real Claude Code shape (docs/workspace-layout.md): first 200 chars + "-" + a 6-char suffix.
    const truncatedName = `${fullSlug.slice(0, 200)}-abc123`;
    const projectsDir = join(home, ".claude", "projects");
    mkdirSync(join(projectsDir, truncatedName), { recursive: true });
    writeFileSync(join(projectsDir, truncatedName, "session.jsonl"), '{"marker":"codeword-long"}\n');

    const newCwd = tempDir("butchr-slug-newcwd-");
    const result = migrateClaudeProjectSlug(oldCwd, newCwd, home);
    expect(result.outcome).toBe("moved");
    expect(existsSync(join(projectsDir, truncatedName))).toBe(false);
    expect(readFileSync(join(claudeSlugDir(home, newCwd), "session.jsonl"), "utf8")).toContain("codeword-long");
  });

  test("a slug shorter than the truncation length never matches a same-prefix directory it did not itself produce", () => {
    const home = tempDir("butchr-slug-home-");
    const oldCwd = tempDir("butchr-short-cwd-");
    const projectsDir = join(home, ".claude", "projects");
    // A directory that merely starts with this short slug's name plus "-something" must NOT be
    // mistaken for it — the prefix-match fallback only ever applies past the truncation length.
    mkdirSync(join(projectsDir, `${claudeProjectSlug(oldCwd)}-unrelated-suffix`), { recursive: true });
    const result = migrateClaudeProjectSlug(oldCwd, tempDir("butchr-newcwd-"), home);
    expect(result.outcome).toBe("no-old-slug");
  });
});

describe("migrateWorkspaceLayout / reverseMigrateWorkspaceLayout", () => {
  test("migrates an old-layout workspace to its short-name directory, carrying bookkeeping files for free, stamping it, and moving the Claude slug together", () => {
    const root = tempDir("butchr-root-");
    const home = tempDir("butchr-home-");
    const key = KEY("FACTORY-1");
    const oldDir = oldDirFor(root, key);
    populate(oldDir);
    writeTranscript(home, oldDir, "t.jsonl", "codeword-abc");

    const result = migrateWorkspaceLayout(key, root, home);
    expect(result.outcome).toBe("migrated");
    expect(result.oldDir).toBe(oldDir);
    expect(existsSync(oldDir)).toBe(false);
    expect(readFileSync(join(result.newDir, "CLAUDE.md"), "utf8")).toBe("claude-md-content");
    expect(readFileSync(join(result.newDir, "brief.md"), "utf8")).toBe("brief-content");
    expect(readFileSync(join(result.newDir, ".butchr-permission-mode.json"), "utf8")).toBe('"default"');
    expect(readBookkeptAgentKey(result.newDir)).toBe(key);
    expect(result.repairedWorktrees).toEqual([]);
    expect(result.slug.outcome).toBe("moved");
    expect(readFileSync(join(claudeSlugDir(home, result.newDir), "t.jsonl"), "utf8")).toBe("codeword-abc");
    // and workspaceDirFor now agrees this is where the key lives:
    expect(workspaceDirFor(key, root)).toBe(result.newDir);
  });

  test("neither old nor new dir exists: no-legacy-workspace, touches nothing", () => {
    const root = tempDir("butchr-root-");
    const home = tempDir("butchr-home-");
    const key = KEY("FACTORY-2");
    const result = migrateWorkspaceLayout(key, root, home);
    expect(result.outcome).toBe("no-legacy-workspace");
    expect(result.oldDir).toBeNull();
    expect(existsSync(result.newDir)).toBe(false);
  });

  test("throws for a non-rule-engine (legacy bare) key — nothing for this migration to act on", () => {
    const root = tempDir("butchr-root-");
    const home = tempDir("butchr-home-");
    expect(() => migrateWorkspaceLayout("FACTORY-1", root, home)).toThrow(/not a rule-engine agent key/);
    expect(() => reverseMigrateWorkspaceLayout("FACTORY-1", root, home)).toThrow(/not a rule-engine agent key/);
  });

  test("never overwrites a non-empty target workspace dir: refuses loudly, BOTH sides untouched", () => {
    const root = tempDir("butchr-root-");
    const home = tempDir("butchr-home-");
    const key = KEY("FACTORY-3");
    const oldDir = oldDirFor(root, key);
    populate(oldDir);
    const newDir = newLayoutDirFor(key, root);
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "unrelated.txt"), "someone else's stuff");

    expect(() => migrateWorkspaceLayout(key, root, home)).toThrow(/non-empty/);
    expect(existsSync(oldDir)).toBe(true);
    expect(readFileSync(join(oldDir, "CLAUDE.md"), "utf8")).toBe("claude-md-content");
    expect(readFileSync(join(newDir, "unrelated.txt"), "utf8")).toBe("someone else's stuff");
  });

  test("an EMPTY new-layout target (already claimed by ensureWorkspaceDir but nothing written into it yet) is safe to proceed through", () => {
    const root = tempDir("butchr-root-");
    const home = tempDir("butchr-home-");
    const key = KEY("FACTORY-4");
    const oldDir = oldDirFor(root, key);
    populate(oldDir);
    const newDir = newLayoutDirFor(key, root);
    mkdirSync(newDir, { recursive: true }); // claimed, empty

    const result = migrateWorkspaceLayout(key, root, home);
    expect(result.outcome).toBe("migrated");
    expect(readFileSync(join(newDir, "CLAUDE.md"), "utf8")).toBe("claude-md-content");
  });

  test("idempotent: running again after a completed migration is a no-op — no error, no further change", () => {
    const root = tempDir("butchr-root-");
    const home = tempDir("butchr-home-");
    const key = KEY("FACTORY-5");
    const oldDir = oldDirFor(root, key);
    populate(oldDir);
    writeTranscript(home, oldDir, "t.jsonl", "codeword");

    const first = migrateWorkspaceLayout(key, root, home);
    const second = migrateWorkspaceLayout(key, root, home);
    expect(second.outcome).toBe("already-migrated");
    expect(second.oldDir).toBeNull();
    expect(second.slug.outcome).toBe("no-old-slug");
    expect(readFileSync(join(first.newDir, "CLAUDE.md"), "utf8")).toBe("claude-md-content");
    expect(readBookkeptAgentKey(first.newDir)).toBe(key);
  });

  test("partial-failure recovery: directory already renamed but not yet stamped (crash between the two) — re-running finishes the stamp instead of erroring or re-renaming", () => {
    const root = tempDir("butchr-root-");
    const home = tempDir("butchr-home-");
    const key = KEY("FACTORY-6");
    const newDir = newLayoutDirFor(key, root);
    populate(newDir); // simulate: the rename already happened; crash landed before the stamp write
    expect(readBookkeptAgentKey(newDir)).toBeNull();

    const result = migrateWorkspaceLayout(key, root, home);
    expect(result.outcome).toBe("already-migrated");
    expect(readBookkeptAgentKey(newDir)).toBe(key);
  });

  test("partial-failure ordering: the directory half completes even when the slug half then throws, and a corrected re-run finishes only the remaining slug move", () => {
    const root = tempDir("butchr-root-");
    const home = tempDir("butchr-home-");
    const key = KEY("FACTORY-7");
    const oldDir = oldDirFor(root, key);
    populate(oldDir);
    writeTranscript(home, oldDir, "t.jsonl", "codeword-partial");
    const newDir = newLayoutDirFor(key, root);
    // Force the slug half to refuse: something already occupies the destination slug dir.
    writeTranscript(home, newDir, "blocker.jsonl", "already-here");

    expect(() => migrateWorkspaceLayout(key, root, home)).toThrow(/non-empty/);
    // The DIRECTORY half already completed despite the thrown error — this is the ordering decision:
    expect(existsSync(oldDir)).toBe(false);
    expect(readFileSync(join(newDir, "CLAUDE.md"), "utf8")).toBe("claude-md-content");
    expect(readBookkeptAgentKey(newDir)).toBe(key);

    // Operator clears the blocker and re-runs: recovers cleanly, finishing only the remaining slug half.
    rmSync(claudeSlugDir(home, newDir), { recursive: true, force: true });
    const recovered = migrateWorkspaceLayout(key, root, home);
    expect(recovered.outcome).toBe("already-migrated");
    expect(recovered.slug.outcome).toBe("moved");
    expect(readFileSync(join(claudeSlugDir(home, newDir), "t.jsonl"), "utf8")).toBe("codeword-partial");
  });

  test("reversible: forward then reverse restores the original old-layout directory exactly, including removing the new-layout stamp", () => {
    const root = tempDir("butchr-root-");
    const home = tempDir("butchr-home-");
    const key = KEY("FACTORY-8");
    const oldDir = oldDirFor(root, key);
    populate(oldDir);
    writeTranscript(home, oldDir, "t.jsonl", "codeword-roundtrip");

    const forward = migrateWorkspaceLayout(key, root, home);
    const back = reverseMigrateWorkspaceLayout(key, root, home);

    expect(back.outcome).toBe("migrated");
    expect(existsSync(forward.newDir)).toBe(false);
    expect(existsSync(oldDir)).toBe(true);
    expect(readFileSync(join(oldDir, "CLAUDE.md"), "utf8")).toBe("claude-md-content");
    expect(readFileSync(join(oldDir, ".butchr-permission-mode.json"), "utf8")).toBe('"default"');
    expect(readBookkeptAgentKey(oldDir)).toBeNull(); // stamp explicitly removed — see this function's own doc comment
    expect(readFileSync(join(claudeSlugDir(home, oldDir), "t.jsonl"), "utf8")).toBe("codeword-roundtrip");
    expect(existsSync(claudeSlugDir(home, forward.newDir))).toBe(false);
    // workspaceDirFor now correctly reports the restored old location again — the round trip is real, not cosmetic.
    expect(workspaceDirFor(key, root)).toBe(oldDir);
  });

  test("reverse migration is idempotent and reports no-legacy-workspace when there is nothing to reverse", () => {
    const root = tempDir("butchr-root-");
    const home = tempDir("butchr-home-");
    const key = KEY("FACTORY-9");
    expect(reverseMigrateWorkspaceLayout(key, root, home).outcome).toBe("no-legacy-workspace");

    const oldDir = oldDirFor(root, key);
    populate(oldDir);
    migrateWorkspaceLayout(key, root, home);
    expect(reverseMigrateWorkspaceLayout(key, root, home).outcome).toBe("migrated");
    const again = reverseMigrateWorkspaceLayout(key, root, home); // idempotent
    expect(again.outcome).toBe("already-migrated");
    expect(readFileSync(join(oldDir, "CLAUDE.md"), "utf8")).toBe("claude-md-content");
  });

  test("reverse migration never overwrites a non-empty old-layout target", () => {
    const root = tempDir("butchr-root-");
    const home = tempDir("butchr-home-");
    const key = KEY("FACTORY-10");
    const newDir = newLayoutDirFor(key, root);
    populate(newDir);
    writeBookkeptAgentKey(newDir, key);
    const oldDir = oldDirFor(root, key);
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "someone-else.txt"), "already here");

    expect(() => reverseMigrateWorkspaceLayout(key, root, home)).toThrow(/non-empty/);
    expect(readBookkeptAgentKey(newDir)).toBe(key);
    expect(readFileSync(join(oldDir, "someone-else.txt"), "utf8")).toBe("already here");
  });
});

describe("git worktree repair across a rename", () => {
  test("an atomic directory rename breaks a worktree's absolute-path back-references; migrateWorkspaceLayout repairs them so git keeps working from the new location", () => {
    const root = tempDir("butchr-root-");
    const home = tempDir("butchr-home-");
    const key = KEY("FACTORY-11");
    const oldDir = oldDirFor(root, key);
    populate(oldDir);

    const canonical = tempDir("butchr-canonical-clone-");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git(canonical, "init", "-q", "-b", "main");
    git(canonical, "config", "user.email", "t@example.com");
    git(canonical, "config", "user.name", "t");
    writeFileSync(join(canonical, "README.md"), "hello");
    git(canonical, "add", "README.md");
    git(canonical, "commit", "-q", "-m", "init");

    // Worktree nested one level inside the workspace dir, per brief.md's own `worktree add "$PWD/<repo>"` convention.
    const worktreeDir = join(oldDir, "repo");
    git(canonical, "worktree", "add", worktreeDir, "-b", "FACTORY-11-branch", "main");
    expect(existsSync(join(worktreeDir, "README.md"))).toBe(true);

    const result = migrateWorkspaceLayout(key, root, home);
    expect(result.outcome).toBe("migrated");
    const newWorktreeDir = join(result.newDir, "repo");
    expect(result.repairedWorktrees).toEqual([newWorktreeDir]);

    // Real proof, not just "repair didn't throw": the worktree is USABLE from its new location...
    expect(git(newWorktreeDir, "status", "--short")).toBe("");
    writeFileSync(join(newWorktreeDir, "new-file.txt"), "content");
    git(newWorktreeDir, "add", "new-file.txt");
    git(newWorktreeDir, "commit", "-q", "-m", "post-migration commit");
    // ...AND the canonical clone's own back-reference was fixed, not just the worktree's forward one:
    const list = git(canonical, "worktree", "list");
    expect(list).toContain(newWorktreeDir);
    expect(list).not.toContain(worktreeDir);
  });

  test("repairGitWorktrees on a workspace with no worktrees at all is a safe no-op", () => {
    const dir = tempDir("butchr-no-worktree-");
    writeFileSync(join(dir, "CLAUDE.md"), "x");
    expect(repairGitWorktrees(dir)).toEqual([]);
  });
});

describe("migrateClaudeSettingsEntry — ~/.claude.json's own per-project trust/tool-approval state", () => {
  function fakeClaudeJson(dir: string, contents: Record<string, unknown>): string {
    const path = join(dir, ".claude.json");
    writeFileSync(path, JSON.stringify(contents));
    return path;
  }

  test("moves the projects[oldCwd] entry to projects[newCwd]", () => {
    const dir = tempDir("butchr-claude-json-");
    const oldCwd = "/old/workspace/path";
    const newCwd = "/new/workspace/path";
    const path = fakeClaudeJson(dir, {
      numStartups: 5,
      projects: { [oldCwd]: { hasTrustDialogAccepted: true, allowedTools: ["Bash"] }, "/other/untouched": { hasTrustDialogAccepted: false } },
    });

    const result = migrateClaudeSettingsEntry(oldCwd, newCwd, path);
    expect(result.outcome).toBe("moved");
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.projects[oldCwd]).toBeUndefined();
    expect(after.projects[newCwd]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ["Bash"] });
    // Untouched sibling entries and unrelated top-level fields survive the round trip.
    expect(after.projects["/other/untouched"]).toEqual({ hasTrustDialogAccepted: false });
    expect(after.numStartups).toBe(5);
  });

  test("no old entry present: no-old-entry, file untouched", () => {
    const dir = tempDir("butchr-claude-json-");
    const path = fakeClaudeJson(dir, { projects: { "/unrelated": {} } });
    const before = readFileSync(path, "utf8");
    const result = migrateClaudeSettingsEntry("/old/nowhere", "/new/nowhere", path);
    expect(result.outcome).toBe("no-old-entry");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("missing ~/.claude.json entirely: no-old-entry, never created as a side effect", () => {
    const dir = tempDir("butchr-claude-json-");
    const path = join(dir, ".claude.json"); // never written
    const result = migrateClaudeSettingsEntry("/old", "/new", path);
    expect(result.outcome).toBe("no-old-entry");
    expect(existsSync(path)).toBe(false);
  });

  test("never overwrites a non-empty target entry: refuses loudly, file left byte-for-byte untouched", () => {
    const dir = tempDir("butchr-claude-json-");
    const oldCwd = "/old/workspace/path";
    const newCwd = "/new/workspace/path";
    const path = fakeClaudeJson(dir, {
      projects: { [oldCwd]: { hasTrustDialogAccepted: true }, [newCwd]: { hasTrustDialogAccepted: false, allowedTools: ["Read"] } },
    });
    const before = readFileSync(path, "utf8");
    expect(() => migrateClaudeSettingsEntry(oldCwd, newCwd, path)).toThrow(/non-empty/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("an EMPTY target entry ({}) is safe to proceed through", () => {
    const dir = tempDir("butchr-claude-json-");
    const oldCwd = "/old/workspace/path";
    const newCwd = "/new/workspace/path";
    const path = fakeClaudeJson(dir, { projects: { [oldCwd]: { hasTrustDialogAccepted: true }, [newCwd]: {} } });
    const result = migrateClaudeSettingsEntry(oldCwd, newCwd, path);
    expect(result.outcome).toBe("moved");
    expect(JSON.parse(readFileSync(path, "utf8")).projects[newCwd]).toEqual({ hasTrustDialogAccepted: true });
  });

  test("idempotent and reversible: forward then forward-again is a no-op, forward then reverse restores exactly", () => {
    const dir = tempDir("butchr-claude-json-");
    const oldCwd = "/old/workspace/path";
    const newCwd = "/new/workspace/path";
    const path = fakeClaudeJson(dir, { projects: { [oldCwd]: { hasTrustDialogAccepted: true, allowedTools: ["Bash", "Read"] } } });

    expect(migrateClaudeSettingsEntry(oldCwd, newCwd, path).outcome).toBe("moved");
    expect(migrateClaudeSettingsEntry(oldCwd, newCwd, path).outcome).toBe("no-old-entry"); // idempotent

    const reversed = migrateClaudeSettingsEntry(newCwd, oldCwd, path);
    expect(reversed.outcome).toBe("moved");
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.projects[oldCwd]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ["Bash", "Read"] });
    expect(after.projects[newCwd]).toBeUndefined();
  });
});
