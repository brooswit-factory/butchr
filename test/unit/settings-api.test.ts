import { describe, expect, test } from "bun:test";
import { buildSettingEntries, buildAtlassianTokenFileStatus, isModeTooOpen, redactUrlUserinfo, SETTINGS_DEFINITIONS, SECRET_KEY_RE } from "../../src/web/settings-api.js";

/** FACTORY-694 item 4: every definition that is actually secret, reviewed and hardcoded by hand — NOT derived from `SECRET_KEY_RE` or any other rule. Adding a new `SETTINGS_DEFINITIONS` entry without updating this set (when it should be secret) is caught by the "every definition's secret flag is deliberate" test below. */
const EXPECTED_SECRET_KEYS = new Set([
  "ATLASSIAN_TOKEN",
  "GITHUB_TOKEN_FILE",
  "ROCKETCHAT_ADMIN_TOKEN_FILE",
  "ROCKETCHAT_TOKEN_DIR",
  "BUTCHR_TEAM_ADMIN_ROCKETCHAT_TOKEN_FILE",
]);

describe("buildSettingEntries", () => {
  test("every definition is reported exactly once, in order", () => {
    const entries = buildSettingEntries({});
    expect(entries.map((e) => e.key)).toEqual(SETTINGS_DEFINITIONS.map((d) => d.key));
  });

  test("unset non-secret key: value null, source default", () => {
    const entries = buildSettingEntries({});
    const port = entries.find((e) => e.key === "BUTCHR_PORT")!;
    expect(port.secret).toBe(false);
    if (!port.secret) {
      expect(port.value).toBeNull();
      expect(port.source).toBe("default");
      expect(port.restartNeeded).toBe(true);
    }
  });

  test("set non-secret key: value present, source environment", () => {
    const entries = buildSettingEntries({ BUTCHR_PORT: "7718" });
    const port = entries.find((e) => e.key === "BUTCHR_PORT")!;
    if (!port.secret) expect(port.value).toBe("7718");
    expect(port.source).toBe("environment");
  });

  test("secret-like key NEVER reports a value, even when set — only {set: boolean}", () => {
    const entries = buildSettingEntries({ ATLASSIAN_TOKEN: "super-secret-value" });
    const token = entries.find((e) => e.key === "ATLASSIAN_TOKEN")!;
    expect(token.secret).toBe(true);
    expect(JSON.stringify(token)).not.toContain("super-secret-value");
    if (token.secret) expect(token.set).toBe(true);
    expect("value" in token).toBe(false);
  });

  test("secret-like key unset: {set: false}", () => {
    const entries = buildSettingEntries({});
    const token = entries.find((e) => e.key === "ATLASSIAN_TOKEN")!;
    if (token.secret) expect(token.set).toBe(false);
  });

  test("ATLASSIAN_TOKEN_FILE is never a generic entry (handled separately)", () => {
    const entries = buildSettingEntries({ ATLASSIAN_TOKEN_FILE: "/some/path" });
    expect(entries.some((e) => e.key === "ATLASSIAN_TOKEN_FILE")).toBe(false);
  });

  test("a canary URL with embedded userinfo (scheme://user:pass@host) in a non-secret value is redacted, not returned verbatim", () => {
    const canaryUserinfo = "canary-user:canary-pass-should-never-leak";
    const entries = buildSettingEntries({ ROCKETCHAT_URL: `https://${canaryUserinfo}@chat.example.com/path?x=1` });
    const rc = entries.find((e) => e.key === "ROCKETCHAT_URL")!;
    expect(rc.secret).toBe(false);
    if (!rc.secret) {
      expect(rc.value).not.toContain(canaryUserinfo);
      expect(rc.value).not.toContain("canary-pass");
      expect(rc.value).toBe("https://[redacted]@chat.example.com/path?x=1");
    }
    expect(JSON.stringify(entries)).not.toContain(canaryUserinfo);
  });

  test("the same userinfo redaction applies to ANY non-secret value, not only ROCKETCHAT_URL by name", () => {
    const entries = buildSettingEntries({ ATLASSIAN_SITE: "https://evil-canary-secret@example.atlassian.net" });
    const site = entries.find((e) => e.key === "ATLASSIAN_SITE")!;
    if (!site.secret) expect(site.value).toBe("https://[redacted]@example.atlassian.net");
  });

  test("a value with no userinfo is passed through unchanged", () => {
    const entries = buildSettingEntries({ ATLASSIAN_SITE: "https://example.atlassian.net" });
    const site = entries.find((e) => e.key === "ATLASSIAN_SITE")!;
    if (!site.secret) expect(site.value).toBe("https://example.atlassian.net");
  });

  test("SECRET_KEY_RE matches every env var this ticket's spec names as secret-like", () => {
    for (const name of ["ATLASSIAN_TOKEN", "GITHUB_TOKEN_FILE", "ROCKETCHAT_ADMIN_TOKEN_FILE", "BUTCHR_ASSIGNEE_STORY"]) {
      if (name === "BUTCHR_ASSIGNEE_STORY") { expect(SECRET_KEY_RE.test(name)).toBe(false); continue; }
      expect(SECRET_KEY_RE.test(name)).toBe(true);
    }
  });

  // FACTORY-694 item 4: `secret` is now an explicit, per-definition field —
  // these tests prove it is deliberate (every definition has one, it
  // matches a hand-reviewed expected set) and INDEPENDENT of the key's own
  // name (a non-matching name can still be flagged secret, and a
  // matching-looking name is never silently un-flagged by renaming alone).
  describe("every definition's `secret` flag", () => {
    test("is set on exactly the hand-reviewed expected set — not derived at runtime", () => {
      for (const def of SETTINGS_DEFINITIONS) {
        expect(def.secret).toBe(EXPECTED_SECRET_KEYS.has(def.key));
      }
    });

    test("every key whose NAME matches SECRET_KEY_RE is explicitly secret: true (regression guard, not the source of truth)", () => {
      for (const def of SETTINGS_DEFINITIONS) {
        if (SECRET_KEY_RE.test(def.key)) expect(def.secret).toBe(true);
      }
    });

    test("a future key with a secret VALUE and a NON-matching name is hidden because of its explicit flag alone, never because of its name", () => {
      // "WEIRD_CUSTOM_SETTING" matches no part of SECRET_KEY_RE (token|secret|password|key) — yet is explicitly secret: true here.
      expect(SECRET_KEY_RE.test("WEIRD_CUSTOM_SETTING")).toBe(false);
      const definitions = [{ key: "WEIRD_CUSTOM_SETTING", description: "d", secret: true as const }];
      const entries = buildSettingEntries({ WEIRD_CUSTOM_SETTING: "super-secret-value" }, undefined, {}, definitions);
      const entry = entries[0]!;
      expect(entry.secret).toBe(true);
      expect(JSON.stringify(entry)).not.toContain("super-secret-value");
      expect("value" in entry).toBe(false);
      if (entry.secret) expect(entry.set).toBe(true);
    });

    test("a key with a matching-looking name but secret: false is shown verbatim — the flag, not the name, decides", () => {
      // "SOME_KEY_PATH" matches SECRET_KEY_RE by name (contains "KEY") but is explicitly secret: false.
      expect(SECRET_KEY_RE.test("SOME_KEY_PATH")).toBe(true);
      const definitions = [{ key: "SOME_KEY_PATH", description: "d", secret: false as const }];
      const entries = buildSettingEntries({ SOME_KEY_PATH: "/not/a/secret" }, undefined, {}, definitions);
      const entry = entries[0]!;
      expect(entry.secret).toBe(false);
      if (!entry.secret) expect(entry.value).toBe("/not/a/secret");
    });
  });

  // FACTORY-665 additions: `source: "file"` and `editable`.
  test("editable is true exactly for the FACTORY-665 allowlist", () => {
    const entries = buildSettingEntries({});
    const editableKeys = entries.filter((e) => e.editable).map((e) => e.key).sort();
    expect(editableKeys).toEqual([
      "BUTCHR_AGENT_MODEL",
      "BUTCHR_AGENT_PROVIDER",
      "BUTCHR_AGENT_PROVIDERS",
      "BUTCHR_AGENT_PROVIDERS_EPIC",
      "BUTCHR_AGENT_PROVIDERS_PROJECT",
      "BUTCHR_AGENT_PROVIDERS_STORY",
      "BUTCHR_AGENT_PROVIDERS_TASK",
      "BUTCHR_MAX_AGENTS",
      "BUTCHR_POLL_STALE_MS",
    ].sort());
  });

  test("no settings.json layer (rawEnv === effectiveEnv, default): env-set key is 'environment', unset is 'default'", () => {
    const entries = buildSettingEntries({ BUTCHR_MAX_AGENTS: "12" });
    expect(entries.find((e) => e.key === "BUTCHR_MAX_AGENTS")!.source).toBe("environment");
    expect(entries.find((e) => e.key === "BUTCHR_AGENT_MODEL")!.source).toBe("default");
  });

  test("settings.json supplies a value the raw env does NOT set: source is 'file'", () => {
    // effectiveEnv already has the settings.json value merged in (as a real caller's effectiveSettingsEnv would produce); rawEnv is the UNMERGED process.env, which never set it.
    const entries = buildSettingEntries({ BUTCHR_MAX_AGENTS: "12" }, {}, { BUTCHR_MAX_AGENTS: "12" });
    expect(entries.find((e) => e.key === "BUTCHR_MAX_AGENTS")!.source).toBe("file");
  });

  test("a real env var wins over settings.json: source is 'environment', never 'file'", () => {
    const entries = buildSettingEntries({ BUTCHR_MAX_AGENTS: "5" }, { BUTCHR_MAX_AGENTS: "5" }, { BUTCHR_MAX_AGENTS: "12" });
    expect(entries.find((e) => e.key === "BUTCHR_MAX_AGENTS")!.source).toBe("environment");
  });
});

describe("buildAtlassianTokenFileStatus", () => {
  test("unset: path null, exists/readable false, mode/tooOpen null", async () => {
    const status = await buildAtlassianTokenFileStatus({});
    expect(status.path).toBeNull();
    expect(status.exists).toBe(false);
    expect(status.readable).toBe(false);
    expect(status.mode).toBeNull();
    expect(status.tooOpen).toBeNull();
    expect(status.secret).toBe(false);
  });

  test("never returns file contents — the response shape has no 'contents'/'value' field at all", async () => {
    const status = await buildAtlassianTokenFileStatus({ ATLASSIAN_TOKEN_FILE: "/fake/path" }, async () => ({ exists: true, readable: true, mode: 0o600 }));
    expect("contents" in status).toBe(false);
    expect("value" in status).toBe(false);
  });

  test("set, file exists at 0600: tooOpen false", async () => {
    const status = await buildAtlassianTokenFileStatus({ ATLASSIAN_TOKEN_FILE: "/fake/path" }, async () => ({ exists: true, readable: true, mode: 0o600 }));
    expect(status.path).toBe("/fake/path");
    expect(status.exists).toBe(true);
    expect(status.tooOpen).toBe(false);
  });

  test("set, file exists but too open (0644): tooOpen true", async () => {
    const status = await buildAtlassianTokenFileStatus({ ATLASSIAN_TOKEN_FILE: "/fake/path" }, async () => ({ exists: true, readable: true, mode: 0o644 }));
    expect(status.tooOpen).toBe(true);
  });

  test("set, file missing: exists false, mode/tooOpen null", async () => {
    const status = await buildAtlassianTokenFileStatus({ ATLASSIAN_TOKEN_FILE: "/fake/path" }, async () => ({ exists: false, readable: false, mode: null }));
    expect(status.exists).toBe(false);
    expect(status.mode).toBeNull();
    expect(status.tooOpen).toBeNull();
  });
});

describe("redactUrlUserinfo", () => {
  test("redacts user:pass@ in a URL", () => {
    expect(redactUrlUserinfo("https://user:pass@host.example.com")).toBe("https://[redacted]@host.example.com");
  });
  test("redacts a bare user@ (no password) too", () => {
    expect(redactUrlUserinfo("https://user@host.example.com")).toBe("https://[redacted]@host.example.com");
  });
  test("leaves a value with no userinfo untouched", () => {
    expect(redactUrlUserinfo("https://host.example.com/path")).toBe("https://host.example.com/path");
  });
  test("leaves a non-URL value untouched", () => {
    expect(redactUrlUserinfo("just-a-plain-string")).toBe("just-a-plain-string");
  });
  test("redacts every occurrence when more than one URL-with-userinfo appears in one value", () => {
    expect(redactUrlUserinfo("a=https://u1:p1@h1.example, b=https://u2:p2@h2.example")).toBe("a=https://[redacted]@h1.example, b=https://[redacted]@h2.example");
  });
});

describe("isModeTooOpen", () => {
  test("0600 is not too open", () => expect(isModeTooOpen(0o600)).toBe(false));
  test("0400 is not too open", () => expect(isModeTooOpen(0o400)).toBe(false));
  test("0644 is too open (world-readable)", () => expect(isModeTooOpen(0o644)).toBe(true));
  test("0640 is too open (group-readable)", () => expect(isModeTooOpen(0o640)).toBe(true));
  test("0777 is too open", () => expect(isModeTooOpen(0o777)).toBe(true));
});

describe("redactUrlUserinfo: a password that itself contains '@' leaves no remainder (manager-factory review of #660)", () => {
  test("https://u:p@ss@host/x -> nothing of the password survives", () => {
    const out = redactUrlUserinfo("https://user:p@ss-CANARY@chat.example.com/path?x=1");
    expect(out).toBe("https://[redacted]@chat.example.com/path?x=1");
    expect(out).not.toContain("CANARY");
    expect(out).not.toContain("ss");
  });
  test("a plain URL without userinfo, and a path containing '@', are untouched", () => {
    expect(redactUrlUserinfo("https://chat.example.com/a@b")).toBe("https://chat.example.com/a@b");
    expect(redactUrlUserinfo("https://chat.example.com")).toBe("https://chat.example.com");
  });
});
