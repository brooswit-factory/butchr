import { describe, expect, test, beforeEach } from "bun:test";
import {
  advanceProjectWatermark,
  createProjectEventRules,
  createProjectResourceType,
  projectIdOf,
  projectVerdict,
  resetPendingWatermarkFallbackForTests,
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

// BUTCHR-214/226: `pendingWatermarkFallback` (src/resources/project.ts) is
// process-lifetime state shared across every test in this process, and this
// file reuses project key "ACME" across many describe blocks — reset it
// before each test so one test's failed-write fallback can never leak into
// another's assertions (in particular the pre-existing "no wake watermark
// recorded yet" test below, which asserts a clean null watermark for ACME).
beforeEach(() => resetPendingWatermarkFallbackForTests());

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
    expect(projectVerdict(project({ observedEpics: [{ key: "ACME-1", newestCommentId: null }] }))).toBe("active");
  });

  test("an epic already watermarked, no new comment since -> asleep", () => {
    expect(
      projectVerdict(
        project({
          observedEpics: [{ key: "ACME-1", newestCommentId: "50" }],
          watermark: { version: 5, comment: "100", epics: { "ACME-1": "50" } },
        }),
      ),
    ).toBe("asleep");
  });

  test("an epic's newest comment moved past its watermark -> active", () => {
    expect(
      projectVerdict(
        project({
          observedEpics: [{ key: "ACME-1", newestCommentId: "51" }],
          watermark: { version: 5, comment: "100", epics: { "ACME-1": "50" } },
        }),
      ),
    ).toBe("active");
  });

  // BUTCHR-81 DEFECT #1a (found at review): a per-epic watermark keyed by
  // comment id alone, MERGED (never pruned), cannot detect an epic
  // RE-ENTERING review with no new comment (submit_to_boss transitions
  // status; it does not necessarily comment) — a stale map entry from the
  // epic's PRIOR review episode compares equal to the still-unchanged
  // "newest comment id" and the project wrongly stays asleep.
  //
  // DEFECT #1b (found at review, one level deeper): the first fix attempted
  // — watermarking `updated` instead of a comment id — was itself wrong,
  // because this daemon's OWN `agent:*`/`pr:*` label sync bumps `updated`
  // on every label write (MEASURED live, BUTCHR-81 2026-09-01: a plain
  // label add with no comment moved `updated`; a real in-review ticket's
  // label-change history showed 8 changes in 17 minutes, `updated` matching
  // the last one exactly) — faster than this story's 5-minute poll
  // interval, so an `updated`-keyed watermark is behind on EVERY poll for
  // as long as anything sits in review. Comment-id is immune to this.
  //
  // THE ACTUAL FIX: comment-id stays the compared VALUE (immune to label
  // churn), and re-entry is caught by PRUNING on the WRITE side —
  // `advanceProjectWatermark`'s `epics` patch REPLACES the whole map
  // (see its own doc comment) rather than merging, so an epic that has
  // left review is absent from the next replacement and re-entry is
  // detected by absence again. This test proves that replace-based prune,
  // not `projectVerdict` alone (which cannot see "did this get pruned" —
  // that is the WRITE side's job): failure condition, written first — the
  // full sequence (enter -> act/watermark -> leave -> re-enter with no new
  // comment) must end with `projectVerdict` returning `active`.
  test("BUTCHR-81 regression: an epic that leaves review and RE-ENTERS with no new comment still wakes the project, via prune-on-checkin", async () => {
    const w = fakeWorld({ myAccountId: "acct-A", projects: [], properties: { ACME: { ...PROPERTY_A, wake: { version: 5, comment: "100", epics: { "ACME-1": "50" } } } } });
    // Episode 1 already watermarked at comment "50" (above). The epic then
    // LEFT review — a real check_in-shaped call observes zero epics in
    // review right now and REPLACES the map with {} (pruning ACME-1).
    await advanceProjectWatermark(w.ops, "ACME", { epics: {} });
    expect(w.properties.get("ACME")!.wake).toEqual({ version: 5, comment: "100", epics: {} });
    // Episode 2: the epic RE-ENTERS review with NO new comment (still "50").
    const reenteredWithNoComment = project({
      watermark: (w.properties.get("ACME")!.wake as any),
      observedEpics: [{ key: "ACME-1", newestCommentId: "50" }],
    });
    expect(projectVerdict(reenteredWithNoComment)).toBe("active"); // absent from the pruned map -> behind
  });

  test("a never-recorded (null) watermark with something observed -> active (fail-open, matches the issue tier's baseline philosophy)", () => {
    expect(projectVerdict(project({ watermark: { version: null, comment: "100", epics: {} } }))).toBe("active");
  });

  test("nothing observed yet (nulls) and no watermark -> asleep, not active on absence alone", () => {
    expect(projectVerdict(project({ observedVersion: null, observedCommentId: null, watermark: { version: null, comment: null, epics: {} } }))).toBe("asleep");
  });
});

/** Every AtlassianOps member `advanceProjectWatermark` never calls, throwing loudly if it ever does — a call reaching one here is a test bug, not a passing behaviour. Local to this describe block: `fakeWorld` below already has its own, differently-shaped `unimplemented`, and this block needs direct control over `setProjectProperty`'s success/failure that `fakeWorld` doesn't expose. */
function unimplementedProjectOps(overrides: Partial<AtlassianOps> = {}): AtlassianOps {
  const unimplemented = (name: string) => async (..._a: unknown[]) => {
    throw new Error(`fake ops: ${name} not used by this test`);
  };
  return {
    getIssue: unimplemented("getIssue"), search: unimplemented("search"), addComment: unimplemented("addComment"),
    linkIssues: unimplemented("linkIssues"), transition: unimplemented("transition"), createIssue: unimplemented("createIssue"),
    setPriority: unimplemented("setPriority"), assign: unimplemented("assign"), correctText: unimplemented("correctText"),
    createPage: unimplemented("createPage"), getPage: unimplemented("getPage"), updatePage: unimplemented("updatePage") as unknown as AtlassianOps["updatePage"],
    searchPages: unimplemented("searchPages"), listSpaces: unimplemented("listSpaces"),
    getProjectProperty: unimplemented("getProjectProperty"), getProjectPropertyOrNull: unimplemented("getProjectPropertyOrNull"),
    getRemoteLink: unimplemented("getRemoteLink"), upsertRemoteLink: unimplemented("upsertRemoteLink"),
    getChildPages: unimplemented("getChildPages") as unknown as AtlassianOps["getChildPages"],
    getPageLabels: unimplemented("getPageLabels") as unknown as AtlassianOps["getPageLabels"],
    createPageWithLabel: unimplemented("createPageWithLabel") as unknown as AtlassianOps["createPageWithLabel"],
    addLabels: unimplemented("addLabels"), removeLabels: unimplemented("removeLabels"), deleteIssue: unimplemented("deleteIssue"),
    commentOnPage: unimplemented("commentOnPage"), getPageComments: unimplemented("getPageComments") as unknown as AtlassianOps["getPageComments"],
    searchProjects: unimplemented("searchProjects") as unknown as AtlassianOps["searchProjects"],
    getMyself: unimplemented("getMyself") as unknown as AtlassianOps["getMyself"],
    setProjectProperty: unimplemented("setProjectProperty"),
    getPageVersions: unimplemented("getPageVersions") as unknown as AtlassianOps["getPageVersions"],
    getIssueComments: unimplemented("getIssueComments") as unknown as AtlassianOps["getIssueComments"],
    ...overrides,
  };
}

/** A minimal, directly-controllable `properties` store for `advanceProjectWatermark` — `getProjectPropertyOrNull` reads it, `setProjectProperty` (optionally rejecting, per `opts.failWrite`) writes it. Separate from `fakeWorld` below because that helper doesn't expose a way to make `setProjectProperty` itself fail — only property READS. */
function watermarkWorld(initialWake?: Partial<{ version: number | null; comment: string | null; epics: Record<string, string | null> }>, opts: { failWrite?: boolean } = {}) {
  const properties = new Map<string, Record<string, unknown>>();
  if (initialWake) properties.set("ACME", { space: { key: "ACME" }, rootDoc: { id: "doc-A" }, wake: initialWake });
  const persistedWrites: unknown[] = [];
  const ops = unimplementedProjectOps({
    getProjectPropertyOrNull: async (key: string) => properties.get(key) ?? null,
    setProjectProperty: async (key: string, _propertyKey: string, value: unknown) => {
      if (opts.failWrite) throw new Error("simulated: setProjectProperty transiently unavailable");
      properties.set(key, value as Record<string, unknown>);
      persistedWrites.push(value);
      return { ok: true };
    },
  });
  return { ops, properties, persistedWrites };
}

describe("advanceProjectWatermark — the monotonic guard (BUTCHR-214/226, defect 1) and its in-process pending fallback (defect 1b)", () => {
  // Failure condition, this whole block: any test here that finds the
  // stored `comment`/`version` LOWER than an incoming value it should have
  // accepted (over-freezing) or HIGHER than the true numeric max after a
  // regressing incoming value (the guard removed) is this guard failing in
  // one direction or the other.

  test("a lower incoming comment id does not lower the stored watermark (fails if the guard is removed)", async () => {
    const w = watermarkWorld({ version: 1, comment: "500", epics: {} });
    await advanceProjectWatermark(w.ops, "ACME", { comment: "300" });
    expect((w.properties.get("ACME")!.wake as any).comment).toBe("500");
  });

  test("a higher incoming comment id still advances it (fails if the guard is over-applied into a freeze)", async () => {
    const w = watermarkWorld({ version: 1, comment: "500", epics: {} });
    await advanceProjectWatermark(w.ops, "ACME", { comment: "900" });
    expect((w.properties.get("ACME")!.wake as any).comment).toBe("900");
  });

  test("version axis: a lower incoming version does not lower the stored watermark; a higher one still advances", async () => {
    const w = watermarkWorld({ version: 10, comment: null, epics: {} });
    await advanceProjectWatermark(w.ops, "ACME", { version: 3 });
    expect((w.properties.get("ACME")!.wake as any).version).toBe(10);
    await advanceProjectWatermark(w.ops, "ACME", { version: 42 });
    expect((w.properties.get("ACME")!.wake as any).version).toBe(42);
  });

  test("a never-before-set watermark is still settable (absent means never-checked-in, not caught-up, so the FIRST write must not be refused)", async () => {
    const w = watermarkWorld(); // no property at all — genuine 404 base
    await advanceProjectWatermark(w.ops, "ACME", { version: 1, comment: "100" });
    expect(w.properties.get("ACME")!.wake).toEqual({ version: 1, comment: "100", epics: {} });
  });

  test("a corrupted (non-numeric) stored value does not become NaN and swallow a real write — treated as absent, not as smaller-than-everything", async () => {
    const w = watermarkWorld({ version: "not-a-number" as unknown as number, comment: "also-not-numeric" as unknown as string, epics: {} });
    await advanceProjectWatermark(w.ops, "ACME", { version: 5, comment: "500" });
    // Neither NaN (which would make every future comparison false and
    // permanently swallow real writes) nor a silent no-op (which would do
    // the same thing by a different route) — the incoming, trustworthy
    // value is accepted outright.
    expect((w.properties.get("ACME")!.wake as any).version).toBe(5);
    expect((w.properties.get("ACME")!.wake as any).comment).toBe("500");
  });

  test("the regression-to-wake chain, driven through the REAL predicate (not just the storage function): a would-be-regressing write does not make the project active on a stale comment", async () => {
    const w = watermarkWorld({ version: 1, comment: "500", epics: {} });
    // The exact shape a daemon complaint's own suppression write takes
    // (speakOnOwnChannel: `{ comment: <id the complaint itself just got> }`)
    // — here, a non-monotonic id lower than the true page max.
    await advanceProjectWatermark(w.ops, "ACME", { comment: "300" });
    const wake = w.properties.get("ACME")!.wake as { version: number | null; comment: string | null; epics: Record<string, string | null> };
    // The true numeric max on the page is still "500" — the complaint's own
    // lower id never became the newest observed comment.
    const resource = project({ watermark: wake, observedCommentId: "500", observedVersion: 1 });
    expect(projectVerdict(resource)).toBe("asleep"); // NOT active on the stale "500" it already handled
  });

  test("DEFECT 1b: a rejected persisted write is logged distinctly (not silent) and genuinely never lands", async () => {
    const w = watermarkWorld({ version: 1, comment: "500", epics: {} }, { failWrite: true });
    const lines: string[] = [];
    await expect(advanceProjectWatermark(w.ops, "ACME", { comment: "501" }, (l) => lines.push(l))).rejects.toThrow(/transiently unavailable/);
    expect(lines.some((l) => l.includes("DEFECT 1b"))).toBe(true);
    expect(w.persistedWrites.length).toBe(0); // the Jira/Confluence write genuinely never landed
    expect((w.properties.get("ACME")!.wake as any).comment).toBe("500"); // persisted value unchanged
    // The full end-to-end proof that the project does NOT read "active" on
    // this very failure — via the REAL discovery/predicate path, not a
    // reimplementation of the merge here — lives in
    // test/unit/project-self-wake-loop.test.ts's "F7" describe block.
  });

  test("DEFECT 1b: a LATER successful write (from any caller, e.g. check_in) absorbs what an earlier failed write could not persist", async () => {
    const w = watermarkWorld({ version: 1, comment: "500", epics: {} }, { failWrite: true });
    await advanceProjectWatermark(w.ops, "ACME", { comment: "501" }).catch(() => {}); // fails, held in-process only; persisted value stays "500"
    expect((w.properties.get("ACME")!.wake as any).comment).toBe("500");

    // A later write against the SAME project key succeeds this time (e.g.
    // the account's write permission was restored, or a retry succeeded) —
    // even though THIS write's own patch only knows about "500" (comment
    // "501" was never durably recorded, so a fresh check_in-style scan of
    // the page may not reflect it either), the still-pending in-process
    // fallback from the earlier failed attempt is merged in first. Reuses
    // `w`'s own `properties` map (this is one project's persisted state,
    // not two) with a write path that simply doesn't reject.
    const okOps = unimplementedProjectOps({
      getProjectPropertyOrNull: async (key: string) => w.properties.get(key) ?? null,
      setProjectProperty: async (key: string, _propertyKey: string, value: unknown) => {
        w.properties.set(key, value as Record<string, unknown>);
        w.persistedWrites.push(value);
        return { ok: true };
      },
    });
    await advanceProjectWatermark(okOps, "ACME", { comment: "500" });
    expect((w.properties.get("ACME")!.wake as any).comment).toBe("501"); // absorbed — not overwritten back down to "500"
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
  test("epics-in-review are grouped back to their own project by key prefix, and only in-review epics get a comments() call", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [{ key: "ACME", name: "Acme", leadAccountId: "acct-A" }],
      properties: { ACME: PROPERTY_A },
      pageVersions: { "doc-A": 1 },
      epicsInReview: [
        { key: "ACME-10", summary: "Epic 10", status: "In Review", issuetype: "Epic", assignee: null, parent: null, updated: "", labels: [] },
      ],
      epicComments: { "ACME-10": [{ id: "c1" }] },
    });
    const [acme] = await createProjectResourceType(w.deps).discovery.search();
    expect(acme!.observedEpics).toEqual([{ key: "ACME-10", newestCommentId: "c1" }]);
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

  // BUTCHR-81 (found at review): `epics`, when provided, REPLACES the whole
  // map rather than merging — this is the actual fix for rule 3's re-entry
  // defect (see this file's own regression test above and
  // ProjectWatermark.epics's doc comment). An epic NOT included in a given
  // `epics` patch is therefore DROPPED, not preserved.
  test("advancing epic watermarks REPLACES the whole epics map — an epic omitted from the patch is dropped, not preserved", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 1, comment: null, epics: { "ACME-1": "10" } } } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { epics: { "ACME-2": "20", "ACME-3": "30" } });
    expect(w.properties.get("ACME")!.wake).toEqual({
      version: 1,
      comment: null,
      epics: { "ACME-2": "20", "ACME-3": "30" }, // ACME-1 dropped — it was not in this check-in's observed set
    });
  });

  test("an EMPTY epics patch ({}) clears every previously-recorded epic — exactly what a check-in with nothing currently in review must do", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 1, comment: null, epics: { "ACME-1": "10", "ACME-2": "20" } } } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { epics: {} });
    expect(w.properties.get("ACME")!.wake).toEqual({ version: 1, comment: null, epics: {} });
  });

  test("omitting `epics` entirely (a version- or comment-only advance) leaves the existing map untouched", async () => {
    const w = fakeWorld({
      myAccountId: "acct-A",
      projects: [],
      properties: { ACME: { ...PROPERTY_A, wake: { version: 1, comment: null, epics: { "ACME-1": "10" } } } },
    });
    await advanceProjectWatermark(w.ops, "ACME", { version: 2 });
    expect(w.properties.get("ACME")!.wake).toEqual({ version: 2, comment: null, epics: { "ACME-1": "10" } });
  });

  // BUTCHR-105 negative control (acceptance criterion 2): the genuine-404
  // case the fail-open was there to serve must still work after the fix —
  // do not fix the hazard by breaking the case it was meant to handle.
  // Failure condition: this rejecting, or the write not happening at all,
  // means the fix broke genuine first-ever-checkin absence.
  test("no prior butchr property at all (genuine 404) -> starts from an empty base rather than throwing", async () => {
    const w = fakeWorld({ myAccountId: "acct-A", projects: [], properties: { ACME: undefined } });
    await advanceProjectWatermark(w.ops, "ACME", { version: 1 });
    expect(w.properties.get("ACME")!.wake).toEqual({ version: 1, comment: null, epics: {} });
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
    const existing = { space: { key: "S" }, rootDoc: { id: "doc-A" }, repos: ["org/repo"], archiveProject: "KAN", scaffolded: true, wake: { version: 5, comment: "100", epics: {} } };
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
