import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLinkCli, type LinkCliIo } from "../../src/cli/link-cli.js";
import { createLinkStore } from "../../src/resources/link-store.js";

let dir: string;
let file: string;
let io: LinkCliIo;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-link-cli-"));
  file = join(dir, "links.json");
  out = [];
  err = [];
  io = { store: createLinkStore(file), stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("usage / help", () => {
  test("no subcommand: usage to stderr, exit 1", async () => {
    expect(await runLinkCli([], io)).toBe(1);
    expect(err.join("\n")).toMatch(/usage: butchr link/);
    expect(out).toEqual([]);
  });

  test("--help: usage to stdout, exit 0", async () => {
    expect(await runLinkCli(["--help"], io)).toBe(0);
    expect(out.join("\n")).toMatch(/usage: butchr link/);
  });

  test("unknown subcommand: error + usage to stderr, exit 1", async () => {
    expect(await runLinkCli(["bogus"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/unknown subcommand/);
  });
});

describe("list", () => {
  test("wrong argument count is an error, exit 1", async () => {
    expect(await runLinkCli(["list"], io)).toBe(1);
    expect(await runLinkCli(["list", "a", "b"], io)).toBe(1);
  });

  test("no links: a friendly message, exit 0", async () => {
    expect(await runLinkCli(["list", "jira-project:BUTCHR"], io)).toBe(0);
    expect(out).toEqual(["no links for jira-project:BUTCHR"]);
  });

  test("prints each linked target on its own line", async () => {
    await runLinkCli(["add", "jira-project:BUTCHR", "confluence-page:1"], io);
    out.length = 0;
    expect(await runLinkCli(["list", "jira-project:BUTCHR"], io)).toBe(0);
    expect(out).toEqual(["confluence-page:1"]);
  });

  test("an invalid resource argument is a clear error, exit 1", async () => {
    expect(await runLinkCli(["list", "not-a-ref"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/invalid resource:/);
  });
});

describe("add", () => {
  test("adding a new link succeeds, exit 0", async () => {
    expect(await runLinkCli(["add", "jira-project:BUTCHR", "confluence-page:1"], io)).toBe(0);
    expect(out).toEqual(["added confluence-page:1 to jira-project:BUTCHR"]);
  });

  test("idempotent: adding the same link again is still exit 0, reported as already-linked", async () => {
    await runLinkCli(["add", "jira-project:BUTCHR", "confluence-page:1"], io);
    out.length = 0;
    expect(await runLinkCli(["add", "jira-project:BUTCHR", "confluence-page:1"], io)).toBe(0);
    expect(out).toEqual(["confluence-page:1 is already linked to jira-project:BUTCHR"]);
  });

  test("a self-link is refused: exit 1, no link recorded", async () => {
    expect(await runLinkCli(["add", "jira-project:BUTCHR", "jira-project:butchr"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/cannot link to itself/);
    out.length = 0;
    await runLinkCli(["list", "jira-project:BUTCHR"], io);
    expect(out).toEqual(["no links for jira-project:BUTCHR"]);
  });

  test("wrong argument count is an error, exit 1", async () => {
    expect(await runLinkCli(["add", "jira-project:BUTCHR"], io)).toBe(1);
  });
});

describe("remove", () => {
  test("removing a present link succeeds, exit 0", async () => {
    await runLinkCli(["add", "jira-project:BUTCHR", "confluence-page:1"], io);
    out.length = 0;
    expect(await runLinkCli(["remove", "jira-project:BUTCHR", "confluence-page:1"], io)).toBe(0);
    expect(out).toEqual(["removed confluence-page:1 from jira-project:BUTCHR"]);
  });

  test("removing an absent link is still exit 0 — non-destructive, not an error", async () => {
    expect(await runLinkCli(["remove", "jira-project:BUTCHR", "confluence-page:999"], io)).toBe(0);
    expect(out).toEqual(["confluence-page:999 was not linked to jira-project:BUTCHR"]);
  });
});

describe("store errors: a clean stderr line and exit 1, never an uncaught throw", () => {
  test("a newer-than-supported store version, on list", async () => {
    writeFileSync(file, JSON.stringify({ v: 999, links: {} }));
    await expect(runLinkCli(["list", "jira-project:BUTCHR"], io)).resolves.toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/newer than this build supports/);
  });

  test("a newer-than-supported store version, on add", async () => {
    writeFileSync(file, JSON.stringify({ v: 999, links: {} }));
    await expect(runLinkCli(["add", "jira-project:BUTCHR", "confluence-page:1"], io)).resolves.toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/newer than this build supports/);
  });

  test("a newer-than-supported store version, on remove", async () => {
    writeFileSync(file, JSON.stringify({ v: 999, links: {} }));
    await expect(runLinkCli(["remove", "jira-project:BUTCHR", "confluence-page:1"], io)).resolves.toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/newer than this build supports/);
  });

  test("invalid JSON in the store file", async () => {
    writeFileSync(file, "not json");
    await expect(runLinkCli(["list", "jira-project:BUTCHR"], io)).resolves.toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/not valid JSON/);
  });
});
