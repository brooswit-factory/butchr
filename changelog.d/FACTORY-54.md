bump: minor

### Added
- Managed-session definitions may now optionally name one or more Jira projects to opt into linked eventing via a new `linkedEventingProjects` field — a non-empty array of canonical `jira-project:<KEY>` references, validated with the same shared `parseResourceRef`/`formatResourceRef` vocabulary every other resource ref already uses. Invalid entries (wrong provider, malformed key, non-array, empty array, non-string, or a duplicate) are rejected at manifest load time with a clear message. A definition without the field parses and behaves exactly as before (FACTORY-52/FACTORY-54). This is schema, parsing, and validation only — no nudge/notify/watch mechanism consumes it yet; that lands in FACTORY-53.
