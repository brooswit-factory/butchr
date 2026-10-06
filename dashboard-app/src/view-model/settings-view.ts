/**
 * FACTORY-664 — pure view-model for the Settings page. No React, no DOM —
 * every rendering DECISION lives here, same discipline `view-model/rules-
 * view.ts` already follows.
 */
import type { AtlassianTokenFileStatus, SettingEntry, SettingsResponse } from "../api/settings.js";

export interface SettingRowView {
  key: string;
  /** Already the exact text to render — "set" / "not set" for a secret, the literal value or "(default)" otherwise. Never the raw secret. */
  displayValue: string;
  source: "environment" | "default";
  restartNeeded: boolean;
  description: string;
}

export function settingRowView(entry: SettingEntry): SettingRowView {
  const displayValue = entry.secret ? (entry.set ? "set" : "not set") : entry.value ?? "(default)";
  return { key: entry.key, displayValue, source: entry.source, restartNeeded: entry.restartNeeded, description: entry.description };
}

export interface TokenFileView {
  path: string | null;
  statusText: string;
  /** `true` when the file is missing, unreadable, or too open — the UI shows a warning badge. */
  warning: boolean;
}

export function tokenFileView(status: AtlassianTokenFileStatus): TokenFileView {
  if (status.path === null) return { path: null, statusText: "not configured (using ATLASSIAN_TOKEN directly, or unset)", warning: false };
  if (!status.exists) return { path: status.path, statusText: "file not found", warning: true };
  if (!status.readable) return { path: status.path, statusText: "exists, but not readable by this daemon", warning: true };
  const modeText = status.mode !== null ? `mode ${status.mode.toString(8).padStart(3, "0")}` : "mode unknown";
  if (status.tooOpen) return { path: status.path, statusText: `exists, readable — ${modeText} (wider than 0600)`, warning: true };
  return { path: status.path, statusText: `exists, readable — ${modeText}`, warning: false };
}

export interface SettingsPageViewModel {
  rows: SettingRowView[];
  tokenFile: TokenFileView;
  jiraSite: string | null;
  jiraEmail: string | null;
  unitHintText: string | null;
}

function findValue(entries: SettingEntry[], key: string): string | null {
  const entry = entries.find((e) => e.key === key);
  if (!entry || entry.secret) return null;
  return entry.value;
}

export function buildSettingsViewModel(data: SettingsResponse): SettingsPageViewModel {
  const unitHintText = data.unitHint
    ? data.unitHint.dropInPaths.length > 0 || data.unitHint.environmentFiles.length > 0
      ? [...data.unitHint.dropInPaths.map((p) => `drop-in: ${p}`), ...data.unitHint.environmentFiles.map((p) => `env file: ${p}`)].join(", ")
      : "no drop-ins or EnvironmentFile= configured"
    : null;
  return {
    rows: data.settings.map(settingRowView),
    tokenFile: tokenFileView(data.atlassianTokenFile),
    jiraSite: findValue(data.settings, "ATLASSIAN_SITE"),
    jiraEmail: findValue(data.settings, "ATLASSIAN_EMAIL"),
    unitHintText,
  };
}
