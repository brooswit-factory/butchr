import { describe, expect, test } from "bun:test";
import {
  appendSinceWindow,
  buildIdentityReport,
  computeVerdict,
  decideBuildIdentity,
  decideJournalWindow,
  decideReadability,
  describeSkippedUnit,
  formatBuildLine,
  formatReport,
  formatUptime,
  formatWindowLine,
  journalInvocationFor,
  looksLikeButchrUnit,
  parseSsListeners,
  partitionCandidates,
  type BuildOutcome,
  type IdentityReport,
  type SsListener,
  type WindowDecision,
} from "../../scripts/audit-alias-calls.js";

// Shorthand for tests that don't care about the window axis — the default,
// unrequested, whole-journal decision every identity gets when
// `--since-start` wasn't passed.
const NO_WINDOW: WindowDecision = decideJournalWindow(false, { known: false, reason: "not probed by this test" });

// A REAL `ss -ltne` transcript, captured live on the host this ticket was
// built against (servyboi): a mix of root-owned system sockets with no
// `uid:` field, resolved sockets that DO carry one, IPv6 lines, and two
// live butchr daemons — one ours (uid 1001), one a different Unix user's
// (uid 1002) that an unprivileged `ss -ltnp` shows with no process at all.
const REAL_SS_OUTPUT = `
State  Recv-Q Send-Q               Local Address:Port  Peer Address:PortProcess
LISTEN 0      4096                       0.0.0.0:22         0.0.0.0:*    ino:9318 sk:1 cgroup:/system.slice/ssh.socket <->
LISTEN 0      4096                 127.0.0.53%lo:53         0.0.0.0:*    uid:991 ino:7930 sk:3 cgroup:/system.slice/systemd-resolved.service <->
LISTEN 0      4096                     127.0.0.1:631        0.0.0.0:*    ino:419516876 sk:3008 cgroup:/system.slice/cups.service <->
LISTEN 0      4096                          [::]:22            [::]:*    ino:8355 sk:8 cgroup:/system.slice/ssh.socket v6only:1 <->
LISTEN 0      4096   [fd7a:115c:a1e0::af01:45c4]:36556         [::]:*    ino:393362835 sk:3004 cgroup:/system.slice/tailscaled.service v6only:1 <->
LISTEN 0      512                              *:7718             *:*    uid:1002 ino:420653489 sk:f cgroup:/user.slice/user-1002.slice/user@1002.service/app.slice/butchr.service v6only:0 <->
LISTEN 0      512                              *:7717             *:*    uid:1001 ino:420653403 sk:10 cgroup:/user.slice/user-1001.slice/user@1001.service/app.slice/butchr.service v6only:0 <->
`;

describe("parseSsListeners", () => {
  test("extracts port, uid, and cgroup for every listener, real transcript", () => {
    const listeners = parseSsListeners(REAL_SS_OUTPUT);
    expect(listeners).toContainEqual({ port: 7717, uid: 1001, cgroup: "/user.slice/user-1001.slice/user@1001.service/app.slice/butchr.service" });
    expect(listeners).toContainEqual({ port: 7718, uid: 1002, cgroup: "/user.slice/user-1002.slice/user@1002.service/app.slice/butchr.service" });
  });

  test("a socket with no uid: field (root-owned, e.g. ssh.socket) parses uid as null, not 0 or a guess", () => {
    const listeners = parseSsListeners(REAL_SS_OUTPUT);
    const ssh = listeners.find((l) => l.port === 22);
    expect(ssh).toEqual({ port: 22, uid: null, cgroup: "/system.slice/ssh.socket" });
  });

  test("an IPv6 bracketed address extracts the port after the closing bracket, not a colon inside it", () => {
    const listeners = parseSsListeners(REAL_SS_OUTPUT);
    expect(listeners.find((l) => l.cgroup?.includes("tailscaled"))?.port).toBe(36556);
  });

  test("the header line and blank lines are skipped, not misparsed as sockets", () => {
    const listeners = parseSsListeners(REAL_SS_OUTPUT);
    expect(listeners.every((l) => Number.isInteger(l.port))).toBe(true);
  });

  test("empty input yields no listeners", () => {
    expect(parseSsListeners("")).toEqual([]);
  });
});

describe("looksLikeButchrUnit", () => {
  test("a cgroup ending in butchr.service (user or system) matches", () => {
    expect(looksLikeButchrUnit("/user.slice/user-1002.slice/user@1002.service/app.slice/butchr.service")).toBe(true);
    expect(looksLikeButchrUnit("/system.slice/butchr.service")).toBe(true);
  });

  test("an unrelated unit — even one from this org's own stack, sharing the /health shape — does not match", () => {
    expect(looksLikeButchrUnit("/user.slice/user-1002.slice/user@1002.service/app.slice/herdr.service")).toBe(false);
    expect(looksLikeButchrUnit("/system.slice/ssh.socket")).toBe(false);
  });

  test("no cgroup at all does not match", () => {
    expect(looksLikeButchrUnit(null)).toBe(false);
  });
});

describe("partitionCandidates — a same-shaped non-butchr daemon is named, never silently dropped", () => {
  const butchrListener: SsListener = { port: 7717, uid: 1001, cgroup: "/user.slice/user-1001.slice/user@1001.service/app.slice/butchr.service" };
  const herdrListener: SsListener = { port: 7719, uid: 1002, cgroup: "/user.slice/user-1002.slice/user@1002.service/app.slice/herdr.service" };

  test("a butchr.service listener goes in `butchr`", () => {
    expect(partitionCandidates([butchrListener])).toEqual({ butchr: [butchrListener], skipped: [] });
  });

  // REQUIRED (review finding #2): a health-confirmed, daemon-shaped listener whose
  // unit is NOT butchr.service must still surface — as `skipped`, not vanish. If this
  // ever returns `{ butchr: [], skipped: [] }` for a herdr listener, the failure it
  // catches is real: an operator sees "0 identities" instead of "1 skipped".
  test("a health-confirmed listener under a different unit goes in `skipped`, not dropped", () => {
    expect(partitionCandidates([herdrListener])).toEqual({ butchr: [], skipped: [herdrListener] });
  });

  test("a mix is partitioned correctly", () => {
    expect(partitionCandidates([butchrListener, herdrListener])).toEqual({ butchr: [butchrListener], skipped: [herdrListener] });
  });
});

describe("describeSkippedUnit", () => {
  test("names the real unit from the cgroup", () => {
    expect(describeSkippedUnit("/user.slice/user-1002.slice/user@1002.service/app.slice/herdr.service")).toBe("herdr.service");
  });
  test("is honest when there's no cgroup or no systemd unit at all — never guesses a name", () => {
    expect(describeSkippedUnit(null)).toBe("(no cgroup reported)");
    expect(describeSkippedUnit("0::/")).toBe("(not a systemd unit)");
  });
});

describe("journalInvocationFor", () => {
  const userUnit = { kind: "user" as const, unit: "butchr.service", journalctl: "journalctl --user -u butchr.service" };
  const systemUnit = { kind: "system" as const, unit: "butchr.service", journalctl: "journalctl -u butchr.service" };

  test("own identity: uses the unit's own recommended invocation verbatim", () => {
    expect(journalInvocationFor(userUnit, 1001, 1001).command).toBe("journalctl --user -u butchr.service");
  });

  // REQUIRED (blocking review finding): `-u <unit>` matches `_SYSTEMD_UNIT`, but a
  // USER unit's own entries carry `_SYSTEMD_UNIT=user@<uid>.service` and the unit
  // name only in `_SYSTEMD_USER_UNIT=<unit>` — so `-u <unit>` matches NOTHING for a
  // user unit, with or without privilege. Verified live: `journalctl -u
  // butchr.service _UID=<own uid>` returned "-- No entries --" against a journal
  // that `journalctl _SYSTEMD_USER_UNIT=butchr.service _UID=<own uid>` reads fine,
  // unprivileged. So this asserts the FIELD the command scopes by, not the exact
  // string this implementation happens to produce — a test asserting the old
  // (wrong) string would have passed while the invocation matched nothing.
  test("foreign identity, USER unit: NEVER --user (would silently read the reader's own session), and matches _SYSTEMD_USER_UNIT — NOT -u/_SYSTEMD_UNIT, which cannot match a user unit's entries at all", () => {
    const inv = journalInvocationFor(userUnit, 1002, 1001);
    expect(inv.command).not.toContain("--user");
    expect(inv.command).toContain("_SYSTEMD_USER_UNIT=butchr.service");
    expect(inv.command).not.toMatch(/(^|\s)-u\s/);
    expect(inv.command).toContain("_UID=1002");
  });

  test("foreign identity, SYSTEM unit: matches -u/_SYSTEMD_UNIT (correct for a system unit), not _SYSTEMD_USER_UNIT", () => {
    const inv = journalInvocationFor(systemUnit, 1002, 1001);
    expect(inv.command).toMatch(/(^|\s)-u\s+butchr\.service(\s|$)/);
    expect(inv.command).not.toContain("_SYSTEMD_USER_UNIT");
    expect(inv.command).toContain("_UID=1002");
  });

  test("not under systemd at all: no command to run, said honestly", () => {
    const inv = journalInvocationFor({ kind: "none" }, 1001, 1001);
    expect(inv.command).toBe("");
    expect(inv.note).toContain("no journal to read");
  });

  test("no window argument at all: identical to the pre-BUTCHR-86 command, unchanged", () => {
    expect(journalInvocationFor(userUnit, 1001, 1001).command).toBe("journalctl --user -u butchr.service");
  });

  test("a `since` window appends `--since @<epoch>` to the own-identity command", () => {
    const inv = journalInvocationFor(userUnit, 1001, 1001, { kind: "since", sinceEpochSeconds: 1735689600, sinceIso: "2025-01-01T00:00:00.000Z" });
    expect(inv.command).toBe("journalctl --user -u butchr.service --since @1735689600");
  });

  test("a `since` window appends `--since @<epoch>` to the foreign-identity command too", () => {
    const inv = journalInvocationFor(systemUnit, 1002, 1001, { kind: "since", sinceEpochSeconds: 1735689600, sinceIso: "2025-01-01T00:00:00.000Z" });
    expect(inv.command).toBe("journalctl -u butchr.service _UID=1002 --since @1735689600");
  });
});

describe("appendSinceWindow — DoD 6: never a raw operator/health string reaching the shell, only a validated integer", () => {
  test("`{ kind: \"none\" }` leaves the command untouched", () => {
    expect(appendSinceWindow("journalctl -u foo", { kind: "none" })).toBe("journalctl -u foo");
  });

  test("`{ kind: \"since\" }` appends a pure-digit epoch clause", () => {
    expect(appendSinceWindow("journalctl -u foo", { kind: "since", sinceEpochSeconds: 42, sinceIso: "x" })).toBe("journalctl -u foo --since @42");
  });

  // The scenario DoD 6 names explicitly: a malformed timestamp must not be able to
  // break the command or execute anything. Because this function only ever emits a
  // validated integer — never the raw string — there is no space or quote for an
  // adversarial `startedAt` to smuggle a second shell command through in the first
  // place; this asserts that guarantee by construction, not by escaping.
  test("a non-integer sinceEpochSeconds throws rather than ever reaching the shell string", () => {
    expect(() => appendSinceWindow("journalctl -u foo", { kind: "since", sinceEpochSeconds: Number.NaN, sinceIso: "not a real timestamp" })).toThrow();
    expect(() => appendSinceWindow("journalctl -u foo", { kind: "since", sinceEpochSeconds: 1.5, sinceIso: "x" })).toThrow();
  });
});

describe("decideReadability — the null-result rule (the ticket's own harshest acceptance criterion)", () => {
  // Before writing this: the failing case it must catch is a foreign identity
  // whose journal comes back looking exactly like an empty log. If this ever
  // reports `{ readable: true, totalLines: 0 }` for that case, the test fails —
  // that result is indistinguishable from "we proved it quiet," which we did not.
  test("a foreign identity with an empty/permission-gated result is UNREADABLE, never a quiet pass", () => {
    const outcome = decideReadability({
      probe: { exitCode: 0, stdout: "-- No entries --\n", stderr: "" },
      targetUid: 1002,
      readerUid: 1001,
      confirmedLiveViaHealth: true,
      windowed: false,
    });
    expect(outcome.readable).toBe(false);
    if (!outcome.readable) expect(outcome.reason).toContain("uid 1002 is not this reader");
  });

  // BUTCHR-86: windowing never rescues the foreign-identity ambiguity — a cross-user
  // empty read is exactly as indistinguishable from permission-gated under a window
  // as over the whole journal.
  test("a foreign identity with an empty result is UNREADABLE even when the read was windowed", () => {
    const outcome = decideReadability({
      probe: { exitCode: 0, stdout: "-- No entries --\n", stderr: "" },
      targetUid: 1002,
      readerUid: 1001,
      confirmedLiveViaHealth: true,
      windowed: true,
    });
    expect(outcome.readable).toBe(false);
    if (!outcome.readable) expect(outcome.reason).toContain("uid 1002 is not this reader");
  });

  test("journalctl exiting non-zero is UNREADABLE with the real exit code and stderr, not folded into a fake zero", () => {
    const outcome = decideReadability({
      probe: { exitCode: 1, stdout: "", stderr: "Failed to determine unit" },
      targetUid: 1001,
      readerUid: 1001,
      confirmedLiveViaHealth: true,
      windowed: false,
    });
    expect(outcome.readable).toBe(false);
    if (!outcome.readable) expect(outcome.reason).toContain("Failed to determine unit");
  });

  test("our OWN unit, zero lines, but /health confirms it's live right now, UNWINDOWED: UNREADABLE — a live daemon that logged nothing over its WHOLE journal proves the read failed, not that it was quiet", () => {
    const outcome = decideReadability({
      probe: { exitCode: 0, stdout: "-- No entries --\n", stderr: "" },
      targetUid: 1001,
      readerUid: 1001,
      confirmedLiveViaHealth: true,
      windowed: false,
    });
    expect(outcome.readable).toBe(false);
    if (!outcome.readable) expect(outcome.reason).toContain("proof this read is UNREADABLE");
  });

  // BUTCHR-86 DoD 4's named hazard: the SAME zero-lines-from-our-own-live-unit
  // combination that is UNREADABLE over the whole journal is a legitimate quiet
  // result once the read was WINDOWED — a freshly-restarted daemon can genuinely
  // have logged nothing yet in a narrow "since it started" span. Must come back
  // `{ readable: true, totalLines: 0 }`, never folded into the unwindowed UNREADABLE
  // case above (that would drag `computeVerdict` to INCONCLUSIVE for a daemon that
  // simply hasn't had time to log anything since its own restart).
  test("our OWN unit, zero lines, /health confirms it's live right now, WINDOWED: READABLE with totalLines 0 — a narrow window can legitimately be quiet", () => {
    const outcome = decideReadability({
      probe: { exitCode: 0, stdout: "-- No entries --\n", stderr: "" },
      targetUid: 1001,
      readerUid: 1001,
      confirmedLiveViaHealth: true,
      windowed: true,
    });
    expect(outcome).toEqual({ readable: true, totalLines: 0, lines: [] });
  });

  test("our OWN unit, zero lines, liveness not independently confirmed: still UNREADABLE regardless of windowing — a null result is not evidence of a pass", () => {
    const unwindowed = decideReadability({
      probe: { exitCode: 0, stdout: "", stderr: "" },
      targetUid: 1001,
      readerUid: 1001,
      confirmedLiveViaHealth: false,
      windowed: false,
    });
    expect(unwindowed.readable).toBe(false);
    const windowed = decideReadability({
      probe: { exitCode: 0, stdout: "", stderr: "" },
      targetUid: 1001,
      readerUid: 1001,
      confirmedLiveViaHealth: false,
      windowed: true,
    });
    expect(windowed.readable).toBe(false);
  });

  test("positive evidence — at least one real line — is READABLE, with an honest total line count", () => {
    const outcome = decideReadability({
      probe: { exitCode: 0, stdout: "line one\nline two\nline three\n", stderr: "" },
      targetUid: 1001,
      readerUid: 1001,
      confirmedLiveViaHealth: true,
      windowed: false,
    });
    expect(outcome).toEqual({ readable: true, totalLines: 3, lines: ["line one", "line two", "line three"] });
  });
});

describe("buildIdentityReport", () => {
  test("tallies drift/sanctioned/ambiguous/unknown from a readable identity's lines", () => {
    const lines = [
      "  [tools] KAN-1 → transition KAN-1 → Done [deprecated alias; use finish_worker] [alias tool=jira_transition class=drift]",
      "  [tools] KAN-1 → link A → B (Blocks) [alias tool=jira_link_issues class=sanctioned]",
      "  [tools] KAN-1 → assign KAN-1 → x [alias tool=jira_assign class=ambiguous]",
      "  [tools] KAN-1 → link A → B (Implements) [deprecated alias; use new_worker/adopt_worker for an Implements link]", // old format
      "  [tools] KAN-1 → get KAN-1", // not an alias call at all
    ];
    const report = buildIdentityReport({
      uid: 1001,
      unit: "butchr.service",
      journalNote: "own identity",
      outcome: { readable: true, totalLines: lines.length, lines },
      window: NO_WINDOW,
    });
    expect(report).toMatchObject({ drift: 1, sanctioned: 1, ambiguous: 1, unknown: 1 });
  });

  test("an unreadable identity carries all-zero counts — its outcome, not its counts, is what matters", () => {
    const report = buildIdentityReport({
      uid: 1002,
      unit: "butchr.service",
      journalNote: "foreign identity",
      outcome: { readable: false, reason: "unreadable" },
      window: NO_WINDOW,
    });
    expect(report).toMatchObject({ drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0 });
    expect(report.outcome.readable).toBe(false);
  });

  test("the window decision passed in is carried through untouched, independent of readability", () => {
    const windowed: WindowDecision = { window: { kind: "since", sinceEpochSeconds: 1735689600, sinceIso: "2025-01-01T00:00:00.000Z" }, note: "since ..." };
    const report = buildIdentityReport({
      uid: 1001,
      unit: "butchr.service",
      journalNote: "own identity",
      outcome: { readable: false, reason: "unreadable" },
      window: windowed,
    });
    expect(report.window).toEqual(windowed);
  });
});

describe("computeVerdict — structurally incapable of a pass while anything is unreadable", () => {
  const readable = (over: Partial<IdentityReport> = {}): IdentityReport => ({
    uid: 1001, unit: "butchr.service", journalNote: "", outcome: { readable: true, totalLines: 1, lines: [] },
    drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0, window: NO_WINDOW, ...over,
  });
  const unreadable = (over: Partial<IdentityReport> = {}): IdentityReport => ({
    uid: 1002, unit: "butchr.service", journalNote: "", outcome: { readable: false, reason: "nope" },
    drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0, window: NO_WINDOW, ...over,
  });

  // REQUIRED (acceptance criterion): even with zero drift everywhere ELSE readable,
  // one unreadable identity must still make the overall verdict INCONCLUSIVE, never
  // CONDITION_MET — a pass is only available when every discovered identity was
  // provably read.
  test("one unreadable identity forces INCONCLUSIVE even when every readable identity shows zero drift", () => {
    const result = computeVerdict([readable(), unreadable()]);
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.unreadable).toHaveLength(1);
  });

  test("all readable, zero drift, zero unknown-format: CONDITION_MET", () => {
    expect(computeVerdict([readable(), readable({ uid: 1002 })]).verdict).toBe("CONDITION_MET");
  });

  test("all readable but drift > 0 anywhere: CONDITION_NOT_MET", () => {
    expect(computeVerdict([readable({ drift: 1 })]).verdict).toBe("CONDITION_NOT_MET");
  });

  // REQUIRED (acceptance criterion): an old-format line is a REAL alias call that
  // cannot be silently treated as satisfying the condition just because it also
  // isn't confidently "drift" — dropping it would be the same lie as a silent zero.
  test("all readable but an old-format (unknown) line exists anywhere: CONDITION_NOT_MET, not silently a pass", () => {
    expect(computeVerdict([readable({ unknown: 1 })]).verdict).toBe("CONDITION_NOT_MET");
  });

  test("sanctioned and ambiguous calls never block a pass on their own", () => {
    expect(computeVerdict([readable({ sanctioned: 5, ambiguous: 5 })]).verdict).toBe("CONDITION_MET");
  });
});

describe("decideJournalWindow — DoD 1/2/3: the window decision itself, and the degraded-identity call", () => {
  test("--since-start NOT requested: whole journal, and the note says so explicitly (DoD 2 applies even to the default case)", () => {
    const decision = decideJournalWindow(false, { known: false, reason: "irrelevant when not requested" });
    expect(decision.window).toEqual({ kind: "none" });
    expect(decision.note).toContain("whole journal");
    expect(decision.note).toContain("--since-start");
  });

  test("--since-start requested, identity reports a valid startedAt: scoped, epoch computed correctly", () => {
    const decision = decideJournalWindow(true, {
      known: true,
      info: { sha: null, shaProvenance: null, shaDirty: null, shaUnknownReason: null, version: null, startedAt: "2025-01-01T00:00:00.000Z", pid: null },
    });
    expect(decision.window).toEqual({ kind: "since", sinceEpochSeconds: 1735689600, sinceIso: "2025-01-01T00:00:00.000Z" });
    expect(decision.note).toContain("2025-01-01T00:00:00.000Z");
  });

  // THE DEGRADED CASE, DoD 3: --since-start was requested but this identity's build
  // identity is unknown — the ONLY path exercisable end-to-end against this fleet
  // today (deploy-on-merge is off; see the ticket). Must widen to the whole journal
  // rather than refuse the identity outright, and must say so loudly — never a
  // silent narrowing AND never a silent widening.
  test("--since-start requested, build identity UNKNOWN (the live, exercisable-today case): widened to whole journal, loudly", () => {
    const decision = decideJournalWindow(true, { known: false, reason: "this daemon does not report a build identity; it predates the field, or is running an older build" });
    expect(decision.window).toEqual({ kind: "none" });
    expect(decision.note).toContain("--since-start was requested");
    expect(decision.note.toLowerCase()).toContain("widened");
    expect(decision.note).toContain("this daemon does not report a build identity");
  });

  test("--since-start requested, build identity known but startedAt is null: widened to whole journal, loudly", () => {
    const decision = decideJournalWindow(true, {
      known: true,
      info: { sha: null, shaProvenance: null, shaDirty: null, shaUnknownReason: null, version: null, startedAt: null, pid: null },
    });
    expect(decision.window).toEqual({ kind: "none" });
    expect(decision.note.toLowerCase()).toContain("widened");
  });

  test("--since-start requested, startedAt present but unparseable: widened to whole journal, loudly, names the bad value", () => {
    const decision = decideJournalWindow(true, {
      known: true,
      info: { sha: null, shaProvenance: null, shaDirty: null, shaUnknownReason: null, version: null, startedAt: "not a real timestamp", pid: null },
    });
    expect(decision.window).toEqual({ kind: "none" });
    expect(decision.note.toLowerCase()).toContain("widened");
    expect(decision.note).toContain("not a real timestamp");
  });
});

describe("formatWindowLine", () => {
  test("renders the decision's note under a grep-able `window:` prefix", () => {
    expect(formatWindowLine({ window: { kind: "none" }, note: "whole journal (test)" })).toBe("window: whole journal (test)");
  });
});

describe("formatReport", () => {
  test("names every identity, the totals, and a verdict line a human can grep for", () => {
    const id: IdentityReport = {
      uid: 1002, unit: "butchr.service", journalNote: "foreign identity",
      outcome: { readable: false, reason: "cross-user" }, drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0,
      window: NO_WINDOW,
    };
    const result = computeVerdict([id]);
    const text = formatReport([id], result, Date.parse("2026-01-01T00:00:00.000Z"));
    expect(text).toContain("uid=1002");
    expect(text).toContain("UNREADABLE");
    expect(text).toContain("VERDICT: INCONCLUSIVE");
  });

  // DoD 2's headline falsifier, asserted directly: the window in force must be
  // visible even in the default, un-requested, whole-journal case — never inferred,
  // never omitted, never blank.
  test("the window in force is stated even in the default no-window case", () => {
    const id: IdentityReport = {
      uid: 1001, unit: "butchr.service", journalNote: "own identity",
      outcome: { readable: true, totalLines: 5, lines: [] }, drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0,
      window: NO_WINDOW,
    };
    const result = computeVerdict([id]);
    const text = formatReport([id], result, Date.now());
    expect(text).toContain("window: whole journal");
    expect(text).toContain("--since-start");
  });

  test("the window in force is stated for a since-start-scoped identity", () => {
    const decision = decideJournalWindow(true, { known: true, info: { sha: null, shaProvenance: null, shaDirty: null, shaUnknownReason: null, version: null, startedAt: "2026-01-01T00:00:00.000Z", pid: null } });
    const id: IdentityReport = {
      uid: 1001, unit: "butchr.service", journalNote: "own identity",
      outcome: { readable: true, totalLines: 0, lines: [] }, drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0,
      window: decision,
    };
    const result = computeVerdict([id]);
    const text = formatReport([id], result, Date.now());
    expect(text).toContain("window: since this identity's process started at 2026-01-01T00:00:00.000Z");
  });
});

describe("decideBuildIdentity — BUTCHR-54: build identity is a SEPARATE axis from journal readability", () => {
  // THE CASE THE TICKET NAMES AS THE ONE YOU WILL ACTUALLY HIT: deploy-on-merge
  // is off, so a daemon discovered right now answers /health daemon-shaped but
  // predates this field entirely. Must be an explicit, worded unknown — never
  // a blank column, never silently folded into "known: true" with nulls.
  test("a daemon-shaped /health body with no build field at all: explicit unknown, exact wording", () => {
    const outcome = decideBuildIdentity({ ok: true, components: [] });
    expect(outcome).toEqual({
      known: false,
      reason: "this daemon does not report a build identity; it predates the field, or is running an older build",
    });
  });

  test("a fully-populated build field: known, every field parsed through", () => {
    const outcome = decideBuildIdentity({
      ok: true,
      components: [],
      build: {
        sha: "a".repeat(40), shaProvenance: "baked", shaDirty: true, shaUnknownReason: null,
        version: "1.2.3", startedAt: "2026-01-01T00:00:00.000Z", pid: 4242,
        unit: "butchr.service", journalctl: "journalctl --user -u butchr.service",
      },
    });
    expect(outcome).toEqual({
      known: true,
      info: {
        sha: "a".repeat(40), shaProvenance: "baked", shaDirty: true, shaUnknownReason: null,
        version: "1.2.3", startedAt: "2026-01-01T00:00:00.000Z", pid: 4242,
      },
    });
  });

  test("a build field reporting its OWN honest sha-unknown (git-at-start failed on that daemon): known: true, sha: null, reason carried through", () => {
    const outcome = decideBuildIdentity({
      ok: true, components: [],
      build: { sha: null, shaProvenance: null, shaDirty: null, shaUnknownReason: "no readable git repository", version: "1.2.3", startedAt: "2026-01-01T00:00:00.000Z", pid: 1, unit: "(none)", journalctl: "" },
    });
    expect(outcome).toEqual({ known: true, info: { sha: null, shaProvenance: null, shaDirty: null, shaUnknownReason: "no readable git repository", version: "1.2.3", startedAt: "2026-01-01T00:00:00.000Z", pid: 1 } });
  });

  test("null / non-object input never throws — explicit unknown, same wording", () => {
    expect(decideBuildIdentity(null).known).toBe(false);
    expect(decideBuildIdentity(undefined).known).toBe(false);
    expect(decideBuildIdentity("not an object").known).toBe(false);
  });

  test("a malformed build field (wrong types) degrades individual fields to null/unknown rather than throwing or fabricating", () => {
    const outcome = decideBuildIdentity({ ok: true, components: [], build: { sha: 12345, shaProvenance: "not-a-real-provenance", version: 9 } }) as Extract<BuildOutcome, { known: true }>;
    expect(outcome.known).toBe(true);
    expect(outcome.info.sha).toBeNull();
    expect(outcome.info.shaProvenance).toBeNull();
    expect(outcome.info.version).toBeNull();
  });
});

describe("formatUptime", () => {
  const START = Date.parse("2026-01-01T00:00:00.000Z");
  test("no startedAt: honest unknown, never a fabricated duration", () => {
    expect(formatUptime(null, START)).toBe("unknown");
  });
  test("unparseable startedAt: honest unknown", () => {
    expect(formatUptime("not a date", START)).toBe("unknown");
  });
  test("seconds only", () => {
    expect(formatUptime("2026-01-01T00:00:00.000Z", START + 42_000)).toBe("42s");
  });
  test("hours + minutes + seconds", () => {
    expect(formatUptime("2026-01-01T00:00:00.000Z", START + (2 * 3600 + 5 * 60 + 9) * 1000)).toBe("2h 5m 9s");
  });
  test("days included once uptime crosses a day", () => {
    expect(formatUptime("2026-01-01T00:00:00.000Z", START + (3 * 86400 + 3661) * 1000)).toBe("3d 1h 1m 1s");
  });
});

describe("formatBuildLine", () => {
  const now = Date.parse("2026-01-01T01:00:00.000Z");
  test("unknown outcome: the reason, verbatim", () => {
    expect(formatBuildLine({ known: false, reason: "this daemon does not report a build identity; it predates the field, or is running an older build" }, now))
      .toBe("build: unknown — this daemon does not report a build identity; it predates the field, or is running an older build");
  });
  test("known, baked, clean: sha + provenance + version + uptime + pid, no dirty note", () => {
    const line = formatBuildLine({ known: true, info: { sha: "a".repeat(40), shaProvenance: "baked", shaDirty: false, shaUnknownReason: null, version: "1.2.3", startedAt: "2026-01-01T00:00:00.000Z", pid: 4242 } }, now);
    expect(line).toBe(`build: sha=${"a".repeat(40)} (baked) version=1.2.3 uptime=1h 0m 0s pid=4242`);
  });
  test("known, git-at-start, dirty: dirty note included", () => {
    const line = formatBuildLine({ known: true, info: { sha: "b".repeat(40), shaProvenance: "git-at-start", shaDirty: true, shaUnknownReason: null, version: "1.2.3", startedAt: "2026-01-01T00:00:00.000Z", pid: 1 } }, now);
    expect(line).toContain("dirty working tree at start");
  });
  test("known, but this daemon's OWN sha is unknown: reason surfaces inline, never a blank sha", () => {
    const line = formatBuildLine({ known: true, info: { sha: null, shaProvenance: null, shaDirty: null, shaUnknownReason: "no readable git repository above /dist", version: "1.2.3", startedAt: "2026-01-01T00:00:00.000Z", pid: 1 } }, now);
    expect(line).toBe("build: sha=unknown (no readable git repository above /dist) version=1.2.3 uptime=1h 0m 0s pid=1");
  });
});

describe("formatReport carries the build line for every identity, alongside — never instead of — the readability report", () => {
  test("an UNREADABLE identity with a KNOWN build still prints both, independently", () => {
    const id: IdentityReport = {
      uid: 1001, unit: "butchr.service", journalNote: "own identity",
      outcome: { readable: false, reason: "zero lines, unconfirmed" },
      drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0,
      build: { known: true, info: { sha: "c".repeat(40), shaProvenance: "baked", shaDirty: false, shaUnknownReason: null, version: "1.2.3", startedAt: "2026-01-01T00:00:00.000Z", pid: 1 } },
      window: NO_WINDOW,
    };
    const text = formatReport([id], computeVerdict([id]), Date.parse("2026-01-01T00:00:00.000Z"));
    expect(text).toContain("UNREADABLE");
    expect(text).toContain(`sha=${"c".repeat(40)}`);
  });

  // THE OLD-BUILD-WITH-NO-FIELD CASE, end to end through formatReport: a
  // READABLE identity (journal is fine) whose /health simply predates this
  // ticket must still show an explicit build-unknown line, never a blank one
  // and never one that borrows the journal axis's "readable" status.
  test("a READABLE identity with build identity genuinely unreported: readable journal, explicit build-unknown, never conflated", () => {
    const id: IdentityReport = {
      uid: 1001, unit: "butchr.service", journalNote: "own identity",
      outcome: { readable: true, totalLines: 2, lines: [] },
      drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0,
      build: decideBuildIdentity({ ok: true, components: [] }),
      window: NO_WINDOW,
    };
    const text = formatReport([id], computeVerdict([id]), Date.parse("2026-01-01T00:00:00.000Z"));
    expect(text).toContain("READABLE");
    expect(text).toContain("build: unknown — this daemon does not report a build identity");
  });

  test("an IdentityReport built without a `build` field at all (pre-BUTCHR-54 literal): a distinct \"not probed\" line, never a crash or a blank", () => {
    const id: IdentityReport = {
      uid: 1002, unit: "butchr.service", journalNote: "foreign identity",
      outcome: { readable: false, reason: "cross-user" }, drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0,
      window: NO_WINDOW,
    };
    const text = formatReport([id], computeVerdict([id]), Date.now());
    expect(text).toContain("build: unknown — build identity was not probed");
  });
});
