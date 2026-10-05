/**
 * FACTORY-657 (FACTORY-643 slice 1, epic FACTORY-659): re-reads the rules
 * file into a `RulesHolder` (./rules.ts) without a daemon restart. Two
 * triggers call this with the SAME function, so they can never disagree:
 * `src/daemon/index.ts`'s own `SIGHUP` handler, and — per the epic's own
 * scope correction on this ticket — an in-process call FACTORY-663's future
 * web write path makes directly, after it writes the rules file itself, no
 * HTTP round-trip or CLI needed.
 *
 * Goes through the EXACT SAME `loadRules` (and so the exact same
 * `parseRules` validation) `butchr rules check` already dry-runs against —
 * never a second parser. An invalid file (bad JSON, a schema violation)
 * leaves the holder untouched: `setRules` is only ever called after a
 * load succeeds, so "keep the running rules" is a consequence of ordering,
 * not a separate code path that could drift from it.
 *
 * A rule removed or disabled by a reload does not kill its running
 * agent(s) mid-ticket: `setRules` only changes what the NEXT poll's
 * discovery considers enabled (see `RulesHolder`'s own doc comment); the
 * reconciler's existing stop/reap path (src/daemon/loop.ts) is what
 * actually ends an agent whose ticket no longer matches any enabled rule,
 * exactly as it already does for a restart today (see README's own
 * "Applying a change" section) — a reload changes nothing about that path.
 */
import { loadRules, rulesPath, type ReadRulesFile, type Rule, type RulesEnv, type RulesHolder } from "./rules.js";

export interface ReloadResult {
  ok: boolean;
  /** The path `loadRules` read (or would have read) — present even on failure, for the caller's own log line. */
  path: string;
  /** Enabled rule ids present after this reload that were not enabled before it (a new rule, or one just enabled). Empty on failure. */
  added: string[];
  /** Enabled rule ids present before this reload that are not enabled after it (a rule removed or disabled). Empty on failure. */
  removed: string[];
  /** Rule ids enabled both before and after whose definition otherwise differs (query, brief, relationships, …). Empty on failure. */
  changed: string[];
  /** `loadRules`' own error message, one entry per line — empty on success. */
  problems: string[];
}

const byId = (rules: readonly Rule[]) => new Map(rules.filter((r) => r.enabled).map((r) => [r.id, r] as const));

/**
 * `holder` is the daemon's own live `RulesHolder` (see `createRulesHolder`,
 * ./rules.ts) — `setRules` is called on it directly, in place, so every
 * consumer already reading through `holder.getRules()` sees the swap on
 * its very next poll. `env`/`read` default to `loadRules`'s own defaults
 * (the real environment, the real filesystem); both are only ever
 * overridden by a test.
 */
export function reloadRules(holder: RulesHolder, env?: RulesEnv, read?: ReadRulesFile): ReloadResult {
  let loaded: { path: string; origin: "file" | "missing"; rules: Rule[] };
  try {
    loaded = loadRules(env, read);
  } catch (e) {
    return { ok: false, path: rulesPath(env), added: [], removed: [], changed: [], problems: (e as Error).message.split("\n") };
  }
  const before = byId(holder.getRules());
  const after = byId(loaded.rules);
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const changed = [...after.keys()].filter((id) => before.has(id) && JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)));
  holder.setRules(loaded.rules);
  return { ok: true, path: loaded.path, added, removed, changed, problems: [] };
}
