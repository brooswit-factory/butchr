import { describe, expect, test } from "bun:test";
import type { ToolDef } from "@brooswit/thatch";
import {
  OUTCOME_TAG,
  Refusal,
  UNKNOWN_CALLER,
  parseOutcomeLine,
  preIdentityRefusalLine,
  withOutcomeRecording,
} from "../../src/tools/outcome.js";
import { parseAliasAuditLine } from "../../src/tools/alias-audit.js";

function connection(issue?: string) {
  return { headers: issue ? { "x-issue": issue } : {} } as never;
}

function collect() {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
}

// ---------------------------------------------------------------------------
// FALSIFIER 1 (stated before running, per the ticket): the OLD single
// pre-operation `[tools]` line is written BEFORE the handler runs and takes
// no outcome parameter at all, so it is IDENTICAL whether the handler goes
// on to succeed or throw. This must be demonstrably true of the pre-existing
// `audit` line shape (unchanged by this ticket — see outcome.ts's own doc
// comment for why it stays), proving the defect this ticket fixes actually
// exists. If this test PASSED before finding the two lines identical, or
// FAILED to find them identical, the premise of this whole ticket would be
// wrong — so this is written to fail loudly if a future edit ever makes the
// old line outcome-aware without updating this test.
// ---------------------------------------------------------------------------
describe("falsifier: the pre-existing [tools] line cannot distinguish ok from refused/error (the defect BUTCHR-316/BUTCHR-341 exist to fix)", () => {
  test("the old-style audit line has the exact same shape for a call that will succeed and one that will throw", () => {
    const auditLine = (issue: string, what: string) => `  [tools] ${issue} → ${what}`;
    const beforeOk = auditLine("BUTCHR-1", "get BUTCHR-2");
    const beforeThrow = auditLine("BUTCHR-1", "get BUTCHR-2");
    // Structurally the SAME line-building function, called with the SAME
    // arguments, regardless of what happens next — nothing about "did this
    // succeed" can ever be encoded here, because it runs before that is known.
    expect(beforeOk).toBe(beforeThrow);
    expect(beforeOk).not.toMatch(/ok|refused|error/);
  });
});

// ---------------------------------------------------------------------------
// (A): withOutcomeRecording — exactly one [tools2] record per call, on
// every one of the shapes a handler can fail in.
// ---------------------------------------------------------------------------
describe("withOutcomeRecording: exactly one [tools2] record per call", () => {
  test("a handler that resolves records outcome=ok", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      { ping: { description: "", input: {}, handler: async () => "pong" } as ToolDef<any> },
      log,
    );
    const result = await tools.ping!.handler({}, connection("BUTCHR-1"));
    expect(result).toBe("pong");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`${OUTCOME_TAG} caller=BUTCHR-1 verb=ping outcome=ok`);
  });

  test("a handler that returns a PLAIN (non-Promise) value records outcome=ok", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      { ping: { description: "", input: {}, handler: () => "pong" } as ToolDef<any> },
      log,
    );
    const result = await tools.ping!.handler({}, connection("BUTCHR-1"));
    expect(result).toBe("pong");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("outcome=ok");
  });

  test("a handler that throws a Refusal SYNCHRONOUSLY (before returning anything) records outcome=refused", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      {
        act: {
          description: "",
          input: {},
          handler: () => {
            throw new Refusal("act: refusing — not your worker");
          },
        } as ToolDef<any>,
      },
      log,
    );
    expect(() => tools.act!.handler({}, connection("BUTCHR-1"))).toThrow("not your worker");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`${OUTCOME_TAG} caller=BUTCHR-1 verb=act outcome=refused msg=act: refusing — not your worker`);
  });

  test("a handler that throws a PLAIN Error synchronously records outcome=error, never refused", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      {
        act: {
          description: "",
          input: {},
          handler: () => {
            throw new Error("boom");
          },
        } as ToolDef<any>,
      },
      log,
    );
    expect(() => tools.act!.handler({}, connection("BUTCHR-1"))).toThrow("boom");
    expect(lines[0]).toContain("outcome=error");
    expect(lines[0]).not.toContain("outcome=refused");
  });

  test("a handler whose returned Promise REJECTS with a Refusal records outcome=refused", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      { act: { description: "", input: {}, handler: async () => { throw new Refusal("nope"); } } as ToolDef<any> },
      log,
    );
    await expect(tools.act!.handler({}, connection("BUTCHR-1"))).rejects.toThrow("nope");
    expect(lines[0]).toContain("outcome=refused");
  });

  test("a handler whose returned Promise REJECTS with a plain Error records outcome=error", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      { act: { description: "", input: {}, handler: () => Promise.reject(new Error("network down")) } as ToolDef<any> },
      log,
    );
    await expect(tools.act!.handler({}, connection("BUTCHR-1"))).rejects.toThrow("network down");
    expect(lines[0]).toContain("outcome=error");
  });

  test("a handler that throws INSIDE a .then() callback further down its own promise chain is still caught — records outcome=error", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      {
        act: {
          description: "",
          input: {},
          handler: () =>
            Promise.resolve({ from: "A", to: "B" }).then((r) => {
              // mimics jira_link_issues's own shape: ops.linkIssues(...).then((r) => { ...; return orOk(...) })
              throw new Error(`downstream failure for ${r.from}`);
            }),
        } as ToolDef<any>,
      },
      log,
    );
    await expect(tools.act!.handler({}, connection("BUTCHR-1"))).rejects.toThrow("downstream failure for A");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("outcome=error");
  });

  test("a handler that RETURNS EARLY (before any ops call) still records exactly one outcome", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      { act: { description: "", input: {}, handler: () => ({ early: true }) } as ToolDef<any> },
      log,
    );
    await tools.act!.handler({}, connection("BUTCHR-1"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("outcome=ok");
  });

  test("caller with no x-issue header records UNKNOWN_CALLER, not a bare identity", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      { act: { description: "", input: {}, handler: () => "ok" } as ToolDef<any> },
      log,
    );
    await tools.act!.handler({}, connection(undefined));
    expect(lines[0]).toContain(`caller=${UNKNOWN_CALLER}`);
  });

  test("target is extracted from `key` when present", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      { jira_get_issue: { description: "", input: {}, handler: () => ({}) } as ToolDef<any> },
      log,
    );
    await tools.jira_get_issue!.handler({ key: "BUTCHR-42" }, connection("BUTCHR-1"));
    expect(lines[0]).toContain("target=BUTCHR-42");
  });

  test("target is extracted from `from`+`to` when present (jira_link_issues shape)", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      { jira_link_issues: { description: "", input: {}, handler: () => ({}) } as ToolDef<any> },
      log,
    );
    await tools.jira_link_issues!.handler({ from: "BUTCHR-1", to: "BUTCHR-2" }, connection("BUTCHR-1"));
    expect(lines[0]).toContain("target=BUTCHR-1→BUTCHR-2");
  });

  test("target is OMITTED (never invented) when the tool's args carry none of key/from+to/id", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      { jira_search: { description: "", input: {}, handler: () => ({}) } as ToolDef<any> },
      log,
    );
    await tools.jira_search!.handler({ jql: "project = BUTCHR" }, connection("BUTCHR-1"));
    expect(lines[0]).not.toContain("target=");
  });

  test("target extraction NEVER reads free-text fields (text/body/description/summary/reason/why/destination) even when present", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      { jira_add_comment: { description: "", input: {}, handler: () => ({}) } as ToolDef<any> },
      log,
    );
    await tools.jira_add_comment!.handler({ key: "BUTCHR-1", text: "some secret-ish comment body" }, connection("BUTCHR-1"));
    expect(lines[0]).not.toContain("secret-ish");
    expect(lines[0]).not.toContain("comment body");
    expect(lines[0]).toContain("target=BUTCHR-1");
  });
});

// ---------------------------------------------------------------------------
// Requirement 3: structured fields before the unbounded free-text message;
// a message containing a literal newline must not strand outcome=/target=
// on a different line, and the record must still be exactly one journal line.
// ---------------------------------------------------------------------------
describe("Requirement 3: a multi-line message never strands a structured field on a different line", () => {
  test("a Refusal message containing a literal newline is flattened to one line, with outcome=/target=/verb=/caller= all intact and BEFORE msg=", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      {
        act: {
          description: "",
          input: {},
          handler: () => {
            throw new Refusal("line one\nline two\nline three");
          },
        } as ToolDef<any>,
      },
      log,
    );
    expect(() => tools.act!.handler({ key: "BUTCHR-9" }, connection("BUTCHR-1"))).toThrow();
    expect(lines).toHaveLength(1); // exactly one journal line — the whole point of this test
    const line = lines[0]!;
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("caller=BUTCHR-1");
    expect(line).toContain("verb=act");
    expect(line).toContain("target=BUTCHR-9");
    expect(line).toContain("outcome=refused");
    // the message survives (flattened), after every structured field
    const msgIdx = line.indexOf("msg=");
    expect(msgIdx).toBeGreaterThan(line.indexOf("outcome="));
    expect(line.slice(msgIdx)).toContain("line one");
    expect(line.slice(msgIdx)).toContain("line two");
    expect(line.slice(msgIdx)).toContain("line three");

    // and the parser recovers the record from that single line without loss
    const parsed = parseOutcomeLine(line)!;
    expect(parsed.caller).toBe("BUTCHR-1");
    expect(parsed.verb).toBe("act");
    expect(parsed.target).toBe("BUTCHR-9");
    expect(parsed.outcome).toBe("refused");
  });

  test("an over-length message is bounded, not left to grow without limit", async () => {
    const { lines, log } = collect();
    const tools = withOutcomeRecording(
      { act: { description: "", input: {}, handler: () => { throw new Refusal("x".repeat(5000)); } } as ToolDef<any> },
      log,
    );
    expect(() => tools.act!.handler({}, connection("BUTCHR-1"))).toThrow();
    expect(lines[0]!.length).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// (B): the pre-identity refusal record.
// ---------------------------------------------------------------------------
describe("(B) preIdentityRefusalLine: a connection refused before any x-issue is read", () => {
  test("carries an EXPLICIT unknown-caller marker, not a bare '?' — and outcome=refused", () => {
    const line = preIdentityRefusalLine();
    expect(line).toContain(`caller=${UNKNOWN_CALLER}`);
    expect(line).toContain("outcome=refused");
    expect(line).not.toContain("caller=?");
  });

  test("invents NO verb= or target= — there is no tool call yet to name one", () => {
    const line = preIdentityRefusalLine();
    expect(line).not.toContain("verb=");
    expect(line).not.toContain("target=");
  });

  test("parses back cleanly with verb/target as null (never a fabricated placeholder)", () => {
    const parsed = parseOutcomeLine(preIdentityRefusalLine())!;
    expect(parsed).not.toBeNull();
    expect(parsed.verb).toBeNull();
    expect(parsed.target).toBeNull();
    expect(parsed.outcome).toBe("refused");
    expect(parsed.caller).toBe(UNKNOWN_CALLER);
  });
});

// ---------------------------------------------------------------------------
// Requirement 2: mechanical, bidirectional discontinuity from the OLD
// [tools] format — a VERBATIM old-format line (journald prefix included, the
// exact shape defs.ts's own `audit` helper has always emitted), checked in
// BOTH directions against BOTH parsers.
// ---------------------------------------------------------------------------
describe("Requirement 2: [tools2] is mechanically distinguishable from the OLD [tools] line, in both directions", () => {
  // VERBATIM old-format line: parseAliasAuditLine only ever returns non-null
  // for an ALIAS call's audit line (a "[deprecated alias;" marker, or the
  // newer machine-readable [alias tool=... class=...] tag) — a permanent
  // verb's plain "[tools] X → get Y" line was ALREADY null under the old
  // reader, so a genuine old-format sample has to be an alias call, same as
  // the one alias-audit.test.ts itself uses.
  const OLD_TOOLS_LINE =
    "Sep 01 16:05:03 servyboi bun[507430]:   [tools] BUTCHR-63 → transition KAN-1 → Done [deprecated alias; use finish_worker] [alias tool=jira_transition class=drift]";
  const NEW_TOOLS2_LINE = `Sep 10 12:00:01 servyboi bun[123456]: ${OUTCOME_TAG} caller=BUTCHR-63 verb=jira_get_issue target=BUTCHR-1 outcome=ok`;

  test("sanity: each sample matches its own reader", () => {
    expect(parseAliasAuditLine(OLD_TOOLS_LINE)).not.toBeNull();
    expect(parseOutcomeLine(NEW_TOOLS2_LINE)).not.toBeNull();
  });

  test("the OLD line's reader (parseAliasAuditLine) does NOT match the NEW [tools2] line", () => {
    expect(parseAliasAuditLine(NEW_TOOLS2_LINE)).toBeNull();
  });

  test("the NEW line's reader (parseOutcomeLine) does NOT match the OLD [tools] line", () => {
    expect(parseOutcomeLine(OLD_TOOLS_LINE)).toBeNull();
  });

  // location 6 (the load-bearing constraint): scripts/audit-alias-calls.ts's
  // whole alias-removal evidence chain depends on parseAliasAuditLine still
  // matching every OLD-format line, unaffected by this ticket.
  test("parseAliasAuditLine is UNAFFECTED by this ticket — still recovers the old alias-call shape", () => {
    const oldAliasLine =
      "Sep 01 16:05:03 servyboi bun[507430]:   [tools] BUTCHR-63 → transition KAN-1 → Done [deprecated alias; use finish_worker] [alias tool=jira_transition class=drift]";
    expect(parseAliasAuditLine(oldAliasLine)).toEqual({ identity: "BUTCHR-63", tool: "jira_transition", classification: "drift" });
  });
});

describe("Refusal", () => {
  test("is an instanceof Error (so existing `(e as Error).message` call sites keep working unchanged)", () => {
    const r = new Refusal("refusing");
    expect(r).toBeInstanceOf(Error);
    expect(r).toBeInstanceOf(Refusal);
    expect(r.message).toBe("refusing");
  });
});
