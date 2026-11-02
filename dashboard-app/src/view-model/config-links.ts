/**
 * FACTORY-615: a BROWSER-SAFE copy of `agentRowAnchorId`/`configAnchorForResourceKey`
 * from `src/agents/config-inventory-links.ts` — same algorithm, verbatim,
 * not a re-invention (see that module's own doc comment for the full
 * reasoning this reuses). It is a COPY rather than an import for one
 * reason only: that module also exports `agentRowsForRule`, which imports
 * `MANAGED_SESSIONS_RULE_ID` from `src/rules/session-definition-type.ts` —
 * a module that reaches `node:fs/promises` directly and, transitively,
 * `src/agents/workspace.ts`'s own `*.md` brief imports, which Vite's
 * browser build cannot parse (`briefs/*.md` is not valid JS) and fails
 * `vite build` outright the moment anything in `dashboard-app/` imports
 * that chain, even for an unrelated, pure export of the same file.
 *
 * Importing ONLY the type-only pieces was not an option here: `agentRowAnchorId`/
 * `configAnchorForResourceKey` are real runtime functions this view-model
 * calls, not types — a `import type` can't substitute for them.
 *
 * DRIFT GUARD: `test/unit/dashboard-app-config-links.test.ts` asserts this
 * module's output is byte-identical to the real backend module's, across a
 * representative set of resource keys, so a future change to the real
 * algorithm that isn't mirrored here fails CI immediately rather than
 * silently breaking the Configurations page's cross-links.
 *
 * Decodes via `./agent-key-display.js` (parse-only, browser-safe) rather
 * than the real `decodeAnyAgentKey` — see that module's own header for why
 * the real one cannot be imported at runtime here.
 */
import { decodeAnyAgentKey, type ResourceProvider } from "./agent-key-display.js";

/** Verbatim copy of `MANAGED_SESSIONS_RULE_ID` (`src/rules/session-definition-type.ts`) — a reserved rule id, never loaded from `rules.json`; see that module's own doc comment for why this sentinel check is airtight without an inventory lookup. */
const MANAGED_SESSIONS_RULE_ID = "managed-sessions";

/** Verbatim copy of `anchorToken` (`src/agents/config-inventory-links.ts`). */
const anchorToken = (...parts: string[]): string => parts.map(encodeURIComponent).join("--");

/** Verbatim copy of `agentRowAnchorId` (`src/agents/config-inventory-links.ts`). */
export const agentRowAnchorId = (resourceKey: string): string => `agent-${anchorToken(resourceKey)}`;

/** Verbatim copy of `ruleAnchorId` (`src/agents/config-inventory-links.ts`). */
const ruleAnchorId = (resourceProvider: ResourceProvider, ruleId: string): string => `rule-${anchorToken(resourceProvider, ruleId)}`;

/** Verbatim copy of `sessionAnchorId` (`src/agents/config-inventory-links.ts`). */
const sessionAnchorId = (agentKey: string): string => `session-${anchorToken(agentKey)}`;

/** Verbatim copy of `configAnchorForResourceKey` (`src/agents/config-inventory-links.ts`). */
export function configAnchorForResourceKey(resourceKey: string): string | null {
  const decoded = decodeAnyAgentKey(resourceKey);
  if (!decoded) return null;
  if (decoded.resourceProvider === "filesystem" && decoded.ruleId === MANAGED_SESSIONS_RULE_ID) {
    return sessionAnchorId(resourceKey);
  }
  return ruleAnchorId(decoded.resourceProvider, decoded.ruleId);
}
