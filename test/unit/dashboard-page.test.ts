import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderDashboard, type RenderDashboardOpts } from "../../src/web/dashboard-page.js";
import {
  buildDashboardRows,
  buildAdmissionView,
  updateWithheldRows,
  createDashboardFeed,
  type DashboardAgent,
  type DashboardResponse,
} from "../../src/agents/dashboard.js";
import { createAdmissionController } from "../../src/agents/admission.js";
import { StatusFloorTracker } from "../../src/agents/status-floor.js";

function agent(name: string, status = "idle", pane = "p1"): DashboardAgent {
  return { name, resource_key: name.replace(/^butchr[-:]/, "").toUpperCase(), agent_status: status, pane_id: pane };
}

const NO_ADMISSION = { cap: 0, residency: null, sources: [] as const };

/**
 * Extracts the inner text of the FIRST element whose opening tag contains
 * `openTagMarker` (e.g. `class="na"`), up to the next `closeTag`. Scopes a
 * wording assertion to ONE SPECIFIC ELEMENT rather than "does this substring
 * appear anywhere on the page" — a page with more than one row, or a row
 * whose OTHER fields also happen to render the same could-not-check text
 * (e.g. an agent row's own tier), can make an unscoped `toContain` pass even
 * when the element actually under test has been mutated. Found the hard way
 * (BUTCHR-266's review): two of its own mutations — the not-applicable
 * marker's text swapped for could-not-check wording, and the whole-page
 * banner's text swapped for reassuring prose — both kept their CSS class and
 * both survived the full suite, because the surviving assertions checked
 * class presence and a page-wide substring, never this element's own words.
 */
function elementText(html: string, openTagMarker: string, closeTag: string): string {
  const tagStart = html.indexOf(openTagMarker);
  if (tagStart === -1) throw new Error(`expected to find an element with ${JSON.stringify(openTagMarker)} in the rendered HTML`);
  const contentStart = html.indexOf(">", tagStart) + 1;
  const contentEnd = html.indexOf(closeTag, contentStart);
  if (contentEnd === -1) throw new Error(`expected a ${closeTag} after ${JSON.stringify(openTagMarker)}`);
  return html.slice(contentStart, contentEnd);
}

function opts(over: Partial<RenderDashboardOpts> = {}): RenderDashboardOpts {
  return {
    now: 0,
    header: { build: { sha: "a".repeat(40), shaDirty: false, shaUnknownReason: null, version: "1.2.3" } },
    terminalLinkHref: (pane) => `/agents/pane/${encodeURIComponent(pane)}/attach`,
    resourceLinkHref: (key) => `/resource/${encodeURIComponent(key)}/open`,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Baseline: real rows, driven through the real producers (never a hand-built
// fixture that merely happens to typecheck — the ticket's own instruction).
// ---------------------------------------------------------------------------
describe("renderDashboard: agent rows, driven by the real buildDashboardRows (BUTCHR-339)", () => {
  test("an issue-tier row renders resourceKey, issuetype, agentStatus, and both links built from the injected href functions", () => {
    const now = 10_000;
    const meta = new Map([["BUTCHR-1", { summary: "s", issuetype: "Task" }]]);
    const rows = buildDashboardRows([agent("butchr-butchr-1", "working", "w1:p3")], {
      now: () => now,
      issueMeta: (k) => meta.get(k),
      tracker: new StatusFloorTracker(() => now),
    });
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(now).toISOString(), rows, admission: NO_ADMISSION };
    const html = renderDashboard(response, opts({ now }));
    expect(html).toContain("BUTCHR-1");
    expect(html).toContain("Task");
    expect(html).toContain('class="st working"');
    expect(html).toContain(`href="/agents/pane/${encodeURIComponent("w1:p3")}/attach"`);
    expect(html).toContain(`href="/resource/${encodeURIComponent("BUTCHR-1")}/open"`);
  });

  test("a project-tier row renders tier 'project' — no issuetype to know or decline", () => {
    const rows = buildDashboardRows([agent("butchr-butchr", "idle", "p2")], { now: () => 0, issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0) });
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: NO_ADMISSION };
    expect(renderDashboard(response, opts())).toContain(">project<");
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-342: the pane is one of the five fields BUTCHR-266 requires as
// VISIBLE text on every agent row — not merely present somewhere in the HTML
// (it was already present, inside the terminal link's href, which is exactly
// the bug this ticket fixes). `elementText`, scoped to the dedicated `.pane`
// element, is what makes this assertion fail on the pre-fix code regardless
// of the pane's spelling: the href is built with `encodeURIComponent`, so a
// pane containing a character that needs escaping (e.g. the colon in
// "w1:p3") never appears as a raw substring pre-fix — but a pane with no
// such characters (e.g. "p1") DOES survive unescaped inside the href, so an
// unscoped `toContain(pane)` can still pass on the unfixed code for those
// panes. Scoping to the `.pane` element removes that dependence on spelling:
// confirmed by running this test against the pre-fix render (the href-only
// version, before the `.pane` span was added) and watching it fail with
// "expected to find an element with class=\"pane\"".
// ---------------------------------------------------------------------------
describe("renderDashboard: the pane is visible text on every agent row (BUTCHR-342)", () => {
  test("an agent row renders its pane as its own visible element, escaped, distinct from the terminal link's href", () => {
    const rows = buildDashboardRows([agent("butchr-butchr-1", "working", "w1:p3")], {
      now: () => 0,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => 0),
    });
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: NO_ADMISSION };
    const html = renderDashboard(response, opts());
    expect(elementText(html, 'class="pane"', "</span>")).toBe("w1:p3");
  });

  test("a withheld row (real updateWithheldRows, cap 0) renders no pane and no pane slot at all — a withheld row has no agent, so no pane to show", async () => {
    const controller = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue"] });
    await controller.admit(["BUTCHR-99"], [], "issue");
    const census = controller.census();
    const withheldRows = updateWithheldRows(census, new Map(), { issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0), agentKeys: new Set() });
    const rows = [...withheldRows.values()].flat();
    expect(rows).toHaveLength(1);
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: buildAdmissionView(census) };
    const html = renderDashboard(response, opts());
    expect(html).not.toContain('class="pane"');
  });
});

// ---------------------------------------------------------------------------
// Mutation 1: a could-not-check value rendered like a known value — all THREE
// sub-cases the ticket names (whole response, a row's issuetype, a census
// source). Each assertion below is a NAMED test that fails if the
// corresponding could-not-check branch in dashboard-page.ts is deleted or
// collapsed into the "known" one.
// ---------------------------------------------------------------------------
describe("renderDashboard: mutation 1 — could-not-check rendered like known (three sub-cases, BUTCHR-339)", () => {
  test("1a. whole response: a failed agent-list read (checked:false) renders the loud banner, never the calm confirmed styling, and carried-forward rows render STALE", async () => {
    const admission = createAdmissionController({ cap: 10, residency: async () => [] });
    const feed = createDashboardFeed({
      now: () => 1000,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => 1000),
      withheldTracker: new StatusFloorTracker(() => 1000),
      admission: () => admission.census(),
    });
    await feed.poll(async () => ({ agents: [agent("butchr-butchr-1", "working", "p1")] })); // succeeds
    await expect(feed.poll(async () => { throw new Error("boom"); })).rejects.toThrow(); // then fails
    const response = feed.snapshot();
    expect(response.checked).toBe(false);

    const html = renderDashboard(response, opts({ now: 5000 }));
    expect(html).toContain('class="pagefresh cnc banner"');
    expect(html).not.toContain('class="pagefresh known"');
    // THE WORDING ITSELF, scoped to the banner element and case-insensitive
    // (BUTCHR-266's review): a mutation that keeps the loud `cnc banner`
    // class but swaps the TEXT for reassuring prose ("All good.") must fail
    // here — checking for "COULD NOT CHECK" anywhere on the page is not
    // enough, because this response's own row ALSO renders could-not-check
    // tier text, which would let a mutated, reassuring banner hide behind
    // the row's unrelated wording.
    const bannerText = elementText(html, 'class="pagefresh cnc banner"', "</div>");
    expect(bannerText.toLowerCase()).toContain("could not check");
    // the carried-forward row must read STALE, never as a fresh confirmation
    expect(html).toContain('class="conf cnc"');
    expect(html).not.toContain('class="conf known"');
    // BUTCHR-344 (A4): the class alone doesn't pin the badge's own WORDING —
    // scope to the carried-forward row's own freshness element and assert
    // its required text: "at least X" (never a bare age, which is what
    // dropping the "at least " prefix would leave behind) and "as of
    // <its own confirmedAt>" (the row's OWN timestamp, from the poll at
    // now:1000, not the response-level declinedAt).
    const staleConfText = elementText(html, 'class="conf cnc"', "</span>");
    expect(staleConfText).toContain("at least");
    expect(staleConfText).toContain("as of");
    expect(staleConfText).toContain(new Date(1000).toISOString());
  });

  test("1b. a row's issuetype: an unavailable issuetype renders the cnc tier marker, never the plain known styling", () => {
    const rows = buildDashboardRows([agent("butchr-butchr-1", "idle", "p1")], { now: () => 0, issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0) });
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: NO_ADMISSION };
    const html = renderDashboard(response, opts());
    expect(html).toContain('class="tier cnc"');
    expect(elementText(html, 'class="tier cnc"', "</span>").toLowerCase()).toContain("could not check");
    expect(html).not.toContain('class="tier known"');
  });

  test("1c. a census source: a never-reported source renders could-not-check for itself, never as an ordinary checked source", async () => {
    const controller = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue", "project"] });
    await controller.admit(["KAN-1"], [], "issue"); // "issue" reports; "project" never calls admit
    const census = controller.census();
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: buildAdmissionView(census) };
    const html = renderDashboard(response, opts());
    expect(html).toMatch(/data-source="project">project: COULD NOT CHECK — never-reported/);
    expect(html).not.toMatch(/data-source="project">project: checked/);
  });
});

// ---------------------------------------------------------------------------
// Mutation 2: not-applicable rendered as could-not-check, AND the reverse —
// including the "single row carries both at once" case the ticket calls out
// by name.
// ---------------------------------------------------------------------------
describe("renderDashboard: mutation 2 — not-applicable vs could-not-check, never conflated, even on the SAME row (BUTCHR-339)", () => {
  test("a withheld row with an unresolved issuetype carries BOTH the cnc tier marker AND the na agent marker, styled distinctly", async () => {
    const controller = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue"] });
    await controller.admit(["BUTCHR-99"], [], "issue"); // withheld (cap 0), issueMeta below has no entry -> could-not-check issuetype
    const census = controller.census();
    const withheldRows = updateWithheldRows(census, new Map(), { issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0), agentKeys: new Set() });
    const rows = [...withheldRows.values()].flat();
    expect(rows).toHaveLength(1);
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: buildAdmissionView(census) };
    const html = renderDashboard(response, opts());

    expect(html).toContain('class="tier cnc"'); // could-not-check issuetype
    expect(html).toContain('class="na"'); // not-applicable agent marker
    // NEVER SWAPPED — THE WORDING ITSELF, scoped to each element and
    // CASE-INSENSITIVE (BUTCHR-266's review: a mutation that kept class="na"
    // but changed its text to "could not check" — lowercase — survived a
    // case-sensitive regex check here). The na marker must never carry
    // could-not-check wording in ANY case, and the cnc tier marker must
    // never carry the na wording, in either case.
    const naText = elementText(html, 'class="na"', "</span>").toLowerCase();
    expect(naText).not.toContain("could not check");
    expect(naText).toContain("no agent"); // still says what it actually is
    const tierText = elementText(html, 'class="tier cnc"', "</span>").toLowerCase();
    expect(tierText).not.toContain("no agent");
    expect(tierText).toContain("could not check");
  });

  test("reverse: an ordinary agent row (a real pane + agentStatus) never renders the not-applicable marker — nothing about it is inapplicable", () => {
    const meta = new Map([["BUTCHR-1", { summary: "s", issuetype: "Task" }]]);
    const rows = buildDashboardRows([agent("butchr-butchr-1", "idle", "p1")], { now: () => 0, issueMeta: (k) => meta.get(k), tracker: new StatusFloorTracker(() => 0) });
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: NO_ADMISSION };
    expect(renderDashboard(response, opts())).not.toContain('class="na"');
  });
});

// ---------------------------------------------------------------------------
// Mutation 3: a failed/never-reported census source rendered as an ordinary
// busy fleet, or smeared onto another source.
// ---------------------------------------------------------------------------
describe("renderDashboard: mutation 3 — per-source census independence, never smeared (BUTCHR-339)", () => {
  test("one checked source and one never-reported source render two INDEPENDENT lines — the checked one never carries the failed one's reason, and vice versa", async () => {
    const controller = createAdmissionController({ cap: 100, residency: async () => [], sources: ["issue", "project"] });
    await controller.admit(["KAN-1"], [], "issue"); // "issue" checked, nothing withheld (cap is high)
    const census = controller.census();
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: buildAdmissionView(census) };
    const html = renderDashboard(response, opts());
    expect(html).toMatch(/data-source="issue">issue: checked/);
    expect(html).toMatch(/data-source="project">project: COULD NOT CHECK — never-reported/);
    // smear-detector: neither source's own line mentions the other's state
    expect(html).not.toMatch(/data-source="issue">issue: COULD NOT CHECK/);
    expect(html).not.toMatch(/data-source="project">project: checked/);
    // never rendered as an ordinary, fully-healthy fleet: the failure text is present somewhere
    expect(html).toContain("never-reported");
  });
});

// ---------------------------------------------------------------------------
// Mutation 4: the time-in-status floor rendered without its "since daemon
// start" marking when exact is false, or buried rather than prominent.
// ---------------------------------------------------------------------------
describe("renderDashboard: mutation 4 — time-in-status: exact marking + visual prominence (BUTCHR-339)", () => {
  test("a fresh (exact:false) floor is marked 'since daemon start'; a real, witnessed transition (exact:true) is not", () => {
    const tracker = new StatusFloorTracker(() => 0);
    const first = buildDashboardRows([agent("butchr-butchr-1", "working", "p1")], { now: () => 0, issueMeta: () => undefined, tracker }); // first observation -> exact:false
    const inexactResponse: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: first, admission: NO_ADMISSION };
    expect(renderDashboard(inexactResponse, opts({ now: 0 }))).toContain("since daemon start");

    const trackerB = new StatusFloorTracker(() => 0);
    buildDashboardRows([agent("butchr-butchr-2", "working", "p1")], { now: () => 0, issueMeta: () => undefined, tracker: trackerB });
    const second = buildDashboardRows([agent("butchr-butchr-2", "idle", "p1")], { now: () => 5000, issueMeta: () => undefined, tracker: trackerB }); // witnessed transition -> exact:true
    const exactResponse: DashboardResponse = { checked: true, confirmedAt: new Date(5000).toISOString(), rows: second, admission: NO_ADMISSION };
    expect(renderDashboard(exactResponse, opts({ now: 5000 }))).not.toContain("since daemon start");
  });

  test("the time-in-status value renders inside its own dedicated, large element — never buried as a generic row cell", () => {
    const rows = buildDashboardRows([agent("butchr-butchr-1", "working", "p1")], { now: () => 0, issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0) });
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: NO_ADMISSION };
    const html = renderDashboard(response, opts());
    expect(html).toMatch(/<div class="floor"[^>]*><span class="floorval">/);
    // the dedicated CSS class carries a deliberately large font — "buried as
    // a generic cell" would mean this rule disappearing or shrinking, which
    // this string check pins directly.
    expect(html).toMatch(/\.floorval\{font-size:(2\d|[3-9]\d)px/);
  });

  test("a withheld row's `waiting` floor is marked on the SAME exact/prominence terms as an agent row's `timeInStatus`", async () => {
    const controller = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue"] });
    await controller.admit(["BUTCHR-1"], [], "issue");
    const census = controller.census();
    const withheldRows = updateWithheldRows(census, new Map(), { issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0), agentKeys: new Set() });
    const rows = [...withheldRows.values()].flat();
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: buildAdmissionView(census) };
    const html = renderDashboard(response, opts());
    expect(html).toMatch(/<div class="floor"[^>]*><span class="floorval">/);
    expect(html).toContain("since daemon start"); // first observation of this withheld ticket -> exact:false
  });

  // BUTCHR-266's review of the first draft: the PROMINENT number itself must
  // say "at least" when it is only a floor — a trailing note is not enough,
  // because the whole design intent is "read the big number at a glance."
  test("the floorval number itself is prefixed 'at least' when exact:false, and carries NO such prefix when exact:true (a witnessed transition is the genuine duration, not a lower bound)", () => {
    const tracker = new StatusFloorTracker(() => 0);
    const inexact = buildDashboardRows([agent("butchr-butchr-1", "working", "p1")], { now: () => 0, issueMeta: () => undefined, tracker });
    const exact = buildDashboardRows([agent("butchr-butchr-1", "idle", "p1")], { now: () => 5000, issueMeta: () => undefined, tracker }); // witnessed transition

    const inexactHtml = renderDashboard({ checked: true, confirmedAt: new Date(0).toISOString(), rows: inexact, admission: NO_ADMISSION }, opts({ now: 0 }));
    expect(inexactHtml).toMatch(/<span class="floorval">at least /);

    const exactHtml = renderDashboard({ checked: true, confirmedAt: new Date(5000).toISOString(), rows: exact, admission: NO_ADMISSION }, opts({ now: 5000 }));
    expect(exactHtml).toMatch(/<span class="floorval">(?!at least )/);
  });

  // BUTCHR-266's review: `floor.humanDuration` is baked in at POLL time, so a
  // bare display of it would sit frozen between polls even on the browser's
  // own auto-refresh — the render must recompute from the floor's anchor
  // (`sinceMs`) against ITS OWN `now`, so the number is live at every refresh.
  test("the floorval number is recomputed against render-time `now`, not frozen at whatever `humanDuration` was when the row was built", () => {
    const tracker = new StatusFloorTracker(() => 1000);
    const rows = buildDashboardRows([agent("butchr-butchr-1", "working", "p1")], { now: () => 1000, issueMeta: () => undefined, tracker }); // floor anchored at sinceMs=1000, humanDuration frozen at "0s"
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(1000).toISOString(), rows, admission: NO_ADMISSION };

    const atPollTime = renderDashboard(response, opts({ now: 1000 }));
    const tenSecondsLater = renderDashboard(response, opts({ now: 1000 + 10_000 })); // same response object — only `now` moved
    expect(atPollTime).toMatch(/floorval">at least 0s/);
    expect(tenSecondsLater).toMatch(/floorval">at least 10s/); // proves it's live, not stuck at the poll-time "0s"
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-266's review, question 2: a withheld row from a source whose census
// has since DECLINED is carried forward byte-identical (src/agents/dashboard.ts's
// updateWithheldRows) — its own confirmedAt stops advancing, but nothing
// beyond the admission panel said so. A withheld row's freshness badge must
// go stale in lockstep with ITS OWN source's panel entry, and ONLY that
// source's rows — never a source that is still checking in fine.
// ---------------------------------------------------------------------------
describe("renderDashboard: a withheld row from a currently-declined source renders STALE, scoped to that source only (BUTCHR-339, review gap #2)", () => {
  test("two withheld rows from two different sources: only the one whose source currently reports checked:false renders the stale freshness badge", async () => {
    const controller = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue", "project"] });
    await controller.admit(["BUTCHR-1"], [], "issue"); // "issue" checked, withholds BUTCHR-1
    // "project" never calls admit -> never-reported (declined)
    const census = controller.census();
    const withheldRows = [...updateWithheldRows(census, new Map(), { issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0), agentKeys: new Set() }).values()].flat();
    // Hand-add a second withheld row attributed to the declined "project"
    // source, carried forward exactly as `updateWithheldRows` would leave a
    // prior successful read untouched on a decline — the shape this test
    // needs is "a withheld row whose OWN source is currently declined",
    // which requires simulating a PRIOR successful poll for "project" (this
    // controller's "project" source has never reported at all, so there is
    // no prior row to carry forward from it in this call) — so this row is
    // built the same way `updateWithheldRows` builds any withheld row,
        // just attributed to the now-declined source directly.
    const projectRow = { ...withheldRows[0]!, resourceKey: "KAN", source: "project" };
    const rows = [...withheldRows, projectRow];

    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: buildAdmissionView(census) };
    const html = renderDashboard(response, opts());

    // The "issue" row (checked source) reads calm/known.
    expect(html).toContain('class="conf known" data-source="issue"');
    // The "project" row (declined source) reads STALE, scoped to itself.
    expect(html).toContain('class="conf cnc" data-source="project"');
    expect(html).not.toContain('class="conf cnc" data-source="issue"');
  });
});

// ---------------------------------------------------------------------------
// Mutation 5: the page's age taken from the browser clock/request time
// instead of the response's own confirmedAt/declinedAt.
// ---------------------------------------------------------------------------
describe("renderDashboard: mutation 5 — page age from the response's own confirmedAt/declinedAt, never a request-time clock (BUTCHR-339)", () => {
  test("holding confirmedAt fixed and varying `now` changes the rendered age proportionally — proving the age is DERIVED, not a fixed string", () => {
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(1_000_000).toISOString(), rows: [], admission: NO_ADMISSION };
    const soon = renderDashboard(response, opts({ now: 1_000_000 }));
    const sixDaysLater = renderDashboard(response, opts({ now: 1_000_000 + 6 * 86_400_000 }));
    expect(soon).toContain("0s ago");
    expect(sixDaysLater).toContain("6d");
    expect(soon).not.toBe(sixDaysLater);
    // the literal confirmedAt timestamp is always shown too, independent of `now`
    expect(soon).toContain(new Date(1_000_000).toISOString());
    expect(sixDaysLater).toContain(new Date(1_000_000).toISOString());
  });

  test("a could-not-check page's age comes from declinedAt (the ONLY time that arm carries), never confirmedAt", () => {
    const response: DashboardResponse = { checked: false, declinedAt: new Date(2_000_000).toISOString(), rows: [], admission: NO_ADMISSION };
    const html = renderDashboard(response, opts({ now: 2_000_000 + 60_000 }));
    expect(html).toContain("1m");
    expect(html).toContain(new Date(2_000_000).toISOString());
  });

  test("the empty-fleet finding still carries the page's own age — freshness is visible even with zero rows to carry it", () => {
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(500_000).toISOString(), rows: [], admission: NO_ADMISSION };
    const html = renderDashboard(response, opts({ now: 500_000 + 3000 }));
    expect(html).toContain("this daemon runs no agents");
    expect(html).toContain("3s ago");
  });
});

// ---------------------------------------------------------------------------
// Mutation 6: a terminal-link "launched" response rendered as confirmed, or a
// refusal/500 rendered as success or silence. The route's OWN honesty
// (src/web/view.ts's /agents/pane/:pane/attach) is exercised end-to-end in
// test/unit/app.test.ts ("a live pane launches and reports what actually
// happened, in plain text", and the three refusal tests alongside it) — this
// module never re-renders that response text at all, so the page-level
// contract is narrower: the link must be an ordinary href, never itself
// claiming success.
// ---------------------------------------------------------------------------
describe("renderDashboard: mutation 6 (page-level) — the terminal link is a plain href, never a success claim of its own (BUTCHR-339)", () => {
  test("the terminal link's own label never says 'launched'/'confirmed' — that reporting lives entirely on the route (see test/unit/app.test.ts)", () => {
    const rows = buildDashboardRows([agent("butchr-butchr-1", "working", "p1")], { now: () => 0, issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0) });
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: NO_ADMISSION };
    const html = renderDashboard(response, opts());
    expect(html).toMatch(/>open terminal</);
    expect(html).not.toMatch(/launched a terminal|confirmed a terminal/i);
  });
});

// ---------------------------------------------------------------------------
// Mutation 7 (page-level half): the template always defers to the injected
// resourceLinkHref, keyed on resourceKey, for BOTH row kinds — never a URL
// the template invents itself. The actual Jira-vs-Confluence DECISION is a
// route-level concern, pinned directly (with its own named, run tests) in
// test/unit/resource-link.test.ts's `resolveResourceLink` suite.
// ---------------------------------------------------------------------------
describe("renderDashboard: mutation 7 (page-level) — resource links always go through the injected resourceLinkHref, keyed on resourceKey (BUTCHR-339)", () => {
  test("an agent row's resource link is built from resourceLinkHref(resourceKey), not a URL the template invents", () => {
    const rows = buildDashboardRows([agent("butchr-butchr-1", "idle", "p1")], { now: () => 0, issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0) });
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: NO_ADMISSION };
    const calls: string[] = [];
    renderDashboard(response, opts({ resourceLinkHref: (key) => { calls.push(key); return `/marked/${key}`; } }));
    expect(calls).toEqual(["BUTCHR-1"]);
  });

  test("a withheld row's resource link is ALSO built from resourceLinkHref(resourceKey) — withheld rows are not exempted from having a working resource link", async () => {
    const controller = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue"] });
    await controller.admit(["BUTCHR-42"], [], "issue");
    const census = controller.census();
    const withheldRows = updateWithheldRows(census, new Map(), { issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0), agentKeys: new Set() });
    const rows = [...withheldRows.values()].flat();
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: buildAdmissionView(census) };
    const calls: string[] = [];
    renderDashboard(response, opts({ resourceLinkHref: (key) => { calls.push(key); return `/marked/${key}`; } }));
    expect(calls).toEqual(["BUTCHR-42"]);
  });
});

// ---------------------------------------------------------------------------
// Mutation 8: any status filled from a Jira label. Structural guarantee: this
// module (and the view layer it's wired into) imports nothing from
// src/labels/* — checked by scanning the actual source text, so a future
// import is caught even before any behavioural test would notice.
// ---------------------------------------------------------------------------
describe("renderDashboard: mutation 8 — never a Jira-label-derived status (BUTCHR-339)", () => {
  test("src/web/dashboard-page.ts and src/web/view.ts import nothing from src/labels/*", () => {
    for (const path of ["src/web/dashboard-page.ts", "src/web/view.ts"]) {
      const text = readFileSync(path, "utf8");
      // Matches any `import` statement — named, type-only, OR a bare
      // side-effect import with no `from` at all — whose quoted module
      // specifier contains "labels/". A `from`-only regex would miss
      // `import "../labels/plan.js"`, which has no `from` keyword.
      expect(text).not.toMatch(/^import\s[^\n]*["'][^"']*labels\/[^"']*["']/m);
    }
  });

  test("every status this page renders comes from the row's own agentStatus (herdr's domain), never a synthesized label value", () => {
    const rows = buildDashboardRows([agent("butchr-butchr-1", "blocked", "p1")], { now: () => 0, issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0) });
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: NO_ADMISSION };
    expect(renderDashboard(response, opts())).toContain('class="st blocked"');
  });
});

// ---------------------------------------------------------------------------
// DoD requirement 7: build currency (or the build sha) in the header, never
// turning anything red on its own, and the "behind by N" rule (ONLY when
// commitsAhead is exactly 0 — anything else, including null, renders as
// diverged/undetermined).
// ---------------------------------------------------------------------------
describe("renderDashboard: header build currency (BUTCHR-339 DoD 7)", () => {
  const build = { sha: "b".repeat(40), shaDirty: false, shaUnknownReason: null, version: "9.9.9" };
  const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: NO_ADMISSION };

  test("no currency sibling at all (older build): falls back to the build sha alone", () => {
    const html = renderDashboard(response, opts({ header: { build } }));
    expect(html).toContain(build.sha.slice(0, 8));
    expect(html).not.toContain("currency:");
  });

  test("current: renders 'current', never red (no cnc/warning class on the header line)", () => {
    const html = renderDashboard(response, opts({ header: { build, currency: { checkedAt: new Date(1000).toISOString(), verdict: { status: "current", base: { ref: "refs/remotes/origin/main", sha: "c".repeat(40), changedAt: null, changedAtUnknownReason: "x", fetchedAt: null, fetchedAtUnknownReason: "x" }, dirtyUndeterminable: false } } }, now: 1000 }));
    expect(html).toContain("currency: current");
    expect(html).not.toMatch(/hdrline build cnc|hdrline cnc/);
    // BUTCHR-344 (C2b): the opening tag itself must be EXACTLY this literal
    // — no inline style riding along beside the class. A class-only check
    // (or a regex rejecting one specific class spelling) still lets an
    // INLINE `style="color:#f85149;..."` through, because that's a
    // different attribute, not a different class.
    expect(html).toContain('<div class="hdrline build">');
  });

  test("stale with commitsAhead exactly 0: renders 'behind by N'", () => {
    const html = renderDashboard(response, opts({ header: { build, currency: { checkedAt: new Date(0).toISOString(), verdict: { status: "stale", commitsBehind: 42, commitsAhead: 0, base: { ref: "refs/remotes/origin/main", sha: "c".repeat(40), changedAt: null, changedAtUnknownReason: "x", fetchedAt: null, fetchedAtUnknownReason: "x" }, dirtyUndeterminable: false } } } }));
    expect(html).toContain("behind by 42");
    // BUTCHR-344 (C2b): pin class+style together for the STALE verdict too —
    // this is the exact verdict the epic's own C2b mutation targets (an
    // inline `style="color:#f85149;font-weight:700"` on a stale header).
    expect(html).toContain('<div class="hdrline build">');
  });

  test("stale with commitsAhead null: NEVER 'behind' — renders diverged/undetermined instead (the field's own documented rule)", () => {
    const html = renderDashboard(response, opts({ header: { build, currency: { checkedAt: new Date(0).toISOString(), verdict: { status: "stale", commitsBehind: null, commitsAhead: null, base: { ref: "refs/remotes/origin/main", sha: "c".repeat(40), changedAt: null, changedAtUnknownReason: "x", fetchedAt: null, fetchedAtUnknownReason: "x" }, dirtyUndeterminable: false } } } }));
    expect(html).not.toMatch(/behind by/);
    expect(html).toContain("diverged/undetermined");
  });

  test("stale with commitsAhead > 0: also diverged/undetermined, never 'behind'", () => {
    const html = renderDashboard(response, opts({ header: { build, currency: { checkedAt: new Date(0).toISOString(), verdict: { status: "stale", commitsBehind: 3, commitsAhead: 2, base: { ref: "refs/remotes/origin/main", sha: "c".repeat(40), changedAt: null, changedAtUnknownReason: "x", fetchedAt: null, fetchedAtUnknownReason: "x" }, dirtyUndeterminable: false } } } }));
    expect(html).not.toMatch(/behind by/);
    expect(html).toContain("diverged/undetermined");
  });

  test("unknown verdict: could-not-check wording, never rendered as current or stale, and checkedAt:null reads 'never computed yet'", () => {
    const html = renderDashboard(response, opts({ header: { build, currency: { checkedAt: null, verdict: { status: "unknown", reason: "no local base ref" } } } }));
    expect(html).toContain("could not determine — no local base ref");
    expect(html).toContain("never computed yet");
    expect(html).not.toContain("currency: current");
    // BUTCHR-344 (C2b): and the UNKNOWN verdict too — the ticket's own
    // instruction names current, stale, AND unknown as the three verdicts
    // this exact opening tag must be pinned for.
    expect(html).toContain('<div class="hdrline build">');
  });
});

// ---------------------------------------------------------------------------
// Row-kind discrimination: never assume one kind (dashboard.ts's own rule).
// ---------------------------------------------------------------------------
describe("renderDashboard: a response mixing agent and withheld rows renders both, distinctly (BUTCHR-339)", () => {
  test("an agent row and a withheld row in the same response render with different structural markers (.row.agent has a terminal link; .row.withheld does not)", async () => {
    const meta = new Map([["BUTCHR-1", { summary: "s", issuetype: "Task" }]]);
    const agentRows = buildDashboardRows([agent("butchr-butchr-1", "working", "p1")], { now: () => 0, issueMeta: (k) => meta.get(k), tracker: new StatusFloorTracker(() => 0) });
    const controller = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue"] });
    await controller.admit(["BUTCHR-2"], [], "issue");
    const census = controller.census();
    const withheldRows = [...updateWithheldRows(census, new Map(), { issueMeta: (k) => meta.get(k), tracker: new StatusFloorTracker(() => 0), agentKeys: new Set(agentRows.map((r) => r.resourceKey)) }).values()].flat();

    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: [...agentRows, ...withheldRows], admission: buildAdmissionView(census) };
    const html = renderDashboard(response, opts());
    expect(html).toContain('class="row agent"');
    expect(html).toContain('class="row withheld"');
    expect(html).toContain("waiting for a slot");
    // the withheld row has no pane -> no terminal link for BUTCHR-2 specifically
    expect(html).not.toContain(`/agents/pane/${encodeURIComponent("BUTCHR-2")}/attach`);
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-344 (K5): a could-not-check residency (no trusted census yet) must
// never render as an ordinary known number in the admission cap line — the
// shared NO_ADMISSION fixture used everywhere else in this file has
// `residency: null` but nothing above ever asserts on that slot at all.
// Driven by the REAL createAdmissionController (never a hand-typed
// AdmissionView), whose `census()` reports `residency: null` before any
// `admit()` call ever lands — a genuine "no trusted census yet" producer.
// ---------------------------------------------------------------------------
describe("renderDashboard: residency's could-not-check case is never rendered as a known number (BUTCHR-344, review gap K5)", () => {
  test("a fresh admission controller (no admit() call yet) renders could-not-check in the .admcap element, with no number in the residency slot", () => {
    const controller = createAdmissionController({ cap: 5, residency: async () => [] });
    const census = controller.census();
    expect(census.residency).toBeNull(); // sanity: this producer really is in the could-not-check state
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: buildAdmissionView(census) };
    const html = renderDashboard(response, opts());
    const admcapText = elementText(html, 'class="admcap"', "</div>");
    expect(admcapText.toLowerCase()).toContain("could not check");
    // never the known-value span, and never a bare digit standing in for the
    // unresolved residency (the K5 mutation renders `admission.cap`, e.g.
    // "5", in the residency slot instead)
    expect(admcapText).not.toMatch(/residency: <span class="known">/);
    expect(admcapText).not.toMatch(/residency:\s*\d/);
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-344 [correction] (X6): the OPPOSITE gap from K5 — a KNOWN, non-null
// residency must actually appear in the .admcap line at all. Dropping the
// whole " · residency: ..." segment leaves the rest of the suite green,
// because K5 only asserts on the could-not-check wording, never that a real,
// trusted residency count is rendered anywhere. Driven by a REAL
// createAdmissionController with an actual admit() call, so `census().residency`
// is a genuine trusted number, never a hand-typed one.
// ---------------------------------------------------------------------------
describe("renderDashboard: a known, non-null residency actually appears in .admcap — dropping the whole segment must fail (BUTCHR-344 [correction], review item X6)", () => {
  test("a trusted residency count renders in the admission cap line", async () => {
    const controller = createAdmissionController({ cap: 10, residency: async () => ["a", "b", "c"] });
    await controller.admit([], [], "issue");
    const census = controller.census();
    expect(census.residency).toBe(3); // sanity: a real, known, non-null residency
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: buildAdmissionView(census) };
    const html = renderDashboard(response, opts());
    const admcapText = elementText(html, 'class="admcap"', "</div>");
    expect(admcapText).toContain("residency:");
    expect(admcapText).toContain("3");
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-344 [correction] (X2): the not-applicable marker's own TITLE must
// carry the row's REAL reason, never a generic string. Deliberately scoped
// down from an earlier (wrong) characterization: `renderNotApplicable`'s
// VISIBLE text ("no agent — n/a") is unconditional and is not itself part of
// this assertion — only the tooltip (`title` attribute) is under test here.
// ---------------------------------------------------------------------------
describe("renderDashboard: the not-applicable marker's own title carries its real reason (BUTCHR-344 [correction], review item X2)", () => {
  test("a withheld row's .na title attribute is its own agentFields.reason, not a generic string", async () => {
    const controller = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue"] });
    await controller.admit(["BUTCHR-3"], [], "issue");
    const census = controller.census();
    const withheldRows = [...updateWithheldRows(census, new Map(), { issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0), agentKeys: new Set() }).values()].flat();
    expect(withheldRows).toHaveLength(1);
    const reason = withheldRows[0]!.agentFields.reason;
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: withheldRows, admission: buildAdmissionView(census) };
    const html = renderDashboard(response, opts());
    const titleMatch = html.match(/<span class="na" title="([^"]+)">/);
    if (!titleMatch) throw new Error("expected a .na element with a title attribute");
    expect(titleMatch[1]).toBe(reason);
    expect(titleMatch[1]).not.toBe("could not check");
    // deliberately NOT a conflation test (BUTCHR-344 [correction]): the
    // visible text stays unconditional regardless of the title's content.
    expect(elementText(html, 'class="na"', "</span>")).toBe("no agent — n/a");
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-344 [correction] (F1): deleting the auto-refresh meta tag leaves the
// page's VISIBLE TEXT identical (the hint still promises "refreshes every
// Ns"), so a strip-tags-and-compare check would NOT catch this one — it is a
// behaviour change (the browser never reloads) with no visible-text
// difference. Assert the tag is PRESENT and that its interval is COUPLED to
// the hint's own stated number — two independent assertions would let the
// two drift apart silently, which is the same defect one level down.
// ---------------------------------------------------------------------------
describe("renderDashboard: the auto-refresh meta tag is present and coupled to the hint's stated interval (BUTCHR-344 [correction], review item F1)", () => {
  test("the <meta http-equiv=refresh> tag exists and its interval equals the number the hint states", () => {
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: NO_ADMISSION };
    const html = renderDashboard(response, opts({ refreshSeconds: 7 }));
    const metaMatch = html.match(/<meta http-equiv="refresh" content="(\d+)">/);
    if (!metaMatch) throw new Error("expected an auto-refresh meta tag");
    const hintText = elementText(html, 'class="hint"', "</div>");
    const hintMatch = hintText.match(/refreshes every (\d+)s/);
    if (!hintMatch) throw new Error("expected the hint to state its own refresh interval");
    expect(metaMatch[1]).toBe(hintMatch[1]);
    expect(metaMatch[1]).toBe("7");
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-344 [correction] (H1): the currency verdict must carry its own AGE,
// not just the word "checked" — BUTCHR-266's own criterion asks for currency
// WITH its age, and no existing currency test asserted the age text at all.
// ---------------------------------------------------------------------------
describe("renderDashboard: the currency line carries its own age, never a bare 'checked' (BUTCHR-344 [correction], review item H1)", () => {
  test("a known checkedAt/now renders 'checked <age> ago', not a bare 'checked'", () => {
    const build = { sha: "d".repeat(40), shaDirty: false, shaUnknownReason: null, version: "1.0.0" };
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: NO_ADMISSION };
    const html = renderDashboard(
      response,
      opts({
        header: {
          build,
          currency: {
            checkedAt: new Date(1000).toISOString(),
            verdict: { status: "current", base: { ref: "refs/remotes/origin/main", sha: "c".repeat(40), changedAt: null, changedAtUnknownReason: "x", fetchedAt: null, fetchedAtUnknownReason: "x" }, dirtyUndeterminable: false },
          },
        },
        now: 1000 + 65_000,
      }),
    );
    expect(html).toContain("(checked 1m ago)");
    expect(html).not.toContain("(checked)");
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-344 [correction] (Y2): a DECLINED census source's own entry must
// carry the could-not-check CLASS, never the known one — the page's own
// stylesheet carries BOTH `.admsrc.cnc{color:#f0b429}` (amber) and
// `.admsrc.known{color:#3fb950}` (GREEN), so swapping just the class (text
// left untouched) paints a could-not-check source in the success colour.
// This is the exact inverse of a mutation that keeps the class and changes
// the text: here the words still say "COULD NOT CHECK" but the colour lies.
// A sibling assertion that a CHECKED source still carries `known` guards
// against the swap going the other way too.
// ---------------------------------------------------------------------------
describe("renderDashboard: a declined census source's own entry carries the could-not-check class, never the known class (BUTCHR-344 [correction], review item Y2)", () => {
  test("a declined source renders admsrc cnc (never admsrc known); a checked source renders admsrc known (never admsrc cnc)", async () => {
    const controller = createAdmissionController({ cap: 100, residency: async () => [], sources: ["issue", "project"] });
    await controller.admit(["KAN-1"], [], "issue"); // "issue" checked; "project" never reports -> declined
    const census = controller.census();
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: buildAdmissionView(census) };
    const html = renderDashboard(response, opts());
    expect(html).toMatch(/class="admsrc cnc" data-source="project"/);
    expect(html).not.toMatch(/class="admsrc known" data-source="project"/);
    expect(html).toMatch(/class="admsrc known" data-source="issue"/);
    expect(html).not.toMatch(/class="admsrc cnc" data-source="issue"/);
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-344 (L5): the hint's own wording — nothing else on this page reads
// it, so a mutation that quietly over-claims ("opens a terminal window for
// that agent", stated as a plain fact) survives unless something is scoped
// to `.hint` itself.
// ---------------------------------------------------------------------------
describe("renderDashboard: the hint's own wording, scoped to .hint (BUTCHR-344, review gap L5)", () => {
  test("the hint states the terminal link is fire-and-forget (attaches, not a confirmed 'opens' claim)", () => {
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: NO_ADMISSION };
    const html = renderDashboard(response, opts());
    const hintText = elementText(html, 'class="hint"', "</div>");
    expect(hintText).toContain("attaches a terminal to that agent");
    expect(hintText).toContain("fire-and-forget");
    expect(hintText).not.toMatch(/opens a terminal window/i);
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-344 (P3): a withheld row must never carry a terminal link at all —
// scoped to the withheld row's OWN html, not merely "the one specific href
// this fixture happens to produce" (the pre-existing structural test above
// only rejects `/agents/pane/BUTCHR-2/attach`, which no plausible bug would
// literally produce for a withheld row that has no pane in the first place).
// ---------------------------------------------------------------------------
describe("renderDashboard: a withheld row never gains a terminal link, scoped to its own HTML (BUTCHR-344, review gap P3)", () => {
  test("a withheld row's own rendered HTML contains neither 'open terminal' nor '/attach' anywhere in it", async () => {
    const controller = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue"] });
    await controller.admit(["BUTCHR-2"], [], "issue");
    const census = controller.census();
    const withheldRows = [...updateWithheldRows(census, new Map(), { issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0), agentKeys: new Set() }).values()].flat();
    expect(withheldRows).toHaveLength(1);
    // The only row in this response, so the `#rows` container's own content
    // IS this withheld row's own HTML, start to finish.
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows: withheldRows, admission: buildAdmissionView(census) };
    const html = renderDashboard(response, opts());
    const rowsStart = html.indexOf('<div id="rows">') + '<div id="rows">'.length;
    const hintStart = html.indexOf('<div class="hint">');
    const rowHtml = html.slice(rowsStart, hintStart);
    expect(rowHtml).toContain('class="row withheld"');
    expect(rowHtml).not.toContain("open terminal");
    expect(rowHtml).not.toContain("/attach");
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-344 (E1): `esc()` is exercised elsewhere only with panes that need
// no escaping at all ("w1:p3"), so a broken `esc()` that returns its input
// unchanged still passes every existing assertion. This drives a pane
// containing '<', '&', and '"' through the REAL buildDashboardRows and
// checks the `.pane` element's RAW HTML is the fully-escaped form.
// ---------------------------------------------------------------------------
describe("renderDashboard: esc() actually escapes, verified with a pane containing characters that need it (BUTCHR-344, review gap E1)", () => {
  test("a pane containing '<', '&', and '\"' renders as escaped text inside the .pane element's raw HTML", () => {
    const pane = `<img src=x onerror=alert(1)>&"'`;
    const rows = buildDashboardRows([agent("butchr-butchr-1", "working", pane)], { now: () => 0, issueMeta: () => undefined, tracker: new StatusFloorTracker(() => 0) });
    const response: DashboardResponse = { checked: true, confirmedAt: new Date(0).toISOString(), rows, admission: NO_ADMISSION };
    const html = renderDashboard(response, opts());
    const paneHtml = elementText(html, 'class="pane"', "</span>");
    expect(paneHtml).toBe("&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;");
    // the raw '<'/'>' must never survive unescaped — that would open a real tag
    expect(paneHtml).not.toContain("<img");
  });
});
