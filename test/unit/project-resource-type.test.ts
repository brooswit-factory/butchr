import { describe, expect, test } from "bun:test";
import {
  advanceProjectWatermark,
  createProjectEventRules,
  createProjectResourceType,
  projectIdOf,
  projectVerdict,
  PROJECT_ACTIVATION,
  PROJECT_SPAWN_CONFIG,
  type ProjectResource,
  type ProjectResourceDeps,
} from "../../src/resources/project.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

// BUTCHR-67/BUTCHR-81. Failure conditions are stated in each describe/test's
// own comment, per this ticket's evidence-discipline requirement — a check
// whose failure isn't stated first doesn't count as evidence.

function project(overrides: Partial<ProjectResource> = {}): ProjectResource {
  return {
    key: "ACME",
    name: "Acme",
    eligible: true,
    rootDocId: "1",
    observedVersion: 5,
    observedCommentId: "100",
    observedEpics: [],
    watermark: { version: 5, comment: "100", epics: {} },
    ...overrides,
  };
}

describe("projectVerdict — the pure activation/nudge predicate", () => {
  // Failure condition: any of these returning the wrong verdict means the
  // watermark comparison (or the eligibility short-circuit) is wrong.

  test("ineligible -> inactive, regardless of watermark state", () => {
    expect(projectVerdict(project({ eligible: false, observedVersion: 999, watermark: { version: 1, comment: null, epics: {} } }))).toBe("inactive");
  });

  test("eligible and every axis caught up -> asleep", () => {
    expect(projectVerdict(project())).toBe("asleep");
  });

  test("version behind, comment and epics caught up -> active (rules 1/2 are independent axes)", () => {
    expect(projectVerdict(project({ observedVersion: 6 }))).toBe("active");
  });

  test("comment behind, version and epics caught up -> active", () => {
    expect(projectVerdict(project({ observedCommentId: "101" }))).toBe("active");
  });

  test("an epic never before seen in review -> active (absent from watermark.epics == never acted on)", () => {
    expect(projectVerdict(project({ observedEpics: [{ key: "ACME-1", updated: "2026-01-01T00:00:00.000Z" }] }))).toBe("active");
  });

  test("an epic already watermarked at its current updated timestamp -> asleep", () => {
    expect(
      projectVerdict(
        project({
          observedEpics: [{ key: "ACME-1", updated: "2026-01-01T00:00:00.000Z" }],
          watermark: { version: 5, comment: "100", epics: { "ACME-1": "2026-01-01T00:00:00.000Z" } },
        }),
      ),
    ).toBe("asleep");
  });

  test("an epic's updated timestamp moved past its watermark -> active", () => {
    expect(
      projectVerdict(
        project({
          observedEpics: [{ key: "ACME-1", updated: "2026-01-02T00:00:00.000Z" }],
          watermark: { version: 5, comment: "100", epics: { "ACME-1": "2026-01-01T00:00:00.000Z" } },
        }),
      ),
    ).toBe("active");
  });

  // BUTCHR-81 DEFECT, FOUND AT REVIEW: a per-epic watermark keyed by comment
  // id alone cannot detect an epic RE-ENTERING review with no new comment
  // (submit_to_boss transitions status; it does not necessarily comment).
  // Failure condition, written first: an epic that enters review, is acted
  // on (watermarked), LEAVES review, and RE-ENTERS with NO new comment must
  // still produce "active" — because re-entry is itself a Jira `updated`
  // transition, strictly newer than whatever was watermarked during the
  // prior review episode. This is the test that would have failed against
  // the old newestCommentId-keyed design (where re-entry with no comment
  // left the watermark's stale comment id equal to the still-unchanged
  // "newest comment id", wrongly staying asleep).
  test("BUTCHR-81 regression: an epic that leaves review and RE-ENTERS with no new comment still wakes the project", () => {
    // Episode 1: watermarked while first in review, at updated=T2 (after the
    // project's own review comment bumped it past its entry time T1).
    const watermarkFromFirstEpisode = { version: 5, comment: "100", epics: { "ACME-1": "2026-01-01T00:00:00.000Z" /* T2 */ } };
    // Episode 2: epic left review (a transition, bumps updated to T3), then
    // re-entered review (another transition, bumps updated to T4) with NO
    // new comment posted in between. T4 > T2 unconditionally, since at least
    // two transitions happened after T2.
    const reenteredWithNoComment = project({
      observedEpics: [{ key: "ACME-1", updated: "2026-01-03T00:00:00.000Z" /* T4, strictly after T2 */ }],
      watermark: watermarkFromFirstEpisode,
    });
    expect(projectVerdict(reenteredWithNoComment)).toBe("active");
  });

  test("a never-recorded (null) watermark with something observed -> active (fail-open, matches the issue tier's baseline philosophy)", () => {
    expect(projectVerdict(project({ watermark: { version: null, comment: "100", epics: {} } }))).toBe("active");
  });

  test("nothing observed yet (nulls) and no watermark -> asleep, not active on absence alone", () => {
    expect(projectVerdict(project({ observedVersion: null, observedCommentId: null, watermark: { version: null, comment: null, epics: {} } }))).toBe("asleep");
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
  calls: { getPageVersions: string[][]; getPageComments: string[]; search: string[]; getProjectPropertyOrNull: string[] };
}

function fakeWorld(opts: {
  myAccountId: string;
  projects: Array<{ key: string; name: string; leadAccountId: string }>;
  properties: Record<string, Record<string, unknown> | undefined>; // undefined = genuine 404 (ineligible)
  propertyFailures?: Record<string, Error>; // a NON-404 failure — must propagate, never silently ineligible
  pageVersions?: Record<string, number>;
  pageComments?: Record<string, Array<{ id: string; body: string }>>;
  epicsInReview?: JiraIssue[];
}): FakeWorld {
  const properties = new Map(Object.entries(opts.properties).filter(([, v]) => v !== undefined) as [string, Record<string, unknown>][]);
  const calls = { getPageVersions: [] as string[][], getPageComments: [] as string[], search: [] as string[], getProjectPropertyOrNull: [] as string[] };

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
    commentOnPage: unimplemented("commentOnPage"),

    getMyself: async () => ({ accountId: opts.myAccountId }),
    searchProjects: async (_status) => ({
      values: opts.projects.map((p) => ({ key: p.key, name: p.name, lead: { accountId: p.leadAccountId } })),
    }),
    // Still throw-always, matching the real op's contract — used only by
    // advanceProjectWatermark's read-modify-write in these tests.
    getProjectProperty: async (key: string) => {
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
  };

  const deps: ProjectResourceDeps = {
    ops,
    search: async (jql: string) => {
      calls.search.push(jql);
      return opts.epicsInReview ?? [];
    },
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

describe("discovery — rule 3 grouping", () => {
  test("epics-in-review are grouped back to their own project by key prefix, carrying the epic's own `updated` field with no extra call", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
      properties: { ACME: PROPERTY_A },
      pageVersions: { "doc-A": 1 },
      epicsInReview: [
        { key: "ACME-10", summary: "Epic 10", status: "In Review", issuetype: "Epic", assignee: null, parent: null, updated: "2026-01-01T00:00:00.000Z", labels: [] },
      ],
    });
    const [acme] = await createProjectResourceType(w.deps).discovery.search();
    expect(acme!.observedEpics).toEqual([{ key: "ACME-10", updated: "2026-01-01T00:00:00.000Z" }]);
  });

  test("no epics in review -> observedEpics is empty", async () => {
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

describe("discovery — watermark round-trip", () => {
  test("an existing wake watermark on the butchr property is read into ProjectResource.watermark", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 4, comment: "99", epics: { "ACME-1": "2026-01-01T00:00:00.000Z" } } } },
      pageVersions: { "doc-A": 4 },
      pageComments: { "doc-A": [{ id: "99", body: "hi" }] },
    });
    const [acme] = await createProjectResourceType(w.deps).discovery.search();
    expect(acme!.watermark).toEqual({ version: 4, comment: "99", epics: { "ACME-1": "2026-01-01T00:00:00.000Z" } });
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
    expect(acme!.watermark).toEqual({ version: null, comment: null, epics: {} });
    expect(projectVerdict(acme!)).toBe("active");
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

  test("decide() delivers only when the CURRENT (next) state is genuinely behind its watermark", async () => {
    const rules = createProjectEventRules();
    const behind = project({ observedVersion: 6 }); // watermark still at 5
    const poll = await rules.poll({ primary: [project()], related: [] }, { primary: [behind], related: [] });
    const verdict = await poll.decide("ACME", "ACME", "primary");
    expect(verdict.deliver).toBe(true);
  });

  // HAZARD 1's second layer: even though observedCommentId genuinely
  // changed since the previous poll (so changedPrimary fires), decide()
  // must SUPPRESS it once the watermark has caught up to that exact id —
  // exactly the state speak.ts's watermark-advance produces for a project's
  // own comment. Failure condition: deliver:true here means the nudge path
  // re-notifies a project about its own report_to_boss call.
  test("HAZARD 1: a comment change that is ALREADY watermarked (own write) is suppressed on the nudge path too", async () => {
    const rules = createProjectEventRules();
    const before = project({ observedCommentId: "100", watermark: { version: 5, comment: "100", epics: {} } });
    const selfWritten = project({ observedCommentId: "101", watermark: { version: 5, comment: "101", epics: {} } });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [selfWritten], related: [] });
    expect(poll.changedPrimary).toEqual(["ACME"]); // structurally changed...
    const verdict = await poll.decide("ACME", "ACME", "primary");
    expect(verdict.deliver).toBe(false); // ...but suppressed, watermark already caught up
  });

  test("a FOREIGN comment (watermark still behind) still delivers on the nudge path", async () => {
    const rules = createProjectEventRules();
    const before = project({ observedCommentId: "100", watermark: { version: 5, comment: "100", epics: {} } });
    const foreign = project({ observedCommentId: "102", watermark: { version: 5, comment: "100", epics: {} } });
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

describe("advanceProjectWatermark", () => {
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
    expect(prop.wake).toEqual({ version: 7, comment: null, epics: {} });
  });

  test("advancing the comment watermark does not clobber an already-recorded version watermark", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 7, comment: null, epics: {} } } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { comment: "200" });
    expect(w.properties.get("ACME")!.wake).toEqual({ version: 7, comment: "200", epics: {} });
  });

  test("advancing epic watermarks merges into the epics map rather than replacing it, and can batch multiple epics in one call", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 1, comment: null, epics: { "ACME-1": "2026-01-01T00:00:00.000Z" } } } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { epics: { "ACME-2": "2026-01-02T00:00:00.000Z", "ACME-3": "2026-01-03T00:00:00.000Z" } });
    expect(w.properties.get("ACME")!.wake).toEqual({
      version: 1,
      comment: null,
      epics: { "ACME-1": "2026-01-01T00:00:00.000Z", "ACME-2": "2026-01-02T00:00:00.000Z", "ACME-3": "2026-01-03T00:00:00.000Z" },
    });
  });

  test("re-watermarking an epic already in the map OVERWRITES its entry (this is exactly how re-entry stays detectable next time)", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 1, comment: null, epics: { "ACME-1": "2026-01-01T00:00:00.000Z" } } } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { epics: { "ACME-1": "2026-01-05T00:00:00.000Z" } });
    expect(w.properties.get("ACME")!.wake).toEqual({ version: 1, comment: null, epics: { "ACME-1": "2026-01-05T00:00:00.000Z" } });
  });

  test("no prior butchr property at all -> starts from an empty base rather than throwing", async () => {
    const w = fakeWorld({ myAccountId: "acct-A", projects: [], properties: { ACME: undefined } });
    await advanceProjectWatermark(w.ops, "ACME", { version: 1 });
    expect(w.properties.get("ACME")!.wake).toEqual({ version: 1, comment: null, epics: {} });
  });
});
