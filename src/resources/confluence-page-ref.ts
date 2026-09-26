/**
 * FACTORY-7: the `confluence-page` ResourceRef kind's identity — a bare
 * Confluence page id, NOT a `{space, pageId}` pair the way the handoff doc's
 * example shape suggests. Deliberate departure, decided in
 * `docs/resource-links.md`: a page's numeric id is Confluence's own stable
 * identity (BUTCHR-... this repo's `src/tools/docs.ts` already keys a
 * project's root doc by `id` alone); its space is metadata that can change
 * (a page can move space without changing id) and would either duplicate the
 * id or go stale next to it. No Atlassian site field either, for the same
 * reason `jira-work-item-ref.ts`/`jira-project-ref.ts` carry none: this
 * codebase configures exactly one Atlassian site per daemon
 * (`config.atlassian.site`), so a page id is unambiguous within a daemon's
 * own scope without repeating that site everywhere a ref is written.
 *
 * `parseConfluencePageRef` accepts EITHER a bare numeric id OR a full
 * Confluence page URL, extracting the id via `pageIdFromUrl` (`src/tools/docs.ts`)
 * — reused rather than a second `/pages/(\d+)/` regex disagreeing with the
 * one that module's own comment already protects. A Confluence URL with NO
 * `/pages/<digits>/` segment (e.g. a space overview URL) is not a
 * `confluence-page` ref at all — see `docs/resource-links.md`'s "known
 * aliasing not resolved" section for why that case is left as a generic
 * `webpage` ref instead, on purpose.
 */
import { pageIdFromUrl } from "../tools/docs.js";

export interface ConfluencePageRef {
  pageId: string;
}

const PAGE_ID_RE = /^[0-9]+$/;

export function isConfluencePageRef(pageId: string): boolean {
  return PAGE_ID_RE.test(pageId);
}

export function formatConfluencePageRef(ref: ConfluencePageRef): string {
  if (!isConfluencePageRef(ref.pageId)) throw new Error(`invalid confluence-page reference: ${JSON.stringify(ref.pageId)}`);
  return ref.pageId;
}

/**
 * `null` for anything that is neither a bare numeric page id nor a
 * Confluence page URL containing one (never throws). Never case-folds:
 * Confluence page ids are numeric, so there is no case to fold.
 */
export function parseConfluencePageRef(input: string): ConfluencePageRef | null {
  if (isConfluencePageRef(input)) return { pageId: input };
  const fromUrl = pageIdFromUrl(input);
  return fromUrl && isConfluencePageRef(fromUrl) ? { pageId: fromUrl } : null;
}
