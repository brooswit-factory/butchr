/**
 * local/ui — the Settings page's sections: which daemon settings go together,
 * what each is called in words, and where its value comes from. A setting
 * this list doesn't know (one upstream adds later) lands in "Other" under its
 * own key, so nothing disappears.
 */
import { PROVIDER_ENABLED_ENV_VAR } from "../../../src/rules/provider-enablement.js";
import type { ResourceProvider } from "../../../src/rules/agent-key.js";
import { providerInfo } from "./rule-providers.js";
import type { SettingRowView } from "./settings-view.js";

export interface SettingMeta {
  label: string;
  /** Overrides the daemon's own description, where that one would mislead here. */
  help?: string;
  /** An on/off setting ("true"/"false", on by default): shown as a switch instead of a text field. */
  kind?: "switch";
}

/** FACTORY-66's per-provider switches, named like the Add rule menu names each rule type. */
const PROVIDER_SWITCHES = Object.entries(PROVIDER_ENABLED_ENV_VAR) as [ResourceProvider, string][];
const PROVIDER_SWITCH_META: Record<string, SettingMeta> = Object.fromEntries(
  PROVIDER_SWITCHES.map(([provider, key]) => [
    key,
    { label: providerInfo(provider).label, kind: "switch" as const, ...(provider === "jira-component" ? { help: "butchr can't run Jira component rules yet, so this does nothing for now." } : {}) },
  ]),
);

export const SETTING_META: Readonly<Record<string, SettingMeta>> = {
  ...PROVIDER_SWITCH_META,
  BUTCHR_ATLASSIAN_ENABLED: { label: "Atlassian", help: "Off turns off every Jira and Confluence rule type, and butchr doesn't read the Atlassian token.", kind: "switch" },
  BUTCHR_AGENT_PROVIDER: { label: "Default harness" },
  BUTCHR_AGENT_PROVIDERS: { label: "Harness fallback order" },
  BUTCHR_AGENT_PROVIDERS_PROJECT: { label: "Fallback order for project agents" },
  BUTCHR_AGENT_PROVIDERS_EPIC: { label: "Fallback order for epic agents" },
  BUTCHR_AGENT_PROVIDERS_STORY: { label: "Fallback order for story agents" },
  BUTCHR_AGENT_PROVIDERS_TASK: { label: "Fallback order for task agents" },
  BUTCHR_AGENT_MODEL: { label: "Model" },
  BUTCHR_MAX_AGENTS: { label: "Agent cap" },
  BUTCHR_ASSIGNEE_STORY: { label: "Story assignee" },
  BUTCHR_ASSIGNEE_TASK: { label: "Task assignee" },
  BUTCHR_ASSIGNEE_EPIC: { label: "Epic assignee" },
  BUTCHR_PROJECT_ALLOWLIST: { label: "Projects the project tier may staff" },
  BUTCHR_STALLED_MINUTES: { label: "Stalled after (minutes)" },
  BUTCHR_ABANDONED_MINUTES: { label: "Abandoned after (minutes)" },
  BUTCHR_ATREST_MINUTES: { label: "Frozen asleep after (minutes)" },
  BUTCHR_CRASHLOOP_COUNT: { label: "Crash loop: spawns" },
  BUTCHR_CRASHLOOP_WINDOW_MINUTES: { label: "Crash loop: window (minutes)" },
  BUTCHR_YIELDLOOP_COUNT: { label: "Yield loop: wakes" },
  BUTCHR_YIELDLOOP_WINDOW_MINUTES: { label: "Yield loop: window (minutes)" },
  BUTCHR_STANDDOWN_MAX_MINUTES: { label: "Longest sleep (minutes)" },
  BUTCHR_UNRESPONSIVE_MINUTES: { label: "Unresponsive after (minutes)" },
  BUTCHR_IDLE_DIALOG_MINUTES: { label: "Idle dialog check after (minutes)" },
  BUTCHR_OPS_ALERT_DEDUP_MINUTES: { label: "Ops alert dedup (minutes)" },
  BUTCHR_PERMISSION_AUDIT_PATH: { label: "Permission audit log" },
  BUTCHR_LIZARD_APPROVAL_SOUND: { label: "Approval sound" },
  BUTCHR_LIZARD_APPROVAL_SOUND_PATH: { label: "Approval sound file" },
  BUTCHR_PERMISSION_ANSWER_CANARY_PANE: { label: "Permission answers: canary pane" },
  BUTCHR_PORT: { label: "Port" },
  HERDR_SOCKET: { label: "herdr socket" },
  BUTCHR_TERMINAL: { label: "Terminal command" },
  BUTCHR_POLL_STALE_MS: { label: "Poll counts as stale after (ms)" },
  BUTCHR_HERDR_TIMEOUT_MS: { label: "herdr call timeout (ms)" },
  BUTCHR_CAPTURE_DIR: { label: "Pane captures", help: "Where butchr saves what a pane showed: when an agent hit a session limit, when a blocked dialog was escalated, and when a blocked pane had no ticket." },
  BUTCHR_RESTORED_RESUME: { label: "Resume after a herdr restore", help: "Which agents resume their previous session when herdr restores their panes: off, all, or a comma-separated list of agent names." },
};

export interface SettingGroupDef {
  id: string;
  title: string;
  description: string;
  keys: readonly string[];
}

export const SETTING_GROUPS: readonly SettingGroupDef[] = [
  {
    id: "rule-types",
    title: "Rule types",
    description: "Turn a whole kind of rule on or off. butchr doesn't run a switched-off type, or read its credentials.",
    keys: ["BUTCHR_ATLASSIAN_ENABLED", ...PROVIDER_SWITCHES.map(([, key]) => key)],
  },
  {
    id: "agents",
    title: "Agents",
    description: "Which harness and model agents start with, and how many run at once.",
    keys: ["BUTCHR_AGENT_PROVIDER", "BUTCHR_AGENT_PROVIDERS", "BUTCHR_AGENT_PROVIDERS_PROJECT", "BUTCHR_AGENT_PROVIDERS_EPIC", "BUTCHR_AGENT_PROVIDERS_STORY", "BUTCHR_AGENT_PROVIDERS_TASK", "BUTCHR_AGENT_MODEL", "BUTCHR_MAX_AGENTS"],
  },
  {
    id: "jira",
    title: "Jira staffing",
    description: "Who new Jira issues are assigned to, and which projects the project tier works on.",
    keys: ["BUTCHR_ASSIGNEE_STORY", "BUTCHR_ASSIGNEE_TASK", "BUTCHR_ASSIGNEE_EPIC", "BUTCHR_PROJECT_ALLOWLIST"],
  },
  {
    id: "detectors",
    title: "Detectors",
    description: "When butchr decides an agent is stuck, crashing or looping.",
    keys: ["BUTCHR_STALLED_MINUTES", "BUTCHR_ABANDONED_MINUTES", "BUTCHR_ATREST_MINUTES", "BUTCHR_CRASHLOOP_COUNT", "BUTCHR_CRASHLOOP_WINDOW_MINUTES", "BUTCHR_YIELDLOOP_COUNT", "BUTCHR_YIELDLOOP_WINDOW_MINUTES", "BUTCHR_STANDDOWN_MAX_MINUTES", "BUTCHR_UNRESPONSIVE_MINUTES", "BUTCHR_IDLE_DIALOG_MINUTES", "BUTCHR_OPS_ALERT_DEDUP_MINUTES"],
  },
  {
    id: "permissions",
    title: "Permissions",
    description: "Lizard mode's auto-answered permission prompts.",
    keys: ["BUTCHR_PERMISSION_AUDIT_PATH", "BUTCHR_LIZARD_APPROVAL_SOUND", "BUTCHR_LIZARD_APPROVAL_SOUND_PATH", "BUTCHR_PERMISSION_ANSWER_CANARY_PANE"],
  },
  {
    id: "daemon",
    title: "Daemon",
    description: "Where butchr listens, how it reaches herdr, and where it keeps its files.",
    keys: ["BUTCHR_PORT", "HERDR_SOCKET", "BUTCHR_TERMINAL", "BUTCHR_POLL_STALE_MS", "BUTCHR_HERDR_TIMEOUT_MS", "BUTCHR_CAPTURE_DIR", "BUTCHR_RESTORED_RESUME"],
  },
];

export interface SettingItem extends SettingRowView {
  label: string;
  help: string;
  /** On/off, shown as a switch (`SettingMeta.kind`). */
  switch: boolean;
}

/** A switch setting's state: a saved or environment value, else on (butchr's default for every one of them). */
export function switchIsOn(item: Pick<SettingItem, "rawValue">): boolean {
  const v = item.rawValue?.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

export interface SettingGroup {
  id: string;
  title: string;
  description: string;
  items: SettingItem[];
}

/** Lays the daemon's rows out in `SETTING_GROUPS`' order; unknown keys go to "Other", and a group with nothing in it is left out. */
export function groupSettings(rows: readonly SettingRowView[]): SettingGroup[] {
  const item = (r: SettingRowView): SettingItem => ({ ...r, label: SETTING_META[r.key]?.label ?? r.key, help: SETTING_META[r.key]?.help ?? r.description, switch: SETTING_META[r.key]?.kind === "switch" });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const placed = new Set<string>();
  const groups: SettingGroup[] = [];
  for (const g of SETTING_GROUPS) {
    const items = g.keys.flatMap((k) => {
      const r = byKey.get(k);
      if (!r) return [];
      placed.add(k);
      return [item(r)];
    });
    if (items.length) groups.push({ id: g.id, title: g.title, description: g.description, items });
  }
  const rest = rows.filter((r) => !placed.has(r.key)).map(item);
  if (rest.length) groups.push({ id: "other", title: "Other", description: "Settings this page doesn't group yet.", items: rest });
  return groups;
}

/** Where a setting's value comes from, in words. */
export function sourceText(row: Pick<SettingRowView, "source" | "editable">): string {
  if (row.source === "environment") return "set in butchr's environment";
  if (row.source === "file") return "saved from this page";
  return row.editable ? "default; can be changed here" : "default";
}

/** What the restart banner calls a changed setting: "the agent cap", or "the Jira tickets switch" (a rule type keeps its capitals). */
export function changeName(item: Pick<SettingItem, "label" | "key"> & { switch?: boolean }): string {
  if (item.label === item.key) return item.key;
  if (item.switch) return `the ${item.label} switch`;
  return `the ${item.label.charAt(0).toLowerCase()}${item.label.slice(1)}`;
}
