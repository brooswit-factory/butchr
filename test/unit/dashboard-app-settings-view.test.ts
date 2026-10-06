import { describe, expect, test } from "bun:test";
import { settingRowView, tokenFileView, buildSettingsViewModel } from "../../dashboard-app/src/view-model/settings-view.js";
import type { AtlassianTokenFileStatus, SettingEntry, SettingsResponse } from "../../dashboard-app/src/api/settings.js";

describe("settingRowView", () => {
  test("non-secret with a value: displays the value verbatim", () => {
    const entry: SettingEntry = { key: "BUTCHR_PORT", value: "7717", source: "environment", restartNeeded: true, secret: false, editable: false, description: "d" };
    expect(settingRowView(entry).displayValue).toBe("7717");
  });

  test("non-secret unset: displays (default)", () => {
    const entry: SettingEntry = { key: "BUTCHR_PORT", value: null, source: "default", restartNeeded: true, secret: false, editable: false, description: "d" };
    expect(settingRowView(entry).displayValue).toBe("(default)");
  });

  test("secret set: displays 'set', never the actual value — there IS no value field to leak", () => {
    const entry: SettingEntry = { key: "ATLASSIAN_TOKEN", set: true, source: "environment", restartNeeded: true, secret: true, editable: false, description: "d" };
    expect(settingRowView(entry).displayValue).toBe("set");
    expect("value" in entry).toBe(false);
  });

  test("secret unset: displays 'not set'", () => {
    const entry: SettingEntry = { key: "ATLASSIAN_TOKEN", set: false, source: "environment", restartNeeded: true, secret: true, editable: false, description: "d" };
    expect(settingRowView(entry).displayValue).toBe("not set");
  });

  test("editable, non-secret: rawValue is the current value (empty string when unset)", () => {
    const set: SettingEntry = { key: "BUTCHR_MAX_AGENTS", value: "12", source: "file", restartNeeded: true, secret: false, editable: true, description: "d" };
    expect(settingRowView(set).rawValue).toBe("12");
    const unset: SettingEntry = { key: "BUTCHR_MAX_AGENTS", value: null, source: "default", restartNeeded: true, secret: false, editable: true, description: "d" };
    expect(settingRowView(unset).rawValue).toBe("");
  });

  test("non-editable or secret: rawValue is null (never offered an edit control)", () => {
    const nonEditable: SettingEntry = { key: "BUTCHR_PORT", value: "7717", source: "environment", restartNeeded: true, secret: false, editable: false, description: "d" };
    expect(settingRowView(nonEditable).rawValue).toBeNull();
    const secretEditable: SettingEntry = { key: "ATLASSIAN_TOKEN", set: true, source: "environment", restartNeeded: true, secret: true, editable: false, description: "d" };
    expect(settingRowView(secretEditable).rawValue).toBeNull();
  });

  test("source 'file' passes through verbatim", () => {
    const entry: SettingEntry = { key: "BUTCHR_MAX_AGENTS", value: "12", source: "file", restartNeeded: true, secret: false, editable: true, description: "d" };
    expect(settingRowView(entry).source).toBe("file");
  });
});

function tokenStatus(overrides: Partial<AtlassianTokenFileStatus> = {}): AtlassianTokenFileStatus {
  return { key: "ATLASSIAN_TOKEN_FILE", path: "/x/token", source: "environment", restartNeeded: true, secret: false, description: "d", exists: true, readable: true, mode: 0o600, tooOpen: false, ...overrides };
}

describe("tokenFileView", () => {
  test("unset: no warning", () => {
    const v = tokenFileView(tokenStatus({ path: null, exists: false, readable: false, mode: null, tooOpen: null }));
    expect(v.warning).toBe(false);
    expect(v.path).toBeNull();
  });

  test("missing file: warning", () => {
    const v = tokenFileView(tokenStatus({ exists: false, readable: false, mode: null, tooOpen: null }));
    expect(v.warning).toBe(true);
    expect(v.statusText).toContain("not found");
  });

  test("exists, 0600: no warning", () => {
    const v = tokenFileView(tokenStatus({ mode: 0o600, tooOpen: false }));
    expect(v.warning).toBe(false);
  });

  test("exists, too open (0644): warning", () => {
    const v = tokenFileView(tokenStatus({ mode: 0o644, tooOpen: true }));
    expect(v.warning).toBe(true);
    expect(v.statusText).toContain("wider than 0600");
  });

  test("exists but unreadable: warning", () => {
    const v = tokenFileView(tokenStatus({ readable: false }));
    expect(v.warning).toBe(true);
    expect(v.statusText).toContain("not readable");
  });
});

function response(overrides: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    settings: [],
    atlassianTokenFile: tokenStatus(),
    ...overrides,
  };
}

describe("buildSettingsViewModel", () => {
  test("extracts jiraSite/jiraEmail from the settings list", () => {
    const vm = buildSettingsViewModel(response({ settings: [
      { key: "ATLASSIAN_SITE", value: "https://x.atlassian.net", source: "environment", restartNeeded: true, secret: false, editable: false, description: "d" },
      { key: "ATLASSIAN_EMAIL", value: "a@b.com", source: "environment", restartNeeded: true, secret: false, editable: false, description: "d" },
    ] }));
    expect(vm.jiraSite).toBe("https://x.atlassian.net");
    expect(vm.jiraEmail).toBe("a@b.com");
  });

  test("missing ATLASSIAN_SITE/EMAIL entries: both null, never throws", () => {
    const vm = buildSettingsViewModel(response());
    expect(vm.jiraSite).toBeNull();
    expect(vm.jiraEmail).toBeNull();
  });

  test("unitHint absent: unitHintText is null", () => {
    expect(buildSettingsViewModel(response()).unitHintText).toBeNull();
  });

  test("unitHint present but empty: a plain 'no drop-ins' message, not blank", () => {
    const vm = buildSettingsViewModel(response({ unitHint: { dropInPaths: [], environmentFiles: [] } }));
    expect(vm.unitHintText).toContain("no drop-ins");
  });

  test("unitHint with entries: both kinds listed", () => {
    const vm = buildSettingsViewModel(response({ unitHint: { dropInPaths: ["/a.conf"], environmentFiles: ["/b.env"] } }));
    expect(vm.unitHintText).toContain("/a.conf");
    expect(vm.unitHintText).toContain("/b.env");
  });

  test("rows pass through settingRowView for every entry", () => {
    const vm = buildSettingsViewModel(response({ settings: [{ key: "K", value: "v", source: "environment", restartNeeded: true, secret: false, editable: false, description: "d" }] }));
    expect(vm.rows).toHaveLength(1);
    expect(vm.rows[0]!.displayValue).toBe("v");
  });
});
