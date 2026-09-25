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
  test("jira-idea: query and read only — comments/links exist in jira-idea.ts's own client but are not wired through this shared interface (out of scope, FACTORY-21)", () => {
    expect(capabilitiesOf(REF_OF["jira-idea"])).toEqual(["query", "read"]);
  });
  test("confluence-page: links only — no live query/read code, only a version-number change-token hook", () => {
    expect(capabilitiesOf(REF_OF["confluence-page"])).toEqual(["links"]);
  });
  test("github-issue: query, read and links — no snapshot/diff wiring, no comments through this interface", () => {
    expect(capabilitiesOf(REF_OF["github-issue"])).toEqual(["query", "read", "links"]);
  });
  test("zendesk-ticket: query and read only — ZendeskTicketClient already has working comment code, deliberately not declared here (out of scope, FACTORY-21); excluded from ResourceRef so no links at all", () => {
    expect(capabilitiesOf(REF_OF["zendesk-ticket"])).toEqual(["query", "read"]);
  });
  test("filesystem: links only — no read/stat/watch code anywhere", () => {
    expect(capabilitiesOf(REF_OF.filesystem)).toEqual(["links"]);
  });
  test("webpage: links only — no fetch/read code anywhere", () => {
    expect(capabilitiesOf(REF_OF.webpage)).toEqual(["links"]);
  });
  test("createTask is absent for every provider — genuinely unbuilt, not merely undeclared", () => {
    for (const provider of CAPABILITY_PROVIDERS) expect(supports(REF_OF[provider], "createTask")).toBe(false);
  });
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
