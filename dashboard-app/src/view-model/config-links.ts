/**
 * FACTORY-615: a BROWSER-SAFE copy of `agentRowAnchorId`/`configAnchorForResourceKey`
 * from `src/agents/config-inventory-links.ts` — same algorithm, verbatim,
 * not a re-invention (see that module's own doc comment for the full
 * reasoning this reuses). It is a COPY rather than an import because that
 * module imports the real `decodeAnyAgentKey` (`src/rules/agent-key.ts`) at
 * runtime, which `vite build` cannot bundle for the browser (see the last
 * paragraph below).
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

/** Verbatim copy of `anchorToken` (`src/agents/config-inventory-links.ts`). */
const anchorToken = (...parts: string[]): string => parts.map(encodeURIComponent).join("--");

/** Verbatim copy of `agentRowAnchorId` (`src/agents/config-inventory-links.ts`). */
export const agentRowAnchorId = (resourceKey: string): string => `agent-${anchorToken(resourceKey)}`;

/** Verbatim copy of `ruleAnchorId` (`src/agents/config-inventory-links.ts`). */
/** local/ui: exported so the Rules page can give each rule card this id, the one an agent row's "config" link points at. */
export const ruleAnchorId = (resourceProvider: ResourceProvider, ruleId: string): string => `rule-${anchorToken(resourceProvider, ruleId)}`;

/** Verbatim copy of `configAnchorForResourceKey` (`src/agents/config-inventory-links.ts`). */
export function configAnchorForResourceKey(resourceKey: string): string | null {
  const decoded = decodeAnyAgentKey(resourceKey);
  if (!decoded) return null;
  return ruleAnchorId(decoded.resourceProvider, decoded.ruleId);
}
