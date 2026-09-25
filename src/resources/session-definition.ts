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
import { ACCOUNT_POLICIES, AGENT_ROLES, EXECUTION_MODES, type AccountPolicy, type AgentRole, type ExecutionMode } from "../rules/rules.js";

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
 * Model tiers a definition may name, mapped to a concrete model by
 * `tierToModel`. PROVISIONAL pending the real Candlestix tier -> model table
 * (asked of the boss on BUTCHR-408 2026-09-25 — the preserved branch the
 * ticket names, `preserve/candlestix-runtime-f198ae1`, does not exist
 * anywhere reachable from this workspace, and the candlestix repo under
 * ~/code carries no tier/model mapping in any branch, tag, or even
 * unreachable git object; searched exhaustively). `tier1 -> "sonnet"` is the
 * one entry independently confirmed by BUTCHR-393's own ticket text ("10 MUD
 * players: Claude at tier 1 (sonnet)"); `tier0`/`tier2` follow the same
 * cheap/default/expensive shape `modelFor` (src/agents/workspace.ts) already
 * uses for issue types, but are NOT independently confirmed — see
 * `tierToModel`'s own doc comment. Update BOTH `SESSION_TIERS` and
 * `tierToModel` together if the real table turns out different; nothing
 * else in this module encodes tier names.
 */
export const SESSION_TIERS = ["tier0", "tier1", "tier2"] as const;
export type SessionTier = (typeof SESSION_TIERS)[number];

/** `tier -> model`. See `SESSION_TIERS`'s own doc comment for provenance/confidence per entry. */
export function tierToModel(tier: SessionTier): string {
  return { tier0: "haiku", tier1: "sonnet", tier2: "opus" }[tier];
}

export interface SessionDefinition {
  /**
   * Where the managed agent actually works — a Bakr agent's own project
   * directory, a Candlestix session's own directory. Absolute, or `~`/`~/rest`
   * (expanded against the daemon's own `$HOME`, same rule as a filesystem
   * query's `root` — src/resources/filesystem-query.ts's `expandHome`).
   * `session-definition-type.ts`'s `SpawnSpec.cwd` carries this straight
   * through as the spawned agent's REAL process cwd (see that module's own
   * doc comment for the workspace-identity tradeoff this implies).
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
}

const DEFINITION_FIELDS = new Set(["workingDirectory", "brief", "vendor", "tier", "permissionMode", "execution", "account", "role", "frozen"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const oneOf = <T extends string>(options: readonly T[], v: unknown): v is T => typeof v === "string" && (options as readonly string[]).includes(v);

/**
 * `mcpServers`/`channels`: the ticket's own required field ("MCP server
 * list, with per-MCP notification flags; channel bindings to ANY MCP
 * channel server"), deliberately NOT built here. S4 (BUTCHR-395, task
 * BUTCHR-411) is adding `Rule.mcpServers` (`McpServerBinding[]`: name, http
 * url, `headersEnvVar`, `channel: true|false`) on branch `BUTCHR-395` —
 * not yet on `main` or `BUTCHR-393`. The ticket's own sequencing rule: do
 * NOT copy or re-declare `McpServerBinding`, and do NOT merge that branch
 * in. A definition naming either key gets this specific, actionable error
 * instead of a generic "unknown field" one, so nobody mistakes silence for
 * "not needed yet" — see docs/managed-sessions.md.
 */
const DEFERRED_MCP_FIELDS = new Set(["mcpServers", "channels"]);
const deferredMcpProblem = (field: string, at: string): string =>
  `${at}.${field} is not supported yet — deferred pending BUTCHR-395/BUTCHR-411 (Rule.mcpServers) landing and a sequencing decision on BUTCHR-408; omit this field for now (see docs/managed-sessions.md)`;

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
  for (const k of Object.keys(doc)) {
    if (DEFERRED_MCP_FIELDS.has(k)) problems.push(deferredMcpProblem(k, at));
    else if (!DEFINITION_FIELDS.has(k)) problems.push(`${at} has unknown field "${k}"`);
  }
  problems.push(...workingDirectoryProblems(doc.workingDirectory, home).map((p) => `${at}.${p}`));
  if (!nonEmpty(doc.brief)) problems.push(`${at}.brief must be a non-empty string`);
  if (!oneOf(SESSION_DEFINITION_VENDORS, doc.vendor)) problems.push(`${at}.vendor must be one of ${SESSION_DEFINITION_VENDORS.join(", ")}`);
  if (!oneOf(SESSION_TIERS, doc.tier)) problems.push(`${at}.tier must be one of ${SESSION_TIERS.join(", ")}`);
  if (!oneOf(SESSION_PERMISSION_MODES, doc.permissionMode)) problems.push(`${at}.permissionMode must be one of ${SESSION_PERMISSION_MODES.join(", ")}`);
  if (doc.execution !== undefined && !oneOf(EXECUTION_MODES, doc.execution)) problems.push(`${at}.execution must be one of ${EXECUTION_MODES.join(", ")}`);
  if (doc.account !== undefined && !oneOf(ACCOUNT_POLICIES, doc.account)) problems.push(`${at}.account must be one of ${ACCOUNT_POLICIES.join(", ")}`);
  if (doc.role !== undefined && !oneOf(AGENT_ROLES, doc.role)) problems.push(`${at}.role must be one of ${AGENT_ROLES.join(", ")}`);
  if (doc.frozen !== undefined && typeof doc.frozen !== "boolean") problems.push(`${at}.frozen must be a boolean`);
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
