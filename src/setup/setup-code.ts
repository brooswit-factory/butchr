/**
 * FACTORY-665 (PR-2) — the one-time setup code gating every secret/identity
 * write (`POST /api/setup/jira`, `PUT /api/settings/jira/token`), per
 * advisor-agentsafety's A2 review: >=60 bits of CSPRNG, printed to the
 * daemon's own journal/stdout log ONLY (never written to disk, never put in
 * an env var — in-memory for this process's lifetime only), 10-minute TTL,
 * single-use, 5 attempts then locked until a fresh code is minted, constant-
 * time comparison. A fresh code can be minted at any time (not only while
 * unconfigured) via `SIGUSR2` — see `installSetupCodeSigusr2Handler` below —
 * which is how an operator authorizes a LATER token rotation once the
 * initial setup-code window has long since expired.
 *
 * 12 base32 (RFC 4648, no padding) characters = 60 bits exactly — the
 * ticket's own example shape. Base32 (not base64/hex) because an operator
 * may need to read this off a journal and type it by hand: no visually
 * ambiguous characters (no 0/O, 1/I/L), case-insensitive.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 32 symbols, no 0/O/1/I/L
const CODE_LENGTH = 13; // 31-symbol alphabet: 13 * log2(31) = 64.4 bits (12 would be 59.4, under the 60-bit gate)
export const SETUP_CODE_TTL_MS = 10 * 60_000;
export const SETUP_CODE_MAX_ATTEMPTS = 5;

function randomBase32(length: number, randomBytesFn: (n: number) => Buffer): string {
  const bytes = randomBytesFn(length); // one byte per symbol is wasteful but simple and exact — this is a tiny, infrequent allocation
  let out = "";
  for (let i = 0; i < length; i++) out += BASE32_ALPHABET[bytes[i]! % BASE32_ALPHABET.length];
  return out;
}

/** Constant-time (w.r.t. content — not length) equality for two short operator-facing codes, normalized to upper-case first since the operator may type either case. `null`/`undefined` is always a non-match, never thrown. */
function constantTimeCodeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a.toUpperCase(), "utf8");
  const bufB = Buffer.from(b.toUpperCase(), "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type SetupCodeCheckResult =
  | { ok: true }
  | { ok: false; reason: "no code minted" | "expired" | "locked" | "mismatch" };

export interface SetupCodeManagerDeps {
  randomBytesFn?: (n: number) => Buffer;
  now?: () => number;
}

/**
 * Stateful, one-per-process manager. `mint()` replaces any live code
 * (resetting attempts/lockout) and returns the new plaintext code for the
 * caller to log — this module never logs anything itself, so there is
 * exactly one call site in the whole codebase that ever writes a code to
 * any output, trivial to audit. `check(candidate)` is the only way to
 * consume an attempt: a correct candidate is single-use (immediately
 * invalidated on success, not just on exhaustion) so a leaked/observed
 * correct code cannot be replayed for a second write.
 */
export interface SetupCodeManager {
  mint(): string;
  check(candidate: string | null | undefined): SetupCodeCheckResult;
  /** For `/api/setup/status` and tests — never the code itself. */
  state(): { minted: boolean; locked: boolean; expiresAt: string | null };
}

export function createSetupCodeManager(deps: SetupCodeManagerDeps = {}): SetupCodeManager {
  const randomBytesFn = deps.randomBytesFn ?? randomBytes;
  const now = deps.now ?? (() => Date.now());

  let live: { code: string; expiresAt: number; attemptsLeft: number } | null = null;

  function mint(): string {
    const code = randomBase32(CODE_LENGTH, randomBytesFn);
    live = { code, expiresAt: now() + SETUP_CODE_TTL_MS, attemptsLeft: SETUP_CODE_MAX_ATTEMPTS };
    return code;
  }

  function check(candidate: string | null | undefined): SetupCodeCheckResult {
    if (!live) return { ok: false, reason: "no code minted" };
    if (now() >= live.expiresAt) { live = null; return { ok: false, reason: "expired" }; }
    if (live.attemptsLeft <= 0) return { ok: false, reason: "locked" };
    if (typeof candidate !== "string" || !constantTimeCodeEquals(candidate, live.code)) {
      live.attemptsLeft -= 1;
      return { ok: false, reason: live.attemptsLeft <= 0 ? "locked" : "mismatch" };
    }
    live = null; // single-use: a correct code is consumed immediately, win or lose there is no replay
    return { ok: true };
  }

  function state() {
    if (!live) return { minted: false, locked: false, expiresAt: null };
    if (now() >= live.expiresAt) return { minted: false, locked: false, expiresAt: null };
    return { minted: true, locked: live.attemptsLeft <= 0, expiresAt: new Date(live.expiresAt).toISOString() };
  }

  return { mint, check, state };
}

/**
 * Installs the `SIGUSR2` handler that mints a fresh code on demand — "a
 * local command or SIGUSR2" per the ticket; this is the SIGUSR2 half (an
 * operator with shell access to this host runs `kill -SIGUSR2 <pid>`, or
 * `systemctl --user kill -s SIGUSR2 butchr.service`). Logged via `log`
 * (journal/stdout), never written to disk or an env var — same discipline
 * `mint()`'s own caller must already follow at startup. Returns a function
 * that removes the listener (tests only; production never calls it).
 */
export function installSetupCodeSigusr2Handler(manager: SetupCodeManager, log: (line: string) => void = console.error): () => void {
  const handler = () => {
    const code = manager.mint();
    log(`butchr: setup code (10 min, single-use, 5 attempts): ${code}`);
  };
  process.on("SIGUSR2", handler);
  return () => process.off("SIGUSR2", handler);
}
