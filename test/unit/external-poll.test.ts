import { describe, expect, test } from "bun:test";
import {
  defaultIsBlockedHost, pollConfluencePage, pollGithubLink, pollWebpage,
  type ConfluencePollDeps, type GithubConditionalDeps, type WebpagePollDeps,
} from "../../src/jira-watch/external-poll.js";

describe("BUTCHR-437: pollConfluencePage", () => {
  const CONF_URL = "https://wroosbit.atlassian.net/wiki/spaces/BUTCHR/pages/12484678/Some+Page";

  test("a version bump is a genuine change; an unparseable URL is unreadable with no HTTP call", async () => {
    let calls = 0;
    const deps: ConfluencePollDeps = { getVersion: async () => { calls++; return { ok: true, version: 3 }; } };
    expect(await pollConfluencePage(CONF_URL, deps)).toEqual({ status: "ok", fingerprint: "3" });
    expect(calls).toBe(1);

    const notAPage = "https://wroosbit.atlassian.net/wiki/spaces/BUTCHR/overview";
    expect(await pollConfluencePage(notAPage, deps)).toEqual({ status: "unreadable" });
    expect(calls).toBe(1); // no HTTP call for an unresolvable page id
  });

  test("404/403 is unreadable with the HTTP status; any other failure is transient (error)", async () => {
    const notFound: ConfluencePollDeps = { getVersion: async () => ({ ok: false, transient: false, httpStatus: 404 }) };
    expect(await pollConfluencePage(CONF_URL, notFound)).toEqual({ status: "unreadable", httpStatus: 404 });

    const forbidden: ConfluencePollDeps = { getVersion: async () => ({ ok: false, transient: false, httpStatus: 403 }) };
    expect(await pollConfluencePage(CONF_URL, forbidden)).toEqual({ status: "unreadable", httpStatus: 403 });

    const down: ConfluencePollDeps = { getVersion: async () => ({ ok: false, transient: true }) };
    expect(await pollConfluencePage(CONF_URL, down)).toEqual({ status: "error" });
  });
});

describe("BUTCHR-437: pollGithubLink", () => {
  const REF = "acme/widgets#12";

  test("an unauthenticated first fetch (no prior etag) resolves ok with the response's ETag; a matching If-None-Match yields 304 not-modified with zero rate-limit-costing body read needed", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const inm = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
      if (inm === '"v2"') return new Response(null, { status: 304 });
      return new Response(JSON.stringify({ number: 12 }), { status: 200, headers: { etag: '"v2"' } });
    };
    const deps: GithubConditionalDeps = { fetchImpl, token: "tok" };

    const first = await pollGithubLink({ kind: "github-issue", target: REF }, null, deps);
    expect(first).toEqual({ status: "ok", fingerprint: '"v2"' });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/issues/12");
    expect(calls[0]!.headers["if-none-match"]).toBeUndefined();
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");

    const second = await pollGithubLink({ kind: "github-issue", target: REF }, '"v2"', deps);
    expect(second).toEqual({ status: "not-modified" });
    expect(calls[1]!.headers["if-none-match"]).toBe('"v2"');
  });

  test("a PR uses the /pulls path; 404/403 is unreadable with status; a 5xx is transient (error); a network throw is transient too", async () => {
    const notFound: GithubConditionalDeps = { fetchImpl: async (url) => { expect(url).toContain("/pulls/7"); return new Response(null, { status: 404 }); } };
    expect(await pollGithubLink({ kind: "github-pr", target: "acme/widgets#7" }, null, notFound)).toEqual({ status: "unreadable", httpStatus: 404 });

    const forbidden: GithubConditionalDeps = { fetchImpl: async () => new Response(null, { status: 403 }) };
    expect(await pollGithubLink({ kind: "github-issue", target: REF }, null, forbidden)).toEqual({ status: "unreadable", httpStatus: 403 });

    const serverError: GithubConditionalDeps = { fetchImpl: async () => new Response(null, { status: 502 }) };
    expect(await pollGithubLink({ kind: "github-issue", target: REF }, null, serverError)).toEqual({ status: "error" });

    const networkDown: GithubConditionalDeps = { fetchImpl: async () => { throw new Error("ECONNRESET"); } };
    expect(await pollGithubLink({ kind: "github-issue", target: REF }, null, networkDown)).toEqual({ status: "error" });
  });

  test("a target this module cannot parse as owner/repo#n is unreadable, with no fetch attempted", async () => {
    let called = false;
    const deps: GithubConditionalDeps = { fetchImpl: async () => { called = true; return new Response(null, { status: 200 }); } };
    expect(await pollGithubLink({ kind: "github-issue", target: "not-a-ref" }, null, deps)).toEqual({ status: "unreadable" });
    expect(called).toBe(false);
  });
});

describe("BUTCHR-437: pollWebpage", () => {
  const URL = "https://example.com/page";
  const allowAll: WebpagePollDeps["isBlockedHost"] = async () => false;

  test("an ETag response is preferred as the fingerprint; a matching If-None-Match yields not-modified", async () => {
    const fetchImpl = async (u: string, init?: RequestInit): Promise<Response> => {
      const inm = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
      if (inm === '"abc"') return new Response(null, { status: 304 });
      return new Response("<html>hi</html>", { status: 200, headers: { etag: '"abc"' } });
    };
    const deps: WebpagePollDeps = { fetchImpl, isBlockedHost: allowAll };
    const first = await pollWebpage({ target: URL }, undefined, deps);
    expect(first).toEqual({ status: "ok", fingerprint: "etag:\"abc\"" });
    const second = await pollWebpage({ target: URL }, "etag:\"abc\"", deps);
    expect(second).toEqual({ status: "not-modified" });
  });

  test("Last-Modified is used when there is no ETag; a body hash is the last resort, and it changes when the body does", async () => {
    const lmFetch: WebpagePollDeps = { fetchImpl: async () => new Response("body", { status: 200, headers: { "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT" } }), isBlockedHost: allowAll };
    expect(await pollWebpage({ target: URL }, undefined, lmFetch)).toEqual({ status: "ok", fingerprint: "lm:Wed, 01 Jan 2026 00:00:00 GMT" });

    let body = "version one";
    const hashFetch: WebpagePollDeps = { fetchImpl: async () => new Response(body, { status: 200 }), isBlockedHost: allowAll };
    const h1 = await pollWebpage({ target: URL }, undefined, hashFetch);
    expect(h1.status).toBe("ok");
    const fp1 = (h1 as { fingerprint: string }).fingerprint;
    expect(fp1.startsWith("hash:")).toBe(true);
    const unchanged = await pollWebpage({ target: URL }, fp1, hashFetch);
    expect(unchanged).toEqual({ status: "ok", fingerprint: fp1 }); // no validators at all — caller compares fingerprints itself

    body = "version two";
    const h2 = await pollWebpage({ target: URL }, fp1, hashFetch);
    expect(h2.status).toBe("ok");
    expect((h2 as { fingerprint: string }).fingerprint).not.toBe(fp1);
  });

  test("only http/https is ever fetched; a non-http(s) target is unreadable with no fetch attempted", async () => {
    let called = false;
    const deps: WebpagePollDeps = { fetchImpl: async () => { called = true; return new Response("x"); }, isBlockedHost: allowAll };
    expect(await pollWebpage({ target: "ftp://example.com/x" }, undefined, deps)).toEqual({ status: "unreadable" });
    expect(await pollWebpage({ target: "not a url" }, undefined, deps)).toEqual({ status: "unreadable" });
    expect(called).toBe(false);
  });

  test("404/403 is unreadable with status; a 5xx and a network throw are both transient (error)", async () => {
    expect(await pollWebpage({ target: URL }, undefined, { fetchImpl: async () => new Response(null, { status: 404 }), isBlockedHost: allowAll })).toEqual({ status: "unreadable", httpStatus: 404 });
    expect(await pollWebpage({ target: URL }, undefined, { fetchImpl: async () => new Response(null, { status: 403 }), isBlockedHost: allowAll })).toEqual({ status: "unreadable", httpStatus: 403 });
    expect(await pollWebpage({ target: URL }, undefined, { fetchImpl: async () => new Response(null, { status: 500 }), isBlockedHost: allowAll })).toEqual({ status: "error" });
    expect(await pollWebpage({ target: URL }, undefined, { fetchImpl: async () => { throw new Error("boom"); }, isBlockedHost: allowAll })).toEqual({ status: "error" });
  });

  test("a redirect to an http(s) URL is followed; a redirect to a non-http(s) scheme is refused, not followed", async () => {
    const toHttps: WebpagePollDeps = {
      isBlockedHost: allowAll,
      fetchImpl: async (u) => {
        if (u === URL) return new Response(null, { status: 302, headers: { location: "https://example.com/final" } });
        expect(u).toBe("https://example.com/final");
        return new Response("final", { status: 200, headers: { etag: '"f"' } });
      },
    };
    expect(await pollWebpage({ target: URL }, undefined, toHttps)).toEqual({ status: "ok", fingerprint: 'etag:"f"' });

    const toFile: WebpagePollDeps = { isBlockedHost: allowAll, fetchImpl: async () => new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }) };
    expect(await pollWebpage({ target: URL }, undefined, toFile)).toEqual({ status: "unreadable" });

    let hops = 0;
    const loop: WebpagePollDeps = { isBlockedHost: allowAll, fetchImpl: async () => { hops++; return new Response(null, { status: 302, headers: { location: `${URL}?hop=${hops}` } }); } };
    expect(await pollWebpage({ target: URL }, undefined, loop)).toEqual({ status: "unreadable" });
    expect(hops).toBeLessThan(20); // bounded — never an infinite redirect chain
  });

  test("a response over the size cap is treated as transient (error), never hashed or reported unreadable", async () => {
    const huge = "x".repeat(2_000_000);
    const byBody: WebpagePollDeps = { isBlockedHost: allowAll, fetchImpl: async () => new Response(huge, { status: 200 }) };
    expect(await pollWebpage({ target: URL }, undefined, byBody)).toEqual({ status: "error" });

    const byHeader: WebpagePollDeps = { isBlockedHost: allowAll, fetchImpl: async () => new Response("small", { status: 200, headers: { "content-length": "5000000" } }) };
    expect(await pollWebpage({ target: URL }, undefined, byHeader)).toEqual({ status: "error" });
  });

  test("a blocked (private/loopback) host is refused with no fetch attempted — the SSRF guard runs before every fetch, including after a redirect", async () => {
    let called = false;
    const blockAll: WebpagePollDeps = { isBlockedHost: async () => true, fetchImpl: async () => { called = true; return new Response("x"); } };
    expect(await pollWebpage({ target: URL }, undefined, blockAll)).toEqual({ status: "unreadable" });
    expect(called).toBe(false);

    const blockOnRedirectTarget: WebpagePollDeps = {
      isBlockedHost: async (host) => host === "internal.local",
      fetchImpl: async (u) => (u === URL ? new Response(null, { status: 302, headers: { location: "https://internal.local/secret" } }) : new Response("nope")),
    };
    expect(await pollWebpage({ target: URL }, undefined, blockOnRedirectTarget)).toEqual({ status: "unreadable" });
  });

  test("no credentials are ever attached to a webpage fetch", async () => {
    let sawAuthHeader = false;
    const deps: WebpagePollDeps = {
      isBlockedHost: allowAll,
      fetchImpl: async (u, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if ("authorization" in headers) sawAuthHeader = true;
        return new Response("x", { status: 200, headers: { etag: '"e"' } });
      },
    };
    await pollWebpage({ target: URL }, undefined, deps);
    expect(sawAuthHeader).toBe(false);
  });
});

describe("BUTCHR-437: defaultIsBlockedHost (real DNS-based SSRF guard, IP literals only exercised here to avoid a real DNS lookup in a unit test)", () => {
  test("loopback/private/link-local IP literals and localhost are blocked; an ordinary public-shaped IP literal is not", async () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "172.16.0.5", "192.168.1.1", "169.254.169.254", "0.0.0.1", "localhost", "foo.localhost", "::1"]) {
      expect(await defaultIsBlockedHost(host)).toBe(true);
    }
    expect(await defaultIsBlockedHost("93.184.216.34")).toBe(false); // example.com's own A record — a public-shaped literal
  });
});
