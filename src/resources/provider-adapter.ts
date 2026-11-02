/**
 * FACTORY-7: the extension point FACTORY-6 (reconcile effective links into
 * watchers, cache snapshots, emit change events) is expected to implement
 * against — declared and documented here, NOT implemented for any provider
 * in this story (per this epic's own scope: "do not implement any
 * provider's native-link discovery ... leave a clear extension point for
 * it"). Nothing in this codebase constructs a `ProviderAdapter` today; it
 * exists purely as a stable type for a future module to implement.
 */
import type { ResourceRef } from "./resource-ref.js";

export interface ProviderAdapter<Ref extends ResourceRef = ResourceRef> {
  /**
   * Normalizes provider-native identity into this ref's canonical form —
   * the same normalization `formatResourceRef`/`canonicalKey`
   * (`./resource-ref.ts`) already apply, exposed here so a future adapter
   * that discovers a ref from a provider's OWN API response (not from a
   * human-typed canonical string) can normalize it before comparing or
   * storing it, without re-deriving that logic.
   */
  canonicalize(ref: Ref): Ref;

  /**
   * NOT IMPLEMENTED IN THIS STORY. Once a provider adapter exists, this
   * discovers `ref`'s provider-native links (e.g. a Jira work item's own
   * `issuelinks`) for `mergeEffectiveLinks` (`./managed-links.ts`) to combine
   * with the managed collection. Optional: a provider with nothing native
   * to discover (e.g. `filesystem`) may omit it entirely, exactly like
   * `Discovery.related` (`./types.ts`) is already optional for the same
   * reason.
   */
  nativeLinks?(ref: Ref): Promise<ResourceRef[]>;

  /**
   * NOT IMPLEMENTED IN THIS STORY. A cheap, provider-specific hint that
   * `ref` may have changed since the last poll — an opaque string a future
   * reconciler compares to its previous value, never interpreted here.
   * Recommended per-provider strategies (guidance only, nothing below is
   * built or wired to anything):
   *   - `jira-work-item` / `jira-project`: the issue/project's own `updated`
   *     timestamp, plus a comment count (an update with the same `updated`
   *     but a new comment is still a change worth polling for).
   *   - `confluence-page`: the page's `version.number`.
   *   - `github-issue`: the issue's `updated_at`, or its response ETag.
   *   - `filesystem`: mtime plus size (mtime alone misses a same-second
   *     rewrite on filesystems with second-granularity timestamps).
   *   - `webpage`: the response's `ETag` header, falling back to
   *     `Last-Modified` when absent.
   */
  changeToken?(ref: Ref): Promise<string | null>;
}
