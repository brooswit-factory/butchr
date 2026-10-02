/**
 * FACTORY-615: a BROWSER-SAFE, PARSE-ONLY counterpart to
 * `decodeAnyAgentKey` (`src/rules/agent-key.ts`) — needed because that real
 * function's `isResourceId` validation calls `isFilesystemResourceId`
 * (`src/resources/filesystem-ref.ts`), which imports `{ posix, win32 }` from
 * `node:path` AS VALUES (not just types) — Rollup's browser externalization
 * stub has no such exports, so anything in `dashboard-app/` that reaches
 * `decodeAnyAgentKey` at RUNTIME (a type-only import is erased and would be
 * fine, but every caller here needs the real function) fails `vite build`
 * outright.
 *
 * THE DELIBERATE DIFFERENCE FROM THE REAL FUNCTION: this one does NOT
 * re-validate that each segment is a well-formed provider/ruleId/resourceId
 * per `RESOURCE_PROVIDERS`'s own per-provider rules, and does not round-trip
 * check (`joinKey(parts) === key`) — those checks exist in the backend to
 * reject a MALFORMED key before trusting it for a filesystem path, an API
 * call, or a correlation match. This module only ever sees a `resourceKey`
 * the backend's own `encodeAgentKey`/`encodeQueryAgentKey` already produced
 * and that `/dashboard`'s JSON already shipped — there is no untrusted input
 * here, only a DISPLAY decision (the bare resource id to show, and which
 * Configurations anchor to link to), so a parse-only decode is the right
 * amount of validation for this module's actual job, not a weakening of a
 * security boundary that exists elsewhere.
 *
 * DRIFT GUARD: `test/unit/dashboard-app-agent-key-display.test.ts` asserts
 * this parses every key shape the real `encodeAgentKey`/`encodeQueryAgentKey`
 * produce identically to the real `decodeAnyAgentKey`.
 */

const SEP = ":";
const QUERY_AGENT_MARKER = "@query";

export const RESOURCE_PROVIDERS = ["jira-work", "github-issue", "github-pr", "jira-idea", "zendesk-ticket", "jira-project", "filesystem"] as const;
export type ResourceProvider = (typeof RESOURCE_PROVIDERS)[number];

export type AnyAgentKeyParts =
  | { kind: "resource"; resourceProvider: ResourceProvider; ruleId: string; resourceId: string }
  | { kind: "query"; resourceProvider: ResourceProvider; ruleId: string };

function isKnownProvider(s: string): s is ResourceProvider {
  return (RESOURCE_PROVIDERS as readonly string[]).includes(s);
}

/** Parse-only counterpart to `decodeAnyAgentKey` — see this module's own header for why. `null` for anything that doesn't even split into 3 segments with a recognized provider; never throws. */
export function decodeAnyAgentKey(key: string): AnyAgentKeyParts | null {
  const raw = key.split(SEP);
  if (raw.length !== 3) return null;
  let decoded: string[];
  try {
    decoded = raw.map(decodeURIComponent);
  } catch {
    return null;
  }
  const [resourceProvider, ruleId, last] = decoded as [string, string, string];
  if (!isKnownProvider(resourceProvider)) return null;
  if (last === QUERY_AGENT_MARKER) return { kind: "query", resourceProvider, ruleId };
  return { kind: "resource", resourceProvider, ruleId, resourceId: last };
}
