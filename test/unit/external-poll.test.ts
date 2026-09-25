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

  describe("PR #401 review round 1: a rate-limited 403 is transient, not unreadable", () => {
    test("x-ratelimit-remaining: 0 => error (no notify, no unreadable line)", async () => {
      const deps: GithubConditionalDeps = { fetchImpl: async () => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } }) };
      expect(await pollGithubLink({ kind: "github-issue", target: REF }, null, deps)).toEqual({ status: "error" });
    });

    test("a retry-after header on a 403 => error too", async () => {
      const deps: GithubConditionalDeps = { fetchImpl: async () => new Response(null, { status: 403, headers: { "retry-after": "30" } }) };
      expect(await pollGithubLink({ kind: "github-issue", target: REF }, null, deps)).toEqual({ status: "error" });
    });

    test("a plain 403 (no rate-limit signal — e.g. access denied) is still unreadable", async () => {
      const deps: GithubConditionalDeps = { fetchImpl: async () => new Response(null, { status: 403 }) };
      expect(await pollGithubLink({ kind: "github-issue", target: REF }, null, deps)).toEqual({ status: "unreadable", httpStatus: 403 });
    });
  });

  test("PR #401 review round 1: a fetchImpl that never resolves is bounded by timeoutMs (error), not left hanging forever", async () => {
    const deps: GithubConditionalDeps = { fetchImpl: () => new Promise<Response>(() => {}), timeoutMs: 20 };
    const start = Date.now();
    expect(await pollGithubLink({ kind: "github-issue", target: REF }, null, deps)).toEqual({ status: "error" });
    expect(Date.now() - start).toBeLessThan(2000);
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

describe("BUTCHR-437: pollWebpage — PR #401 review round 2: an untrusted body is never read unbounded", () => {
  test("an ETag response's body is NEVER read (cancelled, not buffered) — proven with an endless stream that would hang/OOM if actually consumed", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(64 * 1024)); // would grow forever if ever actually read
      },
      cancel() { cancelled = true; },
    });
    const deps: WebpagePollDeps = {
      isBlockedHost: async () => false,
      fetchImpl: async () => new Response(stream, { status: 200, headers: { etag: '"e"' } }),
    };
    const start = Date.now();
    const result = await pollWebpage({ target: "https://example.com/x" }, undefined, deps);
    expect(result).toEqual({ status: "ok", fingerprint: 'etag:"e"' });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(pulls).toBeLessThanOrEqual(1); // at most the platform's own eager initial fill — this module never calls .read() in a loop to drain it
    expect(cancelled).toBe(true);
  });

  test("the hash-fallback path (no ETag/Last-Modified) still enforces the size cap on a genuinely huge body without hanging", async () => {
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(200_000)); }, // 200KB/chunk — exceeds the 1MB cap after 6 pulls
    });
    const deps: WebpagePollDeps = { isBlockedHost: async () => false, fetchImpl: async () => new Response(stream, { status: 200 }) };
    const start = Date.now();
    const result = await pollWebpage({ target: "https://example.com/x" }, undefined, deps);
    expect(result).toEqual({ status: "error" });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(pulls).toBeLessThanOrEqual(7); // stopped promptly once the cap was crossed, not after reading the whole (endless) stream
  });

  test("a mid-body read failure resolves error, not a thrown exception", async () => {
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(10)); },
      pull() { throw new Error("connection reset"); },
    });
    const deps: WebpagePollDeps = { isBlockedHost: async () => false, fetchImpl: async () => new Response(stream, { status: 200 }) };
    await expect(pollWebpage({ target: "https://example.com/x" }, undefined, deps)).resolves.toEqual({ status: "error" });
  });
});

describe("BUTCHR-437: pollWebpage — PR #401 review round 1: one shared deadline across every redirect hop", () => {
  test("a fetchImpl that never resolves is bounded by timeoutMs (error), not left hanging forever, and isBlockedHost is still consulted first", async () => {
    let blockedCalls = 0;
    const deps: WebpagePollDeps = {
      fetchImpl: () => new Promise<Response>(() => {}),
      isBlockedHost: async () => { blockedCalls++; return false; },
      timeoutMs: 20,
    };
    const start = Date.now();
    expect(await pollWebpage({ target: "https://example.com/x" }, undefined, deps)).toEqual({ status: "error" });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(blockedCalls).toBe(1);
  });

  test("a hanging isBlockedHost is itself bounded — never lets an unresolved SSRF check fall through as 'not blocked'", async () => {
    const deps: WebpagePollDeps = {
      fetchImpl: async () => { throw new Error("should never be called"); },
      isBlockedHost: () => new Promise<boolean>(() => {}),
      timeoutMs: 20,
    };
    expect(await pollWebpage({ target: "https://example.com/x" }, undefined, deps)).toEqual({ status: "error" });
  });

  test("several redirect hops together still respect ONE overall deadline, not one timeout per hop", async () => {
    let hops = 0;
    const deps: WebpagePollDeps = {
      isBlockedHost: async () => false,
      timeoutMs: 200,
      fetchImpl: async (u) => {
        hops++;
        if (hops <= 3) { await new Promise((r) => setTimeout(r, 90)); return new Response(null, { status: 302, headers: { location: `${u}?h=${hops}` } }); }
        return new Response("late", { status: 200, headers: { etag: '"e"' } });
      },
    };
    const start = Date.now();
    const result = await pollWebpage({ target: "https://example.com/x" }, undefined, deps);
    // 3 hops * 90ms = 270ms > the 200ms shared deadline — the chain must be cut short as transient, never followed to completion.
    expect(result).toEqual({ status: "error" });
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("BUTCHR-437: defaultIsBlockedHost (real DNS-based SSRF guard, IP literals only exercised here to avoid a real DNS lookup in a unit test)", () => {
  test("loopback/private/link-local IP literals and localhost are blocked; an ordinary public-shaped IP literal is not", async () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "172.16.0.5", "192.168.1.1", "169.254.169.254", "0.0.0.1", "localhost", "foo.localhost", "::1"]) {
      expect(await defaultIsBlockedHost(host)).toBe(true);
    }
    expect(await defaultIsBlockedHost("93.184.216.34")).toBe(false); // example.com's own A record — a public-shaped literal
  });

  test("PR #401 review round 1: CGNAT (100.64.0.0/10) is blocked", async () => {
    expect(await defaultIsBlockedHost("100.64.0.1")).toBe(true);
    expect(await defaultIsBlockedHost("100.127.255.254")).toBe(true);
    expect(await defaultIsBlockedHost("100.128.0.1")).toBe(false); // just outside the /10 — a real public-shaped address
  });

  test("PR #401 review round 1: IPv6 unspecified (::), unique-local (fc00::/7), and IPv4-mapped in BOTH spellings are blocked", async () => {
    expect(await defaultIsBlockedHost("::")).toBe(true);
    expect(await defaultIsBlockedHost("fc00::1")).toBe(true);
    expect(await defaultIsBlockedHost("fdff:ffff:ffff::1")).toBe(true); // top of the fc00::/7 range
    expect(await defaultIsBlockedHost("::ffff:127.0.0.1")).toBe(true); // dotted-quad spelling
    expect(await defaultIsBlockedHost("::ffff:7f00:1")).toBe(true); // all-hex spelling of the SAME address — the exact gap review round 1 found
    expect(await defaultIsBlockedHost("::ffff:a9fe:a9fe")).toBe(true); // all-hex spelling of ::ffff:169.254.169.254 (cloud metadata)
    expect(await defaultIsBlockedHost("::ffff:8.8.8.8")).toBe(false); // a genuinely public IPv4-mapped address
    expect(await defaultIsBlockedHost("2001:4860:4860::8888")).toBe(false); // an ordinary public IPv6 literal (Google DNS)
  });

  test("PR #401 review round 1: a hostname resolving to MULTIPLE addresses is blocked if ANY of them is private, not only the first", async () => {
    const mixedLookup = async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 }];
    expect(await defaultIsBlockedHost("multi.example.com", mixedLookup)).toBe(true);

    const allPublicLookup = async () => [{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }];
    expect(await defaultIsBlockedHost("multi.example.com", allPublicLookup)).toBe(false);

    const secondAddressPrivate = async () => [{ address: "2001:4860:4860::8888", family: 6 }, { address: "fc00::1", family: 6 }];
    expect(await defaultIsBlockedHost("multi.example.com", secondAddressPrivate)).toBe(true);
  });
});
