import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * BUTCHR-182 (implements BUTCHR-176): "which build is running" (BUTCHR-54's
 * `build-identity.ts`) is only half the question an agent needs answered —
 * it says nothing about whether that build is CURRENT. This module answers
 * that second half, kept deliberately separate from `build-identity.ts` so
 * that file's frozen-at-start singleton stays untouched: currency is a
 * point-in-time comparison, computed fresh at workspace-build time, not a
 * process-lifetime constant.
 *
 * GOVERNING RULE, same one `build-identity.ts` states for itself: "unknown"
 * with a stated reason is a correct answer; a plausible default is not.
 * Nothing in this module may throw — it runs on the agent-spawn path, and an
 * exception here would stop an agent being staffed at all. Every git call is
 * wrapped and time-bounded; every failure degrades to `unknown`.
 *
 * THE TWO SIDES OF THE COMPARISON, both traps:
 *  - RUNNING side is the caller-supplied sha, full stop — never re-read from
 *    a working tree near the daemon (`build-identity.ts` already froze it at
 *    process start specifically to prevent exactly that race).
 *  - BASE side is the LOCAL remote-tracking ref (`refs/remotes/origin/main`)
 *    — resolved through git, never fetched over the network (this runs on
 *    the spawn path; a network call here can hang a spawn). That means the
 *    base itself can be stale, which is why `current` is gated on the base's
 *    OWN freshness being determinable (Requirement 2, added after filing —
 *    see the comment inside `resolveCurrency`'s tree-equality branch): a base
 *    ref nobody has fetched in a week can compare byte-equal to a running
 *    build that is genuinely a hundred commits behind, and that must render
 *    `unknown`, never a false `current`.
 *
 * ONE DAEMON, NOT "THE FLEET" (Requirement 3, added after filing): a host
 * can run more than one butchr daemon, under different Unix users — measured
 * live on this ticket's own host. Every reader-facing string this module
 * produces describes THIS DAEMON's own build and THIS DAEMON's own local
 * checkout, never "the fleet" or "the deploy" — a currency claim is only
 * ever true for the one daemon that computed it.
 *
 * COMPARE BY CONTENT, NOT ANCESTRY: a squash merge makes
 * `git merge-base --is-ancestor` answer NO for a PR that landed perfectly
 * cleanly, and both merge styles occur in this repo. `resolveCurrency` below
 * decides `current` vs `stale` purely by comparing `<sha>^{tree}` hashes;
 * `git rev-list --count` ancestry is used only as SUPPLEMENTARY evidence
 * inside an already-`stale` verdict (commitsBehind/commitsAhead), never to
 * decide the verdict itself.
 */

/** One git operation's result: real data, or why it failed — never a thrown exception. */
export type GitOpResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Everything `resolveCurrency` needs from git, as an injected interface —
 * PURE over this, mirroring `build-identity.ts`'s `resolveSha`/`gitAtStart`
 * split, so the comparison logic is testable with fixtures that can express
 * the traps in the ticket (a squash-merged tree match with no ancestry;
 * divergence; every unknown-because path) without spawning real git.
 */
export interface CurrencyGit {
  /** `<ref>^{tree}` — the tree object hash `ref` points at. `ref` may be a full sha or a symbolic ref. */
  treeOf(ref: string): GitOpResult<{ tree: string }>;
  /** Resolve a ref (e.g. `refs/remotes/origin/main`) to the commit sha it currently points at. */
  resolveRef(ref: string): GitOpResult<{ sha: string }>;
  /**
   * Best-effort: when `ref`'s VALUE last CHANGED (its reflog entry, or the
   * loose ref file's mtime) — NEVER a guessed timestamp. NOT the same
   * question as `lastFetchedAt` below: a `git fetch` that changes nothing
   * does not touch this signal at all (measured live — see module doc
   * comment) — a ref that hasn't changed in a week looks identical whether
   * this host fetched five minutes ago or never fetched at all.
   */
  refChangedAt(ref: string): GitOpResult<{ iso: string }>;
  /**
   * Best-effort: when THIS checkout last talked to the network at all
   * (`FETCH_HEAD`'s mtime — updated on every `git fetch`, including a
   * no-op one that changes no ref). Answers the question `refChangedAt`
   * cannot: whether the comparison base could even in principle be newer
   * than what's recorded. Absent in a repository that has never fetched
   * (e.g. a ref set by `git update-ref` with no real remote) — that must
   * render as `unknown, because X`, never an omitted signal or a guess.
   */
  lastFetchedAt(): GitOpResult<{ iso: string }>;
  /** Count of commits reachable from `to` but not from `from` (`git rev-list --count from..to`) — supplementary evidence only, see module doc comment. */
  commitsBetween(from: string, to: string): GitOpResult<{ count: number }>;
}

const GIT_TIMEOUT_MS = 1500;

function run(dir: string, args: string[]): GitOpResult<{ out: string }> {
  try {
    const out = execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS }).trim();
    return { ok: true, out };
  } catch (e) {
    return { ok: false, error: (e as Error).message.split("\n")[0] ?? "git call failed" };
  }
}

/**
 * The real (impure) git reader, over `dir` — must be THIS SOURCE FILE'S own
 * resolved location (`MODULE_DIR` below), never `process.cwd()`, same
 * discipline `build-identity.ts`'s `realGitAtStart` documents for itself.
 * `git rev-parse`/`git log` search upward for `.git` on their own, so this
 * is correct whether `dir` sits inside a from-source checkout or (correctly
 * failing, never guessing) inside an npm-installed `dist/` with no `.git`
 * anywhere above it.
 */
/**
 * The git-common-dir (shared across worktrees) — where `refs/remotes/...`,
 * their reflogs, AND `FETCH_HEAD` all actually live. VERIFIED, not assumed:
 * in a real `git worktree add` checkout (this repo's own worktree layout,
 * per every agent's brief), `FETCH_HEAD` was measured living under
 * `--git-common-dir`, NOT the per-worktree `--git-dir` — a `git fetch` run
 * in one worktree updates `FETCH_HEAD` for every worktree sharing this
 * common dir, which is exactly the semantics `lastFetchedAt` wants (it asks
 * "did THIS CLONE fetch", not "did this specific worktree checkout fetch").
 */
function resolveGitCommonDir(dir: string): GitOpResult<{ path: string }> {
  const r = run(dir, ["rev-parse", "--git-common-dir"]);
  if (!r.ok) return r;
  return { ok: true, path: isAbsolute(r.out) ? r.out : join(dir, r.out) };
}

export function realCurrencyGit(dir: string): CurrencyGit {
  return {
    treeOf(ref) {
      const r = run(dir, ["rev-parse", "--verify", `${ref}^{tree}`]);
      return r.ok ? { ok: true, tree: r.out } : r;
    },
    resolveRef(ref) {
      const r = run(dir, ["rev-parse", "--verify", ref]);
      return r.ok ? { ok: true, sha: r.out } : r;
    },
    refChangedAt(ref) {
      const gitDir = resolveGitCommonDir(dir);
      if (!gitDir.ok) return { ok: false, error: `could not resolve the git directory to check ${ref}'s change time: ${gitDir.error}` };
      // The reflog file's mtime updates on every CHANGE to `ref`'s value,
      // even when the ref itself is packed (no loose `refs/...` file) — try
      // it first. Fall back to the loose ref file itself if no reflog file
      // exists (core.logAllRefUpdates off, or a bare/minimal clone). Neither
      // moves on a fetch that doesn't change `ref` — see `lastFetchedAt`.
      for (const candidate of [join(gitDir.path, "logs", ref), join(gitDir.path, ref)]) {
        try {
          return { ok: true, iso: statSync(candidate).mtime.toISOString() };
        } catch {
          // try the next candidate
        }
      }
      return { ok: false, error: `no reflog file or loose ref file found for ${ref} under ${gitDir.path} (likely packed, with reflogs disabled) — cannot determine when its value last changed without guessing` };
    },
    lastFetchedAt() {
      const gitDir = resolveGitCommonDir(dir);
      if (!gitDir.ok) return { ok: false, error: `could not resolve the git directory to check FETCH_HEAD: ${gitDir.error}` };
      const fetchHead = join(gitDir.path, "FETCH_HEAD");
      try {
        return { ok: true, iso: statSync(fetchHead).mtime.toISOString() };
      } catch (e) {
        return { ok: false, error: `no FETCH_HEAD under ${gitDir.path} — this checkout has apparently never fetched from a remote: ${(e as Error).message.split("\n")[0]}` };
      }
    },
    commitsBetween(from, to) {
      const r = run(dir, ["rev-list", "--count", `${from}..${to}`]);
      if (!r.ok) return r;
      const count = Number(r.out);
      return Number.isFinite(count) ? { ok: true, count } : { ok: false, error: `git rev-list --count returned non-numeric output: ${JSON.stringify(r.out)}` };
    },
  };
}

/** The local remote-tracking ref this module compares the running build against. Never fetched — see module doc comment. */
export const BASE_REF = "refs/remotes/origin/main";

/** What `resolveCurrency` needs to know about the running build — a structural SUBSET of `build-identity.ts`'s `BuildIdentity`, declared locally (not imported) so this module has zero runtime dependency on that one. */
export interface RunningBuild {
  sha: string | null;
  shaDirty: boolean | null;
  shaUnknownReason: string | null;
}

/**
 * What the comparison base resolved to, carried on both `current` and
 * `stale` verdicts (never on `unknown` — if the base couldn't be resolved,
 * the verdict IS `unknown`, with that failure as the reason).
 *
 * TWO DISTINCT TIMESTAMPS, ON PURPOSE — a review finding on this ticket's
 * own PR (added after `current`'s freshness gate first shipped): a `git
 * fetch` that changes nothing does NOT touch `ref`'s reflog or ref file, so
 * `changedAt` alone cannot distinguish "this host hasn't fetched in a week"
 * (verdict worthless) from "this host fetches constantly but `main` simply
 * hasn't moved" (verdict perfect) — both render an identical `changedAt`.
 * `fetchedAt` (from `FETCH_HEAD`, which DOES move on every fetch, no-op or
 * not) is the signal that actually answers "how stale could this be".
 */
export interface ResolvedBase {
  ref: string;
  sha: string;
  /** Best-effort ISO timestamp of when `ref`'s VALUE last changed — `null` (with a reason, never a guess) when undeterminable. NOT "when this host last fetched" — see the interface doc comment. */
  changedAt: string | null;
  changedAtUnknownReason: string | null;
  /** Best-effort ISO timestamp of when this checkout last fetched from a remote AT ALL (`FETCH_HEAD`'s mtime) — `null` (with a reason, never a guess) when undeterminable, e.g. a checkout that has never fetched. */
  fetchedAt: string | null;
  fetchedAtUnknownReason: string | null;
}

export type CurrencyVerdict =
  | { status: "current"; base: ResolvedBase; dirtyUndeterminable: boolean }
  | {
      status: "stale";
      /** Commits on the base not reachable from the running sha. `null` when the ancestry count itself could not be determined — this NEVER changes `stale` back to `unknown`, since the tree comparison that decided `stale` already succeeded; it only means the count is unavailable. */
      commitsBehind: number | null;
      /** Commits on the running sha not reachable from the base. `0` is load-bearing: render "behind by N" ONLY when this is exactly `0` — anything else (including `null`, unknown) must render as diverged/undetermined, never "behind". */
      commitsAhead: number | null;
      base: ResolvedBase;
      dirtyUndeterminable: boolean;
    }
  | { status: "unknown"; reason: string };

/**
 * PURE given `running` and an injected `git` — mirrors `resolveSha`'s shape.
 * See the module doc comment for the two traps (content-not-ancestry,
 * no-network) this function's structure exists to avoid.
 */
export function resolveCurrency(running: RunningBuild, git: CurrencyGit): CurrencyVerdict {
  if (running.sha === null) {
    return { status: "unknown", reason: `the running build's sha is itself unknown, so it cannot be compared to anything: ${running.shaUnknownReason ?? "no reason given"}` };
  }
  if (running.shaDirty === true) {
    return { status: "unknown", reason: "the running tree was dirty when its sha was captured, so that sha does not truthfully describe what is actually running" };
  }

  const baseRef = git.resolveRef(BASE_REF);
  if (!baseRef.ok) return { status: "unknown", reason: `no local ${BASE_REF} to compare against (never fetched over the network — see module doc comment): ${baseRef.error}` };
  const baseSha = baseRef.sha;

  const runningTree = git.treeOf(running.sha);
  if (!runningTree.ok) return { status: "unknown", reason: `running sha ${running.sha} has no readable tree in this repository (deployed from a different clone?): ${runningTree.error}` };

  const baseTree = git.treeOf(baseSha);
  if (!baseTree.ok) return { status: "unknown", reason: `${BASE_REF} (${baseSha}) has no readable tree: ${baseTree.error}` };

  const changedAt = git.refChangedAt(BASE_REF);
  const fetchedAt = git.lastFetchedAt();
  const base: ResolvedBase = {
    ref: BASE_REF,
    sha: baseSha,
    changedAt: changedAt.ok ? changedAt.iso : null,
    changedAtUnknownReason: changedAt.ok ? null : changedAt.error,
    fetchedAt: fetchedAt.ok ? fetchedAt.iso : null,
    fetchedAtUnknownReason: fetchedAt.ok ? null : fetchedAt.error,
  };
  const dirtyUndeterminable = running.shaDirty === null;

  if (runningTree.tree === baseTree.tree) {
    // REQUIREMENT 2 (added after filing, BUTCHR-182): a stale LOCAL base ref
    // must never compare byte-equal into a false `current`. If the base's
    // own freshness couldn't be established, `current` cannot be trusted —
    // this is the guard that makes `unknown` un-collapsible to `current`;
    // reverting either branch below to always fall through to `current` is
    // the mutation this ticket's own test suite must catch (a naive first
    // draft did exactly the `changedAt`-only version and shipped a false
    // `current` for a week-stale base).
    //
    // GATED ON BOTH SIGNALS, DELIBERATELY (review finding on this PR): a
    // `current` verdict's entire value is "you can trust this daemon's code
    // matches the base" — but `changedAt` alone cannot bound how stale the
    // LOCAL COPY of the base ref itself might be (a fetch that changes
    // nothing never touches it, so it cannot distinguish "fetched five
    // minutes ago, unchanged" from "never fetched, unchanged"). Requiring
    // `fetchedAt` too closes that exact ambiguity for the one verdict whose
    // whole purpose is trustworthiness; `stale`/`diverged` below are NOT
    // gated on it, because a "this daemon is stale/diverged" verdict is
    // already the honest, actionable answer even if the fetch-recency of
    // the comparison base is itself unknown — it isn't a trust claim in the
    // way `current` is.
    if (!changedAt.ok) {
      return {
        status: "unknown",
        reason: `this daemon's build matches ${BASE_REF} content-for-content, but that base's own change-time could not be established, so a current verdict cannot be trusted here: ${changedAt.error}`,
      };
    }
    if (!fetchedAt.ok) {
      return {
        status: "unknown",
        reason: `this daemon's build matches ${BASE_REF} content-for-content, and that ref's own change-time is known, but this checkout's own last-fetch time could not be established — without it there's no way to bound how stale the local copy of ${BASE_REF} itself might be, so a current verdict cannot be trusted here: ${fetchedAt.error}`,
      };
    }
    return { status: "current", base, dirtyUndeterminable };
  }

  const behind = git.commitsBetween(running.sha, baseSha); // commits on base, not on running
  const ahead = git.commitsBetween(baseSha, running.sha); // commits on running, not on base
  return {
    status: "stale",
    commitsBehind: behind.ok ? behind.count : null,
    commitsAhead: ahead.ok ? ahead.count : null,
    base,
    dirtyUndeterminable,
  };
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Compute currency for `running` against the real, local git state — the
 * function `src/agents/workspace.ts`'s `buildWorkspace` actually calls.
 * Wrapped defensively: `resolveCurrency` over `realCurrencyGit` should
 * already never throw (every git call is caught inside `run`), but this
 * outer catch is the hard backstop the ticket demands — nothing on the
 * spawn path may ever throw out of this module.
 */
export function computeBuildCurrency(running: RunningBuild): CurrencyVerdict {
  try {
    return resolveCurrency(running, realCurrencyGit(MODULE_DIR));
  } catch (e) {
    return { status: "unknown", reason: `currency check failed unexpectedly: ${(e as Error).message}` };
  }
}

/** Subset of `BuildIdentity` this module's renderer needs — declared locally, same no-import discipline as `RunningBuild` above. */
export interface BuildSummary {
  sha: string | null;
  shaProvenance: "baked" | "git-at-start" | null;
  shaDirty: boolean | null;
  version: string;
}

const shortSha = (sha: string): string => sha.slice(0, 8);

/**
 * Render `build` + `currency` as plain reader-facing prose lines, for
 * `groundTruthText` (src/agents/ground-truth.ts) to splice next to its
 * existing host/port/pid lines.
 *
 * THE LOAD-BEARING GUARANTEE: the `unknown` branch's rendering must never
 * contain the word `CURRENT` — the literal token the `current` branch's
 * rendering uses — so a reader skimming for that word cannot mistake one
 * for the other. Pinned by a test asserting exactly this; do not let a
 * shared helper string reintroduce the word into both branches.
 */
export function renderBuildCurrencyLines(build: BuildSummary, currency: CurrencyVerdict): string[] {
  const shaText = build.sha ? `${shortSha(build.sha)} (full: ${build.sha})` : "unknown";
  const dirtyText = build.shaDirty === true ? "dirty" : build.shaDirty === false ? "clean" : "dirty-flag unknown";
  // First person, about THIS daemon specifically (Requirement 3): a host can
  // run more than one butchr daemon, and this line must never be read as a
  // claim about any of them but the one that wrote this workspace.
  const lines: string[] = [`- this daemon's build: ${shaText}, provenance ${build.shaProvenance ?? "unknown"}, tree ${dirtyText}, version ${build.version}`];

  if (currency.status === "unknown") {
    lines.push(`- currency: UNKNOWN — ${currency.reason}`);
    return lines;
  }

  const dirtyQualifier = currency.dirtyUndeterminable ? " (the running tree's dirty flag could not be determined)" : "";
  const baseTag = `${currency.base.ref} (${shortSha(currency.base.sha)})`;

  if (currency.status === "current") {
    lines.push(`- currency: CURRENT — matches ${baseTag} content-for-content${dirtyQualifier}`);
  } else if (currency.commitsAhead === 0) {
    lines.push(`- currency: STALE — behind ${baseTag} by ${currency.commitsBehind ?? "an unknown number of"} commit(s)${dirtyQualifier}`);
  } else if (currency.commitsAhead !== null && currency.commitsAhead > 0) {
    lines.push(`- currency: DIVERGED from ${baseTag} — ahead by ${currency.commitsAhead}, behind by ${currency.commitsBehind ?? "an unknown number of"} commit(s)${dirtyQualifier}`);
  } else {
    lines.push(`- currency: STALE relative to ${baseTag} — content differs; ahead/behind commit counts unavailable${dirtyQualifier}`);
  }

  // Two DISTINCT signals, worded so neither can be misread as the other —
  // see ResolvedBase's own doc comment for why a fetch that changes nothing
  // never moves `changedAt`, so `changedAt` alone cannot tell a reader
  // whether this checkout is actually keeping up.
  const changedText = currency.base.changedAt ? `its value last changed ${currency.base.changedAt}` : `its value's last-change time is unknown (${currency.base.changedAtUnknownReason})`;
  const fetchedText = currency.base.fetchedAt
    ? `this checkout last fetched from a remote at all ${currency.base.fetchedAt}`
    : `this checkout's last-fetch time is unknown (${currency.base.fetchedAtUnknownReason})`;
  lines.push(
    `- comparison base: ${currency.base.ref} — ${changedText}; ${fetchedText}. Both read from THIS DAEMON's own local checkout, never fetched over the network for this check, and never a claim about any other daemon that may also be running on this host. The verdict above reflects only what this daemon's checkout of main already had, not main right now.`,
  );
  return lines;
}
