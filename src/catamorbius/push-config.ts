/**
 * FACTORY-137 (task 2/2 of story FACTORY-22): config for wiring the
 * Catamorbius client (FACTORY-134, `./config.ts`) into butchr's
 * linked-eventing pipeline as a push mode. Kept in its own module rather
 * than added to `./config.ts` — that loader is already exhaustively tested
 * against exact throw messages, and this ticket's brief says not to weaken
 * those tests. This module wraps `loadCatamorbiusConfig` instead of
 * extending it.
 *
 * D9 (CONFIG AND ENABLE): off unless `CATAMORBIUS_URL` is configured AND at
 * least one provider is enabled via `CATAMORBIUS_PROVIDERS` — same
 * bare-`CATAMORBIUS_*` prefix task 1 already used (not the ticket's own
 * suggested `BUTCHR_CATAMORBIUS_PROVIDERS`; this repo's `.env.example`
 * already established the bare prefix for this feature and I'm keeping it
 * consistent rather than introducing a second prefix for the same family).
 *
 * TOKEN-FILE-READ FAILURE VS. EVERY OTHER MALFORMED VALUE (ticket's own
 * pre-start correction, item B1): `loadCatamorbiusConfig` lets a throwing
 * `readFile` propagate raw and uncaught — D9 as originally written assumed
 * it would catch that itself. It doesn't, and this ticket's brief says not
 * to weaken the loader's own tests, so the split lives here: only the
 * `readFile` CALL ITSELF throwing (the token file does not exist, or is not
 * readable — an environmental/transient fact) is caught and turned into
 * "feature disabled, one WARNING, daemon falls back to polling". A missing
 * `CATAMORBIUS_TOKEN_FILE` variable and an empty token (after trim) are
 * DELIBERATELY NOT included in that catch — both are operator configuration
 * mistakes, not a file-read failure, and stay loud startup failures exactly
 * like a malformed URL or a non-positive numeric knob. This is a judgment
 * call the ticket left to the implementer ("decide and document where that
 * split lives"); flagged in the PR for the story to confirm or correct.
 */
import { loadCatamorbiusConfig, type CatamorbiusConfig, type CatamorbiusConfigEnv } from "./config.js";

export type CatamorbiusProvider = "jira" | "github";

export interface CatamorbiusPushConfig {
  /** D9: an explicit, non-empty list — never "everything" and never inferred from what's mappable. */
  providers: readonly CatamorbiusProvider[];
  /** D4: one global default plus optional per-provider-type overrides — never per-rule, never per-subscription (see this module's own header and docs/catamorbius-push.md for why). */
  ttlMs: number;
  ttlMsByProvider: Partial<Record<CatamorbiusProvider, number>>;
  /** D5: how long covered targets stay covered (not polled) while reconnecting, after having been live. */
  graceMs: number;
  /** D6: trailing per-target debounce so a burst of notifications becomes one fetch. */
  debounceMs: number;
}

export interface CatamorbiusPushConfigEnv extends CatamorbiusConfigEnv {
  CATAMORBIUS_PROVIDERS?: string | undefined;
  CATAMORBIUS_TTL_MS?: string | undefined;
  CATAMORBIUS_TTL_JIRA_MS?: string | undefined;
  CATAMORBIUS_TTL_GITHUB_MS?: string | undefined;
  CATAMORBIUS_GRACE_MS?: string | undefined;
  CATAMORBIUS_DEBOUNCE_MS?: string | undefined;
}

const DEFAULT_TTL_MS = 600_000; // D4: 10 minutes
const DEFAULT_GRACE_MS = 60_000; // D5
const DEFAULT_DEBOUNCE_MS = 2_000; // D6

/**
 * D4: "reject non-positive values loudly at startup; decide and justify a
 * floor." A floor of 1ms (not, say, 1000ms) is deliberate: this is a
 * validation floor against a nonsensical value (0, negative, NaN), not a
 * performance floor — a genuinely tiny TTL is the operator's own choice to
 * make and this module has no basis for second-guessing where "too
 * aggressive" begins for a deployment it knows nothing about.
 */
function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} is not a positive number: ${JSON.stringify(raw)}`);
  return n;
}

const KNOWN_PROVIDERS: readonly CatamorbiusProvider[] = ["jira", "github"];

function parseProviders(raw: string | undefined): CatamorbiusProvider[] {
  if (!raw?.trim()) return [];
  const out: CatamorbiusProvider[] = [];
  for (const token of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!(KNOWN_PROVIDERS as readonly string[]).includes(token)) {
      throw new Error(`CATAMORBIUS_PROVIDERS names an unknown provider: ${JSON.stringify(token)} (known: ${KNOWN_PROVIDERS.join(", ")})`);
    }
    if (!out.includes(token as CatamorbiusProvider)) out.push(token as CatamorbiusProvider);
  }
  return out;
}

/** Loads the D4/D5/D6 knobs on top of an already-loaded `CatamorbiusConfig`. Throws loudly on any malformed value — never silently coerced, same contract as `loadCatamorbiusConfig` itself. */
export function loadCatamorbiusPushKnobs(env: CatamorbiusPushConfigEnv): CatamorbiusPushConfig {
  const providers = parseProviders(env.CATAMORBIUS_PROVIDERS);
  const ttlMs = positiveNumber(env.CATAMORBIUS_TTL_MS, DEFAULT_TTL_MS, "CATAMORBIUS_TTL_MS");
  const ttlMsByProvider: Partial<Record<CatamorbiusProvider, number>> = {};
  if (env.CATAMORBIUS_TTL_JIRA_MS !== undefined) ttlMsByProvider.jira = positiveNumber(env.CATAMORBIUS_TTL_JIRA_MS, ttlMs, "CATAMORBIUS_TTL_JIRA_MS");
  if (env.CATAMORBIUS_TTL_GITHUB_MS !== undefined) ttlMsByProvider.github = positiveNumber(env.CATAMORBIUS_TTL_GITHUB_MS, ttlMs, "CATAMORBIUS_TTL_GITHUB_MS");
  const graceMs = positiveNumber(env.CATAMORBIUS_GRACE_MS, DEFAULT_GRACE_MS, "CATAMORBIUS_GRACE_MS");
  const debounceMs = positiveNumber(env.CATAMORBIUS_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS, "CATAMORBIUS_DEBOUNCE_MS");
  return { providers, ttlMs, ttlMsByProvider, graceMs, debounceMs };
}

export type CatamorbiusFullConfig = { catamorbius: CatamorbiusConfig; push: CatamorbiusPushConfig };

/**
 * D9: the one entry point the daemon calls at startup. `undefined` means
 * "push mode off" — either `CATAMORBIUS_URL` is unset (task 1's own
 * contract, unchanged), or it's set but no provider is enabled (this
 * ticket's own addition to the "off by default" contract), or the token
 * file could not be read (see this module's own header on why that one
 * case, and only that one, degrades instead of throwing). Every other
 * malformed value — URL, any numeric knob, an unknown provider name — still
 * throws synchronously, so daemon startup fails loudly exactly as it does
 * for every other misconfigured, opted-in feature.
 *
 * D9: "the client's start() never blocks or throws into daemon startup" is
 * a property of the CLIENT (task 1) and this ticket's own controller, not
 * of this loader — this function is synchronous config parsing only, no I/O
 * beyond the injected `readFile`, so it throwing at startup is the intended
 * "fail loudly" behaviour for a genuine misconfiguration, not a violation of
 * that property.
 */
export function loadCatamorbiusFullConfig(env: CatamorbiusPushConfigEnv, readFile: (path: string) => string, log: (line: string) => void): CatamorbiusFullConfig | undefined {
  let tokenReadFailed = false;
  const guardedReadFile = (path: string): string => {
    try {
      return readFile(path);
    } catch (e) {
      tokenReadFailed = true;
      throw e;
    }
  };
  let catamorbius: CatamorbiusConfig | undefined;
  try {
    catamorbius = loadCatamorbiusConfig(env, guardedReadFile);
  } catch (e) {
    if (tokenReadFailed) {
      log(`  WARNING: [catamorbius] token file could not be read (${(e as Error)?.message ?? e}); push mode disabled, falling back to polling`);
      return undefined;
    }
    throw e;
  }
  if (!catamorbius) return undefined; // CATAMORBIUS_URL unset
  const push = loadCatamorbiusPushKnobs(env);
  if (push.providers.length === 0) return undefined; // D9: no provider asserted as flowing -> feature stays inert
  return { catamorbius, push };
}
