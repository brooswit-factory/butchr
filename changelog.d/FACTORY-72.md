bump: minor

### Added

- New `GET /config-inventory` daemon endpoint and `src/agents/query-agent-inventory.ts`
  module: a read-only inventory of every configured query agent — every rule
  in the daemon's rules file and every managed-session definition (active or
  archived) — whether or not it currently has a running agent. Each rule
  reports a real, computed reason when unstaffed (disabled, missing
  token/config, admission cap, or no current matches), reusing the daemon's
  existing staffing decisions and dashboard state rather than re-deriving
  them. Rules-file and session-definition load/parse errors are captured
  per-file (path + message) instead of being swallowed. No secret values
  (header values, token contents, env values) are ever exposed — only names.
- `SessionDefinitionListEntry` (`butchr session list`'s own shape) gained
  `account`, `permissionMode`, `workingDirectory` and `mcpServerNames`
  (names only) fields, additively.
