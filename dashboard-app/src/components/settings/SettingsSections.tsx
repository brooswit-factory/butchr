/**
 * local/ui — the Settings page's daemon settings, one card per group
 * (`view-model/settings-groups.ts`) in the Providers cards' style, in place
 * of upstream's single table. Each setting shows its name in words, what it
 * does, its key and where its value comes from. The editable ones get a field
 * and Save, or a switch for an on/off setting; butchr asks for a confirm when a
 * value crosses a safety ceiling.
 */
import { useState, type FormEvent } from "react";
import { Button, Heading, Input, Switch, Text, TextField } from "@launchpad-ui/components";
import { SettingsWriteRefusedError } from "../../api/settings.js";
import { changeName, groupSettings, sourceText, switchIsOn, type SettingGroup, type SettingItem } from "../../view-model/settings-groups.js";
import type { SettingRowView } from "../../view-model/settings-view.js";
import "./SettingsSections.css";

/** `onInput` beside `onChange`, the event happy-dom tests deliver (see `RuleEditor.tsx`'s `typed`). */
const typed = (fn: (value: string) => void) => ({ onInput: (e: FormEvent<HTMLInputElement>) => fn((e.target as HTMLInputElement).value) });

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "confirm"; message: string } | { kind: "error"; message: string };

function SettingField({ item, onSave }: { item: SettingItem; onSave: (key: string, value: string, confirm: boolean) => Promise<void> }) {
  // The value saved last. The daemon keeps reporting its startup value until a
  // restart, so a successful save moves this on locally; a new value from the
  // daemon (after a restart) replaces it.
  const [saved, setSaved] = useState(item.rawValue ?? "");
  const [reported, setReported] = useState(item.rawValue);
  if (item.rawValue !== reported) {
    setReported(item.rawValue);
    setSaved(item.rawValue ?? "");
  }
  const [value, setValue] = useState(saved);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const trimmed = value.trim();
  const change = (v: string) => {
    setValue(v);
    if (state.kind !== "saving") setState({ kind: "idle" });
  };

  async function save(confirm: boolean) {
    setState({ kind: "saving" });
    try {
      await onSave(item.key, trimmed, confirm);
      setSaved(trimmed);
      setState({ kind: "saved" });
    } catch (e) {
      if (e instanceof SettingsWriteRefusedError && e.needsConfirm) setState({ kind: "confirm", message: e.message });
      else setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="sg-field">
      <form
        className="sg-field__row"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && trimmed !== saved) void save(false);
        }}
      >
        <TextField className="sg-field__input" aria-label={item.label} value={value} onChange={change} isDisabled={state.kind === "saving"}>
          <Input placeholder="butchr's default" spellCheck={false} autoComplete="off" data-testid={`sg-input-${item.key}`} {...typed(change)} />
        </TextField>
        <Button type="submit" size="small" isPending={state.kind === "saving"} isDisabled={!trimmed || trimmed === saved} data-testid={`sg-save-${item.key}`}>
          Save
        </Button>
      </form>
      {!trimmed && saved && (
        <Text elementType="p" size="small" className="sg-muted">
          butchr can't clear a saved value from here yet.
        </Text>
      )}
      {state.kind === "saved" && (
        <Text elementType="p" size="small" className="sg-ok" data-testid={`sg-result-${item.key}`}>
          Saved. butchr uses it after a restart.
        </Text>
      )}
      {state.kind === "error" && (
        <Text elementType="p" size="small" className="sg-error" data-testid={`sg-result-${item.key}`}>
          {state.message}
        </Text>
      )}
      {state.kind === "confirm" && (
        <div className="sg-confirm" data-testid={`sg-confirm-${item.key}`}>
          <Text elementType="p" size="small" className="sg-warning">
            {state.message}
          </Text>
          <Button size="small" onPress={() => void save(true)} data-testid={`sg-confirm-button-${item.key}`}>
            Save anyway
          </Button>
        </div>
      )}
    </div>
  );
}

type SwitchState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "confirm"; message: string; value: boolean } | { kind: "error"; message: string };

/** An on/off setting: flipping it saves "true" or "false" straight away. */
function SettingSwitch({ item, onSave }: { item: SettingItem; onSave: (key: string, value: string, confirm: boolean) => Promise<void> }) {
  const [on, setOn] = useState(switchIsOn(item));
  const [state, setState] = useState<SwitchState>({ kind: "idle" });

  async function save(next: boolean, confirm: boolean) {
    const before = on;
    setOn(next);
    setState({ kind: "saving" });
    try {
      await onSave(item.key, next ? "true" : "false", confirm);
      setState({ kind: "saved" });
    } catch (e) {
      setOn(before);
      if (e instanceof SettingsWriteRefusedError && e.needsConfirm) setState({ kind: "confirm", message: e.message, value: next });
      else setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="sg-field">
      <Switch isSelected={on} isDisabled={state.kind === "saving"} onChange={(next) => void save(next, false)} aria-label={item.label} data-testid={`sg-switch-${item.key}`} />
      {state.kind === "saved" && (
        <Text elementType="p" size="small" className="sg-ok" data-testid={`sg-result-${item.key}`}>
          Saved. butchr uses it after a restart.
        </Text>
      )}
      {state.kind === "error" && (
        <Text elementType="p" size="small" className="sg-error" data-testid={`sg-result-${item.key}`}>
          {state.message}
        </Text>
      )}
      {state.kind === "confirm" && (
        <div className="sg-confirm" data-testid={`sg-confirm-${item.key}`}>
          <Text elementType="p" size="small" className="sg-warning">
            {state.message}
          </Text>
          <Button size="small" onPress={() => void save(state.value, true)} data-testid={`sg-confirm-button-${item.key}`}>
            Save anyway
          </Button>
        </div>
      )}
    </div>
  );
}

function SettingValue({ item }: { item: SettingItem }) {
  if (item.switch) {
    const isDefault = item.displayValue === "(default)";
    const on = isDefault || switchIsOn({ rawValue: item.displayValue });
    return <span className={isDefault ? "sg-muted" : undefined}>{on ? "On" : "Off"}{isDefault ? " (butchr's default)" : ""}</span>;
  }
  if (item.displayValue === "(default)") return <span className="sg-muted">butchr's default</span>;
  return <code className="sg-value">{item.displayValue}</code>;
}

function SettingRow({ item, onSave }: { item: SettingItem; onSave: (item: SettingItem, value: string, confirm: boolean) => Promise<void> }) {
  return (
    <li className="sg-row" data-testid={`sg-row-${item.key}`}>
      <div className="sg-row__about">
        <Text elementType="p" className="sg-row__label">
          {item.label}
        </Text>
        {item.help && (
          <Text elementType="p" size="small" className="sg-muted">
            {item.help}
          </Text>
        )}
        <Text elementType="p" size="small" className="sg-row__meta">
          <code>{item.key}</code> · {sourceText(item)}
        </Text>
      </div>
      <div className="sg-row__value">
        {/* An environment value always wins, so a saved one could never take effect (the daemon refuses it too). */}
        {item.editable && item.rawValue !== null && item.source !== "environment" ? (
          item.switch ? <SettingSwitch item={item} onSave={(_key, value, confirm) => onSave(item, value, confirm)} /> : <SettingField item={item} onSave={(_key, value, confirm) => onSave(item, value, confirm)} />
        ) : (
          <SettingValue item={item} />
        )}
      </div>
    </li>
  );
}

function GroupCard({ group, onSave }: { group: SettingGroup; onSave: (item: SettingItem, value: string, confirm: boolean) => Promise<void> }) {
  const titleId = `sg-${group.id}-title`;
  return (
    <section className="sg-card" aria-labelledby={titleId} data-testid={`sg-group-${group.id}`}>
      <header className="sg-card__header">
        <Heading level={3} id={titleId} className="sg-card__title">
          {group.title}
        </Heading>
        <Text size="small" className="sg-muted">
          {group.description}
        </Text>
      </header>
      <ul className="sg-rows">
        {group.items.map((item) => (
          <SettingRow key={item.key} item={item} onSave={onSave} />
        ))}
      </ul>
    </section>
  );
}

export interface SettingsSectionsProps {
  rows: readonly SettingRowView[];
  onSaveSetting: (key: string, value: string, confirm: boolean) => Promise<void>;
  /** Called after a save lands, with what the restart banner should call it. */
  onChanged: (what: string) => void;
}

export function SettingsSections({ rows, onSaveSetting, onChanged }: SettingsSectionsProps) {
  const groups = groupSettings(rows);
  const save = async (item: SettingItem, value: string, confirm: boolean) => {
    await onSaveSetting(item.key, value, confirm);
    onChanged(changeName(item));
  };
  return (
    <section className="sg-section" aria-labelledby="sg-heading" data-testid="settings-sections">
      <div className="sg-section__intro">
        <Heading level={2} id="sg-heading" className="sg-section__title">
          Daemon settings
        </Heading>
        <Text elementType="p" size="small" className="sg-muted">
          Values set in butchr's environment win and can only be changed there. The rest can be saved here. Every change applies after a restart.
        </Text>
      </div>
      {groups.map((g) => (
        <GroupCard key={g.id} group={g} onSave={save} />
      ))}
    </section>
  );
}
