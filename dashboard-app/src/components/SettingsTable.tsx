/**
 * FACTORY-664 — the settings list: key, value ("set"/"not set" for a
 * secret, the literal value or "(default)" otherwise), source, a
 * restart-needed badge, and the description. Every field is plain JSX text
 * content (React escapes it — no `dangerouslySetInnerHTML` anywhere in this
 * file), so a setting whose value happens to contain markup-looking text
 * is never parsed as markup.
 */
import { Text } from "@launchpad-ui/components";
import type { SettingRowView } from "../view-model/settings-view.js";
import { SettingsEditControl } from "./SettingsEditControl.js";
import "./SettingsView.css";

export interface SettingsTableProps {
  rows: SettingRowView[];
  /** FACTORY-665: called by an editable row's own `SettingsEditControl` — omitted means every row renders read-only (e.g. a dashboard build with no write path configured). */
  onSaveSetting?: (key: string, value: string, confirm: boolean) => Promise<void>;
}

export function SettingsTable({ rows, onSaveSetting }: SettingsTableProps) {
  return (
    <div className="settings-table" role="table" aria-label="settings" data-testid="settings-table">
      {rows.map((row) => (
        <div className="settings-table__row" data-testid="setting-row" data-setting-key={row.key} role="row" key={row.key}>
          <Text elementType="span" bold role="cell" className="settings-table__cell">
            {row.key}
          </Text>
          <Text elementType="span" size="small" role="cell" className="settings-table__cell" data-testid="setting-value">
            {row.displayValue}
          </Text>
          <Text elementType="span" size="small" role="cell" className="settings-table__cell">
            {row.source === "environment" && row.editable ? "environment (overrides settings.json)" : row.source}
          </Text>
          <span role="cell" className="settings-table__cell">
            {row.restartNeeded && (
              <Text elementType="span" size="small" className="settings-table__badge settings-table__badge--restart">
                restart needed
              </Text>
            )}
          </span>
          <Text elementType="span" size="small" role="cell" className="settings-table__cell">
            {row.description}
          </Text>
          <span role="cell" className="settings-table__cell">
            {row.editable && onSaveSetting && row.rawValue !== null && (
              <SettingsEditControl settingKey={row.key} initialValue={row.rawValue} onSave={onSaveSetting} />
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
