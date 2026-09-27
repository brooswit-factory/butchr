/**
 * FACTORY-118 (implementing FACTORY-91, epic FACTORY-83) — the migration
 * half of the short-workspace-directory-name feature: moving an
 * already-existing pre-FACTORY-118 three-deep workspace
 * (`<root>/<provider>/<ruleId>/<resourceId>`) to its new short-name
 * location (`workspace.ts`'s `newLayoutDirFor`), and moving Claude Code's
 * own `~/.claude/projects/<slug-of-cwd>` memory/transcript directory to
 * follow it — so renaming a workspace directory never silently cuts an
 * agent off from its own memory (the hazard this whole ticket exists to
 * close; see FACTORY-91/FACTORY-83's docs for the full background).
 *
 * THREE REQUIRED PROPERTIES, each covered by its own tests
 * (test/unit/workspace-migration.test.ts):
 *   - IDEMPOTENT: running `migrateWorkspaceLayout` again after it already
 *     finished is a no-op — no error, no further filesystem change.
 *   - REVERSIBLE: `reverseMigrateWorkspaceLayout` undoes it exactly —
 *     forward then reverse restores the original directory layout and
 *     slug location byte-for-byte (mtimes aside).
 *   - NEVER OVERWRITES A NON-EMPTY TARGET: on either half (the workspace
 *     directory or the Claude slug), a non-empty target refuses loudly
 *     (throws, naming both paths) rather than merging, replacing, or
 *     silently skipping — see each function's own doc comment for exactly
 *     which existing-target shapes are safe to proceed through (an EMPTY
 *     target, e.g. a fresh session's own not-yet-written slug dir, or a
 *     workspace dir `ensureWorkspaceDir` claimed but hasn't written into
 *     yet) versus which refuse.
 *
 * PARTIAL-FAILURE ORDERING (FACTORY-118's own required decision, restated
 * here — see `migrateWorkspaceLayout`'s own doc comment for the reasoning):
 * the workspace DIRECTORY rename always happens before the CLAUDE SLUG
 * move, and both halves re-derive "is this already done" from what is
 * ACTUALLY ON DISK right now (never from an in-memory flag or from
 * whether a previous call threw) — so a crash or error between the two
 * halves leaves a state a plain re-run of the same call finishes
 * correctly, picking up only the remaining half.
 *
 * WHAT THIS DOES NOT DO: decide WHEN to migrate (that is a caller's job —
 * a startup pass and/or `buildWorkspace`'s own "computed dir differs from
 * where it lives" check, per FACTORY-118's own ticket text) or touch
 * anything on a host other than the one it runs on. Safe to call for an
 * agent that is CURRENTLY RUNNING (see docs/workspace-layout.md's
 * "Renaming a live workspace" section for the empirical Servy evidence
 * this claim rests on — POSIX `rename(2)` on a directory a live process
 * has as its cwd does not disturb that process, and a Claude Code session
 * with an already-open transcript file descriptor keeps writing through
 * it by inode, not by path, so an in-flight session's OWN writes are
 * unaffected by moving `~/.claude/projects/<old-slug>` out from under it —
 * only a LATER `--resume`/`--continue` invocation, which re-derives the
 * slug from its cwd at that later moment, needs the slug to have already
 * moved).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { decodeAgentKey, decodeAnyAgentKey } from "../rules/agent-key.js";
import { AGENT_KEY_BOOKKEEPING_FILE, claudeProjectSlug, newLayoutDirFor, readBookkeptAgentKey, writeBookkeptAgentKey, workspaceRoot } from "./workspace.js";

/**
 * `claudeProjectSlug` (imported from `./workspace.js`, which also needs it
 * for Addendum A4's slug-collision check — see that function's own doc
 * comment there for the full verification story: `@brooswit/drovr`'s
 * independent reimplementation, and EMPIRICALLY against the real `claude`
 * CLI on this host, docs/workspace-layout.md's "Empirical slug verification"
 * section) is confirmed exact for a resolved absolute path containing `.`,
 * `_`, `%`, `~`, and multi-byte Unicode characters. NOT confirmed for a
 * resolved path whose sanitized length exceeds 200 characters: real Claude
 * Code truncates the sanitized slug to its first 200 characters and appends
 * `-` plus a 6-character suffix that did NOT match a plain md5/sha1/sha256
 * hex digest of the raw path in this investigation — see that same doc
 * section for the full negative result. `migrateClaudeProjectSlug` below
 * therefore falls back to a PREFIX match against the real
 * `~/.claude/projects` listing (see `findClaudeProjectDir`'s own doc
 * comment) whenever the exact-match slug is not found on disk, rather than
 * ever assuming the formula alone is authoritative for an overlong path.
 */
/** The exact-match slug length past which real Claude Code is known (empirically, not by source) to truncate-and-hash instead — see `claudeProjectSlug`'s own doc comment (src/agents/workspace.ts). */
const CLAUDE_SLUG_TRUNCATION_LENGTH = 200;

/**
 * Locates the REAL on-disk `~/.claude/projects/<slug>` directory for `cwd`,
 * tolerating the long-path truncation `claudeProjectSlug` cannot itself
 * reproduce: an exact-name match wins if present; otherwise, for a `cwd`
 * whose computed slug exceeds `CLAUDE_SLUG_TRUNCATION_LENGTH`, a directory
 * whose name starts with the first `CLAUDE_SLUG_TRUNCATION_LENGTH`
 * characters of that slug followed by `-` is treated as the same project
 * (real Claude Code's own truncated-slug shape). `null` if neither is
 * found — genuinely no session has ever run at `cwd`, not a lookup
 * failure.
 */
function findClaudeProjectDir(projectsDir: string, cwd: string): string | null {
  const slug = claudeProjectSlug(cwd);
  const exact = join(projectsDir, slug);
  if (existsSync(exact)) return exact;
  if (slug.length <= CLAUDE_SLUG_TRUNCATION_LENGTH) return null;
  const prefix = `${slug.slice(0, CLAUDE_SLUG_TRUNCATION_LENGTH)}-`;
  let entries: string[];
  try { entries = readdirSync(projectsDir); } catch { return null; }
  const match = entries.find((e) => e.startsWith(prefix));
  return match ? join(projectsDir, match) : null;
}

export interface SlugMigrationResult {
  outcome: "moved" | "already-migrated" | "no-old-slug";
  oldSlugDir: string | null;
  newSlugDir: string;
}

/**
 * Moves `~/.claude/projects/<slug-of-oldCwd>` to `~/.claude/projects/<slug-of-newCwd>` —
 * IDEMPOTENT (re-run once `oldCwd`'s slug is gone reports `"no-old-slug"`,
 * never an error), REVERSIBLE (calling again with `oldCwd`/`newCwd` swapped
 * undoes it exactly), and NEVER OVERWRITES A NON-EMPTY TARGET (throws,
 * naming both paths, leaving both sides untouched, if the destination
 * slug directory exists and already holds anything — an EMPTY destination,
 * e.g. a fresh session started at the new path before this ran, or the
 * two paths sharing one slug already, is safe to proceed through: an
 * empty directory is nothing to lose, and a real Claude Code invocation
 * has not yet written a first transcript into it).
 *
 * REFUSES rather than guesses when `newCwd`'s own naive slug exceeds
 * `CLAUDE_SLUG_TRUNCATION_LENGTH` (empirically confirmed live on Servy —
 * docs/workspace-layout.md's "Empirical slug verification" section — real
 * Claude Code truncates and appends a 6-character suffix this codebase
 * cannot reproduce, see `claudeProjectSlug`'s own doc comment for the
 * negative hash result). `findClaudeProjectDir` can tolerate this on the
 * OLD side by scanning for a matching truncated-prefix directory that
 * ALREADY exists, but there is nothing to scan for on the NEW side before
 * a real `claude` invocation has ever run there — silently renaming into
 * the naive (untruncated) name would move the transcript to a directory
 * real Claude Code will never read from, cutting the agent off from its
 * own memory exactly as silently as the hazard this whole ticket exists to
 * close. Confirmed live: migrating a workspace whose new path's slug was
 * over the threshold left the transcript unreachable by `claude --continue`
 * at the new cwd (a fresh, empty conversation) even though the file itself
 * had been moved — see the doc's Servy proof for the exact commands.
 */
export function migrateClaudeProjectSlug(oldCwd: string, newCwd: string, home: string = homedir()): SlugMigrationResult {
  const projectsDir = join(home, ".claude", "projects");
  const newSlugNaive = claudeProjectSlug(newCwd);
  if (resolve(oldCwd) !== resolve(newCwd) && newSlugNaive.length > CLAUDE_SLUG_TRUNCATION_LENGTH) {
    throw new Error(
      `migrateClaudeProjectSlug: refusing to migrate — new cwd ${JSON.stringify(newCwd)}'s naive Claude Code slug is ${newSlugNaive.length} chars, over the ${CLAUDE_SLUG_TRUNCATION_LENGTH}-char threshold where real Claude Code truncates and appends an unreproducible hash suffix (see this function's own doc comment). Moving the memory slug here would silently orphan it. Shorten the workspace root or resource id so the new path's slug stays at or under the threshold, then retry.`,
    );
  }
  const newSlugDir = join(projectsDir, newSlugNaive);
  if (resolve(oldCwd) === resolve(newCwd)) return { outcome: "already-migrated", oldSlugDir: existsSync(newSlugDir) ? newSlugDir : null, newSlugDir };
  const oldSlugDir = findClaudeProjectDir(projectsDir, oldCwd);
  if (!oldSlugDir) return { outcome: "no-old-slug", oldSlugDir: null, newSlugDir };
  if (resolve(oldSlugDir) === resolve(newSlugDir)) return { outcome: "already-migrated", oldSlugDir, newSlugDir };
  if (existsSync(newSlugDir)) {
    if (readdirSync(newSlugDir).length > 0) {
      throw new Error(`refusing to migrate Claude Code memory slug ${oldSlugDir} -> ${newSlugDir}: target already exists and is non-empty (source left untouched)`);
    }
    rmdirSync(newSlugDir);
  }
  mkdirSync(dirname(newSlugDir), { recursive: true });
  renameSync(oldSlugDir, newSlugDir);
  return { outcome: "moved", oldSlugDir, newSlugDir };
}

/**
 * Every git WORKTREE (never an ordinary clone — told apart by `.git` being
 * a FILE, not a directory: only a linked worktree has that shape) found at
 * or under `dir`, bounded to a shallow depth (real workspaces nest a
 * worktree one level down, per this fleet's own `worktree add
 * "$PWD/<repo>"` convention — see brief.md) and skipping hidden directories
 * (butchr's own `.butchr-*`/`.codex` bookkeeping, and `.git` itself) so an
 * ordinary large checkout's `node_modules`/build output is never walked.
 */
function findGitWorktrees(dir: string, depth = 3): string[] {
  const out: string[] = [];
  const gitPath = join(dir, ".git");
  try { if (statSync(gitPath).isFile()) out.push(dir); } catch { /* no .git here, or not a worktree — fine */ }
  if (depth <= 0) return out;
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    out.push(...findGitWorktrees(join(dir, e.name), depth - 1));
  }
  return out;
}

/**
 * Repairs every git worktree found under `dir` (`git worktree repair`,
 * which fixes BOTH the worktree's own `.git` file — pointing at the
 * canonical clone's `.git/worktrees/<name>/gitdir` — AND that canonical
 * clone's own back-reference to the worktree, either of which a rename of
 * `dir` leaves stale; see this ticket's own doc for why an atomic
 * directory rename does not fix these two absolute-path cross-references
 * for free the way it does every plain bookkeeping file inside `dir`).
 * Called with the workspace directory's NEW location — `git worktree
 * repair` is documented to work from inside the (possibly-stale) worktree
 * itself, reconciling paths in both directions. Throws, naming the
 * worktree, if a repair attempt itself fails — this must never be silent:
 * an unrepaired worktree looks fine until the next `git` command run
 * inside it fails obscurely.
 */
export function repairGitWorktrees(dir: string): string[] {
  const worktrees = findGitWorktrees(dir);
  for (const worktree of worktrees) {
    try { execFileSync("git", ["-C", worktree, "worktree", "repair"], { stdio: "pipe" }); }
    catch (e) { throw new Error(`git worktree repair failed for ${worktree}: ${(e as Error).message}`); }
  }
  return worktrees;
}

export interface WorkspaceMigrationResult {
  outcome: "migrated" | "already-migrated" | "no-legacy-workspace";
  oldDir: string | null;
  newDir: string;
  slug: SlugMigrationResult;
  repairedWorktrees: string[];
}

/**
 * Migrates ONE rule-engine agent's workspace from its pre-FACTORY-118
 * three-deep directory to its new short-name one, and its Claude Code
 * memory slug alongside it. Every branch below is existence-based — it
 * asks "what exists on disk right now", never "did I already run and
 * succeed" — which is what makes a re-run after a partial failure land in
 * the right branch automatically rather than needing its own separate
 * "resume" path:
 *
 *   old absent, new absent  -> `"no-legacy-workspace"`: nothing to do (this
 *     agent key was never built under the old layout — a brand-new ticket
 *     created after this ticket shipped looks exactly like this).
 *   old absent, new present -> `"already-migrated"`: the directory rename
 *     already happened (this call or an interrupted earlier one); make
 *     sure the bookkeeping stamp, worktree repair, and slug move are ALSO
 *     done (each individually idempotent) rather than assuming they were.
 *   old present, new present -> refuse if `newDir` is non-empty (never
 *     overwrite real content); otherwise (an empty target — e.g.
 *     `ensureWorkspaceDir` or `resource-connections.ts`'s own `prepare()`
 *     claimed it but nothing has been written into it yet) fall through to
 *     the rename below exactly as if `newDir` had been absent — POSIX
 *     `rename(2)` replaces an empty directory target.
 *   old present, new absent -> the ordinary case: rename, stamp, repair
 *     worktrees, move the slug.
 *
 * ORDERING (FACTORY-118's own required decision): the directory rename
 * happens before the Claude slug move, in every branch above that performs
 * both. Reasoning: `migrateClaudeProjectSlug`'s own "old" side is
 * re-derived from `oldDir` — THIS FUNCTION'S OWN ARGUMENT, always the
 * fixed pre-migration path — every single time, on every call, regardless
 * of whether the directory has already moved. That is only safe because
 * the directory rename is what makes `oldDir` stop existing (so a later
 * call's `existsSync(oldDir)` check correctly reports "already moved"),
 * and it must happen first for that check to ever fire; the reverse order
 * has no such property — a slug move that ran before the directory rename
 * would have nothing to key its own "already done" detection on other than
 * an in-memory flag this function deliberately does not keep.
 */
export function migrateWorkspaceLayout(agentKey: string, root: string = workspaceRoot(), home: string = homedir()): WorkspaceMigrationResult {
  if (!decodeAnyAgentKey(agentKey)) throw new Error(`migrateWorkspaceLayout: not a rule-engine agent key: ${JSON.stringify(agentKey)}`);
  const oldDir = join(root, ...agentKey.split(":"));
  const newDir = newLayoutDirFor(agentKey, root);
  // Query-level keys and identity-short-id resource keys (Addendum A1:
  // jira-work/jira-idea/jira-project) always have `newDir === oldDir` — old
  // dir == new dir must be a clean no-op success (Addendum A4's own
  // requirement), never a rename-onto-itself.
  if (resolve(oldDir) === resolve(newDir)) {
    return { outcome: existsSync(newDir) ? "already-migrated" : "no-legacy-workspace", oldDir: null, newDir, slug: { outcome: "already-migrated", oldSlugDir: null, newSlugDir: join(home, ".claude", "projects", claudeProjectSlug(newDir)) }, repairedWorktrees: [] };
  }
  const oldExists = existsSync(oldDir);
  const newExists = existsSync(newDir);

  if (!oldExists && !newExists) {
    return { outcome: "no-legacy-workspace", oldDir: null, newDir, slug: { outcome: "no-old-slug", oldSlugDir: null, newSlugDir: join(home, ".claude", "projects", claudeProjectSlug(newDir)) }, repairedWorktrees: [] };
  }
  if (oldExists && newExists) {
    const newDirEntries = readdirSync(newDir);
    // `ensureWorkspaceDir` stamps a directory the INSTANT it claims it — so
    // "claimed but nothing written yet" (this function's own doc comment,
    // and the DoD's own "target-side dir already containing a fresh session
    // created after a restart" edge case) is NEVER a literal zero-entry
    // directory: it always has exactly the bookkeeping stamp file in it.
    // Only entries OTHER than that stamp — and only when the stamp names
    // this SAME key, never a foreign one — count as "real content" for the
    // refuse check below; a foreign or mismatched stamp is real content too
    // (never silently adopted, per Addendum A6).
    const stampedThisKey = readBookkeptAgentKey(newDir) === agentKey;
    const meaningfulEntries = stampedThisKey ? newDirEntries.filter((e) => e !== AGENT_KEY_BOOKKEEPING_FILE) : newDirEntries;
    if (meaningfulEntries.length > 0) {
      throw new Error(`refusing to migrate workspace ${oldDir} -> ${newDir}: target already exists and is non-empty (left both sides untouched)`);
    }
    if (newDirEntries.length > 0) {
      // Logically empty (just this key's own claim stamp) but not LITERALLY
      // empty — POSIX rename(2) only replaces a directory target that has
      // zero entries. Remove the stamp so the physical rename below can
      // proceed exactly as the doc comment above promises; the pre-rename
      // stamp write on `oldDir` (below) restores it at the new location.
      unlinkSync(join(newDir, AGENT_KEY_BOOKKEEPING_FILE));
      rmdirSync(newDir);
    }
  }
  if (oldExists) {
    // Stamped BEFORE the rename, inside `oldDir`, so the stamp travels WITH
    // the atomic rename like every other bookkeeping file — never a separate
    // step after it. This closes a real crash window: `newLayoutDirFor`'s own
    // collision-avoidance (workspace.ts) treats an EXISTING, UNSTAMPED bare
    // leaf as a foreign occupant and reroutes to a suffixed alternative —
    // correct for a genuine two-different-keys collision, but WRONG for this
    // key's own not-yet-stamped rename target. A crash between a
    // post-rename stamp write and the rename itself would therefore make a
    // retry compute a DIFFERENT `newDir` than the one the content actually
    // landed at, permanently orphaning it as "no-legacy-workspace" (old
    // absent, and the fresh — now-different — new candidate also absent).
    // Stamping pre-rename means the directory is ALREADY correctly stamped
    // the instant it lands at `newDir`, so no such window exists.
    writeBookkeptAgentKey(oldDir, agentKey);
    mkdirSync(dirname(newDir), { recursive: true });
    renameSync(oldDir, newDir);
  }
  if (readBookkeptAgentKey(newDir) !== agentKey) writeBookkeptAgentKey(newDir, agentKey);
  const repairedWorktrees = repairGitWorktrees(newDir);
  const slug = migrateClaudeProjectSlug(oldDir, newDir, home);
  return { outcome: oldExists ? "migrated" : "already-migrated", oldDir: oldExists ? oldDir : null, newDir, slug, repairedWorktrees };
}

/**
 * Exact inverse of `migrateWorkspaceLayout`: moves the workspace directory
 * (and its Claude Code slug) back from the new short-name location to the
 * pre-FACTORY-118 three-deep one. Also existence-based, also idempotent,
 * also refuses a non-empty target rather than overwriting it. The one
 * asymmetry with the forward direction: the bookkeeping stamp
 * (`AGENT_KEY_BOOKKEEPING_FILE`) is explicitly REMOVED from the restored
 * old-layout directory rather than merely left unwritten — `workspaceDirFor`'s
 * own "not yet migrated" branch (src/agents/workspace.ts) recognises an
 * old-layout directory specifically by the ABSENCE of that stamp, so
 * leaving it behind after a reversal would make `workspaceDirFor` keep
 * reporting the NEW (no-longer-real) location instead of the restored old
 * one — the round trip would look complete but not actually restore
 * lookup behaviour, exactly the "looks done and is not" failure this
 * ticket's own review discipline exists to catch.
 */
export function reverseMigrateWorkspaceLayout(agentKey: string, root: string = workspaceRoot(), home: string = homedir()): WorkspaceMigrationResult {
  if (!decodeAnyAgentKey(agentKey)) throw new Error(`reverseMigrateWorkspaceLayout: not a rule-engine agent key: ${JSON.stringify(agentKey)}`);
  const oldDir = join(root, ...agentKey.split(":"));
  const newDir = newLayoutDirFor(agentKey, root);
  if (resolve(oldDir) === resolve(newDir)) {
    return { outcome: existsSync(oldDir) ? "already-migrated" : "no-legacy-workspace", oldDir, newDir, slug: { outcome: "already-migrated", oldSlugDir: null, newSlugDir: join(home, ".claude", "projects", claudeProjectSlug(newDir)) }, repairedWorktrees: [] };
  }
  const oldExists = existsSync(oldDir);
  const newExists = existsSync(newDir);

  if (!newExists && !oldExists) {
    return { outcome: "no-legacy-workspace", oldDir: null, newDir, slug: { outcome: "no-old-slug", oldSlugDir: null, newSlugDir: join(home, ".claude", "projects", claudeProjectSlug(newDir)) }, repairedWorktrees: [] };
  }
  if (newExists && oldExists && readdirSync(oldDir).length > 0) {
    throw new Error(`refusing to reverse-migrate workspace ${newDir} -> ${oldDir}: target already exists and is non-empty (left both sides untouched)`);
  }
  if (newExists) {
    mkdirSync(dirname(oldDir), { recursive: true });
    renameSync(newDir, oldDir);
  }
  try { unlinkSync(join(oldDir, AGENT_KEY_BOOKKEEPING_FILE)); } catch { /* already absent — fine, idempotent */ }
  const repairedWorktrees = repairGitWorktrees(oldDir);
  const slug = migrateClaudeProjectSlug(newDir, oldDir, home);
  return { outcome: newExists ? "migrated" : "already-migrated", oldDir, newDir, slug, repairedWorktrees };
}

export interface ClaudeSettingsMigrationResult {
  outcome: "moved" | "already-migrated" | "no-old-entry";
  claudeJsonPath: string;
}

/**
 * FACTORY-118's "other path-keyed state" investigation (see the doc for the
 * full ten-candidate writeup): `~/.claude.json`'s own top-level `projects`
 * object holds a SECOND, independent piece of per-workspace state, keyed by
 * the exact absolute cwd string (not a sanitized slug) — trust/onboarding
 * (`hasTrustDialogAccepted`), `allowedTools`, and MCP approvals
 * (`enabledMcpjsonServers`/`disabledMcpjsonServers`/`mcpServers`). This is
 * real, verified state (not a guess) and genuinely goes stale exactly like
 * the memory slug does when a workspace directory is renamed — so this
 * function exists, with the same three properties as
 * `migrateClaudeProjectSlug` (idempotent, reversible, never overwrites a
 * non-empty target entry).
 *
 * DELIBERATELY NOT CALLED BY `migrateWorkspaceLayout`/`reverseMigrateWorkspaceLayout`
 * ABOVE, unlike the memory-slug move — call it separately (see
 * `scripts/migrate-workspace-layout.ts`'s `--include-claude-settings` flag,
 * off by default). Reasoning: `~/.claude/projects/<slug>` is a directory
 * dedicated to one cwd that nothing else on the host ever writes to, but
 * `~/.claude.json` is ONE FILE SHARED BY EVERY Claude Code session on this
 * host — dozens, on this fleet, per `herdr workspace list` — so a
 * read-modify-write cycle against it, however fast, has a real (if narrow)
 * chance of losing a DIFFERENT session's own concurrent settings flush to
 * the same file during that window. That is a materially larger blast
 * radius than every other move this ticket makes (each of which touches
 * only ITS OWN workspace's directory or slug, nothing shared), so it is
 * never run as a silent side effect of the always-safe default migration —
 * an operator opts in explicitly, at a quiet moment (this epic's own deploy
 * discipline: see FACTORY-83), and accepts that narrow race consciously.
 *
 * WHY SKIPPING THIS STEP IS SAFE TO SHIP (unlike skipping the slug move):
 * the state lost if an operator never runs this is real but recoverable UX
 * friction, never silent data loss — a reset `hasTrustDialogAccepted`/
 * `allowedTools`/`mcpServers` entry just means Claude Code re-asks its
 * ordinary startup trust dialog and first-use tool-permission prompts ONCE
 * at the new path, both of which this codebase already auto-answers for a
 * supervised agent (`chooseStartupAnswer`, src/agents/prompt.ts; the lizard
 * mode permission loop, src/agents/permission-answer-loop.ts) — nothing like
 * the silent, undetectable memory loss the slug move exists to prevent.
 */
export function migrateClaudeSettingsEntry(oldCwd: string, newCwd: string, claudeJsonPath: string): ClaudeSettingsMigrationResult {
  const oldKey = resolve(oldCwd);
  const newKey = resolve(newCwd);
  if (oldKey === newKey) return { outcome: "already-migrated", claudeJsonPath };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "no-old-entry", claudeJsonPath };
    throw new Error(`migrateClaudeSettingsEntry: could not read/parse ${claudeJsonPath}: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error(`migrateClaudeSettingsEntry: ${claudeJsonPath} did not contain a JSON object`);
  const obj = raw as Record<string, unknown>;
  const projects = obj.projects;
  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return { outcome: "no-old-entry", claudeJsonPath };
  const projectsObj = projects as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(projectsObj, oldKey)) return { outcome: "no-old-entry", claudeJsonPath };

  const existingNew = projectsObj[newKey];
  const isNonEmptyObject = (v: unknown): boolean => typeof v === "object" && v !== null && Object.keys(v).length > 0;
  if (isNonEmptyObject(existingNew)) {
    throw new Error(`refusing to migrate Claude Code settings entry ${JSON.stringify(oldKey)} -> ${JSON.stringify(newKey)} in ${claudeJsonPath}: target entry already exists and is non-empty (source left untouched)`);
  }
  projectsObj[newKey] = projectsObj[oldKey];
  delete projectsObj[oldKey];
  writeFileSync(claudeJsonPath, JSON.stringify(obj, null, 2));
  return { outcome: "moved", claudeJsonPath };
}

/**
 * One `<root>/<provider>/<ruleId>/<leaf>` directory as found on disk by a
 * real filesystem walk (`scripts/migrate-workspace-layout.ts`'s own job —
 * including the `readBookkeptAgentKey` read — never done here, so this
 * function stays pure I/O-free and exhaustively unit-testable). `stampedKey`
 * is that read's result, or `null` for a directory with no bookkeeping
 * stamp at all (an old-layout, not-yet-migrated workspace, or something
 * foreign). Trusted as-is here, WITHOUT re-deriving Addendum A6's fuller
 * "is this leaf one of the key's own legitimate forms" check
 * (`agentIdOfWorkspacePath`'s own, src/agents/workspace.ts) — a
 * mis-attributed plan line is still safe because `migrateWorkspaceLayout`
 * independently re-derives and re-validates everything before touching a
 * single file (never overwrites a non-empty target, computes its own
 * `newLayoutDirFor` fresh); this function only decides what to PROPOSE.
 */
export interface DiscoveredLeaf { provider: string; ruleId: string; leaf: string; stampedKey: string | null }

export interface MigrationPlanItem {
  key: string;
  oldDir: string;
  newDir: string;
  /**
   * "migrate": oldDir differs from newDir and no live pane has oldDir as its
   * cwd — safe to call `migrateWorkspaceLayout` now. "no-change": the leaf
   * already computes to itself (an identity-short-id provider, per
   * Addendum A1, or already migrated) — nothing to do, and
   * `migrateWorkspaceLayout` would no-op anyway, but the plan says so
   * up front so an operator isn't left wondering why a line did nothing.
   * "skip-live": Addendum A5 — a live pane has this exact directory as its
   * cwd right now; renaming under it is never safe, so this workspace is
   * left at its OLD path for this run (still fully recognised there,
   * `agentIdOfWorkspacePath`'s own step 2) and reconsidered on the NEXT run
   * once the agent is no longer live at that path.
   */
  action: "migrate" | "no-change" | "skip-live";
}

/**
 * The pure decision half of the operator-facing migration
 * (`scripts/migrate-workspace-layout.ts`): given every leaf directory a real
 * filesystem walk of `root` found (`leaves`) and the set of directories a
 * REAL herdr `agent.list()` reports as a live pane's cwd right now
 * (`livePaths`, resolved absolute paths), decides what each one needs
 * without touching a single file. No I/O, so this is exhaustively unit
 * tested; the script itself only walks the disk, queries herdr, prints this
 * plan, and (only with `--execute`) calls `migrateWorkspaceLayout` for each
 * `"migrate"` line — never for `"no-change"` or `"skip-live"`.
 *
 * A leaf with NO resolvable key (a foreign directory Addendum A6 says must
 * never be adopted: neither a bookkeeping stamp, nor a legacy-encoded
 * segment-decode) is silently absent from the plan — nothing to report,
 * nothing to migrate.
 */
export function planWorkspaceMigration(root: string, leaves: readonly DiscoveredLeaf[], livePaths: ReadonlySet<string>): MigrationPlanItem[] {
  const plan: MigrationPlanItem[] = [];
  for (const { provider, ruleId, leaf, stampedKey } of leaves) {
    const legacyKey = decodeAgentKey(`${provider}:${ruleId}:${leaf}`);
    const key = stampedKey ?? (legacyKey ? `${provider}:${ruleId}:${leaf}` : null);
    if (!key || !decodeAnyAgentKey(key)) continue; // unrecognised — never adopted (Addendum A6)
    const oldDir = join(root, provider, ruleId, leaf);
    const newDir = newLayoutDirFor(key, root);
    if (resolve(oldDir) === resolve(newDir)) { plan.push({ key, oldDir, newDir, action: "no-change" }); continue; }
    plan.push({ key, oldDir, newDir, action: livePaths.has(resolve(oldDir)) ? "skip-live" : "migrate" });
  }
  return plan;
}
