/**
 * FACTORY-7: the `webpage` ResourceRef kind's identity — a normalized
 * `http(s)` URL, the generic catch-all for anything with no more specific
 * provider (mirrors `src/resources/linked-discovery.ts`'s own `webpage`
 * `LinkedItemKind`, which is the closest prior art in this codebase for
 * "what counts as a plain webpage" — see `docs/resource-links.md` for how
 * the two relate).
 *
 * NORMALIZATION APPLIED (each is what `new URL()` already does for a
 * "special" scheme like http/https, or one extra step below):
 * - scheme and host lower-cased (`URL` does this itself),
 * - default port removed (80 for http, 443 for https — `URL` does this
 *   itself too: `new URL("http://x:80/").port === ""`),
 * - fragment (`#...`) stripped — a fragment is purely client-side,
 * - a trailing `/` stripped from the path, UNLESS the path is the bare root
 *   `/` (a URL with no path at all always serializes with one).
 *
 * DELIBERATELY NOT NORMALIZED, named so this isn't "fixed" by accident later
 * without re-reading `docs/resource-links.md`'s own decision:
 * - the query string is kept byte-for-byte, tracking parameters included.
 *   Deciding which query parameters are "tracking-irrelevant" is
 *   provider-specific and easy to get wrong in either direction (stripping a
 *   parameter that DOES change the resource, or keeping one that never
 *   does) — left unresolved on purpose, not an oversight.
 * - the path's OWN case is preserved (unlike the host) — paths are
 *   case-sensitive in general on the web, unlike DNS hostnames.
 * - a URL that also happens to identify a Confluence page (see
 *   `confluence-page-ref.ts`) is not detected or redirected to that provider
 *   — known, deliberately unresolved aliasing, see `docs/resource-links.md`.
 */
export interface WebpageRef {
  url: string;
}

function canonicalize(input: string): string | null {
  let u: URL;
  try { u = new URL(input); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  u.hash = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

/** `null` for anything that isn't a plain `http(s)` URL with no embedded credentials (never throws). Returns the CANONICAL form, which may differ from `input` byte-for-byte even when `input` was already valid. */
export function parseWebpageRef(input: string): WebpageRef | null {
  const canonical = canonicalize(input);
  return canonical ? { url: canonical } : null;
}

/** True only for the exact canonical form `parseWebpageRef`/`formatWebpageRef` produce — i.e. `url` is already a fixed point of canonicalization. */
export function isWebpageRef(url: string): boolean {
  const parsed = parseWebpageRef(url);
  return parsed !== null && parsed.url === url;
}

export function formatWebpageRef(ref: WebpageRef): string {
  const parsed = parseWebpageRef(ref.url);
  if (!parsed) throw new Error(`invalid webpage reference: ${JSON.stringify(ref.url)}`);
  return parsed.url;
}
