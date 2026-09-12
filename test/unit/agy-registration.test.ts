import { expect, test } from "bun:test";
import { bridgeExecutable, inventoryAgyMcp, registrationMatches } from "../../src/mcp/registration.js";

const root = "/tmp/factory";
const executable = "/tmp/dist/butchr-mcp.js";
const bun = "/tmp/bin/bun";
const registration = (entry: unknown) => ({ mcpServers: { butchr: entry } });
const direct = { command: executable, args: ["--workspace-root", root] };

test("AGY registration must target this bridge and workspace root", () => {
  expect(registrationMatches(registration(direct), root, executable, bun)).toBe(true);
  expect(registrationMatches(registration({ ...direct, disabled: false }), root, executable, bun)).toBe(true);
  expect(registrationMatches({ mcpServers: { butchr: direct, personal: { command: "other" } } }, root, executable, bun)).toBe(false);
  expect(registrationMatches({ mcpServers: { butchr: direct, personal: { disabled: true } } }, root, executable, bun)).toBe(true);
  expect(registrationMatches(registration({ command: bun, args: [executable, ...direct.args] }), root, executable, bun)).toBe(true);
  for (const entry of [null, {}, { command: executable }, { args: [] },
    { ...direct, disabled: true }, { ...direct, disabled: "false" },
    { ...direct, url: "http://localhost/mcp" }, { ...direct, serverUrl: "http://localhost" },
    { ...direct, command: "/wrong/bridge" }, { ...direct, args: ["--workspace-root", "/wrong/root"] },
    { ...direct, args: [1] }, { ...direct, args: null }, { ...direct, args: [...direct.args, "--extra"] }]) {
    expect(registrationMatches(registration(entry), root, executable, bun)).toBe(false);
  }
  for (const value of [null, {}, { mcpServers: null }, { mcpServers: {} }]) {
    expect(registrationMatches(value, root, executable, bun)).toBe(false);
  }
  expect(bridgeExecutable()).toEndWith("/butchr/dist/butchr-mcp.js");
});

test("AGY readiness only gates configured AGY launches and redacts failures", () => {
  const logs: string[] = [];
  const log = (s: string) => logs.push(s);
  const unused = { provider: "claude" as const };
  expect(inventoryAgyMcp(unused, log, () => { throw new Error("must not probe"); })).toBe(unused);
  for (const agent of [
    { provider: "agy" as const },
    { provider: "claude" as const, providers: ["claude", "agy"] as ("claude" | "agy")[] },
    { provider: "codex" as const, roleProviders: { task: ["agy" as const] } },
  ]) {
    const blocked = inventoryAgyMcp(agent, log, () => false);
    expect(blocked.agySpawnBlocked).toContain("disabled");
    expect(inventoryAgyMcp(blocked, log, () => true).agySpawnBlocked).toBeUndefined();
    expect(inventoryAgyMcp(agent, log, () => { throw new Error("secret-value"); }).agySpawnBlocked).toBeDefined();
  }
  expect(logs.join("\n")).not.toContain("secret-value");
});
