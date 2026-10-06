/**
 * FACTORY-669 (epic FACTORY-659, slice T1; agentsafety-accepted design,
 * director 2026-10-05 12:30 PDT) — the ONE place a brand-new butchr install
 * gets its first rule. The web UI (FACTORY-663) cannot CREATE a rule, only
 * edit/enable one the web write path (FACTORY-662) is already allowed to
 * touch (any `ui-`-prefixed id, `../rules/rules-write-registry.ts`'s own
 * `UI_EDITABLE_ID_PREFIX`), so a fresh install needs one such rule to
 * already exist, disabled, before the dashboard has anything to show.
 * `seedFirstRunRules` is that seed. Called ONCE, inline, from
 * `src/daemon/index.ts`'s own startup, BEFORE `loadRules` runs for real —
 * never from an HTTP route, an MCP tool, a reload, or a file watcher. No
 * other call site exists anywhere in this codebase, which is what makes
 * "deleting the file while the daemon runs does not recreate it" true: there
 * is simply nothing else that ever calls this.
 *
 * TRUE FIRST RUN, all three or no seed (agentsafety constraint 1):
 *   1. the DEFAULT rules path (`rulesPath(env)`, `env.BUTCHR_RULES_FILE`
 *      UNSET) has nothing at it — no file, no symlink, nothing `lstat` can
 *      see;
 *   2. `BUTCHR_RULES_FILE` is unset. An explicit, missing override stays
 *      today's error — `loadRules` throws for that case, exactly as before
 *      this ticket — so this function refuses to even look at the question
 *      when it's set, rather than risk seeding under an override path no
 *      operator asked it to manage;
 *   3. no prior state: no `<basename>.bak-*` entry (the exact shape
 *      `./write-rules.ts`'s own `uniqueBackupId`/`pruneBackups` produce)
 *      sits in the rules directory. A backup with no current file is a
 *      DIFFERENT condition from a true first run — something wrote a rules
 *      file before and it is gone now — reported back as
 *      `"vanished-established-install"` instead of seeded.
 *
 * WRITE (constraint 2): through `./write-rules.ts`'s `createRulesFileExclusive`
 * — true no-clobber, dir 0700, file 0600, fsync'd, validated through
 * `loadRules` before anything touches disk, same discipline every other
 * writer in this codebase follows.
 *
 * FAILURE (constraint 3's "seed failure" case): caught here, reported back
 * as `"seed-failed"`, never thrown — `src/daemon/index.ts`'s own subsequent
 * `loadRules` call then sees the same "missing" state it always has, and the
 * daemon starts with no rules exactly as if this module did not exist.
 *
 * Logging/alerting (constraint 4) is the CALLER's job, not this module's:
 * `src/daemon/index.ts` is the only place that can actually raise an ops
 * alert (its `opsAlertRouter` is constructed later in that same file's
 * startup sequence, after the Rocket.Chat credential is resolved, which is
 * well after rules load at the top), so this function stays a pure decision
 * + write, returning a typed outcome the caller logs/alerts from.
 */
import { basename, dirname } from "node:path";
import { createRulesFileExclusive, defaultIo, type WriteRulesIo } from "./write-rules.js";
import { rulesPath, PLACEHOLDER_QUERY, type RulesEnv } from "./rules.js";
import { FIRST_RULE_ID } from "./rules-write-registry.js";

export type FirstRunSeedOutcome =
  /** Seeded `path` with the one template rule below. */
  | { kind: "seeded"; path: string }
  /** Not a first run at all (the default path already has something at it) or an explicit `BUTCHR_RULES_FILE` is set — ordinary operation, nothing for the caller to say. */
  | { kind: "not-first-run" }
  /** Default path absent, no override, but a `.bak-*` entry proves this install had a rules file before — no seed; the caller warns and alerts. */
  | { kind: "vanished-established-install"; path: string }
  /** True first run, but the write itself failed (e.g. a read-only config dir) — no seed; the caller warns. The daemon starts with no rules, same as a plain missing file. */
  | { kind: "seed-failed"; path: string; error: string };

/** Escapes `s` for safe interpolation into a `RegExp` source string — same helper `./write-rules.ts` keeps privately for its own backup-name matching. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `dir` holds any `<baseName>.bak-*` entry — the exact prefix `./write-rules.ts`'s own backups are named with (its own `BACKUP_ID_PATTERN` further constrains the suffix; a prefix match alone is enough here, since any match at all means "this install wrote a rules file before"). */
function hasPriorBackup(dir: string, baseName: string, io: WriteRulesIo): boolean {
  const re = new RegExp(`^${escapeRegExp(baseName)}\\.bak-`);
  return io.listDir(dir).some((name) => re.test(name));
}

/**
 * The template's fixed shape (agentsafety-reviewed, this ticket's own PR
 * description carries the `permissionMode`/`lizardMode`/`agentPreferences`
 * reasoning): one `jira-work` rule, `enabled: false`, query set to the
 * sentinel `PLACEHOLDER_QUERY` (so an enable before it's edited is refused —
 * see `../rules/rules-write.ts`), `execution: "singleton"` per the director's
 * own decision text on this ticket (its own staffing comment flagged that
 * PR #650's e2e fixture instead used `"swarm"` for its fixed-fields check;
 * both validate and both are equally inert while the rule stays disabled —
 * `singleton`'s own spawn-side reconciliation is BUTCHR-398, not yet wired —
 * so this seed follows the decision's literal text and flags the fixture
 * discrepancy for agentsafety/a reviewer to settle, rather than silently
 * picking the OTHER value), `account: "none"`, `role: "worker"`.
 */
function templateRuleDoc(): string {
  const doc = {
    rules: [
      {
        id: FIRST_RULE_ID,
        enabled: false,
        resourceProvider: "jira-work",
        query: PLACEHOLDER_QUERY,
        brief:
          "Placeholder brief seeded by butchr's first-run template (FACTORY-669) — not yet a real instruction to anyone. Open the dashboard, edit this rule's query and this brief to describe real work, then enable it.",
        execution: "singleton",
        account: "none",
        role: "worker",
        agentPreferences: [{ harness: "claude", model: "sonnet", effort: "low" }],
        permissionMode: "default",
        lizardMode: true,
      },
    ],
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

export function seedFirstRunRules(env: RulesEnv, io: WriteRulesIo = defaultIo()): FirstRunSeedOutcome {
  if (env.BUTCHR_RULES_FILE?.trim()) return { kind: "not-first-run" };

  const path = rulesPath(env);
  const dir = dirname(path);
  const baseName = basename(path);

  const somethingAtPath = io.isSymlink(path) || io.readFile(path) !== undefined;
  if (somethingAtPath) return { kind: "not-first-run" };

  if (hasPriorBackup(dir, baseName, io)) return { kind: "vanished-established-install", path };

  try {
    createRulesFileExclusive(path, templateRuleDoc(), io);
    return { kind: "seeded", path };
  } catch (e) {
    return { kind: "seed-failed", path, error: (e as Error).message };
  }
}
