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
 * daemon boot — a `butchr link ...` invocation must not require Jira
 * credentials or a rules file, since the link store is provider-agnostic
 * local state.
 */
import { addLink, createLinkStore, defaultLinksStorePath, listLinks, removeLink, type LinkStore } from "../resources/link-store.js";
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

function defaultIo(): LinkCliIo {
  return { store: createLinkStore(defaultLinksStorePath()), stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
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
    const links = await listLinks(io.store, resource.ref);
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
      const result = await addLink(io.store, resource.ref, target.ref);
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

    const result = await removeLink(io.store, resource.ref, target.ref);
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
