import { describe, expect, test } from "bun:test";
import {
  buildIdentityReport,
  computeVerdict,
  decideReadability,
  describeSkippedUnit,
  formatReport,
  journalInvocationFor,
  looksLikeButchrUnit,
  parseSsListeners,
  partitionCandidates,
  type IdentityReport,
  type SsListener,
} from "../../scripts/audit-alias-calls.js";

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
    });
    expect(outcome.readable).toBe(false);
    if (!outcome.readable) expect(outcome.reason).toContain("Failed to determine unit");
  });

  test("our OWN unit, zero lines, but /health confirms it's live right now: UNREADABLE — a live daemon that logged nothing proves the read failed, not that it was quiet", () => {
    const outcome = decideReadability({
      probe: { exitCode: 0, stdout: "-- No entries --\n", stderr: "" },
      targetUid: 1001,
      readerUid: 1001,
      confirmedLiveViaHealth: true,
    });
    expect(outcome.readable).toBe(false);
    if (!outcome.readable) expect(outcome.reason).toContain("proof this read is UNREADABLE");
  });

  test("our OWN unit, zero lines, liveness not independently confirmed: still UNREADABLE — a null result is not evidence of a pass", () => {
    const outcome = decideReadability({
      probe: { exitCode: 0, stdout: "", stderr: "" },
      targetUid: 1001,
      readerUid: 1001,
      confirmedLiveViaHealth: false,
    });
    expect(outcome.readable).toBe(false);
  });

  test("positive evidence — at least one real line — is READABLE, with an honest total line count", () => {
    const outcome = decideReadability({
      probe: { exitCode: 0, stdout: "line one\nline two\nline three\n", stderr: "" },
      targetUid: 1001,
      readerUid: 1001,
      confirmedLiveViaHealth: true,
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
    });
    expect(report).toMatchObject({ drift: 1, sanctioned: 1, ambiguous: 1, unknown: 1 });
  });

  test("an unreadable identity carries all-zero counts — its outcome, not its counts, is what matters", () => {
    const report = buildIdentityReport({
      uid: 1002,
      unit: "butchr.service",
      journalNote: "foreign identity",
      outcome: { readable: false, reason: "unreadable" },
    });
    expect(report).toMatchObject({ drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0 });
    expect(report.outcome.readable).toBe(false);
  });
});

describe("computeVerdict — structurally incapable of a pass while anything is unreadable", () => {
  const readable = (over: Partial<IdentityReport> = {}): IdentityReport => ({
    uid: 1001, unit: "butchr.service", journalNote: "", outcome: { readable: true, totalLines: 1, lines: [] },
    drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0, ...over,
  });
  const unreadable = (over: Partial<IdentityReport> = {}): IdentityReport => ({
    uid: 1002, unit: "butchr.service", journalNote: "", outcome: { readable: false, reason: "nope" },
    drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0, ...over,
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

describe("formatReport", () => {
  test("names every identity, the totals, and a verdict line a human can grep for", () => {
    const id: IdentityReport = {
      uid: 1002, unit: "butchr.service", journalNote: "foreign identity",
      outcome: { readable: false, reason: "cross-user" }, drift: 0, sanctioned: 0, ambiguous: 0, unknown: 0,
    };
    const result = computeVerdict([id]);
    const text = formatReport([id], result);
    expect(text).toContain("uid=1002");
    expect(text).toContain("UNREADABLE");
    expect(text).toContain("VERDICT: INCONCLUSIVE");
  });
});
