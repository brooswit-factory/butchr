/**
 * FACTORY-7: the merge CONTRACT a future provider adapter (FACTORY-6) will
 * use to combine a resource's provider-NATIVE links (e.g. Jira `issuelinks`,
 * once a provider implements `ProviderAdapter.nativeLinks`, `src/resources/
 * provider-adapter.ts`) with its butchr-MANAGED links (`src/resources/
 * link-store.ts`) into one effective sensor set. This story does not
 * implement any provider's native-link discovery — `mergeEffectiveLinks`
 * itself is what's being shipped and tested now, ready for FACTORY-6 to call
 * once a real `native` array exists.
 *
 * RECURSION DECISION, ENFORCED STRUCTURALLY, NOT JUST DOCUMENTED: a link
 * only ever creates a sensor for the directly-linked resource — it never
 * causes discovery of THAT resource's own links, and never creates an
 * agent (the handoff doc's own separation: "queries decide which resources
 * get agents; links decide which resources those agents can sense"). This
 * function's signature is the enforcement: it takes two flat
 * `ResourceRef[]` arrays and returns a flat array — there is no resource
 * resolver, no provider client, and no recursive call anywhere in its body,
 * so there is no code path by which it COULD follow a target's own links even
 * if a future edit wanted it to without changing this signature first (which
 * a reviewer reading this file's diff would see).
 *
 * ORDERING CONTRACT (part of the documented behaviour, not an accident of
 * `Map` insertion order): the effective set lists every `native` ref first,
 * in `native`'s own order, then every `managed` ref not already present
 * (by canonical key), in `managed`'s own order. Deterministic, and cheap to
 * assert in a test.
 */
import { canonicalKey, type ResourceRef } from "./resource-ref.js";

/** Where an effective link's membership comes from: discovered by the provider, added by `add_link`, or both (present in both source lists). */
export type LinkOrigin = "native" | "managed" | "both";

export interface EffectiveLink {
  ref: ResourceRef;
  origin: LinkOrigin;
}

/**
 * Pure: no I/O, no provider call, no recursion — see this module's header.
 *
 * `"both"` means specifically "present in BOTH SOURCE LISTS" — a target
 * that merely repeats within `managed` alone (or within `native` alone)
 * stays `"managed"` (resp. `"native"`), never promoted to `"both"` just for
 * appearing twice in the same list. `nativeKeys` is what makes that
 * distinction: without it, a plain within-`managed` duplicate would be
 * indistinguishable from a genuine native+managed overlap, since both cases
 * find the key already present in `byKey` by the time the duplicate is
 * reached.
 */
export function mergeEffectiveLinks(native: readonly ResourceRef[], managed: readonly ResourceRef[]): EffectiveLink[] {
  const nativeKeys = new Set<string>();
  const byKey = new Map<string, EffectiveLink>();
  for (const ref of native) {
    const key = canonicalKey(ref);
    nativeKeys.add(key);
    byKey.set(key, { ref, origin: "native" });
  }
  for (const ref of managed) {
    const key = canonicalKey(ref);
    if (!byKey.has(key)) byKey.set(key, { ref, origin: "managed" });
    else if (nativeKeys.has(key)) byKey.set(key, { ref, origin: "both" });
  }
  return [...byKey.values()];
}
