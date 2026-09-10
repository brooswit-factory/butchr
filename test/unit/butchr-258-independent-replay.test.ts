import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  advanceProjectWatermark,
  createProjectResourceType,
  projectVerdict,
  type ProjectEpic,
  type ProjectResource,
  type ProjectResourceDeps,
  type ProjectWatermark,
} from "../../src/resources/project.js";
import { atlassianTools } from "../../src/tools/defs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

/**
 * BUTCHR-258 — THE INDEPENDENT VERIFIER'S REPLAY, filed under BUTCHR-201
 * (which owns epic BUTCHR-195's item 5, "the 6-of-10 replay re-run against
 * the fixed code and reported"). Written by an identity that did not write
 * BUTCHR-227's fix — see this file's own PR description and BUTCHR-258's
 * Confluence doc for the full tier-boundary statement, falsifier, and
 * verdicts. This file is the "committed, runnable artefact" the ticket's
 * DoD requires; the doc is the narrative report.
 *
 * TIER BOUNDARY (repeated here because a test file is read independently of
 * the doc that explains it): this is an ISSUE-TIER caller. `get_doc_comments`
 * — the only verb that can take a LIVE Confluence measurement — refuses an
 * issue-tier caller. Every `(id, created)` pair used below is RELAYED, not
 * measured by this file's author, EXCEPT where a comment on the specific
 * fixture states it was found committed in this repository (grep the id
 * yourself before trusting the citation — this file does not assert its own
 * commit's line numbers stay put).
 *
 * FALSIFIERS ARE STATED PER-BLOCK, BEFORE the assertions, and are not edited
 * after being run — a re-derivation that reports its own conclusion is the
 * same shape as the bug this replay exists to catch.
 */

// ---------------------------------------------------------------------------
// THE OLD RULE, RECONSTRUCTED VERBATIM FROM GIT HISTORY, NOT FROM MEMORY.
//
// `newestCommentId` no longer exists in `src/` (BUTCHR-227 deleted it). This
// is not a paraphrase of what it did — it is the exact body, re-read at
// `git show 51f2e4e^:src/resources/project.ts` (the commit immediately
// BEFORE "BUTCHR-227: replace the project tier's max-id comment watermark
// with a seen-set" lands), reproduced here so the "run it both ways"
// requirement exercises the REAL pre-fix reduce, not a guess at its shape.
// Re-verify this yourself: `git log --oneline -- src/resources/project.ts`
// to find the BUTCHR-227 commit at your own checkout, then
// `git show <that-sha>^:src/resources/project.ts` and diff against this
// block — a divergence would mean this replay's "old rule" arm is not
// calibrated against the real defect.
//
//   export function newestCommentId(comments) {
//     if (!comments.length) return null;
//     return comments.reduce((max, c) => (Number(c.id) > Number(max) ? c.id : max), comments[0].id);
//   }
//
// The old `advanceProjectWatermark` OVERWROTE `wake.comment` with exactly
// this reduce's output over the FULL currently-observed comment set (not an
// incremental running value carried caller-to-caller) — also re-read at the
// same pre-BUTCHR-227 commit. The two composed mean: a project's stored
// scalar, after any check-in, equals the max id among every comment that
// existed on the page AT THAT MOMENT. A comment that is not itself the
// running max of everything-so-far never moves the scalar, and therefore
// never causes `observedCommentId !== wm.comment` to read true — it is
// absorbed into an unchanged watermark, silently, forever (durable in
// Confluence, never causing a wake).
function oldRuleReplay(commentsInCreationOrder: readonly { id: string }[], startingWatermark: string | null = null): { delivered: string[]; dropped: string[] } {
  const delivered: string[] = [];
  const dropped: string[] = [];
  let watermark = startingWatermark;
  for (const c of commentsInCreationOrder) {
    const newMax = watermark === null ? c.id : Number(c.id) > Number(watermark) ? c.id : watermark;
    if (newMax !== watermark) {
      delivered.push(c.id);
    } else {
      dropped.push(c.id);
    }
    watermark = newMax;
  }
  return { delivered, dropped };
}

// The SHIPPED rule's comment-axis membership check, re-derived from the
// actually-exported, actually-shipped `projectVerdict`/`unseenCommentIds`
// contract rather than a second reimplementation: every id in
// `commentsInCreationOrder` is "delivered" (never dropped) under the shipped
// design PROVIDED `check_in` is called after each one is observed — which is
// exactly what the LOOP-VS-BATCH test in project-resource-type.test.ts pins
// end-to-end. This helper exists only to produce the same
// `{delivered, dropped}` shape as `oldRuleReplay` for a side-by-side
// assertion; it does not reimplement set membership, it just accumulates a
// Set and reports "dropped" as "already a member" (mirroring the real
// `unseenIds` semantics: an id already in the seen set causes no wake, but —
// unlike the old rule — it was never SILENTLY LOST, it is durably recorded
// and its "not novel" status is exactly correct, not a defect).
function shippedRuleReplay(commentsInCreationOrder: readonly { id: string }[]): { delivered: string[]; dropped: string[] } {
  const seen = new Set<string>();
  const delivered: string[] = [];
  const dropped: string[] = [];
  for (const c of commentsInCreationOrder) {
    if (seen.has(c.id)) {
      dropped.push(c.id); // genuinely a repeat within this replay — not a defect
    } else {
      delivered.push(c.id);
      seen.add(c.id);
    }
  }
  return { delivered, dropped };
}

function project(overrides: Partial<ProjectResource> = {}): ProjectResource {
  const observedCommentIds = overrides.observedCommentIds ?? [];
  const observedEpics = overrides.observedEpics ?? [];
  const watermark: ProjectWatermark = overrides.watermark ?? { version: null, commentsSeen: [], epicsSeen: {} };
  return {
    key: "ACME",
    name: "Acme",
    eligible: true,
    rootDocId: "doc-A",
    observedVersion: watermark.version,
    observedEpics,
    unseenCommentIds: overrides.unseenCommentIds ?? observedCommentIds.filter((id) => !watermark.commentsSeen.includes(id)),
    unseenEpicCommentIds:
      overrides.unseenEpicCommentIds ??
      Object.fromEntries(observedEpics.map((e) => [e.key, e.commentIds.filter((id) => !(watermark.epicsSeen[e.key] ?? []).includes(id))])),
    observedCommentIds,
    watermark,
    ...overrides,
  };
}

interface FakeWorld {
  ops: AtlassianOps;
  deps: ProjectResourceDeps;
  properties: Map<string, Record<string, unknown>>;
}

function fakeWorld(opts: {
  properties: Record<string, Record<string, unknown> | undefined>;
  pageVersions?: Record<string, number>;
  pageComments?: Record<string, Array<{ id: string; body: string }>>;
  epicsInReview?: JiraIssue[];
  epicComments?: Record<string, Array<{ id: string }>>;
}): FakeWorld {
  const properties = new Map(Object.entries(opts.properties).filter(([, v]) => v !== undefined) as [string, Record<string, unknown>][]);
  const unimplemented = (name: string) => async (..._a: unknown[]) => {
    throw new Error(`fake ops: ${name} not used by this test`);
  };
  const ops: AtlassianOps = {
    getIssue: unimplemented("getIssue"),
    search: unimplemented("search"),
    addComment: unimplemented("addComment"),
    linkIssues: unimplemented("linkIssues"),
    transition: unimplemented("transition"),
    createIssue: unimplemented("createIssue"),
    setPriority: unimplemented("setPriority"),
    assign: unimplemented("assign"),
    createPage: unimplemented("createPage"),
    getPage: unimplemented("getPage"),
    updatePage: unimplemented("updatePage"),
    searchPages: unimplemented("searchPages"),
    listSpaces: unimplemented("listSpaces"),
    getRemoteLink: unimplemented("getRemoteLink"),
    upsertRemoteLink: unimplemented("upsertRemoteLink"),
    getChildPages: unimplemented("getChildPages"),
    getPageLabels: unimplemented("getPageLabels"),
    createPageWithLabel: unimplemented("createPageWithLabel"),
    addLabels: unimplemented("addLabels"),
    removeLabels: unimplemented("removeLabels"),
    deleteIssue: unimplemented("deleteIssue"),
    correctText: unimplemented("correctText"),
    commentOnPage: unimplemented("commentOnPage"),
    getMyself: async () => ({ accountId: "acct-A" }),
    searchProjects: async () => ({ values: [{ key: "ACME", name: "Acme", lead: { accountId: "acct-A" } }] }),
    getProjectProperty: async (key: string) => {
      const p = properties.get(key);
      if (!p) throw new Error(`fake: 404, no "butchr" property for ${key}`);
      return p;
    },
    getProjectPropertyOrNull: async (key: string) => properties.get(key) ?? null,
    setProjectProperty: async (key: string, _propertyKey: string, value: unknown) => {
      properties.set(key, value as Record<string, unknown>);
      return { ok: true };
    },
    getPageVersions: async (ids: readonly string[]) => {
      const out: Record<string, number> = {};
      for (const id of ids) if (opts.pageVersions?.[id] !== undefined) out[id] = opts.pageVersions[id]!;
      return out;
    },
    getPageComments: async (pageId: string) => ({ results: opts.pageComments?.[pageId] ?? [] }),
    getIssueComments: async (key: string) => ({ results: opts.epicComments?.[key] ?? [] }),
  };
  const deps: ProjectResourceDeps = {
    ops,
    search: async () => opts.epicsInReview ?? [],
    allowlist: new Set(["ACME"]),
  };
  return { ops, deps, properties };
}

const PROPERTY_A = { space: { key: "ACME" }, rootDoc: { id: "doc-A" } };

// ===========================================================================
// SECTION 1 — THE PRIMARY REPLAY: "6 of 10", run both ways, with the
// denominator stated honestly.
// ===========================================================================
//
// RELAYED (BUTCHR-201's ticket, itself relaying BUTCHR-195): six ids, in
// creation order, that a max-id watermark is claimed to drop, plus a seventh
// id (17334326, created 14:41:42, the "worst single inversion" pivot) that
// the same ticket text names as sitting ABOVE the sixth (17039446, created
// 14:58:54) — i.e. the comment that becomes the running max partway through
// this window. NONE of these seven ids, or their timestamps, were measured
// by this file's author; `get_doc_comments` is project-caller-only and this
// is an issue-tier caller (see this file's top comment and BUTCHR-258's doc).
//
// ⚠ THE DENOMINATOR: the ticket is explicit that "the four NOT-dropped ids
// of the ten are not relayed in any ticket [it] can read" and instructs
// "do NOT invent them, and do NOT quietly report '6 of 10' off a fixture
// that does not contain ten comments." This fixture contains exactly SEVEN
// named ids (the six claimed-dropped, plus the one pivot) — not ten. Every
// assertion below is scoped to those seven, explicitly, never phrased as
// "10".
const SIX_OF_TEN = [
  { id: "16842773", created: "2026-09-02T14:26:39.143Z", note: "assistant: THE DIRECTOR withdrawal" },
  { id: "16711726", created: "2026-09-02T14:26:39.557Z", note: "assistant: PEER MESSAGING directive (became BUTCHR-183)" },
  { id: "16810008", created: "2026-09-02T14:28:52.202Z", note: "project's own reply" },
  { id: "16678958", created: "2026-09-02T14:39:14.127Z", note: "assistant: REMOVE BUTCHR_PROJECT_ALLOWLIST directive" },
  { id: "16973835", created: "2026-09-02T14:50:04.647Z", note: "project's own reply" },
  { id: "17039446", created: "2026-09-02T14:58:54.553Z", note: "assistant: deploy landed, 403 class closed fleet-wide" },
] as const;
const PIVOT = { id: "17334326", created: "2026-09-02T14:41:42Z", note: "the 'worst single inversion' pivot named in the ticket text" };

describe("SECTION 1 — the 6-of-10 replay (7 of the relayed 10 ids; the other 3 are not relayed, and are not invented here)", () => {
  const sevenKnownIds = [...SIX_OF_TEN.slice(0, 4), PIVOT, ...SIX_OF_TEN.slice(4)]; // creation order

  // FALSIFIER, stated before running: if the old-rule replay does NOT drop
  // at least the 5 of 6 that follow the pivot's own high-water mark
  // (16711726, 16810008, 16678958 — all below the running max 16842773 —
  // and 16973835, 17039446 — both below the running max 17334326), this
  // replay's "old rule" arm is miscalibrated and the defect is in this file,
  // not in the epic (per the ticket's own instrument-calibration
  // instruction). This is INDEPENDENT of any assumption about a
  // pre-existing watermark.
  test("OLD RULE, no assumed prior watermark: 5 of the 6 relayed ids drop, the pivot delivers — the sixth (the window's own first comment) requires a prior watermark this file does not assume", () => {
    const { delivered, dropped } = oldRuleReplay(sevenKnownIds);
    expect(dropped).toEqual(["16711726", "16810008", "16678958", "16973835", "17039446"]);
    expect(delivered).toEqual(["16842773", "17334326"]); // the window's first comment starts the max fresh, so it delivers here
  });

  // FALSIFIER: this block's own premise is stated in its name and is an
  // ASSUMPTION, not a measurement — the ticket does not relay what the
  // watermark was immediately before this window opened. It is plausible
  // (this same root doc's comment history is independently documented, in
  // this repo's docs/wake-watermark-and-project-sleep.md and in the
  // ticket's own "ratchet" claim, as already carrying ids as high as
  // 18153493 well before this window), but plausibility is not measurement.
  // Failure condition: if picking ANY value in the stated range failed to
  // reproduce exactly the 6 relayed drops, the ticket's own claim about
  // this specific six would be miscalibrated against the pivot mechanism it
  // also names — worth reporting, not papering over.
  test("OLD RULE, UNDER THE STATED ASSUMPTION of a prior watermark in [16842773, 17334326) established before this window opened: all 6 relayed ids drop, exactly as the ticket claims", () => {
    const { delivered, dropped } = oldRuleReplay(sevenKnownIds, "16900000" /* ASSUMPTION — see this test's own name */);
    expect(dropped).toEqual(["16842773", "16711726", "16810008", "16678958", "16973835", "17039446"]);
    expect(delivered).toEqual(["17334326"]);
  });

  // THE SHIPPED RULE, on the identical fixture, no assumption needed at
  // all — this is the point: set membership does not care what happened
  // before the window opened. Failure condition: any of the 7 reads as
  // dropped.
  test("SHIPPED RULE: the same 7 ids all surface — no starting-watermark assumption required, unlike the old rule", () => {
    const { delivered, dropped } = shippedRuleReplay(sevenKnownIds);
    expect(dropped).toEqual([]);
    expect(delivered).toHaveLength(7);
  });

  // Cross-checked end-to-end through the REAL shipped code (not the
  // `shippedRuleReplay` helper above), via discovery + advanceProjectWatermark,
  // exactly the loop-vs-batch shape: one discover -> one check_in-shaped
  // advance -> one more discover, and the whole window must be caught up.
  test("SHIPPED RULE, end-to-end through the real code: one check_in-shaped advance catches up the whole 7-id window in one cycle", async () => {
    const w = fakeWorld({ properties: { ACME: PROPERTY_A }, pageVersions: { "doc-A": 1 }, pageComments: { "doc-A": sevenKnownIds.map((c) => ({ id: c.id, body: "" })) } });
    const [before] = await createProjectResourceType(w.deps).discovery.search();
    expect(before!.unseenCommentIds).toHaveLength(7);
    expect(projectVerdict(before!)).toBe("active");
    await advanceProjectWatermark(w.ops, "ACME", { version: before!.observedVersion!, seenComments: before!.observedCommentIds });
    const [after] = await createProjectResourceType(w.deps).discovery.search();
    expect(after!.unseenCommentIds).toEqual([]);
    expect(projectVerdict(after!)).toBe("asleep");
  });
});

// ===========================================================================
// SECTION 1b — two ticket-named DoD items that Section 1's aggregate
// assertions cover only implicitly: "the 414ms pair, by name" and "the
// largest inversion, by name" (ticket's ALSO CHECK items 2 and 3). Each gets
// its own falsifier and its own assertion here so neither is inferred from a
// passing aggregate check.
// ===========================================================================

describe("SECTION 1b — the 414ms pair, by name: 16842773 (14:26:39.143) and 16711726 (14:26:39.557), 414ms apart", () => {
  // RELAYED, same provenance as Section 1's SIX_OF_TEN (BUTCHR-201's ticket
  // text). FALSIFIER: a coarse tie-break that collapses timestamps this
  // close together would either (a) make the OLD rule's max-id reduce treat
  // them as simultaneous and pick one arbitrarily, or (b) make the SHIPPED
  // rule fail to keep them as two distinct set members. This block checks
  // (b) directly — the ids themselves are already 414ms/one-integer-tick
  // apart at the STRING level, so a collapse could only happen if something
  // on the observe/classify/write path normalized or deduplicated them
  // beyond plain set membership; failing condition is either id missing from
  // `delivered`, or `delivered.length` not being 2.
  const pair = [
    { id: "16842773", created: "2026-09-02T14:26:39.143Z" },
    { id: "16711726", created: "2026-09-02T14:26:39.557Z" },
  ];

  test("SHIPPED RULE: both surface, distinctly (not collapsed to one)", () => {
    const { delivered, dropped } = shippedRuleReplay(pair);
    expect(delivered).toEqual(["16842773", "16711726"]);
    expect(new Set(delivered).size).toBe(2); // distinct, not coalesced
    expect(dropped).toEqual([]);
  });

  test("SHIPPED RULE, end-to-end through the real code: both ids land in the same stored seen-set after one check_in-shaped advance", async () => {
    const w = fakeWorld({ properties: { ACME: PROPERTY_A }, pageVersions: { "doc-A": 1 }, pageComments: { "doc-A": pair.map((c) => ({ id: c.id, body: "" })) } });
    const [before] = await createProjectResourceType(w.deps).discovery.search();
    expect(before!.unseenCommentIds).toEqual(["16842773", "16711726"]);
    await advanceProjectWatermark(w.ops, "ACME", { seenComments: before!.observedCommentIds });
    const stored = w.properties.get("ACME")!.wake as { commentsSeen: string[] };
    expect(new Set(stored.commentsSeen)).toEqual(new Set(["16842773", "16711726"]));
  });

  // OLD RULE, for contrast only (not itself a DoD requirement for this
  // pair, but establishes what "coarse tie-break" would have meant under
  // the mechanism being replaced): a max-id reduce over just these two,
  // with no prior watermark, treats the higher id as delivered and the
  // lower as dropped — it never "collapses" them, it silently drops one.
  test("OLD RULE, for contrast: the lower id (16711726) is silently dropped, not merely delayed", () => {
    const { delivered, dropped } = oldRuleReplay(pair);
    expect(delivered).toEqual(["16842773"]);
    expect(dropped).toEqual(["16711726"]);
  });
});

describe("SECTION 1b — the largest inversion, by name: id ...818965-apart, watermark 18153493 (created ~19:51) already seen, new comment 17334528 created LATER at 20:21:09.175Z with a LOWER id", () => {
  // RELAYED (BUTCHR-201's ticket text, "ALSO CHECK" item 3): "818,965: a
  // comment created 20:21:09.175Z drew 17334528; one created thirty minutes
  // earlier drew 18153493. It sat below the watermark, no wake was
  // generated, and it was read only because a restart respawned the reader
  // 1.5s later." 18153493 is also independently named elsewhere in this same
  // ticket as "the page's all-time max" watermark value — this fixture seeds
  // it as the ALREADY-SEEN watermark and observes 17334528 arriving after.
  //
  // FALSIFIER, stated before running: under the OLD rule, a fresh max-id
  // reduce over {18153493 (already max), 17334528 (new, lower)} must NOT
  // produce a new max — if it did, this fixture would not reproduce the
  // "sat below the watermark, no wake generated" claim and this replay's
  // calibration would be wrong, not the epic. Under the SHIPPED rule,
  // 17334528 must surface as unseen despite being numerically lower than
  // the already-seen 18153493 — magnitude must play no role.
  test("OLD RULE: 17334528 (lower id, created LATER) never becomes the new max against an established 18153493 watermark — the inversion this replay is named for", () => {
    const watermark = "18153493";
    const newMax = Number("17334528") > Number(watermark) ? "17334528" : watermark;
    expect(newMax).toBe(watermark); // unchanged — 17334528 silently absorbed, no wake
    expect(newMax).not.toBe("17334528");
  });

  test("SHIPPED RULE: 17334528 surfaces as unseen even though 18153493 (numerically higher) is already in the seen set", () => {
    const p = project({
      observedCommentIds: ["18153493", "17334528"],
      watermark: { version: null, commentsSeen: ["18153493"], epicsSeen: {} },
    });
    expect(p.unseenCommentIds).toEqual(["17334528"]); // membership, not magnitude — 818,965 below the already-seen id and still surfaces
    expect(projectVerdict(p)).toBe("active");
  });

  test("SHIPPED RULE, end-to-end: one check_in-shaped advance records 17334528 alongside the already-seen 18153493 and the project goes back to asleep", async () => {
    const w = fakeWorld({
      properties: { ACME: { ...PROPERTY_A, wake: { version: 1, commentsSeen: ["18153493"], epicsSeen: {} } } },
      pageVersions: { "doc-A": 1 },
      pageComments: { "doc-A": [{ id: "18153493", body: "" }, { id: "17334528", body: "" }] },
    });
    const [before] = await createProjectResourceType(w.deps).discovery.search();
    expect(before!.unseenCommentIds).toEqual(["17334528"]);
    expect(projectVerdict(before!)).toBe("active");
    await advanceProjectWatermark(w.ops, "ACME", { seenComments: before!.observedCommentIds });
    const [after] = await createProjectResourceType(w.deps).discovery.search();
    expect(after!.unseenCommentIds).toEqual([]);
    expect(projectVerdict(after!)).toBe("asleep");
  });
});

// ===========================================================================
// SECTION 2 — the 13-pairwise-violations cross-check, attempted, on the same
// partial (7-of-10) denominator as Section 1.
// ===========================================================================
//
// RELAYED: BUTCHR-119 reported 13 pairwise ordering violations over the
// original TEN comments. This file has 7 of those 10 (see Section 1's own
// denominator note) — a strict subset can only ever find LESS THAN OR EQUAL
// TO the true count, never more, so this is a LOWER-BOUND attempt, not a
// reproduction. FALSIFIER: if this count came back as 0, that would say the
// 7 known ids carry no inversions at all, which would contradict the "worst
// single inversion" and "6 dropped" claims already relayed about this same
// window — a result worth flagging as instrument failure, not a clean pass.
function countPairwiseInversions(commentsInCreationOrder: readonly { id: string }[]): number {
  let count = 0;
  for (let i = 0; i < commentsInCreationOrder.length; i++) {
    for (let j = i + 1; j < commentsInCreationOrder.length; j++) {
      if (Number(commentsInCreationOrder[i]!.id) > Number(commentsInCreationOrder[j]!.id)) count++;
    }
  }
  return count;
}

describe("SECTION 2 — the 13-violations cross-check, attempted on a partial (7-of-10) denominator", () => {
  test("7 pairwise inversions found among the 7 KNOWN ids — a lower bound, consistent with (not equal to, and not contradicting) the relayed 13-over-10", () => {
    const sevenKnownIds = [...SIX_OF_TEN.slice(0, 4), PIVOT, ...SIX_OF_TEN.slice(4)];
    const n = countPairwiseInversions(sevenKnownIds);
    expect(n).toBe(7);
    expect(n).toBeLessThanOrEqual(13); // a subset of 7-of-10 cannot exceed the full-10 count
    expect(n).toBeGreaterThan(0); // instrument-calibration floor — see this block's own falsifier
  });
});

// ===========================================================================
// SECTION 3 — Page 2 (CATA) and Page 3 (CNDLX), the independent-reproduction
// specimens named in the ticket.
// ===========================================================================

describe("SECTION 3 — Page 2 (CATA): independently-cited pair, id 17334328 (14:58:06.003Z) / 17104948 (24s later, 14:58:30.387Z, lower by 229,380)", () => {
  // PROVENANCE: found committed in THIS repo, not merely relayed — grep
  // "17334328" at your own checkout: changelog.d/BUTCHR-198.md states this
  // exact pair with these exact timestamps and the 229,380 delta. Re-verify
  // before trusting this citation; this file does not assert its own commit
  // stays put.
  const cataPair = [
    { id: "17334328", created: "2026-09-02T14:58:06.003Z" },
    { id: "17104948", created: "2026-09-02T14:58:30.387Z" },
  ];

  test("OLD RULE drops the second (lower, later) comment", () => {
    const { delivered, dropped } = oldRuleReplay(cataPair);
    expect(delivered).toEqual(["17334328"]);
    expect(dropped).toEqual(["17104948"]);
  });

  test("SHIPPED RULE surfaces both, distinctly", () => {
    const { delivered, dropped } = shippedRuleReplay(cataPair);
    expect(delivered).toEqual(["17334328", "17104948"]);
    expect(dropped).toEqual([]);
  });
});

describe("SECTION 3 — Page 3 (CNDLX): THIRD-HAND relay (project agent, relaying the assistant) — NOT independently verified at this file's own commit, labeled as such per the ticket's instruction", () => {
  // PROVENANCE: relayed by BUTCHR-201's ticket text, itself relaying the
  // project agent, itself relaying the assistant. Not found by this file's
  // author in any committed doc or test fixture in this repo (grepped;
  // no hit). Treated here as an UNVERIFIED input used only to check the
  // MECHANISM's behavior on the claimed shape, never as a settled
  // measurement. If it is wrong, only this file's mechanical conclusion
  // ("the code handles this shape correctly IF the shape is real") survives
  // — not a claim that the CNDLX incident itself is confirmed.
  const cndlx = [
    { id: "20742145", created: "2026-09-03T00:15:19Z" },
    { id: "20316188", created: "2026-09-03T00:19:19Z" },
    { id: "20807681", created: "2026-09-03T00:26:31Z" },
    { id: "20545563", created: "2026-09-03T00:42:33Z" }, // later, LOWER — the named victim in the ticket's telling
  ];

  test("OLD RULE: the daemon's own [butchr:frozen] comment (20807681) becomes the watermark; the later, lower-id direction (20545563) never becomes new max, so it never distinctly wakes anything", () => {
    const { delivered, dropped } = oldRuleReplay(cndlx);
    expect(delivered).toEqual(["20742145", "20807681"]); // each a fresh running max in turn
    expect(dropped).toEqual(["20316188", "20545563"]);
    expect(dropped).toContain("20545563"); // the specific named victim
  });

  test("SHIPPED RULE: all four surface, including the named victim", () => {
    const { delivered } = shippedRuleReplay(cndlx);
    expect(delivered).toContain("20545563");
    expect(delivered).toHaveLength(4);
  });
});

// ===========================================================================
// SECTION 4 — the three stored-value shapes, each exercised against BOTH
// rules (the old rule's failure mode differs by shape: shape 1/2 DROP, shape
// 3 PINS PERMANENTLY ACTIVE — the "over-delivery" half of the same defect).
// ===========================================================================

describe("SECTION 4 — the three stored-value shapes", () => {
  // SHAPE 1 (ceiling-pinned) and SHAPE 2 (regressed) are already exercised
  // end-to-end, against the REAL migration adapter, in
  // project-resource-type.test.ts's "the migration adapter" describe block
  // (CASE 1 / the regressed-scalar test) — not duplicated here. This file
  // adds only what that file's shape-3 case does not: an explicit
  // OLD-RULE-NEVER-CLEARS demonstration, because CASE 3 there only shows the
  // shipped rule's `unseenCommentIds`, not the old rule's non-convergence.

  // SHAPE 3 — DROVR (relayed via BUTCHR-199's doc, "measured on DROVR
  // (control re-run, not inherited)" — one hop from this file's author, not
  // found committed in this repo; not independently verified here).
  // Watermark `17072447` is claimed genuinely newest BY CREATION TIME, but
  // the page's max-id reduce returns `18153592` (higher id, 43 minutes
  // OLDER) — a value the stored scalar can never equal, because the scalar
  // itself was never that id to begin with.
  //
  // FALSIFIER: under the OLD rule, if this ever reads "asleep" at any poll,
  // the "permanently active" claim is false — the max reduce would have to
  // equal the stored scalar, which by construction (18153592 !== 17072447,
  // and the max reduce over a page that already contains 18153592 can never
  // drop below it once observed) it cannot.
  test("OLD RULE: a stored scalar (17072447) that is genuinely newest by TIME but never the page's max-by-ID (18153592) reads ACTIVE forever — it can never clear", () => {
    const pageComments = [{ id: "18153592" }, { id: "17072447" }]; // order doesn't matter to a max reduce
    const wm = { comment: "17072447" };
    const observedMax = pageComments.reduce((max, c) => (Number(c.id) > Number(max) ? c.id : max), pageComments[0]!.id);
    expect(observedMax).toBe("18153592");
    expect(observedMax).not.toBe(wm.comment); // ACTIVE — and every future poll re-observes the same 18153592, so this NEVER changes
    // Re-run the same comparison 3 more times ("polls") to make "never
    // clears" concrete rather than asserted once:
    for (let i = 0; i < 3; i++) {
      const stillMax = pageComments.reduce((max, c) => (Number(c.id) > Number(max) ? c.id : max), pageComments[0]!.id);
      expect(stillMax).not.toBe(wm.comment);
    }
  });

  test("SHIPPED RULE: the same shape converges to asleep after exactly one check_in-shaped advance", async () => {
    const w = fakeWorld({
      properties: { ACME: { ...PROPERTY_A, wake: { version: 5, comment: "17072447", epics: {} } } }, // legacy scalar, migrated at read time
      pageVersions: { "doc-A": 5 },
      pageComments: { "doc-A": [{ id: "18153592", body: "" }, { id: "17072447", body: "" }] },
    });
    const [before] = await createProjectResourceType(w.deps).discovery.search();
    expect(before!.watermark.commentsSeen).toEqual(["17072447"]); // seeded truthfully, not as a threshold
    expect(before!.unseenCommentIds).toEqual(["18153592"]);
    expect(projectVerdict(before!)).toBe("active");
    await advanceProjectWatermark(w.ops, "ACME", { seenComments: before!.observedCommentIds });
    const [after] = await createProjectResourceType(w.deps).discovery.search();
    expect(after!.unseenCommentIds).toEqual([]);
    expect(projectVerdict(after!)).toBe("asleep"); // converges — the old rule's specific failure mode (never clears) cannot recur
  });
});

// ===========================================================================
// SECTION 5 — ⚠ THE DELETION CASE (the epic's late addition, treated with
// the same weight as the primary check). NOBODY HAS TESTED THIS. It is
// constructed here, not assumed.
// ===========================================================================
//
// FALSIFIER, stated before running, verbatim from the epic's own wording: if
// a deleted comment can make the shipped code read ACTIVE, that is a MAJOR
// FINDING and the epic reopens the fix. The mirror claim: under the shipped
// seen-set, deletion of the CURRENT page-max comment (the exact shape that
// produced BUTCHR-208's permanent spawn loop under the OLD absolute
// no-lowering guard) must be a NON-EVENT — verdict stays/returns "asleep",
// and no writer is ever asked to remove anything (there is no "remove" verb
// on this path at all; see project.ts's own doc comment: union can only
// grow the stored set, by construction).
describe("SECTION 5 — THE DELETION CASE, root-doc comment axis: a deleted comment is a non-event under the shipped seen-set", () => {
  test("baseline: comment id 500 is the page's current max and is already seen -> asleep", () => {
    const p = project({
      observedCommentIds: ["500"],
      watermark: { version: null, commentsSeen: ["500"], epicsSeen: {} },
    });
    expect(projectVerdict(p)).toBe("asleep");
  });

  // THE CASE ITSELF: id 500 is DELETED from the page (it no longer appears
  // in `observedCommentIds` at all — this is what "deleted" means from this
  // module's own vantage point, since it never reads Confluence's trash).
  // Under BUTCHR-208's OLD absolute "no writer may lower the watermark"
  // guard, this produced a PERMANENT SPAWN LOOP (the epic's own worked
  // example: observed max legitimately drops to some lower value like 100,
  // the guard refuses to write 100 over the stored 500, so the project reads
  // active forever and the write meant to reconcile it is the very write the
  // guard blocks). Failure condition for THIS test: `projectVerdict`
  // returning "active" here.
  test("id 500 is DELETED (absent from this poll's observation entirely) -> the verdict stays asleep, not active — this is the reopen trigger if it fails", () => {
    const p = project({
      observedCommentIds: [], // 500 no longer exists to be observed
      watermark: { version: null, commentsSeen: ["500"], epicsSeen: {} },
    });
    expect(p.unseenCommentIds).toEqual([]);
    expect(projectVerdict(p)).toBe("asleep"); // MAJOR FINDING if this is ever "active" — see this describe block's own falsifier
  });

  // THE RECONCILE-WRITE HALF: even after observing the deletion, a
  // check_in-shaped advance must NOT need — and must not attempt — to
  // remove "500" from storage. There is no removal code path to call; this
  // test proves that a check_in-shaped write (passing only what THIS poll
  // observed, i.e. nothing) leaves the deleted id's prior seen-record
  // intact rather than erroring or needing a special "reconcile" branch —
  // the exact recovery path BUTCHR-208's old guard could not clear.
  test("a check_in-shaped advance after the deletion succeeds with no special handling, and does not (cannot) remove the deleted id from storage", async () => {
    const w = fakeWorld({
      properties: { ACME: { ...PROPERTY_A, wake: { version: 5, commentsSeen: ["500"], epicsSeen: {} } } },
      pageVersions: { "doc-A": 5 },
      pageComments: { "doc-A": [] }, // 500 deleted; nothing else on the page
    });
    const [before] = await createProjectResourceType(w.deps).discovery.search();
    expect(projectVerdict(before!)).toBe("asleep");
    await advanceProjectWatermark(w.ops, "ACME", { seenComments: before!.observedCommentIds }); // empty array — exactly what check_in would pass
    const stored = w.properties.get("ACME")!.wake as { commentsSeen: string[] };
    expect(stored.commentsSeen).toEqual(["500"]); // still there — union cannot remove, and nothing asked it to
  });
});

describe("SECTION 5 — THE DELETION CASE, epics-in-review axis: the mirror case for a deleted/removed epic comment", () => {
  test("an epic's top comment (id 50) is deleted -> asleep, not active, for that epic", () => {
    const p = project({
      observedEpics: [{ key: "ACME-1", commentIds: [] }], // id 50 no longer observed
      watermark: { version: null, commentsSeen: [], epicsSeen: { "ACME-1": ["50"] } },
    });
    expect(projectVerdict(p)).toBe("asleep");
  });
});

// ===========================================================================
// SECTION 6 — THE PRIMARY CHECK, CONSTRUCTED: an observed-but-NOT-waking id
// (already seen) is still RE-RECORDED alongside a genuinely new one in the
// SAME check_in-shaped write — "seen" and "woke" are different facts, and
// the write must record on "seen". Both changed axes.
// ===========================================================================
describe("SECTION 6 — THE PRIMARY CHECK: seen and woke are different facts, on BOTH changed axes", () => {
  // FALSIFIER: if, after this single check_in-shaped write, the
  // ALREADY-SEEN id (which caused no wake — it was not in `unseenCommentIds`)
  // is absent from the newly-stored set, that would mean the write recorded
  // only the WOKEN subset, not the full OBSERVED set — the loop-vs-batch
  // defect wearing a different fixture's clothes.
  test("root-doc axis: a mixed poll (one already-seen id that wakes nothing, one genuinely new id that does) re-records BOTH", async () => {
    const w = fakeWorld({
      properties: { ACME: { ...PROPERTY_A, wake: { version: 5, commentsSeen: ["100"], epicsSeen: {} } } },
      pageVersions: { "doc-A": 5 },
      pageComments: { "doc-A": [{ id: "100", body: "" }, { id: "200", body: "" }] }, // 100 already seen, 200 new
    });
    const [before] = await createProjectResourceType(w.deps).discovery.search();
    expect(before!.unseenCommentIds).toEqual(["200"]); // 100 causes no wake — it is already seen
    expect(projectVerdict(before!)).toBe("active"); // because of 200, not 100

    // The check_in-shaped write always passes the FULL observed set — see
    // src/tools/defs.ts's check_in handler, `seenComments = comments.results.map(c => c.id)`,
    // never `unseenCommentIds` — this call mirrors that exactly.
    await advanceProjectWatermark(w.ops, "ACME", { seenComments: before!.observedCommentIds });
    const stored = w.properties.get("ACME")!.wake as { commentsSeen: string[] };
    expect(new Set(stored.commentsSeen)).toEqual(new Set(["100", "200"])); // BOTH present — 100 was re-recorded despite waking nothing
  });

  test("epics axis: the same mixed-poll re-recording, for an in-review epic's comment set", async () => {
    const w = fakeWorld({
      properties: { ACME: { ...PROPERTY_A, wake: { version: 5, commentsSeen: [], epicsSeen: { "ACME-1": ["50"] } } } },
      pageVersions: { "doc-A": 5 },
      pageComments: { "doc-A": [] },
      epicsInReview: [{ key: "ACME-1", summary: "e", status: "In Review", issuetype: "Epic", assignee: null, parent: null, updated: "", labels: [] }],
      epicComments: { "ACME-1": [{ id: "50" }, { id: "51" }] }, // 50 already seen (wakes nothing), 51 new
    });
    const [before] = await createProjectResourceType(w.deps).discovery.search();
    expect(before!.unseenEpicCommentIds["ACME-1"]).toEqual(["51"]);
    expect(projectVerdict(before!)).toBe("active");

    await advanceProjectWatermark(w.ops, "ACME", { epics: { "ACME-1": before!.observedEpics[0]!.commentIds } });
    const stored = w.properties.get("ACME")!.wake as { epicsSeen: Record<string, string[]> };
    expect(new Set(stored.epicsSeen["ACME-1"])).toEqual(new Set(["50", "51"])); // 50 re-recorded despite waking nothing
  });
});

// ===========================================================================
// SECTION 6b — THE check_in SEAM, closed: Section 6 above drives
// `advanceProjectWatermark` with a HAND-CONSTRUCTED `seenComments` array —
// exactly the value the primary check's own falsifier doubts ("if `check_in`
// records anything less than every observed id..."). A fixture whose
// starting state equals the state under test can never detect a wrong
// write (BUTCHR-156's rule) — so Section 6 alone cannot tell you whether the
// REAL `check_in` MCP handler (src/tools/defs.ts) actually passes the full
// observed set, only that `advanceProjectWatermark` unions whatever it is
// given. This section drives `tools.check_in!.handler` itself, the same
// construction the sibling suite (test/unit/tools.test.ts's own
// `checkInRig`) already uses — verify that pattern at your own checkout
// before trusting this one.
//
// THIS TEST IS GENUINELY PRE-REGISTERED BY THIS FILE'S CURRENT AUTHOR, not
// inherited: written and run for the first time this session, falsifier
// stated below BEFORE it was run, unedited since.
// ===========================================================================
describe("SECTION 6b — THE check_in SEAM: the REAL handler (src/tools/defs.ts), not a stand-in for it", () => {
  // FALSIFIER, stated before running: if `seenComments` handed to storage
  // after this call is anything other than the FULL observed set (both the
  // already-seen id that wakes nothing, and the new one that does), that
  // means `check_in`'s own handler — not `advanceProjectWatermark`, which
  // Section 6 already covers — is the one that drops something. This is the
  // one seam a mutation on `src/tools/defs.ts` itself (e.g. slicing
  // `seenComments` to one id) can be caught at; Section 6 cannot reach this
  // seam by construction, since it never calls this handler.
  test("real check_in handler: a mixed poll (one already-seen id, one new id) writes the FULL observed set, not the waking subset", async () => {
    const properties = new Map<string, unknown>([["ACME", { space: { key: "ACME" }, rootDoc: { id: "doc-A" }, wake: { version: 1, commentsSeen: ["100"], epicsSeen: {} } }]]);
    const unimplemented = (name: string) => async (..._a: unknown[]) => {
      throw new Error(`fake ops: ${name} not used by this test`);
    };
    const ops: AtlassianOps = {
      getIssue: unimplemented("getIssue"),
      search: async () => ({ issues: [] }), // no epics in review — this test's own scope is the comment axis
      addComment: unimplemented("addComment"),
      linkIssues: unimplemented("linkIssues"),
      transition: unimplemented("transition"),
      createIssue: unimplemented("createIssue"),
      setPriority: unimplemented("setPriority"),
      assign: unimplemented("assign"),
      createPage: unimplemented("createPage"),
      getPage: async () => ({ title: "Acme root doc", body: { storage: { value: "" } }, _links: { base: "", webui: "" } }),
      updatePage: unimplemented("updatePage"),
      searchPages: unimplemented("searchPages"),
      listSpaces: unimplemented("listSpaces"),
      getRemoteLink: unimplemented("getRemoteLink"),
      upsertRemoteLink: unimplemented("upsertRemoteLink"),
      getChildPages: unimplemented("getChildPages"),
      getPageLabels: unimplemented("getPageLabels"),
      createPageWithLabel: unimplemented("createPageWithLabel"),
      addLabels: unimplemented("addLabels"),
      removeLabels: unimplemented("removeLabels"),
      deleteIssue: unimplemented("deleteIssue"),
      correctText: unimplemented("correctText"),
      commentOnPage: unimplemented("commentOnPage"),
      getMyself: async () => ({ accountId: "acct-A" }),
      searchProjects: async () => ({ values: [{ key: "ACME", name: "Acme", lead: { accountId: "acct-A" } }] }),
      getProjectProperty: async (key: string) => {
        const p = properties.get(key);
        if (!p) throw new Error(`fake: 404, no "butchr" property for ${key}`);
        return p;
      },
      getProjectPropertyOrNull: async (key: string) => properties.get(key) ?? null,
      setProjectProperty: async (key: string, _propertyKey: string, value: unknown) => {
        properties.set(key, value as Record<string, unknown>);
        return { ok: true };
      },
      getPageVersions: async (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, 1])),
      // 100 already seen (wakes nothing), 200 new — the SAME mixed-poll
      // shape Section 6 uses, but observed through the real handler's own
      // read, not handed in by the test.
      getPageComments: async () => ({ results: [{ id: "100", body: "" }, { id: "200", body: "" }] }),
      getIssueComments: async () => ({ results: [] }),
    };
    const tools = atlassianTools(ops, () => {});
    const conn = { headers: { "x-issue": "ACME" } } as any;
    const result = (await tools.check_in!.handler({}, conn)) as { seenComments: string[] };
    expect(result.seenComments).toEqual(["100", "200"]); // the handler's OWN return already claims the full set
    const stored = (properties.get("ACME") as any).wake as { commentsSeen: string[] };
    expect(new Set(stored.commentsSeen)).toEqual(new Set(["100", "200"])); // and storage actually got both, not just the one that woke anything
  });
});

// ===========================================================================
// SECTION 7 — THE BLIND SPOT, CONSTRUCTED: a comment/epic-comment outside
// the reader's page window is never observed, therefore never seen,
// therefore never wakes anything — and the admission's WINDOW SIZE is
// checked against what is actually findable in this codebase, per axis.
// ===========================================================================
describe("SECTION 7 — the pagination blind spot, constructed per axis", () => {
  // EPICS AXIS — the window size IS a findable, coded constant:
  // `AtlassianOps.getIssueComments`'s own doc comment (src/tools/atlassian.ts)
  // states "NEWEST FIRST, capped — the SAME ordering and cap as
  // src/atlassian/client.ts's AtlassianClient.comments() (orderBy: "-created",
  // maxResults: 20)", and the real implementation
  // (src/tools/atlassian-real.ts, getIssueComments) passes
  // `maxResults: 20` explicitly. This test constructs exactly the admitted
  // blind spot: an epic whose OLDEST never-seen comment sits beyond a
  // 20-item newest-first window, and confirms the mechanism stays silent —
  // not merely asserts the admission's prose, but exercises it against a
  // fake reader that actually enforces the cap the same way.
  //
  // FALSIFIER: if `unseenEpicCommentIds` ever contained the id this fixture
  // places beyond the window, that would mean discovery has some way to see
  // past a capped reader's own return value — which would be a surprise
  // worth reporting on its own (a hidden second read path), not a pass.
  test("EPICS AXIS: a never-seen comment beyond the reader's own 20-item newest-first cap is never observed, therefore never wakes anything", async () => {
    // 21 comments total; ids "1".."21" by creation order, id "1" oldest,
    // NEVER previously seen. A newest-first, maxResults:20 reader returns
    // ids "21".."2" — "1" is the one the cap excludes, exactly BUTCHR-199's
    // admitted shape ("a comment that never appears inside the reader's page
    // window is never observed").
    const allIds = Array.from({ length: 21 }, (_, i) => String(i + 1));
    const cappedNewestFirst = [...allIds].reverse().slice(0, 20); // "21".."2" — excludes "1"
    const w = fakeWorld({
      properties: { ACME: PROPERTY_A },
      pageVersions: { "doc-A": 1 },
      pageComments: { "doc-A": [] },
      epicsInReview: [{ key: "ACME-1", summary: "e", status: "In Review", issuetype: "Epic", assignee: null, parent: null, updated: "", labels: [] }],
      epicComments: { "ACME-1": cappedNewestFirst.map((id) => ({ id })) }, // the fake READER already enforces the real cap
    });
    const [acme] = await createProjectResourceType(w.deps).discovery.search();
    expect(acme!.observedEpics[0]!.commentIds).not.toContain("1"); // the reader itself never returned it
    expect(acme!.unseenEpicCommentIds["ACME-1"]).not.toContain("1"); // and so it can never be classified as unseen either
    // The mechanism is SILENT on it, exactly as admitted — not merely
    // "eventually consistent": nothing in this module retries with a
    // different page or notices the gap.
  });

  // ROOT-DOC (COMMENT) AXIS — ⚠ A VERDICT, NOT A CONSTRUCTED REPRODUCTION:
  // unlike the epics axis, this file did NOT find a coded, numeric window
  // size for `getPageComments` anywhere in this repository. Checked:
  // `AtlassianOps.getPageComments`'s own doc comment (src/tools/atlassian.ts)
  // documents author/created semantics and the batch-call trap at length,
  // but states NO numeric cap. The real implementation
  // (src/tools/atlassian-real.ts, `getPageComments`) calls
  // `wiki.comment.getPageFooterComments({ id: pageId, bodyFormat: "storage" })`
  // with NO `limit` parameter — confluence.js's own `getPageFooterComments`
  // (v2 API) accepts an optional `limit` (its request builder forwards
  // `parameters.limit` verbatim; see that package's own
  // `dist/v2/api/comment.js`), so an omitted `limit` falls through to
  // whatever the Confluence Cloud REST API's OWN server-side default is for
  // `GET /wiki/api/v2/pages/{id}/footer-comments` — a number this file
  // cannot measure (issue-tier, no live Confluence access) and did not find
  // asserted anywhere in this codebase's comments, tests, or docs/.
  //
  // THE VERDICT, per the ticket's DoD item 9 ("the admission checked against
  // the real boundary including the measured window size per axis"): the
  // blind-spot ADMISSION itself (`ProjectResource.observedCommentIds`'s own
  // doc comment, and BUTCHR-199's doc) is TRUE in shape (a page-window bound
  // exists and is unfixed) but UNDERSTATES on this specific point — it names
  // the epics axis's window as findable (this file confirms it: 20) while
  // never stating the comment axis's own window size, and neither does this
  // module's source. That asymmetry is itself worth reporting: one axis's
  // blind spot is a quantified, testable boundary; the other axis's is
  // qualitatively admitted but not quantified anywhere in-repo.
  // A REAL, BREAKABLE check — reads src/tools/atlassian-real.ts's own source
  // rather than asserting a hand-typed boolean (the prior version of this
  // test was `expect(true).toBe(true)`, flagged in review as reporting its
  // own conclusion rather than reading for it — exactly the staleness
  // failure mode this ticket exists to catch, inside its own artefact).
  // FALSIFIER, stated before this version was run: if `getPageComments`'s
  // call site ever gains a `limit` argument or a `_links.next`/cursor
  // follow, OR if the sibling `getChildPages` in the same file ever LOSES
  // its own pagination follow, this test must fail — either change would
  // mean the asymmetry this section reports no longer holds.
  test("ROOT-DOC AXIS: getPageComments passes no limit and follows no cursor, unlike the sibling getChildPages in the same file — the asymmetry itself, read from source", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "src", "tools", "atlassian-real.ts"), "utf8");
    const getPageCommentsBody = source.slice(source.indexOf("getPageComments:"), source.indexOf("getPageComments:") + 400);
    // (1) no `limit` argument on the root-doc comment read's own call site.
    expect(getPageCommentsBody).toContain('wiki.comment.getPageFooterComments({ id: pageId, bodyFormat: "storage" })');
    expect(getPageCommentsBody).not.toMatch(/getPageFooterComments\([^)]*limit/s);
    // (2) no `_links.next` / cursor follow anywhere in that call's own body.
    expect(getPageCommentsBody).not.toContain("_links");
    expect(getPageCommentsBody).not.toContain("cursor");
    // (3) the sibling getChildPages, in the SAME file, DOES paginate — the
    // asymmetry DoD item 9 asks to be checked, not just the comment-axis gap
    // alone.
    const getChildPagesBody = source.slice(source.indexOf("getChildPages:"), source.indexOf("getChildPages:") + 400);
    expect(getChildPagesBody).toContain("limit: 50");
    expect(getChildPagesBody).toContain("_links?.next");
    expect(getChildPagesBody).toContain("cursor");
  });
});

// ===========================================================================
// SECTION 8 — verdicts requiring no new fixture, recorded here so the
// artefact is self-contained and citable from the doc.
// ===========================================================================
describe("SECTION 8 — verdicts", () => {
  // WHICH AXES CHANGED (ticket's ALSO CHECK item 6 / DoD item 11): a REAL,
  // BREAKABLE check against `projectVerdict`'s own behavior, not just its
  // source text. FALSIFIER: if the version axis ever reads "active" for a
  // reason other than plain scalar inequality (e.g. if it started tolerating
  // a lower observed version, or started using set membership like the other
  // two axes), OR if the comment/epics axes ever failed to go "active" on a
  // fixture engineered to be behind on ONLY that one axis, that would mean
  // more (or less) of the predicate changed than the ticket claims.
  test("VERDICT: the version axis is UNCHANGED (plain scalar inequality) while comment and epics axes use SET MEMBERSHIP — engineered one-axis-behind fixtures for each", () => {
    // Version-only-behind: observedVersion differs from watermark.version,
    // nothing else behind. A magnitude-tolerant version axis would need
    // observedVersion > watermark.version specifically to still read active;
    // this fixture instead uses a LOWER observed version than watermark to
    // prove the comparison is bare inequality (!==), not an ordering check —
    // if the version axis had been converted to "behind" meaning "less
    // than", this specific fixture (observed lower than stored) would still
    // read active, so this alone doesn't distinguish the two. What does
    // distinguish them: the version axis has no "unseen set" of its own at
    // all in ProjectResource — there is exactly one scalar field
    // (`observedVersion`) compared against exactly one scalar
    // (`watermark.version`), never a collection.
    const versionOnlyBehind = project({
      watermark: { version: 5, commentsSeen: ["100"], epicsSeen: {} },
      observedCommentIds: ["100"],
      observedVersion: 6,
    });
    expect(projectVerdict(versionOnlyBehind)).toBe("active");
    const versionCaughtUp = project({
      watermark: { version: 5, commentsSeen: ["100"], epicsSeen: {} },
      observedCommentIds: ["100"],
      observedVersion: 5,
    });
    expect(projectVerdict(versionCaughtUp)).toBe("asleep");

    // Comment-only-behind: version and epics caught up, one unseen comment id.
    const commentOnlyBehind = project({
      watermark: { version: 5, commentsSeen: ["100"], epicsSeen: {} },
      observedCommentIds: ["100", "200"],
      observedVersion: 5,
    });
    expect(projectVerdict(commentOnlyBehind)).toBe("active");

    // Epics-only-behind: version and comments caught up, one epic with an
    // unseen comment id.
    const epicsOnlyBehind = project({
      watermark: { version: 5, commentsSeen: ["100"], epicsSeen: { "ACME-1": ["50"] } },
      observedCommentIds: ["100"],
      observedEpics: [{ key: "ACME-1", commentIds: ["50", "51"] }],
      observedVersion: 5,
    });
    expect(projectVerdict(epicsOnlyBehind)).toBe("active");
  });

  // THE SIZE-CEILING ASSERTION ACTUALLY FIRES (ticket's ALSO CHECK item 8 /
  // DoD item 11): a REAL, CONSTRUCTED overflow, not merely a grep for the
  // constant. FALSIFIER: if `advanceProjectWatermark` completes without
  // throwing when the resulting `commentsSeen` array serializes to more than
  // `PROJECT_PROPERTY_SIZE_CEILING_BYTES` (32768) bytes, the runtime
  // assertion the ticket asks to be checked "actually fires" would be dead
  // code — a comment-only ceiling, exactly the class of self-declaring-grade
  // problem the source's own doc comment says this assertion exists to
  // avoid.
  test("VERDICT: advanceProjectWatermark THROWS when the write would exceed the 32768-byte property ceiling — constructed, not asserted from the constant alone", async () => {
    // ~8-digit comment ids cost ~11 bytes each as a JSON array entry (per
    // this module's own doc-comment budgeting); 3200 of them comfortably
    // exceeds 32768 bytes total for the array alone.
    const manyIds = Array.from({ length: 3200 }, (_, i) => String(20000000 + i));
    const w = fakeWorld({
      properties: { ACME: PROPERTY_A },
      pageVersions: { "doc-A": 1 },
      pageComments: { "doc-A": [] },
    });
    await expect(advanceProjectWatermark(w.ops, "ACME", { seenComments: manyIds })).rejects.toThrow(/32768/);
    // And confirm the write did NOT partially land — `rootDoc` (unrelated to
    // this write, present in PROPERTY_A) must be untouched, matching the
    // "refuse rather than risk a silent truncation" claim: the throw happens
    // BEFORE `setProjectProperty` is called at all.
    expect(w.properties.get("ACME")).toEqual(PROPERTY_A);
  });

  test("VERDICT: no verdict in this file rests on Jira comment ids being monotonic — the epics axis reuses the IDENTICAL set-membership check as the comment axis", () => {
    // Structural proof, not a claim about Jira's id space: `projectVerdict`
    // (src/resources/project.ts) computes `epicsBehind` from
    // `p.unseenEpicCommentIds`, which `loadProjects` derives via the SAME
    // `unseenIds` helper used for `unseenCommentIds` — one function, two
    // call sites, verified by reading src/resources/project.ts directly
    // (grep `unseenIds` at your own checkout). Whether Jira comment ids
    // happen to be monotonic is therefore IRRELEVANT to this design's
    // correctness on either axis — the open Jira-id question the ticket
    // flags as unmeasured does not need measuring for this verdict to hold.
    const epicWithHighThenLowIds = project({
      observedEpics: [{ key: "ACME-1", commentIds: ["999999", "1"] }], // deliberately non-monotonic, whatever the true Jira ordering is
      watermark: { version: null, commentsSeen: [], epicsSeen: { "ACME-1": ["999999"] } },
    });
    // "1" is unseen by MEMBERSHIP alone, despite being numerically far below
    // the already-seen "999999" — a magnitude/threshold reading would
    // (wrongly) treat "1" as covered by the higher already-seen id.
    expect(epicWithHighThenLowIds.unseenEpicCommentIds["ACME-1"]).toEqual(["1"]);
    expect(projectVerdict(epicWithHighThenLowIds)).toBe("active");
  });

  // NOTE ON "BUTCHR-199's doc still carries the false pre-fix premise
  // ('cannot lower the watermark')" — the epic's late requirement (see this
  // ticket's comment stream). NOT included as a test here: a unit test has
  // no network access and cannot fetch a live Confluence page, so any
  // in-file assertion about that doc's CURRENT content would be either
  // stale the moment the doc changes or silently checking nothing. This
  // file's author read BUTCHR-199's doc via `get_doc("BUTCHR-199")` at the
  // time this PR was written and did not find that phrase in it — reported
  // as a point-in-time verdict in BUTCHR-258's own doc and PR description,
  // not asserted here as a standing fact a test suite could ever re-check.

  // THE CITABLE-TEST PROMISE TO BUTCHR-115 — a REAL, BREAKABLE check: reads
  // the sibling test file's own source and confirms the exact promised name
  // is still present, so this fails for real if that test is ever renamed
  // or deleted, rather than merely asserting a boolean this file's author
  // typed by hand.
  test("VERDICT: the citable-test promise to BUTCHR-115 is kept — the exact promised test name is still present in project-resource-type.test.ts", () => {
    const siblingSource = readFileSync(join(import.meta.dir, "project-resource-type.test.ts"), "utf8");
    expect(siblingSource).toContain("BUTCHR-227 NAMED PROPERTY: a comment created later, drawing a LOWER id than one already seen, is still observed");
    // Also confirm it is not the trivial "fresh comment draws a higher id"
    // shape the ticket warns would pass while proving nothing: the promised
    // test's own fixture must use the SEEN id as the LARGER number and the
    // UNSEEN id as the SMALLER one.
    expect(siblingSource).toContain('commentsSeen: ["18153493"]');
    expect(siblingSource).toContain('["17334528"]');
    expect(Number("18153493")).toBeGreaterThan(Number("17334528")); // the seen id is numerically larger — a real inversion, not a fresh-comment no-op
  });

  // THE RETENTION DECISION — a REAL, BREAKABLE check: reads project.ts's own
  // source and confirms the "no eviction, declared with a reason" text is
  // still present, rather than asserting a hand-typed boolean.
  test("VERDICT: the retention decision (no eviction, ever) is declared with a reason in project.ts's own source, not merely implicit", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "src", "resources", "project.ts"), "utf8");
    expect(source).toContain("NO RETENTION RULE, DECLARED");
    expect(source).toMatch(/timestamped\s+PAST EVENT/);
    // And the one thing that could smuggle a retention bound in as a
    // correctness bound — an id-threshold comparison — is absent from the
    // observe/classify/write path (mirrors project-resource-type.test.ts's
    // own "no Number()/magnitude comparison anywhere" test, checked here
    // against the retention-bearing doc comment's own surrounding source
    // rather than re-run against a fixture).
    expect(source).not.toMatch(/commentsSeen[^\n]*\.sort\(/);
  });

  // DoD item 8 (any stored-id-vs-threshold-id comparison) — a REAL,
  // BREAKABLE check against `unseenIds` ITSELF, the one function both axes
  // share, rather than only deferring to project-resource-type.test.ts's own
  // "no Number()/magnitude" test (this file's §10 leaned on that sibling
  // check alone, flagged in review as a soft spot for an increment whose
  // premise is not relying on the implementer's own pinning). FALSIFIER: if
  // `unseenIds`'s body ever gains `Number(`, a comparison operator
  // (`<`/`>`/`<=`/`>=`), or `.sort(`, this must fail — a `Set`+`.filter`
  // membership check has no arithmetic or ordering to smuggle a threshold
  // into.
  test("VERDICT: unseenIds — the one function both axes share — is set membership only, read directly from its own body, not deferred to a sibling suite", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "src", "resources", "project.ts"), "utf8");
    const start = source.indexOf("function unseenIds(");
    expect(start).toBeGreaterThan(-1); // the symbol must exist at all, or this test is pointed at nothing
    const body = source.slice(start, source.indexOf("\n}", start) + 2);
    expect(body).toContain("new Set(seen)");
    expect(body).toContain(".filter((id) => !seenSet.has(id))");
    expect(body).not.toContain("Number(");
    expect(body).not.toMatch(/(?<!=)>|</); // no ordering comparison anywhere in the body — excludes only the arrow `=>` in the filter callback, which is not a comparison
    expect(body).not.toContain(".sort(");
  });
});
