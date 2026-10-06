import { describe, expect, test } from "bun:test";
import { buildSettingEntries, buildAtlassianTokenFileStatus, isModeTooOpen, redactUrlUserinfo, SETTINGS_DEFINITIONS, SECRET_KEY_RE } from "../../src/web/settings-api.js";

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
