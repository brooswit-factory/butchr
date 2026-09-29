---
bump: patch
---

### Fixed

- **Extension-origin guard rejections are now diagnosable from the journal.** A `403` from `GET`/`OPTIONS /resources/for-url` or the `GET /agents/:agentKey/pty` upgrade path used to leave no record anywhere — "origin required" vs "origin not allowed" vs "allowlist empty" (an operator misconfiguration) could not be told apart without reproducing the request by hand. Each rejection now emits one `[origin-guard]` journal line with the method, the request path (never the query string — it carries the page URL), the `Origin` header verbatim or the literal `"absent"`, and the reason. Rate-limited/deduped to at most one line per distinct (method, path, origin, result) per minute, with a bounded, self-pruning dedupe map (`Origin` is attacker-controlled). Allowed requests still log nothing.
