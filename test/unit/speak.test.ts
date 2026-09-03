import { describe, expect, test } from "bun:test";
import { speakOnOwnChannel, unwrapStorageParagraph, createOwnChannelComments } from "../../src/tools/speak.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

// BUTCHR-71 / BUTCHR-62: "where a resource speaks" — an issue on its own
// ticket, a project on its own root doc. What would make each check FAIL:
// an issue caller ending up calling commentOnPage (or a project caller
// ending up calling addComment) would fail the dispatch tests; the posted
// text differing from what was passed in would fail the "text passes
// through unchanged" test; the project caller NOT resolving through the
// project's own entity property would fail the "resolves via
// getProjectProperty" test.

function makeOps(overrides: Partial<AtlassianOps> = {}): { ops: AtlassianOps; jiraComments: Array<{ key: string; text: string }>; pageComments: Array<{ pageId: string; body: string }>; properties: Map<string, unknown> } {
  const jiraComments: Array<{ key: string; text: string }> = [];
  const pageComments: Array<{ pageId: string; body: string }> = [];
  const properties = new Map<string, unknown>([["BUTCHR", { space: { key: "BUTCHR" }, rootDoc: { id: "42" } }]]);
  const ops: AtlassianOps = {
    getIssue: async () => ({}),
    search: async () => ({}),
    addComment: async (key: string, text: string) => {
      jiraComments.push({ key, text });
      return { ok: true };
    },
    linkIssues: async () => ({}),
    transition: async () => ({}),
    createIssue: async () => ({}),
    setPriority: async () => ({}),
    assign: async () => ({}),
    correctText: async () => ({}),
    createPage: async () => ({}),
    getPage: async (id: string) => ({ title: "root doc", body: { storage: { value: "<p>hi</p>" } }, _links: { base: "https://fake.atlassian.net/wiki", webui: `/pages/${id}` } }),
    updatePage: async () => ({ ok: true, version: 1 }),
    searchPages: async () => ({ results: [] }),
    listSpaces: async () => ({}),
    getProjectProperty: async (projectKey: string) => {
      const p = properties.get(projectKey);
      if (!p) throw new Error(`fake: no "butchr" property for ${projectKey}`);
      return p;
    },
    getRemoteLink: async () => null,
    upsertRemoteLink: async () => ({}),
    getChildPages: async () => ({ results: [] }),
    getPageLabels: async () => [],
    createPageWithLabel: async () => ({ id: "x", title: "x", url: "x" }),
    addLabels: async () => ({ ok: true }),
    removeLabels: async () => ({ ok: true }),
    deleteIssue: async () => ({ ok: true }),
    commentOnPage: async (pageId: string, body: string) => {
      const id = String(1000 + pageComments.length);
      pageComments.push({ pageId, body });
      return { ok: true, id };
    },
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: "test-account" }),
    setProjectProperty: async (projectKey: string, _propertyKey: string, value: unknown) => {
      properties.set(projectKey, value);
      return { ok: true };
    },
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async (projectKey: string) => properties.get(projectKey) ?? null,
    ...overrides,
  };
  return { ops, jiraComments, pageComments, properties };
}

describe("speakOnOwnChannel", () => {
  test("an ISSUE caller speaks via ops.addComment, on its own ticket, text unchanged", async () => {
    const { ops, jiraComments, pageComments } = makeOps();
    await speakOnOwnChannel(ops, "BUTCHR-71", "[BUTCHR-71] status update");
    expect(jiraComments).toEqual([{ key: "BUTCHR-71", text: "[BUTCHR-71] status update" }]);
    expect(pageComments).toEqual([]); // never touches the Confluence path
  });

  test("a PROJECT caller speaks via ops.commentOnPage, on its OWN ROOT DOC resolved via the entity property — never ops.addComment", async () => {
    const { ops, jiraComments, pageComments } = makeOps();
    await speakOnOwnChannel(ops, "BUTCHR", "[BUTCHR] status update");
    expect(jiraComments).toEqual([]); // never touches the Jira path
    expect(pageComments.length).toBe(1);
    expect(pageComments[0]!.pageId).toBe("42"); // the id from getProjectProperty's rootDoc.id
    expect(pageComments[0]!.body).toContain("[BUTCHR] status update"); // text preserved
    expect(pageComments[0]!.body).toMatch(/^<p>.*<\/p>$/); // wrapped as a storage-format paragraph
  });

  test("a PROJECT caller's post is refused, naming the project, when the root doc can't be resolved — never silently falls back to addComment", async () => {
    const { ops } = makeOps({ getProjectProperty: async () => { throw new Error("404"); } });
    await expect(speakOnOwnChannel(ops, "BUTCHR", "hello")).rejects.toThrow(/BUTCHR.*unreadable/s);
  });

  test("HTML-sensitive characters in the text are escaped before being wrapped in storage format", async () => {
    const { ops, pageComments } = makeOps();
    await speakOnOwnChannel(ops, "BUTCHR", "a < b & c > d");
    expect(pageComments[0]!.body).toBe("<p>a &lt; b &amp; c &gt; d</p>");
  });

  // HAZARD 1 (BUTCHR-67/BUTCHR-81): a project's own report_to_boss/ask_boss
  // (both go through speakOnOwnChannel) must not leave itself looking like a
  // pending wake trigger. Failure condition, stated before the check: if
  // the `wake.comment` watermark is NOT advanced to the id this call's own
  // `commentOnPage` returned, `projectVerdict` would see `observedCommentId
  // !== watermark.comment` and (wrongly) report `active` for a project that
  // only ever spoke to itself. A suppression that ALSO swallows a foreign
  // comment (one this function never wrote) would fail the opposite way —
  // both are asserted below.
  test("HAZARD 1: a project's own comment advances its wake.comment watermark to that comment's own id", async () => {
    const { ops, properties } = makeOps();
    await speakOnOwnChannel(ops, "BUTCHR", "[BUTCHR] status update");
    const prop = properties.get("BUTCHR") as { wake?: { comment?: string | null } };
    expect(prop.wake?.comment).toBe("1000"); // the id makeOps's fake commentOnPage assigned this call
  });

  test("HAZARD 1 control: the watermark advance never overwrites the rest of the butchr property (space/rootDoc untouched)", async () => {
    const { ops, properties } = makeOps();
    await speakOnOwnChannel(ops, "BUTCHR", "hello");
    const prop = properties.get("BUTCHR") as { space?: { key?: string }; rootDoc?: { id?: string } };
    expect(prop.space).toEqual({ key: "BUTCHR" });
    expect(prop.rootDoc).toEqual({ id: "42" });
  });

  test("a failed watermark write never fails the (already-succeeded) speak call", async () => {
    const { ops, pageComments } = makeOps({ setProjectProperty: async () => { throw new Error("boom"); } });
    await expect(speakOnOwnChannel(ops, "BUTCHR", "hello")).resolves.toBeDefined();
    expect(pageComments.length).toBe(1); // the comment itself still landed
  });

  // BUTCHR-105 requirement 2's decision: the swallow above is KEPT (the test
  // just above still holds), but it must no longer be SILENT — a failed
  // watermark write is logged rather than disappearing with nothing to say
  // why a project keeps nudging itself. Failure condition: no line reaches
  // `log`, or the caller's `speakOnOwnChannel` promise rejects instead of
  // resolving (that would be "remove the swallow", not "log it").
  test("BUTCHR-105: a failed watermark write is logged (not silent) while the speak call still succeeds", async () => {
    const { ops, pageComments } = makeOps({ setProjectProperty: async () => { throw new Error("boom"); } });
    const lines: string[] = [];
    await expect(speakOnOwnChannel(ops, "BUTCHR", "hello", (line) => lines.push(line))).resolves.toBeDefined();
    expect(pageComments.length).toBe(1); // the comment itself still landed
    // BUTCHR-226 (defect 1b): TWO distinct lines now, not one — the generic
    // `advanceProjectWatermark` line (which also records the failed write
    // into its in-process fallback) and speakOnOwnChannel's own
    // caller-specific line, deliberately different shapes so a reader can
    // tell which mechanism produced a given incident (see project.ts's own
    // doc comment on `pendingWatermarkFallback`).
    expect(lines.length).toBe(2);
    expect(lines.every((l) => l.includes("BUTCHR") && l.includes("boom"))).toBe(true);
    expect(lines.some((l) => l.includes("[advanceProjectWatermark]") && l.includes("DEFECT 1b"))).toBe(true);
    expect(lines.some((l) => l.includes("[speakOnOwnChannel]"))).toBe(true);
  });

  test("BUTCHR-105: no log line at all when the watermark write succeeds", async () => {
    const lines: string[] = [];
    const { ops } = makeOps();
    await speakOnOwnChannel(ops, "BUTCHR", "hello", (line) => lines.push(line));
    expect(lines).toEqual([]);
  });
});

// BUTCHR-124 review (PR #180, CHANGES_REQUESTED @ 1be6208): `unwrapStorageParagraph`
// is the exact inverse of speakOnOwnChannel's own `<p>${escapeStorageText(text)}</p>`
// wrapping — the round trip a project-tier read-back needs. What would REFUTE
// each test below: any test that hand-types its OWN "storage-format-looking"
// string instead of reading back what speakOnOwnChannel itself actually wrote
// would prove nothing about the real defect (a fixture disagreeing with the
// real writer is exactly how PR #180's original tests missed this) — so every
// test here round-trips through the REAL `speakOnOwnChannel` call.
describe("unwrapStorageParagraph", () => {
  test("round-trips a real speakOnOwnChannel-written body back to the exact original plain text", async () => {
    const { ops, pageComments } = makeOps();
    const text = "[butchr:unresponsive] KAN-1's pane has been reported blocked for 5 minute(s), and its text does not parse as a recognized dialog.\n\npane: [p1]";
    await speakOnOwnChannel(ops, "BUTCHR", text);
    expect(unwrapStorageParagraph(pageComments[0]!.body)).toBe(text);
  });

  // The exact defect the review found, reproduced and pinned: a naive
  // startsWith(marker) check (findMarked's own anchor) fails on the RAW
  // wrapped body and only succeeds once unwrapped.
  test("findMarked's startsWith(marker) anchor fails on the raw wrapped body and succeeds only after unwrapping", async () => {
    const { ops, pageComments } = makeOps();
    const marker = "[butchr:unresponsive]";
    const text = `${marker} KAN-1's pane has been reported blocked for 5 minute(s)...\n\npane: [p1]`;
    await speakOnOwnChannel(ops, "BUTCHR", text);
    const raw = pageComments[0]!.body;
    expect(raw.startsWith(marker)).toBe(false); // reproduces the defect
    expect(unwrapStorageParagraph(raw).startsWith(marker)).toBe(true); // fixed
  });

  test("round-trips HTML-sensitive characters exactly — the inverse of escapeStorageText's own encode order", async () => {
    const { ops, pageComments } = makeOps();
    const text = "a < b & c > d, and &amp; literally typed too";
    await speakOnOwnChannel(ops, "BUTCHR", text);
    expect(unwrapStorageParagraph(pageComments[0]!.body)).toBe(text);
  });

  test("a body that is NOT <p>...</p>-wrapped (a foreign comment on the same page) passes through, still unescaped", () => {
    expect(unwrapStorageParagraph("plain text, no wrapper at all")).toBe("plain text, no wrapper at all");
    expect(unwrapStorageParagraph("a &lt; b, no paragraph tags")).toBe("a < b, no paragraph tags");
  });
});

// BUTCHR-141/§2.6: `createOwnChannelComments` is EXTRACTED from
// src/daemon/index.ts (a move, not a rewrite) so the real reader — not a
// hand-reproduced stand-in — is importable into a unit test. Every project-
// tier test below round-trips through a REAL `speakOnOwnChannel` write, same
// discipline as `unwrapStorageParagraph`'s own tests above and for the same
// reason: a fixture that hands back plain text for both tiers is faithful to
// the TYPE and still disagrees with the real reader in the one dimension
// (representation) that matters (Rule 2b's third form, BUTCHR-129).
describe("createOwnChannelComments", () => {
  test("an ISSUE key routes to the injected issueComments reader, unchanged — never touches the Confluence path", async () => {
    const { ops } = makeOps();
    let issueCalls = 0;
    const issueComments = async (key: string) => { issueCalls++; return [{ id: "c1", body: `hi ${key}`, created: "t" }]; };
    const reader = createOwnChannelComments(ops, issueComments);
    const rows = await reader("BUTCHR-71");
    expect(issueCalls).toBe(1);
    expect(rows).toEqual([{ id: "c1", body: "hi BUTCHR-71", created: "t" }]);
  });

  test("a PROJECT key resolves its root doc and reads footer comments via getPageComments, called with exactly ONE id — never the injected issueComments reader", async () => {
    const { ops } = makeOps({ getPageComments: async (pageId: string) => (pageId === "42" ? { results: [{ id: "c1", body: "<p>hi</p>" }] } : { results: [] }) });
    const issueComments = async () => { throw new Error("must not be called for a project key"); };
    const reader = createOwnChannelComments(ops, issueComments);
    const rows = await reader("BUTCHR");
    expect(rows).toEqual([{ id: "c1", body: "hi", created: "" }]); // unwrapped; this ROW carries no `created` from the fake, mapped to "" (never synthesised) — see the dedicated `created` tests below for the case where a real timestamp IS present
  });

  // BUTCHR-171: `speak.test.ts:218` (pre-fix line) used to assert
  // `created: ""` UNCONDITIONALLY — pinning the bug where the mapping
  // dropped every timestamp regardless of what getPageComments returned.
  // This replaces that pin: `created` must now PASS THROUGH a real
  // timestamp when the underlying read carries one.
  test("a PROJECT key's `created` passes through a real timestamp from getPageComments, never dropped to \"\"", async () => {
    const { ops } = makeOps({
      getPageComments: async (pageId: string) =>
        pageId === "42" ? { results: [{ id: "c1", body: "<p>hi</p>", created: "2026-01-01T00:00:00.000Z" }] } : { results: [] },
    });
    const reader = createOwnChannelComments(ops, async () => { throw new Error("must not be called for a project key"); });
    const rows = await reader("BUTCHR");
    expect(rows).toEqual([{ id: "c1", body: "hi", created: "2026-01-01T00:00:00.000Z" }]);
  });

  // BUTCHR-171 Consequence 3: getPageComments requests no `sort` (its own
  // doc comment), so this function must defend ordering itself rather than
  // trust the raw return order — sorted newest-first by NUMERIC id. A
  // same-digit-count fixture cannot catch a lexicographic-vs-numeric bug
  // ("9" < "10" is already true as strings when digit counts match), per
  // BUTCHR-156's own measurement — this fixture deliberately crosses a
  // digit-count boundary ("9" vs "1000") to prove the comparison is numeric.
  test("PROJECT-tier rows are ordered newest-first by NUMERIC id, not raw API order or lexicographic order", async () => {
    const { ops } = makeOps({
      getPageComments: async () => ({
        results: [
          { id: "9", body: "<p>oldest, single digit</p>" },
          { id: "1000", body: "<p>newest, four digits</p>" },
          { id: "42", body: "<p>middle</p>" },
        ],
      }),
    });
    const reader = createOwnChannelComments(ops, async () => []);
    const rows = await reader("BUTCHR");
    expect(rows.map((r) => r.id)).toEqual(["1000", "42", "9"]); // numeric descending; a LEXICOGRAPHIC sort would instead put "9" ahead of "1000" and "42" (string "1..." < string "9"), exactly the digit-count-boundary failure this fixture exists to catch
  });

  test("END TO END: a project-tier row written by a REAL speakOnOwnChannel call round-trips back unwrapped, matching findMarked's startsWith(marker) anchor", async () => {
    const { ops, pageComments } = makeOps();
    const marker = "[butchr:crashloop]";
    const text = `${marker} BUTCHR has been spawned 5 times in the last 60 minutes...\n\nresource: [BUTCHR]`;
    await speakOnOwnChannel(ops, "BUTCHR", text);
    const opsWithComments: AtlassianOps = { ...ops, getPageComments: async () => ({ results: pageComments.map((c, i) => ({ id: `c${i}`, body: c.body })) }) };
    const reader = createOwnChannelComments(opsWithComments, async () => []);
    const rows = await reader("BUTCHR");
    expect(rows.length).toBe(1);
    expect(rows[0]!.body).toBe(text); // exact round trip
    expect(rows[0]!.body.startsWith(marker)).toBe(true); // the defect BUTCHR-129 fixed: a raw (still-wrapped) body would fail this
  });

  test("a project root-doc resolution failure rejects (never a laundered empty array) — the caller's own fail-closed handling depends on this", async () => {
    const { ops } = makeOps({ getProjectProperty: async () => { throw new Error("404"); } });
    const reader = createOwnChannelComments(ops, async () => []);
    await expect(reader("BUTCHR")).rejects.toThrow();
  });
});
