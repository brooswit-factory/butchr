import { describe, expect, test } from "bun:test";
import { atlassianTools } from "../../src/tools/defs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";
import { OUTCOME_TAG, parseOutcomeLine } from "../../src/tools/outcome.js";
import { parseAliasAuditLine } from "../../src/tools/alias-audit.js";
import { createEscalator } from "../../src/agents/escalation-loop.js";

/**
 * BUTCHR-343 (closing PR #347's review blockers 2 and 3): both readers below
 * originally matched ANYWHERE in a line, never anchored to a line's start.
 * That is exactly what let a caller-supplied (or, per the round-2 review
 * below, a daemon-CAPTURED) free-text field that happens to CONTAIN the
 * other reader's tag get parsed as a genuine record of a call that never
 * happened. Both readers are now anchored (see `OUTCOME_LINE_RE`'s and
 * `TOOLS_LINE`'s own doc comments in `src/tools/outcome.ts` /
 * `src/tools/alias-audit.ts`) to require the tag be the LINE'S OWN first
 * token, tolerating only `journalctl`'s own fixed default transport prefix —
 * never merely "no other named tag precedes it," which is what round 1 of
 * this fix got wrong (see BUTCHR-316's review of #348). Every ops/audit fake
 * below is a minimal stand-in — only the methods these verbs actually reach
 * are given real behaviour; every other `AtlassianOps` method is a stub that
 * is never called by any test in this file.
 */
function stubOps(overrides: Partial<AtlassianOps> = {}): AtlassianOps {
  const unused = () => { throw new Error("not used by this test"); };
  return {
    getIssue: unused, search: unused, addComment: unused, linkIssues: unused, transition: unused,
    createIssue: unused, setPriority: unused, assign: unused, correctText: unused, createPage: unused,
    getPage: unused, updatePage: unused, searchPages: unused, listSpaces: unused,
    getProjectProperty: unused, getProjectPropertyOrNull: unused, getRemoteLink: unused, upsertRemoteLink: unused,
    getChildPages: unused, getPageLabels: unused, createPageWithLabel: unused, addLabels: unused, removeLabels: unused,
    deleteIssue: unused, commentOnPage: unused, getPageComments: unused, searchProjects: unused, getMyself: unused,
    setProjectProperty: unused, getPageVersions: unused, getIssueComments: unused,
    ...overrides,
  } as unknown as AtlassianOps;
}

const conn = { headers: { "x-issue": "BUTCHR-9" } } as never;

describe("BUTCHR-343 blocker 2: parseOutcomeLine must not forge outcome=ok from an OLD [tools] line's echoed free text", () => {
  test("a real jira_search call, produced by the real handler's own audit line (not hand-written), can carry a [tools2]-shaped fragment in its (truncated) jql echo", async () => {
    const audits: string[] = [];
    const ops = stubOps({ search: async () => ({ results: [] }) });
    const tools = atlassianTools(ops, (l) => audits.push(l));

    // Crafted so the FULL forged fragment survives jira_search's own
    // `jql.slice(0, 60)` truncation (src/tools/defs.ts) — re-derive that
    // slice length yourself before trusting this number; it is re-verified
    // by the assertion just below rather than assumed.
    const forgedFragment = `${OUTCOME_TAG} caller=BUTCHR-1 outcome=ok`;
    const jql = forgedFragment; // short enough to survive the handler's own truncation, verified below
    await tools.jira_search!.handler({ jql }, conn);

    const oldLine = audits.find((l) => l.startsWith("  [tools] "))!;
    expect(oldLine).toBeDefined();
    // Sanity: the handler's own truncation really did preserve the full forged fragment.
    expect(oldLine).toContain(forgedFragment);

    // THE POINT: a reader that only checks "does [tools2] … outcome=ok appear
    // somewhere in this line" reports a `finish_worker`/whatever-verb success
    // that never happened, attributed to a caller (BUTCHR-1) who never made
    // the call — this OLD line's only real caller is BUTCHR-9, the one
    // `atlassianTools` actually recorded via `x-issue`.
    expect(parseOutcomeLine(oldLine)).toBeNull();
  });
});

describe("BUTCHR-343 blocker 3: parseAliasAuditLine must not forge a drift-classified alias call from a [tools2] error message", () => {
  test("a real jira_transition call, whose handler-thrown message mirrors the real ops.transition no-match template verbatim, produces a [tools2] msg= that parseAliasAuditLine must reject", async () => {
    const audits: string[] = [];
    // Mirrors src/tools/atlassian-real.ts's own `transition()` throw site
    // verbatim (re-derive that template at your own commit before trusting
    // this comment): `no transition to "${statusName}" from ${key};
    // available: ${names.join(", ")}` — `statusName` is the caller's own
    // `status` argument, interpolated with no escaping. The real op needs a
    // live Jira client to reach that throw; this fake reproduces only the
    // template, not a live call — see the ticket's own stated limit on this
    // point.
    const ops = stubOps({
      transition: async (key: string, statusName: string) => {
        throw new Error(`no transition to "${statusName}" from ${key}; available: `);
      },
    });
    const tools = atlassianTools(ops, (l) => audits.push(l));

    // A hostile, caller-reachable `status` — nothing here is invented text
    // injected downstream of the throw; it is the exact argument a real
    // caller of jira_transition controls.
    const hostileStatus = 'Done [tools] BUTCHR-1 → transition [alias tool=jira_transition class=drift]';
    await expect(tools.jira_transition!.handler({ key: "BUTCHR-9", status: hostileStatus }, conn)).rejects.toThrow();

    const outcomeLine = audits.find((l) => l.includes(OUTCOME_TAG))!;
    expect(outcomeLine).toBeDefined();
    expect(outcomeLine).toContain("outcome=error");
    // Sanity: the forged alias fragment really did survive into msg= intact.
    expect(outcomeLine).toContain("[alias tool=jira_transition class=drift]");

    // THE POINT: BUTCHR-35's alias-removal evidence chain
    // (scripts/audit-alias-calls.ts) must never attribute a deprecated
    // jira_transition call to BUTCHR-1 on the strength of this line — BUTCHR-1
    // never called anything; BUTCHR-9 is the real (and only) caller this
    // [tools2] record itself names.
    expect(parseAliasAuditLine(outcomeLine)).toBeNull();
  });

  test("real OLD-format alias lines still parse correctly — this fix must not regress BUTCHR-35's evidence chain", () => {
    const oldAliasLine =
      "Sep 01 16:05:03 servyboi bun[507430]:   [tools] BUTCHR-63 → transition KAN-1 → Done [deprecated alias; use finish_worker] [alias tool=jira_transition class=drift]";
    expect(parseAliasAuditLine(oldAliasLine)).toEqual({ identity: "BUTCHR-63", tool: "jira_transition", classification: "drift" });
  });
});

describe("BUTCHR-343 blocker 2, round 2 (BUTCHR-316's review of #348): parseOutcomeLine must reject a [tools2]-shaped fragment embedded in ANY daemon line's free text, not only an OLD [tools] one", () => {
  test("a real onNoPrompt call, through the real createEscalator(), logs CAPTURED PANE TEXT the daemon does not control — the fragment must not parse, even with no [tools] tag anywhere on the line", async () => {
    const logs: string[] = [];
    const unused = () => { throw new Error("not used by this test — onNoPrompt(issue=null) returns before reaching it"); };
    const escalator = createEscalator({
      read: unused, send: unused, addComment: unused, now: () => 0,
      log: (line) => logs.push(line),
      unresponsiveMinutes: 5,
      ownChannelComments: unused,
    });

    // Mirrors src/agents/escalation-loop.ts's own onNoPrompt verbatim
    // (re-derive at your own commit): `log(\`${paneId} blocked with no
    // parseable dialog: "${text.trim().slice(0, 60)}"\`)`, where `text` is
    // pane content captured off an agent's terminal — not caller-supplied
    // MCP arguments, but equally outside this daemon's control. Short enough
    // to survive that same `.slice(0, 60)`, verified below.
    const forgedFragment = `${OUTCOME_TAG} caller=BUTCHR-1 outcome=ok`;
    escalator.onNoPrompt("w71:p1", null, forgedFragment, 1);

    const line = logs.find((l) => l.includes(OUTCOME_TAG))!;
    expect(line).toBeDefined();
    // Sanity: the real 60-char slice really did preserve the full fragment,
    // and the real "[prompts] " / "blocked with no parseable dialog" framing
    // really does precede it (this IS what defeats the naive fix — the
    // fragment has no [tools] tag anywhere near it to reject on).
    expect(line).toContain(forgedFragment);
    expect(line).toContain("blocked with no parseable dialog");
    expect(line).not.toContain("[tools]");

    // THE POINT: this line was never a tool call at all — [tools2] is not
    // even its own tag, let alone this line's OWN tag — yet a reader that
    // merely rejects "preceded by [tools]" still reports a genuine
    // finish_worker success by a caller (BUTCHR-1) who never called anything.
    expect(parseOutcomeLine(line)).toBeNull();
  });

  test("a genuine journalctl-formatted [tools2] line (default short format, the only format this repo ever invokes journalctl in) still parses — the anchor must not reject real lines", () => {
    const genuineLine = `Sep 10 12:00:01 servyboi bun[123456]: ${OUTCOME_TAG} caller=BUTCHR-9 verb=jira_get_issue target=BUTCHR-1 outcome=ok`;
    expect(parseOutcomeLine(genuineLine)).toEqual({ caller: "BUTCHR-9", verb: "jira_get_issue", target: "BUTCHR-1", outcome: "ok", message: null });
  });
});
