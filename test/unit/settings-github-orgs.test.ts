/**
 * local/ui — `BUTCHR_GITHUB_ORGS` as an allowlisted settings.json key: its
 * validator, and that a saved value really reaches `loadConfig` (the env
 * still wins). Temp directories only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveSettingsEnv, isAllowlistedSettingsKey, loadSettingsFile, validateSettingValue } from "../../src/settings/settings-file.js";
import { SettingProvidedByEnvironmentError, writeSetting } from "../../src/settings/write-settings.js";
import { resolveEffectiveGithubEnv } from "../../src/config/effective-env.js";
import { loadConfig } from "../../src/config/config.js";
import { buildSettingEntries } from "../../src/web/settings-api.js";

describe("BUTCHR_GITHUB_ORGS validation", () => {
  test("accepts and normalizes a comma-separated list", () => {
    expect(isAllowlistedSettingsKey("BUTCHR_GITHUB_ORGS")).toBe(true);
    expect(validateSettingValue("BUTCHR_GITHUB_ORGS", " example-org , another-org ")).toEqual({ ok: true, normalized: "example-org,another-org" });
    expect(validateSettingValue("BUTCHR_GITHUB_ORGS", "a".repeat(39))).toMatchObject({ ok: true });
  });

  test.each([
    ["", "must not be empty"],
    ["-leading", "organization names"],
    ["has space", "organization names"],
    ["a,,b", "organization names"],
    ["a".repeat(40), "organization names"],
    ["dot.ted", "organization names"],
    [Array.from({ length: 21 }, (_, i) => `org${i}`).join(","), "at most 20"],
    ["Acme,acme", "twice"],
  ])("refuses %j", (value, message) => {
    const r = validateSettingValue("BUTCHR_GITHUB_ORGS", value);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain(message);
  });
});

describe("BUTCHR_GITHUB_ORGS through settings.json", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "butchr-orgs-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function seedSettings(values: Record<string, string>) {
    mkdirSync(join(dir, "butchr"), { recursive: true });
    writeFileSync(join(dir, "butchr", "settings.json"), JSON.stringify(values), { mode: 0o600 });
  }

  const baseEnv = () => ({ XDG_CONFIG_HOME: dir, ATLASSIAN_SITE: "https://x.atlassian.net", ATLASSIAN_EMAIL: "a@b.c", ATLASSIAN_TOKEN: "atl" });
  const managedToken = () => join(dir, "butchr", "secrets", "github-token");

  test("a saved value plus the managed GitHub token turns the GitHub integration on at the next start", () => {
    seedSettings({ BUTCHR_GITHUB_ORGS: "acme,octocat" });
    const fromFile = loadSettingsFile(baseEnv());
    expect(fromFile).toEqual({ values: { BUTCHR_GITHUB_ORGS: "acme,octocat" }, problems: [] });
    const env = resolveEffectiveGithubEnv(effectiveSettingsEnv(baseEnv() as Record<string, string | undefined>, fromFile.values), { managedTokenFileExists: (p) => p === managedToken() });
    const config = loadConfig(env as never, (p) => (p === managedToken() ? "ghp_x\n" : "unused"));
    expect(config.github).toEqual({ token: "ghp_x", orgs: ["acme", "octocat"] });
  });

  test("the environment wins over settings.json, and the write route says so", () => {
    seedSettings({ BUTCHR_GITHUB_ORGS: "fromfile" });
    const env = { ...baseEnv(), BUTCHR_GITHUB_ORGS: "fromenv" };
    expect(effectiveSettingsEnv(env as Record<string, string | undefined>, loadSettingsFile(env).values).BUTCHR_GITHUB_ORGS).toBe("fromenv");
    expect(() => writeSetting("BUTCHR_GITHUB_ORGS", "acme", false, env)).toThrow(SettingProvidedByEnvironmentError);
  });

  test("writeSetting saves it at 0600, and the Settings catalogue shows it as an editable file-sourced value", () => {
    writeSetting("BUTCHR_GITHUB_ORGS", " acme ", false, baseEnv());
    const values = loadSettingsFile(baseEnv()).values;
    expect(values).toEqual({ BUTCHR_GITHUB_ORGS: "acme" });
    const entry = buildSettingEntries(effectiveSettingsEnv(baseEnv() as Record<string, string | undefined>, values), baseEnv(), values).find((e) => e.key === "BUTCHR_GITHUB_ORGS");
    expect(entry).toMatchObject({ secret: false, value: "acme", source: "file", editable: true });
  });
});
