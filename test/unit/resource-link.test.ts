import { describe, expect, test } from "bun:test";
import { resolveResourceLink } from "../../src/resources/resource-link.js";

const deps = (projectUrl: string | (() => Promise<string>) = "https://wroosbit.atlassian.net/wiki/spaces/KAN/pages/1") => ({
  jiraSite: "https://wroosbit.atlassian.net",
  projectRootDocUrl: async (projectKey: string) => {
    if (typeof projectUrl === "function") return projectUrl();
    return projectUrl;
  },
});

describe("resolveResourceLink: tier -> correct target (BUTCHR-339 mutation 7 — Jira for a project, or Confluence for an issue, is a named failure)", () => {
  test("an ISSUE key resolves to the Jira browse URL, never a Confluence call", async () => {
    let projectCalls = 0;
    const d = { jiraSite: "https://wroosbit.atlassian.net", projectRootDocUrl: async () => { projectCalls++; return "should-not-be-called"; } };
    const r = await resolveResourceLink("KAN-9", d);
    expect(r).toEqual({ ok: true, url: "https://wroosbit.atlassian.net/browse/KAN-9" });
    expect(projectCalls).toBe(0); // THE MUTATION: swapping branches would call projectRootDocUrl for an issue key
  });

  test("a PROJECT id resolves to its Confluence root-doc URL, never a Jira browse link", async () => {
    const r = await resolveResourceLink("KAN", deps("https://wroosbit.atlassian.net/wiki/spaces/KAN/pages/42"));
    expect(r).toEqual({ ok: true, url: "https://wroosbit.atlassian.net/wiki/spaces/KAN/pages/42" });
    if (r.ok) expect(r.url).not.toContain("/browse/"); // THE MUTATION: swapping branches would produce a /browse/ link for a project
  });

  // THE MUTATION ITSELF, pinned directly: reversing which branch handles
  // which predicate produces exactly this wrong pairing for BOTH kinds of
  // key at once — a single assertion that would fail for either direction
  // of the swap.
  test("swap-detector: an issue key's result is never a project-shaped URL and vice versa", async () => {
    const issue = await resolveResourceLink("KAN-9", deps("https://wroosbit.atlassian.net/wiki/x"));
    const project = await resolveResourceLink("KAN", deps("https://wroosbit.atlassian.net/wiki/x"));
    if (!issue.ok || !project.ok) throw new Error("expected both to resolve");
    expect(issue.url).toContain("/browse/KAN-9");
    expect(project.url).not.toContain("/browse/");
  });

  test("an unresolvable project (rootDoc read throws) is refused with the thrown message, not a guessed default", async () => {
    const d = { jiraSite: "https://wroosbit.atlassian.net", projectRootDocUrl: async () => { throw new Error("project KAN: \"butchr\" entity property is missing rootDoc.id"); } };
    const r = await resolveResourceLink("KAN", d);
    expect(r).toEqual({ ok: false, error: "project KAN: \"butchr\" entity property is missing rootDoc.id" });
  });

  test("a project root doc resolving to an empty URL is refused, never rendered as a working empty-string link", async () => {
    const r = await resolveResourceLink("KAN", deps(""));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no resolvable URL");
  });

  test("a key that is neither a valid issue key nor a valid project id is refused with a specific reason, never silently defaulted to either branch", async () => {
    const r = await resolveResourceLink("not a key!", deps());
    expect(r).toEqual({ ok: false, error: "\"not a key!\" is neither a valid Jira issue key nor a valid project id — cannot resolve a resource link for it" });
  });
});
