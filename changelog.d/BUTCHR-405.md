bump: minor

### Added
- Warn once at startup, and report on `/health` under `unresolvedRelationships`, any enabled `jira-work` rule whose `relationships.childRule` or `relationships.inwardConnectionRules` names a rule id absent from this daemon's own loaded rules file.
