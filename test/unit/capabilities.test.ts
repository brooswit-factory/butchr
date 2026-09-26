import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  CAPABILITY_PROVIDERS,
  UnsupportedCapabilityError,
  assertSupports,
  capabilitiesOf,
  supports,
  type CapabilityRef,
} from "../../src/resources/capabilities.js";

/** One valid CapabilityRef per provider — enough identity for `.provider` to resolve, nothing more. */
const REF_OF: Record<(typeof CAPABILITY_PROVIDERS)[number], CapabilityRef> = {
  "jira-work-item": { provider: "jira-work-item", key: "BUTCHR-1" },
  "jira-project": { provider: "jira-project", key: "BUTCHR" },
  "jira-idea": { provider: "jira-idea", key: "IDEA-1" },
  "confluence-page": { provider: "confluence-page", pageId: "123456" },
  "github-issue": { provider: "github-issue", owner: "brooswit-factory", repo: "butchr", number: 1 },
  "zendesk-ticket": { provider: "zendesk-ticket", subdomain: "acme", id: 1 },
  filesystem: { provider: "filesystem", path: "/srv/factory/butchr" },
  webpage: { provider: "webpage", url: "https://example.com/resource" },
};

describe("capabilitiesOf/supports: declaration truthfulness, one row per provider", () => {
  test("jira-work-item: query, read, snapshot, comments and links — no createTask anywhere in this codebase", () => {
    expect(capabilitiesOf(REF_OF["jira-work-item"])).toEqual(["query", "read", "snapshot", "comments", "links"]);
  });
  test("jira-project: query and links only — no dedicated getProject(key), no event-rules/poll wiring, no native project comments", () => {
    expect(capabilitiesOf(REF_OF["jira-project"])).toEqual(["query", "links"]);
  });
  test("jira-idea: query, read and comments (FACTORY-21: wired through comments.ts, reusing JiraIdeaClient.comments/.addComment) — links stays false, still no managed-link-store integration and still excluded from ResourceRef", () => {
    expect(capabilitiesOf(REF_OF["jira-idea"])).toEqual(["query", "read", "comments"]);
  });
  test("confluence-page: comments and links — no live query/read code, only a version-number change-token hook; comments is now wired (FACTORY-29/31) over AtlassianOps.getPageComments/commentOnPage, see comments.test.ts", () => {
    expect(capabilitiesOf(REF_OF["confluence-page"])).toEqual(["comments", "links"]);
  });
  test("github-issue: query, read, links and comments (FACTORY-21: wired through comments.ts, reusing GithubIssueClient.comments/.addComment) — no snapshot/diff wiring", () => {
    expect(capabilitiesOf(REF_OF["github-issue"])).toEqual(["query", "read", "comments", "links"]);
  });
  test("zendesk-ticket: query, read and comments (FACTORY-21: wired through comments.ts, reusing ZendeskTicketClient.comments/addInternalNote, private-note-only) — still excluded from ResourceRef so no links at all", () => {
    expect(capabilitiesOf(REF_OF["zendesk-ticket"])).toEqual(["query", "read", "comments"]);
  });
  test("filesystem: query and links (BUTCHR-407: listFilesystemResources is a real, generic query entry point) — no read/stat-content or snapshot capability wired for a zero-provider-knowledge caller", () => {
    expect(capabilitiesOf(REF_OF.filesystem)).toEqual(["query", "links"]);
  });
  test("webpage: links only — no fetch/read code anywhere", () => {
    expect(capabilitiesOf(REF_OF.webpage)).toEqual(["links"]);
  });
  test("createTask is absent for every provider — genuinely unbuilt, not merely undeclared", () => {
    for (const provider of CAPABILITY_PROVIDERS) expect(supports(REF_OF[provider], "createTask")).toBe(false);
  });
});

/**
 * The full 8x6 inventory (docs/provider-capabilities.md), pinned in one
 * place so any future accidental drift in MATRIX (src/resources/
 * capabilities.ts) — a cell flipped, added, or removed without an
 * accompanying doc/test update — fails loudly here rather than only
 * shifting the per-provider `capabilitiesOf` assertions above one at a
 * time. Every `true` cell below must be backed by real, wired-in code (see
 * the per-provider tests above and comments.test.ts); every `false` cell's
 * reasoning is in the doc.
 */
const EXPECTED_MATRIX: Record<(typeof CAPABILITY_PROVIDERS)[number], Record<(typeof CAPABILITIES)[number], boolean>> = {
  "jira-work-item": { query: true, read: true, snapshot: true, comments: true, links: true, createTask: false },
  "jira-project": { query: true, read: false, snapshot: false, comments: false, links: true, createTask: false },
  "jira-idea": { query: true, read: true, snapshot: false, comments: true, links: false, createTask: false },
  "confluence-page": { query: false, read: false, snapshot: false, comments: true, links: true, createTask: false },
  "github-issue": { query: true, read: true, snapshot: false, comments: true, links: true, createTask: false },
  "zendesk-ticket": { query: true, read: true, snapshot: false, comments: true, links: false, createTask: false },
  filesystem: { query: true, read: false, snapshot: false, comments: false, links: true, createTask: false },
  webpage: { query: false, read: false, snapshot: false, comments: false, links: true, createTask: false },
};

describe("the entire 8x6 MATRIX, pinned so any future drift is loud", () => {
  for (const provider of CAPABILITY_PROVIDERS) {
    test(`${provider}: every capability cell matches the documented inventory`, () => {
      for (const capability of CAPABILITIES) expect(supports(REF_OF[provider], capability)).toBe(EXPECTED_MATRIX[provider][capability]);
    });
  }
});

describe("supports/capabilitiesOf agree, for every provider and every capability", () => {
  test("capabilitiesOf(ref) is exactly the capabilities for which supports(ref, c) is true", () => {
    for (const provider of CAPABILITY_PROVIDERS) {
      const ref = REF_OF[provider];
      const declared = capabilitiesOf(ref);
      for (const capability of CAPABILITIES) expect(supports(ref, capability)).toBe(declared.includes(capability));
    }
  });
});

describe("assertSupports / UnsupportedCapabilityError: typed, programmatically detectable failure", () => {
  test("throws UnsupportedCapabilityError (not a generic Error) naming the provider and capability, for every unsupported cell", () => {
    for (const provider of CAPABILITY_PROVIDERS) {
      for (const capability of CAPABILITIES) {
        if (supports(REF_OF[provider], capability)) continue;
        let caught: unknown;
        try { assertSupports(REF_OF[provider], capability); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(UnsupportedCapabilityError);
        const err = caught as UnsupportedCapabilityError;
        expect(err.provider).toBe(provider);
        expect(err.capability).toBe(capability);
        expect(err.name).toBe("UnsupportedCapabilityError");
      }
    }
  });
  test("never throws for a declared-supported capability", () => {
    expect(() => assertSupports(REF_OF["jira-work-item"], "comments")).not.toThrow();
    expect(() => assertSupports(REF_OF["jira-project"], "links")).not.toThrow();
  });
  test("UnsupportedCapabilityError is a real Error subclass a caller can also catch generically", () => {
    const err = new UnsupportedCapabilityError("webpage", "comments");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('webpage does not support capability "comments"');
  });
});
