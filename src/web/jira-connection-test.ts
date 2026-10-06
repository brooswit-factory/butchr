/**
 * FACTORY-664 — `POST /api/settings/jira/test`'s own logic: calls Atlassian
 * `GET /rest/api/3/myself` with the daemon's OWN already-loaded credentials
 * (never anything from the request body — there is none), and reports back
 * ONLY `{ok, site, httpStatusClass, error?}`. NEVER the upstream response
 * body, NEVER the token, NEVER the Authorization header — those never even
 * reach the return value, only the raw `fetch` call does. Timeout 10s. No
 * redirects followed to another host (`redirect: "manual"` — a 3xx is
 * reported as `httpStatusClass: "other"`, never silently followed).
 */

export type HttpStatusClass = "2xx" | "401/403" | "other" | "network";

export interface JiraTestResult {
  ok: boolean;
  site: string;
  httpStatusClass: HttpStatusClass;
  error?: string;
}

export interface JiraTestCredentials {
  site: string;
  email: string;
  token: string;
}

const TIMEOUT_MS = 10_000;

/** The narrow slice of `fetch` this module actually calls — not `typeof fetch` itself, so an injected test double doesn't also have to implement `fetch.preconnect`. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function classify(status: number): HttpStatusClass {
  if (status >= 200 && status < 300) return "2xx";
  if (status === 401 || status === 403) return "401/403";
  return "other";
}

/** Injectable `fetch` for tests — production uses the global `fetch`. Never logs or returns the Authorization header or the response body. */
export async function testJiraConnection(creds: JiraTestCredentials, fetchFn: FetchLike = fetch): Promise<JiraTestResult> {
  const url = `${creds.site.replace(/\/+$/, "")}/rest/api/3/myself`;
  const basic = Buffer.from(`${creds.email}:${creds.token}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { authorization: `Basic ${basic}`, accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    const httpStatusClass = classify(res.status);
    return httpStatusClass === "2xx"
      ? { ok: true, site: creds.site, httpStatusClass }
      : { ok: false, site: creds.site, httpStatusClass, error: fixedErrorFor(httpStatusClass) };
  } catch {
    return { ok: false, site: creds.site, httpStatusClass: "network", error: fixedErrorFor("network") };
  } finally {
    clearTimeout(timer);
  }
}

/** Fixed, non-leaking error strings — never interpolates anything from the upstream response. */
function fixedErrorFor(httpStatusClass: HttpStatusClass): string {
  switch (httpStatusClass) {
    case "401/403": return "Jira rejected these credentials (401/403).";
    case "other": return "Jira returned an unexpected response.";
    case "network": return "could not reach Jira (network error or timeout).";
    default: return "unknown error";
  }
}
