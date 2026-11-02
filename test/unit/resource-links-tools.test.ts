import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resourceLinkTools } from "../../src/tools/resource-links.js";
import { createLinkStore } from "../../src/resources/link-store.js";
import { Refusal } from "../../src/tools/outcome.js";
import type { ToolDef } from "@brooswit/thatch";

const conn = { headers: {} } as any;

let dir: string;
let tools: Record<string, ToolDef<any>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-resource-links-tools-"));
  tools = resourceLinkTools(createLinkStore(join(dir, "links.json")), () => {});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("list_links", () => {
  test("empty for a resource with no links", async () => {
    const result = await tools.list_links!.handler({ resource: "jira-project:BUTCHR" }, conn);
    expect(result).toEqual({ resource: "jira-project:BUTCHR", links: [] });
  });

  test("reflects an added link, in canonical string form", async () => {
    await tools.add_link!.handler({ resource: "jira-project:BUTCHR", target: "confluence-page:1" }, conn);
    const result = await tools.list_links!.handler({ resource: "jira-project:BUTCHR" }, conn);
    expect(result).toEqual({ resource: "jira-project:BUTCHR", links: ["confluence-page:1"] });
  });

  test("refuses an invalid resource string", async () => {
    await expect(tools.list_links!.handler({ resource: "not-a-ref" }, conn)).rejects.toBeInstanceOf(Refusal);
  });
});

describe("add_link", () => {
  test("adds a link", async () => {
    const result = await tools.add_link!.handler({ resource: "jira-project:BUTCHR", target: "confluence-page:1" }, conn);
    expect(result).toEqual({ added: true });
  });

  test("idempotent: second add reports added:false, not an error", async () => {
    await tools.add_link!.handler({ resource: "jira-project:BUTCHR", target: "confluence-page:1" }, conn);
    const result = await tools.add_link!.handler({ resource: "jira-project:BUTCHR", target: "confluence-page:1" }, conn);
    expect(result).toEqual({ added: false, reason: "already-present" });
  });

  test("refuses a self-link with a Refusal, not a generic error", async () => {
    await expect(tools.add_link!.handler({ resource: "jira-project:BUTCHR", target: "jira-project:butchr" }, conn)).rejects.toBeInstanceOf(Refusal);
  });

  test("refuses an invalid target string", async () => {
    await expect(tools.add_link!.handler({ resource: "jira-project:BUTCHR", target: "nope" }, conn)).rejects.toBeInstanceOf(Refusal);
  });
});

describe("remove_link", () => {
  test("removes a present link", async () => {
    await tools.add_link!.handler({ resource: "jira-project:BUTCHR", target: "confluence-page:1" }, conn);
    const result = await tools.remove_link!.handler({ resource: "jira-project:BUTCHR", target: "confluence-page:1" }, conn);
    expect(result).toEqual({ removed: true });
  });

  test("removing an absent link is a non-destructive no-op, not an error", async () => {
    const result = await tools.remove_link!.handler({ resource: "jira-project:BUTCHR", target: "confluence-page:999" }, conn);
    expect(result).toEqual({ removed: false, reason: "not-present" });
  });
});
