/**
 * FACTORY-665 (epic FACTORY-659, slice S2, WRITE) — `~/.config/butchr/
 * settings.json`: a NON-SECRET layer of defaults that sits strictly UNDER
 * the environment (an env var, when set, always wins — see
 * `effectiveSettingsEnv` below) for a small, hand-picked ALLOWLIST of keys:
 * the fleet cap, agent-provider order (default + per-tier), the default
 * model, and the one genuine polling-cadence knob butchr's `ConfigEnv`
 * exposes today (`BUTCHR_POLL_STALE_MS` — `PROJECT_POLL_INTERVAL_MS`,
 * mentioned in several comments elsewhere in this codebase, is a compiled-
 * in constant, `src/resources/project.ts`, not an env var, so there is
 * nothing else "poll interval"-shaped to allowlist yet).
 *
 * Deliberately excludes EVERY path/URL/identity/port/rules-file key (see
 * `src/web/settings-api.ts`'s own `SETTINGS_DEFINITIONS` for the full
 * read-only catalogue this allowlist is a strict subset of) and every
 * secret-shaped key (`SECRET_KEY_RE`) — this module never reads or writes
 * `ATLASSIAN_TOKEN`/`*_TOKEN_FILE`/etc; that is FACTORY-665's PR-2 (setup
 * mode + the Jira token endpoint), a separate module with a separate,
 * much stricter write path, not this one.
 *
 * LOUD REFUSAL, NEVER A SILENT DEFAULT (the ticket's own words): invalid
 * JSON, a file owned by a different uid than this process, a symlink, or a
 * mode wider than 0600 — the WHOLE file is refused (every key in it is
 * treated as unset, i.e. falls through to the hardcoded default exactly as
 * if the file didn't exist) and `onRefuse` is called with a human-readable
 * reason, which the caller (`src/daemon/index.ts`) logs to the journal AND
 * posts as an ops alert. A single key whose OWN value fails its range
 * check (see `validateSettingValue`) is dropped individually — every
 * other, valid key in the same file still applies — also through
 * `onRefuse`, named per-key.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SettingsFileEnv = Record<string, string | undefined> & { XDG_CONFIG_HOME?: string | undefined; HOME?: string | undefined; BUTCHR_SETTINGS_FILE?: string | undefined };

/** Where settings.json is read from: explicit override, else the XDG config dir — same resolution `rulesPath` (`../rules/rules.ts`) uses, for the same reason (one `~/.config/butchr` directory, several files in it). */
export function settingsFilePath(env: SettingsFileEnv = process.env): string {
  if (env.BUTCHR_SETTINGS_FILE?.trim()) return env.BUTCHR_SETTINGS_FILE.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(xdg, "butchr", "settings.json");
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,63}$/;

export type AllowlistKind = "provider" | "providerOrder" | "model" | "positiveIntWithCeiling" | "positiveMsWithFloor";

export interface AllowlistKeyDef {
  key: string;
  kind: AllowlistKind;
}

/** A positive integer past this needs `confirm: true` on the write (fleet-cap "confirm to raise"). Director's own choice for v1 — no existing ceiling constant for `BUTCHR_MAX_AGENTS` elsewhere in this codebase to reuse (unlike `ENABLE_SCOPE_CEILING`, `../rules/rules-write-registry.ts`, which is a different knob). */
export const MAX_AGENTS_CEILING = 50;

/** Hard maximum for the fleet cap: refused outright, `confirm` cannot lift it (director 2026-10-06; agentsafety A2 item 4b). */
export const MAX_AGENTS_HARD_MAX = 100;

/** Sub-second poll-staleness tolerances are almost certainly a typo, not an intent — refused outright, no confirm escape hatch (unlike the ceiling above, there is no legitimate reason to go lower, only a float/unit mistake). */
export const POLL_STALE_MS_FLOOR = 1000;

const PROVIDERS = new Set(["claude", "codex", "agy"]);

/**
 * THE strict allowlist — every key `settings.json`/`PUT /api/settings/:key`
 * will ever accept, nothing else, ever. Cross-checked by this module's own
 * tests against `SETTINGS_DEFINITIONS` (`../web/settings-api.ts`): every
 * entry here must also appear there (the allowlist is a SUBSET of the
 * read-only catalogue, never a key the read-only page doesn't already
 * know about), and no entry here is ever secret-shaped or a path/URL/
 * identity/port/rules-file key.
 */
export const SETTINGS_ALLOWLIST: readonly AllowlistKeyDef[] = [
  { key: "BUTCHR_MAX_AGENTS", kind: "positiveIntWithCeiling" },
  { key: "BUTCHR_AGENT_PROVIDER", kind: "provider" },
  { key: "BUTCHR_AGENT_PROVIDERS", kind: "providerOrder" },
  { key: "BUTCHR_AGENT_PROVIDERS_PROJECT", kind: "providerOrder" },
  { key: "BUTCHR_AGENT_PROVIDERS_EPIC", kind: "providerOrder" },
  { key: "BUTCHR_AGENT_PROVIDERS_STORY", kind: "providerOrder" },
  { key: "BUTCHR_AGENT_PROVIDERS_TASK", kind: "providerOrder" },
  { key: "BUTCHR_AGENT_MODEL", kind: "model" },
  { key: "BUTCHR_POLL_STALE_MS", kind: "positiveMsWithFloor" },
];

const ALLOWLIST_BY_KEY = new Map(SETTINGS_ALLOWLIST.map((d) => [d.key, d] as const));

export function isAllowlistedSettingsKey(key: string): boolean {
  return ALLOWLIST_BY_KEY.has(key);
}

export type ValidateResult = { ok: true; normalized: string } | { ok: false; error: string; /** `true` only for a ceiling/floor crossing that a caller may override by passing `confirm: true` — never set for a malformed value (a confirm can never fix a syntax error). */ needsConfirm?: boolean };

function validateProviderOrder(value: string, name: string): ValidateResult {
  const entries = value.split(",").map((e) => e.trim());
  if (entries.some((e) => !PROVIDERS.has(e)) || new Set(entries).size !== entries.length || entries.some((e) => e === "")) {
    return { ok: false, error: `${name} must be an ordered, comma-separated list of distinct providers (claude, codex, agy)` };
  }
  return { ok: true, normalized: entries.join(",") };
}

/**
 * Validates one allowlisted key's new string value against its `kind`
 * (format AND range) — called BOTH by the write route (before anything
 * touches disk) and by `loadSettingsFile` below (so a hand-edited file
 * with an out-of-range value is caught exactly the same way a bad write
 * attempt would be, per-key, never a silent pass-through). `confirm`
 * (default `false`) is the write route's own escape hatch for a ceiling/
 * floor crossing that genuinely is intended; `loadSettingsFile` never
 * passes `true` — a hand-edited file gets no confirm bypass, since there
 * is no human confirming anything at startup.
 */
export function validateSettingValue(key: string, rawValue: string, confirm = false): ValidateResult {
  const def = ALLOWLIST_BY_KEY.get(key);
  if (!def) return { ok: false, error: `"${key}" is not an editable setting` };
  const value = rawValue.trim();
  if (value === "") return { ok: false, error: `${key} must not be empty` };
  switch (def.kind) {
    case "provider":
      if (!PROVIDERS.has(value)) return { ok: false, error: `${key} must be claude, codex, or agy` };
      return { ok: true, normalized: value };
    case "providerOrder":
      return validateProviderOrder(value, key);
    case "model":
      // Bounded and flag-shaped values refused: the value reaches the agent CLI as one argv element (agentsafety A2 review item 2).
      if (!MODEL_RE.test(value)) return { ok: false, error: `${key} must be 1-64 characters: letters, digits and ._:/@- only, starting with a letter or digit` };
      return { ok: true, normalized: value };
    case "positiveIntWithCeiling": {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `${key} must be a positive integer` };
      if (n > MAX_AGENTS_HARD_MAX) return { ok: false, error: `${key}=${n} is above the hard maximum (${MAX_AGENTS_HARD_MAX}) — confirm cannot lift it` };
      if (n > MAX_AGENTS_CEILING && !confirm) {
        return { ok: false, error: `${key}=${n} is above the confirm ceiling (${MAX_AGENTS_CEILING}) — retry with confirm: true to proceed`, needsConfirm: true };
      }
      return { ok: true, normalized: String(n) };
    }
    case "positiveMsWithFloor": {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `${key} must be a positive integer (milliseconds)` };
      if (n < POLL_STALE_MS_FLOOR) return { ok: false, error: `${key}=${n} is below the floor (${POLL_STALE_MS_FLOOR}ms) — refusing a sub-second poll-staleness tolerance` };
      return { ok: true, normalized: String(n) };
    }
  }
}

export interface SettingsFileResult {
  /** Only keys that both parsed AND validated — every other key (not in the allowlist, or failing its own range check) is simply absent, never guessed. */
  values: Record<string, string>;
  /** One entry per problem found, loud-refusal text ready to log/alert verbatim. Empty when the file is absent (not a problem — settings.json is optional) or entirely clean. */
  problems: string[];
}

export interface SettingsFileIo {
  readFile: (path: string) => string;
  lstat: (path: string) => { isSymbolicLink(): boolean };
  stat: (path: string) => { uid: number; mode: number };
  ownUid: () => number | undefined;
}

export function defaultSettingsFileIo(): SettingsFileIo {
  return {
    readFile: (path) => readFileSync(path, "utf8"),
    lstat: (path) => lstatSync(path),
    stat: (path) => { const s = statSync(path); return { uid: s.uid, mode: s.mode & 0o777 }; },
    ownUid: () => process.getuid?.(),
  };
}

/**
 * Reads and validates `settings.json`. NEVER THROWS: every failure mode
 * (absent file, invalid JSON, wrong owner, symlink, mode wider than 0600,
 * a non-object document, a non-allowlisted key, an out-of-range value)
 * resolves to a result with that problem named in `problems` and the
 * affected key(s) simply absent from `values` — exactly the "refuse
 * loudly, never a silent default" contract the ticket asks for, with the
 * loudness itself left to the caller (`problems` is the message list;
 * logging/alerting on it is `src/daemon/index.ts`'s job, same division of
 * labor `createRulesFileExclusive`'s own `onWarn` already uses).
 */
export function loadSettingsFile(env: SettingsFileEnv = process.env, io: SettingsFileIo = defaultSettingsFileIo()): SettingsFileResult {
  const path = settingsFilePath(env);

  let text: string;
  try {
    text = io.readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { values: {}, problems: [] };
    return { values: {}, problems: [`${path}: could not be read (${(e as Error).message}) — ignoring, every setting falls back to its default`] };
  }

  try {
    if (io.lstat(path).isSymbolicLink()) {
      return { values: {}, problems: [`${path} is a symlink — refusing to read it; settings.json must be a plain regular file. Every setting falls back to its default.`] };
    }
  } catch { /* already handled the ENOENT case above via readFile; any other lstat failure falls through to the stat check below, which will itself fail loudly */ }

  let meta: { uid: number; mode: number };
  try {
    meta = io.stat(path);
  } catch (e) {
    return { values: {}, problems: [`${path}: could not stat (${(e as Error).message}) — ignoring, every setting falls back to its default`] };
  }

  const ownUid = io.ownUid();
  if (ownUid !== undefined && meta.uid !== ownUid) {
    return { values: {}, problems: [`${path} is owned by uid ${meta.uid}, not this daemon's own uid (${ownUid}) — refusing to trust it. Every setting falls back to its default.`] };
  }
  if ((meta.mode & 0o077) !== 0) {
    return { values: {}, problems: [`${path} has mode ${meta.mode.toString(8).padStart(3, "0")}, wider than 0600 — refusing to trust it. Every setting falls back to its default.`] };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { values: {}, problems: [`${path}: invalid JSON (${(e as Error).message}) — ignoring the whole file, every setting falls back to its default`] };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { values: {}, problems: [`${path}: expected a JSON object of key/value settings — ignoring the whole file, every setting falls back to its default`] };
  }

  const values: Record<string, string> = {};
  const problems: string[] = [];
  for (const [key, raw] of Object.entries(doc as Record<string, unknown>)) {
    if (!isAllowlistedSettingsKey(key)) {
      problems.push(`${path}: "${key}" is not an allowlisted setting — ignored (this key is never read from settings.json)`);
      continue;
    }
    if (typeof raw !== "string") {
      problems.push(`${path}: "${key}" must be a string — ignored, falls back to its default`);
      continue;
    }
    const result = validateSettingValue(key, raw, true) // confirm=true: a value written with confirm must survive the next start; the hard maximum still applies;
    if (!result.ok) {
      problems.push(`${path}: "${key}": ${result.error} — ignored, falls back to its default`);
      continue;
    }
    values[key] = result.normalized;
  }

  return { values, problems };
}

/**
 * Layers `settingsFile` UNDER `processEnv` for exactly the allowlisted
 * keys: an env var that is set (non-empty after trim) ALWAYS wins; only an
 * UNSET env var falls through to the settings.json value. Returns a new
 * object — never mutates `processEnv` — suitable for passing straight into
 * `loadConfig` (`../config/config.ts`) in place of `process.env`.
 */
export function effectiveSettingsEnv<T extends Record<string, string | undefined>>(processEnv: T, settingsFile: Record<string, string>): T {
  const merged = { ...processEnv };
  for (const [key, value] of Object.entries(settingsFile)) {
    const envValue = (merged as Record<string, string | undefined>)[key];
    if (envValue === undefined || envValue.trim() === "") {
      (merged as Record<string, string | undefined>)[key] = value;
    }
  }
  return merged;
}
