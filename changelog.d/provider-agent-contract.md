bump: major

### BREAKING
- Replace the daemon's hierarchy-gated agent tools with explicit Jira/Confluence provider operations and role-independent subscriptions. Workflow helpers are no longer advertised; migrate briefs and callers using docs/provider-agent-contract.md before deployment.
- Jira creation no longer infers staffing or parentage; assignment takes an account ID and issue links require an explicit type.

### Added
- Explicit targets for GitHub, Product Discovery and Zendesk operations, retaining own-resource defaults and provider/account authorization. Add jira_update_issue for targeted summary/description edits.

### Fixed
- Verify GitHub targets before fetching comments, and report unconfirmed Zendesk note privacy truthfully.

Bundled briefs use the provider contract; custom brief bodies are preserved. Explicit full comment reads, bounded page reads, document discovery and label operations retain review and reactivation capabilities. Outcome receipts are recorded once per call with explicit target attribution.
