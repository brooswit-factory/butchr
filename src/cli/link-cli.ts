/**
 * FACTORY-7: `butchr link list|add|remove` — the human-facing CLI over the
 * same core operations `src/tools/resource-links.ts` exposes over MCP
 * (`src/resources/link-store.ts`'s `listLinks`/`addLink`/`removeLink`);
 * neither layer reimplements the other's logic.
 *
 * `package.json`'s `bin.butchr` builds SOLELY from `src/daemon/index.ts`
 * (`scripts/build/build.ts`) — there is no separate CLI entrypoint or
 * argument-dispatch framework anywhere in this codebase to plug into
 * (confirmed: no `process.argv` subcommand switch exists before this story).
 * `runLinkCli` is therefore invoked from a small guard at the very top of
 * `src/daemon/index.ts`, BEFORE that file's own config/rules loading and
 * daemon boot — a `butchr link ...` invocation for a NON-`jira-project`
 * resource must not require Jira credentials or a rules file, since the
 * file-backed link store is provider-agnostic local state.
 *
 * FACTORY-5 ADDS ONE EXCEPTION, LAZILY: a `jira-project:<KEY>` owner routes
 * to the project-property-backed store instead
 * (`src/resources/jira-project-link-store.ts`), which needs a live Jira
 * credential to read/write `brooswit.butchr.links`. `defaultIo` below does
 * NOT call `loadConfig` up front — it hands `createRoutingLinkStore` a
 * FACTORY function that only calls `loadConfig`/constructs a Jira client the
 * first time a call actually routes to a `jira-project:` owner (see
 * `src/resources/link-store-router.ts`'s own header for why the factory is
 * lazy). This is what keeps `butchr link list jira-work-item:X` credential-
 * free exactly as before, while `butchr link list jira-project:X` picks up
 * the same `ATLASSIAN_SITE`/`ATLASSIAN_EMAIL`/`ATLASSIAN_TOKEN(_FILE)`
 * environment the daemon itself reads (`src/config/config.ts`). A missing
 * credential, or any Jira 4xx/5xx the resulting client call hits, surfaces
 * through the exact same path a store-read failure already did before this
 * story (`tryStoreOp` below turns any rejected store call into one clean
 * `stderr` line + exit 1) — no separate error-handling branch was added.
 */
import { readFileSync } from "node:fs";
import { addLink, createLinkStore, defaultLinksStorePath, listLinks, removeLink, type LinkStore } from "../resources/link-store.js";
import { createRoutingLinkStore } from "../resources/link-store-router.js";
import { createJiraProjectLinkStore } from "../resources/jira-project-link-store.js";
import { loadConfig } from "../config/config.js";
import { realAtlassian } from "../tools/atlassian-real.js";
import { formatResourceRef, parseResourceRef } from "../resources/resource-ref.js";

const USAGE = `usage: butchr link list <resource>
       butchr link add <resource> <target>
       butchr link remove <resource> <target>

<resource> and <target> are canonical "<provider>:<id>" references, e.g.:
  jira-work-item:BUTCHR-123
  jira-project:BUTCHR
  confluence-page:123456
  github-issue:owner/repo#42
  filesystem:/srv/factory/butchr
  webpage:https://example.com/resource`;

export interface LinkCliIo {
  store: LinkStore;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * Loads Jira credentials from the SAME environment the daemon reads
 * (`loadConfig`, `src/config/config.ts`) and builds a project-property-
 * backed store over them. Called lazily — see this file's own header — so a
 * missing/invalid credential only ever surfaces when a `jira-project` owner
 * is actually named, never for any other resource kind. Throws (never
 * catches): the rejection propagates through `createRoutingLinkStore`'s
 * factory call into whichever `listLinks`/`addLink`/`removeLink` call
 * triggered it, where `tryStoreOp` below converts it into a clean stderr
 * line.
 */
export function jiraProjectStoreFromEnv(): LinkStore {
  const config = loadConfig(process.env as Record<string, string | undefined>, (p) => readFileSync(p, "utf8"));
  // FACTORY-66: Atlassian credentials are now optional (src/config/config.ts)
  // — a `jira-project` resource genuinely needs them regardless, so this
  // throws its own clear, named error rather than a raw
  // "Cannot read properties of undefined" one. Same "throws, never catches"
  // contract as before (see this file's own header) — `tryStoreOp` still
  // turns this into a clean stderr line.
  if (!config.atlassian) throw new Error("butchr link: jira-project resources require Atlassian credentials, but none are configured on this host (set ATLASSIAN_SITE, ATLASSIAN_EMAIL and ATLASSIAN_TOKEN or ATLASSIAN_TOKEN_FILE)");
  return createJiraProjectLinkStore(realAtlassian({ site: config.atlassian.site, email: config.atlassian.email, token: config.atlassian.token }));
}

function defaultIo(): LinkCliIo {
  return {
    store: createRoutingLinkStore({ fileStore: createLinkStore(defaultLinksStorePath()), jiraProjectStore: jiraProjectStoreFromEnv }),
    stdout: (l) => console.log(l),
    stderr: (l) => console.error(l),
  };
}

function parseOrFail(input: string, argName: string, io: LinkCliIo): { ok: true; ref: ReturnType<typeof parseResourceRef> } | { ok: false } {
  try {
    return { ok: true, ref: parseResourceRef(input) };
  } catch (e) {
    io.stderr(`butchr link: invalid ${argName} ${(e as Error).message}`);
    return { ok: false };
  }
}

/**
 * Runs `op` (a store-touching call — `listLinks`/`addLink`/`removeLink`) and
 * reports any thrown/rejected error as a clean one-line `stderr` message
 * instead of letting it propagate — a `LinkStore` read can throw (an
 * unreadable file, invalid JSON, or `link-store.ts`'s own newer-version
 * refusal), and this function is what keeps that from surfacing as an
 * uncaught stack trace at the top of `src/daemon/index.ts` instead of the
 * clean, documented exit-1 behaviour this CLI promises. `null` on failure —
 * the caller returns 1 without touching `io.stdout`.
 */
async function tryStoreOp<T>(op: () => Promise<T>, io: LinkCliIo): Promise<T | null> {
  try {
    return await op();
  } catch (e) {
    io.stderr(`butchr link: ${(e as Error).message}`);
    return null;
  }
}

/**
 * `argv` is everything AFTER `link` (i.e. `process.argv.slice(3)` when
 * `process.argv[2] === "link"`). Returns the process exit code; never
 * throws. `io` is injectable for tests — production omits it and gets the
 * real store/console.
 */
export async function runLinkCli(argv: string[], io: LinkCliIo = defaultIo()): Promise<number> {
  const [sub, ...rest] = argv;

  if (sub === "--help" || sub === "-h") {
    io.stdout(USAGE);
    return 0;
  }
  if (sub === undefined) {
    io.stderr(USAGE);
    return 1;
  }

  if (sub === "list") {
    if (rest.length !== 1) {
      io.stderr(`butchr link list: expected exactly one argument\n\n${USAGE}`);
      return 1;
    }
    const resource = parseOrFail(rest[0]!, "resource:", io);
    if (!resource.ok) return 1;
    const links = await tryStoreOp(() => listLinks(io.store, resource.ref), io);
    if (links === null) return 1;
    if (!links.length) {
      io.stdout(`no links for ${formatResourceRef(resource.ref)}`);
      return 0;
    }
    for (const l of links) io.stdout(formatResourceRef(l));
    return 0;
  }

  if (sub === "add" || sub === "remove") {
    if (rest.length !== 2) {
      io.stderr(`butchr link ${sub}: expected exactly two arguments\n\n${USAGE}`);
      return 1;
    }
    const resource = parseOrFail(rest[0]!, "resource:", io);
    const target = parseOrFail(rest[1]!, "target:", io);
    if (!resource.ok || !target.ok) return 1;

    if (sub === "add") {
      const result = await tryStoreOp(() => addLink(io.store, resource.ref, target.ref), io);
      if (result === null) return 1;
      if (!result.ok) {
        io.stderr(`butchr link add: ${result.error}`);
        return 1;
      }
      io.stdout(
        result.added
          ? `added ${formatResourceRef(target.ref)} to ${formatResourceRef(resource.ref)}`
          : `${formatResourceRef(target.ref)} is already linked to ${formatResourceRef(resource.ref)}`,
      );
      return 0;
    }

    const result = await tryStoreOp(() => removeLink(io.store, resource.ref, target.ref), io);
    if (result === null) return 1;
    io.stdout(
      result.removed
        ? `removed ${formatResourceRef(target.ref)} from ${formatResourceRef(resource.ref)}`
        : `${formatResourceRef(target.ref)} was not linked to ${formatResourceRef(resource.ref)}`,
    );
    return 0;
  }

  io.stderr(`butchr link: unknown subcommand ${JSON.stringify(sub)}\n\n${USAGE}`);
  return 1;
}
