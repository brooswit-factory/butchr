/**
 * BUTCHR-454 — `butchr session list|show|create|freeze|unfreeze`, following
 * `link-cli.ts`'s own precedent (BUTCHR-408/FACTORY-7): credential-free, no
 * daemon needed, dispatched from a guard at the top of
 * `src/daemon/index.ts`, BEFORE that file's own config/rules loading — a
 * managed-session definition is local filesystem state, same as the link
 * store. This file is deliberately thin: every real decision (validation,
 * atomic writes, the two freeze gates and their order) lives in
 * `src/resources/session-definition-manage.ts` and
 * `src/resources/session-freeze.ts`, which a later task's MCP tools will
 * call directly, unchanged.
 */
import { access, readFile } from "node:fs/promises";
import { MANAGED_SESSIONS_POLL_MS } from "../daemon/session-definitions-loop.js";
import { listFilesystemResources, type FilesystemResource } from "../resources/filesystem.js";
import type { FilesystemQuery } from "../resources/filesystem-query.js";
import {
  createSessionDefinition, listSessionDefinitions, showSessionDefinition,
  type SessionDefinitionListEntry,
} from "../resources/session-definition-manage.js";
import {
  defaultSessionFreezeIo, freezeSessionDefinition, unfreezeSessionDefinition,
  type SessionFreezeIo,
} from "../resources/session-freeze.js";
import { sessionDefinitionsPath } from "../resources/session-definition.js";
import { writeFileAtomic } from "../resources/atomic-write.js";

const USAGE = `usage: butchr session list
       butchr session show <name>
       butchr session create <name> --working-directory <dir> --brief <text>
                             --vendor claude|codex --tier tier1..tier5
                             --permission-mode default|acceptEdits|bypassPermissions|plan|auto
                             [--execution swarm|singleton|persistent]
                             [--account none|temporary|permanent]
                             [--role worker|sentinel] [--frozen]
                             [--mcp-servers <json array>]
                             [--freeze-controllers <comma-separated names>]
                             [--unfreeze-controllers <comma-separated names>]
       butchr session freeze <name>
       butchr session unfreeze <name>

<name> is a definition file's basename, with or without ".json", in the
well-known session-definitions directory (BUTCHR_SESSION_DEFINITIONS_DIR,
else $XDG_CONFIG_HOME/butchr/session-definitions).

--freeze-controllers/--unfreeze-controllers name OTHER definitions (by file
name, with or without ".json") whose agent may call the butchr
freeze_session/unfreeze_session MCP tool against THIS one — see
docs/managed-sessions.md's "Delegated freeze/unfreeze". There is no CLI
verb to change a grant after creation; edit the manifest file directly (or
recreate it) and let the daemon's own poll pick it up.`;

export interface SessionCliIo {
  dir: string;
  freeze: SessionFreezeIo;
  list: (query: FilesystemQuery) => Promise<FilesystemResource[]>;
  read: (path: string) => Promise<string>;
  write: (path: string, contents: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** Exported purely so a test can cover the real (disk-touching) implementation directly, without going through `defaultIo()` — which also wires the real freeze-store singleton, and tests must never touch that (see this ticket's own hard constraints). */
export const realExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

function defaultIo(): SessionCliIo {
  const freeze = defaultSessionFreezeIo();
  return {
    dir: sessionDefinitionsPath(),
    freeze,
    list: listFilesystemResources,
    read: (p) => readFile(p, "utf8"),
    write: writeFileAtomic,
    exists: realExists,
    stdout: (l) => console.log(l),
    stderr: (l) => console.error(l),
  };
}

const freezeSummary = (manifestFrozen: boolean | undefined, storeFrozen: boolean | undefined): string =>
  `manifest=${manifestFrozen === undefined ? "unknown (invalid definition)" : manifestFrozen} store=${storeFrozen === undefined ? "unknown (path too long for an agent key)" : storeFrozen}`;

/** `[]`/`undefined` renders as `(none)` — same convention for both grant fields, list and show. */
const controllersSummary = (names: string[] | undefined): string => (names?.length ? names.join(", ") : "(none)");

function formatListEntry(e: SessionDefinitionListEntry): string[] {
  if (!e.valid) {
    const lines = [`${e.name}  INVALID  (${freezeSummary(e.manifestFrozen, e.storeFrozen)})`];
    for (const p of e.problems) lines.push(`  - ${p}`);
    return lines;
  }
  return [
    `${e.name}  valid  vendor=${e.vendor} tier=${e.tier} role=${e.role} execution=${e.execution}  (${freezeSummary(e.manifestFrozen, e.storeFrozen)})`,
    `  freezeControllers=${controllersSummary(e.freezeControllers)} unfreezeControllers=${controllersSummary(e.unfreezeControllers)}`,
  ];
}

function formatShowEntry(e: SessionDefinitionListEntry): string[] {
  const lines = [`name: ${e.name}`, `path: ${e.path}`, `agentKey: ${e.agentKey}`, `valid: ${e.valid}`];
  if (e.valid) {
    lines.push(`vendor: ${e.vendor}`, `tier: ${e.tier}`, `role: ${e.role}`, `execution: ${e.execution}`);
    lines.push(`freezeControllers: ${controllersSummary(e.freezeControllers)}`, `unfreezeControllers: ${controllersSummary(e.unfreezeControllers)}`);
  } else {
    lines.push("problems:");
    for (const p of e.problems) lines.push(`  - ${p}`);
  }
  lines.push(`frozen: ${freezeSummary(e.manifestFrozen, e.storeFrozen)}`);
  return lines;
}

const EFFECT_NOTE = `effect takes up to one poll (MANAGED_SESSIONS_POLL_MS = ${MANAGED_SESSIONS_POLL_MS}ms) once a running daemon picks it up; if no daemon is currently running, this takes effect the next time one starts.`;

function parseFlags(rest: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** `argv` is everything AFTER `session` (i.e. `process.argv.slice(3)` when `process.argv[2] === "session"`). Returns the process exit code; never throws. */
export async function runSessionCli(argv: string[], io: SessionCliIo = defaultIo()): Promise<number> {
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
    const entries = await listSessionDefinitions({ dir: io.dir, list: io.list, read: io.read, store: io.freeze.store });
    if (!entries.length) {
      io.stdout(`no session definitions in ${io.dir}`);
      return 0;
    }
    for (const e of entries) for (const line of formatListEntry(e)) io.stdout(line);
    return 0;
  }

  if (sub === "show") {
    const [name] = rest;
    if (!name) {
      io.stderr(`butchr session show: expected exactly one argument\n\n${USAGE}`);
      return 1;
    }
    const result = await showSessionDefinition({ dir: io.dir, list: io.list, read: io.read, store: io.freeze.store }, name);
    if (!result.found) {
      io.stderr(`butchr session show: no definition named ${JSON.stringify(name)} in ${io.dir}`);
      return 1;
    }
    for (const line of formatShowEntry(result.entry)) io.stdout(line);
    return 0;
  }

  if (sub === "create") {
    const [name, ...flagArgs] = rest;
    if (!name) {
      io.stderr(`butchr session create: expected a name\n\n${USAGE}`);
      return 1;
    }
    const { flags } = parseFlags(flagArgs);
    const str = (k: string): string | undefined => { const v = flags.get(k); return typeof v === "string" ? v : undefined; };
    const workingDirectory = str("working-directory");
    const brief = str("brief");
    const vendor = str("vendor");
    const tier = str("tier");
    const permissionMode = str("permission-mode");
    const missing = ["working-directory", "brief", "vendor", "tier", "permission-mode"].filter((k) => str(k) === undefined);
    if (missing.length) {
      io.stderr(`butchr session create: missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}\n\n${USAGE}`);
      return 1;
    }
    let mcpServers: unknown;
    const mcpServersRaw = str("mcp-servers");
    if (mcpServersRaw !== undefined) {
      try {
        mcpServers = JSON.parse(mcpServersRaw);
      } catch (e) {
        io.stderr(`butchr session create: --mcp-servers is not valid JSON: ${(e as Error).message}`);
        return 1;
      }
    }
    const execution = str("execution");
    const account = str("account");
    const role = str("role");
    // Comma-separated, trimmed, empty entries dropped — a bare `--freeze-controllers` with no value
    // (parseFlags would then read it as `true`, not a list) is treated as "flag given, no names",
    // same as an empty string; sessionDefinitionProblems is still what decides if the result is valid.
    const controllerList = (k: string): string[] | undefined => {
      const v = flags.get(k);
      if (v === undefined) return undefined;
      return typeof v === "string" ? v.split(",").map((s) => s.trim()).filter((s) => s !== "") : [];
    };
    const freezeControllers = controllerList("freeze-controllers");
    const unfreezeControllers = controllerList("unfreeze-controllers");
    const result = await createSessionDefinition({ dir: io.dir, exists: io.exists, write: io.write }, name, {
      workingDirectory: workingDirectory!, brief: brief!, vendor: vendor!, tier: tier!, permissionMode: permissionMode!,
      ...(execution !== undefined ? { execution } : {}),
      ...(account !== undefined ? { account } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(flags.has("frozen") ? { frozen: true } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(freezeControllers !== undefined ? { freezeControllers } : {}),
      ...(unfreezeControllers !== undefined ? { unfreezeControllers } : {}),
    });
    if (!result.ok) {
      io.stderr(`butchr session create: ${result.error}`);
      return 1;
    }
    io.stdout(`created ${result.path}`);
    return 0;
  }

  if (sub === "freeze" || sub === "unfreeze") {
    const [name] = rest;
    if (!name) {
      io.stderr(`butchr session ${sub}: expected exactly one argument\n\n${USAGE}`);
      return 1;
    }
    const entries = await listSessionDefinitions({ dir: io.dir, list: io.list, read: io.read, store: io.freeze.store });
    const entry = entries.find((e) => e.name === name) ?? entries.find((e) => e.name === `${name}.json`);
    if (!entry) {
      io.stderr(`butchr session ${sub}: no definition named ${JSON.stringify(name)} in ${io.dir}`);
      return 1;
    }
    if (!entry.agentKey) {
      io.stderr(`butchr session ${sub}: ${entry.path} has no agent key (its percent-encoded path is too long) — it can never be staffed, so it cannot be frozen/unfrozen either`);
      return 1;
    }
    const gates = sub === "freeze" ? await freezeSessionDefinition(io.freeze, entry.path) : await unfreezeSessionDefinition(io.freeze, entry.path);
    const verb = sub === "freeze" ? "frozen" : "unfrozen";
    io.stdout(`${verb} ${entry.name} (${entry.agentKey}): ${freezeSummary(gates.manifestFrozen, gates.storeFrozen)}`);
    io.stdout(EFFECT_NOTE);
    return 0;
  }

  io.stderr(`butchr session: unknown subcommand ${JSON.stringify(sub)}\n\n${USAGE}`);
  return 1;
}

export { sessionDefinitionsPath };
