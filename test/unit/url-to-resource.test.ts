import { describe, expect, test } from "bun:test";
import { resolveUrlToResource, type UrlToResourceDeps } from "../../src/resources/url-to-resource.js";

const deps: UrlToResourceDeps = { jiraHost: "acme.atlassian.net", zendeskSubdomain: "acme" };

describe("resolveUrlToResource — Jira", () => {
  test("the classic /browse/<KEY> form", () => {
    expect(resolveUrlToResource("https://acme.atlassian.net/browse/BUTCHR-12", deps).resource).toEqual({ provider: "jira-work", id: "BUTCHR-12" });
  });
  test("case-folds the issue key, same as parseJiraWorkItemRef", () => {
    expect(resolveUrlToResource("https://acme.atlassian.net/browse/butchr-12", deps).resource).toEqual({ provider: "jira-work", id: "BUTCHR-12" });
  });
  test("the new-UI issue-detail form (path ends /issues/<KEY>)", () => {
    expect(resolveUrlToResource("https://acme.atlassian.net/jira/software/c/projects/BUTCHR/issues/BUTCHR-12", deps).resource).toEqual({ provider: "jira-work", id: "BUTCHR-12" });
  });
  test("the board form carrying the key in ?selectedIssue=", () => {
    expect(resolveUrlToResource("https://acme.atlassian.net/jira/software/projects/BUTCHR/boards/1?selectedIssue=BUTCHR-12", deps).resource).toEqual({ provider: "jira-work", id: "BUTCHR-12" });
  });
  test("wrong Jira host resolves to no resource, even for an otherwise well-formed /browse/ path", () => {
    expect(resolveUrlToResource("https://other.atlassian.net/browse/BUTCHR-12", deps).resource).toBeNull();
  });
  test("a path that isn't any recognized Jira form resolves to no resource", () => {
    expect(resolveUrlToResource("https://acme.atlassian.net/wiki/spaces/X", deps).resource).toBeNull();
  });
});

describe("resolveUrlToResource — GitHub", () => {
  test("an issue URL", () => {
    expect(resolveUrlToResource("https://github.com/brooswit-factory/butchr/issues/42", deps).resource).toEqual({ provider: "github-issue", id: "brooswit-factory/butchr#42" });
  });
  test("a PR URL — a SEPARATE provider from github-issue despite the identical owner/repo#number shape", () => {
    expect(resolveUrlToResource("https://github.com/brooswit-factory/butchr/pull/42", deps).resource).toEqual({ provider: "github-pr", id: "brooswit-factory/butchr#42" });
  });
  test("owner/repo are lowercased in the resource id", () => {
    expect(resolveUrlToResource("https://github.com/Brooswit-Factory/Butchr/issues/42", deps).resource).toEqual({ provider: "github-issue", id: "brooswit-factory/butchr#42" });
  });
  test("lookalike hosts resolve to no resource: subdomain trick, different domain, userinfo trick", () => {
    for (const url of [
      "https://github.com.evil.example/brooswit-factory/butchr/issues/42",
      "https://evilgithub.com/brooswit-factory/butchr/issues/42",
      "https://github.com@evil.example/brooswit-factory/butchr/issues/42",
    ]) {
      expect(resolveUrlToResource(url, deps).resource).toBeNull();
    }
  });
  test("www.github.com is not github.com", () => {
    expect(resolveUrlToResource("https://www.github.com/brooswit-factory/butchr/issues/42", deps).resource).toBeNull();
  });
});

describe("resolveUrlToResource — Zendesk", () => {
  test("a ticket URL under the configured subdomain", () => {
    expect(resolveUrlToResource("https://acme.zendesk.com/agent/tickets/123", deps).resource).toEqual({ provider: "zendesk-ticket", id: "acme#123" });
  });
  test("a different subdomain resolves to no resource", () => {
    expect(resolveUrlToResource("https://other.zendesk.com/agent/tickets/123", deps).resource).toBeNull();
  });
  test("Zendesk unconfigured (subdomain undefined) means every Zendesk URL resolves to no resource", () => {
    const noZendesk: UrlToResourceDeps = { jiraHost: deps.jiraHost, zendeskSubdomain: undefined };
    expect(resolveUrlToResource("https://acme.zendesk.com/agent/tickets/123", noZendesk).resource).toBeNull();
  });
});

describe("resolveUrlToResource — universal exclusions", () => {
  test("non-http(s) schemes resolve to no resource and no canonical url", () => {
    for (const url of ["ftp://acme.atlassian.net/browse/BUTCHR-12", "javascript:alert(1)", "mailto:a@b.com"]) {
      const r = resolveUrlToResource(url, deps);
      expect(r.canonicalUrl).toBeNull();
      expect(r.resource).toBeNull();
    }
  });
  test("URLs with embedded credentials resolve to no resource and no canonical url", () => {
    const r = resolveUrlToResource("https://user:pass@acme.atlassian.net/browse/BUTCHR-12", deps);
    expect(r.canonicalUrl).toBeNull();
    expect(r.resource).toBeNull();
  });
  test("an unparseable string never throws", () => {
    expect(() => resolveUrlToResource("not a url at all", deps)).not.toThrow();
    expect(resolveUrlToResource("not a url at all", deps)).toEqual({ canonicalUrl: null, resource: null });
  });
  test("anything not matching any provider is a normal no-resource result, not an error", () => {
    expect(resolveUrlToResource("https://example.com/whatever", deps)).toEqual({ canonicalUrl: "https://example.com/whatever", resource: null });
  });
});

describe("resolveUrlToResource — canonicalization differs from input", () => {
  test("default port, fragment, and host case are normalized away, and the resource still resolves", () => {
    const r = resolveUrlToResource("HTTPS://ACME.atlassian.net:443/browse/BUTCHR-12#comment-1", deps);
    expect(r.canonicalUrl).toBe("https://acme.atlassian.net/browse/BUTCHR-12");
    expect(r.canonicalUrl).not.toBe("HTTPS://ACME.atlassian.net:443/browse/BUTCHR-12#comment-1");
    expect(r.resource).toEqual({ provider: "jira-work", id: "BUTCHR-12" });
  });
  test("a query string is preserved byte-for-byte in canonicalUrl even though it plays no role in matching", () => {
    const r = resolveUrlToResource("https://github.com/brooswit-factory/butchr/issues/42?tab=comments", deps);
    expect(r.canonicalUrl).toBe("https://github.com/brooswit-factory/butchr/issues/42?tab=comments");
    expect(r.resource).toEqual({ provider: "github-issue", id: "brooswit-factory/butchr#42" });
  });
});
