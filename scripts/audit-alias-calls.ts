/**
 * HALF A of BUTCHR-49/BUTCHR-63 — the committed, re-runnable command that
 * answers: "did any agent call a deprecated alias since the last respawn,
 * and was that call drift or sanctioned use?"
 *
 * Manual/operator check — NOT wired into `bun run check`, same reasoning as
 * its precedents scripts/verify-workspace-ground-truth.ts and
 * scripts/verify-spawn-effort.ts: it needs a real systemd unit and a real
 * journal to prove anything, which CI cannot promise.
 *
 * WHAT IT DOES, IN ORDER:
 *   1. `ss -ltne` (note: `-e`, not `-p` — this is the verified-unprivileged
 *      route: it prints a `uid:` and `cgroup:` field for EVERY listening
 *      socket, including ones owned by a different Unix user that an
 *      unprivileged `ss -ltnp` shows with no process at all). Never assumes
 *      a socket is a butchr daemon from its port — every listener gets a
 *      live GET to its own `http://localhost:<port>/health`, checked
 *      against the daemon's actual response shape (src/web/view.ts).
 *      Confirmed-daemon-shaped listeners are then split by unit name
 *      (`partitionCandidates`): a `butchr.service` unit is aggregated; any
 *      other unit (a different daemon sharing this org's `/health`
 *      convention — a live `herdr.service` was observed doing exactly this)
 *      is printed as an explicitly SKIPPED CANDIDATE rather than vanishing.
 *   2. `src/agents/ground-truth.ts`'s own `parseCgroup` — already pure,
 *      already fixture-tested — turns each confirmed daemon's cgroup path
 *      into a systemd unit + the journalctl invocation for it. Reused
 *      as-is, per the ticket's own instruction not to write a second parser.
 *   3. For each identity, first decides the TIME WINDOW in force for it
 *      (`decideJournalWindow`) from the CLI's `--since-start` flag plus that
 *      identity's own `/health`-derived `build.startedAt` (see BUTCHR-54's
 *      `decideBuildIdentity` below) — never a second, divergent probe — then
 *      runs the journal read this file computes as appropriate for it (see
 *      `journalInvocationFor`), captures the raw result (exit status +
 *      stdout + stderr), and hands that RESULT — never a live re-run — to
 *      the pure `decideReadability`. The window in force is carried on every
 *      `IdentityReport` and printed for every identity, every run — see
 *      `WindowDecision` below.
 *   4. Scans a readable identity's captured lines with
 *      `src/tools/alias-audit.ts`'s `parseAliasAuditLine`, tallying
 *      drift / sanctioned / ambiguous / unknown(old-format) per identity.
 *   5. `computeVerdict` folds every identity into ONE overall verdict that
 *      cannot report the removal condition met while any identity was
 *      unreadable — see its own doc comment.
 *
 * CLI FLAGS:
 *   --since-start   Scope each identity's journal read to "since that
 *                    identity's own currently-running process started"
 *                    (its `/health`'s `build.startedAt`, frozen at process
 *                    start — BUTCHR-54). Default (flag absent): no window,
 *                    the whole journal — unchanged from before this flag
 *                    existed, so existing scripted callers are not silently
 *                    re-scoped. An identity whose build identity is unknown
 *                    (still the common case today — deploy-on-merge means
 *                    most daemons on this fleet predate the `build` field
 *                    entirely) cannot be scoped to its process start under
 *                    `--since-start`; see `decideJournalWindow`'s doc
 *                    comment for what happens to it instead (widened, never
 *                    silently).
 *
 * Exit code carries the verdict for anything that scripts this later:
 *   0 = CONDITION_MET (every identity read, zero drift, zero unknown)
 *   1 = CONDITION_NOT_MET (every identity read, but drift or unknown-format calls exist)
 *   2 = INCONCLUSIVE (at least one identity could not be read)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { parseCgroup, type SystemdInfo } from "../src/agents/ground-truth.js";
import { parseAliasAuditLine, type AliasClass } from "../src/tools/alias-audit.js";
import type { ShaProvenance } from "../src/agents/build-identity.js";

// ---------------------------------------------------------------------------
// PURE: parsing `ss -ltne` text into candidate sockets.
// ---------------------------------------------------------------------------

export interface SsListener {
  port: number;
  /** `null` when `ss` printed no `uid:` field for this socket (observed for root-owned system sockets). */
  uid: number | null;
  /** The raw cgroup path text after `cgroup:` (e.g. `/user.slice/user-1001.slice/user@1001.service/app.slice/butchr.service`), or `null` if absent. */
  cgroup: string | null;
}

/**
 * Parse `ss -ltne` output (any listening TCP socket, IPv4 or IPv6, with or
 * without a `uid:`/`cgroup:` field) into one `SsListener` per line. Pure —
 * takes the command's TEXT, not a path or a live invocation — fixturable
 * against a captured real transcript.
 */
export function parseSsListeners(output: string): SsListener[] {
  const listeners: SsListener[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("State")) continue;
    const tokens = trimmed.split(/\s+/);
    // Columns: State Recv-Q Send-Q "Local Address:Port" "Peer Address:Port" [uid: ino: sk: cgroup: ...]
    const localAddrPort = tokens[3];
    if (!localAddrPort) continue;
    const portStr = localAddrPort.split(":").pop();
    const port = portStr ? Number(portStr) : NaN;
    if (!Number.isInteger(port)) continue;
    const uidTok = tokens.find((t) => t.startsWith("uid:"));
    const cgroupTok = tokens.find((t) => t.startsWith("cgroup:"));
    listeners.push({
      port,
      uid: uidTok ? Number(uidTok.slice(4)) : null,
      cgroup: cgroupTok ? cgroupTok.slice(7) : null,
    });
  }
  return listeners;
}

// ---------------------------------------------------------------------------
// PURE: which journalctl invocation to attempt for a given identity.
// ---------------------------------------------------------------------------

export interface JournalInvocation {
  /** Empty string when there is nothing to run (not under systemd at all). */
  command: string;
  /** Why this particular command, for the human-readable report. */
  note: string;
}

/**
 * The time window a journal read is actually scoped to, ALREADY RESOLVED —
 * never a raw operator string. `{ kind: "none" }` is the whole journal (the
 * default, and also what a `--since-start` request degrades to for an
 * identity `decideJournalWindow` could not scope — see its doc comment).
 * `{ kind: "since", ... }` carries a validated Unix-epoch-seconds integer,
 * never a string, so `appendSinceWindow` never has to quote anything: DoD 6
 * (shell-quoting) is satisfied by never putting an arbitrary string in the
 * command at all, not by escaping one.
 */
export type JournalWindow = { kind: "none" } | { kind: "since"; sinceEpochSeconds: number; sinceIso: string };

/**
 * Append a `--since @<epoch>` clause to a journalctl command string, or
 * return it unchanged for `{ kind: "none" }`. `runJournalctl` below runs its
 * whole command string through a shell (`spawnSync(..., { shell: true })`),
 * so anything appended here is shell-parsed — journalctl's `@<seconds>`
 * epoch form is pure digits (after this function's own integer check), so
 * there is no space, quote, or shell metacharacter for a malformed
 * `startedAt` to smuggle in. This is why `JournalWindow.sinceEpochSeconds`
 * is a `number`, not the raw ISO string `/health` reported: the conversion
 * to a validated integer is what makes quoting unnecessary, not a quoting
 * scheme layered on top of a string.
 */
export function appendSinceWindow(command: string, window: JournalWindow): string {
  if (window.kind === "none") return command;
  if (!Number.isInteger(window.sinceEpochSeconds)) {
    throw new Error(`invalid journal window: sinceEpochSeconds must be an integer, got ${JSON.stringify(window.sinceEpochSeconds)}`);
  }
  return `${command} --since @${window.sinceEpochSeconds}`;
}

/**
 * `parseCgroup`'s own `journalctl` field is only correct for READING YOUR
 * OWN unit: `journalctl --user -u <unit>` targets the CALLING user's own
 * user-manager session — it does not take a uid, and cannot be pointed at
 * someone else's. Running it for a foreign identity would not fail loudly;
 * it would silently read OUR OWN matching unit (if we happen to run one
 * too) and mislabel that as the foreign identity's log — a wrong-daemon
 * failure sharper than the "-- No entries --" one, because it comes back
 * non-empty. So a foreign uid ALWAYS drops `--user`.
 *
 * The match FIELD for the foreign, system-level query depends on
 * `systemd.kind`, and getting this wrong is silent in exactly the way the
 * rest of this file guards against: `-u <unit>` matches `_SYSTEMD_UNIT`,
 * but a USER unit's journal entries carry `_SYSTEMD_UNIT=user@<uid>.service`
 * and the unit name itself only in `_SYSTEMD_USER_UNIT=<unit>` — so `-u
 * <unit>` matches NOTHING for a user unit, with or without permission.
 * Verified live, unprivileged, against a journal this reader can definitely
 * read: `journalctl -u butchr.service _UID=<own uid>` returns "-- No
 * entries --" while `journalctl _SYSTEMD_USER_UNIT=butchr.service
 * _UID=<own uid>` returns real lines. A system unit's entries DO carry
 * `_SYSTEMD_UNIT=<unit>`, so `-u <unit>` is correct there. `_UID=` is
 * always added (so multiple uids running a same-named unit don't conflate)
 * — the one vantage that could ever see a foreign user's persisted
 * journal, and the one that needs `adm`/`systemd-journal` to actually do so.
 *
 * `window` (BUTCHR-86) defaults to `{ kind: "none" }` — the whole journal,
 * unchanged from every call site written before this parameter existed —
 * and is applied via `appendSinceWindow` to whichever base command this
 * function already decided on, own-identity or foreign. Which window a
 * given identity actually gets is `decideJournalWindow`'s decision, made
 * once per identity before this function is called — never this function's.
 */
export function journalInvocationFor(
  systemd: SystemdInfo,
  targetUid: number,
  readerUid: number,
  window: JournalWindow = { kind: "none" },
): JournalInvocation {
  if (systemd.kind === "none") return { command: "", note: "not running under a systemd unit — no journal to read" };
  if (targetUid === readerUid) {
    return { command: appendSinceWindow(systemd.journalctl, window), note: "own identity — using this unit's own recommended invocation" };
  }
  const unitMatch = systemd.kind === "user" ? `_SYSTEMD_USER_UNIT=${systemd.unit}` : `-u ${systemd.unit}`;
  return {
    command: appendSinceWindow(`journalctl ${unitMatch} _UID=${targetUid}`, window),
    note:
      systemd.kind === "user"
        ? "foreign identity, user unit — `--user`/`-u` cannot cross users or match a user unit's own field, so this matches `_SYSTEMD_USER_UNIT` at the system level (needs adm/systemd-journal to see anything for a uid that isn't ours)"
        : "foreign identity, system unit — `--user` cannot cross users, so this queries the system-level view (needs adm/systemd-journal to see anything for a uid that isn't ours)",
  };
}

// ---------------------------------------------------------------------------
// PURE: deciding readable-vs-unreadable from a journal invocation's RESULT.
// ---------------------------------------------------------------------------

export interface JournalProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ReadOutcome = { readable: true; totalLines: number; lines: string[] } | { readable: false; reason: string };

/**
 * The acceptance criterion this ticket is harshest on: "I read this
 * identity's journal and found no alias calls" and "I could not read this
 * identity's journal at all" must produce DIFFERENT, VISIBLE output, never
 * a shared zero. This never looks at alias-call content to decide — only
 * at whether the read itself produced ANY line of output at all, combined
 * with identity facts (self vs. foreign, confirmed live via `/health`, and
 * — BUTCHR-86 — whether the read was scoped to a window at all).
 *
 * Before writing this, the failing case it must catch: a foreign, non-self
 * identity whose journal returns zero lines (because we structurally
 * cannot read it) must come back `readable: false` — never
 * `{ readable: true, totalLines: 0 }`, which would be indistinguishable
 * from "we read it and it was quiet."
 *
 * BUTCHR-86's `windowed` deliberately does NOT touch that foreign-identity
 * branch, or the "liveness not independently confirmed" branch below it: a
 * cross-user empty read is exactly as ambiguous under a window as over the
 * whole journal (permission-gated vs. quiet still can't be told apart), and
 * an unconfirmed-live self read has no independent evidence to begin with,
 * windowed or not. It touches exactly ONE branch: our OWN identity, zero
 * lines, `/health` confirms it's live right now. Over the WHOLE journal
 * that combination is proof the read failed (a live daemon that logged
 * nothing at all, ever, is not credible). Under a WINDOW it is not proof of
 * anything — a daemon can legitimately be quiet for the short span since it
 * started. So: windowed + self + live + zero lines is `readable: true` with
 * `totalLines: 0`, never `readable: false`. This is the interaction DoD 4
 * names as the sharpest hazard in this ticket, decided deliberately rather
 * than discovered by accident; see the PR description for the argument.
 * (In practice `windowed: true` can only happen when `confirmedLiveViaHealth`
 * is also true — a window is only ever built from THIS round's own `/health`
 * response, per `decideJournalWindow` — but the nesting below is written to
 * make that dependency explicit rather than relying on a caller to uphold
 * an invariant this function can't see.)
 */
export function decideReadability(opts: {
  probe: JournalProbeResult;
  targetUid: number;
  readerUid: number;
  /** From an independent `/health` probe — a live daemon is a logging daemon. */
  confirmedLiveViaHealth: boolean;
  /** Was this read scoped by `--since-start` (i.e. `JournalWindow.kind !== "none"`)? See this function's doc comment. */
  windowed: boolean;
}): ReadOutcome {
  const { probe, targetUid, readerUid, confirmedLiveViaHealth, windowed } = opts;
  const isSelf = targetUid === readerUid;

  if (probe.exitCode !== 0) {
    return { readable: false, reason: `journalctl exited ${probe.exitCode}: ${probe.stderr.trim() || probe.stdout.trim() || "(no output)"}` };
  }

  const lines = probe.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const emptyMarker = probe.stdout.includes("-- No entries --");

  if (emptyMarker || lines.length === 0) {
    if (!isSelf) {
      return {
        readable: false,
        reason: `uid ${targetUid} is not this reader (uid ${readerUid}); a cross-user read that comes back empty is indistinguishable from a permission-gated one, so it is never trusted as "quiet"`,
      };
    }
    if (confirmedLiveViaHealth) {
      if (windowed) {
        return { readable: true, totalLines: 0, lines: [] };
      }
      return {
        readable: false,
        reason: "zero lines from our own unit, but /health confirms it is live right now — a live daemon that logged nothing is proof this read is UNREADABLE, not proof it is quiet",
      };
    }
    return {
      readable: false,
      reason: "zero lines returned and liveness was not independently confirmed — a null result is not evidence of a pass",
    };
  }

  return { readable: true, totalLines: lines.length, lines };
}

// ---------------------------------------------------------------------------
// PURE: BUTCHR-54 — the running build identity a `/health` response carries
// (or doesn't). A completely separate axis from journal readability above: a
// daemon can be journal-readable and build-unknown (the realistic case
// TODAY, since deploy-on-merge is off — every daemon on the host is running
// an OLD build with no `build` field at all), or the reverse. Neither may
// mask the other, so this is its own outcome type, never folded into
// `ReadOutcome`.
// ---------------------------------------------------------------------------

export interface BuildInfo {
  sha: string | null;
  shaProvenance: ShaProvenance | null;
  shaDirty: boolean | null;
  shaUnknownReason: string | null;
  version: string | null;
  startedAt: string | null;
  pid: number | null;
}

export type BuildOutcome = { known: true; info: BuildInfo } | { known: false; reason: string };

/**
 * The exact acceptance case DoD #4 names: a daemon that answers `/health`
 * daemon-shaped (so it's discovered and counted) but carries no `build`
 * field at all — because it predates this ticket, or deploy-on-merge is off
 * and it's simply still running an old build — must come back `known:
 * false` with a stated reason, NEVER silently defaulted or blank. Also
 * tolerant of a malformed `build` (wrong types) rather than throwing: an
 * unexpected shape from a future/foreign daemon version is exactly the kind
 * of surprise this command must survive, not another failure mode.
 */
export function decideBuildIdentity(healthBody: unknown): BuildOutcome {
  const UNREPORTED = "this daemon does not report a build identity; it predates the field, or is running an older build";
  if (!healthBody || typeof healthBody !== "object" || !("build" in healthBody)) return { known: false, reason: UNREPORTED };
  const raw = (healthBody as { build?: unknown }).build;
  if (!raw || typeof raw !== "object") return { known: false, reason: UNREPORTED };
  const b = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  const provenance: ShaProvenance | null = b.shaProvenance === "baked" || b.shaProvenance === "git-at-start" ? b.shaProvenance : null;
  return {
    known: true,
    info: {
      sha: str(b.sha),
      shaProvenance: provenance,
      shaDirty: bool(b.shaDirty),
      shaUnknownReason: str(b.shaUnknownReason),
      version: str(b.version),
      startedAt: str(b.startedAt),
      pid: num(b.pid),
    },
  };
}

/** `HH`-free, honest uptime string from an ISO `startedAt` — "unknown" (never a fabricated duration) when `startedAt` is absent or unparseable. */
export function formatUptime(startedAt: string | null, nowMs: number): string {
  if (!startedAt) return "unknown";
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs)) return "unknown";
  const totalSec = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  if (days || hours || mins) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

/** One report line per identity: the running sha/version/uptime, or an explicit unknown — never blank, never omitted (see `decideBuildIdentity`'s doc comment). */
export function formatBuildLine(outcome: BuildOutcome, nowMs: number): string {
  if (!outcome.known) return `build: unknown — ${outcome.reason}`;
  const i = outcome.info;
  const shaDetail = i.sha
    ? ` (${i.shaProvenance ?? "unknown provenance"}${i.shaDirty ? ", dirty working tree at start" : ""})`
    : i.shaUnknownReason
      ? ` (${i.shaUnknownReason})`
      : "";
  return `build: sha=${i.sha ?? "unknown"}${shaDetail} version=${i.version ?? "unknown"} uptime=${formatUptime(i.startedAt, nowMs)} pid=${i.pid ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// PURE: BUTCHR-86 — deciding, per identity, the time window a journal read
// is actually scoped to, and stating that decision in words a human can
// read. A completely separate concern from `journalInvocationFor`: this
// decides WHAT window to use (from the CLI's `--since-start` flag plus that
// identity's own `BuildOutcome`); `journalInvocationFor` only turns an
// already-decided `JournalWindow` into a command string.
// ---------------------------------------------------------------------------

export interface WindowDecision {
  window: JournalWindow;
  /** Human-readable, always non-empty, always printed for this identity — see DoD 2: "stated in the output for every identity, every single time." */
  note: string;
}

const NO_WINDOW_NOTE = "whole journal (no --since-start requested; default — existing scripted callers are not silently re-scoped)";

/**
 * DoD 1 + DoD 2 + DoD 3, all in one place. Two inputs: did the operator ASK
 * for a since-start window at all, and does THIS identity's own build
 * identity (BUTCHR-54, via `decideBuildIdentity`) actually carry a
 * `startedAt` it can be scoped to.
 *
 * `sinceStartRequested: false` — the default — always returns `{ kind:
 * "none" }`, and the note says so explicitly even though nothing narrowed:
 * DoD 2 is explicit that the default whole-journal case must still state
 * its window, never leave it implicit because "there's nothing to say."
 *
 * `sinceStartRequested: true` with a build identity that DOES carry a valid
 * `startedAt`: scoped, and the note names the exact timestamp it's scoped
 * to and where that timestamp came from.
 *
 * `sinceStartRequested: true` with a build identity that does NOT carry one
 * — `known: false` (the ticket that requested this feature said this was
 * the ONLY path exercisable end-to-end against this fleet at ticket-write
 * time, since deploy-on-merge was off and every daemon then visible
 * predated the `build` field; verify this against your OWN environment's
 * `/health` rather than trusting that as still true — a daemon on THIS
 * fleet already reports one live while this file was being written, so the
 * degraded path may or may not still be the only one you can exercise), or
 * `known: true` with a null/unparseable `startedAt` — is DoD 3's degraded
 * case. This function's answer: WIDEN, never refuse the identity outright.
 * Refusing would mark the identity `readable: false` and drag the whole run
 * to INCONCLUSIVE for every identity on a fleet with no build-identity
 * daemons yet, which is strictly less useful than reading it — and DoD 3
 * only requires the degraded case be VISIBLE, not that it be excluded. So: this identity's
 * read stays a whole-journal read, `window.kind` stays `"none"`, and the
 * note says so LOUDLY — naming that `--since-start` was requested, that
 * this identity could not honor it, and why — so a human comparing two
 * identities' counts side by side sees immediately that they are not
 * scoped the same way, per DoD 3's "incomparable without saying so."
 */
export function decideJournalWindow(sinceStartRequested: boolean, build: BuildOutcome): WindowDecision {
  if (!sinceStartRequested) return { window: { kind: "none" }, note: NO_WINDOW_NOTE };

  if (!build.known) {
    return {
      window: { kind: "none" },
      note: `whole journal — --since-start was requested but this identity's build identity is unknown (${build.reason}); WIDENED to the whole journal rather than silently narrowed, so this identity is still read, but its counts are NOT scoped like an identity that DID resolve a window — compare with care`,
    };
  }
  const startedAt = build.info.startedAt;
  if (!startedAt) {
    return {
      window: { kind: "none" },
      note: "whole journal — --since-start was requested but this identity's build identity carries no startedAt; WIDENED to the whole journal rather than silently narrowed — compare with care",
    };
  }
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs)) {
    return {
      window: { kind: "none" },
      note: `whole journal — --since-start was requested but this identity's build.startedAt ("${startedAt}") is not a parseable timestamp; WIDENED to the whole journal rather than silently narrowed — compare with care`,
    };
  }
  const sinceEpochSeconds = Math.floor(startMs / 1000);
  return {
    window: { kind: "since", sinceEpochSeconds, sinceIso: startedAt },
    note: `since this identity's process started at ${startedAt} (its own /health build.startedAt, per --since-start)`,
  };
}

/** `window: <note>` — trivial, but a dedicated exported formatter so DoD 2 ("stated ... every single time") is one grep-able, directly-tested line rather than an inline template repeated at every `formatReport` call site. */
export function formatWindowLine(decision: WindowDecision): string {
  return `window: ${decision.note}`;
}

// ---------------------------------------------------------------------------
// PURE: per-identity classification tally, and the one overall verdict.
// ---------------------------------------------------------------------------

export interface IdentityReport {
  uid: number;
  unit: string;
  journalNote: string;
  outcome: ReadOutcome;
  drift: number;
  sanctioned: number;
  ambiguous: number;
  unknown: number;
  /**
   * BUTCHR-54. Optional only so existing literal `IdentityReport`s built
   * before this field existed (this file's own test suite) keep compiling
   * unchanged; every report `main()` actually produces below always sets it
   * — `formatReport` falls back to an explicit "not probed" outcome when
   * it's absent, never a blank line.
   */
  build?: BuildOutcome;
  /** BUTCHR-86. Required, unlike `build` above: every `IdentityReport` from this point forward is built through `buildIdentityReport`, which always takes one — there is no pre-BUTCHR-86 literal anywhere to keep compiling, so there is no need for an optional-plus-sentinel fallback here the way `build` has one. */
  window: WindowDecision;
}

/** Fold a readable identity's raw lines into per-classification counts; an unreadable identity carries all-zero counts (its `outcome` is what actually matters). `build` is a second, independent axis (see `BuildOutcome`'s doc comment) — passed through untouched, never derived from `outcome`. `window` (BUTCHR-86) is a THIRD, independent axis — see `WindowDecision`'s doc comment — likewise passed through untouched. */
export function buildIdentityReport(opts: { uid: number; unit: string; journalNote: string; outcome: ReadOutcome; build?: BuildOutcome; window: WindowDecision }): IdentityReport {
  const counts: Record<AliasClass | "unknown", number> = { drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0 };
  if (opts.outcome.readable) {
    for (const line of opts.outcome.lines) {
      const parsed = parseAliasAuditLine(line);
      if (parsed) counts[parsed.classification]++;
    }
  }
  return { uid: opts.uid, unit: opts.unit, journalNote: opts.journalNote, outcome: opts.outcome, window: opts.window, ...counts, ...(opts.build ? { build: opts.build } : {}) };
}

export type Verdict = "CONDITION_MET" | "CONDITION_NOT_MET" | "INCONCLUSIVE";

export interface VerdictResult {
  verdict: Verdict;
  unreadable: IdentityReport[];
  totals: { drift: number; sanctioned: number; ambiguous: number; unknown: number };
}

/**
 * Structurally incapable of returning CONDITION_MET while any discovered
 * identity was unreadable — that branch is checked FIRST and short-circuits
 * before drift/unknown counts are even consulted. The removal condition is
 * specifically about DRIFT (and unknown-format, which might be drift we
 * simply can't classify) reaching zero; AMBIGUOUS and SANCTIONED calls never
 * block it, by design (see src/tools/alias-audit.ts's classification rule).
 */
export function computeVerdict(identities: IdentityReport[]): VerdictResult {
  const unreadable = identities.filter((i) => !i.outcome.readable);
  const totals = identities.reduce(
    (acc, i) => ({
      drift: acc.drift + i.drift,
      sanctioned: acc.sanctioned + i.sanctioned,
      ambiguous: acc.ambiguous + i.ambiguous,
      unknown: acc.unknown + i.unknown,
    }),
    { drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0 },
  );
  if (unreadable.length > 0) return { verdict: "INCONCLUSIVE", unreadable, totals };
  if (totals.drift > 0 || totals.unknown > 0) return { verdict: "CONDITION_NOT_MET", unreadable, totals };
  return { verdict: "CONDITION_MET", unreadable, totals };
}

/** Sentinel for an `IdentityReport` built (almost always by a test) without a `build` outcome — never actually produced by `main()`, which always passes one. Distinct wording from `decideBuildIdentity`'s "predates the field" reason: this means "nobody even asked", not "asked and got nothing". */
const BUILD_NOT_PROBED: BuildOutcome = { known: false, reason: "build identity was not probed" };

/**
 * Render the full per-identity + verdict report as text for stdout. Pure —
 * takes the already-computed reports (plus `nowMs`, for the one relative
 * value — uptime — this renders), prints nothing itself. Build identity
 * (BUTCHR-54) is printed for EVERY identity regardless of journal
 * readability, and vice versa — the two axes never mask each other (see
 * `BuildOutcome`'s doc comment). The window in force (BUTCHR-86) is a THIRD
 * independent axis, printed for EVERY identity for the same reason — this
 * is DoD 2's headline falsifier: a window that narrows what's counted
 * without a human being able to see that from this report is exactly the
 * failure this ticket exists to prevent.
 */
export function formatReport(identities: IdentityReport[], result: VerdictResult, nowMs: number): string {
  const lines: string[] = [];
  for (const id of identities) {
    if (id.outcome.readable) {
      lines.push(
        `identity uid=${id.uid} unit=${id.unit} — READABLE (${id.outcome.totalLines} total lines; ${id.journalNote})`,
      );
      lines.push(`  drift=${id.drift} sanctioned=${id.sanctioned} ambiguous=${id.ambiguous} unknown-old-format=${id.unknown}`);
    } else {
      lines.push(`identity uid=${id.uid} unit=${id.unit} — UNREADABLE: ${id.outcome.reason} (${id.journalNote})`);
    }
    lines.push(`  ${formatBuildLine(id.build ?? BUILD_NOT_PROBED, nowMs)}`);
    lines.push(`  ${formatWindowLine(id.window)}`);
  }
  lines.push("");
  lines.push(
    `TOTALS: drift=${result.totals.drift} sanctioned=${result.totals.sanctioned} ambiguous=${result.totals.ambiguous} unknown-old-format=${result.totals.unknown}`,
  );
  if (result.unreadable.length > 0) {
    lines.push(`VERDICT: INCONCLUSIVE — ${result.unreadable.length} identity(ies) unreadable: ${result.unreadable.map((i) => `uid ${i.uid}`).join(", ")}`);
  } else if (result.verdict === "CONDITION_NOT_MET") {
    lines.push("VERDICT: CONDITION NOT MET — every identity was read, but drift or unknown-format alias calls remain");
  } else {
    lines.push("VERDICT: CONDITION MET — every identity was read; zero drift, zero unknown-format alias calls");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// IMPURE: the actual `ss`, `/health`, `journalctl`, group-membership calls.
// ---------------------------------------------------------------------------

/**
 * Is this listener's cgroup a `butchr.service` unit at all? ENVIRONMENT.md
 * is explicit that every butchr daemon in this fleet — any host, any uid —
 * runs as a unit literally named `butchr.service`; that is a fact about how
 * the fleet is deployed, not a hardcoded port or a guessed default
 * (`src/config/config.ts`'s port default is exactly the guess this script
 * must not make). This exists because a `/health` shape check ALONE
 * over-matches: a live `herdr.service` on this host answers the same
 * `{ok, components}` convention. But the unit-name check is never used to
 * SKIP a network probe (see `partitionCandidates` below) — only to decide,
 * after a listener is already confirmed daemon-shaped, whether it's ours to
 * aggregate or a same-shaped different daemon worth naming instead of
 * silently dropping.
 */
export function looksLikeButchrUnit(cgroup: string | null): boolean {
  if (!cgroup) return false;
  const info = parseCgroup(cgroup);
  return info.kind !== "none" && info.unit === "butchr.service";
}

/**
 * Split every `/health`-confirmed daemon-shaped listener into ours
 * (`butchr`) and everyone else's (`skipped`). PURE — the network probe
 * already happened; this only classifies the listeners it returned true
 * for. Never drop a confirmed-live, daemon-shaped responder silently: a
 * host running a butchr daemon under some other unit name would otherwise
 * vanish from the report with the verdict still claiming "every identity
 * was read" — the discovery-side version of the exact silent-miss failure
 * this ticket exists to kill on the readability side. `skipped` is
 * reported (see `main`) but does not by itself change the verdict — an
 * unrelated daemon-shaped service sharing this org's `/health` convention
 * is not evidence about alias calls one way or the other.
 */
export function partitionCandidates(healthConfirmed: SsListener[]): { butchr: SsListener[]; skipped: SsListener[] } {
  const butchr: SsListener[] = [];
  const skipped: SsListener[] = [];
  for (const l of healthConfirmed) (looksLikeButchrUnit(l.cgroup) ? butchr : skipped).push(l);
  return { butchr, skipped };
}

/** Render a skipped candidate's unit for the human-readable report — never asserts a name the cgroup didn't actually carry. */
export function describeSkippedUnit(cgroup: string | null): string {
  if (!cgroup) return "(no cgroup reported)";
  const info = parseCgroup(cgroup);
  return info.kind === "none" ? "(not a systemd unit)" : info.unit;
}

/** `/health`'s body when (and only when) it's daemon-shaped; `null` on any failure or a non-daemon-shaped response. The one live probe both discovery (`isButchrHealth`) and build-identity extraction (`decideBuildIdentity`) are built on — never a second, divergent probe. */
async function fetchHealthBody(port: number): Promise<unknown | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    const body = (await res.json()) as { ok?: unknown; components?: unknown };
    return typeof body.ok === "boolean" && Array.isArray(body.components) ? body : null;
  } catch {
    return null;
  }
}

async function isButchrHealth(port: number): Promise<boolean> {
  return (await fetchHealthBody(port)) !== null;
}

// A long-lived host's full journal for a unit can run into hundreds of
// thousands of lines; node's spawnSync default maxBuffer (1MB) silently
// truncates and reports `status: null` well before that, which this file's
// `?? 1` fallback would misreport as "journalctl exited 1" — a fabricated
// exit code standing in for a buffer overflow, not a real failure. BUTCHR-86
// added a per-identity `--since-start` time-scoping option (see
// `decideJournalWindow`), but this buffer stays sized for the WHOLE journal
// regardless: `--since-start` is opt-in and per-identity (a degraded
// identity widens right back to the whole journal, see DoD 3), and even a
// requested window only bounds how far BACK a read can reach, never how
// long a daemon has been running since — a single long-lived process with
// no restart can still produce a huge windowed read. Sizing this to the
// windowed case and truncating the un-windowed default would just move the
// silent-truncation failure this comment was written to describe.
const JOURNALCTL_MAX_BUFFER = 256 * 1024 * 1024;

function runJournalctl(command: string): JournalProbeResult {
  const result = spawnSync(command, { shell: true, encoding: "utf8", maxBuffer: JOURNALCTL_MAX_BUFFER });
  if (result.error) return { exitCode: 1, stdout: result.stdout ?? "", stderr: `spawn error: ${result.error.message}` };
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function main(): Promise<void> {
  const readerUid = process.getuid?.() ?? -1;
  const sinceStartRequested = process.argv.slice(2).includes("--since-start");

  const ssOutput = execFileSync("ss", ["-ltne"], { encoding: "utf8" });
  const listeners = parseSsListeners(ssOutput);

  // Never confirmed by port — every listener gets a live /health round trip;
  // the unit-name check only sorts the confirmed-daemon-shaped ones afterward
  // (see partitionCandidates) so a same-shaped non-butchr daemon is named
  // instead of silently vanishing.
  const healthConfirmed: SsListener[] = [];
  for (const l of listeners) {
    if (await isButchrHealth(l.port)) healthConfirmed.push(l);
  }
  const { butchr: confirmed, skipped } = partitionCandidates(healthConfirmed);

  for (const s of skipped) {
    console.log(`SKIPPED CANDIDATE: port ${s.port} uid=${s.uid ?? "unknown"} unit=${describeSkippedUnit(s.cgroup)} — /health responded daemon-shaped but the unit isn't butchr.service; not aggregated`);
  }

  // A daemon can listen on more than one socket; group by (uid, cgroup) so it's
  // reported once, with every port it was confirmed live on.
  const byIdentity = new Map<string, { uid: number | null; cgroup: string | null; ports: number[] }>();
  for (const c of confirmed) {
    const key = `${c.uid ?? "unknown"}::${c.cgroup ?? "none"}`;
    const existing = byIdentity.get(key);
    if (existing) existing.ports.push(c.port);
    else byIdentity.set(key, { uid: c.uid, cgroup: c.cgroup, ports: [c.port] });
  }

  if (byIdentity.size === 0) {
    console.log("No butchr daemon identities discovered on this host (ss -ltne showed no socket answering /health with a daemon-shaped response).");
    process.exit(2);
  }

  const reports: IdentityReport[] = [];
  for (const identity of byIdentity.values()) {
    // One /health round trip per identity (not per readability branch below):
    // liveness AND build identity (BUTCHR-54) both come from the same probe,
    // never a second, potentially-divergent one.
    // Promise.all, never Promise.race: race resolves on the first SETTLED
    // promise, so a fast miss from one socket could beat a slower hit from
    // another and understate liveness — `some`/`find` are exact regardless
    // of which port answers first.
    const bodies = await Promise.all(identity.ports.map(fetchHealthBody));
    const liveNow = bodies.some((b) => b !== null);
    const build = decideBuildIdentity(bodies.find((b) => b !== null) ?? null);
    // Decided ONCE per identity from this same round's build outcome, then
    // threaded through every branch below — including the two that never
    // reach a real journalctl invocation — so the window is stated for
    // EVERY identity, not just the ones that make it to a journal read
    // (DoD 2).
    const window = decideJournalWindow(sinceStartRequested, build);

    if (identity.uid === null || identity.cgroup === null) {
      reports.push(
        buildIdentityReport({
          uid: identity.uid ?? -1,
          unit: "(unknown)",
          journalNote: "ss -ltne reported no uid/cgroup for this confirmed daemon socket",
          outcome: { readable: false, reason: "ss -ltne did not expose uid/cgroup for this socket — this host disagrees with the verified-unprivileged route this script assumes; investigate before trusting anything else here" },
          build,
          window,
        }),
      );
      continue;
    }
    const systemd = parseCgroup(identity.cgroup);
    const unit = systemd.kind === "none" ? "(none)" : systemd.unit;
    const invocation = journalInvocationFor(systemd, identity.uid, readerUid, window.window);

    if (!invocation.command) {
      reports.push(buildIdentityReport({ uid: identity.uid, unit, journalNote: invocation.note, outcome: { readable: false, reason: invocation.note }, build, window }));
      continue;
    }

    const probe = runJournalctl(invocation.command);
    const outcome = decideReadability({ probe, targetUid: identity.uid, readerUid, confirmedLiveViaHealth: liveNow, windowed: window.window.kind !== "none" });
    reports.push(buildIdentityReport({ uid: identity.uid, unit, journalNote: invocation.note, outcome, build, window }));
  }

  const result = computeVerdict(reports);
  console.log(formatReport(reports, result, Date.now()));

  process.exit(result.verdict === "CONDITION_MET" ? 0 : result.verdict === "CONDITION_NOT_MET" ? 1 : 2);
}

if (import.meta.main) await main();
