import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
   * Best-effort: when this CLONE last fetched `branch` FROM `remote` —
   * deliberately NOT "when did this checkout last fetch anything".
   *
   * BUTCHR-163 — the narrower question is the whole point, because the
   * broad one is wrong in BOTH directions and one of them is dangerous:
   *
   *  - UNDERSTATES (safe): `FETCH_HEAD` is PER-WORKTREE, so a fetch in a
   *    linked worktree never touches the common dir's copy. Reading only
   *    the common dir missed real fetches. See `resolveGitCommonDir`.
   *  - OVERSTATES (DANGEROUS, and this shipped): `FETCH_HEAD`'s mtime moves
   *    for ANY fetch — a different remote, an explicit URL — while
   *    `refs/remotes/origin/main` stays put. Measured: after `git fetch
   *    other`, the mtime was fresh while origin/main was genuinely stale.
   *    A content match against that stale base then walked the gate to a
   *    false `current`, with "fetched moments ago" rendered beside it.
   *    **That is precisely the bug the freshness gate exists to prevent.**
   *
   * So this must be derived, never read as a bare mtime: `FETCH_HEAD`'s
   * CONTENT records the source of every line, which is what makes the
   * narrow question answerable at all. Implementation in
   * `realCurrencyGit`.
   *
   * When no evidence qualifies — a clone that never fetched this branch
   * from this remote, or one whose records cannot be read — this MUST
   * report `ok: false` with the reason, so the caller renders
   * `unknown, because X`. **Never a bare mtime, never a guessed figure:**
   * a number that is confidently wrong here is worse than no number,
   * because a reader cannot tell it is wrong.
   */
  lastFetchedAt(remote: string, branch: string): GitOpResult<{ iso: string }>;
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
 * The git-common-dir — where `refs/remotes/...` and their reflogs actually
 * live, SHARED across every worktree of this clone.
 *
 * CORRECTION (BUTCHR-163). An earlier version of this comment claimed, as
 * measured, that `FETCH_HEAD` also lives here, so that "a `git fetch` run in
 * one worktree updates `FETCH_HEAD` for every worktree sharing this common
 * dir". **That is FALSE.** Re-measured by controlled experiment on git
 * 2.43.0, and independently reproduced: a `git fetch` run inside a linked
 * worktree CREATES `<common-dir>/worktrees/<name>/FETCH_HEAD` and leaves the
 * common-dir `FETCH_HEAD` untouched. In a fresh clone the common-dir
 * `FETCH_HEAD` does not exist at all.
 *
 * The likeliest origin of the wrong claim: it was measured in a MAIN
 * checkout, where `--git-dir` and `--git-common-dir` are the same path — so
 * the very distinction it meant to test could not appear. A fixture whose
 * starting state cannot express the thing under test proves nothing.
 *
 * THE ASYMMETRY IS THE BUG, and it is why `lastFetchedAt` below cannot be a
 * bare mtime of this directory's `FETCH_HEAD`:
 *   - `logs/refs/remotes/origin/main`  -> COMMON dir    (shared)
 *   - `FETCH_HEAD`                     -> PER-WORKTREE  (not shared)
 * So `refChangedAt` sees a worktree's fetch and `lastFetchedAt` did not —
 * understating fetch recency without bound. Measured live on this fleet:
 * agents routinely fetch inside their own linked worktrees.
 */
function resolveGitCommonDir(dir: string): GitOpResult<{ path: string }> {
  const r = run(dir, ["rev-parse", "--git-common-dir"]);
  if (!r.ok) return r;
  return { ok: true, path: isAbsolute(r.out) ? r.out : join(dir, r.out) };
}

/**
 * Compare remote URLs by content, not by spelling.
 *
 * MEASURED, BUTCHR-163 — this is not defensive tidying, it is load-bearing:
 * git STRIPS a trailing `.git` when it records a fetch source in
 * `FETCH_HEAD`. On this repo, `remote.origin.url` is
 * `https://github.com/brooswit-factory/butchr.git` while **0 of 273**
 * `FETCH_HEAD` lines carry that suffix. So a naive string equality matches
 * NOTHING and every verdict degrades to `unknown` —
 * **and that failure is invisible**, because it renders as a principled
 * "could not check", indistinguishable from the honest one this module
 * exists to produce. A permanent false `unknown` is not an improvement on a
 * false `current`; it is the same disease with better manners.
 */
export function normaliseRemoteUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

/**
 * Does this `FETCH_HEAD` body record `branch` fetched from `wantUrl`?
 *
 * Line format, both shapes measured in this repo's own file:
 *   `<sha>\t\tbranch 'BUTCHR-144' of https://github.com/owner/repo`
 *   `<sha>\tnot-for-merge\tbranch 'main' of https://github.com/owner/repo`
 * The middle field is EMPTY for the for-merge line, so split on tabs and
 * tolerate an empty column — splitting on whitespace mis-parses both.
 *
 * A clone fetches many branches, so most lines legitimately name something
 * other than `branch`. Filtering them out is the correct behaviour, never an
 * error condition.
 */
export function fetchHeadNames(content: string, wantUrl: string, branch: string): boolean {
  for (const line of content.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const m = /^branch '(.+)' of (.+)$/.exec(fields[2]!.trim());
    if (m && m[1] === branch && normaliseRemoteUrl(m[2]!) === wantUrl) return true;
  }
  return false;
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
    lastFetchedAt(remote, branch) {
      const gitDir = resolveGitCommonDir(dir);
      if (!gitDir.ok) return { ok: false, error: `could not resolve the git directory to check FETCH_HEAD: ${gitDir.error}` };

      const configured = run(dir, ["config", "--get", `remote.${remote}.url`]);
      if (!configured.ok) return { ok: false, error: `could not read remote.${remote}.url, so no FETCH_HEAD record can be attributed to ${remote}: ${configured.error}` };
      const wantUrl = normaliseRemoteUrl(configured.out);

      // Candidates: the common dir AND every linked worktree's git-dir.
      // Read from the filesystem rather than `git worktree list` on purpose —
      // this runs on the agent-spawn path, and this clone has been measured
      // with 78 linked worktrees; that is 78 file reads, never 78 subprocesses.
      const candidates = [join(gitDir.path, "FETCH_HEAD")];
      try {
        for (const name of readdirSync(join(gitDir.path, "worktrees"))) candidates.push(join(gitDir.path, "worktrees", name, "FETCH_HEAD"));
      } catch {
        // No `worktrees/` directory: a clone with no linked worktrees. Not an
        // error — the common dir's own FETCH_HEAD is still a valid candidate.
      }

      let newest: number | null = null;
      let scanned = 0;
      for (const candidate of candidates) {
        let content: string;
        let mtimeMs: number;
        try {
          content = readFileSync(candidate, "utf8");
          mtimeMs = statSync(candidate).mtimeMs;
        } catch {
          continue; // this worktree never fetched; absence is not an error
        }
        scanned++;
        // A FETCH_HEAD is evidence about `branch` from `remote` only if the
        // fetch that WROTE it recorded that branch from that URL. The file is
        // overwritten wholesale on every fetch, so its mtime describes only
        // its current content — which is exactly what makes this check sound.
        if (fetchHeadNames(content, wantUrl, branch) && (newest === null || mtimeMs > newest)) newest = mtimeMs;
      }

      if (newest === null) {
        return {
          ok: false,
          error:
            scanned === 0
              ? `no readable FETCH_HEAD in ${gitDir.path} or any of its worktrees — this clone has apparently never fetched from a remote`
              : `scanned ${scanned} FETCH_HEAD record(s) under ${gitDir.path} and none recorded branch '${branch}' from ${wantUrl} — this clone's most recent fetches were of something else, so none of them bounds how stale ${remote}/${branch} is here`,
        };
      }
      return { ok: true, iso: new Date(newest).toISOString() };
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

/**
 * `BASE_REF`'s two halves, named separately because `lastFetchedAt` has to
 * ask about them individually: "did this clone fetch BRANCH from REMOTE".
 * Kept beside `BASE_REF` so the three can never drift apart.
 */
export const BASE_REMOTE = "origin";
export const BASE_BRANCH = "main";

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
  /**
   * Best-effort ISO timestamp of when this clone last fetched **`ref`'s own
   * branch from its own remote** — NOT "when it last fetched anything".
   *
   * BUTCHR-163 narrowed this deliberately. It was the mtime of a single
   * `FETCH_HEAD`, which answered the broad question and was wrong in both
   * directions: it missed fetches made in linked worktrees (that file is
   * per-worktree), and it counted a fetch of an unrelated remote as freshness
   * for this base — which walked the gate to a false `current`. See
   * `CurrencyGit.lastFetchedAt` for the derivation that replaced it.
   *
   * `null` (with a reason, never a guess) when undeterminable — including the
   * now-ordinary case of a clone whose recent fetches were all of something
   * else. That is a genuine could-not-check, not a defect.
   */
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
  const fetchedAt = git.lastFetchedAt(BASE_REMOTE, BASE_BRANCH);
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

  // BUTCHR-163, decision (i): the base's own age goes ON THE VERDICT LINE,
  // inseparable from the verdict itself.
  //
  // The gate below only checks that the two freshness signals can be READ,
  // never that they are RECENT — nothing compares either age to anything. So
  // a clone that last fetched the base a week ago still renders `CURRENT`.
  // That is deliberate, and the alternative was considered and DECLINED:
  //
  //   A staleness THRESHOLD would be a judgement about whether being behind
  //   is a FAULT, and being behind is not always a fault — a deliberate pin,
  //   a paused deploy during an incident, and a rollback are all legitimate
  //   states in which a daemon SHOULD be behind. A check that cannot tell
  //   "behind because the deploy broke" from "behind on purpose" is a
  //   crying-wolf alert, and this estate has already paid for one. The right
  //   threshold would also depend on the deploy cadence, which was measured
  //   (BUTCHR-274) as "whenever a person acts" — there is no number to pick.
  //
  // So: report what was OBSERVED, and leave what it MEANS to the reader —
  // but put the observation where a reader skimming for the word `CURRENT`
  // cannot miss it. Rendering it only in the trailing `comparison base:`
  // sentence (as this module did before) is not enough: that sentence is
  // after the verdict, and the skimming reader never reaches it.
  const baseAge = currency.base.fetchedAt ? `base last fetched ${currency.base.fetchedAt}` : `BASE FRESHNESS UNKNOWN (${currency.base.fetchedAtUnknownReason})`;

  if (currency.status === "current") {
    lines.push(`- currency: CURRENT — matches ${baseTag} content-for-content, ${baseAge}${dirtyQualifier}`);
  } else if (currency.commitsAhead === 0) {
    lines.push(`- currency: STALE — behind ${baseTag} by ${currency.commitsBehind ?? "an unknown number of"} commit(s), ${baseAge}${dirtyQualifier}`);
  } else if (currency.commitsAhead !== null && currency.commitsAhead > 0) {
    lines.push(`- currency: DIVERGED from ${baseTag} — ahead by ${currency.commitsAhead}, behind by ${currency.commitsBehind ?? "an unknown number of"} commit(s), ${baseAge}${dirtyQualifier}`);
  } else {
    lines.push(`- currency: STALE relative to ${baseTag} — content differs; ahead/behind commit counts unavailable, ${baseAge}${dirtyQualifier}`);
  }

  // Two DISTINCT signals, worded so neither can be misread as the other —
  // see ResolvedBase's own doc comment for why a fetch that changes nothing
  // never moves `changedAt`, so `changedAt` alone cannot tell a reader
  // whether this checkout is actually keeping up.
  const changedText = currency.base.changedAt ? `its value last changed ${currency.base.changedAt}` : `its value's last-change time is unknown (${currency.base.changedAtUnknownReason})`;
  const fetchedText = currency.base.fetchedAt
    ? `this checkout last fetched that base branch from its remote ${currency.base.fetchedAt}`
    : `this checkout's last-fetch time FOR THAT BASE BRANCH is unknown (${currency.base.fetchedAtUnknownReason})`;
  lines.push(
    `- comparison base: ${currency.base.ref} — ${changedText}; ${fetchedText}. Both read from THIS DAEMON's own local checkout, never fetched over the network for this check, and never a claim about any other daemon that may also be running on this host. The verdict above reflects only what this daemon's checkout of main already had, not main right now.`,
  );
  return lines;
}
