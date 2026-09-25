/**
 * FACTORY-7: provider-agnostic persistence for the butchr-MANAGED link
 * collection, plus the `list_links`/`add_link`/`remove_link` core operations
 * built on top of it (`src/tools/resource-links.ts` and `src/cli/link-cli.ts`
 * are both thin wrappers around the three exported functions at the bottom
 * of this file — neither reimplements this logic).
 *
 * PERSISTENCE DECISION: a single JSON file, `{ v: 1, links: {
 * "<ownerCanonicalKey>": ["<targetCanonicalKey>", ...] } }`, under the
 * daemon's own workspace root (`defaultLinksStorePath`, mirroring how
 * `src/agents/capture-store.ts` locates its own directory) — explicitly NOT
 * a Jira project property: that persistence is `jira-project`-specific and
 * belongs to FACTORY-5 (`brooswit.butchr.links`), which this story does not
 * implement. This store is what FACTORY-5's own tests and any non-Jira
 * resource fall back to; it is a real, provider-agnostic implementation of
 * `LinkStore`, not a stub — a `jira-project` resource just isn't required to
 * use it once FACTORY-5 lands a project-property-backed `LinkStore`.
 *
 * `LinkStore`'s methods are `Promise`-returning even though THIS
 * implementation is synchronous underneath, specifically so a future
 * network-backed implementation (e.g. FACTORY-5's Jira REST project
 * property) can satisfy the same interface without a breaking signature
 * change — `list_links`/`add_link`/`remove_link` below, and every caller of
 * them, already await it.
 *
 * VERSION DECISION: `v` refuses to load a version NEWER than this build
 * understands (see `readFile` below) rather than guessing — a newer version
 * may have changed what a stored entry MEANS, not merely added a field, and
 * silently reading it as v1 risks an older writer corrupting a newer store
 * on its very next write-back. A version this build DOES understand (today,
 * only `1`) is trusted fully.
 *
 * UNKNOWN-PROVIDER DECISION: preserve-and-ignore, achieved structurally
 * rather than by special-casing. Owner keys and target strings are stored
 * and round-tripped as PLAIN STRINGS at this layer — never parsed into a
 * `ResourceRef` except by the specific owner/target a caller names in one
 * `list`/`add`/`remove` call. A string this build's `resource-ref.ts` can't
 * parse (a future provider a newer writer already understands, or plain
 * corruption) is therefore left untouched by any operation that doesn't
 * target it, and is silently omitted (not deleted) from `listLinks`'s
 * returned array — see that function below.
 *
 * ATOMIC WRITE: a temp-file-then-rename, unlike `capture-store.ts`'s plain
 * `writeFileSync` — deliberate, because this file is the one durable source
 * of truth for a resource's links (a capture is disposable; this isn't), and
 * a daemon (MCP `add_link`/`remove_link`) and an operator's CLI can both
 * write it. NAMED LIMITATION: this prevents a crash mid-write from
 * corrupting the file into invalid JSON; it does NOT solve a concurrent
 * read-modify-write race (two callers both read before either writes — the
 * second write wins, the first's change is lost). Judged acceptable for a
 * store this rarely and lightly written to; a real multi-writer lock is out
 * of scope for this story.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { workspaceRoot } from "../agents/workspace.js";
import { canonicalKey, tryParseResourceRef, type ResourceRef } from "./resource-ref.js";

export const LINKS_STORE_VERSION = 1;

export function defaultLinksStorePath(): string {
  return process.env.BUTCHR_LINKS_STORE_FILE?.trim() || join(workspaceRoot(), ".links.json");
}

interface LinksFile {
  v: number;
  links: Record<string, string[]>;
}

function emptyFile(): LinksFile {
  return { v: LINKS_STORE_VERSION, links: {} };
}

function readFile(path: string): LinksFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`links store ${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`links store ${path} is malformed: expected a JSON object`);
  const { v, links } = parsed as Record<string, unknown>;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`links store ${path} has a missing or invalid "v" field: ${JSON.stringify(v)}`);
  if (v > LINKS_STORE_VERSION) {
    throw new Error(
      `links store ${path} is version ${v}, newer than this build supports (max ${LINKS_STORE_VERSION}) — refusing to load it to avoid corrupting it; upgrade butchr before touching this store`,
    );
  }
  if (!links || typeof links !== "object" || Array.isArray(links)) throw new Error(`links store ${path} is malformed: "links" must be an object`);
  const out: Record<string, string[]> = {};
  for (const [owner, targets] of Object.entries(links as Record<string, unknown>)) {
    if (!Array.isArray(targets) || !targets.every((t) => typeof t === "string")) {
      throw new Error(`links store ${path} is malformed: links[${JSON.stringify(owner)}] must be an array of strings`);
    }
    out[owner] = targets as string[];
  }
  return { v, links: out };
}

function writeFile(path: string, file: LinksFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
}

/** The raw, string-keyed persistence layer — never parses a `ResourceRef` itself; see this module's header for why. */
export interface LinkStore {
  list(ownerKey: string): Promise<string[]>;
  /** Returns `true` if `targetKey` was newly added, `false` if it was already present (no-op). */
  add(ownerKey: string, targetKey: string): Promise<boolean>;
  /** Returns `true` if `targetKey` was removed, `false` if it was not present (no-op). */
  remove(ownerKey: string, targetKey: string): Promise<boolean>;
}

export function createLinkStore(path: string): LinkStore {
  return {
    async list(ownerKey) {
      return readFile(path).links[ownerKey] ?? [];
    },
    async add(ownerKey, targetKey) {
      const file = readFile(path);
      const existing = file.links[ownerKey] ?? [];
      if (existing.includes(targetKey)) return false;
      file.links[ownerKey] = [...existing, targetKey];
      writeFile(path, file);
      return true;
    },
    async remove(ownerKey, targetKey) {
      const file = readFile(path);
      const existing = file.links[ownerKey] ?? [];
      if (!existing.includes(targetKey)) return false;
      const next = existing.filter((t) => t !== targetKey);
      if (next.length) file.links[ownerKey] = next;
      else delete file.links[ownerKey];
      writeFile(path, file);
      return true;
    },
  };
}

export type AddLinkResult = { ok: true; added: true } | { ok: true; added: false; reason: "already-present" } | { ok: false; error: string };
export type RemoveLinkResult = { ok: true; removed: true } | { ok: true; removed: false; reason: "not-present" };

/**
 * The butchr-MANAGED links only — see `src/resources/managed-links.ts` for
 * why this deliberately is NOT a merge with provider-native links (no
 * provider adapter exists yet to supply them). An entry this build cannot
 * parse is silently omitted here but left untouched on disk — see this
 * module's header.
 */
export async function listLinks(store: LinkStore, resource: ResourceRef): Promise<ResourceRef[]> {
  const raw = await store.list(canonicalKey(resource));
  const out: ResourceRef[] = [];
  for (const s of raw) {
    const parsed = tryParseResourceRef(s);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Idempotent: adding an already-present link is a no-op, reported as such
 * via `added: false`, never an error. Self-links are refused (`ok: false`) —
 * a resource may not link to itself, decided in `docs/resource-links.md`.
 */
export async function addLink(store: LinkStore, resource: ResourceRef, target: ResourceRef): Promise<AddLinkResult> {
  const ownerKey = canonicalKey(resource);
  const targetKey = canonicalKey(target);
  if (ownerKey === targetKey) return { ok: false, error: `a resource cannot link to itself (${ownerKey})` };
  const added = await store.add(ownerKey, targetKey);
  return added ? { ok: true, added: true } : { ok: true, added: false, reason: "already-present" };
}

/** Removing an absent link is a non-destructive no-op, reported via `removed: false`, never an error. */
export async function removeLink(store: LinkStore, resource: ResourceRef, target: ResourceRef): Promise<RemoveLinkResult> {
  const ownerKey = canonicalKey(resource);
  const targetKey = canonicalKey(target);
  const removed = await store.remove(ownerKey, targetKey);
  return removed ? { ok: true, removed: true } : { ok: true, removed: false, reason: "not-present" };
}
