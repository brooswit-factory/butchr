import { describe, expect, test } from "bun:test";
import { buildSettingEntries, buildAtlassianTokenFileStatus, isModeTooOpen, SETTINGS_DEFINITIONS, SECRET_KEY_RE } from "../../src/web/settings-api.js";

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

  test("SECRET_KEY_RE matches every env var this ticket's spec names as secret-like", () => {
    for (const name of ["ATLASSIAN_TOKEN", "GITHUB_TOKEN_FILE", "ROCKETCHAT_ADMIN_TOKEN_FILE", "BUTCHR_ASSIGNEE_STORY"]) {
      if (name === "BUTCHR_ASSIGNEE_STORY") { expect(SECRET_KEY_RE.test(name)).toBe(false); continue; }
      expect(SECRET_KEY_RE.test(name)).toBe(true);
    }
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

describe("isModeTooOpen", () => {
  test("0600 is not too open", () => expect(isModeTooOpen(0o600)).toBe(false));
  test("0400 is not too open", () => expect(isModeTooOpen(0o400)).toBe(false));
  test("0644 is too open (world-readable)", () => expect(isModeTooOpen(0o644)).toBe(true));
  test("0640 is too open (group-readable)", () => expect(isModeTooOpen(0o640)).toBe(true));
  test("0777 is too open", () => expect(isModeTooOpen(0o777)).toBe(true));
});
