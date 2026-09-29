bump: major

### BREAKING

- **`BUTCHR_EXTENSION_TOKEN` is removed (FACTORY-465, implementing
  FACTORY-464, epic FACTORY-330).** `GET /resources/for-url` and
  `GET /agents/:agentKey/pty` no longer accept or require a bearer token —
  they now gate ONLY on `BUTCHR_EXTENSION_ORIGINS`, requiring a present,
  allowlisted `Origin` header on every request (an absent `Origin` is now
  refused, 403, on BOTH routes — previously the plain HTTP route allowed a
  missing `Origin` through on a valid token). This is a deliberate,
  operator-decided security-posture tradeoff: the daemon binds loopback-only,
  and on a single-user local box an Origin-allowlist-only check is
  sufficient. **`Origin` is enforced by the browser, so this still protects
  against another website open in a browser tab, but it does NOT protect
  against another local process (a script, another user, `curl`) that sets
  `Origin: chrome-extension://<allowlisted-id>` by hand.** An unset/empty
  `BUTCHR_EXTENSION_ORIGINS` remains fail-closed (every request refused), the
  same as before. If you previously set `BUTCHR_EXTENSION_TOKEN`, remove it —
  it is no longer read.
- The `Sec-WebSocket-Protocol: clevr.bearer, <token>` credential channel
  (FACTORY-454/FACTORY-455) is removed along with the token it carried: it
  served no purpose once there was no token to send over it. Clevr no longer
  needs to offer a subprotocol on the `pty` WebSocket handshake at all.

### Removed

- `src/web/bearer-origin-guard.ts` is renamed to `src/web/origin-guard.ts`;
  `checkBearerOrigin`/`checkBearerOriginForUpgrade`/`preflightBearerOrigin`
  are replaced by `checkExtensionOrigin`/`preflightExtensionOrigin` (one
  shared Origin-only rule for both guarded routes — the two routes no longer
  need separate guard functions now that the bearer-token/absent-Origin
  exception that used to distinguish them is gone).
