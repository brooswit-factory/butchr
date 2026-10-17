/**
 * local/ui — the Zendesk and Trello credential routes and handlers: order of
 * checks (a missing or bad subdomain never burns the setup code or reaches
 * the network), the writes themselves, the connection tests, audit lines
 * that never carry a secret, and the credentials summary.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";
import { buildCredentialsSummary, handleTrelloCredentialsWrite, handleZendeskTokenWrite, testTrelloConnection, testZendeskConnection, type ProviderSecretWriteRequestOutcome } from "../../src/web/credentials-api.js";
import { resolveCredentialTarget } from "../../src/setup/secret-target.js";
import type { SetupCodeManager } from "../../src/setup/setup-code.js";
import type { FetchLike } from "../../src/setup/jira-token-write.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-provider-routes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ZD_CANARY = "zd-canary-TOKEN-0123";
const TR_KEY = "trello-canary-KEY";
const TR_TOKEN = "trello-canary-TOKEN";
const CODE = "ABCDEFGHJKMNP";

/** A setup-code manager that accepts `CODE` and counts how often it's asked. */
function codeManager(): SetupCodeManager & { checks: number } {
  const m = {
    checks: 0,
    mint: () => CODE,
    check(code: string) {
      m.checks++;
      return code === CODE ? ({ ok: true } as const) : ({ ok: false, reason: "wrong code" } as const);
    },
  };
  return m as unknown as SetupCodeManager & { checks: number };
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function countingFetch(respond: (url: string) => Response): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fn = (async (url: string) => { urls.push(url); return respond(url); }) as unknown as FetchLike & { urls: string[] };
  fn.urls = urls;
  return fn;
}

describe("handleZendeskTokenWrite", () => {
  test("no subdomain yet: refused before the setup code is checked or anything is fetched", async () => {
    const setupCode = codeManager();
    const fetchFn = countingFetch(() => json(200, {}));
    const out = await handleZendeskTokenWrite({ token: ZD_CANARY, setupCode: CODE }, { setupCode, targets: [resolveCredentialTarget("zendesk", { BUTCHR_SECRETS_DIR: dir })], subdomain: null, fetchFn });
    expect(out).toMatchObject({ ok: false, status: 400, body: { error: expect.stringContaining("subdomain first") } });
    expect([setupCode.checks, fetchFn.urls.length]).toEqual([0, 0]);
  });

  test("a subdomain that isn't one is refused the same way: it would become the request's host", async () => {
    const setupCode = codeManager();
    const fetchFn = countingFetch(() => json(200, {}));
    const out = await handleZendeskTokenWrite({ token: ZD_CANARY, setupCode: CODE }, { setupCode, targets: [resolveCredentialTarget("zendesk", { BUTCHR_SECRETS_DIR: dir })], subdomain: "evil.example/x?", fetchFn });
    expect(out.ok).toBe(false);
    expect([setupCode.checks, fetchFn.urls.length]).toEqual([0, 0]);
  });

  test("happy path: tests against <subdomain>.zendesk.com, writes the managed file 0600, names the account", async () => {
    const fetchFn = countingFetch(() => json(200, { user: { id: 7, email: "agent@acme.example" } }));
    const out = await handleZendeskTokenWrite({ token: ` ${ZD_CANARY} `, setupCode: CODE }, { setupCode: codeManager(), targets: [resolveCredentialTarget("zendesk", { BUTCHR_SECRETS_DIR: dir })], subdomain: "acme", fetchFn });
    expect(out).toEqual({ ok: true, status: 200, body: { ok: true, account: "agent@acme.example", rotated: false, restartNeeded: true } });
    expect(fetchFn.urls).toEqual(["https://acme.zendesk.com/api/v2/users/me.json"]);
    expect(readFileSync(join(dir, "zendesk-oauth-token"), "utf8")).toBe(ZD_CANARY);
  });

  test("a wrong setup code writes nothing", async () => {
    const out = await handleZendeskTokenWrite({ token: ZD_CANARY, setupCode: "WRONG" }, { setupCode: codeManager(), targets: [resolveCredentialTarget("zendesk", { BUTCHR_SECRETS_DIR: dir })], subdomain: "acme", fetchFn: countingFetch(() => json(200, { user: { id: 7 } })) });
    expect(out).toMatchObject({ ok: false, status: 400, body: { error: "setup code: wrong code" } });
  });
});

describe("handleTrelloCredentialsWrite", () => {
  test("tests the key and token as a pair and writes both", async () => {
    const env = { BUTCHR_SECRETS_DIR: dir };
    const fetchFn = countingFetch(() => json(200, { id: "m1", username: "butchr-bot" }));
    const out = await handleTrelloCredentialsWrite({ apiKey: TR_KEY, token: TR_TOKEN, setupCode: CODE }, { setupCode: codeManager(), targets: [resolveCredentialTarget("trello-key", env), resolveCredentialTarget("trello-token", env)], fetchFn });
    expect(out).toEqual({ ok: true, status: 200, body: { ok: true, account: "butchr-bot", rotated: false, restartNeeded: true } });
    expect([readFileSync(join(dir, "trello-api-key"), "utf8"), readFileSync(join(dir, "trello-token"), "utf8")]).toEqual([TR_KEY, TR_TOKEN]);
  });

  test("both fields are required", async () => {
    const env = { BUTCHR_SECRETS_DIR: dir };
    const out = await handleTrelloCredentialsWrite({ apiKey: TR_KEY, token: " ", setupCode: CODE }, { setupCode: codeManager(), targets: [resolveCredentialTarget("trello-key", env), resolveCredentialTarget("trello-token", env)], fetchFn: countingFetch(() => json(200, {})) });
    expect(out).toMatchObject({ ok: false, status: 400, body: { error: "every field is required" } });
  });
});

describe("connection tests use the running butchr's own files", () => {
  test("Zendesk: the env's subdomain and token file", async () => {
    const tokenFile = join(dir, "zd");
    writeFileSync(tokenFile, ZD_CANARY);
    chmodSync(tokenFile, 0o600);
    const fetchFn = countingFetch(() => json(200, { user: { id: 7, email: "agent@acme.example" } }));
    expect(await testZendeskConnection({ ZENDESK_SUBDOMAIN: "acme", ZENDESK_OAUTH_TOKEN_FILE: tokenFile }, fetchFn)).toEqual({ ok: true, account: "agent@acme.example" });
    expect(await testZendeskConnection({}, fetchFn)).toEqual({ ok: false, error: "set ZENDESK_SUBDOMAIN and ZENDESK_OAUTH_TOKEN_FILE" });
  });

  test("Trello: the member, then the board", async () => {
    const keyFile = join(dir, "k");
    const tokenFile = join(dir, "t");
    for (const [path, value] of [[keyFile, TR_KEY], [tokenFile, TR_TOKEN]] as const) { writeFileSync(path, value); chmodSync(path, 0o600); }
    const env = { TRELLO_BOARD_ID: "0123456789abcdef01234567", TRELLO_API_KEY_FILE: keyFile, TRELLO_TOKEN_FILE: tokenFile };
    const ok = countingFetch((url) => (url.includes("/members/me") ? json(200, { id: "m1", username: "butchr-bot" }) : json(200, { name: "Support" })));
    expect(await testTrelloConnection(env, ok)).toEqual({ ok: true, account: "butchr-bot", board: "Support" });
    const noBoard = countingFetch((url) => (url.includes("/members/me") ? json(200, { id: "m1", username: "butchr-bot" }) : new Response("", { status: 404 })));
    expect(await testTrelloConnection(env, noBoard)).toEqual({ ok: false, error: "these credentials (butchr-bot) can't see board 0123456789abcdef01234567" });
  });
});

const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;

function baseDeps(overrides: Partial<ViewDeps> = {}): ViewDeps {
  const unused = () => { throw new Error("unused in this test"); };
  return { state: unused, open: unused, openPane: unused, health: unused, dashboard: unused, header: unused, resourceLink: unused, configInventory: unused, ...overrides } as ViewDeps;
}

function writeDeps(overrides: Partial<ViewDeps> = {}) {
  const csrf = createCsrfTokenIssuer();
  const guard = { port: 0 };
  const peerUidCheck = () => true;
  return { csrf, writeGuard: { dashboardOriginGuard: guard, peerUidCheck, csrf }, dashboardOriginGuard: guard, peerUidCheck, ...overrides };
}

async function withApp(deps: ReturnType<typeof writeDeps>, fn: (port: number, headers: Record<string, string>) => Promise<void>) {
  const app = liveView(fakeMcp, baseDeps(deps));
  app.listen(0);
  const port = app.server!.port!;
  deps.dashboardOriginGuard.port = port;
  try {
    const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } });
    const token = ((await session.json()) as { csrfToken: string }).csrfToken;
    await fn(port, { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": token });
  } finally {
    await app.stop(true);
  }
}

const WRITE_OK: ProviderSecretWriteRequestOutcome = { ok: true, status: 200, body: { ok: true, account: "someone", rotated: false, restartNeeded: true } };

describe("the routes", () => {
  test("PUT /api/settings/zendesk/token and /trello/credentials pass the body through and audit no secret", async () => {
    const audited: unknown[] = [];
    let zendesk: unknown;
    let trello: unknown;
    const deps = writeDeps({
      zendeskTokenWrite: async (input) => { zendesk = input; return WRITE_OK; },
      trelloCredentialsWrite: async (input) => { trello = input; return WRITE_OK; },
      auditWrite: (e) => { audited.push(e); },
    });
    await withApp(deps, async (port, headers) => {
      const z = await fetch(`http://127.0.0.1:${port}/api/settings/zendesk/token`, { method: "PUT", headers, body: JSON.stringify({ token: ZD_CANARY, setupCode: CODE }) });
      expect(z.status).toBe(200);
      const t = await fetch(`http://127.0.0.1:${port}/api/settings/trello/credentials`, { method: "PUT", headers, body: JSON.stringify({ apiKey: TR_KEY, token: TR_TOKEN, setupCode: CODE }) });
      expect(t.status).toBe(200);
      const bad = await fetch(`http://127.0.0.1:${port}/api/settings/trello/credentials`, { method: "PUT", headers, body: JSON.stringify({ token: TR_TOKEN, setupCode: CODE }) });
      expect(bad.status).toBe(400);
    });
    expect(zendesk).toEqual({ token: ZD_CANARY, setupCode: CODE });
    expect(trello).toEqual({ apiKey: TR_KEY, token: TR_TOKEN, setupCode: CODE });
    const text = JSON.stringify(audited);
    for (const secret of [ZD_CANARY, TR_KEY, TR_TOKEN, CODE]) expect(text).not.toContain(secret);
  });

  test("POST /api/settings/{zendesk,trello}/test run their own test; any other provider is a 404", async () => {
    const ran: string[] = [];
    const deps = writeDeps({
      zendeskTest: async () => { ran.push("zendesk"); return { ok: true, account: "agent@acme.example" }; },
      trelloTest: async () => { ran.push("trello"); return { ok: false, error: "set TRELLO_BOARD_ID" }; },
    });
    await withApp(deps, async (port, headers) => {
      const z = await fetch(`http://127.0.0.1:${port}/api/settings/zendesk/test`, { method: "POST", headers, body: "{}" });
      expect(await z.json()).toEqual({ ok: true, account: "agent@acme.example" });
      const t = await fetch(`http://127.0.0.1:${port}/api/settings/trello/test`, { method: "POST", headers, body: "{}" });
      expect(await t.json()).toEqual({ ok: false, error: "set TRELLO_BOARD_ID" });
      const other = await fetch(`http://127.0.0.1:${port}/api/settings/slack/test`, { method: "POST", headers, body: "{}" });
      expect(other.status).toBe(404);
    });
    expect(ran).toEqual(["zendesk", "trello"]);
  });

  test("without a write guard the new routes are disabled (503)", async () => {
    const app = liveView(fakeMcp, baseDeps({ zendeskTokenWrite: async () => WRITE_OK, zendeskTest: async () => ({ ok: true, account: "x" }) }));
    const put = await app.handle(new Request("http://local/api/settings/zendesk/token", { method: "PUT", headers: { origin: "http://x", host: "x", "content-type": "application/json" }, body: "{}" }));
    const post = await app.handle(new Request("http://local/api/settings/zendesk/test", { method: "POST", headers: { origin: "http://x", host: "x", "content-type": "application/json" }, body: "{}" }));
    expect([put.status, post.status]).toEqual([503, 503]);
  });
});

describe("the credentials summary", () => {
  test("carries Zendesk and Trello with each value's source and the env-only risk flag, and no secret", async () => {
    const summary = await buildCredentialsSummary(
      {
        rawEnv: { BUTCHR_SECRETS_DIR: dir, TRELLO_BOARD_ID: "0123456789abcdef01234567", BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK: "agents-can-read-the-zendesk-token" },
        settingsFileValues: { ZENDESK_SUBDOMAIN: "acme" },
        atlassian: { site: null, email: null },
        githubActive: false,
        running: { githubOrgs: [], zendeskSubdomain: null, trelloBoardId: "0123456789abcdef01234567" },
        startedAt: "2026-10-16T00:00:00.000Z",
        supervisor: { kind: "none" },
        ownPid: 1,
      },
      async () => ({ exists: false, readable: false, mode: null }),
      () => false,
    );
    expect(summary.zendesk).toMatchObject({ subdomain: { value: "acme", source: "file", editable: true, running: null }, token: { source: "unset", fileEnvKey: "ZENDESK_OAUTH_TOKEN_FILE" }, riskAccepted: true });
    expect(summary.trello).toMatchObject({ boardId: { value: "0123456789abcdef01234567", source: "environment", editable: false, running: "0123456789abcdef01234567" }, apiKey: { fileEnvKey: "TRELLO_API_KEY_FILE" }, token: { fileEnvKey: "TRELLO_TOKEN_FILE" } });
  });
});
