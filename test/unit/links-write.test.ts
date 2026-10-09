import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLinkAdd, writeLinkRemove, writeLinkUndo, type LastLinksUiWrite, type LinksWriteDeps } from "../../src/resources/links-write.js";
import { jsonFileEtag } from "../../src/resources/write-json-file.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-links-write-"));
  path = join(dir, "links.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deps(over: Partial<LinksWriteDeps> = {}): LinksWriteDeps {
  return { path: () => path, ...over };
}

const emptyFileText = `${JSON.stringify({ v: 1, links: {} }, null, 2)}\n`;

describe("writeLinkAdd", () => {
  test("creates the links file (with a backup of null, since none existed) and adds the entry", async () => {
    const outcome = await writeLinkAdd(deps(), "jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    expect(outcome).toEqual({ ok: true, added: true, backupId: null, etag: expect.any(String) });
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.links["jira-work-item:BUTCHR-1"]).toEqual(["github-issue:owner/repo#1"]);
  });

  test("an invalid resource reference is refused (400) and nothing is written", async () => {
    const outcome = await writeLinkAdd(deps(), "not-a-ref", "github-issue:owner/repo#1");
    expect(outcome).toEqual({ ok: false, status: 400, error: expect.any(String) });
  });

  test("a self-link is refused (400), file unchanged", async () => {
    writeFileSync(path, emptyFileText);
    const outcome = await writeLinkAdd(deps(), "jira-work-item:BUTCHR-1", "jira-work-item:BUTCHR-1");
    expect(outcome).toEqual({ ok: false, status: 400, error: expect.stringContaining("cannot link to itself") });
    expect(readFileSync(path, "utf8")).toBe(emptyFileText);
  });

  test("a jira-project owner is refused (403), file unchanged", async () => {
    writeFileSync(path, emptyFileText);
    const outcome = await writeLinkAdd(deps(), "jira-project:BUTCHR", "github-issue:owner/repo#1");
    expect(outcome).toEqual({ ok: false, status: 403, error: expect.stringContaining("jira-project") });
    expect(readFileSync(path, "utf8")).toBe(emptyFileText);
  });

  test("idempotent: adding an already-present link writes nothing, no backup taken", async () => {
    await writeLinkAdd(deps(), "jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    const afterFirst = readFileSync(path, "utf8");
    const outcome = await writeLinkAdd(deps(), "jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    expect(outcome).toEqual({ ok: true, added: false, reason: "already-present" });
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
  });

  test("a second, different owner's entry is added alongside the first (the whole file is not clobbered)", async () => {
    await writeLinkAdd(deps(), "jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    await writeLinkAdd(deps(), "jira-work-item:BUTCHR-2", "webpage:https://example.com/x");
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.links["jira-work-item:BUTCHR-1"]).toEqual(["github-issue:owner/repo#1"]);
    expect(file.links["jira-work-item:BUTCHR-2"]).toEqual(["webpage:https://example.com/x"]);
  });
});

describe("writeLinkRemove", () => {
  test("removes an existing entry, deleting the owner key once its target list is empty", async () => {
    await writeLinkAdd(deps(), "jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    const outcome = await writeLinkRemove(deps(), "jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    expect(outcome).toEqual({ ok: true, removed: true, backupId: expect.any(String), etag: expect.any(String) });
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.links["jira-work-item:BUTCHR-1"]).toBeUndefined();
  });

  test("idempotent: removing an absent link writes nothing", async () => {
    writeFileSync(path, emptyFileText);
    const outcome = await writeLinkRemove(deps(), "jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    expect(outcome).toEqual({ ok: true, removed: false, reason: "not-present" });
    expect(readFileSync(path, "utf8")).toBe(emptyFileText);
  });

  test("a jira-project owner is refused (403), file unchanged", async () => {
    writeFileSync(path, emptyFileText);
    const outcome = await writeLinkRemove(deps(), "jira-project:BUTCHR", "github-issue:owner/repo#1");
    expect(outcome).toEqual({ ok: false, status: 403, error: expect.stringContaining("jira-project") });
    expect(readFileSync(path, "utf8")).toBe(emptyFileText);
  });
});

describe("writeLinkUndo — byte-for-byte", () => {
  test("end to end: add, then undo, restores the EXACT previous bytes", async () => {
    writeFileSync(path, emptyFileText);
    const lastUiWrite: LastLinksUiWrite = { value: null };
    const d = deps({ lastUiWrite });
    const write = await writeLinkAdd(d, "jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    expect(write.ok).toBe(true);
    if (!write.ok || !("added" in write) || !write.added) throw new Error("expected a completed add");
    expect(readFileSync(path, "utf8")).not.toBe(emptyFileText);

    const undone = writeLinkUndo(d, write.backupId!);
    expect(undone.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(emptyFileText); // byte-for-byte restore
  });

  test("a second undo of the SAME backup id is refused (one-shot)", async () => {
    writeFileSync(path, emptyFileText);
    const lastUiWrite: LastLinksUiWrite = { value: null };
    const d = deps({ lastUiWrite });
    const write = await writeLinkAdd(d, "jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    if (!write.ok || !("added" in write) || !write.added) throw new Error("expected a completed add");
    writeLinkUndo(d, write.backupId!);
    const second = writeLinkUndo(d, write.backupId!);
    expect(second.ok).toBe(false);
  });

  test("undo refuses (and writes nothing) once the file changed since that write", async () => {
    writeFileSync(path, emptyFileText);
    const lastUiWrite: LastLinksUiWrite = { value: null };
    const d = deps({ lastUiWrite });
    const write = await writeLinkAdd(d, "jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    if (!write.ok || !("added" in write) || !write.added) throw new Error("expected a completed add");
    const afterFirstWrite = readFileSync(path, "utf8");
    await writeLinkAdd(d, "jira-work-item:BUTCHR-2", "webpage:https://example.com/x");
    const undone = writeLinkUndo(d, write.backupId!);
    expect(undone.ok).toBe(false);
    expect(readFileSync(path, "utf8")).not.toBe(afterFirstWrite);
  });

  test("an unknown backup id is refused", () => {
    writeFileSync(path, emptyFileText);
    const outcome = writeLinkUndo(deps(), "not-a-real-backup-id");
    expect(outcome.ok).toBe(false);
  });
});

describe("the etag reported after a write matches the file's real on-disk content", () => {
  test("etag is sha256 of the written bytes", async () => {
    const outcome = await writeLinkAdd(deps(), "jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    if (!outcome.ok || !("added" in outcome) || !outcome.added) throw new Error("expected a completed add");
    expect(outcome.etag).toBe(jsonFileEtag(path));
  });
});
