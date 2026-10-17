/**
 * local/ui — the credentials summary `GET /api/settings` carries: sources,
 * paths, file health and setup-code instructions, never a token value.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCredentialsSummary, setupCodeInstructions, type CredentialsSummaryInput } from "../../src/web/credentials-api.js";

const CANARY = "s3cr3t-canary-TOKEN-value";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "butchr-summary-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const STARTED = "2026-10-16T11:55:17.444Z";
const launchd = { kind: "launchd" as const, job: { label: "com.example.butchr", target: "gui/501/com.example.butchr", stderrPath: "/Users/b/Library/Logs/butchr.log" } };

function input(overrides: Partial<CredentialsSummaryInput> = {}): CredentialsSummaryInput {
  return { rawEnv: { XDG_CONFIG_HOME: dir }, settingsFileValues: {}, atlassian: { site: "https://x.atlassian.net", email: "a@b.c" }, githubActive: false, running: { githubOrgs: [], zendeskSubdomain: null, trelloBoardId: null }, startedAt: STARTED, supervisor: launchd, ownPid: 77, ...overrides };
}

describe("buildCredentialsSummary", () => {
  test("an env-named Atlassian file, a not-yet-set GitHub token, and no token value anywhere", async () => {
    const atl = join(dir, "atlassian-token");
    writeFileSync(atl, CANARY, { mode: 0o644 });
    const summary = await buildCredentialsSummary(input({ rawEnv: { XDG_CONFIG_HOME: dir, ATLASSIAN_TOKEN_FILE: atl } }));
    expect(summary.atlassian).toEqual({
      site: "https://x.atlassian.net",
      email: "a@b.c",
      token: { source: "env-file", fileEnvKey: "ATLASSIAN_TOKEN_FILE", path: atl, exists: true, readable: true, mode: 0o644, tooOpen: true, readOnlyReason: null },
    });
    expect(summary.github.token).toEqual({ source: "unset", fileEnvKey: "GITHUB_TOKEN_FILE", path: join(dir, "butchr", "secrets", "github-token"), exists: false, readable: false, mode: null, tooOpen: null, readOnlyReason: null });
    expect(JSON.stringify(summary)).not.toContain(CANARY);
  });

  test("a managed GitHub token shows as secrets-file; a literal Atlassian token is read-only", async () => {
    const managed = join(dir, "butchr", "secrets", "github-token");
    const summary = await buildCredentialsSummary(input({ rawEnv: { XDG_CONFIG_HOME: dir, ATLASSIAN_TOKEN: CANARY } }), async () => ({ exists: true, readable: true, mode: 0o600 }), (p) => p === managed);
    expect(summary.github.token).toMatchObject({ source: "secrets-file", path: managed, exists: true, tooOpen: false });
    expect(summary.atlassian.token).toMatchObject({ source: "env-literal", path: null, readOnlyReason: expect.stringContaining("ATLASSIAN_TOKEN_FILE") });
    expect(JSON.stringify(summary)).not.toContain(CANARY);
  });

  test("orgs come from the env first, else settings.json; only a non-env list is editable", async () => {
    const fromFile = await buildCredentialsSummary(input({ settingsFileValues: { BUTCHR_GITHUB_ORGS: "acme,octocat" }, githubActive: true }));
    expect(fromFile.github).toMatchObject({ orgs: ["acme", "octocat"], orgsSource: "file", orgsEditable: true, active: true });
    const fromEnv = await buildCredentialsSummary(input({ rawEnv: { XDG_CONFIG_HOME: dir, BUTCHR_GITHUB_ORGS: " envorg " }, settingsFileValues: { BUTCHR_GITHUB_ORGS: "acme" } }));
    expect(fromEnv.github).toMatchObject({ orgs: ["envorg"], orgsSource: "environment", orgsEditable: false });
    const none = await buildCredentialsSummary(input());
    expect(none.github).toMatchObject({ orgs: [], orgsSource: "default", orgsEditable: true });
  });

  test("next to each saved setting, what this daemon started with (it keeps using that until a restart)", async () => {
    const summary = await buildCredentialsSummary(input({
      settingsFileValues: { BUTCHR_GITHUB_ORGS: "example-org,another-org", ZENDESK_SUBDOMAIN: "newco" },
      githubActive: true,
      running: { githubOrgs: ["acme"], zendeskSubdomain: "oldco", trelloBoardId: null },
    }));
    expect(summary.github).toMatchObject({ orgs: ["example-org", "another-org"], runningOrgs: ["acme"], active: true });
    expect(summary.zendesk.subdomain).toEqual({ value: "newco", source: "file", editable: true, running: "oldco" });
    expect(summary.trello.boardId).toEqual({ value: null, source: "default", editable: true, running: null });
  });

  test("a site with embedded credentials is redacted", async () => {
    const summary = await buildCredentialsSummary(input({ atlassian: { site: "https://user:pass@x.atlassian.net", email: "a@b.c" } }));
    expect(summary.atlassian.site).toBe("https://[redacted]@x.atlassian.net");
  });
});

describe("setupCodeInstructions", () => {
  test("launchd: launchctl kill for this job, and a grep of its own stderr log", () => {
    expect(setupCodeInstructions(launchd, 77)).toEqual({
      command: "launchctl kill SIGUSR2 gui/$(id -u)/com.example.butchr",
      findCommand: "grep 'setup code' /Users/b/Library/Logs/butchr.log | tail -1",
      where: "butchr's log (/Users/b/Library/Logs/butchr.log)",
    });
    const spaced = setupCodeInstructions({ kind: "launchd", job: { ...launchd.job, stderrPath: "/Users/b/My Logs/it's.log" } }, 77);
    expect(spaced.findCommand).toBe(`grep 'setup code' '/Users/b/My Logs/it'\\''s.log' | tail -1`);
  });

  test("systemd and an unsupervised process", () => {
    expect(setupCodeInstructions({ kind: "systemd" }, 77).command).toBe("systemctl --user kill -s SIGUSR2 butchr.service");
    expect(setupCodeInstructions({ kind: "none" }, 77)).toEqual({ command: "kill -USR2 77", findCommand: null, where: "butchr's own output (stderr)" });
  });

  test("restart support follows the supervisor", async () => {
    expect((await buildCredentialsSummary(input())).restart).toEqual({ supported: true, supervisor: "launchd", startedAt: STARTED });
    expect((await buildCredentialsSummary(input({ supervisor: { kind: "none" } }))).restart).toEqual({ supported: false, supervisor: "none", startedAt: STARTED });
  });
});
