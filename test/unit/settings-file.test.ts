import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SETTINGS_ALLOWLIST,
  MAX_AGENTS_CEILING,
  POLL_STALE_MS_FLOOR,
  effectiveSettingsEnv,
  isAllowlistedSettingsKey,
  loadSettingsFile,
  settingsFilePath,
  validateSettingValue,
  type SettingsFileEnv,
} from "../../src/settings/settings-file.js";
import { SETTINGS_DEFINITIONS } from "../../src/web/settings-api.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-settings-file-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(): SettingsFileEnv {
  return { XDG_CONFIG_HOME: dir };
}

function filePath(): string {
  return join(dir, "butchr", "settings.json");
}

function writeFile(contents: string, mode = 0o600): void {
  mkdirSync(join(dir, "butchr"), { recursive: true, mode: 0o700 });
  writeFileSync(filePath(), contents, { mode });
}

describe("SETTINGS_ALLOWLIST", () => {
  test("every allowlisted key is also in the read-only SETTINGS_DEFINITIONS catalogue", () => {
    const known = new Set(SETTINGS_DEFINITIONS.map((d) => d.key));
    for (const def of SETTINGS_ALLOWLIST) expect(known.has(def.key)).toBe(true);
  });

  test("never allowlists a secret-shaped, path, URL, identity, port, or rules-file key", () => {
    const forbidden = /TOKEN|SECRET|PASSWORD|KEY|_FILE$|_DIR$|URL|PORT|ROOM|MENTION|ACCOUNTID|ASSIGNEE/i;
    for (const def of SETTINGS_ALLOWLIST) expect(def.key).not.toMatch(forbidden);
  });

  test("isAllowlistedSettingsKey agrees with the list", () => {
    expect(isAllowlistedSettingsKey("BUTCHR_MAX_AGENTS")).toBe(true);
    expect(isAllowlistedSettingsKey("ATLASSIAN_TOKEN")).toBe(false);
    expect(isAllowlistedSettingsKey("BUTCHR_PORT")).toBe(false);
    expect(isAllowlistedSettingsKey("not-a-real-key")).toBe(false);
  });
});

describe("validateSettingValue", () => {
  test("rejects a non-allowlisted key", () => {
    expect(validateSettingValue("BUTCHR_PORT", "7717").ok).toBe(false);
  });

  test("BUTCHR_AGENT_PROVIDER: accepts claude/codex/agy, rejects anything else", () => {
    expect(validateSettingValue("BUTCHR_AGENT_PROVIDER", "codex")).toEqual({ ok: true, normalized: "codex" });
    expect(validateSettingValue("BUTCHR_AGENT_PROVIDER", "gpt").ok).toBe(false);
  });

  test("BUTCHR_AGENT_PROVIDERS: ordered distinct list, rejects a duplicate or unknown entry", () => {
    expect(validateSettingValue("BUTCHR_AGENT_PROVIDERS", "claude,codex")).toEqual({ ok: true, normalized: "claude,codex" });
    expect(validateSettingValue("BUTCHR_AGENT_PROVIDERS", "claude,claude").ok).toBe(false);
    expect(validateSettingValue("BUTCHR_AGENT_PROVIDERS", "claude,gpt").ok).toBe(false);
  });

  test("BUTCHR_AGENT_MODEL: any non-empty string", () => {
    expect(validateSettingValue("BUTCHR_AGENT_MODEL", "claude-fable-5")).toEqual({ ok: true, normalized: "claude-fable-5" });
    expect(validateSettingValue("BUTCHR_AGENT_MODEL", "   ").ok).toBe(false);
  });

  test("BUTCHR_MAX_AGENTS: positive integer, non-integer/zero/negative refused", () => {
    expect(validateSettingValue("BUTCHR_MAX_AGENTS", "12")).toEqual({ ok: true, normalized: "12" });
    expect(validateSettingValue("BUTCHR_MAX_AGENTS", "0").ok).toBe(false);
    expect(validateSettingValue("BUTCHR_MAX_AGENTS", "-3").ok).toBe(false);
    expect(validateSettingValue("BUTCHR_MAX_AGENTS", "3.5").ok).toBe(false);
    expect(validateSettingValue("BUTCHR_MAX_AGENTS", "abc").ok).toBe(false);
  });

  test("BUTCHR_MAX_AGENTS: above the ceiling needs confirm", () => {
    const over = String(MAX_AGENTS_CEILING + 1);
    const refused = validateSettingValue("BUTCHR_MAX_AGENTS", over);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.needsConfirm).toBe(true);
    expect(validateSettingValue("BUTCHR_MAX_AGENTS", over, true)).toEqual({ ok: true, normalized: over });
    // at the ceiling exactly: no confirm needed
    expect(validateSettingValue("BUTCHR_MAX_AGENTS", String(MAX_AGENTS_CEILING))).toEqual({ ok: true, normalized: String(MAX_AGENTS_CEILING) });
  });

  test("BUTCHR_POLL_STALE_MS: floor refused outright, confirm does not bypass it", () => {
    const under = String(POLL_STALE_MS_FLOOR - 1);
    expect(validateSettingValue("BUTCHR_POLL_STALE_MS", under).ok).toBe(false);
    expect(validateSettingValue("BUTCHR_POLL_STALE_MS", under, true).ok).toBe(false);
    expect(validateSettingValue("BUTCHR_POLL_STALE_MS", String(POLL_STALE_MS_FLOOR))).toEqual({ ok: true, normalized: String(POLL_STALE_MS_FLOOR) });
  });
});

describe("settingsFilePath", () => {
  test("XDG_CONFIG_HOME override, then BUTCHR_SETTINGS_FILE override", () => {
    expect(settingsFilePath({ XDG_CONFIG_HOME: "/x" })).toBe(join("/x", "butchr", "settings.json"));
    expect(settingsFilePath({ XDG_CONFIG_HOME: "/x", BUTCHR_SETTINGS_FILE: "/y/settings.json" })).toBe("/y/settings.json");
  });
});

describe("loadSettingsFile", () => {
  test("absent file: no values, no problems", () => {
    const result = loadSettingsFile(env());
    expect(result.values).toEqual({});
    expect(result.problems).toEqual([]);
  });

  test("valid file: every allowlisted key present", () => {
    writeFile(JSON.stringify({ BUTCHR_MAX_AGENTS: "12", BUTCHR_AGENT_PROVIDER: "codex" }));
    const result = loadSettingsFile(env());
    expect(result.values).toEqual({ BUTCHR_MAX_AGENTS: "12", BUTCHR_AGENT_PROVIDER: "codex" });
    expect(result.problems).toEqual([]);
  });

  test("invalid JSON: whole file refused, every key unset", () => {
    writeFile("{not json");
    const result = loadSettingsFile(env());
    expect(result.values).toEqual({});
    expect(result.problems.length).toBe(1);
    expect(result.problems[0]).toMatch(/invalid JSON/);
  });

  test("a non-object document: refused", () => {
    writeFile(JSON.stringify(["not", "an", "object"]));
    const result = loadSettingsFile(env());
    expect(result.values).toEqual({});
    expect(result.problems[0]).toMatch(/expected a JSON object/);
  });

  test("a symlinked settings.json: refused, never followed", () => {
    mkdirSync(join(dir, "butchr"), { recursive: true, mode: 0o700 });
    const real = join(dir, "real-settings.json");
    writeFileSync(real, JSON.stringify({ BUTCHR_MAX_AGENTS: "12" }), { mode: 0o600 });
    symlinkSync(real, filePath());
    const result = loadSettingsFile(env());
    expect(result.values).toEqual({});
    expect(result.problems[0]).toMatch(/symlink/);
  });

  test("mode wider than 0600: refused", () => {
    writeFile(JSON.stringify({ BUTCHR_MAX_AGENTS: "12" }), 0o644);
    const result = loadSettingsFile(env());
    expect(result.values).toEqual({});
    expect(result.problems[0]).toMatch(/mode 644/);
  });

  test("wrong owner (uid mismatch): refused", () => {
    writeFile(JSON.stringify({ BUTCHR_MAX_AGENTS: "12" }));
    const io = {
      readFile: (p: string) => readFileSync(p, "utf8"),
      lstat: (p: string) => lstatSync(p),
      stat: (p: string) => { const s = statSync(p); return { uid: s.uid, mode: s.mode & 0o777 }; },
      ownUid: () => statSync(filePath()).uid + 1,
    };
    const result = loadSettingsFile(env(), io);
    expect(result.values).toEqual({});
    expect(result.problems[0]).toMatch(/not this daemon's own uid/);
  });

  test("a non-allowlisted key in an otherwise valid file: ignored individually, other keys still apply", () => {
    writeFile(JSON.stringify({ BUTCHR_MAX_AGENTS: "12", BUTCHR_PORT: "9999" }));
    const result = loadSettingsFile(env());
    expect(result.values).toEqual({ BUTCHR_MAX_AGENTS: "12" });
    expect(result.problems.length).toBe(1);
    expect(result.problems[0]).toMatch(/BUTCHR_PORT.*not an allowlisted setting/);
  });

  test("an out-of-range value for one key: that key dropped, others still apply", () => {
    writeFile(JSON.stringify({ BUTCHR_MAX_AGENTS: "0", BUTCHR_AGENT_PROVIDER: "codex" }));
    const result = loadSettingsFile(env());
    expect(result.values).toEqual({ BUTCHR_AGENT_PROVIDER: "codex" });
    expect(result.problems.length).toBe(1);
    expect(result.problems[0]).toMatch(/BUTCHR_MAX_AGENTS/);
  });

  test("a non-string value: ignored individually", () => {
    writeFile(JSON.stringify({ BUTCHR_MAX_AGENTS: 12 }));
    const result = loadSettingsFile(env());
    expect(result.values).toEqual({});
    expect(result.problems[0]).toMatch(/must be a string/);
  });
});

describe("effectiveSettingsEnv", () => {
  test("an unset env var falls through to the settings.json value", () => {
    const merged = effectiveSettingsEnv<Record<string, string | undefined>>({ FOO: undefined }, { BUTCHR_MAX_AGENTS: "12" });
    expect(merged.BUTCHR_MAX_AGENTS).toBe("12");
  });

  test("a SET env var always wins, even if settings.json also has the key", () => {
    const merged = effectiveSettingsEnv<Record<string, string | undefined>>({ BUTCHR_MAX_AGENTS: "5" }, { BUTCHR_MAX_AGENTS: "12" });
    expect(merged.BUTCHR_MAX_AGENTS).toBe("5");
  });

  test("an empty-string env var is treated as unset", () => {
    const merged = effectiveSettingsEnv<Record<string, string | undefined>>({ BUTCHR_MAX_AGENTS: "" }, { BUTCHR_MAX_AGENTS: "12" });
    expect(merged.BUTCHR_MAX_AGENTS).toBe("12");
  });

  test("never mutates the input env object", () => {
    const input: Record<string, string | undefined> = { BUTCHR_MAX_AGENTS: undefined };
    const merged = effectiveSettingsEnv(input, { BUTCHR_MAX_AGENTS: "12" });
    expect(input.BUTCHR_MAX_AGENTS).toBeUndefined();
    expect(merged.BUTCHR_MAX_AGENTS).toBe("12");
  });
});
