/**
 * BUTCHR-408 — the managed-session definition format: one JSON file per
 * Butchr-managed agent (a Bakr directory agent, a Candlestix session),
 * living in the well-known directory `sessionDefinitionsPath()` resolves.
 * Kept apart from `src/rules/rules.ts` on purpose: a `Rule` configures ONE
 * uniform policy for every resource it matches, but every definition file
 * needs its OWN vendor/tier/frozen/role — heterogeneous per file, not
 * uniform per rule — so this is validated as its own per-RESOURCE document,
 * not a `Rule` field. `src/rules/session-definition-type.ts` is what reads a
 * matched filesystem resource's content through this parser and turns it
 * into a `SpawnSpec`.
 *
 * Fields that already have a validated home elsewhere are REUSED verbatim,
 * never redefined: `execution`/`account`/`role` are `Rule`'s own types
 * (src/rules/rules.ts) — same enums, same defaults, same "independent of
 * every other field" house style.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "./filesystem-query.js";
import { ACCOUNT_POLICIES, AGENT_ROLES, EXECUTION_MODES, parseMcpServers, type AccountPolicy, type AgentRole, type ExecutionMode, type McpServerBinding } from "../rules/rules.js";
import { formatResourceRef, parseResourceRef } from "./resource-ref.js";
import { powerValueProblems, resolveModelPower, resolveEffortPower, type AgentEffort } from "./power-scale.js";

/** Agent vendors a managed-session definition may name. Narrower than `AGENT_HARNESSES` (src/rules/rules.ts) — `agy` is not a Bakr/Candlestix vendor and is deliberately excluded here, not merely unused. */
export const SESSION_DEFINITION_VENDORS = ["claude", "codex"] as const;
export type SessionDefinitionVendor = (typeof SESSION_DEFINITION_VENDORS)[number];

/**
 * Permission modes a managed session may launch under. `"auto"` is the
 * ticket's own named case — "permission mode, including `auto` with a
 * strict MCP config" (BUTCHR-393/BUTCHR-408) — carried through verbatim to
 * `SpawnSpec.permissionMode` -> Drovr's `ClaudeAgentLaunch.permissionMode`
 * (untyped string there; validated here so a typo fails at load time, not
 * at launch). Codex has no `permissionMode` concept in
 * `CodexAgentLaunch` (its own `trustWorkspace`/`bypassApprovalsAndSandbox`
 * fields instead) — see docs/managed-sessions.md's "Per-vendor launch
 * differences" for what that means for a `vendor: "codex"` definition.
 */
export const SESSION_PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "auto"] as const;
export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number];

/**
 * Model tiers a definition may name, 1-5, PORTED from Candlestix's own
 * `~/.config/candlestix/model-tiers.json` on host Codey. Source: CNDLX-45
 * comment 23525 (John Winstead, "Codey inventory v1", 2026-09-24T22:00Z),
 * relayed on BUTCHR-408 comment 23948 (story agent, 2026-09-24) in answer to
 * this ticket's own `ask_boss`; both read and cross-checked verbatim before
 * porting. CAVEAT carried from that same relay: this is a REPORT of a file
 * none of us can read directly (Codey host access is blocked — CNDLX-45 says
 * so), so it is ported as DATA, not logic, and is UNVERIFIED against the
 * live file — treat a mismatch report against the real Codey file as
 * grounds to fix this table, not the reporter.
 */
export const SESSION_TIERS = ["tier1", "tier2", "tier3", "tier4", "tier5"] as const;
export type SessionTier = (typeof SESSION_TIERS)[number];

/**
 * `(vendor, tier) -> model`. Model choice depends on BOTH fields, not tier
 * alone — Candlestix's own table gives Claude and Codex independent per-tier
 * model strings (see `SESSION_TIERS`'s own doc comment for provenance):
 * claude tiers 1-3 = sonnet, 4-5 = opus; codex tier 1 = gpt-5.6-luna, 2 =
 * gpt-5.6-terra, 3 = gpt-5.6-sol, 4-5 = gpt-6-astra.
 */
const CLAUDE_TIER_MODEL: Record<SessionTier, string> = {
  tier1: "sonnet", tier2: "sonnet", tier3: "sonnet", tier4: "opus", tier5: "opus",
};
const CODEX_TIER_MODEL: Record<SessionTier, string> = {
  tier1: "gpt-5.6-luna", tier2: "gpt-5.6-terra", tier3: "gpt-5.6-sol", tier4: "gpt-6-astra", tier5: "gpt-6-astra",
};

export function tierToModel(vendor: SessionDefinitionVendor, tier: SessionTier): string {
  return (vendor === "codex" ? CODEX_TIER_MODEL : CLAUDE_TIER_MODEL)[tier];
}

/**
 * FACTORY-75 — the ONE exported resolver `specForSessionDefinition`
 * (src/rules/session-definition-type.ts), `buildWorkspace`'s stale-check
 * seam (src/agents/herd.ts's `resolvedAgentOf`), and this ticket's own
 * "visibility" requirement (an exported resolver, not buried in the launch
 * path) all read from — never a second, independently-recomputed copy of
 * this logic anywhere else in this codebase.
 *
 * Deliberately BYPASSES the `modelPower`/`effort` tables entirely for a
 * `tier`-based (deprecated) definition, rather than mapping `tier` onto a
 * scale POINT that happens to resolve to the same model: `tierToModel`
 * above is reused verbatim (byte-identical to before this ticket), and NO
 * `effort` is returned at all for that path (`effort: undefined`) — this is
 * the ONLY way to reproduce today's launch behaviour EXACTLY, not merely
 * approximately:
 *   - Claude: today's managed-session launch already always sends
 *     `--effort` (`ClaudeAgentLaunch.effort` is a REQUIRED field in
 *     `@brooswit/drovr`), defaulting through `agentLaunchConfig`'s own
 *     `agent.effort ?? effortFor(spec.issuetype)` fallback chain
 *     (src/agents/argv.ts/workspace.ts) whenever nothing sets `agent.effort`
 *     — exactly what leaving `effort` unset here preserves, byte-for-byte,
 *     including honouring any global `config.agent.effort` override a
 *     daemon might have configured (a hardcoded "high" here would silently
 *     override that instead).
 *   - Codex: today's managed-session launch sends NO reasoning-effort
 *     override at all (no `.codex/config.toml` `model_reasoning_effort`
 *     line is ever written for a non-`jira-project` spec — see
 *     `buildWorkspace`, src/agents/workspace.ts). Resolving `tier` through
 *     the effort table would ALWAYS produce SOME value and start emitting a
 *     flag that has never been sent before — a real behaviour change this
 *     ticket's own back-compat requirement forbids.
 * A `modelPower`/`effort`-based (new) definition has no such constraint —
 * both axes always resolve to a concrete value, exactly as designed.
 */
export function effectiveAgent(definition: Pick<SessionDefinition, "vendor" | "tier" | "modelPower" | "effort">): { model: string; effort?: AgentEffort } {
  if (definition.tier !== undefined) return { model: tierToModel(definition.vendor, definition.tier) };
  return { model: resolveModelPower(definition.vendor, definition.modelPower!), effort: resolveEffortPower(definition.effort!) };
}

export interface SessionDefinition {
  /**
   * Where the managed agent actually works — a Bakr agent's own project
   * directory, a Candlestix session's own directory. Absolute, or `~`/`~/rest`
   * (expanded against the daemon's own `$HOME`, same rule as a filesystem
   * query's `root` — src/resources/filesystem-query.ts's `expandHome`).
   * `specForSessionDefinition`'s `SpawnSpec.cwd` (src/rules/session-definition-type.ts)
   * carries this through to the agent's own KICKOFF instructions, not the
   * launched process's OS cwd — see `SpawnSpec.cwd`'s own doc comment
   * (src/agents/workspace.ts) for why a literal process-cwd override is
   * unsafe here.
   */
  workingDirectory: string;
  /** The agent's prompt/role. Non-empty; no `@builtin:` resolution (that shorthand is a `Rule` convenience — a definition's brief is always literal). */
  brief: string;
  vendor: SessionDefinitionVendor;
  /**
   * FACTORY-75: DEPRECATED in favour of `modelPower`/`effort` below — kept
   * working, never removed, for the 8 live codey definitions and any other
   * definition still written this way (`sessionDefinitionProblems` logs a
   * deprecation note once per path when this is used, via
   * `onceDeprecatedTier`, src/rules/session-definition-type.ts). A
   * definition sets EITHER `tier` alone OR both `modelPower`/`effort`,
   * never a mix — see `sessionDefinitionProblems`'s own validation for the
   * exact rule and `effectiveAgent` below for how each path resolves.
   */
  tier?: SessionTier;
  /**
   * FACTORY-75 (src/resources/power-scale.ts) — 0-100, which model this
   * definition's agent launches, resolved through that vendor's own table.
   * Required together with `effort` when `tier` is absent; see this
   * interface's own `tier` doc comment for the exclusivity rule.
   */
  modelPower?: number;
  /**
   * FACTORY-75 (src/resources/power-scale.ts) — 0-100, how hard that model
   * thinks, resolved through the shared effort table then translated to
   * this vendor's own CLI/config surface at launch time
   * (`codexReasoningEffortFlag` for Codex; Claude's own `--effort` accepts
   * the resolved `AgentEffort` value directly). Required together with
   * `modelPower` when `tier` is absent.
   */
  effort?: number;
  permissionMode: SessionPermissionMode;
  /**
   * BUTCHR-453/BUTCHR-463 — reaches a Claude launch's
   * `ClaudeAgentLaunch.strictMcpConfig` verbatim (`@brooswit/drovr`; emits
   * `--strict-mcp-config` alongside `--mcp-config`, so Claude Code loads
   * ONLY the servers named in this agent's own `mcp.json` — no project- or
   * user-level `.mcp.json` discovery on top of it). This is what lets a
   * definition express the Candlestix directors' "permission mode auto with
   * a strict MCP config" faithfully; `assertNoInheritedMcpConfig`
   * (src/agents/workspace.ts) is a related but narrower guarantee (no
   * PROJECT-level `.mcp.json` inherited from an ancestor directory) that
   * does not exclude user-level config the way this field does — see
   * docs/managed-sessions.md's "Nexus's MCP isolation constraint" for both.
   * `"codex"` has no equivalent concept — REJECTED at manifest load for a
   * `vendor: "codex"` definition (see `sessionDefinitionProblems`), a
   * deliberate departure from `permissionMode`'s own precedent (which is
   * validated/stored but silently never forwarded to a Codex launch): a
   * silently-ignored `permissionMode` is cosmetic, but a silently-ignored
   * `strictMcpConfig` would leave an operator believing they have an
   * MCP-isolation property they don't — the exact silent-loss failure mode
   * this field exists to close. Absent/`false` means today's behaviour
   * exactly — no flag, ordinary discovery.
   */
  strictMcpConfig?: boolean;
  /** Reused verbatim from `Rule` (src/rules/rules.ts) — same type, same validation, same "independent of every other field" semantics. Stored and surfaced; execution-mode RECONCILIATION for an individual definition is not implemented by this ticket (see docs/managed-sessions.md) — the built-in query itself always runs `swarm` (one agent per eligible definition file), which is already "one agent" for every mode at the file granularity this ticket covers. */
  execution: ExecutionMode;
  /** Reused verbatim from `Rule`. BUTCHR-460: wired, same as every other provider's rule-level `account` — see docs/rocketchat-accounts.md's "Wiring" section (`managedSessionAccountPolicies`, src/daemon/index.ts). */
  account: AccountPolicy;
  /** Reused verbatim from `Rule`. Default `"worker"` — same default as `Rule.role`. */
  role: AgentRole;
  /** Frozen persistent definitions run no agent at all — excluded from the built-in query's eligible set entirely (see session-definition-type.ts). Default `false`. */
  frozen: boolean;
  /**
   * Additional MCP servers this agent may connect to, beyond butchr's own —
   * the ticket's own required field ("MCP server list, with per-MCP
   * notification flags; channel bindings to ANY MCP channel server").
   * `McpServerBinding`/`parseMcpServers` (src/rules/rules.ts) is REUSED
   * verbatim, not redefined: the type was ported there from S4's
   * (BUTCHR-395/BUTCHR-411) `BUTCHR-395` branch (PR #387, merge commit
   * 5520722) per the epic's sequencing decision on BUTCHR-408 (rebase onto
   * `main`, take S4's type as source material, do not wait for its own PR).
   * The per-MCP "notification flag" the ticket names is `channel`, exactly
   * as S4 designed it. Absent means none — today's behaviour exactly.
   */
  mcpServers?: McpServerBinding[];
  /**
   * BUTCHR-456 (BUTCHR-394 T3, CNDLX-45's delegated freeze/unfreeze) —
   * OTHER managed-session definitions (named by file, with or without
   * `.json`) whose agent may call the butchr `freeze_session` MCP tool
   * against THIS definition. Absent/empty means nobody may. Scoping lives
   * at the MCP TOOL boundary (`src/tools/session-freeze-tools.ts`), not
   * here — this field is just the grant an operator writes; see
   * docs/managed-sessions.md's "Delegated freeze/unfreeze" section for the
   * full design and what the boundary is/isn't (a tool-boundary guarantee,
   * not an OS-level one).
   */
  freezeControllers?: string[];
  /**
   * Same shape as `freezeControllers`, for `unfreeze_session` — DELIBERATELY
   * a separate list: listing a controller in `freezeControllers` grants it
   * NOTHING on `unfreeze_session`, and vice versa. Per CNDLX-45's own
   * decision, whether an agent may freeze a definition and whether it may
   * UNFREEZE one are two independent operator judgment calls (unfreezing
   * undoes the very migration this capability exists to protect), so the
   * grant fields must never be merged into one list.
   */
  unfreezeControllers?: string[];
  /**
   * FACTORY-52 (epic FACTORY-51) — opt one or more Jira projects into
   * linked eventing for THIS definition's agent, in the same canonical
   * `jira-project:<KEY>` vocabulary every other resource ref in this
   * codebase already uses (`parseResourceRef`/`formatResourceRef`,
   * ./resource-ref.js), reused verbatim rather than reimplemented — a
   * malformed key fails at manifest LOAD time with the same message an
   * operator would get anywhere else. Deliberately its own field, not a
   * reuse of `Rule.linkedEventing` (src/rules/rules.ts): that field is a
   * per-RULE boolean naming no project, whereas a managed-session
   * definition has no owning `Rule` of its own to hang an opt-in off of and
   * needs to name WHICH project(s), not merely whether. Non-empty array of
   * canonical `jira-project:<KEY>` strings when present; only the
   * `jira-project` provider is accepted (any other — `jira-work-item:...`,
   * `github-issue:...`, ... — is rejected), and duplicate entries (compared
   * by canonical form) are rejected rather than silently deduped, matching
   * `freezeControllers`/`unfreezeControllers`'s own "reject, never silently
   * drop" discipline above. The parsed value is the array of CANONICAL
   * refs (not bare project keys) — same shape a caller would get back from
   * `formatResourceRef` on each entry — so a consumer that already deals in
   * `ResourceRef`/canonical strings elsewhere needs no separate parsing
   * here. Absent means today's behaviour exactly: no project(s) opted in,
   * no key materialises on the parsed definition. Pure additive and
   * PARSE-ONLY — this field is not consulted by any nudge/notify/watch
   * mechanism yet; that wiring is FACTORY-53's own scope (see
   * docs/managed-sessions.md).
   */
  linkedEventingProjects?: string[];
}

const DEFINITION_FIELDS = new Set([
  "workingDirectory", "brief", "vendor", "tier", "modelPower", "effort", "permissionMode", "strictMcpConfig", "execution", "account", "role", "frozen",
  "mcpServers", "freezeControllers", "unfreezeControllers", "linkedEventingProjects",
]);

const MAX_CONTROLLERS_PER_FIELD = 100;
const MAX_CONTROLLER_NAME_CHARS = 200;

/** Strips a trailing ".json" so "foo" and "foo.json" are recognised as the same controller — the same with-or-without-extension convenience `butchr session show/freeze/unfreeze` already extend to a CLI-supplied name. */
const controllerCanonicalName = (raw: string): string => (raw.endsWith(".json") ? raw.slice(0, -5) : raw);

/**
 * `freezeControllers`/`unfreezeControllers`: an array of non-empty file-name
 * strings, no duplicates (compared after stripping a trailing `.json`, so
 * `"a"` and `"a.json"` collide), no path separators, no NUL byte, and no
 * bare `"."`/`".."` — a controller is named by FILE NAME only, never a path,
 * so a grant can never itself be used to smuggle a traversal segment into
 * the resolution the MCP tool later does (src/tools/session-freeze-tools.ts).
 * A definition never needs to list itself, but nothing here forbids it —
 * that's a no-op grant, not an error.
 */
function controllerListProblems(raw: unknown, at: string): string[] {
  if (!Array.isArray(raw)) return [`${at} must be an array of strings`];
  const problems: string[] = [];
  if (raw.length > MAX_CONTROLLERS_PER_FIELD) problems.push(`${at} must not list more than ${MAX_CONTROLLERS_PER_FIELD} controllers`);
  const seen = new Set<string>();
  raw.forEach((v, i) => {
    const pat = `${at}[${i}]`;
    if (typeof v !== "string" || v.trim() === "") { problems.push(`${pat} must be a non-empty string`); return; }
    const name = v.trim();
    if (name.length > MAX_CONTROLLER_NAME_CHARS) { problems.push(`${pat} must be at most ${MAX_CONTROLLER_NAME_CHARS} characters`); return; }
    if (name.includes("/") || name.includes("\\") || name.includes("\0")) { problems.push(`${pat} "${name}" must not contain a path separator`); return; }
    if (name === "." || name === "..") { problems.push(`${pat} "${name}" is not a valid file name`); return; }
    const canonical = controllerCanonicalName(name);
    if (!canonical) { problems.push(`${pat} "${name}" is not a valid file name`); return; }
    if (seen.has(canonical)) { problems.push(`${pat} "${name}" duplicates an earlier entry in the same list`); return; }
    seen.add(canonical);
  });
  return problems;
}

/**
 * `linkedEventingProjects`: each entry must parse as a canonical
 * `jira-project:<KEY>` reference via the shared `parseResourceRef` — a bare
 * project key with no provider prefix (e.g. `"FACTORY"`) is REJECTED, same
 * as everywhere else `ResourceRef`'s canonical form is required, not merely
 * accepted. Duplicates (by canonical form, so the same key written twice,
 * even with different casing before parsing, collides) are rejected rather
 * than silently deduped — see this field's own doc comment on the
 * `SessionDefinition` interface above.
 */
function linkedEventingProjectsProblems(raw: unknown, at: string): string[] {
  if (!Array.isArray(raw)) return [`${at} must be an array of strings`];
  if (raw.length === 0) return [`${at} must not be empty`];
  const problems: string[] = [];
  const seen = new Set<string>();
  raw.forEach((v, i) => {
    const pat = `${at}[${i}]`;
    if (typeof v !== "string" || v.trim() === "") { problems.push(`${pat} must be a non-empty string`); return; }
    let ref;
    try { ref = parseResourceRef(v.trim()); }
    catch (e) { problems.push(`${pat} ${(e as Error).message}`); return; }
    if (ref.provider !== "jira-project") { problems.push(`${pat} "${v.trim()}" must be a jira-project reference (got provider "${ref.provider}")`); return; }
    const canonical = formatResourceRef(ref);
    if (seen.has(canonical)) { problems.push(`${pat} "${v.trim()}" duplicates an earlier entry in the same list (${canonical})`); return; }
    seen.add(canonical);
  });
  return problems;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const oneOf = <T extends string>(options: readonly T[], v: unknown): v is T => typeof v === "string" && (options as readonly string[]).includes(v);

function workingDirectoryProblems(raw: unknown, home: string): string[] {
  if (typeof raw !== "string" || !raw.trim()) return ["workingDirectory must be a non-empty string"];
  const expanded = expandHome(raw.trim(), home);
  if (expanded === null) return [`workingDirectory "${raw}": ~user is not supported; use an absolute path`];
  if (expanded.includes("\0")) return [`workingDirectory "${raw}" contains a NUL byte`];
  if (expanded[0] !== "/") return [`workingDirectory "${raw}" must be absolute (or start with ~)`];
  if (expanded !== "/" && expanded.endsWith("/")) return [`workingDirectory "${raw}" must not have a trailing slash`];
  return [];
}

/** Why a session-definition document is unusable, or `[]`. Same "collect every problem, never touch disk" discipline as `filesystemQueryProblems`. */
export function sessionDefinitionProblems(doc: unknown, at: string, home: string = homedir()): string[] {
  if (!isObject(doc)) return [`${at} must be a JSON object`];
  const problems: string[] = [];
  for (const k of Object.keys(doc)) if (!DEFINITION_FIELDS.has(k)) problems.push(`${at} has unknown field "${k}"`);
  problems.push(...workingDirectoryProblems(doc.workingDirectory, home).map((p) => `${at}.${p}`));
  if (!nonEmpty(doc.brief)) problems.push(`${at}.brief must be a non-empty string`);
  if (!oneOf(SESSION_DEFINITION_VENDORS, doc.vendor)) problems.push(`${at}.vendor must be one of ${SESSION_DEFINITION_VENDORS.join(", ")}`);
  // FACTORY-75: `tier` (deprecated) and `modelPower`+`effort` (the new
  // two-axis mechanism, src/resources/power-scale.ts) are mutually
  // exclusive ways to say the same thing — exactly one of the two shapes
  // must be present, never both (ambiguous precedence) and never neither
  // (every definition must resolve to SOME model). See `effectiveAgent`
  // below for how each shape resolves once valid.
  {
    const hasTier = doc.tier !== undefined;
    const hasModelPower = doc.modelPower !== undefined;
    const hasEffort = doc.effort !== undefined;
    if (hasTier && (hasModelPower || hasEffort)) {
      problems.push(`${at} must not combine deprecated "tier" with "modelPower"/"effort" — use one or the other`);
    } else if (hasTier) {
      if (!oneOf(SESSION_TIERS, doc.tier)) problems.push(`${at}.tier must be one of ${SESSION_TIERS.join(", ")}`);
    } else if (!hasModelPower && !hasEffort) {
      problems.push(`${at} must set either "tier" (deprecated) or both "modelPower" and "effort"`);
    } else {
      if (!hasModelPower) problems.push(`${at}.modelPower is required when "tier" is absent`);
      else problems.push(...powerValueProblems(doc.modelPower, `${at}.modelPower`));
      if (!hasEffort) problems.push(`${at}.effort is required when "tier" is absent`);
      else problems.push(...powerValueProblems(doc.effort, `${at}.effort`));
    }
  }
  if (!oneOf(SESSION_PERMISSION_MODES, doc.permissionMode)) problems.push(`${at}.permissionMode must be one of ${SESSION_PERMISSION_MODES.join(", ")}`);
  if (doc.strictMcpConfig !== undefined) {
    if (typeof doc.strictMcpConfig !== "boolean") problems.push(`${at}.strictMcpConfig must be a boolean`);
    else if (doc.vendor === "codex") problems.push(`${at}.strictMcpConfig is not supported for vendor "codex" — Codex has no strict-MCP-config concept; omit this field for a Codex definition`);
  }
  if (doc.execution !== undefined && !oneOf(EXECUTION_MODES, doc.execution)) problems.push(`${at}.execution must be one of ${EXECUTION_MODES.join(", ")}`);
  if (doc.account !== undefined && !oneOf(ACCOUNT_POLICIES, doc.account)) problems.push(`${at}.account must be one of ${ACCOUNT_POLICIES.join(", ")}`);
  if (doc.role !== undefined && !oneOf(AGENT_ROLES, doc.role)) problems.push(`${at}.role must be one of ${AGENT_ROLES.join(", ")}`);
  if (doc.frozen !== undefined && typeof doc.frozen !== "boolean") problems.push(`${at}.frozen must be a boolean`);
  if (doc.mcpServers !== undefined) parseMcpServers(doc.mcpServers, `${at}.mcpServers`, problems);
  if (doc.freezeControllers !== undefined) problems.push(...controllerListProblems(doc.freezeControllers, `${at}.freezeControllers`));
  if (doc.unfreezeControllers !== undefined) problems.push(...controllerListProblems(doc.unfreezeControllers, `${at}.unfreezeControllers`));
  if (doc.linkedEventingProjects !== undefined) problems.push(...linkedEventingProjectsProblems(doc.linkedEventingProjects, `${at}.linkedEventingProjects`));
  return problems;
}

/** Throws with every collected problem (see `sessionDefinitionProblems`) when the document is invalid. Callers pass the raw parsed JSON — `parseSessionDefinitionFile` below is the read+JSON.parse+validate convenience most callers actually want. */
export function parseSessionDefinition(doc: unknown, at: string, home: string = homedir()): SessionDefinition {
  const problems = sessionDefinitionProblems(doc, at, home);
  if (problems.length) throw new Error(problems.join("\n"));
  const d = doc as Record<string, unknown>;
  return {
    workingDirectory: expandHome((d.workingDirectory as string).trim(), home)!,
    brief: (d.brief as string).trim(),
    vendor: d.vendor as SessionDefinitionVendor,
    ...(d.tier !== undefined ? { tier: d.tier as SessionTier } : {}),
    ...(d.modelPower !== undefined ? { modelPower: d.modelPower as number } : {}),
    ...(d.effort !== undefined ? { effort: d.effort as number } : {}),
    permissionMode: d.permissionMode as SessionPermissionMode,
    ...(d.strictMcpConfig !== undefined ? { strictMcpConfig: d.strictMcpConfig as boolean } : {}),
    execution: (d.execution as ExecutionMode | undefined) ?? "swarm",
    account: (d.account as AccountPolicy | undefined) ?? "none",
    role: (d.role as AgentRole | undefined) ?? "worker",
    frozen: (d.frozen as boolean | undefined) ?? false,
    ...(d.mcpServers !== undefined ? { mcpServers: parseMcpServers(d.mcpServers, `${at}.mcpServers`, []) as McpServerBinding[] } : {}),
    ...(d.freezeControllers !== undefined ? { freezeControllers: (d.freezeControllers as string[]).map((s) => s.trim()) } : {}),
    ...(d.unfreezeControllers !== undefined ? { unfreezeControllers: (d.unfreezeControllers as string[]).map((s) => s.trim()) } : {}),
    ...(d.linkedEventingProjects !== undefined
      ? { linkedEventingProjects: (d.linkedEventingProjects as string[]).map((s) => formatResourceRef(parseResourceRef(s.trim()))) }
      : {}),
  };
}

/** Parses a definition file's raw text: JSON syntax errors are reported the same way `loadRules` reports a bad rules.json — one clear message, never a stack trace. */
export function parseSessionDefinitionFile(text: string, at: string, home: string = homedir()): SessionDefinition {
  let doc: unknown;
  try { doc = JSON.parse(text); }
  catch (e) { throw new Error(`${at}: invalid JSON: ${(e as Error).message}`); }
  return parseSessionDefinition(doc, at, home);
}

export interface SessionDefinitionsEnv { [name: string]: string | undefined; BUTCHR_SESSION_DEFINITIONS_DIR?: string | undefined; XDG_CONFIG_HOME?: string | undefined; HOME?: string | undefined }

/**
 * Where managed-session definition files live: explicit override, else the
 * XDG config dir — the SAME resolution shape as `rulesPath` (src/rules/rules.ts),
 * deliberately: an operator who already knows how `BUTCHR_RULES_FILE`/
 * `rules.json` resolve should recognise this immediately. Unlike `rulesPath`,
 * this names a DIRECTORY (one file per managed agent), not a single file.
 */
export function sessionDefinitionsPath(env: SessionDefinitionsEnv = process.env): string {
  if (env.BUTCHR_SESSION_DEFINITIONS_DIR?.trim()) return env.BUTCHR_SESSION_DEFINITIONS_DIR.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(xdg, "butchr", "session-definitions");
}

/**
 * BUTCHR-455 review fix: `builtinManagedSessionsRule`'s own query
 * (`{root, kind: "file", maxDepth: 1}`) has no name filter, and
 * `listFilesystemResources` does not skip dotfiles — so a temp file a
 * writer leaves in the ACTIVE directory mid-write (`writeFileAtomic`'s own
 * `.<uuid>.tmp`, used by `create`, `freeze`/`unfreeze`'s manifest rewrite,
 * and this ticket's own cross-filesystem `unarchive` fallback) is a
 * CANDIDATE definition for the brief window between its write and its
 * rename into the real name. If a poll lands in that window and the temp
 * content happens to already be a valid, non-frozen manifest (true for
 * every one of those writers, which all write/rewrite a full valid
 * document), it would be staffed as a SECOND agent under a path-derived
 * key that has no relationship to the real definition's own freeze state —
 * breaking "one agent per eligible definition" and, worse, able to run
 * un-frozen while the real definition is still store-frozen. Both
 * `searchSessionDefinitions` (`src/rules/session-definition-type.ts`) and
 * `listSessionDefinitions` (`src/resources/session-definition-manage.ts`)
 * call this FIRST, before any oversized/parse/frozen check, and skip a
 * hidden entry SILENTLY — never logged as invalid, never listed at all —
 * because a hidden file was never offered as a definition in the first
 * place; it's not a broken one.
 */
export function isHiddenDefinitionFile(basename: string): boolean {
  return basename.startsWith(".");
}
