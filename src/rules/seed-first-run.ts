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
 * TRUE FIRST RUN, all four or no seed (agentsafety constraint 1):
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
 *   4. (FACTORY-685, L1) the rules directory is either absent or genuinely
 *      EMPTY — not merely "has no rules.json". A directory that already
 *      holds OTHER state (`session-definitions/`, `project-managers/`,
 *      `secrets/`, anything) but no rules file and no `.bak-*` is an
 *      established install some OTHER way (its rules file was never this
 *      module's concern, or a provisioning step ran before rules.json was
 *      ever written) — not a fresh config dir either. Reported back as
 *      `"config-dir-not-empty"`, no seed.
 *
 * WRITE (constraint 2): through `./write-rules.ts`'s `createRulesFileExclusive`
 * — true no-clobber, file 0600, fsync'd, validated through `loadRules`
 * before anything touches disk, same discipline every other writer in this
 * codebase follows. The directory is created at 0700 ONLY when this call
 * itself creates it (FACTORY-685, L2) — an existing directory's permissions
 * are left exactly as found, never narrowed (the pre-fix bug: a pre-existing
 * `0755` dir silently became `0700`) and never widened either (a
 * pre-existing `0500` dir does NOT become `0700`); see
 * `createRulesFileExclusive`'s own doc comment for the warning surfaced when
 * an existing dir is already wider than `0700`.
 *
 * FAILURE (constraint 3's "seed failure" case, FACTORY-685 L3: ANY failure
 * reading or deciding, not just the write itself): the WHOLE body below —
 * every `io` call, not only `createRulesFileExclusive` — runs inside one
 * `try`. Nothing may throw out of `seedFirstRunRules`: a directory sitting
 * at the rules path, an unreadable file, `ENOTDIR`, `EACCES` on `listDir`,
 * all land on `"seed-failed"`, never propagate — this function is called
 * inline from `src/daemon/index.ts`'s own startup, BEFORE `loadRules` runs
 * for real, so a throw here would take the whole daemon down before it ever
 * got to serve anything. The caller's subsequent `loadRules` call then sees
 * the same "missing" state it always has, and the daemon starts with no
 * rules exactly as if this module did not exist.
 *
 * This "nothing else ever calls this" property (what makes "deleting the
 * file while the daemon runs does not recreate it" true) holds only for the
 * lifetime of ONE daemon process: a RESTART with the rules file absent and
 * no `.bak-*` in the directory is, by this function's own definition, a true
 * first run again, and seeds again. "Never recreates" is a per-process
 * guarantee, not a permanent one.
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
  /** Seeded `path` with the one template rule below. `dirPermissionsWarning`, when present (FACTORY-685, L2), means the rules directory already existed wider than mode 0700 — left untouched, but worth the caller surfacing. */
  | { kind: "seeded"; path: string; dirPermissionsWarning?: string }
  /** Not a first run at all (the default path already has something at it) or an explicit `BUTCHR_RULES_FILE` is set — ordinary operation, nothing for the caller to say. */
  | { kind: "not-first-run" }
  /** Default path absent, no override, but a `.bak-*` entry proves this install had a rules file before — no seed; the caller warns and alerts. */
  | { kind: "vanished-established-install"; path: string }
  /** FACTORY-685 (L1): default path absent, no override, no `.bak-*`, but the rules directory already holds OTHER entries — an established install some other way, not a fresh config dir; no seed, the caller warns and alerts. */
  | { kind: "config-dir-not-empty"; path: string }
  /** True first run, but the write itself failed (e.g. a read-only config dir), OR any other step in deciding whether to seed threw (FACTORY-685, L3: an unreadable file, a directory sitting at the rules path, ENOTDIR/EACCES) — no seed; the caller warns. The daemon starts with no rules, same as a plain missing file. */
  | { kind: "seed-failed"; path: string; error: string };

/** Escapes `s` for safe interpolation into a `RegExp` source string — same helper `./write-rules.ts` keeps privately for its own backup-name matching. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `dir` holds any `<baseName>.bak-*` entry — the exact prefix `./write-rules.ts`'s own backups are named with (its own `BACKUP_ID_PATTERN` further constrains the suffix; a prefix match alone is enough here, since any match at all means "this install wrote a rules file before"). */
function hasPriorBackup(dir: string, baseName: string, io: WriteRulesIo): boolean {
  const re = new RegExp(`^${escapeRegExp(baseName)}\\.bak-`);
  return io.listDir(dir).some((name) => re.test(name));
}

/** FACTORY-685 (L1): whether `dir` holds ANY entry at all. `io.listDir` already returns `[]` for an absent directory (see `defaultIo`'s own doc comment), so an absent dir and a genuinely empty one are indistinguishable here — both read as "no other state", which is exactly the "absent OR empty" condition this ticket asks for. Called only after the caller has already confirmed nothing sits at the rules path itself and no `.bak-*` entry exists, so any entry found here is neither of those — some OTHER file or subdirectory a prior provisioning step (or a hand-placed file) left behind. */
function hasOtherState(dir: string, io: WriteRulesIo): boolean {
  return io.listDir(dir).length > 0;
}

/**
 * The template's fixed shape (agentsafety-reviewed, this ticket's own PR
 * description carries the `permissionMode`/`lizardMode`/`agentPreferences`
 * reasoning): one `jira-work` rule, `enabled: false`, query set to the
 * sentinel `PLACEHOLDER_QUERY` (so an enable before it's edited is refused —
 * see `../rules/rules-write.ts`), `execution: "swarm"` (FACTORY-685,
 * agentsafety F1: the PREVIOUS seed wrote `"singleton"` here, paired with the
 * `brief: "@builtin:task"` below — a defect, not a deliberate pairing.
 * `singleton` runs ONE query agent with no `x-issue`, while `@builtin:task`
 * is a PER-TICKET brief that instructs its agent to `jira_get_issue` its own
 * ticket, `ask_boss`, and merge its own PR — none of which a singleton's one
 * query agent can do. `"swarm"` is the shape `docs/rules.example.json`'s own
 * `tasks` rule uses, and the one `@builtin:task` is actually written for: one
 * agent PER matching ticket, each with a real `x-issue`. `execution` stays a
 * fixed, UI-inert field either way while the rule is disabled — see
 * `rules-write-registry.ts`'s own header for why that's enforced by
 * allowlist omission, not a literal check — but a USER who edits the query
 * and enables the rule now gets agents that can actually follow their
 * brief), `account: "none"`, `role: "worker"`.
 *
 * `brief: "@builtin:task"` (manager-factory review on PR #652, 2026-10-05
 * 22:09 PDT): `brief` is FILE-ONLY — FACTORY-662's web write path
 * deliberately never lets the dashboard edit it — so a placeholder brief
 * text here would be a dead end: a user who edits the QUERY (the one field
 * the UI lets them touch) and enables the rule would still hand its worker
 * a "not yet a real instruction" placeholder forever. The shipped,
 * `loadRules`-validated task brief (`src/agents/workspace.ts`'s `BRIEF_BY_TYPE`,
 * the same one `docs/rules.example.json`'s own `tasks` rule uses) is a real,
 * reviewed instruction from the very first enable.
 */
function templateRuleDoc(): string {
  const doc = {
    rules: [
      {
        id: FIRST_RULE_ID,
        enabled: false,
        resourceProvider: "jira-work",
        query: PLACEHOLDER_QUERY,
        brief: "@builtin:task",
        execution: "swarm",
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

  // FACTORY-685 (L3): the WHOLE decide-and-write body lives inside this one
  // try — every `io` call, not just `createRulesFileExclusive` — so nothing
  // (a directory sitting at the rules path, an unreadable file, ENOTDIR,
  // EACCES on `listDir`) can ever throw out of this function. See this
  // file's own header for why that matters at this call site specifically.
  try {
    const somethingAtPath = io.isSymlink(path) || io.readFile(path) !== undefined;
    if (somethingAtPath) return { kind: "not-first-run" };

    if (hasPriorBackup(dir, baseName, io)) return { kind: "vanished-established-install", path };

    // FACTORY-685 (L1): absent-or-empty only — a dir already holding other
    // state (but no rules file, no backup) is an established install some
    // other way, not a fresh one.
    if (hasOtherState(dir, io)) return { kind: "config-dir-not-empty", path };

    let dirPermissionsWarning: string | undefined;
    createRulesFileExclusive(path, templateRuleDoc(), io, { onWarn: (message) => { dirPermissionsWarning = message; } });
    return dirPermissionsWarning !== undefined ? { kind: "seeded", path, dirPermissionsWarning } : { kind: "seeded", path };
  } catch (e) {
    return { kind: "seed-failed", path, error: (e as Error).message };
  }
}
