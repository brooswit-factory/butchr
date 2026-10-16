---
bump: patch
---

### Fixed

- **`POST /resources/for-url` silently treated a missing/wrong `Content-Type` the same as a JSON body with no `url` field (FACTORY-487, a follow-up nit from agentsafety's review of FACTORY-480/butchr#564).** Elysia only parses `body` as JSON when `Content-Type` is the exact-case media type `application/json` (optionally with a `;charset=...` suffix) — anything else left `body` unparsed (or, for some content-types, the raw request text), which the route's existing "absent/malformed `url` is just the empty-string case" fallback couldn't tell apart from a legitimate empty lookup. `src/web/view.ts`'s POST handler now checks `Content-Type` itself, after the Origin guard and before reading `body`, and returns `415` for anything but `application/json` (matched case-sensitively, on purpose, to mirror exactly what Elysia itself recognizes as JSON — measured, not assumed).
- Corrected the route-wiring comment above the POST handler, which claimed "the guard check happens BEFORE the body is ever read" as if that were a property of request handling generally — Elysia's own parse step has already read the raw body by the time any handler runs at all; the guard only ever controls what THIS HANDLER does with a request it didn't refuse. `docs/resources-for-url.md`'s `POST` contract now documents the `415` behavior and the case-sensitivity choice.
