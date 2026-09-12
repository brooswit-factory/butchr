import { expect, test } from "bun:test";
import { loadConfig } from "../../src/config/config.js";
import { inventoryCodexMcp, providerOrder } from "../../src/agents/argv.js";

const base = { ATLASSIAN_SITE: "https://example.atlassian.net", ATLASSIAN_EMAIL: "test@example.com", ATLASSIAN_TOKEN: "test" };
const noRead = () => "";

test("role preferences override the default ordered providers", () => {
  const config = loadConfig({ ...base, BUTCHR_AGENT_PROVIDERS: "claude, codex", BUTCHR_AGENT_PROVIDERS_PROJECT: "codex,claude" }, noRead);
  expect(providerOrder(config.agent!, "Project")).toEqual(["codex", "claude"]);
  expect(providerOrder(config.agent!, "task")).toEqual(["claude", "codex"]);
  expect(providerOrder(loadConfig(base, noRead).agent!, "story")).toEqual(["claude"]);
});

test("invalid preference lists fail configuration loading", () => {
  for (const value of ["", "claude,", "claude,claude", "unknown"]) {
    expect(() => loadConfig({ ...base, BUTCHR_AGENT_PROVIDERS: value }, noRead)).toThrow("ordered list");
  }
});

test("Codex inventory is prepared even when only a role fallback needs it", () => {
  let probes = 0;
  const result = inventoryCodexMcp({ provider: "claude", roleProviders: { project: ["claude", "codex"] } }, () => {}, () => {
    probes++;
    return { exitCode: 0, stdout: "[]" };
  });
  expect(probes).toBe(1);
  expect(result.disabledMcpServers).toEqual([]);
});
