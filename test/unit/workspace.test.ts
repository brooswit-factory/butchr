import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, rmSync, writeFileSync, statSync, chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { briefFor, interpolate, modelFor, effortFor, assertNoInheritedMcpConfig, buildWorkspace, agentIdOfWorkspacePath, ensureWorkspaceDir, isValidLeaf, newLayoutDirFor, readBookkeptAgentKey, writeBookkeptAgentKey, FILESYSTEM_TOOLS_NOTE, MANAGED_SESSION_TOOLS_NOTE, mcpIdentityHeaders, resolveAccountHeader, resolveMcpServerHeaders, resourceKeyOf, ruleAgentIdOfWorkspacePath, singleResourceOf, workspaceDirFor, workspaceMcpServers, workspacePermissionMode, workspaceStrictMcpConfig, workspaceLizardMode, workspaceModel, workspaceEffort, workspaceSessionId, discoverClaudeSessionId, persistDiscoveredSessionId, invalidatePersistedSessionId, claudeTranscriptExists, workspaceRoot, type SpawnSpec } from "../../src/agents/workspace.js";
import { agentLaunchConfig } from "../../src/agents/argv.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";
import { MAX_ENCODED_SEGMENT_BYTES } from "../../src/resources/filesystem-ref.js";
import { absPath } from "../helpers/abs-path";

// FACTORY-118 review round 1: A2/A3/A4/A6 each need a test that PINS the
// addendum's own claim directly, not just incidentally exercised as a side
// effect of some other test's setup — reviewed-in gap, fixed here.
describe("FACTORY-118 Addenda A2/A3/A4/A6: leaf validation, sticky naming, slug collisions, untrusted stamps", () => {
  test("Addendum A2: a hostile short id falls back to the legacy encoded leaf, never an unsafe path segment", () => {
    // Every non-empty, single-char-or-longer, slash-free, NUL-free string at
    // or under the byte limit is valid — isValidLeaf's own permissive half.
    expect(isValidLeaf("a")).toBe(true);
    expect(isValidLeaf(":")).toBe(true);
    expect(isValidLeaf("#42")).toBe(true);
    expect(isValidLeaf("日本語")).toBe(true);
    // Every hostile shape the addendum names, individually pinned — no real
    // provider is known to produce a NUL or a bare "."/".." short id (their
    // own resourceId-level validation forbids the inputs that would), but
    // isValidLeaf's OWN contract does not depend on one existing.
    expect(isValidLeaf("")).toBe(false);
    expect(isValidLeaf(".")).toBe(false);
    expect(isValidLeaf("..")).toBe(false);
    expect(isValidLeaf("a/b")).toBe(false);
    expect(isValidLeaf("/")).toBe(false);
    expect(isValidLeaf("a\0b")).toBe(false);
    expect(isValidLeaf("a".repeat(MAX_ENCODED_SEGMENT_BYTES))).toBe(true); // exactly at the limit
    expect(isValidLeaf("a".repeat(MAX_ENCODED_SEGMENT_BYTES + 1))).toBe(false); // one byte over

    // End to end, through a REAL provider that actually produces a hostile
    // short id: filesystemShortDisplayId("/") returns "/" itself (no
    // non-empty segments to name) — contains "/", so newLayoutDirFor must
    // fall back to the legacy percent-encoded leaf, never join() on it raw.
    // (The over-length case has no known real producer to reach end to end:
    // every current provider's short id is a substring/transform of its own
    // resourceId, which `isResourceId` already caps at the same encoded
    // byte limit before `encodeAgentKey` ever accepts it — the direct
    // `isValidLeaf` checks above are this shape's own real pin.)
    const rootLeafKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: "/" });
    expect(newLayoutDirFor(rootLeafKey, "/root")).toBe("/root/filesystem/repos/%2F");
  });

  test("Addendum A3: a leaf, once chosen, is STICKY — unaffected by a colliding key later appearing or disappearing, and survives a fresh process (no in-memory state)", () => {
    const root = mkdtempSync(join(tmpdir(), "butchr-sticky-"));
    try {
      // Two different real paths reducing to the same "<parent>:<name>" short id — the FACTORY-90 collision example.
      const first = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("home", "one", "acme", "rinth") });
      const second = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("srv", "two", "acme", "rinth") });

      const firstDirBeforeCollision = ensureWorkspaceDir(first, root);
      expect(firstDirBeforeCollision.endsWith("/acme:rinth")).toBe(true); // no collision yet — bare name

      const secondDir = ensureWorkspaceDir(second, root);
      expect(secondDir).not.toBe(firstDirBeforeCollision); // suffixed, not the same directory
      expect(secondDir.endsWith("/acme:rinth")).toBe(false);

      // The FIRST key's own assignment did not move just because a collision now exists.
      expect(newLayoutDirFor(first, root)).toBe(firstDirBeforeCollision);
      expect(ensureWorkspaceDir(first, root)).toBe(firstDirBeforeCollision);

      // Removing the second key's directory (its "disappearance") must not move the first either —
      // sticky means "chosen once", never "recomputed against whatever currently exists".
      rmSync(secondDir, { recursive: true, force: true });
      expect(newLayoutDirFor(first, root)).toBe(firstDirBeforeCollision);

      // "Survives a fresh process": nothing here is in-memory — a brand new
      // resolution, from nothing but the stamp already on disk, agrees.
      expect(readBookkeptAgentKey(firstDirBeforeCollision)).toBe(first);
      expect(newLayoutDirFor(first, root)).toBe(firstDirBeforeCollision);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Addendum A4: two different directory names whose Claude Code memory slugs would COLLIDE are disambiguated, even though the directory names themselves don't collide", () => {
    const root = mkdtempSync(join(tmpdir(), "butchr-slugcollide-"));
    try {
      // Short ids "p:a.b" and "p:a-b" — two DIFFERENT directory names (no
      // directory-name collision between them at all) that both slug to
      // "...-p-a-b" (every non-alphanumeric character becomes "-").
      const first = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("p", "a.b") });
      const second = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("p", "a-b") });

      const firstDir = ensureWorkspaceDir(first, root);
      expect(firstDir.endsWith("/p:a.b")).toBe(true); // no directory-NAME collision — claimed bare

      const secondDir = ensureWorkspaceDir(second, root);
      // Would otherwise ALSO claim its own bare "p:a-b" (still no directory-name
      // collision with "p:a.b") — disambiguated anyway, because its Claude Code
      // slug collides with the first directory's.
      expect(secondDir.endsWith("/p:a-b")).toBe(false);
      expect(secondDir).not.toBe(firstDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Addendum A6: an in-directory bookkeeping stamp is a HINT, never an authority — a stamp copied into a foreign directory, or left at the wrong leaf for its own key, is never trusted", () => {
    const root = mkdtempSync(join(tmpdir(), "butchr-untrusted-stamp-"));
    try {
      const realKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("home", "one", "acme", "rinth") });
      const realDir = ensureWorkspaceDir(realKey, root);
      expect(readBookkeptAgentKey(realDir)).toBe(realKey);
      expect(agentIdOfWorkspacePath(realDir, root)).toBe(realKey);

      // Copy the real stamp into an unrelated, foreign directory under the SAME rule.
      const foreignDir = join(root, "filesystem", "repos", "totally-unrelated-name");
      mkdirSync(foreignDir, { recursive: true });
      writeBookkeptAgentKey(foreignDir, realKey);
      // The foreign directory must NEVER resolve to the real key via its copied stamp...
      expect(agentIdOfWorkspacePath(foreignDir, root)).not.toBe(realKey);
      // ...and the REAL directory must keep resolving correctly — a foreign copy never hijacks it.
      expect(agentIdOfWorkspacePath(realDir, root)).toBe(realKey);

      // Delete the real stamp: the workspace degrades to unrecognised (never
      // mis-attributed to another key, never a duplicate spawn) — segment
      // decode also fails here since the leaf is the short id, not the
      // legacy percent-encoded form.
      unlinkSync(join(realDir, ".butchr-agent-key.json"));
      expect(agentIdOfWorkspacePath(realDir, root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// FACTORY-570: on win32 a managed-session definition's resourceId is a
// backslash-separated, drive-lettered Windows path
// (`C:\Users\broos\...\codex-test.json`) — `managedSessionShortDisplayId`
// (src/rules/session-definition-type.ts) looks for the LAST `/` to find the
// bare definition name, finds none, and returns almost the whole raw path as
// its "short id". Before this ticket, `isValidLeaf` accepted that string
// verbatim (it only ever rejected `/`, never `:`/`\`), so it was joined
// straight onto the workspace root — exactly the shape of butchr's own
// reported failure: `ENOENT: no such file or directory, mkdir
// 'C:\Users\broos\butchr-workspaces\filesystem\managed-sessions\C:\Users\broos\...'`.
// `platform` is always injected here (never left at the suite's real
// `process.platform`) so every case below runs, and proves the SAME thing,
// on any CI host — including the `windows` job, where the injected value and
// the real one now agree.
describe("FACTORY-570: Windows filesystem resourceIds get a flat, valid workspace leaf — never the raw drive path", () => {
  const WIN_ROOT = "C:\\Users\\broos\\butchr-workspaces";
  const WIN_RESOURCE_ID = "C:\\Users\\broos\\butchr\\config\\session-definitions\\codex-test.json";

  test("isValidLeaf: `:` and `\\` are rejected on platform win32 (the hostile shape managedSessionShortDisplayId can produce for a Windows path), but stay valid on posix — Addendum A2's own permissive half, unchanged", () => {
    // Unchanged, default-platform (posix in this suite) behaviour — the
    // existing Addendum A2 pin above already covers `isValidLeaf(":")` at
    // the default, but restated here as the explicit contrast this ticket's
    // own fix depends on: same string, opposite verdict, platform-gated.
    expect(isValidLeaf(":", "linux")).toBe(true);
    expect(isValidLeaf(":", "win32")).toBe(false);
    expect(isValidLeaf("\\", "linux")).toBe(true);
    expect(isValidLeaf("\\", "win32")).toBe(false);
    expect(isValidLeaf(WIN_RESOURCE_ID, "win32")).toBe(false); // the exact hostile "short id" shape this ticket fixes
    expect(isValidLeaf("codex-test", "win32")).toBe(true); // an ordinary bare name is still fine on win32
  });

  test("newLayoutDirFor: a managed-session Windows resourceId falls back to the flat, fully percent-encoded legacy leaf — never the raw drive path with its `:`/`\\` intact", () => {
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: WIN_RESOURCE_ID }, "win32");
    const dir = newLayoutDirFor(key, WIN_ROOT, "win32");
    const leaf = dir.split(/[\\/]/).pop()!; // last path segment, either separator (this host's real path.join picks one)
    expect(leaf).toBe(encodeURIComponent(WIN_RESOURCE_ID));
    expect(leaf.includes(":")).toBe(false);
    expect(leaf.includes("\\")).toBe(false);
    expect(leaf.includes("/")).toBe(false);
  });

  test("UNC ids get the same flat treatment as a drive-letter id", () => {
    const uncId = "\\\\server\\share\\defs\\x.json";
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: uncId }, "win32");
    const dir = newLayoutDirFor(key, WIN_ROOT, "win32");
    const leaf = dir.split(/[\\/]/).pop()!;
    expect(leaf).toBe(encodeURIComponent(uncId));
    expect(leaf.includes(":")).toBe(false);
    expect(leaf.includes("\\")).toBe(false);
  });

  test("round trip holds on win32: encode -> workspaceDirFor -> agentIdOfWorkspacePath decodes back to the exact original key, for a drive-letter id", () => {
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: WIN_RESOURCE_ID }, "win32");
    const dir = workspaceDirFor(key, WIN_ROOT, "win32");
    expect(agentIdOfWorkspacePath(dir, WIN_ROOT, "win32")).toBe(key);
  });

  test("round trip holds on win32 for a UNC id too", () => {
    const uncId = "\\\\server\\share\\defs\\x.json";
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: uncId }, "win32");
    const dir = workspaceDirFor(key, WIN_ROOT, "win32");
    expect(agentIdOfWorkspacePath(dir, WIN_ROOT, "win32")).toBe(key);
  });

  test("posix behaviour is byte-identical: a managed session still gets its short, bare definition name, never the flat encoded slug", () => {
    // `platform` (pinned to "linux" here, never this suite's real
    // `process.platform`) governs only the id/leaf VALIDITY logic
    // (isValidLeaf/candidateLeaf/isResourceId) — `node:path`'s `join` inside
    // `workspaceDirFor` itself always uses the REAL host's separator
    // (backslash on the `windows` CI job), so the leaf — the one thing this
    // ticket's fix actually changes — is asserted on its own, split on
    // either separator, rather than against one hardcoded full path.
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/home/brooswit/.config/butchr/session-definitions/admin-assembly.json" }, "linux");
    const dir = workspaceDirFor(key, "/root/butchr-workspaces", "linux");
    expect(dir.split(/[\\/]/).pop()).toBe("admin-assembly");
  });

  test("real mkdir + rmdir under a temp root: ensureWorkspaceDir actually creates the leaf this fix computes, and the created directory's own basename carries no `:`/`\\`/`/` — the assertion the windows CI job proves on real NTFS, since there `platform: win32` is also this run's real `process.platform`", () => {
    const root = mkdtempSync(join(tmpdir(), "butchr-570-mkdir-"));
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: WIN_RESOURCE_ID }, "win32");
      const dir = ensureWorkspaceDir(key, root, "win32");
      expect(existsSync(dir)).toBe(true);
      const basename = dir.split(/[\\/]/).pop()!;
      expect(basename.includes(":")).toBe(false);
      expect(basename.includes("\\")).toBe(false);
      expect(basename.includes("/")).toBe(false);
      expect(basename).toBe(encodeURIComponent(WIN_RESOURCE_ID));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("workspace identity", () => {
  test("AGY writes cwd bridge identity and AGENTS.md while retaining existing work", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "butchr-agy-workspace-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const spec = { key: "AGY-1", issuetype: "Task", summary: "bridge fixture", parent: null };
      const dir = buildWorkspace(spec, "http://localhost:7717/mcp", "agy");
      expect(dir).toBe(join(root, spec.key));
      expect(JSON.parse(readFileSync(join(dir, ".butchr-agy.json"), "utf8"))).toEqual({ issue: spec.key, mcpUrl: "http://localhost:7717/mcp" });
      expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("Read `brief.md`");
      expect(readFileSync(join(dir, "brief.md"), "utf8")).toContain(spec.key);
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(dir, "mcp.json"))).toBe(false);
      expect(existsSync(join(dir, "ENVIRONMENT.md"))).toBe(true);
      writeFileSync(join(dir, "progress.txt"), "keep this work");
      buildWorkspace(spec, "http://localhost:9000/mcp", "agy");
      expect(JSON.parse(readFileSync(join(dir, ".butchr-agy.json"), "utf8")).mcpUrl).toBe("http://localhost:9000/mcp");
      expect(readFileSync(join(dir, "progress.txt"), "utf8")).toBe("keep this work");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("derives identity only from a direct child of the configured workspace root", () => {
    const root = workspaceRoot();
    expect(agentIdOfWorkspacePath(join(root, "kan-42"))).toBe("KAN-42");
    expect(agentIdOfWorkspacePath(join(root, "nested", "KAN-42"))).toBeNull();
    expect(agentIdOfWorkspacePath(absPath("tmp", "KAN-42"))).toBeNull();
    expect(agentIdOfWorkspacePath(null)).toBeNull();
  });
  test("rule agent ids cover every provider and never a legacy workspace", () => {
    const root = absPath("w");
    expect(ruleAgentIdOfWorkspacePath(join(root, "jira-work", "build", "KAN-1"), root)).toBe("jira-work:build:KAN-1");
    expect(ruleAgentIdOfWorkspacePath(join(root, "github-issue", "triage", "acme%2Fweb%2342"), root)).toBe("github-issue:triage:acme%2Fweb%2342");
    expect(ruleAgentIdOfWorkspacePath(join(root, "jira-idea", "ideas", "IDEA-7"), root)).toBe("jira-idea:ideas:IDEA-7");
    expect(ruleAgentIdOfWorkspacePath(join(root, "zendesk-ticket", "support", "acme%2312"), root)).toBe("zendesk-ticket:support:acme%2312");
    expect(ruleAgentIdOfWorkspacePath(join(root, "kan-42"), root)).toBeNull();
    expect(ruleAgentIdOfWorkspacePath(join(root, "github-issue", "triage", "not-a-ref"), root)).toBeNull();
    expect(ruleAgentIdOfWorkspacePath(null, root)).toBeNull();
  });
  test("BUTCHR-397: a query-level agent's workspace round-trips through workspaceDirFor/agentIdOfWorkspacePath and sits as a SIBLING of that rule's per-resource ones, never their parent", () => {
    const root = absPath("w");
    const queryKey = encodeQueryAgentKey({ resourceProvider: "jira-work", ruleId: "triage" });
    const resourceKey = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-12" });
    const queryDir = workspaceDirFor(queryKey, root);
    const resourceDir = workspaceDirFor(resourceKey, root);
    expect(queryDir).toBe(join(root, "jira-work", "triage", "%40query"));
    // Same parent directory (the rule's own folder) — a sibling, not an ancestor: buildWorkspace()
    // would otherwise write the query agent's own files into the directory that holds every
    // per-resource agent's subdirectory for this rule.
    expect(join(queryDir, "..")).toBe(join(resourceDir, ".."));
    expect(queryDir).not.toBe(resourceDir);
    // Round-trips back to the exact same key, and is recognised as a rule-engine (not legacy) workspace.
    expect(agentIdOfWorkspacePath(queryDir, root)).toBe(queryKey);
    expect(ruleAgentIdOfWorkspacePath(queryDir, root)).toBe(queryKey);
    // Findable again after a "daemon restart" with nothing but the directory: agentIdOfWorkspacePath
    // takes only the path and root, no in-memory state, and this is the exact inverse of workspaceDirFor.
    expect(workspaceDirFor(agentIdOfWorkspacePath(queryDir, root)!, root)).toBe(queryDir);
  });

  test("BUTCHR-398 (review finding 1): singleResourceOf is null for a query-level id — a caller that needs a real single resource to write to (e.g. an escalation comment) must never fall back to the bogus whole key resourceKeyOf itself falls back to", () => {
    for (const resourceProvider of ["jira-work", "github-issue", "github-pr", "jira-idea", "zendesk-ticket"] as const) {
      const key = encodeQueryAgentKey({ resourceProvider, ruleId: "triage" });
      expect(singleResourceOf(key)).toBeNull();
      // Never equal to resourceKeyOf's own fallback (the bogus whole key) — this is the actual bug being closed.
      expect(resourceKeyOf(key)).toBe(key);
    }
  });
  test("BUTCHR-398: singleResourceOf is unchanged for a per-resource id, of any provider — same as resourceKeyOf", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-1" });
    expect(singleResourceOf(key)).toBe("BUTCHR-1");
    expect(singleResourceOf(key)).toBe(resourceKeyOf(key));
  });
  test("BUTCHR-398: mcpIdentityHeaders for a query-level spec sends x-butchr-agent alone, never x-issue, for every provider including jira-work", () => {
    for (const resourceProvider of ["jira-work", "github-issue", "github-pr", "jira-idea", "zendesk-ticket"] as const) {
      const key = encodeQueryAgentKey({ resourceProvider, ruleId: "triage" });
      const spec: SpawnSpec = { key, issuetype: "task", summary: "s", parent: null, brief: "b" };
      expect(mcpIdentityHeaders(spec)).toEqual({ "x-butchr-agent": key });
    }
  });

  test("BUTCHR-398: buildWorkspace for a query-level agy spec writes {agent, mcpUrl} only — no issue/resource field a real Jira/GitHub/Zendesk lookup could be keyed off", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "butchr-agy-query-workspace-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeQueryAgentKey({ resourceProvider: "jira-work", ruleId: "triage" });
      const spec: SpawnSpec = { key, issuetype: "task", summary: "triage (query agent)", parent: null, brief: "Handle the whole queue." };
      const dir = buildWorkspace(spec, "http://localhost:7717/mcp", "agy");
      expect(dir).toBe(workspaceDirFor(key, root));
      expect(JSON.parse(readFileSync(join(dir, ".butchr-agy.json"), "utf8"))).toEqual({ agent: key, mcpUrl: "http://localhost:7717/mcp" });
      // mcp.json (the Claude path) carries the same header shape.
      buildWorkspace(spec, "http://localhost:7717/mcp", "claude");
      expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.butchr.headers).toEqual({ "x-butchr-agent": key });
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("briefFor / modelFor", () => {
  test("models: epic=opus story=opus task=sonnet, default sonnet", () => {
    expect(modelFor("Epic")).toBe("opus");
    expect(modelFor("Story")).toBe("opus");
    expect(modelFor("Task")).toBe("sonnet");
    expect(modelFor("Whatever")).toBe("sonnet");
    // FACTORY-526: a `jira-project` rule with no explicit agentPreferences
    // model must not silently spawn Opus — `project` now falls to the same
    // sonnet default every other unrecognised issue type gets. It used to
    // get the epic tier (BUTCHR-71); that's now opt-in via agentPreferences.
    expect(modelFor("project")).toBe("sonnet");
  });
  test("effort: epic/story/task high, project low, unknown type defaults to high without throwing", () => {
    expect(effortFor("Epic")).toBe("high");
    expect(effortFor("Story")).toBe("high");
    expect(effortFor("Task")).toBe("high");
    // FACTORY-526: keep the missing-model default cheap on effort too.
    expect(effortFor("project")).toBe("low");
    expect(() => effortFor("Whatever")).not.toThrow();
    expect(effortFor("Whatever")).toBe("high");
    expect(effortFor("EPIC")).toBe("high");
    expect(effortFor("Story")).toBe("high");
  });

  test("bundled workflows use explicit targets and preserve review, hold and completion evidence", () => {
    for (const type of ["Epic", "Story", "Task", "Bug", "project", "unknown"]) {
      const brief = briefFor(type);
      for (const verb of ["jira_get_issue", "jira_add_comment", "jira_transition", "jira_create_issue", "jira_update_issue", "add_link"]) expect(brief).toContain(verb);
      expect(brief).toContain("Hierarchy and review assignments are process conventions, not tool permissions");
      expect(brief).toContain("Keep cancellations cancelled, freezes frozen");
      expect(brief).toContain("not proof that the requested behavior works");
      expect(brief).not.toMatch(/\b(new_worker|ask_boss|submit_to_boss|set_doc)\b/);
    }
  });
  test("author briefs retain current-head and last-decisive-review checks", () => {
    for (const type of ["Story", "Task"]) {
      const brief = briefFor(type);
      expect(brief).toContain("reviews[].commit.oid");
      expect(brief).toContain('select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")');
      expect(brief).toContain("] | last");
      expect(brief).toContain("base-merge");
      expect(brief).toContain("not sufficient");
    }
  });
});
describe("interpolate", () => {
  test("fills key, summary, type, parent; parent-less says so", () => {
    const out = interpolate("k={{KEY}} s={{SUMMARY}} t={{TYPE}} p={{PARENT}}", { key: "K-1", issuetype: "Task", summary: "do it", parent: "K-0" });
    expect(out).toBe("k=K-1 s=do it t=Task p=K-0");
    expect(interpolate("{{PARENT}}", { key: "K", issuetype: "Epic", summary: "s", parent: null })).toContain("top-level");
  });
});
describe("buildWorkspace", () => {
  // Reused across several managed-session fixtures below — one canonical filesystem resourceId.
  const ETC_DEFS_A_JSON = absPath("etc", "defs", "a.json");
  // Reused across several "never throws for a missing workspace dir" fixtures below.
  const DOES_NOT_EXIST = absPath("does", "not", "exist");

  test("writes CLAUDE.md, interpolated brief.md, and mcp.json with x-issue", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "Story", summary: "ship it", parent: "KAN-1" }, "http://x/mcp");
      expect(dir).toBe(join(root, "KAN-9"));
      expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("brief.md");
      const brief = readFileSync(join(dir, "brief.md"), "utf8");
      // BUTCHR-169: `parent` is now a TRUSTWORTHY value by the time it
      // reaches here — ISSUE_SPAWN_CONFIG.specFor (src/resources/issue.ts)
      // derives it from the ticket's Implements link, never Jira's native
      // `parent` field. buildWorkspace itself just renders whatever
      // SpawnSpec it's given, which is what this fixture pins.
      expect(brief).toContain("KAN-9"); expect(brief).toContain("ship it"); expect(brief).toContain("KAN-1");
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      expect(mcp.mcpServers.butchr.headers["x-issue"]).toBe("KAN-9");
      expect(mcp.mcpServers.butchr.url).toBe("http://x/mcp");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes ENVIRONMENT.md, and CLAUDE.md is interpolated with the same ground truth", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-10", issuetype: "Task", summary: "ship it", parent: "KAN-1" }, "http://localhost:7719/mcp");
      expect(existsSync(join(dir, "ENVIRONMENT.md"))).toBe(true);
      const environment = readFileSync(join(dir, "ENVIRONMENT.md"), "utf8");
      expect(environment).toContain(hostname());
      expect(environment).toContain("journalctl");
      expect(environment).toContain("7719");
      const claudeMd = readFileSync(join(dir, "CLAUDE.md"), "utf8");
      expect(claudeMd).toContain(hostname());
      expect(claudeMd).toContain("journalctl");
      expect(claudeMd).not.toContain("{{GROUND_TRUTH}}");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PR #394 review fix 2: spec.cwd does NOT redirect buildWorkspace — bookkeeping files always land in workspaceDirFor(spec.key), never in an operator's own working directory", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-root-"));
    const real = mkdtempSync(join(tmpdir(), "bw-real-cwd-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: ETC_DEFS_A_JSON });
      const spec: SpawnSpec = { key, issuetype: "managed-session", summary: "s", parent: null, brief: "b", cwd: real };
      const dir = buildWorkspace(spec, "http://x/mcp");
      expect(dir).toBe(workspaceDirFor(key, root));
      expect(dir).not.toBe(real);
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(dir, "brief.md"))).toBe(true);
      expect(existsSync(join(dir, "mcp.json"))).toBe(true);
      // The operator's own working directory is untouched — nothing was ever written there.
      expect(existsSync(join(real, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(real, "brief.md"))).toBe(false);
      expect(existsSync(join(real, "mcp.json"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  test("BUTCHR-456: a managed-session agent's brief gets MANAGED_SESSION_TOOLS_NOTE, never the generic FILESYSTEM_TOOLS_NOTE — a plain filesystem/BUTCHR-407 agent gets the reverse", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-tools-note-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const managedKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: ETC_DEFS_A_JSON });
      const managedSpec: SpawnSpec = { key: managedKey, issuetype: "managed-session", summary: "s", parent: null, brief: "Tend it." };
      const managedDir = buildWorkspace(managedSpec, "http://x/mcp");
      const managedBrief = readFileSync(join(managedDir, "brief.md"), "utf8");
      expect(managedBrief).toContain(MANAGED_SESSION_TOOLS_NOTE);
      expect(managedBrief).not.toContain(FILESYSTEM_TOOLS_NOTE);
      expect(managedBrief).toContain("freeze_session");

      const plainKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: absPath("repo", "a.md") });
      const plainSpec: SpawnSpec = { key: plainKey, issuetype: "filesystem", summary: "s", parent: null, brief: "Keep it current." };
      const plainDir = buildWorkspace(plainSpec, "http://x/mcp");
      const plainBrief = readFileSync(join(plainDir, "brief.md"), "utf8");
      expect(plainBrief).toContain(FILESYSTEM_TOOLS_NOTE);
      expect(plainBrief).not.toContain(MANAGED_SESSION_TOOLS_NOTE);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PR #394 review fix (round 3): agentLaunchConfig keeps the launched PROCESS at the bookkeeping dir even when spec.cwd is set — see SpawnSpec.cwd's own doc comment (Drovr's launch.cwd===workspace.cwd invariant) — while mcp config stays anchored there too, for both vendors", () => {
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: ETC_DEFS_A_JSON });
    const spec: SpawnSpec = { key, issuetype: "managed-session", summary: "s", parent: null, brief: "b", cwd: absPath("repo", "some-project") };
    const bookkeepingDir = absPath("butchr-workspaces", "filesystem", "managed-sessions", "%2Fetc%2Fdefs%2Fa.json");
    const claudeLaunch = agentLaunchConfig(spec, bookkeepingDir, "pane-1", "name", { provider: "claude" });
    expect(claudeLaunch.cwd).toBe(bookkeepingDir);
    expect(claudeLaunch.cwd).not.toBe(absPath("repo", "some-project"));
    expect((claudeLaunch as { mcpConfigPath: string }).mcpConfigPath).toBe(`${bookkeepingDir}/mcp.json`);
    const codexLaunch = agentLaunchConfig(spec, bookkeepingDir, "pane-1", "name", { provider: "codex" });
    expect(codexLaunch.cwd).toBe(bookkeepingDir);
    // No spec.cwd: byte-for-byte unchanged behaviour for every other spec.
    const noOverride: SpawnSpec = { key: "AGY-1", issuetype: "Task", summary: "s", parent: null };
    expect(agentLaunchConfig(noOverride, absPath("some", "dir"), "pane-1", "name", { provider: "claude" }).cwd).toBe(absPath("some", "dir"));
  });

  test("PR #394 review fix 2, end-to-end: a spawn through buildWorkspace + agentLaunchConfig never touches pre-existing CLAUDE.md/AGENTS.md/mcp.json in the operator's own working directory, for both vendors (round 3: the guarantee holds trivially now — butchr's process never even launches there)", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-root2-"));
    process.env.BUTCHR_WORKSPACES = root;
    const real = mkdtempSync(join(tmpdir(), "bw-real-project-"));
    const ownClaudeMd = "# This project's own instructions — do not touch.\n";
    const ownAgentsMd = "# This project's own AGENTS.md — do not touch.\n";
    const ownMcpJson = JSON.stringify({ mcpServers: { "some-other-server": { type: "http", url: "https://example.test" } } });
    writeFileSync(join(real, "CLAUDE.md"), ownClaudeMd);
    writeFileSync(join(real, "AGENTS.md"), ownAgentsMd);
    writeFileSync(join(real, "mcp.json"), ownMcpJson);
    try {
      for (const provider of ["claude", "codex"] as const) {
        const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: absPath("etc", "defs", `${provider}.json`) });
        const spec: SpawnSpec = { key, issuetype: "managed-session", summary: "s", parent: null, brief: "Do the work.", cwd: real };
        const dir = buildWorkspace(spec, "http://x/mcp", provider);
        const launch = agentLaunchConfig(spec, dir, "pane-1", "name", { provider });
        expect(launch.cwd).toBe(dir); // the process launches at the bookkeeping dir, not `real`
        expect(launch.cwd).not.toBe(real);
        expect(launch.prompt).toBe(""); // agentLaunchConfig itself never sets the kickoff — kickoffFor does, dispatched separately (herd.ts)
        // Byte-identical: the operator's own files were never opened for writing.
        expect(readFileSync(join(real, "CLAUDE.md"), "utf8")).toBe(ownClaudeMd);
        expect(readFileSync(join(real, "AGENTS.md"), "utf8")).toBe(ownAgentsMd);
        expect(readFileSync(join(real, "mcp.json"), "utf8")).toBe(ownMcpJson);
      }
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  test("BUTCHR-408 (McpServerBinding ported from S4): a bound server lands in mcp.json alongside butchr's own; headersEnvVar is resolved from THIS daemon's env, never persisted anywhere else", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-mcp-"));
    process.env.BUTCHR_WORKSPACES = root;
    const envBefore = process.env.MUD_BRIDGE_HEADERS;
    process.env.MUD_BRIDGE_HEADERS = JSON.stringify({ Authorization: "Bearer secret-token" });
    try {
      const mcpServers = [{ name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", headersEnvVar: "MUD_BRIDGE_HEADERS", channel: true }];
      const spec: SpawnSpec = { key: "KAN-9", issuetype: "Story", summary: "s", parent: "KAN-1", mcpServers };
      const dir = buildWorkspace(spec, "http://x/mcp");
      const mcpJsonPath = join(dir, "mcp.json");
      const mcp = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
      expect(mcp.mcpServers.butchr.url).toBe("http://x/mcp");
      expect(mcp.mcpServers["mud-bridge"]).toEqual({ type: "http", url: "https://mud.internal/mcp", headers: { Authorization: "Bearer secret-token" } });
      // A resolved secret header value makes mcp.json 0600. FACTORY-569: NTFS has no POSIX permission bits.
      if (process.platform !== "win32") {
        const mode = require("node:fs").statSync(mcpJsonPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
      // The persisted, staleness-check-only sidecar carries the binding's metadata (name/url/channel/headersEnvVar NAME) — never a resolved header value.
      const persisted = readFileSync(join(dir, ".butchr-mcp-servers.json"), "utf8");
      expect(persisted).not.toContain("secret-token");
      expect(JSON.parse(persisted)).toEqual(mcpServers);
      expect(workspaceMcpServers(dir)).toEqual(mcpServers);
    } finally {
      if (envBefore === undefined) delete process.env.MUD_BRIDGE_HEADERS; else process.env.MUD_BRIDGE_HEADERS = envBefore;
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-569: NTFS has no POSIX permission bits — nothing here to assert on win32.
  test.skipIf(process.platform === "win32")("mcp.json keeps its default permissions when no binding resolves a secret header", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-mcp-nosecret-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const mcpServers = [{ name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", channel: true }];
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "Story", summary: "s", parent: null, mcpServers }, "http://x/mcp");
      const mode = require("node:fs").statSync(join(dir, "mcp.json")).mode & 0o777;
      expect(mode).not.toBe(0o600);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspaceMcpServers is undefined for a workspace with no bound servers, never throws", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-mcp-none-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "Story", summary: "s", parent: null }, "http://x/mcp");
      expect(workspaceMcpServers(dir)).toBeUndefined();
      expect(workspaceMcpServers(DOES_NOT_EXIST)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-43: `permissionMode`/`strictMcpConfig` are persisted at build
  // time and read back the same way `mcpServers` is above — staleIssues()
  // (src/agents/herd.ts) previously had no way to recover either field,
  // which respawn-looped every managed session launched with a non-default
  // permission mode (or strictMcpConfig) forever.
  test("workspacePermissionMode/workspaceStrictMcpConfig round-trip what buildWorkspace persisted", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-permission-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "managed-session", summary: "s", parent: null, permissionMode: "auto", strictMcpConfig: true }, "http://x/mcp");
      expect(readFileSync(join(dir, ".butchr-permission-mode.json"), "utf8")).toBe(JSON.stringify("auto"));
      expect(readFileSync(join(dir, ".butchr-strict-mcp-config.json"), "utf8")).toBe(JSON.stringify(true));
      expect(workspacePermissionMode(dir)).toBe("auto");
      expect(workspaceStrictMcpConfig(dir)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspacePermissionMode/workspaceStrictMcpConfig are undefined for a workspace where neither was ever set, never throws", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-permission-none-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "Story", summary: "s", parent: null }, "http://x/mcp");
      expect(workspacePermissionMode(dir)).toBeUndefined();
      expect(workspaceStrictMcpConfig(dir)).toBeUndefined();
      expect(workspacePermissionMode(DOES_NOT_EXIST)).toBeUndefined();
      expect(workspaceStrictMcpConfig(DOES_NOT_EXIST)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-108: same persist-at-build/read-back shape as permissionMode/
  // strictMcpConfig above, for Codex's own lizard-mode launch signal —
  // without this, HerdrHerd.staleIssues() (src/agents/herd.ts) would have no
  // way to recover it either, which would respawn-loop every lizard Codex
  // agent forever (the exact FACTORY-43 bug, for this field).
  test("workspaceLizardMode round-trips what buildWorkspace persisted, independent of permissionMode/strictMcpConfig", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-lizard-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "managed-session", summary: "s", parent: null, lizardMode: true }, "http://x/mcp");
      expect(readFileSync(join(dir, ".butchr-lizard-mode.json"), "utf8")).toBe(JSON.stringify(true));
      expect(workspaceLizardMode(dir)).toBe(true);
      const falseDir = buildWorkspace({ key: "KAN-10", issuetype: "managed-session", summary: "s", parent: null, lizardMode: false }, "http://x/mcp");
      expect(readFileSync(join(falseDir, ".butchr-lizard-mode.json"), "utf8")).toBe(JSON.stringify(false));
      expect(workspaceLizardMode(falseDir)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspaceLizardMode is undefined for a workspace where it was never set, never throws", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-lizard-none-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "Story", summary: "s", parent: null }, "http://x/mcp");
      expect(workspaceLizardMode(dir)).toBeUndefined();
      expect(workspaceLizardMode(DOES_NOT_EXIST)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-75: `spec.agents[].model`/`.effort` (the two-axis mechanism's
  // resolved value for whichever provider this workspace launches under)
  // are persisted the SAME shape as `permissionMode`/`strictMcpConfig`
  // above — `HerdrHerd.staleIssues()`'s own `resolvedAgentOf` seam
  // (src/agents/herd.ts) reads them back to compare against what the
  // definition/rule CURRENTLY resolves to.
  test("workspaceModel/workspaceEffort round-trip what buildWorkspace persisted, keyed by the launch's own provider", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-model-effort-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "managed-session", summary: "s", parent: null, agents: [{ harness: "claude", model: "fable", effort: "xhigh" }] }, "http://x/mcp", "claude");
      expect(readFileSync(join(dir, ".butchr-model.json"), "utf8")).toBe(JSON.stringify("fable"));
      expect(readFileSync(join(dir, ".butchr-effort.json"), "utf8")).toBe(JSON.stringify("xhigh"));
      expect(workspaceModel(dir)).toBe("fable");
      expect(workspaceEffort(dir)).toBe("xhigh");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspaceModel/workspaceEffort persist the entry matching the ACTUAL launch provider, not just spec.agents[0] — a fallback chain's other entries are ignored", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-model-effort-provider-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const spec: SpawnSpec = { key: "KAN-9", issuetype: "managed-session", summary: "s", parent: null, agents: [{ harness: "claude", model: "fable", effort: "xhigh" }, { harness: "codex", model: "gpt-6-astra" }] };
      const dirCodex = buildWorkspace(spec, "http://x/mcp", "codex");
      expect(workspaceModel(dirCodex)).toBe("gpt-6-astra");
      expect(workspaceEffort(dirCodex)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspaceModel/workspaceEffort are undefined for a workspace where neither was ever set (no spec.agents entry for this provider), never throws", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-model-effort-none-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "Story", summary: "s", parent: null }, "http://x/mcp");
      expect(workspaceModel(dir)).toBeUndefined();
      expect(workspaceEffort(dir)).toBeUndefined();
      expect(workspaceModel(DOES_NOT_EXIST)).toBeUndefined();
      expect(workspaceEffort(DOES_NOT_EXIST)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-314 (PR #513 review fix): `buildWorkspace()` no longer touches
  // session id AT ALL — a fresh Claude launch runs under Claude's OWN
  // auto-generated session id (nothing butchr passes reaches the real
  // launch's argv; see `agentStartParams`'s own doc comment,
  // src/agents/argv.ts), so the real id is DISCOVERED afterward from its
  // transcript directory (`discoverClaudeSessionId`/`persistDiscoveredSessionId`
  // below), never pre-minted here.
  describe("FACTORY-314: discoverClaudeSessionId / persistDiscoveredSessionId / claudeTranscriptExists", () => {
    // Real creation (birth) time, NOT a faked mtime: `discoverClaudeSessionId`
    // (PR #513 epic review, "trap 2") deliberately prefers `birthtimeMs` —
    // effectively immutable once a file exists on most filesystems, unlike
    // mtime — so these tests create files in real, separately-timestamped
    // order rather than back-dating `utimesSync` (which cannot move
    // birthtime at all, and would make these tests assert nothing).
    function fakeTranscript(home: string, dir: string, id: string) {
      const projectDir = join(home, ".claude", "projects", resolve(dir).replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, `${id}.jsonl`), "{}");
    }
    const tick = () => new Promise((r) => setTimeout(r, 20));

    test("discoverClaudeSessionId returns the NEWEST transcript's id for this cwd, ignoring non-.jsonl files", async () => {
      const home = mkdtempSync(join(tmpdir(), "claude-home-"));
      const dir = absPath("some", "workspace", "KAN-20");
      try {
        fakeTranscript(home, dir, "older-session");
        await tick();
        fakeTranscript(home, dir, "newer-session");
        const projectDir = join(home, ".claude", "projects", resolve(dir).replace(/[^a-zA-Z0-9]/g, "-"));
        writeFileSync(join(projectDir, "not-a-transcript.txt"), "ignore me");
        expect(discoverClaudeSessionId(dir, home)).toBe("newer-session");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    test("discoverClaudeSessionId returns undefined when the project folder doesn't exist (no launch has happened yet, or discovery is checked against the wrong home)", () => {
      const home = mkdtempSync(join(tmpdir(), "claude-home-empty-"));
      try {
        expect(discoverClaudeSessionId(absPath("some", "workspace", "KAN-21"), home)).toBeUndefined();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    // PR #513 epic review ("trap 2"): the load-bearing case. A workspace
    // directory holding an OLDER transcript from a PRIOR respawn of the
    // SAME issue must never be silently mistaken for a brand-new launch's
    // own transcript — that would resume the WRONG conversation, validate
    // cleanly, and report success. `after` (the launch's own start instant)
    // is what makes that structurally impossible: nothing can be created
    // before the launch that produces it.
    test("discoverClaudeSessionId with `after` set NEVER returns a transcript created before that instant, even when it is the newest (or ONLY) one present — falls through to undefined instead of a wrong-but-real id", async () => {
      const home = mkdtempSync(join(tmpdir(), "claude-home-after-"));
      const dir = absPath("some", "workspace", "KAN-24");
      try {
        fakeTranscript(home, dir, "prior-respawns-old-session"); // a real, older transcript from BEFORE this launch
        await tick();
        const after = Date.now(); // "this launch" starts here — nothing created before this instant is a candidate
        // No new transcript has been written yet (simulates the discovery race this ticket measured live: the launch is confirmed, but its own file has not appeared yet).
        expect(discoverClaudeSessionId(dir, home, after)).toBeUndefined();
        await tick();
        fakeTranscript(home, dir, "this-launchs-real-session"); // now the REAL one for this launch appears
        expect(discoverClaudeSessionId(dir, home, after)).toBe("this-launchs-real-session");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    // FACTORY-631/FACTORY-623/FACTORY-568 regression — the millisecond-
    // granularity hazard, driven at FUNCTION level (not by looping the full
    // `herd.test.ts` scenario, which the FACTORY-623 diagnosis measured as
    // 0/40 locally: its margin is ~5-6ms alone, only ~1.6-2.0ms in the full
    // suite — the wrong instrument here).
    //
    // A naive "write, then `Date.now()`" repro (as the FACTORY-623 diagnosis
    // measured on ITS OWN host: stale id returned in 476/500 trials) is
    // itself a TIMING RACE, and racing it is exactly the "loop and hope"
    // approach that ticket's own diagnosis warns off — measured on THIS
    // worker's own host/filesystem (see `/tmp` script output recorded in the
    // PR description), the same race held 0/2000: this host's write+stat+
    // `Date.now()` sequence consistently takes long enough to roll into the
    // NEXT millisecond, so a bare timing race can't be trusted to fail here
    // the way it failed on the diagnosis's host. Driving the exact defect
    // deterministically needs no race at all: read the file's OWN real
    // `created` back, then set `after := Math.floor(created)` — a value
    // `Date.now()` COULD legitimately have produced for a launch starting
    // anywhere in that same millisecond. By construction `Math.floor(created)
    // <= created`, so the unmodified `created >= after` check ALWAYS held
    // (measured 500/500 on this host) and wrongly treated the file as this
    // launch's own; the fixed `created >= after + AFTER_MARGIN_MS` check
    // requires `created >= Math.floor(created) + 1`, which is NEVER true,
    // so the fix rejects it every time (see `discoverClaudeSessionId`'s own
    // doc comment for why that margin is the correct, minimal one).
    test("discoverClaudeSessionId never accepts a stale transcript whose `created` floors to the SAME whole millisecond as `after` (FACTORY-631/FACTORY-623/FACTORY-568)", () => {
      const home = mkdtempSync(join(tmpdir(), "claude-home-ms-hazard-"));
      try {
        const dir = absPath("some", "workspace", "KAN-25");
        const projectDir = join(home, ".claude", "projects", resolve(dir).replace(/[^a-zA-Z0-9]/g, "-"));
        mkdirSync(projectDir, { recursive: true });
        const TRIALS = 200;
        for (let i = 0; i < TRIALS; i++) {
          const id = `stale-trial-${i}`;
          const file = join(projectDir, `${id}.jsonl`);
          writeFileSync(file, "{}");
          const stat = statSync(file);
          const created = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
          const after = Math.floor(created); // a `Date.now()`-shaped value sharing `created`'s own millisecond — the ambiguous case
          expect(discoverClaudeSessionId(dir, home, after)).toBeUndefined();
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    test("persistDiscoveredSessionId writes what workspaceSessionId reads back", () => {
      const root = mkdtempSync(join(tmpdir(), "bw-persist-discovered-"));
      try {
        persistDiscoveredSessionId(root, "abc-123");
        expect(workspaceSessionId(root)).toBe("abc-123");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    // FACTORY-314 (epic review on PR #513, round 3): the OTHER half of
    // `persistDiscoveredSessionId`'s "never a guess" contract. A failed
    // discovery must not leave an OLDER id from a prior launch resumable —
    // see `HerdrHerd.startProviders`'s discovery-failure branch, which now
    // calls this instead of only logging.
    test("invalidatePersistedSessionId removes a persisted id — workspaceSessionId falls back to undefined", () => {
      const root = mkdtempSync(join(tmpdir(), "bw-invalidate-"));
      try {
        persistDiscoveredSessionId(root, "stale-from-a-prior-launch");
        expect(workspaceSessionId(root)).toBe("stale-from-a-prior-launch");
        invalidatePersistedSessionId(root);
        expect(workspaceSessionId(root)).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("invalidatePersistedSessionId on a workspace with no persisted id at all never throws (nothing to remove is not an error)", () => {
      const root = mkdtempSync(join(tmpdir(), "bw-invalidate-noop-"));
      try {
        expect(() => invalidatePersistedSessionId(root)).not.toThrow();
        expect(workspaceSessionId(root)).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("claudeTranscriptExists is true only for a REAL transcript, false for a missing one or the wrong home", () => {
      const home = mkdtempSync(join(tmpdir(), "claude-home-exists-"));
      const otherHome = mkdtempSync(join(tmpdir(), "claude-home-other-"));
      const dir = absPath("some", "workspace", "KAN-22");
      try {
        fakeTranscript(home, dir, "real-session");
        expect(claudeTranscriptExists(dir, "real-session", home)).toBe(true);
        expect(claudeTranscriptExists(dir, "no-such-session", home)).toBe(false);
        expect(claudeTranscriptExists(dir, "real-session", otherHome)).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(otherHome, { recursive: true, force: true });
      }
    });
  });

  test("buildWorkspace never creates a session id file itself — session id persistence is a separate, explicit step (discoverClaudeSessionId/persistDiscoveredSessionId)", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-no-session-id-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-23", issuetype: "Task", summary: "s", parent: null }, "http://x/mcp", "claude");
      expect(workspaceSessionId(dir)).toBeUndefined();
      expect(existsSync(join(dir, ".butchr-session-id.json"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspaceSessionId is undefined for a non-Claude launch and for a workspace with no persisted id at all — never throws", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-session-id-none-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const codexDir = buildWorkspace({ key: "KAN-12", issuetype: "Task", summary: "s", parent: null }, "http://x/mcp", "codex");
      expect(workspaceSessionId(codexDir)).toBeUndefined();
      expect(workspaceSessionId(DOES_NOT_EXIST)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-75: Codex has no `--effort`/`--reasoning` CLI flag at all
  // (`CodexAgentLaunch`, @brooswit/drovr, has no effort field) — its own
  // `model_reasoning_effort` config key is emitted into the SAME
  // per-workspace `.codex/config.toml` the freeform (jira-project) path
  // already writes `approval_policy`/`sandbox_mode` into (see
  // `codexReasoningEffortFlag`'s own doc comment, src/resources/power-scale.ts,
  // for how the config key itself was confirmed and its caveats).
  test("a codex managed-session launch with a resolved effort gets .codex/config.toml's model_reasoning_effort — a tier-based (back-compat) launch, which never resolves an effort, gets no such file at all", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-codex-effort-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const withEffort = buildWorkspace({ key: "KAN-10", issuetype: "managed-session", summary: "s", parent: null, agents: [{ harness: "codex", model: "gpt-6-astra", effort: "xhigh" }] }, "http://x/mcp", "codex");
      const configToml = readFileSync(join(withEffort, ".codex/config.toml"), "utf8");
      expect(configToml).toBe('model_reasoning_effort = "xhigh"\n'); // live-verified passthrough — see codexReasoningEffortFlag's own doc comment.
      const tierBased = buildWorkspace({ key: "KAN-11", issuetype: "managed-session", summary: "s", parent: null, agents: [{ harness: "codex", model: "gpt-5.6-luna" }] }, "http://x/mcp", "codex");
      expect(existsSync(join(tierBased, ".codex", "config.toml"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolveMcpServerHeaders: missing/malformed headersEnvVar resolves to undefined and logs the binding+var name, never a value", () => {
    const logs: string[] = [];
    const binding = { name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", headersEnvVar: "MUD_BRIDGE_HEADERS", channel: true };
    const noEnvVar = { name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", channel: true };
    expect(resolveMcpServerHeaders(binding, {}, (l) => logs.push(l))).toBeUndefined();
    expect(resolveMcpServerHeaders(noEnvVar, { MUD_BRIDGE_HEADERS: "{}" })).toBeUndefined();
    expect(resolveMcpServerHeaders(binding, { MUD_BRIDGE_HEADERS: "not json" }, (l) => logs.push(l))).toBeUndefined();
    expect(resolveMcpServerHeaders(binding, { MUD_BRIDGE_HEADERS: JSON.stringify({ a: 1 }) }, (l) => logs.push(l))).toBeUndefined();
    expect(resolveMcpServerHeaders(binding, { MUD_BRIDGE_HEADERS: JSON.stringify({ Authorization: "Bearer x" }) })).toEqual({ Authorization: "Bearer x" });
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) { expect(l).toContain("mud-bridge"); expect(l).toContain("MUD_BRIDGE_HEADERS"); }
  });

  test("BUTCHR-408 / Nexus MCP isolation constraint, direction 1: a managed-session agent's launched cwd never becomes the operator's own workingDirectory, and butchr never reads/writes/touches a .mcp.json there — a pre-existing one stays byte-identical (does NOT by itself prove Claude Code can't discover it; see 'PR #394 review round 2' below for the direction that guarantees the property regardless of Claude Code's own undocumented discovery behaviour)", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-nexus-"));
    const real = mkdtempSync(join(tmpdir(), "bw-nexus-real-"));
    process.env.BUTCHR_WORKSPACES = root;
    // Simulate a Bakr agent's real project directory carrying its OWN project-level
    // .mcp.json (the Claude Code auto-discovery convention — a DIFFERENT file/mechanism
    // than butchr's own explicit --mcp-config "mcp.json", no leading dot).
    const evilDotMcpJson = JSON.stringify({ mcpServers: { "evil-server": { type: "http", url: "https://not-butchr.test" } } });
    writeFileSync(join(real, ".mcp.json"), evilDotMcpJson);
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: ETC_DEFS_A_JSON });
      const spec: SpawnSpec = { key, issuetype: "managed-session", summary: "s", parent: null, brief: "Do the work.", cwd: real };
      const dir = buildWorkspace(spec, "http://x/mcp", "claude");
      const launch = agentLaunchConfig(spec, dir, "pane-1", "name", { provider: "claude" });
      // The launched process's OWN cwd is the bookkeeping dir, never `real` —
      // whatever Claude Code's own discovery does, it does it starting from
      // THIS directory, not from workingDirectory.
      expect(launch.cwd).toBe(dir);
      expect(launch.cwd).not.toBe(real);
      expect((launch as { mcpConfigPath: string }).mcpConfigPath).toBe(join(dir, "mcp.json"));
      // butchr never reads, writes, or otherwise touches a .mcp.json anywhere —
      // the operator's own file is byte-identical, and butchr's own config is a
      // differently-named file (no leading dot) in a different directory entirely.
      expect(readFileSync(join(real, ".mcp.json"), "utf8")).toBe(evilDotMcpJson);
      expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
      const ownMcpJson = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      expect(Object.keys(ownMcpJson.mcpServers)).toEqual(["butchr"]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  test("PR #394 review round 2, direction 2 — the guarantee: a .mcp.json in ANY ancestor of the launched cwd (workspaceDirFor(spec.key)), not just workingDirectory, refuses the spawn outright rather than asserting Claude Code won't discover it — a managed-session agent's launched cwd is always workspaceDirFor(spec.key), which Claude's --mcp-config is additive to, not exclusive of (no --strict-mcp-config anywhere in this codebase or @brooswit/drovr)", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-nexus-ancestor-"));
    process.env.BUTCHR_WORKSPACES = root;
    // A .mcp.json two levels above workspaceRoot() itself — well outside anything
    // butchr writes to, simulating an operator's own dotfile sitting somewhere
    // up the tree (e.g. $HOME, or a parent of BUTCHR_WORKSPACES).
    const ancestorMcpJson = join(root, ".mcp.json");
    writeFileSync(ancestorMcpJson, JSON.stringify({ mcpServers: { "evil-server": { type: "http", url: "https://not-butchr.test" } } }));
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: ETC_DEFS_A_JSON });
      const spec: SpawnSpec = { key, issuetype: "managed-session", summary: "s", parent: null, brief: "Do the work.", cwd: absPath("repo", "some-project") };
      expect(() => buildWorkspace(spec, "http://x/mcp", "claude")).toThrow(/would inherit/);
      expect(() => buildWorkspace(spec, "http://x/mcp", "claude")).toThrow(ancestorMcpJson);
      // Nothing was written before the guard fired — refuse-before-write, not partial-then-fail.
      expect(existsSync(workspaceDirFor(key))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("assertNoInheritedMcpConfig: no ancestor .mcp.json anywhere -> no throw, even walking all the way to the filesystem root", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-nexus-clean-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      expect(() => assertNoInheritedMcpConfig(join(root, "filesystem", "managed-sessions", "a"))).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a spec WITHOUT cwd (every non-managed-session provider) is never guarded — byte-for-byte unchanged behaviour, even with a .mcp.json sitting in an ancestor", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-nexus-unguarded-"));
    process.env.BUTCHR_WORKSPACES = root;
    writeFileSync(join(root, ".mcp.json"), "{}");
    try {
      const spec: SpawnSpec = { key: "KAN-9", issuetype: "Story", summary: "s", parent: null };
      expect(() => buildWorkspace(spec, "http://x/mcp")).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// BUTCHR-411: a rule can bind additional MCP servers, each landing in
// mcp.json alongside butchr's own — the channel flag itself is argv.ts's
// concern (see argv.test.ts); this is what a Claude agent's mcp.json actually
// contains.
describe("buildWorkspace — MCP server bindings (BUTCHR-411)", () => {
  const withRoot = (fn: (root: string) => void) => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-mcp-"));
    process.env.BUTCHR_WORKSPACES = root;
    try { fn(root); }
    finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  };
  const mud = { name: "mud", type: "http" as const, url: "https://mud.example/mcp", channel: true };

  test("no mcpServers -> mcp.json byte-identical to before (just butchr)", () => {
    withRoot(() => {
      const withField = buildWorkspace({ key: "KAN-20", issuetype: "Task", summary: "s", parent: null, mcpServers: [] }, "http://x/mcp");
      const withoutField = buildWorkspace({ key: "KAN-21", issuetype: "Task", summary: "s", parent: null }, "http://x/mcp");
      const a = readFileSync(join(withField, "mcp.json"), "utf8").replace(/KAN-20/g, "KAN");
      const b = readFileSync(join(withoutField, "mcp.json"), "utf8").replace(/KAN-21/g, "KAN");
      expect(a).toBe(b);
      expect(Object.keys(JSON.parse(a).mcpServers)).toEqual(["butchr"]);
    });
  });

  test("a bound server lands in mcp.json alongside butchr's own, channel:true or not", () => {
    withRoot(() => {
      const dir = buildWorkspace({ key: "KAN-22", issuetype: "Task", summary: "s", parent: null, mcpServers: [mud, { ...mud, name: "silent", channel: false }] }, "http://x/mcp");
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      expect(Object.keys(mcp.mcpServers).sort()).toEqual(["butchr", "mud", "silent"]);
      expect(mcp.mcpServers.mud).toEqual({ type: "http", url: "https://mud.example/mcp" });
      expect(mcp.mcpServers.silent).toEqual({ type: "http", url: "https://mud.example/mcp" });
      expect(mcp.mcpServers.butchr.url).toBe("http://x/mcp"); // butchr's own entry is unchanged by bindings
    });
  });

  test("a bound server's headersEnvVar resolves from THIS process's own env into mcp.json headers", () => {
    withRoot(() => {
      process.env.BUTCHR_TEST_WS_MUD_HEADERS = JSON.stringify({ Authorization: "Bearer t" });
      try {
        const dir = buildWorkspace({ key: "KAN-23", issuetype: "Task", summary: "s", parent: null, mcpServers: [{ ...mud, headersEnvVar: "BUTCHR_TEST_WS_MUD_HEADERS" }] }, "http://x/mcp");
        const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
        expect(mcp.mcpServers.mud).toEqual({ type: "http", url: "https://mud.example/mcp", headers: { Authorization: "Bearer t" } });
      } finally { delete process.env.BUTCHR_TEST_WS_MUD_HEADERS; }
    });
  });

  test("a non-claude provider never writes mcp.json at all -- bindings must not break agy/codex launch", () => {
    withRoot(() => {
      const dir = buildWorkspace({ key: "KAN-24", issuetype: "Task", summary: "s", parent: null, mcpServers: [mud] }, "http://x/mcp", "agy");
      expect(existsSync(join(dir, "mcp.json"))).toBe(false);
    });
  });

  // Review finding, PR #387 (BLOCKING): a bound server's resolved header
  // VALUE landed in a group/other-readable mcp.json at the default umask.
  const mode = (path: string) => statSync(path).mode & 0o777;

  // FACTORY-569: NTFS has no POSIX permission bits — nothing here to assert on win32.
  test.skipIf(process.platform === "win32")("mcp.json carrying a bound server's resolved header is chmod 0600 (owner-only)", () => {
    withRoot(() => {
      process.env.BUTCHR_TEST_WS_PERM_HEADERS = JSON.stringify({ Authorization: "Bearer secret" });
      try {
        const dir = buildWorkspace({ key: "KAN-25", issuetype: "Task", summary: "s", parent: null, mcpServers: [{ ...mud, headersEnvVar: "BUTCHR_TEST_WS_PERM_HEADERS" }] }, "http://x/mcp");
        expect(mode(join(dir, "mcp.json"))).toBe(0o600);
      } finally { delete process.env.BUTCHR_TEST_WS_PERM_HEADERS; }
    });
  });

  test.skipIf(process.platform === "win32")("a binding-less mcp.json keeps its default (unchanged) permissions — not tightened when there is no secret to protect", () => {
    withRoot(() => {
      const dir = buildWorkspace({ key: "KAN-26", issuetype: "Task", summary: "s", parent: null }, "http://x/mcp");
      const withoutBindings = mode(join(dir, "mcp.json"));
      const dir2 = buildWorkspace({ key: "KAN-27", issuetype: "Task", summary: "s", parent: null, mcpServers: [mud] }, "http://x/mcp"); // bound, but headersEnvVar unset -> no resolved header
      const withHeaderlessBinding = mode(join(dir2, "mcp.json"));
      expect(withHeaderlessBinding).toBe(withoutBindings);
      expect(withHeaderlessBinding).not.toBe(0o600); // proves this isn't just "always 0600 now"
    });
  });

  // BUTCHR-413 (CHANGES_REQUESTED review finding 1): spec.rocketchatAccount +
  // a binding's accountHeader reach Claude's mcp.json too, not just Codex's
  // argv — the SAME non-secret value on both surfaces (boundCodexServers,
  // src/agents/argv.ts, and argv.test.ts's own coverage for that half).
  test("spec.rocketchatAccount + a binding's accountHeader land in Claude's mcp.json", () => {
    withRoot(() => {
      const dir = buildWorkspace({ key: "KAN-29", issuetype: "Task", summary: "s", parent: null, mcpServers: [{ ...mud, accountHeader: "x-rocketr-account" }], rocketchatAccount: "butchr_acct_1" }, "http://x/mcp");
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      expect(mcp.mcpServers.mud).toEqual({ type: "http", url: "https://mud.example/mcp", headers: { "x-rocketr-account": "butchr_acct_1" } });
    });
  });

  test.skipIf(process.platform === "win32")("an account header ALONE (no headersEnvVar) never triggers the 0600 tightening — only an actual secret does", () => {
    withRoot(() => {
      const dir = buildWorkspace({ key: "KAN-30", issuetype: "Task", summary: "s", parent: null, mcpServers: [{ ...mud, accountHeader: "x-rocketr-account" }], rocketchatAccount: "butchr_acct_1" }, "http://x/mcp");
      expect(mode(join(dir, "mcp.json"))).not.toBe(0o600);
    });
  });

  test.skipIf(process.platform === "win32")("rebuilding an EXISTING workspace still tightens permissions on the rewrite (chmod, not just the create-time mode)", () => {
    withRoot(() => {
      const spec = { key: "KAN-28", issuetype: "Task", summary: "s", parent: null };
      const dir = buildWorkspace(spec, "http://x/mcp"); // first build: no bindings, default perms
      expect(mode(join(dir, "mcp.json"))).not.toBe(0o600);
      process.env.BUTCHR_TEST_WS_PERM_HEADERS2 = JSON.stringify({ Authorization: "Bearer secret" });
      try {
        buildWorkspace({ ...spec, mcpServers: [{ ...mud, headersEnvVar: "BUTCHR_TEST_WS_PERM_HEADERS2" }] }, "http://x/mcp"); // rebuild: now bound, with a resolved header
        expect(mode(join(dir, "mcp.json"))).toBe(0o600);
      } finally { delete process.env.BUTCHR_TEST_WS_PERM_HEADERS2; }
    });
  });

  // BUTCHR-412 (BUTCHR-391 comment 24007): the corrected Rocket.Chat
  // credential design — an agent never holds a credential; its MCP binding
  // carries only its own (non-secret) account name, via `accountHeader`.
  describe("accountHeader / spec.rocketchatAccount (BUTCHR-412)", () => {
    const rocketr = { name: "rocketr", type: "http" as const, url: "https://rocketr.internal/mcp", accountHeader: "x-rocketr-account", channel: true };

    test("spec.rocketchatAccount is injected under the binding's accountHeader name — never anywhere else", () => {
      withRoot(() => {
        const dir = buildWorkspace({ key: "KAN-30", issuetype: "Task", summary: "s", parent: null, mcpServers: [rocketr], rocketchatAccount: "butchr_jira-work-triage-kan-30_deadbeef00" }, "http://x/mcp");
        const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
        expect(mcp.mcpServers.rocketr).toEqual({ type: "http", url: "https://rocketr.internal/mcp", headers: { "x-rocketr-account": "butchr_jira-work-triage-kan-30_deadbeef00" } });
        for (const f of ["CLAUDE.md", "brief.md", "ENVIRONMENT.md"]) {
          expect(readFileSync(join(dir, f), "utf8")).not.toContain("butchr_jira-work-triage-kan-30_deadbeef00");
        }
        // No token, no credential file of any kind — the account name is the ONLY thing that ever moves.
        expect(existsSync(join(dir, ".butchr-rocketchat.json"))).toBe(false);
      });
    });

    test.skipIf(process.platform === "win32")("an account name (never secret) does NOT by itself tighten mcp.json's permissions", () => {
      withRoot(() => {
        const dir = buildWorkspace({ key: "KAN-31", issuetype: "Task", summary: "s", parent: null, mcpServers: [rocketr], rocketchatAccount: "butchr_x" }, "http://x/mcp");
        expect(mode(join(dir, "mcp.json"))).not.toBe(0o600);
      });
    });

    test("no rocketchatAccount on the spec (account policy \"none\", or ensureAccount hasn't run): the header is simply omitted", () => {
      withRoot(() => {
        const dir = buildWorkspace({ key: "KAN-32", issuetype: "Task", summary: "s", parent: null, mcpServers: [rocketr] }, "http://x/mcp");
        const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
        expect(mcp.mcpServers.rocketr).toEqual({ type: "http", url: "https://rocketr.internal/mcp" });
      });
    });

    test("a binding with no accountHeader ignores spec.rocketchatAccount entirely", () => {
      withRoot(() => {
        const dir = buildWorkspace({ key: "KAN-33", issuetype: "Task", summary: "s", parent: null, mcpServers: [mud], rocketchatAccount: "butchr_x" }, "http://x/mcp");
        const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
        expect(mcp.mcpServers.mud).toEqual({ type: "http", url: "https://mud.example/mcp" });
      });
    });

    test("accountHeader and headersEnvVar combine on the SAME binding — the secret one still tightens permissions, the account name doesn't need to", () => {
      withRoot(() => {
        process.env.BUTCHR_TEST_WS_ROCKETR_HEADERS = JSON.stringify({ "X-Extra": "v" });
        try {
          const dir = buildWorkspace({ key: "KAN-34", issuetype: "Task", summary: "s", parent: null, mcpServers: [{ ...rocketr, headersEnvVar: "BUTCHR_TEST_WS_ROCKETR_HEADERS" }], rocketchatAccount: "butchr_x" }, "http://x/mcp");
          const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
          expect(mcp.mcpServers.rocketr).toEqual({ type: "http", url: "https://rocketr.internal/mcp", headers: { "X-Extra": "v", "x-rocketr-account": "butchr_x" } });
          // FACTORY-569: NTFS has no POSIX permission bits.
          if (process.platform !== "win32") expect(mode(join(dir, "mcp.json"))).toBe(0o600); // the headersEnvVar half is still treated as potentially secret
        } finally { delete process.env.BUTCHR_TEST_WS_ROCKETR_HEADERS; }
      });
    });
  });
});

describe("resolveAccountHeader (BUTCHR-412)", () => {
  const rocketr = { name: "rocketr", type: "http" as const, url: "https://rocketr.internal/mcp", accountHeader: "x-rocketr-account", channel: true };
  const mud = { name: "mud", type: "http" as const, url: "https://mud.example/mcp", channel: true };

  test("binding names accountHeader and an account is present -> resolves that one header", () => {
    expect(resolveAccountHeader(rocketr, "butchr_x")).toEqual({ "x-rocketr-account": "butchr_x" });
  });
  test("binding names accountHeader but no account (undefined) -> undefined, never an empty-string header", () => {
    expect(resolveAccountHeader(rocketr, undefined)).toBeUndefined();
  });
  test("no accountHeader on the binding -> undefined regardless of account", () => {
    expect(resolveAccountHeader(mud, "butchr_x")).toBeUndefined();
  });
});

describe("resolveMcpServerHeaders (BUTCHR-411)", () => {
  const mud = { name: "mud", type: "http" as const, url: "https://mud.example/mcp", channel: true };

  const silent = () => {}; // most cases below intentionally exercise the "resolves to nothing" log path; keep test output clean

  test("no headersEnvVar -> undefined, and the log is never called (nothing to warn about)", () => {
    const lines: string[] = [];
    expect(resolveMcpServerHeaders(mud, {}, (l) => lines.push(l))).toBeUndefined();
    expect(lines).toEqual([]);
  });
  test("headersEnvVar names an unset var -> undefined, not a throw", () => {
    expect(resolveMcpServerHeaders({ ...mud, headersEnvVar: "NOPE" }, {}, silent)).toBeUndefined();
  });
  test("a set var holding a flat string-valued JSON object resolves, and the log is never called", () => {
    const lines: string[] = [];
    expect(resolveMcpServerHeaders({ ...mud, headersEnvVar: "H" }, { H: JSON.stringify({ Authorization: "Bearer t", "X-Extra": "y" }) }, (l) => lines.push(l))).toEqual({ Authorization: "Bearer t", "X-Extra": "y" });
    expect(lines).toEqual([]);
  });
  test("malformed JSON, a non-object, or a non-string-valued object all resolve to undefined rather than throwing", () => {
    for (const raw of ["not json", "[]", "null", "42", JSON.stringify({ a: 1 }), JSON.stringify({ a: { b: "c" } })]) {
      expect(resolveMcpServerHeaders({ ...mud, headersEnvVar: "H" }, { H: raw }, silent)).toBeUndefined();
    }
  });
  // Review finding, PR #387 (non-blocking, requested): an authenticated
  // bridge whose headersEnvVar resolves to nothing must leave a trail
  // naming the binding and the env var — never the (here, secret) value.
  test("headersEnvVar set but unresolvable logs exactly one line naming the binding and env var — never the raw env value", () => {
    const lines: string[] = [];
    resolveMcpServerHeaders({ ...mud, headersEnvVar: "MUD_MCP_HEADERS" }, { MUD_MCP_HEADERS: "not-json-but-looks-like-a-SEKRET-token" }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("mud");
    expect(lines[0]).toContain("MUD_MCP_HEADERS");
    expect(lines[0]).not.toContain("SEKRET");
    expect(lines[0]).not.toContain("not-json-but-looks-like-a-SEKRET-token");
  });
  test("defaults to console.error when no log fn is given (only asserting it doesn't throw — output is incidental)", () => {
    expect(() => resolveMcpServerHeaders({ ...mud, headersEnvVar: "STILL_UNSET_VAR_XYZ" }, {})).not.toThrow();
  });
  test("defaults to process.env when no env map is given", () => {
    process.env.BUTCHR_TEST_RESOLVE_HEADERS = JSON.stringify({ A: "b" });
    try { expect(resolveMcpServerHeaders({ ...mud, headersEnvVar: "BUTCHR_TEST_RESOLVE_HEADERS" })).toEqual({ A: "b" }); }
    finally { delete process.env.BUTCHR_TEST_RESOLVE_HEADERS; }
  });
});
