import { afterEach, describe, expect, test } from "bun:test";
import { realDaemonApi, createFixturesDaemonApi, defaultDaemonLogsFixture, DaemonLogsUnavailableError, DaemonReloadFailedError } from "../../dashboard-app/src/api/daemon.js";
import { RateLimitError } from "../../dashboard-app/src/api/settings.js";

describe("createFixturesDaemonApi", () => {
  test("fetchLogs returns the default fixture when none supplied", async () => {
    const api = createFixturesDaemonApi();
    expect(await api.fetchLogs()).toEqual(defaultDaemonLogsFixture());
  });

  test("fetchLogs one-shot nextLogsError is thrown then cleared", async () => {
    const err = new DaemonLogsUnavailableError("no systemd unit or scheduled task detected");
    const api = createFixturesDaemonApi({ nextLogsError: err });
    await expect(api.fetchLogs()).rejects.toBe(err);
    await expect(api.fetchLogs()).resolves.toBeDefined();
  });

  test("reload resolves with a no-change result by default", async () => {
    const api = createFixturesDaemonApi();
    const result = await api.reload();
    expect(result.ok).toBe(true);
    expect(result.added).toEqual([]);
  });

  test("reload one-shot nextReloadError is thrown then cleared", async () => {
    const err = new DaemonReloadFailedError("bad json", ["bad json"]);
    const api = createFixturesDaemonApi({ nextReloadError: err });
    await expect(api.reload()).rejects.toBe(err);
    await expect(api.reload()).resolves.toBeDefined();
  });
});

describe("realDaemonApi — FACTORY-668: wire behavior against a mocked fetch", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("fetchLogs: a plain GET, no CSRF token fetched at all", async () => {
    let sawSessionCall = false;
    let sawCsrfHeader = false;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session") { sawSessionCall = true; return new Response(JSON.stringify({ csrfToken: "tok" }), { status: 200, headers: { "content-type": "application/json" } }); }
      if ((init?.headers as Record<string, string> | undefined)?.["x-butchr-csrf"]) sawCsrfHeader = true;
      return new Response(JSON.stringify(defaultDaemonLogsFixture()), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const result = await realDaemonApi.fetchLogs();
    expect(result).toEqual(defaultDaemonLogsFixture());
    expect(sawSessionCall).toBe(false);
    expect(sawCsrfHeader).toBe(false);
  });

  test("fetchLogs: non-2xx throws DaemonLogsUnavailableError with the server's own message", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "no systemd unit or scheduled task detected for this daemon" }), { status: 503, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(realDaemonApi.fetchLogs()).rejects.toBeInstanceOf(DaemonLogsUnavailableError);
    await expect(realDaemonApi.fetchLogs()).rejects.toThrow(/no systemd unit or scheduled task detected/);
  });

  test("reload: fetches a CSRF token first, POSTs an empty-object body with the CSRF header", async () => {
    let sentBody: string | undefined;
    let sentCsrf: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "tok-123" }), { status: 200, headers: { "content-type": "application/json" } });
      sentBody = String(init?.body);
      sentCsrf = (init?.headers as Record<string, string>)["x-butchr-csrf"];
      return new Response(JSON.stringify({ ok: true, path: "/x/rules.json", added: [], removed: [], changed: [], problems: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const result = await realDaemonApi.reload();
    expect(JSON.parse(sentBody!)).toEqual({});
    expect(sentCsrf).toBe("tok-123");
    expect(result.ok).toBe(true);
  });

  test("reload: 429 throws RateLimitError with Retry-After", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "tok" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "17" } });
    }) as unknown as typeof fetch;
    await expect(realDaemonApi.reload()).rejects.toBeInstanceOf(RateLimitError);
  });

  test("reload: 409 (bad rules.json) throws DaemonReloadFailedError carrying problems", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "tok" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ error: "bad json", path: "/x/rules.json" }), { status: 409, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await expect(realDaemonApi.reload()).rejects.toBeInstanceOf(DaemonReloadFailedError);
  });
});
