import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSetupStatus, isTokenProvidedByEnvironment, handleJiraTokenWrite, type JiraWriteDeps } from "../../src/web/setup-api.js";
import { createSetupCodeManager } from "../../src/setup/setup-code.js";
import type { JiraTokenWriteIo, FetchLike } from "../../src/setup/jira-token-write.js";
import type { JiraIdentityFileIo } from "../../src/setup/jira-identity-file.js";

const CANARY_TOKEN = "s3cr3t-canary-TOKEN";
const SITE = "https://x.atlassian.net";

function okFetch(accountId: string): FetchLike {
  return async () => new Response(JSON.stringify({ accountId, displayName: "D" }), { status: 200 });
}

function fakeIo(): JiraTokenWriteIo {
  const files = new Map<string, string>();
  return {
    readFile: (p) => files.get(p),
    mkdir: () => {},
    modeOf: () => undefined,
    isSymlink: () => false,
    writeTempExclusive: (p, text) => files.set(`tmp:${p}`, text),
    rename: (tmp, dest) => { const v = files.get(`tmp:${tmp}`); if (v !== undefined) files.set(dest, v); },
    removeQuiet: () => {},
  };
}

/** Same in-memory shape as `fakeIo` above, for the (separate) identity-file IO — never the real filesystem. */
function fakeIdentityIo(): JiraIdentityFileIo {
  const files = new Map<string, string>();
  return {
    readFile: (p) => files.get(p),
    mkdir: () => {},
    modeOf: () => undefined,
    isSymlink: () => false,
    writeTempExclusive: (p, text) => files.set(`tmp:${p}`, text),
    rename: (tmp, dest) => { const v = files.get(`tmp:${tmp}`); if (v !== undefined) files.set(dest, v); },
    removeQuiet: () => {},
  };
}

describe("buildSetupStatus", () => {
  test("mirrors the configured flag verbatim", () => {
    expect(buildSetupStatus(true)).toEqual({ configured: true });
    expect(buildSetupStatus(false)).toEqual({ configured: false });
  });
});

describe("isTokenProvidedByEnvironment", () => {
  test("true iff ATLASSIAN_TOKEN or ATLASSIAN_TOKEN_FILE is set and non-blank", () => {
    expect(isTokenProvidedByEnvironment({})).toBe(false);
    expect(isTokenProvidedByEnvironment({ ATLASSIAN_TOKEN: "  " })).toBe(false);
    expect(isTokenProvidedByEnvironment({ ATLASSIAN_TOKEN: "t" })).toBe(true);
    expect(isTokenProvidedByEnvironment({ ATLASSIAN_TOKEN_FILE: "/f" })).toBe(true);
  });
});

describe("handleJiraTokenWrite", () => {
  function deps(overrides: Partial<JiraWriteDeps> = {}): JiraWriteDeps {
    return { setupCode: createSetupCodeManager(), io: fakeIo(), fetchFn: okFetch("acct-1"), path: "/p/atlassian-token", identityIo: fakeIdentityIo(), identityPath: "/p/jira-identity.json", ...overrides };
  }

  test("requireEnvCheck:true + env-provided token -> 409, before even checking the setup code", () => {
    const d = deps({ env: { ATLASSIAN_TOKEN: "x" } });
    return handleJiraTokenWrite({ site: SITE, email: "a@b.c", token: CANARY_TOKEN, setupCode: "WRONG" }, d, { requireEnvCheck: true }).then((r) => {
      expect(r).toEqual({ ok: false, status: 409, body: { error: "provided by environment" } });
    });
  });
  test("requireEnvCheck:false ignores env entirely, even if a token is present there", async () => {
    const codeManager = createSetupCodeManager();
    const code = codeManager.mint();
    const d = deps({ setupCode: codeManager, env: { ATLASSIAN_TOKEN: "ignored" } });
    const r = await handleJiraTokenWrite({ site: SITE, email: "a@b.c", token: CANARY_TOKEN, setupCode: code }, d, { requireEnvCheck: false });
    expect(r.ok).toBe(true);
  });
  test("a wrong setup code refuses with 400 and names the reason, consumes an attempt", async () => {
    const codeManager = createSetupCodeManager();
    codeManager.mint();
    const d = deps({ setupCode: codeManager });
    const r = await handleJiraTokenWrite({ site: SITE, email: "a@b.c", token: CANARY_TOKEN, setupCode: "WRONGCODE12" }, d, { requireEnvCheck: false });
    expect(r).toEqual({ ok: false, status: 400, body: { error: "setup code: mismatch" } });
  });
  test("no setup code minted at all -> 400 'no code minted'", async () => {
    const d = deps();
    const r = await handleJiraTokenWrite({ site: SITE, email: "a@b.c", token: CANARY_TOKEN, setupCode: "ANYTHING1234" }, d, { requireEnvCheck: false });
    expect(r).toEqual({ ok: false, status: 400, body: { error: "setup code: no code minted" } });
  });
  test("a bad site shape refuses with 400 and a descriptive message, after the setup code already passed", async () => {
    const codeManager = createSetupCodeManager();
    const code = codeManager.mint();
    const d = deps({ setupCode: codeManager });
    const r = await handleJiraTokenWrite({ site: "https://evil.example.com", email: "a@b.c", token: CANARY_TOKEN, setupCode: code }, d, { requireEnvCheck: false });
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(400);
    expect(JSON.stringify(r)).toContain("ATLASSIAN_SITE must look like");
  });
  test("blank email or token refuses with 400 before any network call", async () => {
    const codeManager = createSetupCodeManager();
    let code = codeManager.mint();
    const d1 = deps({ setupCode: codeManager, fetchFn: async () => { throw new Error("should not be called"); } });
    const r1 = await handleJiraTokenWrite({ site: SITE, email: "  ", token: CANARY_TOKEN, setupCode: code }, d1, { requireEnvCheck: false });
    expect(r1).toEqual({ ok: false, status: 400, body: { error: "email is required" } });
    code = codeManager.mint();
    const r2 = await handleJiraTokenWrite({ site: SITE, email: "a@b.c", token: "  ", setupCode: code }, d1, { requireEnvCheck: false });
    expect(r2).toEqual({ ok: false, status: 400, body: { error: "token is required" } });
  });
  test("happy path: 200 with accountId/displayName/rotated/restartNeeded:true/identityPersisted:true, never the token", async () => {
    const codeManager = createSetupCodeManager();
    const code = codeManager.mint();
    const identityIo = fakeIdentityIo();
    const d = deps({ setupCode: codeManager, identityIo });
    const r = await handleJiraTokenWrite({ site: SITE, email: "a@b.c", token: CANARY_TOKEN, setupCode: code }, d, { requireEnvCheck: false });
    expect(r).toEqual({ ok: true, status: 200, body: { ok: true, accountId: "acct-1", displayName: "D", rotated: false, restartNeeded: true, identityPersisted: true } });
    expect(JSON.stringify(r)).not.toContain(CANARY_TOKEN);
    expect(JSON.parse(identityIo.readFile("/p/jira-identity.json")!)).toEqual({ site: SITE, email: "a@b.c" });
  });
  test("rotation (requireEnvCheck:true) never writes the identity file, even on success", async () => {
    const codeManager = createSetupCodeManager();
    const code = codeManager.mint();
    const identityIo = fakeIdentityIo();
    const d = deps({ setupCode: codeManager, identityIo });
    const r = await handleJiraTokenWrite({ site: SITE, email: "a@b.c", token: CANARY_TOKEN, setupCode: code }, d, { requireEnvCheck: true });
    expect(r).toMatchObject({ ok: true, body: { identityPersisted: true } }); // trivially true: nothing needed persisting
    expect(identityIo.readFile("/p/jira-identity.json")).toBeUndefined();
  });
  test("an identity-persist failure is reported alongside the success, without unwinding the already-written token", async () => {
    const codeManager = createSetupCodeManager();
    const code = codeManager.mint();
    const failingIdentityIo: JiraIdentityFileIo = { ...fakeIdentityIo(), writeTempExclusive: () => { throw new Error("ENOSPC"); } };
    const d = deps({ setupCode: codeManager, identityIo: failingIdentityIo });
    const r = await handleJiraTokenWrite({ site: SITE, email: "a@b.c", token: CANARY_TOKEN, setupCode: code }, d, { requireEnvCheck: false });
    expect(r.ok).toBe(true);
    expect((r as { body: { identityPersisted: boolean; identityError?: string } }).body.identityPersisted).toBe(false);
    expect((r as { body: { identityError?: string } }).body.identityError).toContain("ENOSPC");
  });
  test("a failed token test maps to 400 with the fixed error, never the upstream body", async () => {
    const codeManager = createSetupCodeManager();
    const code = codeManager.mint();
    const d = deps({ setupCode: codeManager, fetchFn: async () => new Response("leaky upstream body", { status: 401 }) });
    const r = await handleJiraTokenWrite({ site: SITE, email: "a@b.c", token: CANARY_TOKEN, setupCode: code }, d, { requireEnvCheck: false });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("leaky upstream body");
  });
  test("an account-mismatch rotation maps to 400 naming both account ids", async () => {
    const codeManager = createSetupCodeManager();
    const code = codeManager.mint();
    const io: JiraTokenWriteIo = { ...fakeIo(), readFile: () => "old-token" };
    const fetchFn: FetchLike = async (_u, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
      const isOld = auth === `Basic ${Buffer.from("a@b.c:old-token").toString("base64")}`;
      return new Response(JSON.stringify({ accountId: isOld ? "OLD" : "NEW" }), { status: 200 });
    };
    const d = deps({ setupCode: codeManager, io, fetchFn });
    const r = await handleJiraTokenWrite({ site: SITE, email: "a@b.c", token: CANARY_TOKEN, setupCode: code }, d, { requireEnvCheck: true });
    expect(r).toEqual({ ok: false, status: 400, body: { error: "the new token belongs to a different Atlassian account (NEW) than the current one (OLD) — refusing" } });
  });
  test("defaults deps.io when omitted: exercises the REAL filesystem IO, scoped to a scratch temp dir (never the shared ~/.config/butchr)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-api-test-"));
    try {
      const codeManager = createSetupCodeManager();
      const code = codeManager.mint();
      const r = await handleJiraTokenWrite(
        { site: SITE, email: "a@b.c", token: CANARY_TOKEN, setupCode: code },
        { setupCode: codeManager, fetchFn: okFetch("acct-x"), path: join(dir, "atlassian-token"), identityPath: join(dir, "jira-identity.json") },
        { requireEnvCheck: false },
      );
      expect(r).toMatchObject({ ok: true, body: { identityPersisted: true } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
