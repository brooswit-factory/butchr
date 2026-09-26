import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSessionDefinitionFile, effectiveAgent, tierToModel } from "../../src/resources/session-definition.js";

/**
 * BUTCHR-466 (task of story BUTCHR-396, epic BUTCHR-391): the 14 staged
 * managed-session definitions this ticket's runbook (docs/codey-migration-runbook.md)
 * hands to manager-factory-bakr/manager-factory-candlestix to place under
 * their own Codey session-definitions directory. Loaded here through the
 * REAL validator (`parseSessionDefinitionFile`, the same function the
 * daemon's own poll and `butchr session create` both run every manifest
 * through — see docs/managed-sessions.md), so a schema change in
 * src/resources/session-definition.ts that these examples no longer satisfy
 * fails here instead of drifting silently, exactly like
 * test/unit/rules-example.test.ts does for docs/rules.example.json.
 *
 * These are STAGED EXAMPLES, not the live Codey definitions — every
 * `workingDirectory` and MCP `url`/env-var-name below is either sourced from
 * BAKR-63/CNDLX-45's own read-only inventory comments (cited in the runbook)
 * or an explicit placeholder the runbook tells the Codey manager to replace
 * before actually staging. This test only proves the FILES PARSE AND VALIDATE
 * as well-formed definitions — it says nothing about whether a placeholder
 * URL or an unverified working directory is the real one.
 */
const EXAMPLES_DIR = join(import.meta.dir, "..", "..", "docs", "codey-session-definitions.example");
const HOME = "/home/codey-manager";

const EXPECTED_FILES = [
  "admin-brooswit-nexus.json",
  "director-brooswit-factory.json",
  "director-brooswit-minecraft.json",
  "director-brooswit-mud.json",
  "mud-player-aelric.json",
  "mud-player-bressa.json",
  "mud-player-corvin.json",
  "mud-player-della.json",
  "mud-player-edrin.json",
  "mud-player-fenna.json",
  "mud-player-garrick.json",
  "mud-player-hestia.json",
  "mud-player-ivor.json",
  "mud-player-junia.json",
];

const load = (name: string) => parseSessionDefinitionFile(readFileSync(join(EXAMPLES_DIR, name), "utf8"), name, HOME);

describe("docs/codey-session-definitions.example/", () => {
  test("contains exactly the 14 staged definitions this ticket's mapping names, no more, no less", () => {
    const actual = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".json")).sort();
    expect(actual).toEqual([...EXPECTED_FILES].sort());
  });

  test("every staged definition loads cleanly through the real validator", () => {
    for (const name of EXPECTED_FILES) expect(() => load(name)).not.toThrow();
  });

  test("Nexus and the 3 directors: persistent, permanent account, sentinel role, rocketr + atlassian bound", () => {
    for (const name of ["admin-brooswit-nexus.json", "director-brooswit-factory.json", "director-brooswit-minecraft.json", "director-brooswit-mud.json"]) {
      const def = load(name);
      expect(def.execution).toBe("persistent");
      expect(def.account).toBe("permanent");
      expect(def.role).toBe("sentinel");
      expect(def.frozen).toBe(false);
      expect(def.vendor).toBe("claude");
      const names = (def.mcpServers ?? []).map((m) => m.name);
      expect(names).toContain("rocketr");
      expect(names).toContain("atlassian");
      const rocketr = def.mcpServers!.find((m) => m.name === "rocketr")!;
      expect(rocketr.channel).toBe(true);
      expect(rocketr.accountHeader).toBe("x-rocketr-account");
      const atlassian = def.mcpServers!.find((m) => m.name === "atlassian")!;
      expect(atlassian.channel).toBe(false);
    }
  });

  test("BUTCHR-453/S7 landed: the 3 directors claim strict-MCP-config; Nexus (not a director) does not", () => {
    for (const name of ["director-brooswit-factory.json", "director-brooswit-minecraft.json", "director-brooswit-mud.json"]) {
      expect(load(name).strictMcpConfig).toBe(true);
    }
    expect(load("admin-brooswit-nexus.json").strictMcpConfig).toBeUndefined();
  });

  test("no non-director staged definition sets strictMcpConfig, and no vendor:codex definition does (codex has no strict-MCP-config concept — rejected at manifest load)", () => {
    const directors = new Set(["director-brooswit-factory.json", "director-brooswit-minecraft.json", "director-brooswit-mud.json"]);
    for (const name of EXPECTED_FILES) {
      const def = load(name);
      if (directors.has(name)) continue;
      expect(def.strictMcpConfig).toBeUndefined();
      if (def.vendor === "codex") expect(def.strictMcpConfig).toBeUndefined();
    }
  });

  test("the 10 MUD players: frozen persistent, tier1, account none, sentinel role, mud-mcp bound, only director-brooswit-mud may freeze", () => {
    const players = EXPECTED_FILES.filter((f) => f.startsWith("mud-player-"));
    expect(players.length).toBe(10);
    for (const name of players) {
      const def = load(name);
      expect(def.execution).toBe("persistent");
      expect(def.account).toBe("none");
      expect(def.role).toBe("sentinel");
      expect(def.frozen).toBe(true);
      expect(def.tier).toBe("tier1");
      expect(def.vendor).toBe("claude");
      const mcpServers = def.mcpServers ?? [];
      const names = mcpServers.map((m) => m.name);
      expect(names).toEqual(["mud-mcp"]);
      expect(mcpServers[0]?.channel).toBe(true);
      // The old Bakr/Candlestix slot named "yappr" is the mud-mcp bridge itself,
      // never the retired yappr messaging service — must never become rocketr.
      expect(names).not.toContain("rocketr");
      expect(names).not.toContain("yappr");
      expect(def.freezeControllers).toEqual(["director-brooswit-mud"]);
      expect(def.unfreezeControllers ?? []).toEqual([]);
    }
  });

  test("no staged definition carries a Butchr boss/worker RELATIONSHIP field — query-based agents never get one (epic non-goal)", () => {
    // A brief may legitimately WARN the agent never to call report_to_boss/ask_boss/submit_to_boss
    // (query-based agents have no boss) — what must never appear is one of the actual
    // Rule-relationship schema fields (childRule/inwardConnectionRules/Implements), which
    // session-definition.ts's own DEFINITION_FIELDS set doesn't even accept in the first place.
    for (const name of EXPECTED_FILES) {
      const doc = JSON.parse(readFileSync(join(EXAMPLES_DIR, name), "utf8"));
      expect(Object.keys(doc)).not.toContain("childRule");
      expect(Object.keys(doc)).not.toContain("inwardConnectionRules");
      expect(Object.keys(doc)).not.toContain("Implements");
    }
  });

  test("BUTCHR-453/S7 landed: all 3 director definitions now claim strict-MCP-config (field name `strictMcpConfig`, verified against src/resources/session-definition.ts)", () => {
    for (const name of ["director-brooswit-factory.json", "director-brooswit-minecraft.json", "director-brooswit-mud.json"]) {
      const raw = readFileSync(join(EXAMPLES_DIR, name), "utf8");
      expect(raw).toMatch(/"strictMcpConfig"\s*:\s*true/);
    }
  });

  // FACTORY-75 DoD item 3: every one of these 14 staged, tier-based
  // definitions (the closest faithful proxy available for the 8 LIVE codey
  // ones this ticket could not reach directly — see this ticket's own PR
  // description for that gap) resolves to the EXACT SAME model before vs.
  // after this ticket's change: `effectiveAgent`'s tier path bypasses the
  // new modelPower/effort tables entirely and calls the pre-existing
  // `tierToModel` directly (see that function's own doc comment).
  test("FACTORY-75: every staged definition's resolved model is UNCHANGED by this ticket — effectiveAgent(def).model === tierToModel(vendor, tier) for all 14", () => {
    for (const name of EXPECTED_FILES) {
      const def = load(name);
      expect(def.tier).toBeDefined(); // every staged example still uses the deprecated field — none has been migrated.
      const resolved = effectiveAgent(def);
      expect(resolved.model).toBe(tierToModel(def.vendor, def.tier!));
      expect(resolved.effort).toBeUndefined(); // tier path never carries an effort override — see effectiveAgent's own doc comment.
    }
  });
});
