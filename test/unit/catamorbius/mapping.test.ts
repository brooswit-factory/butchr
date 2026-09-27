import { describe, expect, test } from "bun:test";
import { watchKeyForResource, watchKeysForEvent, type CatamorbiusCloudEvent, type WatchableResource } from "../../../src/catamorbius/mapping.js";

describe("watchKeyForResource", () => {
  test("jira-work-item: uppercases and prefixes", () => {
    expect(watchKeyForResource({ provider: "jira-work-item", key: "butchr-1" })).toBe("jira:BUTCHR-1");
    expect(watchKeyForResource({ provider: "jira-work-item", key: "BUTCHR-1" })).toBe("jira:BUTCHR-1");
  });
  test("jira-work-item: malformed key -> null", () => {
    expect(watchKeyForResource({ provider: "jira-work-item", key: "not-an-issue-key" })).toBeNull();
  });
  test("github-issue and github-pr with the SAME owner/repo/number produce the IDENTICAL watch key (trap c)", () => {
    const issue = watchKeyForResource({ provider: "github-issue", owner: "Acme", repo: "Widgets", number: 42 });
    const pr = watchKeyForResource({ provider: "github-pr", owner: "Acme", repo: "Widgets", number: 42 });
    expect(issue).toBe("github:acme/widgets#42");
    expect(pr).toBe("github:acme/widgets#42");
    expect(issue).toBe(pr as string);
  });
  test("github: mixed-case owner/repo lower-cases (trap a)", () => {
    expect(watchKeyForResource({ provider: "github-issue", owner: "Brooswit-Factory", repo: "ButchR", number: 7 })).toBe("github:brooswit-factory/butchr#7");
  });
  test("LinkedItem-shaped input ({kind,target}) is accepted identically to the structured form", () => {
    expect(watchKeyForResource({ kind: "jira-key", target: "butchr-9" })).toBe("jira:BUTCHR-9");
    expect(watchKeyForResource({ kind: "github-issue", target: "Acme/Widgets#3" })).toBe("github:acme/widgets#3");
    expect(watchKeyForResource({ kind: "github-pr", target: "Acme/Widgets#3" })).toBe("github:acme/widgets#3");
  });
  test("malformed LinkedItem target -> null, never throws", () => {
    expect(watchKeyForResource({ kind: "jira-key", target: "nope" })).toBeNull();
    expect(watchKeyForResource({ kind: "github-issue", target: "not-a-ref" })).toBeNull();
  });
});

function githubEvent(overrides: Partial<CatamorbiusCloudEvent>): CatamorbiusCloudEvent {
  return { source: "//github/acme", subject: "acme/widgets#42", ...overrides };
}
function jiraEvent(overrides: Partial<CatamorbiusCloudEvent>): CatamorbiusCloudEvent {
  return { source: "//jira/example.atlassian.net", ...overrides };
}

describe("watchKeysForEvent: GitHub", () => {
  test("issue/PR subject owner/repo#n maps to the github: key, case-insensitively (trap a)", () => {
    expect(watchKeysForEvent(githubEvent({ subject: "Acme/Widgets#42" }))).toEqual(["github:acme/widgets#42"]);
  });
  test("push subject owner/repo@ref is unmapped (trap d)", () => {
    expect(watchKeysForEvent(githubEvent({ subject: "acme/widgets@refs/heads/main" }))).toEqual([]);
  });
  test("bare repository full_name subject is unmapped (trap d)", () => {
    expect(watchKeysForEvent(githubEvent({ subject: "acme/widgets" }))).toEqual([]);
  });
  test("missing subject is unmapped", () => {
    expect(watchKeysForEvent(githubEvent({ subject: undefined }))).toEqual([]);
  });
  test("an event whose subject names an issue maps to the same key a github-pr resource with that number would (trap c)", () => {
    const eventKeys = watchKeysForEvent(githubEvent({ subject: "acme/widgets#42" }));
    const prKey = watchKeyForResource({ provider: "github-pr", owner: "acme", repo: "widgets", number: 42 });
    const issueKey = watchKeyForResource({ provider: "github-issue", owner: "acme", repo: "widgets", number: 42 });
    expect(eventKeys).toContain(prKey as string);
    expect(eventKeys).toContain(issueKey as string);
  });
});

describe("watchKeysForEvent: Jira", () => {
  test("subject already an issue key maps directly", () => {
    expect(watchKeysForEvent(jiraEvent({ subject: "JRA-20002" }))).toEqual(["jira:JRA-20002"]);
  });
  test("comment/worklog WITH a top-level issue in the body: subject is already the issue key (trap b, common case)", () => {
    const event = jiraEvent({ subject: "JRA-20002", data: { raw: { body: { issue: { key: "JRA-20002" } } } } });
    expect(watchKeysForEvent(event)).toEqual(["jira:JRA-20002"]);
  });
  test("comment/worklog WITHOUT a top-level issue and no project-derivable subject: unmapped, never an error (trap b)", () => {
    const event = jiraEvent({ subject: undefined, data: { raw: { body: { comment: { id: "1" } } } } });
    expect(watchKeysForEvent(event)).toEqual([]);
  });
  test("subject falls back to a project key (no issue): unmapped, but body.issue.key is still checked defensively (trap b)", () => {
    const eventNoIssueAnywhere = jiraEvent({ subject: "KAN", data: { raw: { body: { project: { key: "KAN" } } } } });
    expect(watchKeysForEvent(eventNoIssueAnywhere)).toEqual([]);
    const eventIssueOnlyInBody = jiraEvent({ subject: "KAN", data: { raw: { body: { issue: { key: "KAN-7" } } } } });
    expect(watchKeysForEvent(eventIssueOnlyInBody)).toEqual(["jira:KAN-7"]);
  });
  test("sprint/version/board subjects are unmapped", () => {
    expect(watchKeysForEvent(jiraEvent({ subject: "42" }))).toEqual([]);
  });
});

describe("watchKeysForEvent: neither github nor jira source", () => {
  test("unknown source is unmapped", () => {
    expect(watchKeysForEvent({ source: "//zendesk/acme", subject: "acme/widgets#42" })).toEqual([]);
  });
});

/**
 * THE INVARIANT (definition of done #2): for every mappable resource R and
 * every gateway event ABOUT R, the watch key of R is among the keys of the
 * event. Exercised directly, not just via the individual-case tests above.
 */
describe("invariant: watchKeyForResource(R) is always among watchKeysForEvent(eventAbout(R))", () => {
  const cases: Array<{ name: string; resource: WatchableResource; event: CatamorbiusCloudEvent }> = [
    { name: "jira issue, subject-carried", resource: { provider: "jira-work-item", key: "BUTCHR-1" }, event: jiraEvent({ subject: "BUTCHR-1" }) },
    {
      name: "jira issue, comment event with top-level issue",
      resource: { provider: "jira-work-item", key: "BUTCHR-1" },
      event: jiraEvent({ subject: "BUTCHR-1", data: { raw: { body: { issue: { key: "BUTCHR-1" } } } } }),
    },
    {
      name: "jira issue, comment event with issue ONLY in body (no subject)",
      resource: { provider: "jira-work-item", key: "BUTCHR-1" },
      event: jiraEvent({ subject: undefined, data: { raw: { body: { issue: { key: "BUTCHR-1" } } } } }),
    },
    { name: "github issue, mixed-case repo", resource: { provider: "github-issue", owner: "Acme", repo: "Widgets", number: 42 }, event: githubEvent({ subject: "Acme/Widgets#42" }) },
    { name: "github PR, mixed-case repo, same number as an issue elsewhere", resource: { provider: "github-pr", owner: "Acme", repo: "Widgets", number: 42 }, event: githubEvent({ subject: "Acme/Widgets#42" }) },
  ];
  for (const { name, resource, event } of cases) {
    test(name, () => {
      const key = watchKeyForResource(resource);
      expect(key).not.toBeNull();
      expect(watchKeysForEvent(event)).toContain(key as string);
    });
  }
});
