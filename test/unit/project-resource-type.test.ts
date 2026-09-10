import { describe, expect, test } from "bun:test";
import {
  advanceProjectWatermark,
  createProjectEventRules,
  createProjectResourceType,
  projectIdOf,
  projectVerdict,
  PROJECT_ACTIVATION,
  PROJECT_SPAWN_CONFIG,
  type ProjectEpic,
  type ProjectResource,
  type ProjectResourceDeps,
  type ProjectWatermark,
} from "../../src/resources/project.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

// BUTCHR-67/BUTCHR-81/BUTCHR-227. Failure conditions are stated in each
// describe/test's own comment, per this ticket's evidence-discipline
// requirement — a check whose failure isn't stated first doesn't count as
// evidence.
//
// BUTCHR-227's REAL MEASURED FIXTURE, carried through this file rather than
// invented ids (per this ticket's own instruction): the sharpest inversion
// on record — id `18153493` created `19:51:09.376Z`, and id `17334528`
// created THIRTY MINUTES LATER at `20:21:09.175Z` but 818,965 LOWER. Also:
// `17334328`/`17104948` (24s apart, 229,380 apart) and the live-regressed
// pair `17760259` (a real, already-acted-on watermark) / `16777415` (the
// value it was measured to have regressed TO). THE CONTROL (BUTCHR-119,
// carried per this ticket's own requirement): every comment in this real
// dataset is `version.number === 1` (never edited), so its `created`
// timestamp is genuinely creation time, not edit time — without that
// control, "created later, lower id" would be a coincidence, not a result.
// This file does not re-verify `version.number` itself (it has no live
// Confluence to check it against); it states the assumption it inherits,
// per this ticket's "carry the control, or state your fixture's assumption
// explicitly" requirement.

function project(overrides: Partial<ProjectResource> = {}): ProjectResource {
  const observedCommentIds = overrides.observedCommentIds ?? ["100"];
  const observedEpics = overrides.observedEpics ?? [];
  const watermark: ProjectWatermark = overrides.watermark ?? { version: 5, commentsSeen: ["100"], epicsSeen: {} };
  return {
    key: "ACME",
    name: "Acme",
    eligible: true,
    rootDocId: "1",
    observedVersion: 5,
    observedEpics,
    // Derived exactly the way `loadProjects` derives them, unless a test
    // overrides one directly to exercise a mismatch between the derived
    // field and its inputs (e.g. a stale/hand-crafted unseen list).
    unseenCommentIds: overrides.unseenCommentIds ?? observedCommentIds.filter((id) => !watermark.commentsSeen.includes(id)),
    unseenEpicCommentIds:
      overrides.unseenEpicCommentIds ??
      Object.fromEntries(observedEpics.map((e) => [e.key, e.commentIds.filter((id) => !(watermark.epicsSeen[e.key] ?? []).includes(id))])),
    observedCommentIds,
    watermark,
    ...overrides,
  };
}

describe("projectVerdict — the pure activation/nudge predicate", () => {
  // Failure condition: any of these returning the wrong verdict means the
  // watermark comparison (or the eligibility short-circuit) is wrong.

  test("ineligible -> inactive, regardless of watermark state", () => {
    expect(projectVerdict(project({ eligible: false, observedVersion: 999, watermark: { version: 1, commentsSeen: [], epicsSeen: {} } }))).toBe("inactive");
  });

  test("eligible and every axis caught up -> asleep", () => {
    expect(projectVerdict(project())).toBe("asleep");
  });

  test("version behind, comment and epics caught up -> active (rules 1/2 are independent axes)", () => {
    expect(projectVerdict(project({ observedVersion: 6 }))).toBe("active");
  });

  test("comment behind (an observed id absent from the seen set) -> active", () => {
    expect(projectVerdict(project({ observedCommentIds: ["100", "101"] }))).toBe("active");
  });

  // THE NAMED REGRESSION TEST (BUTCHR-227 DoD item: "a comment created
  // later, drawing a LOWER id than one already seen, is still observed"),
  // using the real measured pair (see this file's own top comment): id
  // `18153493` was already seen (a prior check-in recorded it); id
  // `17334528`, created thirty minutes LATER but 818,965 LOWER, is freshly
  // observed. Failure condition: this returning `"asleep"` would mean the
  // fix re-derived id magnitude somewhere on this path — a threshold
  // walking back in, this ticket's own named trap.
  test("BUTCHR-227 NAMED PROPERTY: a comment created later, drawing a LOWER id than one already seen, is still observed", () => {
    const p = project({
      observedCommentIds: ["18153493", "17334528"],
      watermark: { version: 5, commentsSeen: ["18153493"], epicsSeen: {} },
    });
    expect(p.unseenCommentIds).toEqual(["17334528"]);
    expect(projectVerdict(p)).toBe("active");
  });

  // The mirror of the property above, stated as its own failure condition:
  // an id that WAS already seen must stay asleep even though it is
  // numerically LOWER than another id in the seen set — set membership
  // only, no magnitude comparison anywhere. A fixture that only ever tests
  // "unseen -> active" could pass an implementation that (wrongly) treats
  // any id BELOW the max of the seen set as seen too (a threshold in
  // disguise); this fixture's seen set has a LOWER id than the one already
  // recorded max would suggest, and it must still read as caught up.
  test("an id already in the seen set stays asleep even though a HIGHER id also exists in the seen set — membership, not a max/threshold", () => {
    const p = project({
      observedCommentIds: ["17334528"], // the lower, already-seen id, observed again
      watermark: { version: 5, commentsSeen: ["17334528", "18153493"], epicsSeen: {} },
    });
    expect(p.unseenCommentIds).toEqual([]);
    expect(projectVerdict(p)).toBe("asleep");
  });

  test("an epic never before seen in review -> active (absent from watermark.epicsSeen == never acted on)", () => {
    expect(projectVerdict(project({ observedEpics: [{ key: "ACME-1", commentIds: [] }] }))).toBe("active");
  });

  test("an epic already watermarked, no new comment since -> asleep", () => {
    expect(
      projectVerdict(
        project({
          observedEpics: [{ key: "ACME-1", commentIds: ["50"] }],
          watermark: { version: 5, commentsSeen: ["100"], epicsSeen: { "ACME-1": ["50"] } },
        }),
      ),
    ).toBe("asleep");
  });

  test("an epic's comment set gained an id past its watermark -> active", () => {
    expect(
      projectVerdict(
        project({
          observedEpics: [{ key: "ACME-1", commentIds: ["50", "51"] }],
          watermark: { version: 5, commentsSeen: ["100"], epicsSeen: { "ACME-1": ["50"] } },
        }),
      ),
    ).toBe("active");
  });

  // BUTCHR-81 DEFECT #1a (found at review, still true under the seen-set):
  // a per-epic watermark KEY SET, MERGED (never pruned), cannot detect an
  // epic RE-ENTERING review with no new comment (submit_to_boss transitions
  // status; it does not necessarily comment) — a stale map entry from the
  // epic's PRIOR review episode compares as caught-up and the project
  // wrongly stays asleep.
  //
  // THE ACTUAL FIX: re-entry is caught by PRUNING THE KEY on the WRITE
  // side — `advanceProjectWatermark`'s `epics` patch REPLACES the whole KEY
  // SET (see its own doc comment) rather than merging, so an epic that has
  // left review is absent from the next replacement and re-entry is
  // detected by absence again. This test proves that replace-based prune,
  // not `projectVerdict` alone (which cannot see "did this get pruned" —
  // that is the WRITE side's job): failure condition, written first — the
  // full sequence (enter -> act/watermark -> leave -> re-enter with no new
  // comment) must end with `projectVerdict` returning `active`.
  test("BUTCHR-81 regression, still true under the seen-set: an epic that leaves review and RE-ENTERS with no new comment still wakes the project, via prune-on-checkin", async () => {
    const w = fakeWorld({ myAccountId: "acct-A", projects: [], properties: { ACME: { ...PROPERTY_A, wake: { version: 5, commentsSeen: ["100"], epicsSeen: { "ACME-1": ["50"] } } } } });
    // Episode 1 already watermarked with epic ACME-1 seen through "50". The
    // epic then LEFT review — a real check_in-shaped call observes zero
    // epics in review right now and REPLACES the key set with {} (pruning
    // ACME-1).
    await advanceProjectWatermark(w.ops, "ACME", { epics: {} });
    expect((w.properties.get("ACME")!.wake as { epicsSeen: unknown }).epicsSeen).toEqual({});
    // Episode 2: the epic RE-ENTERS review with NO new comment (still "50").
    const reenteredWithNoComment = project({
      watermark: { version: 5, commentsSeen: ["100"], epicsSeen: (w.properties.get("ACME")!.wake as { epicsSeen: Record<string, readonly string[]> }).epicsSeen },
      observedEpics: [{ key: "ACME-1", commentIds: ["50"] }],
    });
    expect(projectVerdict(reenteredWithNoComment)).toBe("active"); // absent from the pruned map -> behind
  });

  test("a never-recorded (empty) watermark with something observed -> active (fail-open, matches the issue tier's baseline philosophy)", () => {
    expect(projectVerdict(project({ watermark: { version: null, commentsSeen: [], epicsSeen: {} } }))).toBe("active");
  });

  test("nothing observed yet (empty) and no watermark -> asleep, not active on absence alone", () => {
    expect(projectVerdict(project({ observedVersion: null, observedCommentIds: [], watermark: { version: null, commentsSeen: [], epicsSeen: {} } }))).toBe("asleep");
  });

  // BUTCHR-227 DoD item 7 (no comparison anywhere between a stored id and a
  // threshold id): a seen set containing ids on BOTH sides of an observed
  // id's magnitude must not accidentally short-circuit via any sort/first/
  // last access. This fixture's seen set is intentionally NOT sorted and
  // straddles the observed id numerically in both directions.
  test("no Number()/magnitude comparison anywhere: an unsorted seen set straddling the observed id in both directions still resolves by membership alone", () => {
    const p = project({
      observedCommentIds: ["500"],
      watermark: { version: 5, commentsSeen: ["999", "1", "500", "2"], epicsSeen: {} },
    });
    expect(projectVerdict(p)).toBe("asleep"); // "500" IS a member, regardless of "999" and "1" flanking it
  });
});

describe("PROJECT_ACTIVATION / PROJECT_SPAWN_CONFIG / projectIdOf", () => {
  test("PROJECT_ACTIVATION.verdictFor delegates to projectVerdict", () => {
    expect(PROJECT_ACTIVATION.verdictFor(project())).toBe("asleep");
    expect(PROJECT_ACTIVATION.verdictFor(project({ observedVersion: 6 }))).toBe("active");
  });

  test("PROJECT_SPAWN_CONFIG.specFor: issuetype 'project', parent null (top-level), key/summary from the resource", () => {
    expect(PROJECT_SPAWN_CONFIG.specFor(project({ key: "FOO", name: "Foo Inc" }))).toEqual({
      key: "FOO",
      issuetype: "project",
      summary: "Foo Inc",
      parent: null,
    });
  });

  test("projectIdOf returns the bare project key", () => {
    expect(projectIdOf(project({ key: "BAR" }))).toBe("BAR");
  });
});

// --- A fake AtlassianOps + Jira-search deps for discovery tests ---

interface FakeWorld {
  ops: AtlassianOps;
  deps: ProjectResourceDeps;
  properties: Map<string, Record<string, unknown>>;
  calls: { getPageVersions: string[][]; getPageComments: string[]; getIssueComments: string[]; search: string[]; getProjectPropertyOrNull: string[] };
}

function fakeWorld(opts: {
  myAccountId: string;
  projects: Array<{ key: string; name: string; leadAccountId: string }>;
  properties: Record<string, Record<string, unknown> | undefined>; // undefined = genuine 404 (ineligible)
  propertyFailures?: Record<string, Error>; // a NON-404 failure — must propagate, never silently ineligible
  pageVersions?: Record<string, number>;
  pageComments?: Record<string, Array<{ id: string; body: string }>>;
  epicsInReview?: JiraIssue[];
  epicComments?: Record<string, Array<{ id: string }>>;
  // BUTCHR-91/BUTCHR-68: defaults to admitting every project passed in
  // `projects` — every PRE-EXISTING test in this file constructs a
  // `fakeWorld` without this field and must keep exercising exactly the
  // lead/eligibility behavior it already asserts, unaffected by the
  // allowlist this ticket adds. Pass an explicit `allowlist` only in a test
  // that means to exercise the allowlist itself (see the "allowlist" describe
  // block below).
  allowlist?: readonly string[];
}): FakeWorld {
  const properties = new Map(Object.entries(opts.properties).filter(([, v]) => v !== undefined) as [string, Record<string, unknown>][]);
  const calls = { getPageVersions: [] as string[][], getPageComments: [] as string[], getIssueComments: [] as string[], search: [] as string[], getProjectPropertyOrNull: [] as string[] };

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

    getMyself: async () => ({ accountId: opts.myAccountId }),
    searchProjects: async (_status) => ({
      values: opts.projects.map((p) => ({ key: p.key, name: p.name, lead: { accountId: p.leadAccountId } })),
    }),
    // Still throw-always, matching the real op's contract. Also honors
    // `propertyFailures` (BUTCHR-105): the real op throws on ANY failure,
    // 404 or otherwise, so a non-404 failure must be simulatable here too —
    // this is what lets a regression test targeting the OLD
    // `advanceProjectWatermark` (which called THIS op, bare-`.catch`ed)
    // actually exercise the failure it existed to catch, rather than
    // silently reading a fine property back.
    getProjectProperty: async (key: string) => {
      if (opts.propertyFailures?.[key]) throw opts.propertyFailures[key];
      const p = properties.get(key);
      if (!p) throw new Error(`fake: 404, no "butchr" property for ${key}`);
      return p;
    },
    // discovery's own read: null on a genuine 404, THROWS (propagates) on
    // any configured non-404 failure — the both-directions distinction
    // BUTCHR-81's review required.
    getProjectPropertyOrNull: async (key: string) => {
      calls.getProjectPropertyOrNull.push(key);
      if (opts.propertyFailures?.[key]) throw opts.propertyFailures[key];
      return properties.get(key) ?? null;
    },
    setProjectProperty: async (key: string, _propertyKey: string, value: unknown) => {
      properties.set(key, value as Record<string, unknown>);
      return { ok: true };
    },
    getPageVersions: async (ids: readonly string[]) => {
      calls.getPageVersions.push([...ids]);
      const out: Record<string, number> = {};
      for (const id of ids) if (opts.pageVersions?.[id] !== undefined) out[id] = opts.pageVersions[id]!;
      return out;
    },
    getPageComments: async (pageId: string) => {
      calls.getPageComments.push(pageId);
      return { results: opts.pageComments?.[pageId] ?? [] };
    },
    getIssueComments: async (key: string) => {
      calls.getIssueComments.push(key);
      return { results: opts.epicComments?.[key] ?? [] };
    },
  };

  const deps: ProjectResourceDeps = {
    ops,
    search: async (jql: string) => {
      calls.search.push(jql);
      return opts.epicsInReview ?? [];
    },
    allowlist: new Set(opts.allowlist ?? opts.projects.map((p) => p.key)),
  };

  return { ops, deps, properties, calls };
}

const PROPERTY_A = { space: { key: "ACME" }, rootDoc: { id: "doc-A" } };
const PROPERTY_B = { space: { key: "BETA" }, rootDoc: { id: "doc-B" } };

describe("discovery — Declaration 1 (client-side lead filter)", () => {
  // Failure condition: a WRONG configured account admitting anything but
  // zero projects means the filter isn't actually filtering (this is the
  // proof required in place of trusting the live server-side leadAccountId
  // param, MEASURED to be silently ignored).
  test("a WRONG configured account id returns ZERO projects, even though live projects exist", async () => {
    const w = fakeWorld({
      myAccountId: "acct-nonexistent",
      projects: [
        { key: "ACME", name: "Acme", leadAccountId: "acct-A" },
        { key: "BETA", name: "Beta", leadAccountId: "acct-B" },
      ],
      properties: { ACME: PROPERTY_A, BETA: PROPERTY_B },
      pageVersions: { "doc-A": 1, "doc-B": 1 },
    });
    const result = await createProjectResourceType(w.deps).discovery.search();
    expect(result).toEqual([]);
  });

  test("the RIGHT configured account id admits exactly the projects it leads, none led by others", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [
        { key: "ACME", name: "Acme", leadAccountId: "acct-A" },
        { key: "BETA", name: "Beta", leadAccountId: "acct-B" },
      ],
      properties: { ACME: PROPERTY_A, BETA: PROPERTY_B },
      pageVersions: { "doc-A": 1, "doc-B": 1 },
    });
    const result = await createProjectResourceType(w.deps).discovery.search();
    expect(result.map((p) => p.key)).toEqual(["ACME"]);
  });
});

describe("discovery — allowlist (BUTCHR-91/BUTCHR-68: opt-in staffing scope, default OFF)", () => {
  // Failure condition, stated first: an EMPTY allowlist must yield ZERO
  // projects even though both live projects are led by this credential and
  // fully eligible — the same shape a naive (allowlist-less) wiring would
  // staff. A one-sided assertion here (just "result is []") would also pass
  // a reject-everything implementation, so this is paired with the very
  // next test — the SAME two projects, only `allowlist` differs — proving
  // the empty result comes from the allowlist actually filtering, not from
  // a stub that always returns nothing.
  test("empty allowlist -> zero projects staffed, even though both candidates are led and eligible", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [
        { key: "ACME", name: "Acme", leadAccountId: "acct-A" },
        { key: "BETA", name: "Beta", leadAccountId: "acct-A" },
      ],
      properties: { ACME: PROPERTY_A, BETA: PROPERTY_B },
      pageVersions: { "doc-A": 1, "doc-B": 1 },
      allowlist: [],
    });
    const result = await createProjectResourceType(w.deps).discovery.search();
    expect(result).toEqual([]);
    // The own control: none of the per-project I/O below ran either — an
    // unlisted project must cost nothing beyond the in-memory filter (see
    // `loadProjects`'s own comment on this).
    expect(w.calls.getProjectPropertyOrNull).toEqual([]);
    expect(w.calls.getPageVersions).toEqual([]);
    expect(w.calls.getPageComments).toEqual([]);
  });

  // The control half of the pair above, and the direct proof of Definition
  // of Done item 2(b): the SAME two led-and-eligible candidates, only ACME
  // named in the allowlist -> ACME staffed, BETA excluded despite being
  // equally led and equally eligible. Failure condition: BETA appearing in
  // the result, or ACME missing, either one means the filter isn't scoping
  // to exactly the named key.
  test("allowlist naming ACME -> exactly ACME staffed; BETA (equally led, equally eligible) excluded", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [
        { key: "ACME", name: "Acme", leadAccountId: "acct-A" },
        { key: "BETA", name: "Beta", leadAccountId: "acct-A" },
      ],
      properties: { ACME: PROPERTY_A, BETA: PROPERTY_B },
      pageVersions: { "doc-A": 1, "doc-B": 1 },
      allowlist: ["ACME"],
    });
    const result = await createProjectResourceType(w.deps).discovery.search();
    expect(result.map((p) => p.key)).toEqual(["ACME"]);
    expect(result[0]!.eligible).toBe(true);
  });
});

describe("discovery — Declaration 2 (entity-property eligibility, independent of the lead filter)", () => {
  // Failure condition, stated first per this ticket's reviewer ruling: this
  // predicate fails if a project WITH the property is excluded, or a
  // project WITHOUT it (or without a usable rootDoc.id inside it) is
  // admitted — proven here directly, all three candidates led by the SAME
  // account, so the lead filter is not doing this work.
  test("property present with rootDoc.id -> eligible; property unreadable (404) -> ineligible; property present but missing rootDoc.id -> ineligible", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [
        { key: "HASPROP", name: "Has Property", leadAccountId: "acct-A" },
        { key: "NOPROP", name: "No Property", leadAccountId: "acct-A" },
        { key: "NOROOTDOC", name: "No Root Doc", leadAccountId: "acct-A" },
      ],
      properties: {
        HASPROP: { space: { key: "HASPROP" }, rootDoc: { id: "doc-1" } },
        NOPROP: undefined, // 404
        NOROOTDOC: { space: { key: "NOROOTDOC" } }, // present, but no rootDoc.id
      },
      pageVersions: { "doc-1": 3 },
    });
    const result = await createProjectResourceType(w.deps).discovery.search();
    const byKey = new Map(result.map((p) => [p.key, p]));
    expect(byKey.get("HASPROP")?.eligible).toBe(true);
    expect(byKey.get("HASPROP")?.rootDocId).toBe("doc-1");
    expect(byKey.get("NOPROP")?.eligible).toBe(false);
    expect(byKey.get("NOPROP")?.rootDocId).toBeNull();
    expect(byKey.get("NOROOTDOC")?.eligible).toBe(false);
    expect(byKey.get("NOROOTDOC")?.rootDocId).toBeNull();
    // No project key appears in the predicate itself — this is a behavioral
    // proof (the SAME three-candidate fixture, only the property shape
    // varies) rather than a name check.
  });
});

describe("discovery — BUTCHR-81 DEFECT #2 (found at review): a transient property-read failure must never demote a project to ineligible/inactive", () => {
  // The chain the reviewer traced: a bare catch around getProjectProperty ->
  // any error (404 OR a transient 429/500/timeout) -> null -> pushed into
  // the `ineligible` list with `eligible: false` -> `projectVerdict`
  // "inactive" -> BUTCHR-66's `desiredFrom`/`atRestFrom` place "inactive" in
  // NEITHER desired nor resting -> the reconciler's `stop` set -> a RUNNING
  // agent gets killed mid-work over one blipped read. Both directions
  // asserted together, same "both-directions" discipline as the lead filter
  // (a one-sided proof would have passed the broken implementation too).
  test("a genuine 404 (no butchr property) -> ineligible, exactly as Declaration 2 requires", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [{ key: "GONE", name: "Gone", leadAccountId: "acct-A" }],
      properties: { GONE: undefined }, // genuine 404
    });
    const [gone] = await createProjectResourceType(w.deps).discovery.search();
    expect(gone!.eligible).toBe(false);
  });

  test("a NON-404 failure (rate limit / timeout / permission change) on the property read propagates and fails the WHOLE poll — it must NOT come back as an ineligible/inactive project", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [{ key: "FLAKY", name: "Flaky", leadAccountId: "acct-A" }],
      properties: { FLAKY: PROPERTY_A },
      propertyFailures: { FLAKY: new Error("503 Service Unavailable (simulated transient failure)") },
    });
    await expect(createProjectResourceType(w.deps).discovery.search()).rejects.toThrow(/503/);
    // The failure propagated rather than resolving to a short/misclassified
    // list — a caller (runResourceLoop's fetch stage) that sees this
    // rejection changes nothing this poll, which is the safe direction
    // (retries at the next PROJECT_POLL_INTERVAL_MS) rather than reporting
    // FLAKY as a project the reconciler should stop.
  });

  test("one project's non-404 failure fails the poll even when OTHER projects would have resolved fine — no silent partial result", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [
        { key: "GOOD", name: "Good", leadAccountId: "acct-A" },
        { key: "FLAKY", name: "Flaky", leadAccountId: "acct-A" },
      ],
      properties: { GOOD: PROPERTY_A, FLAKY: PROPERTY_B },
      propertyFailures: { FLAKY: new Error("network timeout (simulated)") },
      pageVersions: { "doc-A": 1, "doc-B": 1 },
    });
    await expect(createProjectResourceType(w.deps).discovery.search()).rejects.toThrow(/timeout/);
  });
});

describe("discovery — call-count budget (batching)", () => {
  test("root-doc versions are read in ONE batched call across all eligible projects, not one per project", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [
        { key: "ACME", name: "Acme", leadAccountId: "acct-A" },
        { key: "BETA", name: "Beta", leadAccountId: "acct-A" },
      ],
      properties: { ACME: PROPERTY_A, BETA: PROPERTY_B },
      pageVersions: { "doc-A": 1, "doc-B": 2 },
    });
    await createProjectResourceType(w.deps).discovery.search();
    expect(w.calls.getPageVersions.length).toBe(1);
    expect(new Set(w.calls.getPageVersions[0])).toEqual(new Set(["doc-A", "doc-B"]));
  });

  test("footer comments are read ONE PER PROJECT (never batched — the batch-shaped endpoint measured live to lie)", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [
        { key: "ACME", name: "Acme", leadAccountId: "acct-A" },
        { key: "BETA", name: "Beta", leadAccountId: "acct-A" },
      ],
      properties: { ACME: PROPERTY_A, BETA: PROPERTY_B },
      pageVersions: { "doc-A": 1, "doc-B": 1 },
    });
    await createProjectResourceType(w.deps).discovery.search();
    expect(w.calls.getPageComments.sort()).toEqual(["doc-A", "doc-B"]);
  });

  test("rule-3 epics-in-review are fetched in ONE JQL call across all eligible projects, no per-epic call", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [
        { key: "ACME", name: "Acme", leadAccountId: "acct-A" },
        { key: "BETA", name: "Beta", leadAccountId: "acct-A" },
      ],
      properties: { ACME: PROPERTY_A, BETA: PROPERTY_B },
      pageVersions: { "doc-A": 1, "doc-B": 1 },
    });
    await createProjectResourceType(w.deps).discovery.search();
    expect(w.calls.search.length).toBe(1);
    expect(w.calls.search[0]).toContain("project IN (ACME,BETA)");
    expect(w.calls.search[0]).toContain('issuetype = Epic AND status = "In Review"');
  });
});

describe("discovery — rule 3 grouping and per-epic comment reads", () => {
  test("epics-in-review are grouped back to their own project by key prefix, and only in-review epics get a comments() call — commentIds carries EVERY observed id, not a 'newest' scalar", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
      properties: { ACME: PROPERTY_A },
      pageVersions: { "doc-A": 1 },
      epicsInReview: [
        { key: "ACME-10", summary: "Epic 10", status: "In Review", issuetype: "Epic", assignee: null, parent: null, updated: "", labels: [] },
      ],
      epicComments: { "ACME-10": [{ id: "c1" }, { id: "c2" }] },
    });
    const [acme] = await createProjectResourceType(w.deps).discovery.search();
    expect(acme!.observedEpics).toEqual([{ key: "ACME-10", commentIds: ["c1", "c2"] }] satisfies ProjectEpic[]);
  });

  test("no epics in review -> observedEpics is empty and no comments() call happens for any epic", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
      properties: { ACME: PROPERTY_A },
      pageVersions: { "doc-A": 1 },
      epicsInReview: [],
    });
    const [acme] = await createProjectResourceType(w.deps).discovery.search();
    expect(acme!.observedEpics).toEqual([]);
  });
});

describe("discovery — watermark round-trip (new shape)", () => {
  test("an existing wake.commentsSeen/epicsSeen on the butchr property is read into ProjectResource.watermark, and unseen fields are derived correctly", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 4, commentsSeen: ["99"], epicsSeen: { "ACME-1": ["2026-01-01"] } } } },
      pageVersions: { "doc-A": 4 },
      pageComments: { "doc-A": [{ id: "99", body: "hi" }] },
    });
    const [acme] = await createProjectResourceType(w.deps).discovery.search();
    expect(acme!.watermark).toEqual({ version: 4, commentsSeen: ["99"], epicsSeen: { "ACME-1": ["2026-01-01"] } });
    expect(acme!.observedCommentIds).toEqual(["99"]);
    expect(acme!.unseenCommentIds).toEqual([]);
    expect(projectVerdict(acme!)).toBe("asleep"); // fully caught up
  });

  test("no wake watermark recorded yet -> null/empty watermark, verdict active (fail-open)", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
      properties: { ACME: PROPERTY_A },
      pageVersions: { "doc-A": 4 },
    });
    const [acme] = await createProjectResourceType(w.deps).discovery.search();
    expect(acme!.watermark).toEqual({ version: null, commentsSeen: [], epicsSeen: {} });
    expect(projectVerdict(acme!)).toBe("active");
  });

  // --- THE MIGRATION (BUTCHR-227 DoD items 2, 3, 5, 6, 10) ---

  describe("the migration adapter — a pre-BUTCHR-227 legacy scalar seeds the seen-set, never as a threshold", () => {
    // Failure condition, stated first: this must seed EXACTLY the one
    // legacy id as seen (never a range, never "everything below it"). A
    // fixture with an observed id NUMERICALLY BELOW the legacy scalar that
    // still comes back unseen is the direct proof a threshold did not
    // sneak back in — the exact shape of bug this ticket exists to remove.
    test("a legacy `comment` scalar seeds a ONE-MEMBER commentsSeen set — a numerically LOWER but never-explicitly-seen id is still unseen", async () => {
      const w = fakeWorld({
        myAccountId: "acct-A",
        projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
        // Legacy shape: no `commentsSeen` field at all, only the old scalar.
        properties: { ACME: { ...PROPERTY_A, wake: { version: 5, comment: "18153493", epics: {} } } },
        pageVersions: { "doc-A": 5 },
        // Real measured pair: this id is NUMERICALLY LOWER than the legacy
        // scalar but was never itself recorded as seen — a threshold
        // interpretation would (wrongly) treat it as already covered.
        pageComments: { "doc-A": [{ id: "18153493", body: "" }, { id: "17334528", body: "" }] },
      });
      const [acme] = await createProjectResourceType(w.deps).discovery.search();
      expect(acme!.watermark.commentsSeen).toEqual(["18153493"]);
      expect(acme!.unseenCommentIds).toEqual(["17334528"]);
      expect(projectVerdict(acme!)).toBe("active");
    });

    // THE LIVE-REGRESSED-STATE CASE, DoD item 6: a fixture whose stored
    // value sits BELOW an already-seen comment — this ticket's own measured
    // live state (17760259 at 17:15:24Z regressed to 16777415 at
    // 19:51:55Z). Asserted as a FIRST-CLASS case: the migration seeds
    // whatever scalar is actually stored (16777415, the regressed value),
    // truthfully ("this one id was seen"), and does NOT attempt to
    // reconstruct that 17760259 was "really" the high-water mark — an id
    // AT or BELOW 16777415 that was never itself recorded re-delivers,
    // exactly like the case above; this test's job is narrower: prove the
    // adapter does not choke on, special-case, or silently prefer a
    // "larger" stored value it has no way to know ever existed.
    test("a REGRESSED stored scalar (a real historical id lower than a comment the project already acted on) is seeded as-is, no reconstruction attempted", async () => {
      const w = fakeWorld({
        myAccountId: "acct-A",
        projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
        properties: { ACME: { ...PROPERTY_A, wake: { version: 5, comment: "16777415", epics: {} } } },
        pageVersions: { "doc-A": 5 },
        pageComments: { "doc-A": [{ id: "16777415", body: "" }] },
      });
      const [acme] = await createProjectResourceType(w.deps).discovery.search();
      // The migration is truthful about exactly what was stored — it does
      // not "know" 17760259 ever existed, and must not invent it.
      expect(acme!.watermark.commentsSeen).toEqual(["16777415"]);
      expect(projectVerdict(acme!)).toBe("asleep"); // the one id it DOES know about is caught up
    });

    test("once `commentsSeen` exists (even empty), the legacy `comment` scalar is NEVER consulted again", async () => {
      const w = fakeWorld({
        myAccountId: "acct-A",
        projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
        // Both fields present, deliberately disagreeing — commentsSeen (the
        // new shape) must win outright, not merge with the legacy scalar.
        properties: { ACME: { ...PROPERTY_A, wake: { version: 5, comment: "999", commentsSeen: [], epics: {} } } },
        pageVersions: { "doc-A": 5 },
        pageComments: { "doc-A": [{ id: "999", body: "" }] },
      });
      const [acme] = await createProjectResourceType(w.deps).discovery.search();
      expect(acme!.watermark.commentsSeen).toEqual([]); // NOT ["999"] — the legacy scalar was not consulted
      expect(projectVerdict(acme!)).toBe("active");
    });

    test("a legacy per-epic scalar map migrates each entry to a one-member set", async () => {
      const w = fakeWorld({
        myAccountId: "acct-A",
        projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
        properties: { ACME: { ...PROPERTY_A, wake: { version: 5, comment: null, epics: { "ACME-1": "50", "ACME-2": null } } } },
        pageVersions: { "doc-A": 5 },
        epicsInReview: [
          { key: "ACME-1", summary: "e1", status: "In Review", issuetype: "Epic", assignee: null, parent: null, updated: "", labels: [] },
        ],
        epicComments: { "ACME-1": [{ id: "50" }, { id: "51" }] },
      });
      const [acme] = await createProjectResourceType(w.deps).discovery.search();
      expect(acme!.watermark.epicsSeen).toEqual({ "ACME-1": ["50"], "ACME-2": [] });
      expect(acme!.unseenEpicCommentIds["ACME-1"]).toEqual(["51"]);
      expect(projectVerdict(acme!)).toBe("active");
    });

    // THE THREE NAMED STORED-VALUE CASES (BUTCHR-199's correction): the
    // adapter must treat a legacy scalar identically regardless of WHY it
    // ended up where it is — never deriving special-case logic from the
    // scalar's numeric relationship to other ids. Named individually so a
    // reader (and BUTCHR-201) can check each is actually covered, not
    // merely implied by the others.

    // CASE 1 — THE RATCHET/CEILING: a stored scalar pinned at the page's
    // historical MAXIMUM, with a real population of never-seen comments
    // beneath it (BUTCHR-199's own replay: 17 comments, only 6 ever seen,
    // ceiling `18153493`). Failure condition: any comment beneath the
    // ceiling numerically LOWER than it, but never itself recorded, coming
    // back as "seen" — that would mean the adapter is reading the scalar as
    // a threshold rather than as one truthfully-seen id.
    test("CASE 1 (the ratchet): a stored scalar AT the page's historical maximum still leaves every OTHER never-seen id (even lower ones) unseen — the ceiling is not inherited as a threshold", async () => {
      const w = fakeWorld({
        myAccountId: "acct-A",
        projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
        properties: { ACME: { ...PROPERTY_A, wake: { version: 5, comment: "18153493", epics: {} } } }, // the true ceiling, per BUTCHR-199's replay
        pageVersions: { "doc-A": 5 },
        // A handful of the population the replay found beneath the ceiling,
        // never previously recorded — real measured pairs.
        pageComments: {
          "doc-A": [
            { id: "18153493", body: "" }, // the ceiling itself — already seen
            { id: "17334528", body: "" }, // beneath it, never seen
            { id: "17367180", body: "" }, // beneath it, never seen
            { id: "16580758", body: "" }, // far beneath it, never seen
          ],
        },
      });
      const [acme] = await createProjectResourceType(w.deps).discovery.search();
      expect(acme!.watermark.commentsSeen).toEqual(["18153493"]); // seeded truthfully, not as a range
      expect(new Set(acme!.unseenCommentIds)).toEqual(new Set(["17334528", "17367180", "16580758"])); // the whole population beneath surfaces
      expect(projectVerdict(acme!)).toBe("active");
    });

    // CASE 2 — THE REGRESSED VALUE: covered above ("a REGRESSED stored
    // scalar... is seeded as-is"). Named here for the record so all three
    // cases are enumerable from one place, per BUTCHR-199's correction.

    // CASE 3 — CORRECT-BY-CREATION-TIME AND STILL LOSES: a stored scalar
    // that WAS the genuinely newest comment at the moment it was written
    // (no defect at write time), but a comment that already existed
    // earlier — chronologically OLDER, numerically HIGHER — is read for the
    // first time afterward (e.g. discovery's page window shifts to include
    // it). Under the OLD max-reduce design this could either wake the
    // project correctly OR pin it active depending on timing; under the
    // seen-set it is simply "an id not yet in the set", regardless of the
    // stored scalar's own history. Failure condition: this test is really
    // no different in shape from CASE 1/the basic migration test — which is
    // exactly BUTCHR-199's point: the adapter must not need a special case
    // for "the stored value used to be correct" at all.
    test("CASE 3 (correct-by-creation-time, still loses under the old rule): an older, higher-id comment appearing for the first time is unseen regardless of the stored scalar's own history — no special-casing needed", async () => {
      const w = fakeWorld({
        myAccountId: "acct-A",
        projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
        // This scalar WAS the true newest at write time — nothing wrong
        // with it when it was written.
        properties: { ACME: { ...PROPERTY_A, wake: { version: 5, comment: "17334328", epics: {} } } },
        pageVersions: { "doc-A": 5 },
        // An OLDER, higher-id comment (real measured pair: created
        // 14:58:30.387Z, 24s AFTER 17334328, but this fixture models the
        // inverse relationship — an EARLIER, higher-id comment surfacing
        // later) is now part of the observed read for the first time.
        pageComments: { "doc-A": [{ id: "17334328", body: "" }, { id: "17760259", body: "" }] },
      });
      const [acme] = await createProjectResourceType(w.deps).discovery.search();
      expect(acme!.watermark.commentsSeen).toEqual(["17334328"]); // the adapter does not need to know this scalar's history
      expect(acme!.unseenCommentIds).toEqual(["17760259"]); // simply not yet in the set
      expect(projectVerdict(acme!)).toBe("active");
    });
  });
});

// THE LOOP-VS-BATCH FALSIFIER (BUTCHR-208, via BUTCHR-195/BUTCHR-199's
// correction): "if check_in under the set records anything less than EVERY
// observed id — a max, a subset, only the ids that woke the project — the
// unrecorded remainder stays unseen and re-delivers on the next poll, and
// the migration becomes a LOOP rather than a BATCH". A named deliverable
// with its own test, per that correction, exercised end-to-end: discovery
// observes a batch of never-seen comments, a check_in-shaped
// `advanceProjectWatermark` call records what it saw, and the VERY NEXT
// discovery poll (no second check_in) must be fully caught up — one cycle,
// not several.
describe("THE LOOP-VS-BATCH FALSIFIER: check_in must converge in ONE cycle, recording EVERY observed id — a max or a subset would re-deliver the remainder next poll", () => {
  // Failure condition, stated first: after ONE discover -> advance(all
  // observed) -> discover round trip, ANY previously-observed id still
  // appearing in `unseenCommentIds`/`unseenEpicCommentIds`, or the verdict
  // still reading `"active"`, means the write recorded less than the full
  // batch — a loop, not a batch, and this epic's own defect wearing the fix's
  // clothes.
  test("root-doc axis: five never-seen comments (including a real inversion pair) all converge to seen after ONE check_in-shaped advance — not just the ones that would have woken a max-reduce", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
      properties: { ACME: PROPERTY_A }, // brand new, nothing seen yet
      pageVersions: { "doc-A": 1 },
      // Five ids, deliberately NOT in numeric order, including the sharpest
      // real measured inversion (18153493 created before, 17334528 after —
      // see this file's own top comment).
      pageComments: { "doc-A": [{ id: "18153493", body: "" }, { id: "17334528", body: "" }, { id: "100", body: "" }, { id: "999999999", body: "" }, { id: "1", body: "" }] },
    });

    // Cycle 1: discover (everything unseen) -> a check_in-shaped advance
    // recording the FULL observed set, exactly as src/tools/defs.ts's
    // check_in does (`seenComments: comments.results.map(c => c.id)`).
    const [before] = await createProjectResourceType(w.deps).discovery.search();
    expect(before!.unseenCommentIds.length).toBe(5); // sanity: nothing seen yet
    await advanceProjectWatermark(w.ops, "ACME", { version: before!.observedVersion!, seenComments: before!.observedCommentIds });

    // Cycle 2: NO second check_in — this is the falsifier's exact shape.
    const [after] = await createProjectResourceType(w.deps).discovery.search();
    expect(after!.unseenCommentIds).toEqual([]); // every one of the five, not just a "newest"
    expect(projectVerdict(after!)).toBe("asleep");
  });

  test("epics axis: the same convergence-in-one-cycle property, for an in-review epic's comment set", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
      properties: { ACME: PROPERTY_A },
      pageVersions: { "doc-A": 1 },
      epicsInReview: [{ key: "ACME-1", summary: "e", status: "In Review", issuetype: "Epic", assignee: null, parent: null, updated: "", labels: [] }],
      epicComments: { "ACME-1": [{ id: "999" }, { id: "1" }, { id: "500" }] },
    });
    const [before] = await createProjectResourceType(w.deps).discovery.search();
    expect(before!.unseenEpicCommentIds["ACME-1"]!.length).toBe(3);
    await advanceProjectWatermark(w.ops, "ACME", { version: before!.observedVersion!, epics: { "ACME-1": before!.observedEpics[0]!.commentIds } });

    const [after] = await createProjectResourceType(w.deps).discovery.search();
    expect(after!.unseenEpicCommentIds["ACME-1"]).toEqual([]);
    expect(projectVerdict(after!)).toBe("asleep");
  });
});

describe("eventRules.poll — the nudge path for an already-awake agent", () => {
  test("changedPrimary is empty when nothing observed differs between polls", async () => {
    const rules = createProjectEventRules();
    const p = project();
    const poll = await rules.poll({ primary: [p], related: [] }, { primary: [p], related: [] });
    expect(poll.changedPrimary).toEqual([]);
  });

  test("changedPrimary includes a key whose observed version/comment/epics differ from the previous poll", async () => {
    const rules = createProjectEventRules();
    const before = project({ observedVersion: 5 });
    const after = project({ observedVersion: 6 });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    expect(poll.changedPrimary).toEqual(["ACME"]);
  });

  // BUTCHR-227 DoD item ("a set comparison that silently degrades to
  // reference equality is a live defect — cover it"): `getPageComments`
  // requests no `sort`, so the SAME underlying comments can come back in a
  // DIFFERENT array order across two polls with nothing having actually
  // changed. Failure condition: `changedPrimary` including "ACME" here
  // means `changed()` is comparing array order/identity, not set
  // membership — a spurious nudge on every such poll.
  test("BUTCHR-227: the SAME comment ids in a DIFFERENT array order do NOT count as changed (set, not array-order, comparison)", async () => {
    const rules = createProjectEventRules();
    const before = project({ observedCommentIds: ["100", "101", "102"] });
    const reordered = project({ observedCommentIds: ["102", "100", "101"] });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [reordered], related: [] });
    expect(poll.changedPrimary).toEqual([]);
  });

  test("BUTCHR-227: the same epic comment ids in a different order do NOT count as changed either", async () => {
    const rules = createProjectEventRules();
    const before = project({ observedEpics: [{ key: "ACME-1", commentIds: ["1", "2"] }] });
    const reordered = project({ observedEpics: [{ key: "ACME-1", commentIds: ["2", "1"] }] });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [reordered], related: [] });
    expect(poll.changedPrimary).toEqual([]);
  });

  test("decide() delivers only when the CURRENT (next) state is genuinely behind its watermark", async () => {
    const rules = createProjectEventRules();
    const behind = project({ observedVersion: 6 }); // watermark still at 5
    const poll = await rules.poll({ primary: [project()], related: [] }, { primary: [behind], related: [] });
    const verdict = await poll.decide("ACME", "ACME", "primary");
    expect(verdict.deliver).toBe(true);
  });

  // HAZARD 1's second layer: even though the observed comment set genuinely
  // changed since the previous poll (so changedPrimary fires), decide()
  // must SUPPRESS it once the watermark has caught up to that exact id —
  // exactly the state speak.ts's watermark-advance produces for a project's
  // own comment. Failure condition: deliver:true here means the nudge path
  // re-notifies a project about its own report_to_boss call.
  test("HAZARD 1: a comment change that is ALREADY watermarked (own write) is suppressed on the nudge path too", async () => {
    const rules = createProjectEventRules();
    const before = project({ observedCommentIds: ["100"], watermark: { version: 5, commentsSeen: ["100"], epicsSeen: {} } });
    const selfWritten = project({ observedCommentIds: ["100", "101"], watermark: { version: 5, commentsSeen: ["100", "101"], epicsSeen: {} } });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [selfWritten], related: [] });
    expect(poll.changedPrimary).toEqual(["ACME"]); // structurally changed...
    const verdict = await poll.decide("ACME", "ACME", "primary");
    expect(verdict.deliver).toBe(false); // ...but suppressed, watermark already caught up
  });

  test("a FOREIGN comment (watermark still behind) still delivers on the nudge path", async () => {
    const rules = createProjectEventRules();
    const before = project({ observedCommentIds: ["100"], watermark: { version: 5, commentsSeen: ["100"], epicsSeen: {} } });
    const foreign = project({ observedCommentIds: ["100", "102"], watermark: { version: 5, commentsSeen: ["100"], epicsSeen: {} } });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [foreign], related: [] });
    const verdict = await poll.decide("ACME", "ACME", "primary");
    expect(verdict.deliver).toBe(true);
  });

  test("decide() on a key not present in the next snapshot delivers false rather than throwing", async () => {
    const rules = createProjectEventRules();
    const poll = await rules.poll({ primary: [project()], related: [] }, { primary: [], related: [] });
    const verdict = await poll.decide("ACME", "ACME", "primary");
    expect(verdict.deliver).toBe(false);
  });

  test("changedRelated is always empty — projects have no related/Implements-chain concept", async () => {
    const rules = createProjectEventRules();
    const poll = await rules.poll({ primary: [], related: [] }, { primary: [], related: [] });
    expect(poll.changedRelated).toEqual([]);
  });
});

describe("advanceProjectWatermark — union semantics (BUTCHR-227)", () => {
  test("merges only the wake sub-key, leaving the rest of the butchr property (space/rootDoc/repos/...) untouched", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { space: { key: "S" }, rootDoc: { id: "doc-A" }, repos: ["org/repo"], archiveProject: "KAN" } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { version: 7 });
    const prop = w.properties.get("ACME")!;
    expect(prop.space).toEqual({ key: "S" });
    expect(prop.rootDoc).toEqual({ id: "doc-A" });
    expect(prop.repos).toEqual(["org/repo"]);
    expect(prop.archiveProject).toBe("KAN");
    expect(prop.wake).toEqual({ version: 7, commentsSeen: [], epicsSeen: {} });
  });

  // THE CORE CLAIM: a union, never a replace — advancing with a NEW id
  // must ADD to whatever was already seen, not overwrite it away.
  test("seenComments UNIONS into the stored set — an id from a PRIOR advance is still present after a later one", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 7, commentsSeen: ["100"], epicsSeen: {} } } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { seenComments: ["101"] });
    expect(new Set((w.properties.get("ACME")!.wake as { commentsSeen: string[] }).commentsSeen)).toEqual(new Set(["100", "101"]));
  });

  // THE UNREPRESENTABILITY CLAIM (BUTCHR-227 DoD item 2 — regression is
  // UNREPRESENTABLE, not merely forbidden): passing a LOWER id than one
  // already seen must be unable to remove the higher one — there is no
  // patch shape that regresses the set, because union can only grow it.
  // This is writer B's exact real-world shape: it always passes exactly
  // ONE freshly-posted id, which is precisely the case a scalar overwrite
  // handled wrong.
  test("advancing with a NUMERICALLY LOWER id than one already seen does not remove the higher one — regression is unrepresentable", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 7, commentsSeen: ["18153493"], epicsSeen: {} } } },
    });
    // The real measured inversion: writer B posts a genuinely NEW comment
    // that happens to draw a lower id than one already seen.
    await advanceProjectWatermark(w.ops, "ACME", { seenComments: ["17334528"] });
    expect(new Set((w.properties.get("ACME")!.wake as { commentsSeen: string[] }).commentsSeen)).toEqual(new Set(["18153493", "17334528"]));
  });

  // The migration composes correctly with the writer: a project whose ONLY
  // stored state is the legacy scalar must not lose that seen id when the
  // first post-migration write happens — see `normalizeWake`'s own doc
  // comment for why the writer's union base must be the MIGRATED value,
  // never the raw stored JSON.
  test("a writer's union runs against the MIGRATED value — a legacy `comment` scalar's id survives the first post-migration advance", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 7, comment: "18153493", epics: {} } } }, // legacy shape only
    });
    await advanceProjectWatermark(w.ops, "ACME", { seenComments: ["17334528"] });
    const commentsSeen = (w.properties.get("ACME")!.wake as { commentsSeen: string[] }).commentsSeen;
    expect(new Set(commentsSeen)).toEqual(new Set(["18153493", "17334528"])); // NOT just ["17334528"] — the legacy id must not be dropped
  });

  // THE LEGACY SCALAR IS NEVER DELETED (BUTCHR-227 DoD item 1: "forensic
  // evidence of the regression"). Failure condition: `comment`/`epics`
  // missing from the stored property after ANY advance — this ticket's
  // migration depends on that field surviving indefinitely.
  test("the legacy `comment`/`epics` scalar fields are preserved byte-for-byte across a write, never deleted", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 7, comment: "16777415", epics: { "ACME-1": "50" } } } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { seenComments: ["999"] });
    const wake = w.properties.get("ACME")!.wake as { comment: string; epics: Record<string, string> };
    expect(wake.comment).toBe("16777415"); // untouched, forensic
    expect(wake.epics).toEqual({ "ACME-1": "50" }); // untouched, forensic
  });

  // BUTCHR-227 §6/DoD #9: THE CEILING ASSERTS, IT DOES NOT MERELY CLAIM.
  // Failure condition, stated first: a write whose serialized property
  // exceeds `PROJECT_PROPERTY_SIZE_CEILING_BYTES` must REJECT rather than
  // silently reach `setProjectProperty` — proven here two ways: the promise
  // rejects, AND the property on the server is left untouched (the write
  // never happened), the same "not merely rejects" discipline this file
  // already applies to the non-404 read-failure test above.
  test("BUTCHR-227: a write whose serialized property would exceed the stated size ceiling REJECTS rather than silently writing an oversized property", async () => {
    const existing = { ...PROPERTY_A, wake: { version: 1, commentsSeen: [], epicsSeen: {} } };
    const w = fakeWorld({ myAccountId: "acct-A", projects: [], properties: { ACME: existing } });
    // One id string is ~11 bytes serialized; comfortably over 32768 bytes
    // needs on the order of 3,000+ entries — generated, not hand-typed.
    const tooManyIds = Array.from({ length: 4000 }, (_, i) => String(20000000 + i));
    await expect(advanceProjectWatermark(w.ops, "ACME", { seenComments: tooManyIds })).rejects.toThrow(/ceiling/);
    expect(w.properties.get("ACME")).toEqual(existing); // the write never happened
  });

  // The control half: a write comfortably UNDER the ceiling must succeed
  // normally — this is not a blanket rejection, only an oversized one.
  test("BUTCHR-227: a normally-sized write is unaffected by the ceiling assertion", async () => {
    const w = fakeWorld({ myAccountId: "acct-A", projects: [], properties: { ACME: PROPERTY_A } });
    await advanceProjectWatermark(w.ops, "ACME", { seenComments: ["100", "101"] });
    expect((w.properties.get("ACME")!.wake as { commentsSeen: string[] }).commentsSeen).toEqual(["100", "101"]);
  });

  // BUTCHR-81 (found at review), preserved under the seen-set: `epics`,
  // when provided, REPLACES the whole KEY SET rather than merging — this is
  // the actual fix for rule 3's re-entry defect (see this file's own
  // regression test above and `ProjectWatermark.epicsSeen`'s doc comment).
  // A KEY not included in a given `epics` patch is therefore DROPPED.
  test("advancing epic watermarks REPLACES the whole epicsSeen KEY SET — a key omitted from the patch is dropped, not preserved", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 1, commentsSeen: [], epicsSeen: { "ACME-1": ["10"] } } } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { epics: { "ACME-2": ["20"], "ACME-3": ["30"] } });
    expect((w.properties.get("ACME")!.wake as { epicsSeen: unknown }).epicsSeen).toEqual({
      "ACME-2": ["20"],
      "ACME-3": ["30"], // ACME-1 dropped — it was not in this check-in's observed set
    });
  });

  // Per-key VALUE union (distinct from the key-set replace above): a key
  // present in BOTH the stored map and the patch must union its values,
  // never replace them — this matters because `getIssueComments` is
  // capped, so a replace could drop an id a truncated read simply missed
  // this particular poll even though an earlier poll genuinely saw it.
  test("a KEY present in both the stored epicsSeen map and the patch UNIONS its values, never replaces them", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 1, commentsSeen: [], epicsSeen: { "ACME-1": ["10", "11"] } } } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { epics: { "ACME-1": ["12"] } }); // a truncated read this poll only saw "12"
    expect(new Set((w.properties.get("ACME")!.wake as { epicsSeen: Record<string, string[]> }).epicsSeen["ACME-1"])).toEqual(new Set(["10", "11", "12"]));
  });

  test("an EMPTY epics patch ({}) clears every previously-recorded epic KEY — exactly what a check-in with nothing currently in review must do", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 1, commentsSeen: [], epicsSeen: { "ACME-1": ["10"], "ACME-2": ["20"] } } } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { epics: {} });
    expect((w.properties.get("ACME")!.wake as { epicsSeen: unknown }).epicsSeen).toEqual({});
  });

  test("omitting `epics` entirely (a version- or comment-only advance) leaves the existing map untouched", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 1, commentsSeen: [], epicsSeen: { "ACME-1": ["10"] } } } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { version: 2 });
    const wake = w.properties.get("ACME")!.wake as { version: number; epicsSeen: unknown };
    expect(wake.version).toBe(2);
    expect(wake.epicsSeen).toEqual({ "ACME-1": ["10"] });
  });

  // BUTCHR-105 negative control (acceptance criterion 2): the genuine-404
  // case the fail-open was there to serve must still work after the fix —
  // do not fix the hazard by breaking the case it was meant to handle.
  // Failure condition: this rejecting, or the write not happening at all,
  // means the fix broke genuine first-ever-checkin absence.
  test("no prior butchr property at all (genuine 404) -> starts from an empty base rather than throwing", async () => {
    const w = fakeWorld({ myAccountId: "acct-A", projects: [], properties: { ACME: undefined } });
    await advanceProjectWatermark(w.ops, "ACME", { version: 1 });
    expect(w.properties.get("ACME")!.wake).toEqual({ version: 1, commentsSeen: [], epicsSeen: {} });
  });

  // BUTCHR-105 acceptance criterion 1. Failure condition, stated before this
  // is ever run: against the UNFIXED code (`getProjectProperty(...).catch(()
  // => undefined) ?? {}`), a non-404 read failure is indistinguishable from a
  // genuine absence — the call would resolve successfully AND the property
  // already on the server (rootDoc/space/repos/archiveProject/scaffolded)
  // would be overwritten with a wake-only object, i.e. `w.properties.get(
  // "ACME")` would come back EQUAL to `{ wake: { version: 1, ... } }`, losing
  // everything else. This test fails against that code two ways: the
  // rejection assertion fails (nothing is thrown), and even if it were
  // loosened, the property-untouched assertion below would catch the
  // overwrite. It must pass only against a fix that refuses to write when
  // the read fails for an unknown reason.
  test("a non-404 read failure (rate limit / timeout / permission change) must NOT become the base of the replace: the call rejects and the existing property is left completely untouched", async () => {
    const existing = { space: { key: "S" }, rootDoc: { id: "doc-A" }, repos: ["org/repo"], archiveProject: "KAN", scaffolded: true, wake: { version: 5, commentsSeen: ["100"], epicsSeen: {} } };
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: existing },
      propertyFailures: { ACME: new Error("503 Service Unavailable (simulated transient failure)") },
    });
    await expect(advanceProjectWatermark(w.ops, "ACME", { version: 6 })).rejects.toThrow(/503/);
    // Not merely "rejects" — the property on the server must be BYTE-FOR-BYTE
    // what it was before the call: `rootDoc` is not reconstructible from
    // anything else in the system, so an overwrite here is the actual data
    // loss this ticket exists to prevent, not just a rejected promise.
    expect(w.properties.get("ACME")).toEqual(existing);
  });
});
