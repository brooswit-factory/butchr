/**
 * local/ui — where web-set credentials are written (`secret-target.ts`),
 * the GitHub token writer (`github-token-write.ts`), the relaxed Atlassian
 * rotation check, `~` expansion, and the GitHub effective-env fill-in.
 * Real temp directories only; never ~/.config/butchr.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandHomePath } from "../../src/config/home-path.js";
import { loadConfig } from "../../src/config/config.js";
import { resolveEffectiveGithubEnv } from "../../src/config/effective-env.js";
import { checkSecretDestination, resolveCredentialTarget, type SecretDestinationIo } from "../../src/setup/secret-target.js";
import { loadZendeskAuth } from "../../src/resources/zendesk-ticket.js";
import { loadTrelloAuth } from "../../src/resources/trello-card.js";
import { githubTokenFilePath, testCandidateGithubToken, writeGithubToken } from "../../src/setup/github-token-write.js";
import type { FetchLike } from "../../src/setup/jira-token-write.js";
import { handleJiraTokenWrite, isTokenLiteralFromEnvironment } from "../../src/web/setup-api.js";
import { createSetupCodeManager } from "../../src/setup/setup-code.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-credentials-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CANARY = "ghp_canaryTOKEN0123456789";
const modeOf = (p: string) => statSync(p).mode & 0o777;

/** A fake GitHub: maps a bearer token to the `/user` response it gets. */
function github(users: Record<string, number | string | Error>): { fetchFn: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const token = String((init.headers as Record<string, string>).authorization).replace(/^Bearer /, "");
    const user = users[token];
    if (user instanceof Error) throw user;
    if (user === undefined || typeof user === "number") return new Response("{}", { status: typeof user === "number" ? user : 401 });
    return new Response(JSON.stringify({ login: user, id: 1 }), { status: 200 });
  };
  return { fetchFn, calls };
}

describe("expandHomePath", () => {
  test("expands ~ and ~/ only; everything else is untouched", () => {
    expect(expandHomePath("~/.config/x", { HOME: "/home/b" })).toBe("/home/b/.config/x");
    expect(expandHomePath("~", { HOME: "/home/b" })).toBe("/home/b");
    expect(expandHomePath("/abs/x", { HOME: "/home/b" })).toBe("/abs/x");
    expect(expandHomePath("~other/x", { HOME: "/home/b" })).toBe("~other/x");
    expect(expandHomePath("rel/x", { HOME: "/home/b" })).toBe("rel/x");
  });

  test("loadConfig reads a ~/ token file from the home directory", () => {
    const reads: string[] = [];
    const config = loadConfig({ ATLASSIAN_SITE: "https://x.atlassian.net", ATLASSIAN_EMAIL: "a@b.c", ATLASSIAN_TOKEN_FILE: "~/atl", GITHUB_TOKEN_FILE: "~/gh", BUTCHR_GITHUB_ORGS: "acme", HOME: "/home/b" } as never, (p) => {
      reads.push(p);
      return "tok\n";
    });
    expect(reads).toEqual(["/home/b/atl", "/home/b/gh"]);
    expect(config.github?.orgs).toEqual(["acme"]);
  });
});

describe("resolveCredentialTarget", () => {
  const never = () => false;
  test("Atlassian: an env-named file wins, ~ expanded, and is written in place", () => {
    expect(resolveCredentialTarget("atlassian", { ATLASSIAN_TOKEN_FILE: "~/t", ATLASSIAN_TOKEN: "lit", HOME: "/h" }, never)).toEqual({
      name: "atlassian", fileEnvKey: "ATLASSIAN_TOKEN_FILE", source: "env-file", path: "/h/t", readOnlyReason: null, managed: false,
    });
  });

  test("Atlassian: a literal ATLASSIAN_TOKEN can't be changed from the web", () => {
    const t = resolveCredentialTarget("atlassian", { ATLASSIAN_TOKEN: "lit" }, never);
    expect([t.source, t.path, t.managed]).toEqual(["env-literal", null, false]);
    expect(t.readOnlyReason).toContain("ATLASSIAN_TOKEN_FILE");
  });

  test("unset env: the managed secrets path, secrets-file once it exists", () => {
    const env = { XDG_CONFIG_HOME: dir };
    expect(resolveCredentialTarget("atlassian", env, never)).toMatchObject({ source: "unset", path: join(dir, "butchr", "secrets", "atlassian-token"), managed: true });
    expect(resolveCredentialTarget("github", env, () => true)).toMatchObject({ source: "secrets-file", path: join(dir, "butchr", "secrets", "github-token"), managed: true, fileEnvKey: "GITHUB_TOKEN_FILE" });
    expect(githubTokenFilePath({ BUTCHR_SECRETS_DIR: "/s" })).toBe("/s/github-token");
  });

  test("a relative env-named path is read-only", () => {
    const t = resolveCredentialTarget("github", { GITHUB_TOKEN_FILE: "gh-token" }, never);
    expect([t.source, t.path]).toEqual(["env-file", "gh-token"]);
    expect(t.readOnlyReason).toContain("absolute");
  });

  test("isTokenLiteralFromEnvironment matches loadConfig's precedence", () => {
    expect(isTokenLiteralFromEnvironment({ ATLASSIAN_TOKEN: "x" })).toBe(true);
    expect(isTokenLiteralFromEnvironment({ ATLASSIAN_TOKEN: "x", ATLASSIAN_TOKEN_FILE: "/f" })).toBe(false);
    expect(isTokenLiteralFromEnvironment({ ATLASSIAN_TOKEN_FILE: "/f" })).toBe(false);
    expect(isTokenLiteralFromEnvironment({})).toBe(false);
  });
});

describe("checkSecretDestination", () => {
  test("refuses a symlink, a directory, a relative path, and an env-named path whose directory is missing", () => {
    writeFileSync(join(dir, "real"), "x");
    symlinkSync(join(dir, "real"), join(dir, "link"));
    mkdirSync(join(dir, "adir"));
    expect(checkSecretDestination(join(dir, "link"), { managed: false })).toMatchObject({ ok: false, error: expect.stringContaining("symlink") });
    expect(checkSecretDestination(join(dir, "adir"), { managed: false })).toMatchObject({ ok: false, error: expect.stringContaining("not a regular file") });
    expect(checkSecretDestination("relative/token", { managed: false })).toMatchObject({ ok: false, error: expect.stringContaining("absolute") });
    expect(checkSecretDestination(join(dir, "missing", "token"), { managed: false })).toMatchObject({ ok: false, error: expect.stringContaining("doesn't exist") });
  });

  test("accepts an existing regular file, a new file in an existing directory, and a managed path whose directory is still missing", () => {
    writeFileSync(join(dir, "real"), "x");
    expect(checkSecretDestination(join(dir, "real"), { managed: false })).toEqual({ ok: true });
    expect(checkSecretDestination(join(dir, "new-token"), { managed: false })).toEqual({ ok: true });
    expect(checkSecretDestination(join(dir, "secrets", "github-token"), { managed: true })).toEqual({ ok: true });
  });

  test("refuses a file owned by another uid", () => {
    const io: SecretDestinationIo = { lstat: () => ({ isSymbolicLink: false, isFile: true, uid: 0 }), dirExists: () => true, ownUid: () => 501 };
    expect(checkSecretDestination("/etc/token", { managed: false }, io)).toMatchObject({ ok: false, error: expect.stringContaining("owned by uid 0") });
  });
});

describe("writeGithubToken", () => {
  test("tests the token first, then writes it at 0600 (creating the managed directory at 0700)", async () => {
    const path = join(dir, "secrets", "github-token");
    const { fetchFn, calls } = github({ [CANARY]: "octocat" });
    expect(await writeGithubToken(CANARY, path, { createDir: true }, undefined, fetchFn)).toEqual({ ok: true, login: "octocat", rotated: false });
    expect(readFileSync(path, "utf8")).toBe(CANARY);
    expect(modeOf(path)).toBe(0o600);
    expect(modeOf(join(dir, "secrets"))).toBe(0o700);
    expect(calls[0]!.url).toBe("https://api.github.com/user");
    expect(calls[0]!.init.redirect).toBe("error");
  });

  test("replacing an existing file tightens a wide mode to 0600", async () => {
    const path = join(dir, "gh");
    writeFileSync(path, "old-token");
    chmodSync(path, 0o644);
    const { fetchFn } = github({ "old-token": "octocat", [CANARY]: "octocat" });
    expect(await writeGithubToken(CANARY, path, { createDir: false }, undefined, fetchFn)).toEqual({ ok: true, login: "octocat", rotated: true });
    expect(modeOf(path)).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(CANARY);
  });

  test("a working current token for a different login refuses, leaving the file alone", async () => {
    const path = join(dir, "gh");
    writeFileSync(path, "old-token", { mode: 0o600 });
    const { fetchFn } = github({ "old-token": "someone", [CANARY]: "octocat" });
    expect(await writeGithubToken(CANARY, path, { createDir: false }, undefined, fetchFn)).toEqual({ ok: false, reason: "login-mismatch", currentLogin: "someone", candidateLogin: "octocat" });
    expect(readFileSync(path, "utf8")).toBe("old-token");
  });

  test("a current token GitHub rejects can be replaced; one that can't be checked refuses", async () => {
    const path = join(dir, "gh");
    writeFileSync(path, "dead-token", { mode: 0o600 });
    expect(await writeGithubToken(CANARY, path, { createDir: false }, undefined, github({ "dead-token": 401, [CANARY]: "octocat" }).fetchFn)).toMatchObject({ ok: true, rotated: true });
    writeFileSync(path, "flaky-token", { mode: 0o600 });
    expect(await writeGithubToken(CANARY, path, { createDir: false }, undefined, github({ "flaky-token": new Error("socket hang up"), [CANARY]: "octocat" }).fetchFn)).toMatchObject({ ok: false, reason: "current-token-unverifiable" });
    expect(readFileSync(path, "utf8")).toBe("flaky-token");
  });

  test("a rejected candidate or a symlinked destination writes nothing; errors never carry the token", async () => {
    const path = join(dir, "gh");
    const rejected = await writeGithubToken(CANARY, path, { createDir: false }, undefined, github({}).fetchFn);
    expect(rejected).toEqual({ ok: false, reason: "test-failed", error: "GitHub rejected this token (401/403)." });
    expect(() => lstatSync(path)).toThrow();
    writeFileSync(join(dir, "target"), "x");
    symlinkSync(join(dir, "target"), path);
    expect(await writeGithubToken(CANARY, path, { createDir: false }, undefined, github({ [CANARY]: "octocat" }).fetchFn)).toEqual({ ok: false, reason: "destination-symlink" });
    expect(JSON.stringify([rejected])).not.toContain(CANARY);
  });

  test("testCandidateGithubToken names a redirect and a network failure without their messages", async () => {
    expect(await testCandidateGithubToken(CANARY, async () => { throw new TypeError(`redirect not allowed for https://api.github.com/user?t=${CANARY}`); })).toEqual({ ok: false, reason: "redirect" });
    expect(await testCandidateGithubToken(CANARY, async () => { throw new Error(`boom ${CANARY}`); })).toEqual({ ok: false, reason: "network" });
    expect(await testCandidateGithubToken(CANARY, async () => new Response("{}", { status: 200 }))).toEqual({ ok: false, reason: "other" });
  });
});

describe("Atlassian rotation (relaxed env check)", () => {
  const okFetch: FetchLike = async () => new Response(JSON.stringify({ accountId: "acct-1", displayName: "D" }), { status: 200 });

  test("an env-named token file is rotated in place", async () => {
    const path = join(dir, "atlassian-token");
    writeFileSync(path, "old", { mode: 0o600 });
    const setupCode = createSetupCodeManager();
    const code = setupCode.mint();
    const r = await handleJiraTokenWrite(
      { site: "https://x.atlassian.net", email: "a@b.c", token: "new-atl-token", setupCode: code },
      { setupCode, fetchFn: okFetch, path, env: { ATLASSIAN_TOKEN_FILE: path }, checkDestination: (p) => checkSecretDestination(p, { managed: false }) },
      { requireEnvCheck: true },
    );
    expect(r).toMatchObject({ ok: true, status: 200, body: { rotated: true, restartNeeded: true } });
    expect(readFileSync(path, "utf8")).toBe("new-atl-token");
    expect(modeOf(path)).toBe(0o600);
  });

  test("a bad destination answers 400 before the setup code is spent", async () => {
    writeFileSync(join(dir, "target"), "x");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    const setupCode = createSetupCodeManager();
    const code = setupCode.mint();
    const r = await handleJiraTokenWrite(
      { site: "https://x.atlassian.net", email: "a@b.c", token: "new", setupCode: code },
      { setupCode, fetchFn: okFetch, path: join(dir, "link"), env: { ATLASSIAN_TOKEN_FILE: join(dir, "link") }, checkDestination: (p) => checkSecretDestination(p, { managed: false }) },
      { requireEnvCheck: true },
    );
    expect(r).toMatchObject({ ok: false, status: 400, body: { error: expect.stringContaining("symlink") } });
    expect(setupCode.check(code)).toEqual({ ok: true });
  });
});

describe("resolveEffectiveGithubEnv", () => {
  test("fills GITHUB_TOKEN_FILE from secrets/github-token only when the env leaves it unset", () => {
    const managed = join(dir, "butchr", "secrets", "github-token");
    const env = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({ XDG_CONFIG_HOME: dir, ...extra });
    expect(resolveEffectiveGithubEnv(env(), { managedTokenFileExists: (p) => p === managed })).toEqual({ XDG_CONFIG_HOME: dir, GITHUB_TOKEN_FILE: managed });
    expect(resolveEffectiveGithubEnv(env(), { managedTokenFileExists: () => false })).toEqual({ XDG_CONFIG_HOME: dir });
    expect(resolveEffectiveGithubEnv(env({ GITHUB_TOKEN_FILE: "/env/gh" }), { managedTokenFileExists: () => true })).toEqual({ XDG_CONFIG_HOME: dir, GITHUB_TOKEN_FILE: "/env/gh" });
  });
});

describe("a ~/ token file path: Settings writes it and the daemon reads it at the same place", () => {
  // Fake file io: every stat/read is recorded, and each path holds a placeholder value, never a real credential.
  function io() {
    const opened: string[] = [];
    const st = { isFile: () => true, mode: 0o100600, uid: 501 };
    return { opened, io: { stat: (p: string) => { opened.push(p); return st; }, readFile: (p: string) => { opened.push(p); return "placeholder-value"; }, uid: 501 } };
  }

  test("Zendesk: the loader opens the expanded path resolveCredentialTarget writes", () => {
    const env = { HOME: "/home/someone", ZENDESK_SUBDOMAIN: "acme", ZENDESK_OAUTH_TOKEN_FILE: "~/zendesk-token" };
    const { opened, io: fileIo } = io();
    expect(loadZendeskAuth(env, fileIo as never)).toMatchObject({ ok: true, subdomain: "acme" });
    expect(new Set<string | null>(opened)).toEqual(new Set([resolveCredentialTarget("zendesk", env, () => true).path]));
    expect(opened[0]).toBe("/home/someone/zendesk-token");
  });

  test("Trello: both the key and the token files are opened at their expanded paths", () => {
    const env = { HOME: "/home/someone", TRELLO_BOARD_ID: "0123456789abcdef01234567", TRELLO_API_KEY_FILE: "~/trello-key", TRELLO_TOKEN_FILE: "~/trello-token" };
    const { opened, io: fileIo } = io();
    expect(loadTrelloAuth(env, fileIo as never)).toMatchObject({ ok: true });
    expect(new Set<string | null>(opened)).toEqual(new Set([resolveCredentialTarget("trello-key", env, () => true).path, resolveCredentialTarget("trello-token", env, () => true).path]));
    expect(new Set(opened)).toEqual(new Set(["/home/someone/trello-key", "/home/someone/trello-token"]));
  });
});
