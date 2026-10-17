/**
 * local/ui — the Rules page's draft model. Plain TypeScript,
 * no React, same discipline as `rules-view.ts`.
 *
 * The whole page edits ONE draft, compared against the snapshot (`base`) it was started from.
 * Nothing is written until Review and save. Every status the page shows
 * (new / edited / deleted, incomplete / invalid, the change list, the
 * ordered save steps) is DERIVED from `(base, rules)`, never stored, so
 * reverting an edit by hand makes the rule clean again.
 *
 * The write path underneath is unchanged: each save step is one of the
 * existing `RulesApi` calls with its own plan-then-confirm gate (see
 * `rules-save.ts`), so every server-side refusal still applies.
 */
import type { AgentEffort } from "../../../src/resources/power-scale.js";
import type { AgentHarness, AgentRole, RulePermissionMode } from "../../../src/rules/agent-harness.js";
import type { ResourceProvider } from "../../../src/rules/agent-key.js";
import type { ExecutionMode } from "../../../src/rules/rules.js";
import { PLACEHOLDER_QUERY, type NotifyDeliveryMode, type RuleAgentPreferencePatch, type RuleCreateDraft, type RuleDto, type RuleFieldPatch } from "../api/rules.js";

export interface PreferenceDraft {
  harness: AgentHarness;
  /** `""` means butchr's default model for the harness. */
  model: string;
  effort: AgentEffort | "";
}

export interface RuleDraft {
  /** Stable client key: the saved rule's id, or `new:<n>` for a rule that only exists in this draft (a colon can't appear in a rule id, so the two never collide). */
  key: string;
  isNew: boolean;
  id: string;
  resourceProvider: ResourceProvider;
  query: string;
  enabled: boolean;
  /** `null` = no preference slot: the rule uses butchr's global agent config. */
  preference: PreferenceDraft | null;
  /** `""` = butchr's default. */
  permissionMode: RulePermissionMode | "";
  lizardMode: boolean;
  role: AgentRole;
  /** Kept as text so a half-typed number is still a draft; `""` = inherit the global stall threshold. */
  idlePokeMinutes: string;
  /** `""` = inherit the default wake text. */
  idlePokeMessage: string;
  idlePokeEnabled: boolean;
  execution: ExecutionMode;
  resumeOnRespawn: boolean;
  /** Kept as text; `""` = the daemon's default cutoff. */
  resumeContextCutoff: string;
  /** `""` = butchr's default: the MCP channel, falling back to a direct prompt. */
  notifyDeliveryMode: NotifyDeliveryMode | "";
  /** Kept as text; `""` = the daemon's default stall threshold. */
  stalledMinutes: string;
  /** Linked-change eventing (jira-work and jira-project rules, `supportsLinkedEvents`). The counts are kept as text; `""` = butchr's default. */
  linkedEventing: boolean;
  maxLinkedTurnsPerHour: string;
  maxLinkedItems: string;
  linkedRemoteLinks: boolean;
  linkedDescriptionLinks: boolean;
  linkedPollIntervalMs: string;
  /** Full brief text (`@builtin:<name>` or literal), or `null` while a saved rule's brief hasn't been loaded yet — the rules list only carries an excerpt. */
  brief: string | null;
  /** Marked for deletion on save (saved rules only — a new rule is simply dropped). */
  deleted: boolean;
}

/** Fields a person can change from the page. `key`, `isNew` and `deleted` are bookkeeping. */
export type EditableField =
  | "id"
  | "resourceProvider"
  | "query"
  | "enabled"
  | "preference"
  | "permissionMode"
  | "lizardMode"
  | "role"
  | "idlePokeMinutes"
  | "idlePokeMessage"
  | "idlePokeEnabled"
  | "execution"
  | "resumeOnRespawn"
  | "resumeContextCutoff"
  | "notifyDeliveryMode"
  | "stalledMinutes"
  | "linkedEventing"
  | "maxLinkedTurnsPerHour"
  | "maxLinkedItems"
  | "linkedRemoteLinks"
  | "linkedDescriptionLinks"
  | "linkedPollIntervalMs"
  | "brief";

/** The linked-eventing fields, in display order. */
const LINKED_FIELDS: readonly EditableField[] = ["linkedEventing", "maxLinkedTurnsPerHour", "maxLinkedItems", "linkedRemoteLinks", "linkedDescriptionLinks", "linkedPollIntervalMs"];

const EDITABLE_FIELDS: readonly EditableField[] = [
  "id",
  "resourceProvider",
  "query",
  "enabled",
  "preference",
  "permissionMode",
  "lizardMode",
  "role",
  "idlePokeMinutes",
  "idlePokeMessage",
  "idlePokeEnabled",
  "execution",
  "resumeOnRespawn",
  "resumeContextCutoff",
  "notifyDeliveryMode",
  "stalledMinutes",
  ...LINKED_FIELDS,
  "brief",
];

export const BUILTIN_BRIEF_PREFIX = "@builtin:";
export const DEFAULT_BRIEF = "@builtin:task";

/** `:` is outside the rule-id alphabet (`isRuleId`), so a new rule's key can never equal a saved rule's id (which is its key). */
export const DRAFT_KEY_PREFIX = "new:";

/** Same rule as the server's `isRuleId` (`src/rules/agent-key.ts`), restated because that module's value imports reach `node:path`, which the browser bundle cannot load. */
const RULE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RULE_ID_MAX = 64;

export function isValidRuleId(id: string): boolean {
  return id.length <= RULE_ID_MAX && RULE_ID_RE.test(id);
}

/** `briefs` holds the full briefs loaded so far (by rule id); a rule whose brief isn't loaded gets `brief: null`. */
export function draftFromRule(rule: RuleDto, briefs: Readonly<Record<string, string>> = {}): RuleDraft {
  const first = rule.agentPreferences[0];
  return {
    key: rule.id,
    isNew: false,
    id: rule.id,
    resourceProvider: rule.resourceProvider,
    query: rule.query,
    enabled: rule.enabled,
    preference: first ? { harness: first.harness, model: first.model ?? "", effort: first.effort ?? "" } : null,
    permissionMode: rule.permissionMode ?? "",
    lizardMode: rule.lizardMode ?? false,
    role: rule.role ?? "worker",
    idlePokeMinutes: rule.idlePokeMinutes != null ? String(rule.idlePokeMinutes) : "",
    idlePokeMessage: rule.idlePokeMessage ?? "",
    idlePokeEnabled: rule.idlePokeEnabled ?? false,
    execution: rule.execution,
    resumeOnRespawn: rule.resumeOnRespawn !== false,
    resumeContextCutoff: rule.resumeContextCutoff != null ? String(rule.resumeContextCutoff) : "",
    notifyDeliveryMode: rule.notifyDeliveryMode ?? "",
    stalledMinutes: rule.stalledMinutes != null ? String(rule.stalledMinutes) : "",
    linkedEventing: rule.linkedEventing === true,
    maxLinkedTurnsPerHour: rule.maxLinkedTurnsPerHour != null ? String(rule.maxLinkedTurnsPerHour) : "",
    maxLinkedItems: rule.maxLinkedItems != null ? String(rule.maxLinkedItems) : "",
    linkedRemoteLinks: rule.linkedRemoteLinks === true,
    linkedDescriptionLinks: rule.linkedDescriptionLinks === true,
    linkedPollIntervalMs: rule.linkedPollIntervalMs != null ? String(rule.linkedPollIntervalMs) : "",
    brief: briefs[rule.id] ?? null,
    deleted: false,
  };
}

function sameValue(a: RuleDraft[EditableField], b: RuleDraft[EditableField]): boolean {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    return a.harness === b.harness && a.model === b.model && a.effort === b.effort;
  }
  return false;
}

export interface RulesDraftState {
  /** The server snapshot this draft was started (or last rebased) from. */
  base: readonly RuleDto[];
  /** `base`'s `sourceEtag` — the `ifMatch` the first save step sends. */
  baseEtag: string;
  /** The draft, in display order: saved rules in file order, then new ones. */
  rules: readonly RuleDraft[];
  nextDraftNo: number;
  /** Full briefs loaded so far, by rule id — the base values a brief edit is compared against. */
  briefs: Readonly<Record<string, string>>;
}

export function initialDraftState(rules: readonly RuleDto[], etag: string): RulesDraftState {
  return { base: rules, baseEtag: etag, rules: rules.map((r) => draftFromRule(r)), nextDraftNo: 1, briefs: {} };
}

export type RulesDraftAction =
  /**
   * Move onto a newer server snapshot, keeping only edits the snapshot
   * doesn't already contain. `created` maps draft keys to the ids the server
   * created for them; `briefs` carries briefs this save just wrote, so they
   * become the new base without a reload.
   */
  | { type: "rebase"; rules: readonly RuleDto[]; etag: string; created?: Readonly<Record<string, string>>; briefs?: Readonly<Record<string, string>> }
  /** A saved rule's full brief arrived (it's loaded on demand, when its card opens). */
  | { type: "brief-loaded"; id: string; brief: string }
  | { type: "edit"; key: string; changes: Partial<Pick<RuleDraft, EditableField>> }
  | { type: "add"; resourceProvider: ResourceProvider; query?: string }
  | { type: "duplicate"; key: string }
  /** A new rule is dropped; a saved one is marked for deletion. */
  | { type: "remove"; key: string }
  /** Undo everything on one card: a new rule is dropped, a saved one goes back to its base values. */
  | { type: "restore"; key: string }
  | { type: "discard-all" };

export function newDraftKey(n: number): string {
  return `${DRAFT_KEY_PREFIX}${n}`;
}

function uniqueCopyId(sourceId: string, taken: ReadonlySet<string>): string {
  const stem = sourceId.slice(0, RULE_ID_MAX - 7).replace(/-+$/, "") || "rule";
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${stem}-copy` : `${stem}-copy-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Three-way merge used by `rebase`: fields the person changed (draft ≠ old base) keep their value, everything else takes the server's fresh value. */
function mergeOntoFresh(oldBase: RuleDraft | undefined, draft: RuleDraft, fresh: RuleDraft): RuleDraft {
  if (!oldBase) return fresh;
  const merged: RuleDraft = { ...fresh, deleted: draft.deleted };
  for (const field of EDITABLE_FIELDS) {
    if (!sameValue(draft[field], oldBase[field])) (merged as unknown as Record<EditableField, unknown>)[field] = draft[field];
  }
  return merged;
}

export function rulesDraftReducer(state: RulesDraftState, action: RulesDraftAction): RulesDraftState {
  switch (action.type) {
    case "rebase": {
      const created = action.created ?? {};
      // Briefs this save wrote are the new base; a loaded brief whose excerpt no longer matches the server's is stale and dropped.
      const briefs: Record<string, string> = { ...state.briefs, ...(action.briefs ?? {}) };
      for (const r of action.rules) {
        const known = briefs[r.id];
        if (known !== undefined && r.briefExcerpt !== undefined && r.briefExcerpt !== known.slice(0, r.briefExcerpt.length)) delete briefs[r.id];
      }
      const freshById = new Map(action.rules.map((r) => [r.id, r]));
      const oldBaseById = new Map(state.base.map((r) => [r.id, r]));
      const seen = new Set<string>();
      const next: RuleDraft[] = [];
      for (const draft of state.rules) {
        if (draft.isNew) {
          const createdId = created[draft.key];
          const fresh = createdId !== undefined ? freshById.get(createdId) : undefined;
          if (fresh) {
            seen.add(fresh.id);
            next.push(draftFromRule(fresh, briefs));
          } else {
            next.push(draft);
          }
          continue;
        }
        const fresh = freshById.get(draft.id);
        if (!fresh) continue; // gone on the server — deleted by this save or by someone else
        seen.add(fresh.id);
        const oldBase = oldBaseById.get(draft.id);
        next.push(mergeOntoFresh(oldBase ? draftFromRule(oldBase, state.briefs) : undefined, draft, draftFromRule(fresh, briefs)));
      }
      const appeared = action.rules.filter((r) => !seen.has(r.id)).map((r) => draftFromRule(r, briefs));
      // Saved rules stay in file order; rules still only in the draft stay last.
      const saved = [...next.filter((d) => !d.isNew), ...appeared];
      const order = new Map(action.rules.map((r, i) => [r.id, i]));
      saved.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return { ...state, base: action.rules, baseEtag: action.etag, briefs, rules: [...saved, ...next.filter((d) => d.isNew)] };
    }
    case "brief-loaded":
      return {
        ...state,
        briefs: { ...state.briefs, [action.id]: action.brief },
        rules: state.rules.map((d) => (!d.isNew && d.id === action.id && d.brief === null ? { ...d, brief: action.brief } : d)),
      };
    case "edit":
      return { ...state, rules: state.rules.map((d) => (d.key === action.key ? { ...d, ...action.changes } : d)) };
    case "add": {
      const key = newDraftKey(state.nextDraftNo);
      const draft: RuleDraft = {
        key,
        isNew: true,
        id: "",
        resourceProvider: action.resourceProvider,
        query: action.query ?? "",
        enabled: false,
        preference: null,
        permissionMode: "",
        lizardMode: false,
        role: action.resourceProvider === "jira-project" ? "sentinel" : "worker",
        idlePokeMinutes: "",
        idlePokeMessage: "",
        idlePokeEnabled: false,
        execution: "swarm",
        resumeOnRespawn: true,
        resumeContextCutoff: "",
        notifyDeliveryMode: "",
        stalledMinutes: "",
        linkedEventing: false,
        maxLinkedTurnsPerHour: "",
        maxLinkedItems: "",
        linkedRemoteLinks: false,
        linkedDescriptionLinks: false,
        linkedPollIntervalMs: "",
        brief: DEFAULT_BRIEF,
        deleted: false,
      };
      return { ...state, rules: [...state.rules, draft], nextDraftNo: state.nextDraftNo + 1 };
    }
    case "duplicate": {
      const source = state.rules.find((d) => d.key === action.key);
      if (!source) return state;
      const key = newDraftKey(state.nextDraftNo);
      const taken = new Set(state.rules.map((d) => d.id));
      const copy: RuleDraft = {
        ...source,
        key,
        isNew: true,
        id: uniqueCopyId(source.id || "rule", taken),
        // New rules are always created off (the server never accepts `enabled` on create).
        enabled: false,
        // Idle-poke settings can't be sent on create; the copy starts from the defaults.
        idlePokeMinutes: "",
        idlePokeMessage: "",
        idlePokeEnabled: false,
        // The page loads the source's brief before duplicating; the default is only a last resort.
        brief: source.brief ?? DEFAULT_BRIEF,
        deleted: false,
      };
      return { ...state, rules: [...state.rules, copy], nextDraftNo: state.nextDraftNo + 1 };
    }
    case "remove": {
      const target = state.rules.find((d) => d.key === action.key);
      if (!target) return state;
      if (target.isNew) return { ...state, rules: state.rules.filter((d) => d.key !== action.key) };
      return { ...state, rules: state.rules.map((d) => (d.key === action.key ? { ...d, deleted: true } : d)) };
    }
    case "restore": {
      const target = state.rules.find((d) => d.key === action.key);
      if (!target) return state;
      if (target.isNew) return { ...state, rules: state.rules.filter((d) => d.key !== action.key) };
      const base = state.base.find((r) => r.id === target.id);
      if (!base) return state;
      return { ...state, rules: state.rules.map((d) => (d.key === action.key ? draftFromRule(base, state.briefs) : d)) };
    }
    case "discard-all":
      return { ...state, rules: state.base.map((r) => draftFromRule(r, state.briefs)) };
  }
}

// ---------------------------------------------------------------------------
// Derived: per-rule diffs, status, validation
// ---------------------------------------------------------------------------

export function baseDraftFor(state: RulesDraftState, draft: RuleDraft): RuleDraft | undefined {
  if (draft.isNew) return undefined;
  const base = state.base.find((r) => r.id === draft.id);
  return base ? draftFromRule(base, state.briefs) : undefined;
}

/** `@builtin:<name>` → `name`, anything else → `null` (custom text). */
export function builtinBriefName(brief: string): string | null {
  return brief.startsWith(BUILTIN_BRIEF_PREFIX) ? brief.slice(BUILTIN_BRIEF_PREFIX.length) : null;
}

/** How a brief reads in a summary or a diff: the built-in's name, or the first line of custom text. */
export function briefText(brief: string | null): string {
  if (brief === null) return "(not loaded)";
  const name = builtinBriefName(brief);
  if (name !== null) return `built-in "${name}"`;
  const firstLine = brief.trim().split("\n")[0] ?? "";
  return `custom: ${firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine}`;
}

export function executionText(mode: ExecutionMode): string {
  switch (mode) {
    case "swarm":
      return "swarm (one agent per matching ticket)";
    case "singleton":
      return "singleton (one agent for the whole query)";
    case "persistent":
      return "persistent (one agent, always running)";
  }
}

export function preferenceText(pref: PreferenceDraft | null): string {
  if (!pref) return "butchr's global agent config";
  const parts: string[] = [pref.harness, pref.model || "default model"];
  if (pref.effort) parts.push(`${pref.effort} effort`);
  return parts.join(" · ");
}

export function permissionText(mode: RulePermissionMode | ""): string {
  return mode === "" ? "butchr's default" : mode;
}

/** What each permission mode does. `manual` is Claude's other name for `default`, and `auto` is a classifier's judgment, not a skip (FACTORY-275). */
const PERMISSION_MODE_DESCRIPTIONS: Readonly<Record<RulePermissionMode, string>> = {
  default: "Asks before each action that needs permission.",
  manual: "Another name for default.",
  acceptEdits: "Accepts file edits without asking; asks before anything else.",
  bypassPermissions: "Unattended mode: skips every permission check.",
  plan: "Plans without changing anything.",
  auto: "A model classifier answers each permission prompt, and can still say no.",
};

export function permissionDescription(mode: RulePermissionMode | ""): string {
  // butchr launches a rule without a mode in acceptEdits (`DEFAULT_PERMISSION_MODE`, src/agents/argv.ts).
  return mode === "" ? "Same as acceptEdits." : (PERMISSION_MODE_DESCRIPTIONS[mode] ?? "");
}

export function idlePokeText(d: Pick<RuleDraft, "idlePokeEnabled" | "idlePokeMinutes" | "idlePokeMessage">): string {
  if (!d.idlePokeEnabled) return "off";
  const every = d.idlePokeMinutes ? `every ${d.idlePokeMinutes} min` : "at the global stall threshold";
  return d.idlePokeMessage ? `${every}, custom message` : every;
}

export interface FieldChange {
  field: EditableField;
  label: string;
  from: string;
  to: string;
}

const FIELD_LABELS: Record<EditableField, string> = {
  id: "Id",
  resourceProvider: "Provider",
  query: "Query",
  enabled: "Status",
  preference: "Agent",
  permissionMode: "Permission mode",
  lizardMode: "Lizard mode",
  role: "Fleet capacity",
  idlePokeMinutes: "Idle poke interval",
  idlePokeMessage: "Idle poke message",
  idlePokeEnabled: "Idle poke",
  execution: "Execution",
  resumeOnRespawn: "Resume on respawn",
  resumeContextCutoff: "Resume context cutoff",
  notifyDeliveryMode: "Notification delivery",
  stalledMinutes: "Stall threshold",
  linkedEventing: "Linked-change events",
  maxLinkedTurnsPerHour: "Linked wakes per hour",
  maxLinkedItems: "Linked items watched",
  linkedRemoteLinks: "Follow remote links",
  linkedDescriptionLinks: "Follow description links",
  linkedPollIntervalMs: "Linked poll interval",
  brief: "Brief",
};

/** butchr's own defaults for a rule with linked-change events on (`DEFAULT_MAX_LINKED_TURNS_PER_HOUR`/`DEFAULT_MAX_LINKED_ITEMS`, `src/jira-watch/linked-eventing.ts`), restated for the browser bundle. */
export const DEFAULT_LINKED_TURNS_PER_HOUR = 2;
export const DEFAULT_LINKED_ITEMS = 25;

/** How butchr sends this rule's agents ticket updates (`Rule.notifyDeliveryMode`, FACTORY-1010). */
export function notifyDeliveryText(mode: NotifyDeliveryMode | ""): string {
  if (mode === "channel") return "channel only";
  if (mode === "prompt") return "direct prompt only";
  return "channel, then prompt (default)";
}

function fieldText(field: EditableField, d: RuleDraft): string {
  switch (field) {
    case "id":
      return d.id || "(no id)";
    case "resourceProvider":
      return d.resourceProvider;
    case "query":
      return d.query || "(empty)";
    case "enabled":
      return d.enabled ? "On" : "Off";
    case "preference":
      return preferenceText(d.preference);
    case "permissionMode":
      return permissionText(d.permissionMode);
    case "lizardMode":
      return d.lizardMode ? "on" : "off";
    case "role":
      return d.role === "worker" ? "counted" : "not counted (sentinel)";
    case "idlePokeMinutes":
      return d.idlePokeMinutes ? `${d.idlePokeMinutes} min` : "global stall threshold";
    case "idlePokeMessage":
      return d.idlePokeMessage || "default message";
    case "idlePokeEnabled":
      return d.idlePokeEnabled ? "on" : "off";
    case "execution":
      return d.execution;
    case "resumeOnRespawn":
      return d.resumeOnRespawn ? "on" : "off";
    case "resumeContextCutoff":
      return d.resumeContextCutoff || "default";
    case "notifyDeliveryMode":
      return notifyDeliveryText(d.notifyDeliveryMode);
    case "stalledMinutes":
      return d.stalledMinutes ? `${d.stalledMinutes} min` : "butchr's default";
    case "linkedEventing":
      return d.linkedEventing ? "on" : "off";
    case "maxLinkedTurnsPerHour":
      return `${d.maxLinkedTurnsPerHour || `${DEFAULT_LINKED_TURNS_PER_HOUR} (default)`} per hour`;
    case "maxLinkedItems":
      return d.maxLinkedItems || `${DEFAULT_LINKED_ITEMS} (default)`;
    case "linkedRemoteLinks":
      return d.linkedRemoteLinks ? "on" : "off";
    case "linkedDescriptionLinks":
      return d.linkedDescriptionLinks ? "on" : "off";
    case "linkedPollIntervalMs":
      return d.linkedPollIntervalMs ? `${d.linkedPollIntervalMs} ms` : "every poll (default)";
    case "brief":
      return briefText(d.brief);
  }
}

/** What changed on one card, for the card's undo modal and the review list. A new rule lists every field it sets. */
export function diffRule(base: RuleDraft | undefined, draft: RuleDraft): FieldChange[] {
  if (draft.deleted) return [];
  if (!base) {
    const shown: EditableField[] = ["id", "resourceProvider", "query", "preference", "permissionMode", "lizardMode", "role", "execution", "resumeOnRespawn", "resumeContextCutoff", "notifyDeliveryMode", "stalledMinutes", ...(draft.linkedEventing ? LINKED_FIELDS : []), "brief"];
    return shown.map((field) => ({ field, label: FIELD_LABELS[field], from: "", to: fieldText(field, draft) }));
  }
  return EDITABLE_FIELDS.filter((f) => !sameValue(base[f], draft[f])).map((field) => ({ field, label: FIELD_LABELS[field], from: fieldText(field, base), to: fieldText(field, draft) }));
}

export type RuleIssueLevel = "incomplete" | "invalid";

export interface RuleIssue {
  field: EditableField;
  level: RuleIssueLevel;
  message: string;
}

export function validateRule(draft: RuleDraft, base: RuleDraft | undefined, all: readonly RuleDraft[]): RuleIssue[] {
  if (draft.deleted) return [];
  const issues: RuleIssue[] = [];
  if (draft.isNew) {
    const id = draft.id.trim();
    if (id === "") issues.push({ field: "id", level: "incomplete", message: "Give the rule an id." });
    else if (!isValidRuleId(id)) issues.push({ field: "id", level: "invalid", message: `Use lowercase letters, numbers and single hyphens (up to ${RULE_ID_MAX} characters).` });
    else if (all.some((other) => other.key !== draft.key && !other.deleted && other.id === id)) issues.push({ field: "id", level: "invalid", message: "Another rule already uses this id." });
  }
  if (draft.query.trim() === "") issues.push({ field: "query", level: "incomplete", message: "Add a query." });
  else if (draft.enabled && draft.query.trim() === PLACEHOLDER_QUERY) issues.push({ field: "query", level: "invalid", message: "Replace the placeholder query before turning this rule on." });
  if (base && base.permissionMode !== "" && draft.permissionMode === "") {
    issues.push({ field: "permissionMode", level: "invalid", message: "butchr can't reset a permission mode back to its default from here yet. Pick a mode." });
  }
  if (draft.idlePokeMinutes !== "" && !/^[1-9]\d*$/.test(draft.idlePokeMinutes)) {
    issues.push({ field: "idlePokeMinutes", level: "invalid", message: "Use a whole number of minutes, 1 or more." });
  } else if (base && base.idlePokeMinutes !== "" && draft.idlePokeMinutes === "") {
    issues.push({ field: "idlePokeMinutes", level: "invalid", message: "Going back to the global stall threshold isn't supported here yet." });
  }
  if (base && base.idlePokeMessage !== "" && draft.idlePokeMessage === "") {
    issues.push({ field: "idlePokeMessage", level: "invalid", message: "Going back to the default message isn't supported here yet." });
  }
  if (draft.resumeContextCutoff !== "" && !/^[1-9]\d*$/.test(draft.resumeContextCutoff)) {
    issues.push({ field: "resumeContextCutoff", level: "invalid", message: "Use a whole number, 1 or more, or leave it empty for the default." });
  }
  if (draft.stalledMinutes !== "" && !(Number.isFinite(Number(draft.stalledMinutes)) && Number(draft.stalledMinutes) > 0)) {
    issues.push({ field: "stalledMinutes", level: "invalid", message: "Use a number of minutes above 0, or leave it empty for butchr's default." });
  }
  for (const field of ["maxLinkedTurnsPerHour", "maxLinkedItems", "linkedPollIntervalMs"] as const) {
    if (draft[field] !== "" && !/^[1-9]\d*$/.test(draft[field])) {
      issues.push({ field, level: "invalid", message: "Use a whole number, 1 or more, or leave it empty for butchr's default." });
    }
  }
  if (draft.brief !== null && draft.brief.trim() === "") {
    issues.push({ field: "brief", level: "invalid", message: "The brief can't be empty." });
  }
  return issues;
}

/** Problems outrank change markers. */
export type RuleCardStatus = "invalid" | "incomplete" | "deleted" | "added" | "edited" | "clean";

export function ruleStatus(draft: RuleDraft, base: RuleDraft | undefined, issues: readonly RuleIssue[]): RuleCardStatus {
  if (issues.some((i) => i.level === "invalid")) return "invalid";
  if (issues.some((i) => i.level === "incomplete")) return "incomplete";
  if (draft.deleted) return "deleted";
  if (draft.isNew) return "added";
  return diffRule(base, draft).length > 0 ? "edited" : "clean";
}

export interface RuleRowState {
  draft: RuleDraft;
  base: RuleDraft | undefined;
  issues: RuleIssue[];
  status: RuleCardStatus;
  changes: FieldChange[];
  dirty: boolean;
}

export interface DraftSummary {
  rows: RuleRowState[];
  dirty: boolean;
  added: number;
  edited: number;
  deleted: number;
  /** `"valid"` only when nothing on the page is incomplete or invalid. */
  validity: "valid" | "incomplete" | "invalid";
}

export function summarizeDraft(state: RulesDraftState): DraftSummary {
  const rows = state.rules.map((draft) => {
    const base = baseDraftFor(state, draft);
    const issues = validateRule(draft, base, state.rules);
    const changes = diffRule(base, draft);
    const dirty = draft.isNew || draft.deleted || changes.length > 0;
    return { draft, base, issues, status: ruleStatus(draft, base, issues), changes, dirty };
  });
  const dirtyRows = rows.filter((r) => r.dirty);
  const issues = dirtyRows.flatMap((r) => r.issues);
  return {
    rows,
    dirty: dirtyRows.length > 0,
    added: dirtyRows.filter((r) => r.draft.isNew).length,
    edited: dirtyRows.filter((r) => !r.draft.isNew && !r.draft.deleted).length,
    deleted: dirtyRows.filter((r) => r.draft.deleted).length,
    validity: issues.some((i) => i.level === "invalid") ? "invalid" : issues.some((i) => i.level === "incomplete") ? "incomplete" : "valid",
  };
}

// ---------------------------------------------------------------------------
// Derived: the write steps a save performs, in execution order
// ---------------------------------------------------------------------------

export type RuleChange =
  | { kind: "disable"; key: string; ruleId: string }
  | { kind: "delete"; key: string; ruleId: string }
  | { kind: "update"; key: string; ruleId: string; patch: RuleFieldPatch }
  | { kind: "create"; key: string; ruleId: string; draft: RuleCreateDraft }
  | { kind: "enable"; key: string; ruleId: string };

function preferencePatch(pref: PreferenceDraft): RuleAgentPreferencePatch & { harness: AgentHarness } {
  const entry: RuleAgentPreferencePatch & { harness: AgentHarness } = { harness: pref.harness };
  if (pref.model) entry.model = pref.model;
  if (pref.effort) entry.effort = pref.effort;
  return entry;
}

/**
 * The `PUT /api/rules/:id` body for one saved rule — same diff-only
 * discipline as `RuleEditDialog`'s `buildFieldsPatch`. `baseBrief` is the
 * rule's loaded full brief (`null` if it was never loaded); a brief the
 * person typed is sent whenever it differs from that.
 */
export function buildFieldPatch(base: RuleDto, draft: RuleDraft, baseBrief: string | null = null): RuleFieldPatch {
  const patch: RuleFieldPatch = {};
  if (draft.query !== base.query) patch.query = draft.query;
  if (draft.permissionMode !== (base.permissionMode ?? "") && draft.permissionMode !== "") patch.permissionMode = draft.permissionMode;
  if (draft.lizardMode !== (base.lizardMode ?? false)) patch.lizardMode = draft.lizardMode;
  if (draft.role !== (base.role ?? "worker")) patch.role = draft.role;
  const baseMinutes = base.idlePokeMinutes != null ? String(base.idlePokeMinutes) : "";
  if (draft.idlePokeMinutes !== baseMinutes && draft.idlePokeMinutes !== "") patch.idlePokeMinutes = Number(draft.idlePokeMinutes);
  if (draft.idlePokeMessage !== (base.idlePokeMessage ?? "") && draft.idlePokeMessage !== "") patch.idlePokeMessage = draft.idlePokeMessage;
  if (draft.idlePokeEnabled !== (base.idlePokeEnabled ?? false)) patch.idlePokeEnabled = draft.idlePokeEnabled;
  const current = base.agentPreferences[0];
  if (current && draft.preference) {
    const entry = preferencePatch(draft.preference);
    const changed = current.harness !== entry.harness || (current.model ?? "") !== (entry.model ?? "") || (current.effort ?? "") !== (entry.effort ?? "");
    // The server requires the same array length, so later entries are sent back unchanged.
    if (changed) patch.agentPreferences = base.agentPreferences.map((p, i) => (i === 0 ? entry : { harness: p.harness, ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) }));
  }
  if (draft.execution !== base.execution) patch.execution = draft.execution;
  if (draft.resumeOnRespawn !== (base.resumeOnRespawn !== false)) patch.resumeOnRespawn = draft.resumeOnRespawn;
  const baseCutoff = base.resumeContextCutoff != null ? String(base.resumeContextCutoff) : "";
  if (draft.resumeContextCutoff !== baseCutoff) patch.resumeContextCutoff = draft.resumeContextCutoff === "" ? null : Number(draft.resumeContextCutoff);
  // Both clear back to butchr's default with `null`, which the server supports for these two.
  if (draft.notifyDeliveryMode !== (base.notifyDeliveryMode ?? "")) patch.notifyDeliveryMode = draft.notifyDeliveryMode || null;
  const baseStalled = base.stalledMinutes != null ? String(base.stalledMinutes) : "";
  if (draft.stalledMinutes !== baseStalled) patch.stalledMinutes = draft.stalledMinutes === "" ? null : Number(draft.stalledMinutes);
  for (const field of ["linkedEventing", "linkedRemoteLinks", "linkedDescriptionLinks"] as const) {
    if (draft[field] !== (base[field] === true)) patch[field] = draft[field];
  }
  for (const field of ["maxLinkedTurnsPerHour", "maxLinkedItems", "linkedPollIntervalMs"] as const) {
    const baseValue = base[field] != null ? String(base[field]) : "";
    if (draft[field] !== baseValue) patch[field] = draft[field] === "" ? null : Number(draft[field]);
  }
  if (draft.brief !== null && draft.brief !== baseBrief) patch.brief = draft.brief;
  return patch;
}

export function buildCreateDraft(draft: RuleDraft): RuleCreateDraft {
  const create: RuleCreateDraft = { id: draft.id.trim(), resourceProvider: draft.resourceProvider, query: draft.query.trim() };
  if (draft.permissionMode) create.permissionMode = draft.permissionMode;
  if (draft.lizardMode) create.lizardMode = true;
  if (draft.role !== "worker") create.role = draft.role;
  if (draft.preference) create.agentPreferences = [preferencePatch(draft.preference)];
  if (draft.brief !== null && draft.brief !== DEFAULT_BRIEF) create.brief = draft.brief;
  if (draft.execution !== "swarm") create.execution = draft.execution;
  if (!draft.resumeOnRespawn) create.resumeOnRespawn = false;
  if (draft.resumeContextCutoff !== "") create.resumeContextCutoff = Number(draft.resumeContextCutoff);
  if (draft.notifyDeliveryMode) create.notifyDeliveryMode = draft.notifyDeliveryMode;
  if (draft.stalledMinutes !== "") create.stalledMinutes = Number(draft.stalledMinutes);
  for (const field of ["linkedEventing", "linkedRemoteLinks", "linkedDescriptionLinks"] as const) if (draft[field]) create[field] = true;
  for (const field of ["maxLinkedTurnsPerHour", "maxLinkedItems", "linkedPollIntervalMs"] as const) if (draft[field] !== "") create[field] = Number(draft[field]);
  return create;
}

/**
 * Execution order: turn rules off first (so their agents stop before
 * anything else changes), then deletes, field updates, creates, and turning
 * rules on last (so a rule starts with its new settings already in place).
 */
export function computeRuleChanges(state: RulesDraftState): RuleChange[] {
  const disables: RuleChange[] = [];
  const deletes: RuleChange[] = [];
  const updates: RuleChange[] = [];
  const creates: RuleChange[] = [];
  const enables: RuleChange[] = [];
  for (const draft of state.rules) {
    if (draft.isNew) {
      creates.push({ kind: "create", key: draft.key, ruleId: draft.id.trim(), draft: buildCreateDraft(draft) });
      continue;
    }
    const base = state.base.find((r) => r.id === draft.id);
    if (!base) continue;
    if (draft.deleted) {
      deletes.push({ kind: "delete", key: draft.key, ruleId: draft.id });
      continue;
    }
    const patch = buildFieldPatch(base, draft, state.briefs[draft.id] ?? null);
    if (Object.keys(patch).length > 0) updates.push({ kind: "update", key: draft.key, ruleId: draft.id, patch });
    if (draft.enabled !== base.enabled) (draft.enabled ? enables : disables).push({ kind: draft.enabled ? "enable" : "disable", key: draft.key, ruleId: draft.id });
  }
  return [...disables, ...deletes, ...updates, ...creates, ...enables];
}

/** Whether a saved rule may be deleted from the page: the server refuses enabled or staffed rules. */
export function deleteBlockedReason(base: RuleDto | undefined): string | null {
  if (!base) return null;
  if (base.enabled) return "Turn this rule off and save before deleting it.";
  if (base.staffed === true) return "Wait for its agents to finish, or stop them, before deleting it.";
  return null;
}
