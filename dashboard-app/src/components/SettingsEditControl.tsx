/**
 * FACTORY-665 — the inline edit control for ONE editable settings.json
 * row: a text input pre-filled with the row's current raw value, a Save
 * button, and (only when the write is refused with `needsConfirm: true` —
 * e.g. BUTCHR_MAX_AGENTS above its confirm ceiling) a confirm dialog that
 * re-submits the SAME value with `confirm: true`. Every value is plain JSX
 * text/input content — no `dangerouslySetInnerHTML` anywhere in this file.
 */
import { useState } from "react";
import { Button, Input, TextField, Text } from "@launchpad-ui/components";
import { SettingsWriteRefusedError } from "../api/settings.js";
import "./SettingsView.css";

export interface SettingsEditControlProps {
  settingKey: string;
  initialValue: string;
  onSave: (key: string, value: string, confirm: boolean) => Promise<void>;
}

type SaveState = { kind: "idle" } | { kind: "pending" } | { kind: "error"; message: string } | { kind: "needsConfirm"; message: string } | { kind: "saved" };

export function SettingsEditControl({ settingKey, initialValue, onSave }: SettingsEditControlProps) {
  const [value, setValue] = useState(initialValue);
  const [state, setState] = useState<SaveState>({ kind: "idle" });

  async function save(confirm: boolean) {
    setState({ kind: "pending" });
    try {
      await onSave(settingKey, value, confirm);
      setState({ kind: "saved" });
    } catch (e) {
      if (e instanceof SettingsWriteRefusedError && e.needsConfirm) {
        setState({ kind: "needsConfirm", message: e.message });
      } else {
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return (
    <div className="settings-edit-control" data-testid="settings-edit-control" data-setting-key={settingKey}>
      <TextField
        aria-label={`edit ${settingKey}`}
        value={value}
        onChange={(v) => { setValue(v); setState({ kind: "idle" }); }}
      >
        <Input data-testid="settings-edit-input" />
      </TextField>
      <Button onPress={() => void save(false)} isDisabled={state.kind === "pending"} data-testid="settings-edit-save">
        Save
      </Button>
      {state.kind === "saved" && (
        <Text elementType="span" size="small" data-testid="settings-edit-result">
          saved — restart needed
        </Text>
      )}
      {state.kind === "error" && (
        <Text elementType="span" size="small" className="settings-jira-card__warning" data-testid="settings-edit-result">
          {state.message}
        </Text>
      )}
      {state.kind === "needsConfirm" && (
        <span data-testid="settings-edit-confirm">
          <Text elementType="span" size="small" className="settings-jira-card__warning">
            {state.message}
          </Text>
          <Button onPress={() => void save(true)} data-testid="settings-edit-confirm-button">
            Confirm
          </Button>
        </span>
      )}
    </div>
  );
}
