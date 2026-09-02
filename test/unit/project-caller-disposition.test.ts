import { describe, expect, test } from "bun:test";
import { atlassianTools } from "../../src/tools/defs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

/**
 * BUTCHR-82: BUTCHR-65 made a project-keyed caller first-class across the
 * whole MCP tool surface and proved its enumeration complete — 27 registry
 * keys, diffed both directions, zero gaps. That was a ONE-TIME check. Nothing
 * failed when a 28th verb landed with no project-caller decision recorded
 * anywhere a guard could see — and one did, within an hour of this ticket
 * being filed (`correct_worker`, BUTCHR-41/BUTCHR-60; see below). This file
 * is the enforced version, run at `bun run check` time via `test:unit`.
 *
 * THE DEFAULT THIS ENFORCES: refuse-until-declared. A verb absent from
 * DISPOSITIONS below fails the first test in this file immediately. There is
 * no "assume caller-agnostic and let it through" fallback — that was the
 * unsafe default already in the code (`refuseProjectCaller` is opt-in per
 * verb; a verb that calls nothing is silently ALLOWED for a project caller
 * today) and inverting it is the epic's explicit ruling on this ticket.
 *
 * "DECLARED" MEANS A HUMAN WROTE AN ENTRY HERE — never inferred from what a
 * verb's handler happens to call. `correct_worker` is the reason this
 * distinction is load-bearing rather than pedantic: its project-caller
 * support is REAL (`assertOwnWorker` in relationship.ts has an explicit
 * `isProjectId` branch) but it calls neither `refuseProjectCaller` nor
 * `requireProjectCaller` — a guard keyed on "does it call the gate helper"
 * would read a DELIBERATELY DECIDED verb as an UNDECIDED one. A verb's
 * disposition is only "declared" once it has a line in DISPOSITIONS; the
 * point of that map being hand-authored, not derived, is that adding a verb
 * and forgetting this file is the failure this guard exists to catch.
 *
 * FOUR DISPOSITIONS, exactly one required per verb:
 *
 *   "refuses"       Throws for a project caller (`refuseProjectCaller` in
 *                   defs.ts), naming why. 3 verbs today: submit_to_boss,
 *                   finish_without_a_boss, file_where_it_belongs.
 *
 *   "project-only"  The inverse: throws for an ISSUE caller instead — the
 *                   verb only means anything for a project
 *                   (`requireProjectCaller`). 1 verb today: check_in.
 *
 *   "permitted"     WORKS for a project caller, with behaviour that may
 *                   differ from the issue-caller case. Every "permitted"
 *                   verb must ALSO say so in its own description — checked
 *                   below — because that is the half a runtime-only guard
 *                   cannot see: correct_worker's CODE was always correctly
 *                   decided; its DESCRIPTION was the thing that lied ("no
 *                   AGENT can ever correct an epic's description"), and a
 *                   guard that only drove behaviour would have sailed past
 *                   that defect while it shipped. A "permitted" entry whose
 *                   description is silent about a project caller is that
 *                   same defect recurring, and this file's marker check is
 *                   what makes it fail instead of shipping quietly again.
 *
 *   "agnostic"      Takes an explicit target (`key`, `projectKey`, …) and
 *                   never inspects the CALLER's own identity shape at all —
 *                   the eight jira_* / five confluence_* passthroughs. A
 *                   project caller and an issue caller get byte-identical
 *                   treatment by construction, so there is nothing for a
 *                   description to declare.
 *
 * WHAT THIS DOES NOT CATCH — stated plainly rather than left to be assumed:
 *   - It does not prove a "permitted" verb's description is TRUE, only that
 *     it mentions a project caller at all. A description could name the
 *     wrong behaviour and still pass this file's marker check.
 *   - It does not prove an "agnostic" verb never reads `x-issue` for its own
 *     shape — that classification is a human judgment call recorded here,
 *     checked for registry-membership consistency, not verified by tracing
 *     the handler's source.
 *   - It says nothing about a verb's ISSUE-caller behaviour at all — out of
 *     scope for this ticket by design.
 * A guard described as stronger than this would be worse than the gap it
 * replaces; see this ticket's Confluence doc for the same statement kept
 * current.
 *
 * EVERY PIN BELOW THAT NAMES A LIVE VERB — the disposition map itself, and
 * the marker check on the "permitted" bucket — is an assertion about an
 * artefact this file does not own: another story can legitimately change
 * what a verb's disposition should be. When that happens, THIS FILE SHOULD
 * GO RED, and that red is correct: it means the map or a description needs
 * updating to match the new decision, not that this guard is broken. DO NOT
 * DELETE OR LOOSEN AN ASSERTION HERE TO GET GREEN — update DISPOSITIONS (and,
 * for a "permitted" verb, its description) to reflect the decision that was
 * actually made, the same way BUTCHR-41/60 fixed correct_worker's text
 * instead of deleting the test that caught it.
 */

type Disposition = "refuses" | "project-only" | "permitted" | "agnostic";

const DISPOSITIONS: Record<string, Disposition> = {
  // Refuses a project caller outright, at the tool-registration gate
  // (`refuseProjectCaller`, defs.ts) — each names why in its own message.
  submit_to_boss: "refuses",
  finish_without_a_boss: "refuses",
  file_where_it_belongs: "refuses",

  // Exists ONLY for a project caller; refuses an issue caller instead
  // (`requireProjectCaller`, defs.ts — the gate runs in the opposite
  // direction from the bucket above).
  check_in: "project-only",

  // Works for a project caller, with caller-shape-specific behaviour
  // documented in each verb's own description (checked below).
  new_worker: "permitted",
  start_worker: "permitted",
  shelve_worker: "permitted",
  adopt_worker: "permitted",
  finish_worker: "permitted",
  prioritize_worker: "permitted",
  // BUTCHR-41/BUTCHR-60: deliberately PERMITTED — a project agent may
  // correct one of its own epics — with NO gate call at all. This is the
  // verb that proves "calls refuseProjectCaller" cannot be this guard's
  // marker for "declared": a deliberately-decided verb that calls nothing
  // would misread as undecided under that marker. Its entry here is the
  // active declaration; do not remove it on the theory that "it calls
  // nothing, so it must be agnostic" — it is not: assertOwnWorker branches
  // on isProjectId for it specifically.
  correct_worker: "permitted",
  tell_worker: "permitted",
  report_to_boss: "permitted",
  ask_boss: "permitted",
  get_doc: "permitted",
  set_doc: "permitted",

  // Pure Atlassian passthroughs: act on an explicit argument, never on the
  // CALLER's own identity — verified not to require an x-issue at all below.
  jira_get_issue: "agnostic",
  jira_search: "agnostic",
  jira_link_issues: "agnostic",
  jira_add_comment: "agnostic",
  jira_transition: "agnostic",
  jira_create_issue: "agnostic",
  jira_set_priority: "agnostic",
  jira_assign: "agnostic",
  confluence_create_page: "agnostic",
  confluence_update_page: "agnostic",
  confluence_search_pages: "agnostic",
  confluence_get_page: "agnostic",
  confluence_list_spaces: "agnostic",
};

/**
 * The actual guard mechanism, factored out so the SAME function is proven,
 * below, to both fail on an undeclared verb and pass once one is declared —
 * rather than trusting that the inline `expect` on the real registry would
 * have caught a bug in this diffing logic itself.
 */
function diffAgainstDispositions(registryKeys: readonly string[], dispositions: Readonly<Record<string, Disposition>>): string[] {
  const problems: string[] = [];
  const declared = new Set(Object.keys(dispositions));
  const registry = new Set(registryKeys);
  for (const key of registryKeys) {
    if (!declared.has(key)) {
      problems.push(
        `\`${key}\` exists in the tool registry but has no entry in DISPOSITIONS (test/unit/project-caller-disposition.test.ts) — ` +
          `a new verb must declare what it means for a project caller before it can ship. Add an entry choosing one of ` +
          `"refuses" | "project-only" | "permitted" | "agnostic" (see this file's header comment for what each means), and if ` +
          `it is "permitted", make sure the verb's own description in src/tools/defs.ts says so — the marker check below requires it.`,
      );
    }
  }
  for (const key of declared) {
    if (!registry.has(key)) {
      problems.push(
        `DISPOSITIONS (test/unit/project-caller-disposition.test.ts) declares \`${key}\`, which no longer exists in the tool ` +
          `registry — remove the stale entry (the verb was renamed or removed from src/tools/defs.ts).`,
      );
    }
  }
  return problems;
}

/** No-argument fixture rig, `x-issue` supplied per test. */
function realRegistryKeys(): string[] {
  return Object.keys(atlassianTools({} as AtlassianOps));
}

describe("project-caller disposition enumeration (BUTCHR-82) — refuse-until-declared", () => {
  test("every verb in the real registry has a declared disposition, and every declared disposition names a real verb", () => {
    const problems = diffAgainstDispositions(realRegistryKeys(), DISPOSITIONS);
    // If this goes red on a REAL verb (not the constructed one two tests
    // below), the fix is DISPOSITIONS, not this assertion: read the failure
    // message, pick a disposition, and — if it is "permitted" — check the
    // verb's description carries a project-caller mention. Do not delete or
    // weaken this check to get green; an undeclared verb going undetected
    // is the exact defect this file exists to prevent.
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // --- The guard-for-the-guard: proves the mechanism above can actually
  // fail, using a verb THIS TEST CONSTRUCTS AND OWNS — never a live one.
  // An earlier draft of this demonstration used `correct_worker` itself as
  // the "currently undecided" example; it stopped being true mid-ticket
  // when BUTCHR-41/60 decided it, which is exactly the failure mode this
  // shape avoids: a control borrowed from the live system is a control any
  // other story can revise out from under this test, and it fails in the
  // most seductive direction — green because the world moved, not because
  // the guard works. A throwaway verb name nobody else can touch is immune
  // to that. ---
  const CONSTRUCTED_VERB = "a_throwaway_verb_nobody_decided__butchr_82";

  test("RED: the check fails on a constructed verb with no declared disposition", () => {
    const registryKeys = [...realRegistryKeys(), CONSTRUCTED_VERB];
    const problems = diffAgainstDispositions(registryKeys, DISPOSITIONS);
    expect(problems.some((p) => p.includes(CONSTRUCTED_VERB))).toBe(true);
  });

  test("GREEN: the same constructed verb passes once it is given a disposition", () => {
    const registryKeys = [...realRegistryKeys(), CONSTRUCTED_VERB];
    const decided: Record<string, Disposition> = { ...DISPOSITIONS, [CONSTRUCTED_VERB]: "agnostic" };
    const problems = diffAgainstDispositions(registryKeys, decided);
    expect(problems).toEqual([]);
  });

  test('every "permitted" verb\'s own description mentions a project caller — the half a runtime-only guard misses', () => {
    // This is the mechanism that would have caught correct_worker's now-fixed
    // false claim ("no AGENT can ever correct an epic's description"): that
    // verb's CODE was always correctly decided (assertOwnWorker's isProjectId
    // branch), but its DESCRIPTION never said a project caller could use it
    // at all — silent, not merely wrong. A "permitted" verb whose description
    // never mentions a project caller is that same shape of defect.
    //
    // This does NOT prove the description is accurate, only that it is not
    // silent — see this file's header comment for that limit stated plainly.
    // If a future "permitted" verb legitimately has nothing project-caller-
    // specific worth documenting, that is a reason to reconsider whether
    // "permitted" is the right disposition for it, not a reason to loosen
    // this regex.
    const tools = atlassianTools({} as AtlassianOps);
    const marker = /project[- ]?(keyed )?caller/i;
    const silent = Object.entries(DISPOSITIONS)
      .filter(([, disposition]) => disposition === "permitted")
      .map(([key]) => key)
      .filter((key) => !marker.test(tools[key]?.description ?? ""));
    expect(
      silent,
      `these "permitted" verbs never mention a project caller anywhere in their own description: ${silent.join(", ")} — ` +
        `a verb whose code decided PERMITTED but whose description stays silent is the exact defect this test exists to catch ` +
        `(see BUTCHR-41/BUTCHR-60's correct_worker, which shipped that way for a time). Fix the description in src/tools/defs.ts; ` +
        `do not delete or loosen this assertion to get green.`,
    ).toEqual([]);
  });
});

/** Every op rejects — used for verbs whose disposition means they throw before ever touching `ops`. A call that reaches an op here is a test bug, not a passing behaviour. */
function unreachableOps(): AtlassianOps {
  const unreachable = (name: string) => async () => {
    throw new Error(`unreachable: ops.${name} was called — this verb was expected to refuse before touching ops`);
  };
  return {
    getIssue: unreachable("getIssue"),
    search: unreachable("search"),
    addComment: unreachable("addComment"),
    linkIssues: unreachable("linkIssues"),
    transition: unreachable("transition"),
    createIssue: unreachable("createIssue"),
    setPriority: unreachable("setPriority"),
    assign: unreachable("assign"),
    correctText: unreachable("correctText"),
    createPage: unreachable("createPage"),
    getPage: unreachable("getPage"),
    updatePage: unreachable("updatePage"),
    searchPages: unreachable("searchPages"),
    listSpaces: unreachable("listSpaces"),
    getProjectProperty: unreachable("getProjectProperty"),
    getProjectPropertyOrNull: unreachable("getProjectPropertyOrNull"),
    getRemoteLink: unreachable("getRemoteLink"),
    upsertRemoteLink: unreachable("upsertRemoteLink"),
    getChildPages: unreachable("getChildPages") as unknown as AtlassianOps["getChildPages"],
    getPageLabels: unreachable("getPageLabels") as unknown as AtlassianOps["getPageLabels"],
    createPageWithLabel: unreachable("createPageWithLabel") as unknown as AtlassianOps["createPageWithLabel"],
    addLabels: unreachable("addLabels"),
    removeLabels: unreachable("removeLabels"),
    deleteIssue: unreachable("deleteIssue"),
    commentOnPage: unreachable("commentOnPage"),
    getPageComments: unreachable("getPageComments") as unknown as AtlassianOps["getPageComments"],
    searchProjects: unreachable("searchProjects") as unknown as AtlassianOps["searchProjects"],
    getMyself: unreachable("getMyself") as unknown as AtlassianOps["getMyself"],
    setProjectProperty: unreachable("setProjectProperty"),
    getPageVersions: unreachable("getPageVersions") as unknown as AtlassianOps["getPageVersions"],
    getIssueComments: unreachable("getIssueComments") as unknown as AtlassianOps["getIssueComments"],
  };
}

const PROJECT_CALLER = { headers: { "x-issue": "BUTCHR" } } as any;
const ISSUE_CALLER = { headers: { "x-issue": "BUTCHR-1" } } as any;

describe('project-caller disposition enumeration (BUTCHR-82) — "refuses" and "project-only" verbs actually behave that way', () => {
  const refusesVerbs = Object.entries(DISPOSITIONS)
    .filter(([, d]) => d === "refuses")
    .map(([key]) => key);
  const projectOnlyVerbs = Object.entries(DISPOSITIONS)
    .filter(([, d]) => d === "project-only")
    .map(([key]) => key);

  // Sanity on the buckets themselves — if a future edit to DISPOSITIONS
  // leaves one of these empty, the loops below would silently assert
  // nothing and this file would look green while checking less than it
  // claims to. Pinned to the counts this ticket found: 3 "refuses" verbs
  // (submit_to_boss, finish_without_a_boss, file_where_it_belongs) and 1
  // "project-only" verb (check_in). If a FUTURE verb is legitimately added
  // to either bucket, this assertion SHOULD go red — that is correct, not a
  // bug: update the expected count here to match the new, deliberate total.
  // Do not delete this assertion to get green; update the number.
  test("both buckets are non-empty (guards the loops below against silently checking nothing)", () => {
    expect(refusesVerbs.length).toBe(3);
    expect(projectOnlyVerbs.length).toBe(1);
  });

  for (const verb of refusesVerbs) {
    test(`${verb}: a project caller is refused, by name, before any Atlassian call`, async () => {
      const tools = atlassianTools(unreachableOps(), () => {});
      const handler = tools[verb]!.handler;
      await expect(handler({}, PROJECT_CALLER)).rejects.toThrow(/refusing a project caller/);
    });
  }

  for (const verb of projectOnlyVerbs) {
    test(`${verb}: an ISSUE caller is refused, by name, before any Atlassian call — the gate runs the opposite direction from "refuses"`, async () => {
      const tools = atlassianTools(unreachableOps(), () => {});
      const handler = tools[verb]!.handler;
      await expect(handler({}, ISSUE_CALLER)).rejects.toThrow(/refusing an issue caller/);
    });
  }
});

describe('project-caller disposition enumeration (BUTCHR-82) — "agnostic" verbs take no x-issue-shape branch at all', () => {
  const agnosticVerbs = Object.entries(DISPOSITIONS)
    .filter(([, d]) => d === "agnostic")
    .map(([key]) => key);

  test("the bucket is non-empty (guards the loop below against silently checking nothing)", () => {
    expect(agnosticVerbs.length).toBe(13);
  });

  // These verbs are declared "agnostic" because they act on an explicit
  // argument, never the caller's own identity shape — so a missing `x-issue`
  // header must not throw the caller-shape refusals "refuses" / "project-
  // only" verbs use. It may still throw for unrelated reasons (a required
  // field genuinely missing from `{}`); this only checks it is never THIS
  // family of refusal, which is the one a wrong disposition would produce.
  for (const verb of agnosticVerbs) {
    test(`${verb}: never refuses on caller SHAPE — no x-issue header produces no caller-shape refusal`, async () => {
      const tools = atlassianTools(unreachableOps(), () => {});
      const handler = tools[verb]!.handler;
      const noHeaderConn = { headers: {} } as any;
      try {
        await handler({}, noHeaderConn);
      } catch (e) {
        expect((e as Error).message).not.toMatch(/refusing a project caller|refusing an issue caller/);
      }
    });
  }
});
