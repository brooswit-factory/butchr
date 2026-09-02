import { describe, expect, test } from "bun:test";
import {
  createProjectResourceType,
  projectVerdict,
  advanceProjectWatermark,
  newestCommentId,
  type ProjectResourceDeps,
} from "../../src/resources/project.js";
import { speakOnOwnChannel } from "../../src/tools/speak.js";
import { setProjectDoc } from "../../src/tools/docs.js";
import { desiredFrom } from "../../src/daemon/loop.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

/**
 * BUTCHR-217 — characterizes TODAY'S REAL project root-doc wake rule,
 * end-to-end through the REAL `speakOnOwnChannel` write and the REAL
 * `loadProjects`/`projectVerdict` read (via `createProjectResourceType(...)
 * .discovery.search()`), never a hand-rolled shortcut fixture. This is what
 * DoD item 3 requires: a fixture that is merely TYPE-faithful (e.g. an
 * auto-incrementing `commentOnPage` id, as several sibling test files' local
 * `makeOps` helpers use) cannot exercise the one dimension this file is
 * about — Confluence footer-comment ids are NOT monotonic with creation
 * order (measured live, `newestCommentId`'s own doc comment in
 * src/resources/project.ts) — so this file's fake `commentOnPage` returns
 * CALLER-CHOSEN ids, including ids lower than ids already on the page,
 * exactly the shape a type-faithful-but-behaviorally-wrong fixture would
 * never produce.
 *
 * Every describe block states its own failure condition first, per this
 * ticket's evidence-discipline requirement.
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
      return { ok: true };
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

describe("F8 / DoD-1(d) / DoD-3 THE VERSION AXIS: a project's own root-doc BODY EDIT — no comment involved at all — self-wakes it deterministically, because nothing but check_in ever advances the version watermark", () => {
  // Failure condition: this whole block is wrong if the project reads
  // "asleep" after a body edit with the comment/epics axes untouched and
  // caught up — that would mean something DOES suppress the version axis,
  // contradicting the writer inventory below. It does NOT come back
  // "asleep": confirmed by re-deriving the writer inventory directly
  // (`grep -rn "advanceProjectWatermark(" src/` at this PR's own commit
  // finds EXACTLY TWO non-definition call sites — src/tools/defs.ts's
  // check_in, which passes `{version, comment, epics}` every time, and
  // src/tools/speak.ts's speakOnOwnChannel, which passes `{comment}` ONLY,
  // never `version` — so there is no third writer and nothing advances the
  // version axis outside check_in). `setProjectDoc` (src/tools/docs.ts),
  // the function `set_doc` actually calls for a project caller, calls
  // ONLY `ops.updatePage` and never `advanceProjectWatermark` — confirmed
  // by reading its full body, not by absence-of-a-grep-hit alone.
  //
  // UNLIKE the comment-axis regression (F5/F6, above), this is not
  // probabilistic — it does not depend on a non-monotonic id landing below
  // a watermark. Every body edit bumps Confluence's own `version.number`
  // by exactly 1 (this fake's `updatePage`/`getPageVersions` mirror that
  // real behavior); there is no scenario where it does NOT diverge from a
  // watermark nothing ever touches.
  test("a project's own set_doc call (a REAL setProjectDoc write, not a hand-set version number) leaves the version watermark behind and reads active on the next poll — comment and epics axes stay fully caught up", async () => {
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
    expect(resource.watermark.version).toBe(5); // never advanced — only check_in could
    expect(resource.observedCommentId).toBe(resource.watermark.comment); // comment axis: still caught up, untouched by this edit
    expect(verdict).toBe("active"); // wakes on the version axis alone

    // Traced through to an actual spawn decision, same as the comment-axis
    // test above — this is not merely a predicate curiosity.
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

describe("THE SPECIMEN'S MECHANISM: non-monotonic Confluence ids turn the suppression's OWN bookkeeping into a self-wake (F5/F6)", () => {
  // Failure condition for this whole block: if this does NOT reproduce
  // "active" from a write that never involved a foreign comment, then F5 is
  // FALSIFIED (the blind overwrite never fires in the regressing direction)
  // and the epic's hypothesis-to-kill is dead — that would itself be the
  // finding to report. It DOES reproduce below, so F5/F6 are CONFIRMED live
  // in today's code: `advanceProjectWatermark` is a blind overwrite (no max,
  // no monotonic guard — see its own source) and `newestCommentId` is a
  // pure max-by-numeric-id reduce over ALL comments including ones the
  // watermark write skipped past.
  test("a daemon complaint (frozen-asleep's own addComment, via the REAL speakOnOwnChannel seam) posted with a LOWER id than an already-caught-up watermark regresses the watermark and WAKES the project — with zero foreign comments involved", async () => {
    // Set up: the project already checked in once, caught up to the highest
    // id then on the page (id "500") — an entirely ordinary, healthy state.
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
    // The watermark was blindly overwritten to the LOWER just-posted id...
    expect(resource.watermark.comment).toBe("300");
    // ...while the true numeric max on the page is still "500" (the
    // suppression write never looked at it) — the mismatch this ticket's
    // hypothesis predicts.
    expect(resource.observedCommentId).toBe("500");
    // ...and the project WAKES, purely from its own suppressed write. This
    // is the specimen's reported shape: "wakes on a stale comment rather
    // than on the complaint itself."
    expect(verdict).toBe("active");

    // F6 — traced through to an ACTUAL SPAWN DECISION, not reasoned on
    // paper: `desiredFrom` (src/daemon/loop.ts) is the real function whose
    // output the reconciler spawns from (`spawn = desired − running`), and
    // it includes exactly the `"active"`-verdict resources. This resource
    // lands in it.
    const resourceType = createProjectResourceType(w.deps);
    const allProjects = await resourceType.discovery.search();
    const desired = desiredFrom(allProjects, resourceType);
    expect(desired.has("ACME")).toBe(true);
  });

  test("contrast: check_in's OWN write pattern (max over currently-observed comments, not the just-posted id) does not regress the watermark under the identical non-monotonic scenario", async () => {
    // Same page state as above, but this simulates `check_in`'s actual
    // write shape (src/tools/defs.ts): it computes `comment` as the max id
    // over what it just observed, and that's what it hands to
    // advanceProjectWatermark — never the id of one specific write.
    const w = world({
      projectKey: "ACME",
      rootDocId: "doc-1",
      initialComments: [{ id: "500", body: "<p>earlier</p>" }, { id: "300", body: "<p>[butchr:frozen] ...</p>" }],
      initialWake: { version: 1, comment: "500", epics: {} },
    });
    const observed = (await w.ops.getPageComments("doc-1")).results;
    await advanceProjectWatermark(w.ops, "ACME", { comment: newestCommentId(observed)! });
    const { verdict, resource } = await verdictOf(w.deps, "ACME");
    expect(resource.watermark.comment).toBe("500"); // unchanged — still the true max
    expect(verdict).toBe("asleep");
  });
});

describe("F7: the swallowed watermark-write failure reproduces the SAME symptom, by a DIFFERENT mechanism than F5/F6's regression", () => {
  // Failure condition: if the watermark write rejects and the project does
  // NOT end up "active" on the next poll, F7 is dead — the swallow would be
  // harmless. It does not come back dead below: a write failure leaves the
  // OLD watermark in place while a brand-new (even normal, HIGHER-id)
  // complaint has already landed on the page — same "active" outcome as
  // F5/F6, but the watermark here is simply stale, never regressed.
  test("commentOnPage succeeds (id 501, perfectly monotonic) but the watermark write rejects — the .catch swallows it, and the project wakes anyway", async () => {
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
    expect(lines.some((l) => l.includes("WARNING") && l.includes("watermark advance failed"))).toBe(true);
    const { verdict, resource } = await verdictOf(w.deps, "ACME");
    expect(resource.watermark.comment).toBe("500"); // never advanced
    expect(resource.observedCommentId).toBe("501"); // the new comment IS on the page
    expect(verdict).toBe("active");
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
