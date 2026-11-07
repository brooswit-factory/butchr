/**
 * local/ui — `PUT /api/settings/github/token` and `POST
 * /api/settings/github/test` (guards, budgets, audit lines that never carry
 * a token or code), plus `handleGithubTokenWrite`'s ordering and
 * `testGithubConnection`'s fixed-string results.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";
import { handleGithubTokenWrite, type GithubTokenWriteRequestOutcome } from "../../src/web/credentials-api.js";
import { githubTestInputs, testGithubConnection } from "../../src/web/github-connection-test.js";
import { resolveCredentialTarget } from "../../src/setup/secret-target.js";
import type { FetchLike } from "../../src/setup/jira-token-write.js";

const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;
const CANARY = "ghp_canaryTOKEN0123456789";
const CODE = "ABCDEFGHJKMNP";

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

const OK: GithubTokenWriteRequestOutcome = { ok: true, status: 200, body: { ok: true, login: "octocat", rotated: false, restartNeeded: true } };

describe("PUT /api/settings/github/token", () => {
  test("no write guard: 503; never calls githubTokenWrite", async () => {
    let called = false;
    const app = liveView(fakeMcp, baseDeps({ githubTokenWrite: async () => { called = true; return OK; } }));
    const res = await app.handle(new Request("http://local/api/settings/github/token", { method: "PUT", headers: { origin: "http://x", host: "x", "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(503);
    expect(called).toBe(false);
  });

  test("missing CSRF: 403 (the app-wide guard answers first), and nothing audited carries the token or code", async () => {
    const audited: Array<{ outcome: string; diffSummary: string; ids: string[] }> = [];
    let called = false;
    const deps = writeDeps({ githubTokenWrite: async () => { called = true; return OK; }, auditWrite: (e) => { audited.push(e); } });
    await withApp(deps, async (port, headers) => {
      const { "x-butchr-csrf": _csrf, ...noCsrf } = headers;
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/github/token`, { method: "PUT", headers: noCsrf, body: JSON.stringify({ token: CANARY }) });
      expect(res.status).toBe(403);
    });
    expect(called).toBe(false);
    expect(audited.every((a) => a.outcome === "rejected")).toBe(true);
    expect(JSON.stringify(audited)).not.toContain(CANARY);
    expect(JSON.stringify(audited)).not.toContain(CODE);
  });

  test("happy path: passes exactly { token } and a rate gate, returns the body, audits with no secret", async () => {
    let received: unknown;
    let gate: unknown;
    const audited: Array<{ outcome: string; diffSummary: string; ids: string[] }> = [];
    const deps = writeDeps({ githubTokenWrite: async (input, rateGate) => { received = input; gate = rateGate; return OK; }, auditWrite: (e) => { audited.push(e); } });
    await withApp(deps, async (port, headers) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/github/token`, { method: "PUT", headers, body: JSON.stringify({ token: CANARY }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(OK.body);
    });
    expect(received).toEqual({ token: CANARY });
    expect(typeof gate).toBe("function");
    expect(audited.map((a) => [a.outcome, a.diffSummary])).toEqual([["accepted", "set github token"]]);
    expect(JSON.stringify(audited)).not.toContain(CANARY);
    expect(JSON.stringify(audited)).not.toContain(CODE);
  });

  test("a malformed body is 400; a 429 carries retry-after", async () => {
    const deps = writeDeps({ githubTokenWrite: async () => ({ ok: false, status: 429, body: { error: "rate limited" }, retryAfterSeconds: 42 }) });
    await withApp(deps, async (port, headers) => {
      const bad = await fetch(`http://127.0.0.1:${port}/api/settings/github/token`, { method: "PUT", headers, body: JSON.stringify({ token: 7 }) });
      expect(bad.status).toBe(400);
      const limited = await fetch(`http://127.0.0.1:${port}/api/settings/github/token`, { method: "PUT", headers, body: JSON.stringify({ token: CANARY }) });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("42");
    });
  });
});

describe("POST /api/settings/github/test", () => {
  test("returns the test result; its own budget answers 429; audits as a test", async () => {
    const audited: Array<{ outcome: string; diffSummary: string; kind?: string }> = [];
    let allow = true;
    const deps = writeDeps({
      githubTest: async () => ({ ok: true, login: "octocat", httpStatusClass: "2xx", orgs: [{ org: "acme", ok: true, httpStatusClass: "2xx" }] }),
      githubTestRateLimit: () => (allow ? { ok: true } : { ok: false, retryAfterSeconds: 5 }) as never,
      auditWrite: (e) => { audited.push(e as never); },
    });
    await withApp(deps, async (port, headers) => {
      const ok = await fetch(`http://127.0.0.1:${port}/api/settings/github/test`, { method: "POST", headers, body: "{}" });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, login: "octocat" });
      allow = false;
      const limited = await fetch(`http://127.0.0.1:${port}/api/settings/github/test`, { method: "POST", headers, body: "{}" });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("5");
    });
    expect(audited.map((a) => a.outcome)).toEqual(["accepted", "rejected"]);
  });
});

describe("handleGithubTokenWrite", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "butchr-gh-write-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const okGithub: FetchLike = async () => new Response(JSON.stringify({ login: "octocat" }), { status: 200 });

  test("a read-only target answers 400", async () => {
    const target = resolveCredentialTarget("github", { GITHUB_TOKEN_FILE: "relative-token" });
    const r = await handleGithubTokenWrite({ token: CANARY }, { target, fetchFn: okGithub });
    expect(r).toMatchObject({ ok: false, status: 400, body: { error: expect.stringContaining("absolute") } });
  });

  test("writes the managed secrets file; a multi-line token is refused", async () => {
    const target = resolveCredentialTarget("github", { BUTCHR_SECRETS_DIR: join(dir, "secrets") });
    const bad = await handleGithubTokenWrite({ token: "two\nlines" }, { target, fetchFn: okGithub });
    expect(bad).toMatchObject({ ok: false, status: 400 });
    const r = await handleGithubTokenWrite({ token: ` ${CANARY} ` }, { target, fetchFn: okGithub });
    expect(r).toEqual({ ok: true, status: 200, body: { ok: true, login: "octocat", rotated: false, restartNeeded: true } });
    expect(readFileSync(join(dir, "secrets", "github-token"), "utf8")).toBe(CANARY);
    expect(JSON.stringify([bad, r])).not.toContain(CANARY);
  });
});

describe("testGithubConnection", () => {
  test("no token: a fixed explanation, no network call", async () => {
    let called = false;
    expect(await testGithubConnection(undefined, ["acme"], async () => { called = true; return new Response("{}"); })).toEqual({ ok: false, httpStatusClass: "other", error: "No GitHub token is set.", orgs: [] });
    expect(called).toBe(false);
  });

  test("githubTestInputs reads what the next start would: the named token file now (~/ expanded) and the org list", () => {
    const reads: string[] = [];
    const readFile = (p: string) => { reads.push(p); return "ghp_x\n"; };
    expect(githubTestInputs({ HOME: "/h", GITHUB_TOKEN_FILE: "~/gh", BUTCHR_GITHUB_ORGS: " example-org , another-org " }, readFile)).toEqual({ token: "ghp_x", orgs: ["example-org", "another-org"] });
    expect(reads).toEqual(["/h/gh"]);
    expect(githubTestInputs({ BUTCHR_GITHUB_ORGS: "acme" }, readFile)).toEqual({ token: undefined, orgs: ["acme"] });
    expect(githubTestInputs({ GITHUB_TOKEN_FILE: "/missing" }, () => { throw new Error("ENOENT"); })).toEqual({ token: undefined, orgs: [] });
    expect(githubTestInputs({ GITHUB_TOKEN_FILE: "/empty" }, () => " \n")).toEqual({ token: undefined, orgs: [] });
  });

  test("checks /user then each org, naming orgs the token can't see, and never echoes the token", async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
      if (url.endsWith("/orgs/acme")) return new Response("{}", { status: 200 });
      return new Response("{}", { status: 404 });
    };
    const r = await testGithubConnection(CANARY, ["acme", "secret-org"], fetchFn);
    expect(r).toEqual({ ok: false, login: "octocat", httpStatusClass: "2xx", error: "This token can't see secret-org.", orgs: [{ org: "acme", ok: true, httpStatusClass: "2xx" }, { org: "secret-org", ok: false, httpStatusClass: "other" }] });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  test("a rejected token or a network failure gives fixed strings", async () => {
    expect(await testGithubConnection(CANARY, [], async () => new Response("nope", { status: 401 }))).toEqual({ ok: false, httpStatusClass: "401/403", error: "GitHub rejected this token (401/403).", orgs: [] });
    expect(await testGithubConnection(CANARY, [], async () => { throw new Error(`down ${CANARY}`); })).toEqual({ ok: false, httpStatusClass: "network", error: "could not reach GitHub (network error or timeout).", orgs: [] });
  });
});
