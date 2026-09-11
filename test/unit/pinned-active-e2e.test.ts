import { describe, expect, test, beforeEach } from "bun:test";
import {
  createProjectResourceType,
  projectVerdict,
  resetPendingWatermarkFallbackForTests,
  type ProjectResourceDeps,
  type ProjectResource,
} from "../../src/resources/project.js";
import { desiredFrom, reconcileNow } from "../../src/daemon/loop.js";
import { speakOnOwnChannel, createOwnChannelComments } from "../../src/tools/speak.js";
import { createPinnedActiveDetector, MARKER } from "../../src/agents/pinned-active.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";
import type { Herd } from "../../src/agents/herd.js";

// BUTCHR-226: `pendingWatermarkFallback` (src/resources/project.ts) is
// process-lifetime state shared across every test in this process — reset it
// before each test, same discipline project-self-wake-loop.test.ts uses.
beforeEach(() => resetPendingWatermarkFallbackForTests());

const MIN = 60_000;

/**
 * BUTCHR-305/BUTCHR-238 — end-to-end reachability: the REAL `reconcileNow`
 * (src/daemon/loop.ts), the REAL `createPinnedActiveDetector`
 * (src/agents/pinned-active.ts), the REAL `speakOnOwnChannel`/
 * `createOwnChannelComments` write/read pair (src/tools/speak.ts), and the
 * REAL `createProjectResourceType`/`projectVerdict` (src/resources/project.ts)
 * — a fake ONLY at the I/O boundary: the Atlassian ops surface (`world()`,
 * same shape project-self-wake-loop.test.ts's own fixture uses, extended
 * here with `getPageComments`/`commentOnPage` bookkeeping already present
 * there) and the herd/agent-list (`fakeHerd` + a mutable `agentStatus` map,
 * standing in for `herdr.agent.list()`).
 */
function world(opts: {
  projectKey: string;
  rootDocId: string;
  initialComments?: Array<{ id: string; body: string }>;
  initialWake?: { version?: number | null; comment?: string | null; epics?: Record<string, string | null> };
  initialPageVersion?: number;
  /** Simulated clock, so a freshly-posted complaint's `created` lands in the SAME units this test's own `now` variable uses — required for the detector's episode-closure comparison (`closedBefore`) to mean anything. Defaults to real wall-clock time for tests that don't care. */
  now?: () => number;
}): { ops: AtlassianOps; deps: ProjectResourceDeps; pageComments: Array<{ id: string; body: string; created: string }> } {
  const now = opts.now ?? (() => Date.now());
  const pageComments: Array<{ id: string; body: string; created: string }> = (opts.initialComments ?? []).map((c) => ({ ...c, created: new Date(0).toISOString() }));
  let nextAutoId = 9000;
  let pageVersion = opts.initialPageVersion ?? 1;
  const properties = new Map<string, Record<string, unknown>>([
    [opts.projectKey, { space: { key: opts.projectKey }, rootDoc: { id: opts.rootDocId }, wake: opts.initialWake ?? {} }],
  ]);

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
    getPage: async (id: string) => ({ title: "root doc", body: { storage: { value: "<p>hi</p>" } }, _links: { base: "https://fake.atlassian.net/wiki", webui: `/pages/${id}` } }),
    updatePage: async (_p: unknown) => { pageVersion++; return { ok: true, version: pageVersion }; },
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
    getIssueComments: async () => { throw new Error("fake ops: a project id must never be read as an issue's comments"); },
    getMyself: async () => ({ accountId: "acct-project-agent" }),
    searchProjects: async () => ({ values: [{ key: opts.projectKey, name: opts.projectKey, lead: { accountId: "acct-project-agent" } }] }),
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
      for (const id of ids) if (id === opts.rootDocId) out[id] = pageVersion;
      return out;
    },
    commentOnPage: async (pageId: string, body: string) => {
      if (pageId !== opts.rootDocId) throw new Error(`fake: unexpected pageId ${pageId}`);
      const id = String(nextAutoId++);
      pageComments.push({ id, body, created: new Date(now()).toISOString() });
      return { ok: true, id };
    },
    getPageComments: async (pageId: string) => {
      if (pageId !== opts.rootDocId) throw new Error(`fake: unexpected pageId ${pageId}`);
      return { results: pageComments.map((c) => ({ id: c.id, body: c.body, created: c.created })) };
    },
  };

  const deps: ProjectResourceDeps = { ops, search: async () => [], allowlist: new Set([opts.projectKey]) };
  return { ops, deps, pageComments };
}

/** Same shape crash-loop.test.ts's/pinned-active.test.ts's fakeHerd uses. */
function fakeHerd(runningKeys: () => string[]): Herd {
  return {
    async runningIssues() { return runningKeys(); },
    async staleIssues() { return []; },
    async spawn() {},
    async stop() {},
    async paneFor(i) { return runningKeys().includes(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
  };
}

async function verdictOf(deps: ProjectResourceDeps, key: string): Promise<{ verdict: string; resource: ProjectResource }> {
  const resources = await createProjectResourceType(deps).discovery.search();
  const resource = resources.find((r) => r.key === key);
  if (!resource) throw new Error(`fake world produced no ProjectResource for ${key}`);
  return { verdict: projectVerdict(resource), resource };
}

describe("BUTCHR-305/BUTCHR-238 end-to-end reachability: real reconcileNow + real detector + real speakOnOwnChannel + real projectVerdict, fake only at the I/O boundary", () => {
  test("the full sequence: ACTIVE + running + idle past the window posts exactly one complaint, on the project's own root doc, WITHOUT re-activating the wake trigger it is complaining about — further polls in the same episode post nothing more, and a later fresh episode (after real work resumes) complains again", async () => {
    let now = 0;
    // versionBehind alone keeps this project ACTIVE throughout — the comment
    // axis starts (and, per the assertion below, STAYS) fully caught up, so
    // any change in unseenCommentIds can only be caused by this detector's
    // own complaint, never by the pre-existing reason this project is active.
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialComments: [{ id: "100", body: "<p>seed</p>" }],
      initialWake: { version: 1, comment: "100", epics: {} },
      initialPageVersion: 2, // observedVersion(2) !== watermark.version(1) -> versionBehind -> active
      now: () => now,
    });

    let status = "idle";
    const detector = createPinnedActiveDetector({
      now: () => now,
      minutes: 10,
      agentStatuses: async () => new Map([["ACME", status]]),
      addComment: (id, text) => speakOnOwnChannel(w.ops, id, text) as Promise<void>,
      comments: createOwnChannelComments(w.ops, async () => { throw new Error("issue comments should never be read for a project id"); }),
    });
    const herd = fakeHerd(() => ["ACME"]);

    async function poll() {
      const resourceType = createProjectResourceType(w.deps);
      const resources = await resourceType.discovery.search();
      const desired = desiredFrom(resources, resourceType);
      await reconcileNow(herd, desired, { checkPinnedActive: detector.check });
    }

    // Sanity: ACTIVE from the start (versionBehind), comment axis caught up.
    let { verdict, resource } = await verdictOf(w.deps, "ACME");
    expect(verdict).toBe("active");
    expect(resource.unseenCommentIds).toEqual([]);

    await poll(); // poll 0
    now = 9 * MIN;
    await poll(); // still short of the 10-minute window
    expect(w.pageComments.some((c) => c.body.includes(MARKER))).toBe(false);

    now = 10 * MIN + 1;
    await poll(); // crosses the window
    let complaints = w.pageComments.filter((c) => c.body.includes(MARKER));
    expect(complaints.length).toBe(1);

    // THE SELF-PIN TRAP, PROVEN BY ASSERTION (constraint 3): the complaint
    // just posted a NEW comment on this project's own root doc, through the
    // exact channel `unseenCommentIds` counts — if `speakOnOwnChannel`'s own
    // self-watermark advance were broken, this project would now ALSO be
    // ACTIVE for a NEW reason (a comment axis it was never behind on
    // before). It must not be: still caught up, still active for the SAME
    // (versionBehind) reason as before.
    ({ verdict, resource } = await verdictOf(w.deps, "ACME"));
    expect(resource.unseenCommentIds).toEqual([]); // unchanged by the complaint itself
    expect(verdict).toBe("active"); // unchanged — same reason (versionBehind) as before the complaint

    // Further polls in the same episode: no more complaints.
    now += MIN;
    await poll();
    now += MIN;
    await poll();
    complaints = w.pageComments.filter((c) => c.body.includes(MARKER));
    expect(complaints.length).toBe(1);

    // The agent goes back to working — the streak re-arms.
    status = "working";
    now += MIN;
    await poll();

    // A LATER fresh episode: idle again, past the window — a fresh complaint.
    // (11 polls, not 10: the first one only STARTS the new streak's floor —
    // see StalledTracker.observe — so crossing the 10-minute window takes 11
    // one-minute ticks from the first idle observation, same as episode 1's
    // own `i <= 10` loop starting from a floor of exactly 0.)
    status = "idle";
    for (let i = 1; i <= 11; i++) { now += MIN; await poll(); }
    complaints = w.pageComments.filter((c) => c.body.includes(MARKER));
    expect(complaints.length).toBe(2); // NOT latched shut forever by the first episode's complaint
  });

  test("a busy project (agent reads 'working' every poll) is never complained about, however long it stays ACTIVE — the bound does not reap (or even speak to) the innocent", async () => {
    let now = 0;
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialComments: [{ id: "100", body: "<p>seed</p>" }],
      initialWake: { version: 1, comment: "100", epics: {} },
      initialPageVersion: 2,
      now: () => now,
    });
    const detector = createPinnedActiveDetector({
      now: () => now,
      minutes: 10,
      agentStatuses: async () => new Map([["ACME", "working"]]),
      addComment: (id, text) => speakOnOwnChannel(w.ops, id, text) as Promise<void>,
      comments: createOwnChannelComments(w.ops, async () => { throw new Error("issue comments should never be read for a project id"); }),
    });
    const herd = fakeHerd(() => ["ACME"]);
    for (let i = 0; i <= 200; i++) {
      now = i * MIN;
      const resourceType = createProjectResourceType(w.deps);
      const desired = desiredFrom(await resourceType.discovery.search(), resourceType);
      await reconcileNow(herd, desired, { checkPinnedActive: detector.check });
    }
    expect(w.pageComments.some((c) => c.body.includes(MARKER))).toBe(false);
    expect((await verdictOf(w.deps, "ACME")).verdict).toBe("active"); // still active (versionBehind) the whole time — never touched
  });

  test("a quota-blocked idle agent draws nothing, past the window, for as long as it stays blocked", async () => {
    let now = 0;
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialComments: [{ id: "100", body: "<p>seed</p>" }],
      initialWake: { version: 1, comment: "100", epics: {} },
      initialPageVersion: 2,
      now: () => now,
    });
    const detector = createPinnedActiveDetector({
      now: () => now,
      minutes: 10,
      agentStatuses: async () => new Map([["ACME", "idle"]]),
      addComment: (id, text) => speakOnOwnChannel(w.ops, id, text) as Promise<void>,
      comments: createOwnChannelComments(w.ops, async () => { throw new Error("issue comments should never be read for a project id"); }),
      quotaBlocked: (id) => id === "ACME",
    });
    const herd = fakeHerd(() => ["ACME"]);
    for (let i = 0; i <= 30; i++) {
      now = i * MIN;
      const resourceType = createProjectResourceType(w.deps);
      const desired = desiredFrom(await resourceType.discovery.search(), resourceType);
      await reconcileNow(herd, desired, { checkPinnedActive: detector.check });
    }
    expect(w.pageComments.some((c) => c.body.includes(MARKER))).toBe(false);
  });

  test("a failed comments fetch (the project-aware reader rejecting) posts nothing and leaves the next poll free to retry — fails closed, per the dedupe trap", async () => {
    let now = 0;
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialComments: [{ id: "100", body: "<p>seed</p>" }],
      initialWake: { version: 1, comment: "100", epics: {} },
      initialPageVersion: 2,
      now: () => now,
    });
    let failReads = true;
    const realComments = createOwnChannelComments(w.ops, async () => { throw new Error("issue comments should never be read for a project id"); });
    const detector = createPinnedActiveDetector({
      now: () => now,
      minutes: 10,
      agentStatuses: async () => new Map([["ACME", "idle"]]),
      addComment: (id, text) => speakOnOwnChannel(w.ops, id, text) as Promise<void>,
      comments: async (id) => { if (failReads) throw new Error("Confluence 503"); return realComments(id); },
    });
    const herd = fakeHerd(() => ["ACME"]);
    for (let i = 0; i <= 15; i++) {
      now = i * MIN;
      const resourceType = createProjectResourceType(w.deps);
      const desired = desiredFrom(await resourceType.discovery.search(), resourceType);
      await reconcileNow(herd, desired, { checkPinnedActive: detector.check });
    }
    expect(w.pageComments.some((c) => c.body.includes(MARKER))).toBe(false); // fetch failing the whole time — stayed silent
    failReads = false;
    now = 16 * MIN;
    const resourceType = createProjectResourceType(w.deps);
    const desired = desiredFrom(await resourceType.discovery.search(), resourceType);
    await reconcileNow(herd, desired, { checkPinnedActive: detector.check });
    expect(w.pageComments.filter((c) => c.body.includes(MARKER)).length).toBe(1); // retried and succeeded
  });

  test("an already-posted complaint from a prior process (found via the REAL project-aware comments read, through the real unwrap) is adopted, not duplicated", async () => {
    let now = 0;
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialComments: [{ id: "100", body: "<p>seed</p>" }],
      initialWake: { version: 1, comment: "100", epics: {} },
      initialPageVersion: 2,
      now: () => now,
    });
    const realComments = createOwnChannelComments(w.ops, async () => { throw new Error("issue comments should never be read for a project id"); });
    const addComment = (id: string, text: string) => speakOnOwnChannel(w.ops, id, text) as Promise<void>;
    const herd = fakeHerd(() => ["ACME"]);

    const before = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => new Map([["ACME", "idle"]]), addComment, comments: realComments });
    for (let i = 0; i <= 10; i++) {
      now = i * MIN;
      const resourceType = createProjectResourceType(w.deps);
      const desired = desiredFrom(await resourceType.discovery.search(), resourceType);
      await reconcileNow(herd, desired, { checkPinnedActive: before.check });
    }
    expect(w.pageComments.filter((c) => c.body.includes(MARKER)).length).toBe(1);

    // Simulate a daemon restart: a brand-new detector instance, no in-memory
    // tracking, same underlying Confluence page (the real, storage-format
    // wrapped comment is still there — adoption must go through the real
    // unwrap, per constraint 4, not a plain-text shortcut).
    const after = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => new Map([["ACME", "idle"]]), addComment, comments: realComments });
    for (let i = 0; i <= 10; i++) {
      now = (i + 11) * MIN;
      const resourceType = createProjectResourceType(w.deps);
      const desired = desiredFrom(await resourceType.discovery.search(), resourceType);
      await reconcileNow(herd, desired, { checkPinnedActive: after.check });
    }
    expect(w.pageComments.filter((c) => c.body.includes(MARKER)).length).toBe(1); // adopted, not re-posted
  });

  test("plan.spawn/plan.stop/plan.respawn are byte-identical with and without checkPinnedActive wired, over the REAL project resource type's own desired/atRest computation", async () => {
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialComments: [{ id: "100", body: "<p>seed</p>" }],
      initialWake: { version: 1, comment: "100", epics: {} },
      initialPageVersion: 2, // active
    });

    async function run(withHook: boolean) {
      const spawned: string[] = [], stopped: string[] = [];
      const herd: Herd = {
        async runningIssues() { return []; }, // not yet running -> a spawn candidate
        async staleIssues() { return []; },
        async spawn(sp) { spawned.push(sp.key); },
        async stop(i) { stopped.push(i); },
        async paneFor() { return null; },
        async nudge() { return { delivered: true }; },
      };
      const resourceType = createProjectResourceType(w.deps);
      const desired = desiredFrom(await resourceType.discovery.search(), resourceType);
      await reconcileNow(herd, desired, withHook ? { checkPinnedActive: async () => { /* observes and speaks only */ } } : {});
      return { spawned, stopped };
    }

    const without = await run(false);
    const withHook = await run(true);
    expect(withHook).toEqual(without);
    expect(without.spawned).toEqual(["ACME"]);
  });
});
