/**
 * FACTORY-662 — the per-process CSRF token every write route requires. One
 * random token is minted when this module is first constructed (NOT
 * per-request, NOT persisted across a daemon restart) and handed out only by
 * `GET /api/session`, itself gated by the SAME Origin/Host/peer-uid guards
 * every write route uses — so an attacker who cannot pass those guards can
 * never learn the token either, and a daemon restart invalidates every
 * outstanding token for free (nothing to revoke).
 *
 * Compared with `timingSafeEqual` (not `===`): a plain string compare leaks
 * the first mismatching byte's timing, which over enough requests is a real
 * side channel for guessing a 32-byte token one byte at a time. Length is
 * checked first (constant-time compare throws on mismatched lengths), which
 * leaks only the token's fixed LENGTH, never any of its content — the length
 * is not a secret (`CSRF_TOKEN_BYTES` below is public in this file).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export const CSRF_TOKEN_BYTES = 32;

export interface CsrfTokenIssuer {
  /** This process's one token, hex-encoded. Stable for the process's lifetime. */
  token: string;
  /** `true` iff `candidate` equals the live token, compared in constant time. `null`/`undefined`/non-string candidates are always `false`, never thrown. */
  check: (candidate: string | null | undefined) => boolean;
}

export function createCsrfTokenIssuer(randomBytesFn: (n: number) => Buffer = randomBytes): CsrfTokenIssuer {
  const token = randomBytesFn(CSRF_TOKEN_BYTES).toString("hex");
  const tokenBuf = Buffer.from(token, "utf8");
  return {
    token,
    check: (candidate) => {
      if (typeof candidate !== "string") return false;
      const candidateBuf = Buffer.from(candidate, "utf8");
      if (candidateBuf.length !== tokenBuf.length) return false;
      return timingSafeEqual(candidateBuf, tokenBuf);
    },
  };
}

/** The header every write route requires, carrying the token `GET /api/session` handed out. */
export const CSRF_HEADER = "x-butchr-csrf";
