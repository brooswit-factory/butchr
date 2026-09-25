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
  tier: SessionTier;
  permissionMode: SessionPermissionMode;
  /** Reused verbatim from `Rule` (src/rules/rules.ts) — same type, same validation, same "independent of every other field" semantics. Stored and surfaced; execution-mode RECONCILIATION for an individual definition is not implemented by this ticket (see docs/managed-sessions.md) — the built-in query itself always runs `swarm` (one agent per eligible definition file), which is already "one agent" for every mode at the file granularity this ticket covers. */
  execution: ExecutionMode;
  /** Reused verbatim from `Rule`. Stored only — the Rocket.Chat account lifecycle itself is unimplemented for EVERY provider today (rules.ts's own doc comment), managed sessions included. */
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
}

const DEFINITION_FIELDS = new Set(["workingDirectory", "brief", "vendor", "tier", "permissionMode", "execution", "account", "role", "frozen", "mcpServers"]);

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
  if (!oneOf(SESSION_TIERS, doc.tier)) problems.push(`${at}.tier must be one of ${SESSION_TIERS.join(", ")}`);
  if (!oneOf(SESSION_PERMISSION_MODES, doc.permissionMode)) problems.push(`${at}.permissionMode must be one of ${SESSION_PERMISSION_MODES.join(", ")}`);
  if (doc.execution !== undefined && !oneOf(EXECUTION_MODES, doc.execution)) problems.push(`${at}.execution must be one of ${EXECUTION_MODES.join(", ")}`);
  if (doc.account !== undefined && !oneOf(ACCOUNT_POLICIES, doc.account)) problems.push(`${at}.account must be one of ${ACCOUNT_POLICIES.join(", ")}`);
  if (doc.role !== undefined && !oneOf(AGENT_ROLES, doc.role)) problems.push(`${at}.role must be one of ${AGENT_ROLES.join(", ")}`);
  if (doc.frozen !== undefined && typeof doc.frozen !== "boolean") problems.push(`${at}.frozen must be a boolean`);
  if (doc.mcpServers !== undefined) parseMcpServers(doc.mcpServers, `${at}.mcpServers`, problems);
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
    tier: d.tier as SessionTier,
    permissionMode: d.permissionMode as SessionPermissionMode,
    execution: (d.execution as ExecutionMode | undefined) ?? "swarm",
    account: (d.account as AccountPolicy | undefined) ?? "none",
    role: (d.role as AgentRole | undefined) ?? "worker",
    frozen: (d.frozen as boolean | undefined) ?? false,
    ...(d.mcpServers !== undefined ? { mcpServers: parseMcpServers(d.mcpServers, `${at}.mcpServers`, []) as McpServerBinding[] } : {}),
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
