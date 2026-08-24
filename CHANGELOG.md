# Changelog

All notable changes to butchr. Format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
entries are `## [x.y.z] - YYYY-MM-DD` with subsections from: `BREAKING`, `Added`, `Changed`, `Fixed`, `Removed`.
CI refuses a merge that changes `src/` or `package.json` without a new entry here.

## Versioning
- **MAJOR** — a restructuring/rewrite that breaks a lot, requiring reimplementation. Requires a `### BREAKING` section.
- **MINOR** — a new feature, or a change to an existing feature that breaks just that feature.
- **PATCH** — a fix or correction needing no consumer code changes, or very minor ones.

## [0.2.0] - 2026-08-24
### Added
- Distribution: butchr builds to a single executable `dist/butchr.js` and publishes to npm with a `butchr` bin, so machines run it via `npm i -g @brooswit/butchr`. Releases publish on a version bump to `main` (OIDC provenance), matching the library repos.
### Changed
- The daemon fails cleanly with a one-line message (not a stack trace) when required configuration is missing.

## [0.1.0] - 2026-08-24
### Added
- The daemon skeleton: one Elysia server hosting the MCP endpoint agents connect to (`/mcp`, via `@brooswit/thatch`) and a read-only live view (`/health`, `/agents`).
- `config` — env parsing with the Atlassian token read from a file (`ATLASSIAN_TOKEN_FILE`), never logged.
- `atlassian` — a small Jira Cloud REST client (classic-token Basic auth): `search(jql)` and `links(key)`, with an injectable `fetch`.
- `notifyIssue` — pushes a channel update to whichever connected agents identify (via `x-issue`) as working that issue.
