/**
 * FACTORY-729 — `AgentHarness`/`AGENT_HARNESSES` and `RulePermissionMode`/
 * `RULE_PERMISSION_MODES`, split out of `./rules.ts` (which re-exports both
 * unchanged, for every existing importer) for the SAME reason
 * `AGENT_EFFORTS` already lives in `../resources/power-scale.ts` instead of
 * `rules.ts` directly (see that module's own top comment): this is a pure,
 * dependency-free LEAF module with no `node:*` imports of its own, safe to
 * import from browser-bundled code.
 *
 * `rules.ts` pulls in `node:crypto`/`node:fs` (and, transitively, several
 * other server-only modules — Jira/GitHub/Zendesk query parsers, filesystem
 * queries, `../agents/workspace.ts`) for its `loadRules`/`parseRules`
 * machinery. A plain VALUE import of anything named from `rules.ts` —
 * TypeScript's `import type` is erased at build time, but `import { X }`
 * is not — pulls that whole module graph into whatever bundles it,
 * `node:*` imports included. `../../dashboard-app/src/rules/rule-form-
 * catalog.ts` and (through it) `dashboard-app/src/components/
 * FirstRuleSetup.tsx` need these two constants/types as real VALUES (not
 * just types) for their own harness/permission-mode dropdowns — this file
 * is what lets them do that without dragging `rules.ts` into the Vite
 * client bundle, which was observed to break that build outright (Rollup
 * never wrote `dist/web` at all, surfaced downstream as an unrelated-
 * looking `ENOENT` from `vite.config.ts`'s third-party-notices plugin).
 */

/** Agent harnesses Drovr can launch. */
export const AGENT_HARNESSES = ["claude", "codex", "agy"] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];

/**
 * FACTORY-87 (FACTORY-76, rule-side companion to DROVR-42) — the same five
 * permission-mode values `SessionDefinition.permissionMode` accepts
 * (`SESSION_PERMISSION_MODES`, `../resources/session-definition.ts`). See
 * `Rule.permissionMode`'s own doc comment (`./rules.ts`) for the full
 * contract (default, per-vendor mapping, etc.) — this file only owns the
 * constant's VALUE and TYPE, kept independent for the leaf-module reason
 * described above.
 */
export const RULE_PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "auto"] as const;
export type RulePermissionMode = (typeof RULE_PERMISSION_MODES)[number];
