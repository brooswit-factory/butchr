import { describe, expect, test } from "bun:test";
import { testJiraConnection } from "../../src/web/jira-connection-test.js";

const creds = { site: "https://example.atlassian.net", email: "a@b.com", token: "shh-secret-token" };

describe("testJiraConnection", () => {
  test("2xx with a JSON body carrying accountId: ok true, httpStatusClass 2xx, no error", async () => {
    const result = await testJiraConnection(creds, async () => new Response(JSON.stringify({ accountId: "abc-123" }), { status: 200 }));
    expect(result).toEqual({ ok: true, site: creds.site, httpStatusClass: "2xx" });
  });

  test("FACTORY-694 item 3: 2xx with an empty/no-accountId body (e.g. a proxy's 200) is NOT connected", async () => {
    const result = await testJiraConnection(creds, async () => new Response("{}", { status: 200 }));
    expect(result.ok).toBe(false);
    expect(result.httpStatusClass).toBe("2xx");
    expect(result.error).toBeDefined();
  });

  test("FACTORY-694 item 3: 2xx with a non-JSON (HTML) body is NOT connected, and never echoes the body", async () => {
    const result = await testJiraConnection(creds, async () => new Response("<html>captive portal</html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("captive portal");
  });

  test("FACTORY-694 item 3: 2xx with accountId present but not a string is NOT connected", async () => {
    const result = await testJiraConnection(creds, async () => new Response(JSON.stringify({ accountId: 12345 }), { status: 200 }));
    expect(result.ok).toBe(false);
  });

  test("FACTORY-694 item 3: the fixed error for a bodyless 2xx never echoes any upstream content", async () => {
    const canary = "canary-upstream-body-should-never-leak";
    const result = await testJiraConnection(creds, async () => new Response(JSON.stringify({ somethingElse: canary }), { status: 200 }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  test("401: ok false, httpStatusClass 401/403, fixed error string, never the upstream body", async () => {
    const result = await testJiraConnection(creds, async () => new Response(JSON.stringify({ errorMessages: ["upstream secret leak"] }), { status: 401 }));
    expect(result.ok).toBe(false);
    expect(result.httpStatusClass).toBe("401/403");
    expect(result.error).not.toContain("upstream secret leak");
  });

  test("403: httpStatusClass 401/403", async () => {
    const result = await testJiraConnection(creds, async () => new Response("", { status: 403 }));
    expect(result.httpStatusClass).toBe("401/403");
  });

  test("other status (500): httpStatusClass other", async () => {
    const result = await testJiraConnection(creds, async () => new Response("", { status: 500 }));
    expect(result.httpStatusClass).toBe("other");
  });

  test("network failure (thrown): httpStatusClass network", async () => {
    const result = await testJiraConnection(creds, async () => { throw new Error("ECONNREFUSED"); });
    expect(result.ok).toBe(false);
    expect(result.httpStatusClass).toBe("network");
  });

  test("never includes the token or an Authorization header anywhere in the result", async () => {
    const result = await testJiraConnection(creds, async () => new Response("{}", { status: 200 }));
    expect(JSON.stringify(result)).not.toContain(creds.token);
    expect(JSON.stringify(result).toLowerCase()).not.toContain("authorization");
    expect(JSON.stringify(result).toLowerCase()).not.toContain("basic ");
  });

  test("sends Basic auth with email:token, GET, and redirect: manual (never follows a redirect to another host)", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    await testJiraConnection(creds, async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response("{}", { status: 200 });
    });
    expect(capturedUrl).toBe(`${creds.site}/rest/api/3/myself`);
    expect(capturedInit?.method).toBe("GET");
    expect(capturedInit?.redirect).toBe("manual");
    const headers = capturedInit?.headers as Record<string, string>;
    const expectedBasic = `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString("base64")}`;
    expect(headers.authorization).toBe(expectedBasic);
  });

  test("a 3xx redirect is reported as httpStatusClass other, never followed", async () => {
    const result = await testJiraConnection(creds, async () => new Response("", { status: 302, headers: { location: "https://evil.example" } }));
    expect(result.httpStatusClass).toBe("other");
  });
});
