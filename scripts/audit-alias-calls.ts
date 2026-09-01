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
 *   3. For each identity, runs the journal read this file computes as
 *      appropriate for it (see `journalInvocationFor` below), captures the
 *      raw result (exit status + stdout + stderr), and hands that RESULT —
 *      never a live re-run — to the pure `decideReadability`.
 *   4. Scans a readable identity's captured lines with
 *      `src/tools/alias-audit.ts`'s `parseAliasAuditLine`, tallying
 *      drift / sanctioned / ambiguous / unknown(old-format) per identity.
 *   5. `computeVerdict` folds every identity into ONE overall verdict that
 *      cannot report the removal condition met while any identity was
 *      unreadable — see its own doc comment.
 *
 * Exit code carries the verdict for anything that scripts this later:
 *   0 = CONDITION_MET (every identity read, zero drift, zero unknown)
 *   1 = CONDITION_NOT_MET (every identity read, but drift or unknown-format calls exist)
 *   2 = INCONCLUSIVE (at least one identity could not be read)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { parseCgroup, type SystemdInfo } from "../src/agents/ground-truth.js";
import { parseAliasAuditLine, type AliasClass } from "../src/tools/alias-audit.js";

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
 */
export function journalInvocationFor(systemd: SystemdInfo, targetUid: number, readerUid: number): JournalInvocation {
  if (systemd.kind === "none") return { command: "", note: "not running under a systemd unit — no journal to read" };
  if (targetUid === readerUid) {
    return { command: systemd.journalctl, note: "own identity — using this unit's own recommended invocation" };
  }
  const unitMatch = systemd.kind === "user" ? `_SYSTEMD_USER_UNIT=${systemd.unit}` : `-u ${systemd.unit}`;
  return {
    command: `journalctl ${unitMatch} _UID=${targetUid}`,
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
 * with identity facts (self vs. foreign, confirmed live via `/health`).
 *
 * Before writing this, the failing case it must catch: a foreign, non-self
 * identity whose journal returns zero lines (because we structurally
 * cannot read it) must come back `readable: false` — never
 * `{ readable: true, totalLines: 0 }`, which would be indistinguishable
 * from "we read it and it was quiet."
 */
export function decideReadability(opts: {
  probe: JournalProbeResult;
  targetUid: number;
  readerUid: number;
  /** From an independent `/health` probe — a live daemon is a logging daemon. */
  confirmedLiveViaHealth: boolean;
}): ReadOutcome {
  const { probe, targetUid, readerUid, confirmedLiveViaHealth } = opts;
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
}

/** Fold a readable identity's raw lines into per-classification counts; an unreadable identity carries all-zero counts (its `outcome` is what actually matters). */
export function buildIdentityReport(opts: { uid: number; unit: string; journalNote: string; outcome: ReadOutcome }): IdentityReport {
  const counts: Record<AliasClass | "unknown", number> = { drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0 };
  if (opts.outcome.readable) {
    for (const line of opts.outcome.lines) {
      const parsed = parseAliasAuditLine(line);
      if (parsed) counts[parsed.classification]++;
    }
  }
  return { uid: opts.uid, unit: opts.unit, journalNote: opts.journalNote, outcome: opts.outcome, ...counts };
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

/** Render the full per-identity + verdict report as text for stdout. Pure — takes the already-computed reports, prints nothing itself. */
export function formatReport(identities: IdentityReport[], result: VerdictResult): string {
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

async function isButchrHealth(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    const body = (await res.json()) as { ok?: unknown; components?: unknown };
    return typeof body.ok === "boolean" && Array.isArray(body.components);
  } catch {
    return false;
  }
}

// A long-lived host's full journal for a unit can run into hundreds of
// thousands of lines; node's spawnSync default maxBuffer (1MB) silently
// truncates and reports `status: null` well before that, which this file's
// `?? 1` fallback would misreport as "journalctl exited 1" — a fabricated
// exit code standing in for a buffer overflow, not a real failure. Sized
// generously rather than time-scoping the query (e.g. `--since` the unit's
// last start): that is a real, separate improvement this script leaves for
// later rather than folding into this ticket's scope silently.
const JOURNALCTL_MAX_BUFFER = 256 * 1024 * 1024;

function runJournalctl(command: string): JournalProbeResult {
  const result = spawnSync(command, { shell: true, encoding: "utf8", maxBuffer: JOURNALCTL_MAX_BUFFER });
  if (result.error) return { exitCode: 1, stdout: result.stdout ?? "", stderr: `spawn error: ${result.error.message}` };
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function main(): Promise<void> {
  const readerUid = process.getuid?.() ?? -1;

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
    if (identity.uid === null || identity.cgroup === null) {
      reports.push(
        buildIdentityReport({
          uid: identity.uid ?? -1,
          unit: "(unknown)",
          journalNote: "ss -ltne reported no uid/cgroup for this confirmed daemon socket",
          outcome: { readable: false, reason: "ss -ltne did not expose uid/cgroup for this socket — this host disagrees with the verified-unprivileged route this script assumes; investigate before trusting anything else here" },
        }),
      );
      continue;
    }
    const systemd = parseCgroup(identity.cgroup);
    const unit = systemd.kind === "none" ? "(none)" : systemd.unit;
    const invocation = journalInvocationFor(systemd, identity.uid, readerUid);
    // Promise.all, never Promise.race: race resolves on the first SETTLED
    // promise, so a fast `false` from one socket could beat a slower `true`
    // from another and understate liveness — `some` is exact regardless of
    // which port answers first.
    const liveNow = (await Promise.all(identity.ports.map(isButchrHealth))).some(Boolean);

    if (!invocation.command) {
      reports.push(buildIdentityReport({ uid: identity.uid, unit, journalNote: invocation.note, outcome: { readable: false, reason: invocation.note } }));
      continue;
    }

    const probe = runJournalctl(invocation.command);
    const outcome = decideReadability({ probe, targetUid: identity.uid, readerUid, confirmedLiveViaHealth: liveNow });
    reports.push(buildIdentityReport({ uid: identity.uid, unit, journalNote: invocation.note, outcome }));
  }

  const result = computeVerdict(reports);
  console.log(formatReport(reports, result));

  process.exit(result.verdict === "CONDITION_MET" ? 0 : result.verdict === "CONDITION_NOT_MET" ? 1 : 2);
}

if (import.meta.main) await main();
