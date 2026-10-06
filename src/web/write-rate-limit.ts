/**
 * N2 (FACTORY-678) — a server-side, per-client sliding-window limit on
 * write-shaped routes (`POST /api/rules/:id/enabled`, `PUT /api/rules/:id`,
 * `POST /api/rules/plan`, `POST /api/undo/:backupId`), so a local process
 * cannot hammer the write lock, the disk, or the alert channel at full
 * speed. Deliberately separate from `../web/rules-preview.ts`'s own
 * per-RULE preview limit — this one is per-CLIENT and covers every write
 * attempt, accepted or rejected.
 *
 * CLIENT IDENTITY: every write route already runs through `checkWriteGuard`
 * (`./write-guard.ts`), which requires the caller's socket to resolve (via
 * `isSameUidPeer`, `./peer-uid.ts`) to THIS daemon's own uid — so every
 * legitimate caller is already the one local operator. There is therefore
 * no stronger identity to key on than the caller's own socket address (the
 * same `SocketEndpoint.address` `server.requestIP(request)` already hands
 * every write route, reused here rather than invented) — it keeps a
 * runaway script bound to one address from starving a DIFFERENT address
 * (e.g. a dashboard reached over `127.0.0.1` vs `::1`), without pretending
 * to distinguish identities the trust model doesn't actually separate.
 *
 * COUNTS REJECTED ATTEMPTS TOO: `check` is called once per request that
 * passes `checkWriteGuard` and BEFORE the route-specific write logic runs
 * — so a request this limiter lets through still counts against the
 * budget even if the underlying write is itself refused downstream (a
 * stale etag, a ceiling, a bad patch) — a rejected-write flood still
 * touches the lock, exactly as a flood of accepted writes would.
 *
 * `windowMs`/`max` are injectable (same discipline as `./rules-preview.ts`'s
 * own `now`/`rateLimitMs`), so a test drives a fake clock rather than
 * waiting on real timers.
 */

export interface WriteRateLimiterDeps {
  windowMs?: number;
  max?: number;
  now?: () => number;
}

export type WriteRateLimitOutcome = { ok: true } | { ok: false; retryAfterSeconds: number };

export const DEFAULT_WRITE_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_WRITE_RATE_LIMIT_MAX = 10;

/**
 * Builds the limiter closure — ONE instance shared across every request
 * (same reason `createRulesPreviewer` and `createScopeCache` are each built
 * once and reused: a fresh instance per request would reset its state
 * every time, defeating the limit entirely). Sliding window: each `clientKey`
 * tracks its own list of attempt timestamps within the last `windowMs`; a
 * call that would exceed `max` is refused (and does NOT itself count as a
 * new attempt — refusing it must never extend the client's own lockout).
 */
export function createWriteRateLimiter(deps: WriteRateLimiterDeps = {}): (clientKey: string) => WriteRateLimitOutcome {
  const windowMs = deps.windowMs ?? DEFAULT_WRITE_RATE_LIMIT_WINDOW_MS;
  const max = deps.max ?? DEFAULT_WRITE_RATE_LIMIT_MAX;
  const now = deps.now ?? (() => Date.now());
  const attempts = new Map<string, number[]>();

  return function check(clientKey: string): WriteRateLimitOutcome {
    const t = now();
    const prior = (attempts.get(clientKey) ?? []).filter((ts) => t - ts < windowMs);
    if (prior.length >= max) {
      attempts.set(clientKey, prior);
      const oldest = prior[0]!;
      const retryAfterMs = windowMs - (t - oldest);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    prior.push(t);
    attempts.set(clientKey, prior);
    return { ok: true };
  };
}
