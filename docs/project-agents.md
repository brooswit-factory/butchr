# Free-form project resource agents

A `jira-project` rule runs one ordinary interactive agent per matching Jira
project. Its brief is supplied by the operator. There is no Confluence binding,
ticket assignment, check-in protocol, automatic task decomposition, or implied
management hierarchy. Agents remain resident while their project matches.

Project queries are JSON strings, not issue JQL. Supported fields are:

- `leadAccountId`: Jira account ID, or `me` for the configured Jira account.
- `keys`: optional non-empty array of project keys.
- `query`: optional Jira project name/key search text.

For example:

```json
{"rules":[{
  "id":"project-assistants",
  "resourceProvider":"jira-project",
  "query":"{\"leadAccountId\":\"me\",\"keys\":[\"EXAMPLE\"]}",
  "brief":"You are my project assistant. Await my instructions; do not invent work.",
  "agentPreferences":[{"harness":"codex"}]
}]}
```

Discovery reads every [Jira project search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/#api-rest-api-3-project-search-get)
page before filtering by lead and keys. Failed or incomplete discovery leaves
existing agents running. Archived projects are excluded. The rule owns only
`jira-project:<rule>:<project>` agents; ticket rules and bakr agents are separate.
Workspaces use `<BUTCHR_WORKSPACES>/jira-project/<rule>/<project>`. Open the
agent from butchr's existing live view to chat interactively.

## Optional external tools and messages

An operator can set `mcpConfigFile` on a project rule to an absolute path such as
`/home/operator/project-connections/{{KEY}}.json`. `{{KEY}}` is replaced with the
project key. The file uses the standard `mcpServers` format with HTTP or stdio
servers. Optional `notifications: false` disables inbound events for a server.
No external connections are required; there are no built-in chat accounts,
manager names, directors, routing conventions, or integration credentials.

Butchr shares one upstream connection between tools and channel events. Tools
appear under `resource_<server>`. Channel events wake the existing interactive
agent through Herdr. Authenticated local proxy endpoints remain stable across
daemon restarts; operator-owned credentials remain outside the source tree.
`butchr` is reserved as a server name. Restart the daemon to reload connection
configuration, and deliberately relaunch affected agents if the server set changes.
Removing a matching project closes its connections and stops its agent.

Event queues are in memory; restarting the daemon can lose queued events.
Uncertain prompt delivery stops that connection's delivery queue to avoid
repeating actions. Inspect `[connections]` journal entries and resend only after
checking the agent. External MCP permissions come from each configured service;
project agents have no automatic access to ticket/Confluence tools.

Project Codex workspaces use workspace-write sandboxing, on-request approvals,
and automatic approval review. Claude project agents use its default approval
mode. Old ticket-agent permissions are unchanged. A changed workspace retains
files but provider fallback does not import another provider's native transcript;
keep source history during migrations and reference it explicitly in the brief.

Channel relays batch 100ms bursts and queued corrections. Codex pane delivery no
longer waits through Claude's 8-second quota-dialog check. Input is still sent
through Herdr's native agent prompt interface; blocked approval dialogs are never
answered by the relay. App Server hosts use Drovr steering; this pane host retains
native CLI input semantics.
