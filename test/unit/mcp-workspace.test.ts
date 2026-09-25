import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bridgeWorkspace } from "../../src/mcp/workspace.js";
import { encodeQueryAgentKey } from "../../src/rules/agent-key.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "butchr-mcp-workspace-"));
  roots.push(root);
  const cwd = join(root, "TEST-1");
  mkdirSync(cwd);
  const metadata = join(cwd, ".butchr-agy.json");
  writeFileSync(metadata, JSON.stringify({ issue: "TEST-1", mcpUrl: "http://127.0.0.1:7717/mcp" }));
  return { root, cwd, metadata };
}

test("bridge uses only the current direct-child workspace identity", () => {
  const { root, cwd } = fixture();
  expect(bridgeWorkspace(root, cwd)).toEqual({ identity: "TEST-1", url: new URL("http://127.0.0.1:7717/mcp") });
  const other = join(root, "TEST-2");
  mkdirSync(other);
  writeFileSync(join(other, ".butchr-agy.json"), JSON.stringify({ issue: "TEST-2", mcpUrl: "https://localhost/mcp" }));
  expect(bridgeWorkspace(root, other).identity).toBe("TEST-2");
  expect(() => bridgeWorkspace(root, root)).toThrow();
  const nested = join(cwd, "nested");
  mkdirSync(nested);
  expect(() => bridgeWorkspace(root, nested)).toThrow();
  const outside = fixture();
  const alias = join(root, "alias");
  symlinkSync(outside.cwd, alias);
  expect(() => bridgeWorkspace(root, alias)).toThrow();
});

test("bridge refuses absent or mismatched identity and invalid endpoints", () => {
  const { root, cwd, metadata } = fixture();
  for (const value of [null, {}, { issue: "TEST-2", mcpUrl: "http://localhost" },
    { issue: "TEST-1", mcpUrl: "file:///tmp/mcp" },
    { issue: "TEST-1", mcpUrl: "http://secret:secret@localhost" },
    { issue: "TEST-1", mcpUrl: 5 }, { issue: "TEST-1", mcpUrl: "not a URL" }]) {
    writeFileSync(metadata, JSON.stringify(value));
    expect(() => bridgeWorkspace(root, cwd)).toThrow();
  }
  writeFileSync(metadata, "not JSON");
  expect(() => bridgeWorkspace(root, cwd)).toThrow();
  rmSync(metadata);
  expect(() => bridgeWorkspace(root, cwd)).toThrow();
});

test("BUTCHR-397: a query-level agent's workspace is recognised as a rule-engine shape (never 'Not a factory workspace'); a per-resource- or key-only-shaped .butchr-agy.json is refused rather than crashing", () => {
  const root = mkdtempSync(join(tmpdir(), "butchr-mcp-workspace-"));
  roots.push(root);
  const key = encodeQueryAgentKey({ resourceProvider: "jira-work", ruleId: "triage" });
  const cwd = join(root, ...key.split(":"));
  mkdirSync(cwd, { recursive: true });
  // A per-resource-shaped file (as an existing jira-work agent would carry) is refused:
  // there is no single `resource`/`issue` for a query-level agent to match.
  writeFileSync(join(cwd, ".butchr-agy.json"), JSON.stringify({ issue: "BUTCHR-12", agent: key, mcpUrl: "http://127.0.0.1:7717/mcp" }));
  expect(() => bridgeWorkspace(root, cwd)).toThrow("Invalid factory workspace identity");

  // A KEY_ONLY provider's OWN per-resource shape (`{agent, resource, mcpUrl}`) is also
  // refused for a query-level agent — it still has no single resource to name.
  const ghKey = encodeQueryAgentKey({ resourceProvider: "github-issue", ruleId: "triage" });
  const ghCwd = join(root, ...ghKey.split(":"));
  mkdirSync(ghCwd, { recursive: true });
  writeFileSync(join(ghCwd, ".butchr-agy.json"), JSON.stringify({ agent: ghKey, resource: "acme/web#42", mcpUrl: "http://127.0.0.1:7717/mcp" }));
  expect(() => bridgeWorkspace(root, ghCwd)).toThrow("Invalid factory workspace identity");
});

test("BUTCHR-398: a query-level agent's OWN defined .butchr-agy.json shape — {agent, mcpUrl}, no issue/resource field — succeeds, for every provider", () => {
  const root = mkdtempSync(join(tmpdir(), "butchr-mcp-workspace-"));
  roots.push(root);
  for (const resourceProvider of ["jira-work", "github-issue", "jira-idea", "zendesk-ticket"] as const) {
    const key = encodeQueryAgentKey({ resourceProvider, ruleId: "triage" });
    const cwd = join(root, ...key.split(":"));
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, ".butchr-agy.json"), JSON.stringify({ agent: key, mcpUrl: "http://127.0.0.1:7717/mcp" }));
    expect(bridgeWorkspace(root, cwd)).toEqual({ url: new URL("http://127.0.0.1:7717/mcp"), agent: key });
  }
});

test("BUTCHR-398: a query-level .butchr-agy.json carrying a stray issue or resource field is refused, never silently accepted", () => {
  const root = mkdtempSync(join(tmpdir(), "butchr-mcp-workspace-"));
  roots.push(root);
  const key = encodeQueryAgentKey({ resourceProvider: "jira-work", ruleId: "triage" });
  const cwd = join(root, ...key.split(":"));
  mkdirSync(cwd, { recursive: true });
  for (const value of [
    { agent: key, issue: "BUTCHR-1", mcpUrl: "http://127.0.0.1:7717/mcp" },
    { agent: key, resource: "BUTCHR-1", mcpUrl: "http://127.0.0.1:7717/mcp" },
    { agent: "jira-work:triage:BUTCHR-1", mcpUrl: "http://127.0.0.1:7717/mcp" }, // wrong agent
    { mcpUrl: "http://127.0.0.1:7717/mcp" }, // missing agent entirely
  ]) {
    writeFileSync(join(cwd, ".butchr-agy.json"), JSON.stringify(value));
    expect(() => bridgeWorkspace(root, cwd)).toThrow("Invalid factory workspace identity");
  }
});

test("bridge entrypoint help and startup errors do not start a daemon or leak metadata", async () => {
  const entry = new URL("../../src/mcp/entry.ts", import.meta.url).pathname;
  for (const args of [["--help"], [], ["--workspace-root", "/nonexistent-private-test-path"]]) {
    const child = Bun.spawn([process.execPath, entry, ...args], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(args[0] === "--help" ? 0 : 1);
    expect(stderr).not.toContain("nonexistent-private-test-path");
    expect(stdout).toBe(args[0] === "--help" ? "Usage: butchr-mcp --workspace-root <factory workspace root>\n" : "");
  }
});
