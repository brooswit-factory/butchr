/**
 * BUTCHR-339: resolves a dashboard row's RESOURCE key to the correct
 * external target — the Jira ISSUE for an issue key, the project's
 * CONFLUENCE ROOT DOC for a project id. Pure given its deps (no direct
 * Atlassian client of its own), so it can be unit-tested directly rather
 * than only reachable through `src/daemon/index.ts` (a module no unit test
 * in this repo imports — see `src/agents/dashboard.ts`'s own header for why
 * that discipline exists, and the same reasoning applies here: getting this
 * backwards — Jira for a project, Confluence for an issue — is one of
 * BUTCHR-339's own eight named mutations, and it must have a real test that
 * actually runs this function, not one that only exercises the daemon
 * entrypoint script).
 *
 * `isProjectId`/`isIssueKey` (./id.ts) are mutually exclusive by
 * construction, so exactly one branch below ever applies to a well-formed
 * key; a key matching neither is refused with a specific reason rather than
 * silently falling through to either branch.
 */
import { isIssueKey, isProjectId } from "./id.js";

export interface ResourceLinkDeps {
  /** The configured Atlassian site (e.g. `https://foo.atlassian.net`, no trailing slash) — reused verbatim, never a second spelling (see `src/tools/docs.ts`'s own `ticketUrl` construction, which this mirrors). */
  jiraSite: string;
  /**
   * Resolves a PROJECT key's root-doc URL. Never called for an issue key.
   * A rejection (the project's `butchr` entity property unreadable or
   * missing `rootDoc.id` — see `src/tools/docs.ts`'s `projectRootDoc`) is
   * caught by `resolveResourceLink` itself and turned into a readable
   * refusal, never allowed to throw out of this function.
   */
  projectRootDocUrl: (projectKey: string) => Promise<string>;
}

export type ResourceLinkResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * `/dashboard` does no I/O on its own request path (see `src/agents/dashboard.ts`'s
 * module header); this function is deliberately the ONE place that Atlassian
 * read happens for a resource link, and it is only ever called from the
 * `/resource/:key/open` redirect route (`src/web/view.ts`) — i.e. only when
 * a human actually clicks, never while building the dashboard page itself.
 */
export async function resolveResourceLink(key: string, deps: ResourceLinkDeps): Promise<ResourceLinkResult> {
  if (isIssueKey(key)) return { ok: true, url: `${deps.jiraSite}/browse/${key}` };
  if (isProjectId(key)) {
    try {
      const url = await deps.projectRootDocUrl(key);
      if (!url) return { ok: false, error: `project ${key}'s root doc has no resolvable URL (its Confluence page reported no _links.base/webui)` };
      return { ok: true, url };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  return { ok: false, error: `"${key}" is neither a valid Jira issue key nor a valid project id — cannot resolve a resource link for it` };
}
