import { describe, expect, test, beforeEach } from "bun:test";
import {
  createProjectResourceType,
  projectVerdict,
  advanceProjectWatermark,
  resetPendingWatermarkFallbackForTests,
  type ProjectResourceDeps,
} from "../../src/resources/project.js";
import { speakOnOwnChannel } from "../../src/tools/speak.js";
import { setProjectDoc } from "../../src/tools/docs.js";
import { desiredFrom } from "../../src/daemon/loop.js";
import { atlassianTools } from "../../src/tools/defs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

// BUTCHR-226: `pendingWatermarkFallback` (src/resources/project.ts) is
// process-lifetime state shared across every test in this process, and this
// file reuses project key "ACME" across many tests/describe blocks — reset
// it before each test so one test's failed-write fallback can never leak
// into another's assertions.
beforeEach(() => resetPendingWatermarkFallbackForTests());

/**
 * BUTCHR-217 — characterizes TODAY'S REAL project root-doc wake rule,
 * end-to-end through the REAL `speakOnOwnChannel` write and the REAL
 * `loadProjects`/`projectVerdict` read (via `createProjectResourceType(...)
 * .discovery.search()`), never a hand-rolled shortcut fixture. This is what
 * DoD item 3 requires: a fixture that is merely TYPE-faithful (e.g. an
 * auto-incrementing `commentOnPage` id, as several sibling test files' local
 * `makeOps` helpers use) cannot exercise the one dimension this file is
 * about — Confluence footer-comment ids are NOT monotonic with creation
 * order (measured live; see src/resources/project.ts's own module-level
 * measurement notes) — so this file's fake `commentOnPage` returns
 * CALLER-CHOSEN ids, including ids lower than ids already on the page,
 * exactly the shape a type-faithful-but-behaviorally-wrong fixture would
 * never produce.
 *
 * BUTCHR-227 UPDATE, PER BUTCHR-199's OWN INSTRUCTION ("your PR will break
 * some of these deliberately-pinned characterization tests, and that break
 * IS THE SIGNAL, not your bug — update them test-by-test, never flatten
 * green"): this file pinned TODAY'S (BROKEN) behavior at BUTCHR-217. The
 * F5/F6 "specimen's mechanism" block below is the exact defect BUTCHR-227
 * fixes — its assertions are INVERTED below (from "regresses and wakes" to
 * "does not regress, stays asleep"), with the old assertions kept in a
 * comment so a reader can see exactly what changed and why. Every other
 * block in this file characterizes something BUTCHR-227 explicitly does
 * NOT touch (the version axis, F7's silent-write-failure path, the
 * author/content-blindness of the predicate) and is updated ONLY for the
 * renamed fields (`observedCommentId` -> `observedCommentIds`,
 * `watermark.comment` -> `watermark.commentsSeen`), never for behavior —
 * `newestCommentId` itself no longer exists (BUTCHR-227 deleted it, having
 * no remaining callers) so this file's one direct use of it is rewritten
 * against `advanceProjectWatermark`'s new `seenComments` writer shape.
 *
 * Every describe block states its own failure condition first, per this
 * ticket's evidence-discipline requirement.
 *
 * BUTCHR-226 UPDATE: this file characterized PRE-FIX behavior — the three
 * defects it pins were left unfixed on purpose (211's own PR body: "no
 * behavior change"). BUTCHR-226 fixes all three (the monotonic guard,
 * defect 1; the in-process pending-watermark fallback, defect 1b; the
 * version-axis identity-of-write advance in `setProjectDoc`, defect 2), so
 * three tests below that asserted the DEFECT's outcome now assert the FIXED
 * outcome instead — each edited test says so explicitly, in place, rather
 * than being silently deleted or weakened (per this ticket's own
 * instruction). Every OTHER test here is untouched and still passes
 * unmodified: they prove properties BUTCHR-226 does not change (a foreign
 * comment/edit still wakes, content/author never matter, epics semantics),
 * which is exactly the invariant this fix is not allowed to weaken.
 */

interface World {
  ops: AtlassianOps;
  deps: ProjectResourceDeps;
  pageComments: Array<{ id: string; body: string }>;
  setProjectPropertyCalls: number;
}

function world(opts: {
  projectKey: string;
  rootDocId: string;
  initialComments?: Array<{ id: string; body: string }>;
  initialWake?: { version?: number | null; comment?: string | null; epics?: Record<string, string | null> };
  /** Queue of ids `commentOnPage` returns, in call order — lets a test force a NON-monotonic id (lower than an id already on the page), the real, measured Confluence behavior this module's own doc comments describe. */
  nextCommentIds?: string[];
  /** When true, the write half of `advanceProjectWatermark` (setProjectProperty) rejects — simulates F7, the swallowed-`.catch` path. */
  failWatermarkWrite?: boolean;
  /** The root doc's starting Confluence page version (`version.number`) — `updatePage` (the REAL write `set_doc`/`setProjectDoc` makes) bumps it by 1 per call, exactly like Confluence does, so `getPageVersions` reflects a genuine body edit rather than a hand-set number. */
  initialPageVersion?: number;
}): World {
  const pageComments = [...(opts.initialComments ?? [])];
  const idQueue = [...(opts.nextCommentIds ?? [])];
  let nextAutoId = 9000;
  let setProjectPropertyCalls = 0;
  let pageVersion = opts.initialPageVersion ?? 1;
  const properties = new Map<string, Record<string, unknown>>([
    [
      opts.projectKey,
      {
        space: { key: opts.projectKey },
        rootDoc: { id: opts.rootDocId },
        wake: opts.initialWake ?? {},
      },
    ],
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
    // REAL Confluence behavior: every `updatePage` (a body edit — the
    // write `setProjectDoc`/`set_doc` makes) bumps `version.number` by 1,
    // whether or not anything else ever reads it back to a watermark.
    updatePage: async (_p: unknown) => {
      pageVersion++;
      return { ok: true, version: pageVersion };
    },
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
    getIssueComments: async () => ({ results: [] }),

    getMyself: async () => ({ accountId: "acct-project-agent" }),
    searchProjects: async () => ({
      values: [{ key: opts.projectKey, name: opts.projectKey, lead: { accountId: "acct-project-agent" } }],
    }),
    getProjectProperty: async (key: string) => {
      const p = properties.get(key);
      if (!p) throw new Error(`fake: 404, no "butchr" property for ${key}`);
      return p;
    },
    getProjectPropertyOrNull: async (key: string) => properties.get(key) ?? null,
    setProjectProperty: async (key: string, _propertyKey: string, value: unknown) => {
      setProjectPropertyCalls++;
      if (opts.failWatermarkWrite) throw new Error("fake: setProjectProperty transiently unavailable");
      properties.set(key, value as Record<string, unknown>);
      return { ok: true };
    },
    getPageVersions: async (ids: readonly string[]) => {
      const out: Record<string, number> = {};
      for (const id of ids) if (id === opts.rootDocId) out[id] = pageVersion;
      return out;
    },
    // REAL shape: storage-format XHTML, exactly what speakOnOwnChannel writes
    // and getPageComments returns — never a plain-text shortcut (BUTCHR-129's
    // own lesson, cited in this module's leads).
    commentOnPage: async (pageId: string, body: string) => {
      const id = idQueue.length ? idQueue.shift()! : String(nextAutoId++);
      pageComments.push({ id, body });
      return { ok: true, id };
    },
    getPageComments: async (pageId: string) => {
      if (pageId !== opts.rootDocId) throw new Error(`fake: unexpected pageId ${pageId}`);
      return { results: pageComments.map((c) => ({ id: c.id, body: c.body })) };
    },
  };

  const deps: ProjectResourceDeps = {
    ops,
    search: async () => [],
    allowlist: new Set([opts.projectKey]),
  };

  return { ops, deps, pageComments, get setProjectPropertyCalls() { return setProjectPropertyCalls; } };
}

async function verdictOf(deps: ProjectResourceDeps, key: string) {
  const resources = await createProjectResourceType(deps).discovery.search();
  const resource = resources.find((r) => r.key === key);
  if (!resource) throw new Error(`fake world produced no ProjectResource for ${key}`);
  return { verdict: projectVerdict(resource), resource };
}

describe("end-to-end (real speakOnOwnChannel write, real loadProjects read): the direction the epic cares about", () => {
  // Failure condition: a fleet-authored write (report_to_boss/ask_boss, or a
  // daemon complaint routed through speakOnOwnChannel — same seam) that
  // reads back as "active" on the very next poll is exactly HAZARD 1 failing
  // to close — this must be "asleep" whenever ids happen to stay monotonic
  // (the common case; the non-monotonic case is its own describe block
  // below, because it is NOT this same claim).
  test("a project's own report_to_boss/ask_boss write, with a normal (higher) id, does not wake it on the next poll", async () => {
    const w = world({ projectKey: "ACME", rootDocId: "doc-1", initialWake: { version: 1, comment: null, epics: {} } });
    await speakOnOwnChannel(w.ops, "ACME", "[ACME] status update");
    const { verdict } = await verdictOf(w.deps, "ACME");
    expect(verdict).toBe("asleep");
  });
});

describe("F8 / DoD-1(d) / DoD-3 THE VERSION AXIS — BUTCHR-226 FIXED THIS: a project's own root-doc BODY EDIT no longer self-wakes it, and a FOREIGN edit still does", () => {
  // PRE-BUTCHR-226, this block asserted the DEFECT's outcome (own edit ->
  // "active", traced to an actual spawn). BUTCHR-226 closed the version axis
  // with the same identity-of-write shape the comment axis already used
  // (`setProjectDoc`, src/tools/docs.ts, now advances `wake.version` to the
  // version ITS OWN `ops.updatePage` call produced, via
  // `advanceProjectWatermark`). Updated in place rather than left to fail
  // silently disagree with shipped code — see this file's own top-of-file
  // BUTCHR-226 update note.
  //
  // Failure condition, post-fix: the OWN-edit test below is wrong if it
  // reads "active" (the version suppression regressed or was never wired);
  // the FOREIGN-edit test below is wrong if it reads "asleep" (the
  // suppression widened to swallow a write it must not — the failure this
  // whole ticket names as worse than the bug).
  test("a project's own set_doc call (a REAL setProjectDoc write) advances the version watermark to the version IT produced — reads asleep on the next poll, comment/epics axes untouched", async () => {
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialPageVersion: 5,
      initialComments: [{ id: "100", body: "<p>seed</p>" }],
      initialWake: { version: 5, comment: "100", epics: {} }, // caught up on every axis, exactly as if check_in just ran
    });
    expect((await verdictOf(w.deps, "ACME")).verdict).toBe("asleep"); // sanity: caught up before the edit

    // The REAL write `set_doc` makes for a project caller — no comment
    // posted, no speakOnOwnChannel call, nothing that could touch the
    // comment axis at all.
    await setProjectDoc(w.ops, "ACME", "<p>updated brief</p>");

    const { verdict, resource } = await verdictOf(w.deps, "ACME");
    expect(resource.observedVersion).toBe(6); // Confluence bumped it
    expect(resource.watermark.version).toBe(6); // BUTCHR-226: advanced to the version setProjectDoc's OWN write produced
    expect(resource.unseenCommentIds).toEqual([]); // comment axis: still caught up, untouched by this edit
    expect(verdict).toBe("asleep"); // BUTCHR-226: no longer wakes on its own edit

    // Traced through to an actual spawn decision, same discipline as F5/F6.
    const resourceType = createProjectResourceType(w.deps);
    const desired = desiredFrom(await resourceType.discovery.search(), resourceType);
    expect(desired.has("ACME")).toBe(false);
  });

  // The failure this fix must not cause (worth more than the fix itself,
  // per the ticket): a body edit this project's OWN `setProjectDoc` never
  // made — e.g. a human editing the page directly, or any other writer —
  // must still wake it. Exercised here via a raw `ops.updatePage` call,
  // bypassing `setProjectDoc` entirely, so no version-watermark advance
  // happens at all.
  test("a FOREIGN root-doc body edit (a raw ops.updatePage call, never through setProjectDoc) still wakes the project", async () => {
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialPageVersion: 5,
      initialComments: [{ id: "100", body: "<p>seed</p>" }],
      initialWake: { version: 5, comment: "100", epics: {} },
    });
    expect((await verdictOf(w.deps, "ACME")).verdict).toBe("asleep"); // sanity: caught up before the edit

    await w.ops.updatePage({ id: "doc-1", body: "<p>someone else's edit</p>" });

    const { verdict, resource } = await verdictOf(w.deps, "ACME");
    expect(resource.observedVersion).toBe(6);
    expect(resource.watermark.version).toBe(5); // never advanced — this write never went through setProjectDoc
    // BUTCHR-227 field rename only (observedCommentId -> observedCommentIds,
    // watermark.comment -> watermark.commentsSeen): the PROPERTY under test
    // — the comment axis stays fully caught up, untouched by this edit — is
    // unchanged; `unseenCommentIds` is the direct expression of "caught up".
    expect(resource.unseenCommentIds).toEqual([]); // comment axis: still caught up, untouched by this edit
    expect(verdict).toBe("active"); // wakes on the version axis alone

    const resourceType = createProjectResourceType(w.deps);
    const desired = desiredFrom(await resourceType.discovery.search(), resourceType);
    expect(desired.has("ACME")).toBe(true);
  });
});

describe("end-to-end: the OPPOSITE direction — a genuine foreign comment must still wake (not optional, per DoD)", () => {
  // Failure condition: a foreign comment (never routed through
  // speakOnOwnChannel, so never watermarked) reading back as "asleep" means
  // the suppression is swallowing real inbound messages — the worse bug the
  // ticket names explicitly.
  test("a human/boss comment posted directly via commentOnPage (never through speakOnOwnChannel) wakes the project", async () => {
    const w = world({ projectKey: "ACME", rootDocId: "doc-1", initialComments: [{ id: "100", body: "<p>[ACME] status update</p>" }], initialWake: { version: 1, comment: "100", epics: {} } });
    // A boss/operator directive, posted the way a human actually would —
    // straight to the page, not through this project's own outbound seam.
    await w.ops.commentOnPage("doc-1", "<p>Please prioritize the other ticket first.</p>");
    const { verdict } = await verdictOf(w.deps, "ACME");
    expect(verdict).toBe("active");
  });
});

describe("THE SPECIMEN'S MECHANISM, BUTCHR-227 UPDATE: F5/F6 is FIXED — this block's assertions are INVERTED from BUTCHR-217's pinned (broken) behavior, on purpose", () => {
  // BUTCHR-217's ORIGINAL failure condition (kept for the record): "if this
  // does NOT reproduce 'active' from a write that never involved a foreign
  // comment, then F5 is FALSIFIED". That was correct for the CODE AT THAT
  // TIME (a blind scalar overwrite). BUTCHR-227 changes the code, so the
  // SAME setup must now produce the OPPOSITE verdict — a test that still
  // asserted "active" here would be asserting that this ticket's own fix
  // did not work.
  //
  // THIS BLOCK'S NEW FAILURE CONDITION, stated before looking: if this
  // reproduces "active" from a write that never involved a foreign comment,
  // BUTCHR-227's fix DID NOT WORK — the exact defect it exists to close is
  // still live. It does not reproduce "active" below (proven by running the
  // test), so the fix holds against this specimen.
  test("BUTCHR-227 FIXED: a daemon complaint posted with a LOWER id than an already-caught-up watermark no longer regresses anything, and the project stays ASLEEP — zero foreign comments involved", async () => {
    // Set up: identical to BUTCHR-217's original fixture — the project
    // already checked in once, caught up to the highest id then on the page
    // (id "500", stored as the LEGACY scalar shape check_in used to write —
    // this ALSO exercises the migration adapter, seeding `commentsSeen` with
    // exactly one member, "500").
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialComments: [{ id: "500", body: "<p>[ACME] earlier status</p>" }],
      initialWake: { version: 1, comment: "500", epics: {} },
      // The MEASURED failure mode this ticket's leads describe: the next
      // Confluence footer-comment id assigned is LOWER than one already on
      // the page. frozen-asleep's own complaint (the exact real text
      // shape it posts) gets this id.
      nextCommentIds: ["300"],
    });
    expect((await verdictOf(w.deps, "ACME")).verdict).toBe("asleep"); // sanity: caught up before the write

    // The reap comment — same call frozen-asleep's postComplaint makes via
    // its injected `addComment`, which src/daemon/index.ts wires to
    // speakOnOwnChannel for every complaint detector.
    await speakOnOwnChannel(w.ops, "ACME", "[butchr:frozen] ACME has read \"asleep\" with its agent still running...");

    const { verdict, resource } = await verdictOf(w.deps, "ACME");
    // BUTCHR-217 (BEFORE, now WRONG): `expect(resource.watermark.comment).toBe("300")`
    // — the scalar watermark was blindly overwritten to the LOWER id, losing "500".
    // BUTCHR-227 (NOW): a UNION, never a replace — both ids are seen.
    expect(new Set(resource.watermark.commentsSeen)).toEqual(new Set(["500", "300"]));
    // BUTCHR-217 (BEFORE, now WRONG): `expect(resource.observedCommentId).toBe("500")`
    // — a single "newest by magnitude" scalar. BUTCHR-227 (NOW): the FULL
    // observed set, unordered by construction.
    expect(new Set(resource.observedCommentIds)).toEqual(new Set(["500", "300"]));
    // THE FIX ITSELF: nothing is unseen, so the project does NOT wake purely
    // from its own suppressed write — the specimen's reported shape
    // ("wakes on a stale comment rather than on the complaint itself") no
    // longer reproduces.
    expect(resource.unseenCommentIds).toEqual([]);
    expect(verdict).toBe("asleep");

    // Traced through to an ACTUAL SPAWN DECISION, not reasoned on paper:
    // `desiredFrom` (src/daemon/loop.ts) is the real function whose output
    // the reconciler spawns from. BUTCHR-217 asserted this resource LANDED
    // in `desired` (the bug). BUTCHR-227: it does not.
    const resourceType = createProjectResourceType(w.deps);
    const allProjects = await resourceType.discovery.search();
    const desired = desiredFrom(allProjects, resourceType);
    expect(desired.has("ACME")).toBe(false);
  });

  // BUTCHR-217's "contrast" test compared check_in's (safe) max-reduce
  // writer against speakOnOwnChannel's (unsafe) blind-overwrite writer —
  // the contrast existed because the two writers had DIFFERENT regression
  // safety. BUTCHR-227 removes that asymmetry: BOTH writers now go through
  // the same union, so there is no longer a meaningful "contrast" between
  // them on this axis — this test is REPURPOSED (not deleted) to assert the
  // now-shared property directly: a union-shaped advance, given the same
  // non-monotonic scenario, cannot regress anything, from EITHER writer's
  // calling shape.
  test("BUTCHR-227: a union-shaped advance (either writer's shape) does not regress under the identical non-monotonic scenario — the old writer-asymmetry this contrast existed to show is gone", async () => {
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialComments: [{ id: "500", body: "<p>earlier</p>" }, { id: "300", body: "<p>[butchr:frozen] ...</p>" }],
      initialWake: { version: 1, comment: "500", epics: {} },
    });
    const observed = (await w.ops.getPageComments("doc-1")).results;
    // check_in's OWN shape (src/tools/defs.ts): the FULL observed id set,
    // never a "newest" scalar.
    await advanceProjectWatermark(w.ops, "ACME", { seenComments: observed.map((c) => c.id) });
    const { verdict, resource } = await verdictOf(w.deps, "ACME");
    expect(new Set(resource.watermark.commentsSeen)).toEqual(new Set(["500", "300"])); // both preserved, not just the max
    expect(verdict).toBe("asleep");
  });
});

describe("BUTCHR-260 — the reconcile/deletion-recovery machinery is DROPPED, not adapted: a comment deletion needs no recovery path under BUTCHR-227's seen-set", () => {
  // WHAT USED TO LIVE HERE (BUTCHR-226 review round 1): under the
  // pre-BUTCHR-227 scalar watermark ("newest comment id by numeric
  // magnitude"), deleting the root doc's highest-id comment could drop the
  // page's true max BELOW the already-stored scalar. `projectVerdict`'s
  // exact-inequality comparison then read that stale-high watermark as
  // "behind" forever, and the ordinary monotonic guard (raise-only) could
  // never let `check_in` lower it back — a PERMANENT spawn loop only an
  // explicit `patch.reconcile` escape hatch (check_in-only, bypassing the
  // guard entirely) could clear. Three tests here proved that recovery
  // end-to-end (two driving `advanceProjectWatermark` directly, one through
  // the real `atlassianTools(...)` `check_in` handler).
  //
  // WHY THIS IS GONE (BUTCHR-260, VERIFIED rather than assumed — see
  // `advanceProjectWatermark`'s own doc comment on `monotonicMax`,
  // src/resources/project.ts, for the full evidence trail): BUTCHR-227
  // replaced that scalar with `commentsSeen`, a SEEN SET compared by
  // MEMBERSHIP, never by magnitude, unioned, never replaced, with no
  // retention/eviction rule. There is no "newest" for a deletion to
  // invalidate, and nothing is ever removed from the set once seen, so a
  // deleted comment simply STAYS seen — there is no ceiling to re-lower and
  // no recovery to perform. The two direct-`reconcile`-flag tests that used
  // to prove the recovery are deleted outright, not adapted: the scenario
  // they proved recoverable no longer occurs, so there is nothing left for
  // them to characterize.
  //
  // STILL REQUIRED (BUTCHR-260 DoD): "check_in's real call-site wiring,
  // driven through the real atlassianTools(...) handler, not a direct
  // advanceProjectWatermark call" — kept below, repurposed to prove the NEW
  // claim (no reconciliation needed) instead of the old one (reconciliation
  // works).
  test("check_in, driven through the REAL tool-surface handler (atlassianTools(...), not a direct advanceProjectWatermark call): a comment already checked in stays seen after it's deleted from the page — no reconciliation performed or needed, project stays asleep", async () => {
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialPageVersion: 1,
      initialComments: [{ id: "500", body: "<p>will be deleted</p>" }, { id: "100", body: "<p>survives</p>" }],
      initialWake: { version: 1, epics: {} }, // nothing checked in yet
    });
    // check_in's real handler also calls `ops.search` for epics currently
    // In Review (src/tools/defs.ts) — `world()`'s own fake leaves this
    // `unimplemented`, since no other test in this file exercises the real
    // check_in handler; none are in review here.
    w.ops.search = async () => ({ issues: [] });
    expect((await verdictOf(w.deps, "ACME")).verdict).toBe("active"); // sanity: two comments, neither seen yet

    // The REAL tool surface, the same handler an agent's MCP call actually
    // reaches — not a reimplementation of check_in's shape.
    const tools = atlassianTools(w.ops, () => {});
    await tools.check_in!.handler({}, { headers: { "x-issue": "ACME" } } as any);
    expect((await verdictOf(w.deps, "ACME")).verdict).toBe("asleep"); // sanity: check_in caught up on both

    // The specimen this block used to need a `reconcile` escape hatch for:
    // the comment check_in just recorded as seen is now deleted from the
    // page entirely.
    const idx = w.pageComments.findIndex((c) => c.id === "500");
    w.pageComments.splice(idx, 1);

    const { verdict, resource } = await verdictOf(w.deps, "ACME");
    // THE CLAIM: still asleep, with NO reconciliation performed — "500"
    // stays a member of `commentsSeen` forever (no retention rule), and the
    // freshly observed set ("100" only, now) is fully contained in it.
    expect(new Set(resource.watermark.commentsSeen)).toEqual(new Set(["500", "100"]));
    expect(resource.unseenCommentIds).toEqual([]);
    expect(verdict).toBe("asleep");

    const resourceType = createProjectResourceType(w.deps);
    const desired = desiredFrom(await resourceType.discovery.search(), resourceType);
    expect(desired.has("ACME")).toBe(false);
  });
});

describe("F7 — BUTCHR-226 FIXED THIS (defect 1b): the swallowed watermark-write failure no longer reproduces the self-wake symptom, via the in-process pending-watermark fallback", () => {
  // PRE-BUTCHR-226, this test proved the swallow left the project "active"
  // forever on its own already-posted complaint (a rejected write meant the
  // watermark simply never advanced while the page's true max moved on).
  // BUTCHR-226's fix (`pendingWatermarkFallback`, src/resources/project.ts)
  // does NOT make the Jira/Confluence write itself succeed — it cannot — but
  // it remembers, in this process only, what the write was trying to
  // record, and `loadProjects` merges that into the watermark it compares
  // against. Updated in place — see this file's top-of-file BUTCHR-226
  // update note.
  //
  // Failure condition, post-fix: this is wrong if the verdict still reads
  // "active" after the rejected write (the fallback isn't wired into the
  // read path) or if the WARNING log line disappeared (the failure would go
  // back to being silent, the exact regression BUTCHR-105 already ruled
  // against).
  test("commentOnPage succeeds (id 501, perfectly monotonic) but the persisted watermark write rejects — the .catch still logs it, but the in-process fallback keeps the project asleep anyway", async () => {
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialComments: [{ id: "500", body: "<p>earlier</p>" }],
      initialWake: { version: 1, comment: "500", epics: {} },
      nextCommentIds: ["501"],
      failWatermarkWrite: true,
    });
    const lines: string[] = [];
    await speakOnOwnChannel(w.ops, "ACME", "[butchr:frozen] ACME ...", (l) => lines.push(l));
    // Both the generic advanceProjectWatermark fallback line and speakOnOwnChannel's
    // own caller-specific line are expected — see project.ts's own doc
    // comment on why two distinct, differently-shaped WARNING lines is the
    // point (a reader can tell which mechanism produced a given incident).
    expect(lines.some((l) => l.includes("WARNING") && l.includes("watermark advance failed"))).toBe(true);
    expect(lines.some((l) => l.includes("WARNING") && l.includes("[advanceProjectWatermark]") && l.includes("DEFECT 1b"))).toBe(true);
    const { verdict, resource } = await verdictOf(w.deps, "ACME");
    // The PERSISTED property was never written (the fake's setProjectProperty
    // always rejects here) — but `resource.watermark` is what `loadProjects`
    // hands to the predicate, and BUTCHR-226/BUTCHR-260's fallback merges the
    // in-process pending value into it (adapted to `commentsSeen`), so the
    // EFFECTIVE watermark the project is judged against already reflects the
    // failed write's own intent.
    expect(new Set(resource.watermark.commentsSeen)).toEqual(new Set(["500", "501"]));
    expect(resource.unseenCommentIds).toEqual([]); // the new comment IS on the page, but already covered by the fallback
    expect(verdict).toBe("asleep"); // BUTCHR-226/BUTCHR-260: no longer wakes on its own already-posted (but unpersisted) complaint
  });
});

describe("DoD 4 — the absent-author case: the wake predicate never consumes `author` at all (structural, not a graceful default)", () => {
  // Failure condition: this claim is wrong if `ProjectResource`,
  // `ProjectEpic`, or anything `projectVerdict`/`loadProjects` reads carries
  // an `author` field anywhere in its shape — it does not (see
  // src/resources/project.ts's own interfaces), so there is nothing for
  // "absent" vs "present" to change. A comment whose author could not be
  // read (getPageComments's own `author?: string` on AtlassianOps) wakes
  // the project identically to one whose author IS legible — this test
  // proves it by never supplying an author field at all and observing the
  // normal foreign-comment wake still fires.
  test("a foreign comment with NO author field at all still wakes the project, exactly like one with an author", async () => {
    const w = world({ projectKey: "ACME", rootDocId: "doc-1", initialComments: [{ id: "100", body: "<p>seed</p>" }], initialWake: { version: 1, comment: "100", epics: {} } });
    await w.ops.commentOnPage("doc-1", "<p>a comment from someone whose author this reader could not resolve</p>");
    const { verdict } = await verdictOf(w.deps, "ACME");
    expect(verdict).toBe("active");
  });
});

describe("DoD 5 — the human-quotes-a-marker case: the wake predicate is content-blind by construction", () => {
  // Failure condition: this claim is wrong if a comment BODY containing the
  // literal `[butchr:frozen]` marker text is treated any differently by
  // `projectVerdict`/`loadProjects` than one without it — it is not, because
  // `ProjectResource`/`ProjectEpic` carry no body/content field for the
  // predicate to key on in the first place (only ids and a version number).
  // A content-marker rule IS used elsewhere in this codebase (`findMarked`,
  // src/agents/escalation-helper.ts) for a DIFFERENT purpose — dedupe/adopt
  // on restart — never for the wake trigger itself.
  test("a foreign comment whose body quotes [butchr:frozen] verbatim still wakes the project on id alone — content plays no role", async () => {
    const w = world({ projectKey: "ACME", rootDocId: "doc-1", initialComments: [{ id: "100", body: "<p>seed</p>" }], initialWake: { version: 1, comment: "100", epics: {} } });
    // A human, quoting the marker on purpose (e.g. asking "why did this
    // post?") — never written via speakOnOwnChannel, so never watermarked.
    await w.ops.commentOnPage("doc-1", "<p>Someone please explain this: [butchr:frozen] ACME has read \"asleep\"...</p>");
    const { verdict } = await verdictOf(w.deps, "ACME");
    expect(verdict).toBe("active");
  });
});
