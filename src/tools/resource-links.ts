/**
 * FACTORY-7: `list_links`/`add_link`/`remove_link` — the MCP surface over
 * `src/resources/link-store.ts`'s core operations, usable by ANY resource
 * agent (per the handoff doc's own "generic operations ... for any resource
 * agent and a human operator") and, via `src/cli/link-cli.ts`, by a human.
 *
 * UNLIKE `github_get_issue`/`zendesk_get_ticket`/etc., these tools take an
 * EXPLICIT `resource` argument rather than scoping to the caller's own
 * identity (`callerIdentity`, `src/mcp/identity.ts`) — a deliberate
 * departure from that convention, not an oversight: three of this story's
 * six `ResourceRef` kinds (`confluence-page`, `filesystem`, `webpage`) have
 * no agent/caller-identity concept anywhere in this codebase at all, so
 * "the caller's own resource" is not an answerable question for them. An
 * explicit argument also matches the handoff doc's own signature,
 * `list_links(resource)`, literally.
 *
 * `resource` and `target` are always the canonical `<provider>:<id>` STRING
 * form (`src/resources/resource-ref.ts`) — the SAME encoding the CLI takes
 * on argv and the store persists to disk, so there is exactly one
 * representation to document, test, and debug, rather than a string form
 * for the CLI and a structured-object form for MCP.
 *
 * These tools return ONLY the butchr-MANAGED link collection — see
 * `src/resources/managed-links.ts`'s header for why `list_links` here is not
 * a merge with provider-native links (no provider adapter exists yet).
 *
 * Registered unconditionally (unlike `githubIssueTools`/`zendeskTicketTools`,
 * which run only when their provider is configured) — the local link store
 * needs no external credentials and works for every provider kind, so there
 * is no configuration gate to apply.
 */
import { z, type ToolDef } from "@brooswit/thatch";
import { parseResourceRef, formatResourceRef } from "../resources/resource-ref.js";
import { addLink, listLinks, removeLink, type LinkStore } from "../resources/link-store.js";
import { Refusal, withOutcomeRecording } from "./outcome.js";

function parseOrRefuse(input: string, argName: string) {
  try {
    return parseResourceRef(input);
  } catch (e) {
    throw new Refusal(`${argName} ${(e as Error).message}`);
  }
}

export function resourceLinkTools(store: LinkStore, log: (line: string) => void = console.error): Record<string, ToolDef<any>> {
  const tools: Record<string, ToolDef<any>> = {
    list_links: {
      description:
        "List the butchr-managed links for a resource — the resources this agent has said it wants to sense, in canonical `provider:id` form. Does NOT include provider-native links (e.g. Jira issuelinks); those are merged in separately once a provider adapter implements it.",
      input: { resource: z.string() },
      handler: async (a) => {
        const { resource } = a as { resource: string };
        const ref = parseOrRefuse(resource, "resource:");
        log(`  [tools] list_links ${resource}`);
        const links = await listLinks(store, ref);
        return { resource: formatResourceRef(ref), links: links.map(formatResourceRef) };
      },
    },
    add_link: {
      description:
        "Add a butchr-managed link from `resource` to `target` (both canonical `provider:id` strings, e.g. `jira-project:BUTCHR`, `github-issue:owner/repo#42`). Idempotent: adding a link that already exists is a no-op, reported via `added: false`. A resource may not link to itself.",
      input: { resource: z.string(), target: z.string() },
      handler: async (a) => {
        const { resource, target } = a as { resource: string; target: string };
        const resourceRef = parseOrRefuse(resource, "resource:");
        const targetRef = parseOrRefuse(target, "target:");
        log(`  [tools] add_link ${resource} -> ${target}`);
        const result = await addLink(store, resourceRef, targetRef);
        if (!result.ok) throw new Refusal(result.error);
        return result.added ? { added: true } : { added: false, reason: result.reason };
      },
    },
    remove_link: {
      description:
        "Remove a butchr-managed link from `resource` to `target` (both canonical `provider:id` strings). Removing a link that is not present is a non-destructive no-op, reported via `removed: false`, never an error.",
      input: { resource: z.string(), target: z.string() },
      handler: async (a) => {
        const { resource, target } = a as { resource: string; target: string };
        const resourceRef = parseOrRefuse(resource, "resource:");
        const targetRef = parseOrRefuse(target, "target:");
        log(`  [tools] remove_link ${resource} -> ${target}`);
        const result = await removeLink(store, resourceRef, targetRef);
        return result.removed ? { removed: true } : { removed: false, reason: result.reason };
      },
    },
  };
  return withOutcomeRecording(tools, log);
}
