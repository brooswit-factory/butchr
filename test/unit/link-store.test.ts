import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLink, createLinkStore, listLinks, removeLink, type LinkStore } from "../../src/resources/link-store.js";
import { canonicalKey, parseResourceRef } from "../../src/resources/resource-ref.js";

const ref = (s: string) => parseResourceRef(s);

let dir: string;
let file: string;
let store: LinkStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-link-store-"));
  file = join(dir, "links.json");
  store = createLinkStore(file);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a fresh (non-existent) store", () => {
  test("list_links returns empty, never throws for a missing file", async () => {
    expect(await listLinks(store, ref("jira-project:BUTCHR"))).toEqual([]);
  });
});

describe("add_link", () => {
  test("adds a link and it is then listed", async () => {
    const resource = ref("jira-project:BUTCHR");
    const target = ref("confluence-page:123456");
    const result = await addLink(store, resource, target);
    expect(result).toEqual({ ok: true, added: true });
    expect(await listLinks(store, resource)).toEqual([target]);
  });

  test("idempotent: adding the same link twice is a no-op the second time, reported as such", async () => {
    const resource = ref("jira-project:BUTCHR");
    const target = ref("confluence-page:123456");
    await addLink(store, resource, target);
    const second = await addLink(store, resource, target);
    expect(second).toEqual({ ok: true, added: false, reason: "already-present" });
    expect(await listLinks(store, resource)).toEqual([target]);
  });

  test("idempotency is by CANONICAL key, not by exact input spelling", async () => {
    const resource = ref("jira-project:BUTCHR");
    await addLink(store, resource, ref("jira-work-item:butchr-1"));
    const second = await addLink(store, resource, ref("jira-work-item:BUTCHR-1"));
    expect(second.ok && !second.added).toBe(true);
  });

  test("a resource may not link to itself — refused, not silently accepted", async () => {
    const resource = ref("jira-project:BUTCHR");
    const result = await addLink(store, resource, ref("jira-project:butchr"));
    expect(result.ok).toBe(false);
    expect(await listLinks(store, resource)).toEqual([]);
  });

  test("persists across a fresh LinkStore instance over the same file", async () => {
    const resource = ref("jira-project:BUTCHR");
    const target = ref("confluence-page:1");
    await addLink(store, resource, target);
    const reopened = createLinkStore(file);
    expect(await listLinks(reopened, resource)).toEqual([target]);
  });
});

describe("remove_link", () => {
  test("removes a present link", async () => {
    const resource = ref("jira-project:BUTCHR");
    const target = ref("confluence-page:1");
    await addLink(store, resource, target);
    const result = await removeLink(store, resource, target);
    expect(result).toEqual({ ok: true, removed: true });
    expect(await listLinks(store, resource)).toEqual([]);
  });

  test("removing an absent link is a clear, non-destructive no-op — never an error", async () => {
    const resource = ref("jira-project:BUTCHR");
    const result = await removeLink(store, resource, ref("confluence-page:999"));
    expect(result).toEqual({ ok: true, removed: false, reason: "not-present" });
  });

  test("removing one of several links leaves the others intact", async () => {
    const resource = ref("jira-project:BUTCHR");
    const a = ref("confluence-page:1");
    const b = ref("confluence-page:2");
    await addLink(store, resource, a);
    await addLink(store, resource, b);
    await removeLink(store, resource, a);
    expect(await listLinks(store, resource)).toEqual([b]);
  });
});

describe("version handling", () => {
  test("refuses to load a store whose version is newer than this build supports", async () => {
    writeFileSync(file, JSON.stringify({ v: 999, links: {} }));
    await expect(listLinks(store, ref("jira-project:BUTCHR"))).rejects.toThrow(/newer than this build supports/);
  });

  test("refuses a missing or invalid version field", async () => {
    writeFileSync(file, JSON.stringify({ links: {} }));
    await expect(listLinks(store, ref("jira-project:BUTCHR"))).rejects.toThrow(/invalid "v" field/);
  });

  test("refuses malformed JSON", async () => {
    writeFileSync(file, "not json");
    await expect(listLinks(store, ref("jira-project:BUTCHR"))).rejects.toThrow(/not valid JSON/);
  });
});

describe("unknown-provider entries: preserve-and-ignore", () => {
  test("an unparseable stored target is omitted from list_links but left on disk untouched", async () => {
    const resource = ref("jira-project:BUTCHR");
    writeFileSync(file, JSON.stringify({ v: 1, links: { [canonicalKey(resource)]: ["zendesk-ticket:acme#1", "confluence-page:5"] } }));
    const links = await listLinks(store, resource);
    expect(links).toEqual([ref("confluence-page:5")]);
    // still on disk, byte for byte, for the owner key this call didn't touch:
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.links["jira-project:BUTCHR"]).toEqual(["zendesk-ticket:acme#1", "confluence-page:5"]);
  });

  test("adding a link for a DIFFERENT resource never disturbs another resource's unrecognised entries", async () => {
    writeFileSync(file, JSON.stringify({ v: 1, links: { "jira-project:BUTCHR": ["zendesk-ticket:acme#1"] } }));
    await addLink(store, ref("jira-project:FACTORY"), ref("confluence-page:1"));
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.links["jira-project:BUTCHR"]).toEqual(["zendesk-ticket:acme#1"]);
  });
});
