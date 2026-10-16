# Provider agent contract

Butchr owns provider connections and credentials. Its MCP surface exposes operations on explicit resources using those connections. An agent's task, issue type, project, provider identity or place in a work hierarchy does not grant or remove provider operations. Authentication of the MCP connection and authorization by the connected provider remain required. Identity headers provide attribution and compatible defaults; they are not account credentials.

## Operations

- Jira: read/search, create, update summary/description, comment, transition, assign, priority, explicit issue links, additive/removal label operations, project properties and remote-link reads. `jira_update_issue` changes only the supplied fields. Creation accepts a provider issue-type name, without inferred staffing or mandatory parent links. Assignment accepts an account ID, not a role alias. `jira_link_issues` requires an explicit link type.
- Confluence: create/read/update/search pages, list spaces, read/add footer comments and bounded version-checked document reads, with explicit page/space IDs. The existing provider adapter retains optimistic version locking.
- GitHub issues/PRs: read and comment with optional `target: "owner/repo#number"`.
- Jira Product Discovery: read, list linked GitHub issues and comment with optional `target: "PROJECT-123"`.
- Zendesk: read and internal note with optional `target: "subdomain#number"`. There is no new public-reply operation. A missing privacy audit is reported as `confirmedPrivate: false, internal: null`.
- Existing GitHub/idea linking tools accept an optional target for their formerly implicit side. Live resource checks and deterministic remote-link IDs remain; rule-match relationships are no longer tool authorization.
- `list_links`, `add_link`, `remove_link` operate on explicit canonical resource IDs. They select observations, not workers or ownership.

Omitting a provider target retains the existing own-resource default only when that provider/resource is present in the caller identity. Other callers, including query agents, must supply a target. Supplying a malformed target never falls back to the caller resource.

The surface exposes the operations currently implemented by the provider adapters, not arbitrary HTTP passthrough. New provider operations can be added without inventing agent roles. GitHub organization restrictions, Zendesk account restrictions and credential opt-in, valid resource types, redirect protections, and upstream 401/403 responses remain authoritative. Filesystem and session-controller containment is unchanged. No credentials are returned through tools.

## Compatibility and migration

This is a breaking MCP surface change. The daemon no longer advertises the old hierarchy/workflow tools. Their source remains available to existing internal callers during migration, but they are not an alternative agent permission system.

| Former workflow tool | Provider operation / process |
| --- | --- |
| new_worker, file_where_it_belongs | jira_create_issue with explicit fields; separately link, assign, comment or transition as the workflow requests |
| adopt_worker | jira_link_issues and jira_assign, explicitly chosen by the workflow |
| start_worker, submit_to_boss, finish_worker, finish_without_a_boss | jira_transition with explicit issue and status, after the workflow's required review |
| prioritize_worker | jira_set_priority |
| correct_worker | jira_update_issue; explicitly archive prior text in a comment when the workflow requires it |
| check_worker | jira_get_issue plus existing session/PR evidence sources; issue status alone is not proof of agent activity |
| tell_worker, report_to_boss, ask_boss | jira_add_comment on an explicit issue; preserve review/question conventions in text |
| tell_peer, list_peers | Explicit provider search/read and comment destinations; no inferred project leadership permission |
| get_doc, set_doc, get_doc_comments, get_my_confluence_page, get_my_confluence_page_comments | Read jira_get_project_property or jira_get_remote_link to resolve existing page references; use confluence_read_document, confluence_update_page and confluence_get_comments with explicit IDs. No automatic document binding is introduced |
| check_in, stand_down | No provider-operation equivalent. Finish the turn with a truthful handoff; do not infer a sleep or stop receipt from a Jira write |

An explicit `implements` on jira_create_issue remains a compatibility convenience, with separate create/link outcomes. Omit it for no link; the old string `none` is no longer a valid target. A link failure after creation returns the created issue key: retry the link, not the create. Jira status writes do not imply an agent was stopped, a PR approved or a review delivered.

Bundled briefs now use the provider surface and retain review and hold conventions. Custom brief bodies remain untouched. Before rollout, audit and migrate custom briefs and external callers using this map, inspect the actual exposed tool schemas, and preserve all human approvals, cancellations, freezes and review assignments. This change does not rewrite running sessions or configuration. Deployment requires a separate approved rollout.

## Observation and integrity

A stored subscription does not prove that a watcher exists, an event was delivered or a resulting agent turn ran. Existing polling opt-ins, target support, rate limits and delivery receipts still apply. In particular, jira-project as a subscription target has no watcher yet. Subscriptions do not spawn agents or recursively discover children. Provider reads for observations use the daemon's existing account, not a fictitious per-agent account.

Existing atomic local-file writes, schema/version validation, idempotent links and provider write receipts remain. The Jira project-property link store still has its documented cross-process read-modify-write race; this change does not claim transactional storage across daemon accounts. Coordinate simultaneous edits to the same subscription collection until a storage-concurrency change is made. Jira label adapters also retain their existing read-modify-write race; serialize concurrent edits to the same issue labels.

## Rollout and rollback

1. Review and merge the isolated change; leave deployed services and role/rule configuration unchanged.
2. Prepare migrated briefs/callers, retain a known-good binary and back up configuration/subscriptions. Confirm the operator's provider accounts and existing scopes without extracting secrets.
3. Obtain approval for a concrete rollout covering those migrated briefs and the selected accounts. Drain or wait for active turns; do not inject input into working or human-owned sessions.
4. Verify the actual MCP tool inventory, a permitted explicit-target read, a provider-denied read, and an authorized observation's delivery/resulting turn. Do not fabricate verification events or workers.
5. If rollback is needed, restore the prior binary and its matching briefs. This change introduces no persistent schema migration; preserve any real provider writes and report them rather than undoing them blindly.
