/** local/ui — the credential cards' text helpers (`view-model/credentials-view.ts`). */
import { describe, expect, test } from "bun:test";
import { GITHUB_ORGS_MAX, githubTestText, jiraTestText, orgRowProblems, orgsToSave, pendingRestartChanges, stillUsingText, tokenIsSet, tokenLocationText, tokenWarning } from "../../dashboard-app/src/view-model/credentials-view.js";
import { localUiSettingsFixture, type CredentialsSummary, type TokenStatus } from "../../dashboard-app/src/api/settings.js";

const token = (overrides: Partial<TokenStatus>): TokenStatus => ({ source: "env-file", fileEnvKey: "ATLASSIAN_TOKEN_FILE", path: "/p/t", exists: true, readable: true, mode: 0o600, tooOpen: false, readOnlyReason: null, ...overrides });

describe("credentials view text", () => {
  test("where a token is, or will be", () => {
    expect(tokenLocationText(token({}))).toBe("Stored in /p/t (named by ATLASSIAN_TOKEN_FILE).");
    expect(tokenLocationText(token({ source: "secrets-file" }))).toBe("Stored in /p/t.");
    expect(tokenLocationText(token({ source: "unset", exists: false }))).toBe("Not set. Saving one writes /p/t.");
    expect(tokenLocationText(token({ source: "env-literal", path: null }))).toBe("Set directly in butchr's environment.");
  });

  test("file problems, and whether a token is set", () => {
    expect(tokenWarning(token({}))).toBeNull();
    expect(tokenWarning(token({ mode: 0o644, tooOpen: true }))).toBe("Its mode is 644, wider than 0600. Saving a new token replaces it with an owner-only file.");
    expect(tokenWarning(token({ exists: false, readable: false }))).toBe("That file doesn't exist. Saving a token creates it.");
    expect(tokenWarning(token({ readable: false }))).toBe("butchr can't read that file.");
    expect(tokenWarning(token({ source: "unset", exists: false }))).toBeNull();
    expect([tokenIsSet(token({})), tokenIsSet(token({ source: "unset", exists: false })), tokenIsSet(token({ source: "env-literal", exists: false }))]).toEqual([true, false, true]);
  });

  test("test results", () => {
    expect(jiraTestText({ ok: true, site: "s", httpStatusClass: "2xx" })).toBe("Connected.");
    expect(jiraTestText({ ok: false, site: "s", httpStatusClass: "401/403", error: "Jira rejected these credentials (401/403)." })).toBe("Jira rejected these credentials (401/403).");
    expect(githubTestText({ ok: true, login: "octo", httpStatusClass: "2xx", orgs: [] })).toBe("Signed in as octo. No organizations are set, so the GitHub integration stays off.");
    expect(githubTestText({ ok: false, httpStatusClass: "401/403", error: "GitHub rejected this token (401/403).", orgs: [] })).toBe("GitHub rejected this token (401/403).");
  });

  test("the org list saves trimmed rows and drops blank ones", () => {
    expect(orgsToSave([" example-org ", "", "  ", "another-org"])).toEqual(["example-org", "another-org"]);
    expect(orgsToSave([])).toEqual([]);
  });

  test("org rows are checked like butchr's settings check: name shape, then repeats on the later row", () => {
    expect(orgRowProblems(["example-org", "", "a".repeat(39), "0x-org"])).toEqual([null, null, null, null]);
    const shape = "Use letters, digits and hyphens, up to 39 characters, starting with a letter or digit.";
    expect(orgRowProblems(["has space", "-leading", "dot.ted", "a,b", "a".repeat(40)])).toEqual([shape, shape, shape, shape, shape]);
    expect(orgRowProblems(["acme", " Acme ", "acme"])).toEqual([null, "Already in the list.", "Already in the list."]);
    expect(GITHUB_ORGS_MAX).toBe(20);
  });

  test("what's saved but not running yet: orgs, the Zendesk subdomain and the Trello board, each against what butchr started with", () => {
    const base = localUiSettingsFixture().credentials!;
    const with_ = (patch: (c: CredentialsSummary) => CredentialsSummary) => pendingRestartChanges(patch(structuredClone(base)));
    expect(pendingRestartChanges(base)).toEqual([]);
    expect(with_((c) => ({ ...c, github: { ...c.github, orgs: ["example-org"], runningOrgs: ["acme"] } }))).toEqual(["the GitHub organizations"]);
    expect(with_((c) => ({ ...c, github: { ...c.github, orgs: ["example-org"], runningOrgs: ["example-org"] } }))).toEqual([]);
    expect(with_((c) => ({ ...c, zendesk: { ...c.zendesk, subdomain: { ...c.zendesk.subdomain, value: "newco", running: null } }, trello: { ...c.trello, boardId: { ...c.trello.boardId, value: null, running: "0123456789abcdef01234567" } } }))).toEqual(["the Zendesk subdomain", "the Trello board"]);
    // A butchr too old to report what it runs never shows anything pending.
    const { runningOrgs: _dropped, ...oldGithub } = { ...base.github, orgs: ["x"] };
    const old = { ...base, github: oldGithub, zendesk: { ...base.zendesk, subdomain: { value: "x", source: "file", editable: true } } } as unknown as CredentialsSummary;
    expect(pendingRestartChanges(old)).toEqual([]);
    expect(stillUsingText("acme")).toBe("butchr is still using acme until it restarts.");
    expect(stillUsingText(null)).toBe("butchr starts using this when it restarts.");
  });
});
