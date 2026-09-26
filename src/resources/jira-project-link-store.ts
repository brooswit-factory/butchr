/**
 * FACTORY-5 (implementing FACTORY-4/FACTORY-3): a `LinkStore` (the interface
 * `src/resources/link-store.ts` defines and FACTORY-7 shipped a file-backed
 * implementation of) backed instead by the Jira project entity property
 * `brooswit.butchr.links` — one project's own managed links, persisted where
 * the project itself lives rather than in this daemon's local workspace.
 *
 * WHY A SEPARATE PROPERTY FROM `butchr`: `src/resources/project.ts`'s
 * `butchr` property is this daemon's own wake-watermark bookkeeping for the
 * PROJECT TIER, already close to its own size ceiling (see that module's
 * `PROJECT_PROPERTY_SIZE_CEILING_BYTES` discussion) and owned by a different
 * concern entirely. A managed link is operator/agent-facing state, not
 * watermark state, and mixing the two would mean a link-heavy project could
 * starve its own wake bookkeeping of space (or vice versa) for no
 * architectural reason — namespaced under `brooswit.butchr.links` (the
 * `brooswit.` prefix because project-property keys are shared across every
 * app that might read/write this project, not just this daemon) per
 * `docs/resource-links.md`.
 *
 * VALUE SHAPE: `{ v: 1, links: ["<targetCanonicalKey>", ...] }` — a FLAT
 * array, not the file store's `{ v: 1, links: { "<ownerKey>": [...] } }`
 * map. Deliberate: a project property is already scoped to exactly one
 * project by the Jira API call that reads/writes it (`projectKey` is an
 * argument, not data inside the value), so there is exactly one owner this
 * value could ever describe — a map keyed by an owner that never varies
 * would just be a wrapper with one entry. `list`/`add`/`remove` below still
 * take the full canonical `ownerKey` (e.g. `"jira-project:BUTCHR"`, the SAME
 * string `src/resources/link-store.ts`'s `listLinks`/`addLink`/`removeLink`
 * already pass to any `LinkStore`) so this implementation satisfies the
 * interface unchanged — it just asserts that key names the SAME project the
 * property call targets (`projectKeyFromOwnerKey` below) rather than storing
 * it.
 *
 * VERSION/UNKNOWN-PROVIDER DISCIPLINE: same rules as `link-store.ts`,
 * restated here because this is a second, independent implementation, not a
 * shared code path. `v` refuses to load a version newer than
 * `JIRA_PROJECT_LINKS_STORE_VERSION` (today `1`) rather than guess — a newer
 * version may have changed what a stored entry MEANS. Target strings are
 * round-tripped as plain strings, never parsed into a `ResourceRef` at this
 * layer (that happens one layer up, in `listLinks`/`addLink`/`removeLink`)
 * — achieved structurally, the same way `link-store.ts` achieves it: this
 * module never inspects a target string's shape, so one this build's
 * `resource-ref.ts` can't parse is preserved byte for byte across an `add`/
 * `remove` of a DIFFERENT target in the same property, never dropped.
 *
 * ATOMICITY / RACE WINDOW, NAMED: `add`/`remove` are a read-modify-write of
 * the FULL property value (`getProjectPropertyOrNull` then
 * `setProjectProperty`, which is a full-value REPLACE — Jira's project
 * property API has no compare-and-swap, no partial update, no ETag/version
 * precondition). Two concurrent callers (two agents, or an agent racing an
 * operator's CLI) can both read the same starting value before either
 * writes; the second write wins and the first caller's change is silently
 * lost. Judged acceptable for the same reason `link-store.ts`'s own,
 * differently-caused race is: a managed-link collection is lightly written
 * to relative to how often it's read. A real fix needs Jira-side optimistic
 * locking this API does not expose; out of scope here, same as there.
 *
 * SIZE CAP: a Jira project entity property value is capped at 32768 bytes
 * (the same ceiling `src/resources/project.ts`'s `PROJECT_PROPERTY_SIZE_CEILING_BYTES`
 * documents and re-derives independently for its own property — restated,
 * not imported, since the two properties are unrelated and this module must
 * not take an accidental dependency on project.ts's internals to enforce
 * its own limit). `add` refuses with a clear, thrown error rather than
 * risking a silent Jira-side rejection or truncation; `remove` can only
 * shrink the value, so it is not checked.
 *
 * PERMISSIONS: MEASURED live by `src/resources/project.ts` (2026-09-01) that
 * this daemon's own credential can WRITE a project entity property it does
 * not lead — gated on Jira's Administer Jira/Projects grant, not on project
 * leadership. That measurement is against the OTHER (`butchr`) property;
 * this module has not independently re-measured `brooswit.butchr.links`
 * specifically (same API, same permission model, so expected to match, but
 * "expected to match" is not "measured" — see this story's PR description
 * for what was actually verified live, if anything, against a scratch
 * project property).
 *
 * MISSING PROPERTY == EMPTY COLLECTION, not an error: `getProjectPropertyOrNull`
 * (not `getProjectProperty`) is used for exactly this reason — a genuine
 * Jira 404 (the property has never been written) resolves `null`, which
 * this module treats as `{ v: 1, links: [] }`. Any OTHER rejection (a
 * missing/wrong project key, a permission failure, a network error) still
 * rejects and propagates to the caller uncaught — see `docs/resource-links.md`
 * Decision 8's file-store analogue for why a store read must not silently
 * swallow a failure it cannot distinguish from "empty".
 */
import type { AtlassianOps } from "../tools/atlassian.js";
import type { LinkStore } from "./link-store.js";
import { tryParseResourceRef } from "./resource-ref.js";

export const JIRA_PROJECT_LINKS_PROPERTY_KEY = "brooswit.butchr.links";
export const JIRA_PROJECT_LINKS_STORE_VERSION = 1;

/**
 * Same stated ceiling as `src/resources/project.ts`'s own
 * `PROJECT_PROPERTY_SIZE_CEILING_BYTES` (see that constant's doc comment for
 * how the number was obtained) — restated independently here rather than
 * imported, since the two properties are unrelated persistence and this
 * module must not take a dependency on project.ts's internals to enforce a
 * limit that happens to share the same platform-wide origin.
 */
const JIRA_PROJECT_LINKS_PROPERTY_SIZE_CEILING_BYTES = 32768;

interface JiraProjectLinksProperty {
  v: number;
  links: string[];
}

function emptyProperty(): JiraProjectLinksProperty {
  return { v: JIRA_PROJECT_LINKS_STORE_VERSION, links: [] };
}

/**
 * `ownerKey` is always the full canonical `"jira-project:<KEY>"` string a
 * caller passed `listLinks`/`addLink`/`removeLink` — those functions never
 * strip the provider prefix before calling a `LinkStore`. Only the routing
 * layer (`src/resources/link-store-router.ts`) is supposed to ever route a
 * `jira-project:` owner here in the first place, so a mismatch means a
 * wiring bug upstream, not a runtime input to handle gracefully.
 */
function projectKeyFromOwnerKey(ownerKey: string): string {
  const ref = tryParseResourceRef(ownerKey);
  if (!ref || ref.provider !== "jira-project") {
    throw new Error(`createJiraProjectLinkStore: ownerKey ${JSON.stringify(ownerKey)} is not a "jira-project:<KEY>" canonical key — this store must only ever be reached via the jira-project routing path`);
  }
  return ref.key;
}

async function readProperty(ops: AtlassianOps, projectKey: string): Promise<JiraProjectLinksProperty> {
  const raw = await ops.getProjectPropertyOrNull(projectKey, JIRA_PROJECT_LINKS_PROPERTY_KEY);
  if (raw === null || raw === undefined) return emptyProperty();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`jira-project ${projectKey}'s "${JIRA_PROJECT_LINKS_PROPERTY_KEY}" property is malformed: expected a JSON object`);
  }
  const { v, links } = raw as Record<string, unknown>;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`jira-project ${projectKey}'s "${JIRA_PROJECT_LINKS_PROPERTY_KEY}" property has a missing or invalid "v" field: ${JSON.stringify(v)}`);
  }
  if (v > JIRA_PROJECT_LINKS_STORE_VERSION) {
    throw new Error(
      `jira-project ${projectKey}'s "${JIRA_PROJECT_LINKS_PROPERTY_KEY}" property is version ${v}, newer than this build supports (max ${JIRA_PROJECT_LINKS_STORE_VERSION}) — refusing to load it to avoid corrupting it; upgrade butchr before touching this project's links`,
    );
  }
  if (!Array.isArray(links) || !links.every((t) => typeof t === "string")) {
    throw new Error(`jira-project ${projectKey}'s "${JIRA_PROJECT_LINKS_PROPERTY_KEY}" property is malformed: "links" must be an array of strings`);
  }
  return { v, links: links as string[] };
}

function assertWithinSizeCeiling(projectKey: string, value: JiraProjectLinksProperty): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > JIRA_PROJECT_LINKS_PROPERTY_SIZE_CEILING_BYTES) {
    throw new Error(
      `jira-project ${projectKey}'s "${JIRA_PROJECT_LINKS_PROPERTY_KEY}" property would serialize to ${bytes} bytes, over the ${JIRA_PROJECT_LINKS_PROPERTY_SIZE_CEILING_BYTES}-byte Jira project-entity-property ceiling — refusing to write rather than risk a silent truncation or rejection.`,
    );
  }
}

export function createJiraProjectLinkStore(ops: AtlassianOps): LinkStore {
  return {
    async list(ownerKey) {
      const projectKey = projectKeyFromOwnerKey(ownerKey);
      return (await readProperty(ops, projectKey)).links;
    },
    async add(ownerKey, targetKey) {
      const projectKey = projectKeyFromOwnerKey(ownerKey);
      const current = await readProperty(ops, projectKey);
      if (current.links.includes(targetKey)) return false;
      const next: JiraProjectLinksProperty = { v: JIRA_PROJECT_LINKS_STORE_VERSION, links: [...current.links, targetKey] };
      assertWithinSizeCeiling(projectKey, next);
      await ops.setProjectProperty(projectKey, JIRA_PROJECT_LINKS_PROPERTY_KEY, next);
      return true;
    },
    async remove(ownerKey, targetKey) {
      const projectKey = projectKeyFromOwnerKey(ownerKey);
      const current = await readProperty(ops, projectKey);
      if (!current.links.includes(targetKey)) return false;
      const next: JiraProjectLinksProperty = { v: JIRA_PROJECT_LINKS_STORE_VERSION, links: current.links.filter((t) => t !== targetKey) };
      await ops.setProjectProperty(projectKey, JIRA_PROJECT_LINKS_PROPERTY_KEY, next);
      return true;
    },
  };
}
