/**
 * FACTORY-5: owner routing for `LinkStore` — the ONE small, testable
 * function that decides, per call, whether a `list`/`add`/`remove` touches
 * the Jira-project-property-backed store (`jira-project-link-store.ts`) or
 * the provider-agnostic local file store FACTORY-7 shipped
 * (`link-store.ts`'s `createLinkStore`). Deliberately not a scattering of
 * `if (ownerKey.startsWith("jira-project:"))` checks at each of the three
 * call sites (core `listLinks`/`addLink`/`removeLink` never need to know
 * this decision exists at all — they call whatever `LinkStore` they're
 * handed) — this is the ONE place the decision is made, reused identically
 * by the daemon's MCP tool wiring and the CLI.
 *
 * `ownerKey` here is always the full canonical `"<provider>:<id>"` string
 * (e.g. `"jira-project:BUTCHR"`) — the same string every `LinkStore` method
 * already receives — so routing is a prefix check, not a parse.
 *
 * LAZY `jiraProjectStore`: a factory, not a `LinkStore` value, and invoked
 * ONLY when a call actually routes to a `jira-project:` owner. This is what
 * lets the CLI (`src/cli/link-cli.ts`) build a routing store up front
 * without needing Jira credentials for the common case (a non-jira-project
 * resource) — credential loading happens lazily, inside the factory, the
 * first time it's actually needed, and any error it throws (missing
 * credentials, a bad token) propagates as a normal rejected `list`/`add`/
 * `remove` call, which the CLI already turns into a clean one-line stderr
 * message (`tryStoreOp`, link-cli.ts) — no separate error-handling path
 * needed here.
 */
import type { LinkStore } from "./link-store.js";

export function isJiraProjectOwnerKey(ownerKey: string): boolean {
  return ownerKey.startsWith("jira-project:");
}

export interface LinkStoreRouterDeps {
  /** Every owner kind except `jira-project`. */
  fileStore: LinkStore;
  /** Invoked only for a `jira-project:` owner — see this module's header. */
  jiraProjectStore: () => LinkStore | Promise<LinkStore>;
}

export function createRoutingLinkStore(deps: LinkStoreRouterDeps): LinkStore {
  const storeFor = async (ownerKey: string): Promise<LinkStore> => (isJiraProjectOwnerKey(ownerKey) ? await deps.jiraProjectStore() : deps.fileStore);
  return {
    async list(ownerKey) {
      return (await storeFor(ownerKey)).list(ownerKey);
    },
    async add(ownerKey, targetKey) {
      return (await storeFor(ownerKey)).add(ownerKey, targetKey);
    },
    async remove(ownerKey, targetKey) {
      return (await storeFor(ownerKey)).remove(ownerKey, targetKey);
    },
  };
}
