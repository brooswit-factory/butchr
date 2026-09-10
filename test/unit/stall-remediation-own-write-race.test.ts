import { describe, expect, test } from "bun:test";
import { createLabelSync, type LabelWriter } from "../../src/labels/sync.js";
import { createStallRemediator } from "../../src/agents/stall-remediation.js";
import { createOwnWriteLedger, DAEMON_WRITER } from "../../src/jira-watch/own-writes.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

/**
 * BUTCHR-221/BUTCHR-210's own-write hazard, exercised end to end against the
 * REAL own-write ledger (src/jira-watch/own-writes.ts) — not a description
 * of the race, a reproduction of it.
 *
 * THE HAZARD (stated once, precisely, so both scenarios below can be judged
 * against it): src/daemon/index.ts's `recordOwnWrite` fires an ASYNC
 * read-back of a ticket's `updated` field right after syncLabels's `onWrite`
 * (i.e. right after a label write), and records whatever `updated` value it
 * reads under writer "daemon" — which then suppresses the notify ping for
 * EVERY watcher of that ticket, including its own agent. If a stall-wake
 * comment posts on the SAME poll as the `agent:stalled` label write, and
 * lands before that read-back resolves, the read-back's `updated` value
 * already reflects the comment — so the very wake this feature exists to
 * deliver gets folded into the "daemon already knows about this" record and
 * silently swallowed.
 *
 * WHAT WOULD MEAN THE HAZARD IS NOT REAL (stated before either scenario
 * runs, per this ticket's own instruction): if `shouldSuppress` returned
 * `false` for the comment's own bumped `updated` value in BOTH scenarios —
 * i.e. if the ledger's discriminator (exact-match on `expectedUpdated`)
 * could never actually coincide with a comment's bump regardless of
 * ordering. It can, and scenario B below reproduces exactly that
 * coincidence — so the hazard IS real for a design that posts on the same
 * poll as the write. Scenario A then demonstrates that gating on `applied`
 * (this module's actual, shipped design) never lets that coincidence arise
 * in the first place, because the two writes are never in the same
 * read-back's window.
 */

const iss = (key: string, status: string, labels: string[]): JiraIssue =>
  ({ key, status, summary: "s", issuetype: "Task", assignee: "a", parent: null, updated: "t", labels });

/** A minimal fake Jira ticket: `updated` is a monotonic, lexicographically-sortable counter (own-writes.ts's own discriminator relies on that ordering, exactly as real ISO-8601 timestamps do). */
function fakeTicket() {
  let seq = 0;
  let updated = "u0000";
  const bump = () => { seq++; updated = `u${String(seq).padStart(4, "0")}`; return updated; };
  return {
    get updated() { return updated; },
    bump,
  };
}

describe("the own-write ledger hazard (BUTCHR-221/BUTCHR-210)", () => {
  test("SCENARIO B (the hazard, reproduced): a same-poll comment lands before the label-write's read-back resolves -> the wake is swallowed", () => {
    const ledger = createOwnWriteLedger();
    const ticket = fakeTicket();

    // Poll N: the label write happens...
    const afterLabelWrite = ticket.bump(); // U1
    // ...and BEFORE the async read-back for that write resolves, a naive
    // same-poll remediation posts its wake comment...
    const afterComment = ticket.bump(); // U2 — already reflects the comment
    // ...and ONLY THEN does the read-back actually run (the race: it lost).
    ledger.record("KAN-1", ticket.updated, DAEMON_WRITER, 0); // records U2, contaminated by the comment

    // A later poll observes `updated` = U2 (nothing else has happened) and
    // asks whether to notify the ticket's own agent about it.
    expect(ledger.shouldSuppress("KAN-1", afterComment, "KAN-1", 1)).toBe(true); // SWALLOWED — this is the bug this ticket's own hazard section warns about
    expect(afterLabelWrite).not.toBe(afterComment); // sanity: two distinct writes really did happen
  });

  test("SCENARIO A (the shipped design): the read-back resolves BEFORE the wake comment is even attempted -> the wake is delivered", () => {
    const ledger = createOwnWriteLedger();
    const ticket = fakeTicket();

    // Poll N: the label write happens, and its read-back completes (this
    // module's actual guarantee: gating remediation on `applied` means at
    // least one full poll interval — vastly more than one HTTP round trip —
    // separates the write from anything this module does).
    ticket.bump(); // U1
    ledger.record("KAN-1", ticket.updated, DAEMON_WRITER, 0); // records U1, uncontaminated

    // Poll N+1 (a later, distinct poll): only NOW does the wake comment post.
    const afterComment = ticket.bump(); // U2 — strictly newer than the recorded U1

    expect(ledger.shouldSuppress("KAN-1", afterComment, "KAN-1", 100_000)).toBe(false); // DELIVERED — U2 matches no recorded entry
  });

  test("end-to-end through the real modules: syncLabels + createStallRemediator never produce a same-poll (write, comment) pair on one ticket", async () => {
    // This is the structural guarantee scenario A relies on, proven against
    // the real wiring rather than asserted: collect every Jira write
    // (updateLabels AND addComment) with the POLL NUMBER it happened on, and
    // show no ticket ever receives both inside the same poll.
    let poll = 0;
    const writesByPoll: Array<{ poll: number; kind: "label" | "comment" }> = [];
    const jira: LabelWriter = {
      async updateLabels() { writesByPoll.push({ poll, kind: "label" }); },
    };
    const commentStore: { id: string; body: string; created: string }[] = [];
    const rem = createStallRemediator({
      now: () => poll * 15_000,
      addComment: async (_issue, text) => {
        writesByPoll.push({ poll, kind: "comment" });
        commentStore.unshift({ id: `c${poll}`, body: text, created: new Date(poll * 15_000).toISOString() });
      },
      comments: async () => commentStore,
    });
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"]]),
      stalled: { check: async () => true, forget: () => {} },
      stallRemediation: rem,
    });

    // Poll 1: unconfirmed candidate.
    poll = 1;
    await sync([iss("KAN-1", "In Progress", ["agent:idle"])]);
    // Poll 2: confirmed — label WRITES this poll. `applied` going in was
    // still "idle", so remediation must not act this poll either.
    poll = 2;
    await sync([iss("KAN-1", "In Progress", ["agent:idle"])]);
    // Poll 3: `applied` now reads "stalled" — remediation acts THIS poll,
    // and (by construction) no label write happens this poll (no diff).
    poll = 3;
    await sync([iss("KAN-1", "In Progress", ["agent:stalled"])]);

    const labelPoll = writesByPoll.find((w) => w.kind === "label")?.poll;
    const commentPoll = writesByPoll.find((w) => w.kind === "comment")?.poll;
    expect(labelPoll).toBe(2);
    expect(commentPoll).toBe(3);
    expect(labelPoll).not.toBe(commentPoll); // never the same poll — the structural guarantee scenario A depends on
  });
});
