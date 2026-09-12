# Agent providers

Set `BUTCHR_AGENT_PROVIDER=claude` (default) or `codex`. Optionally set
`BUTCHR_AGENT_MODEL` to a model available to that provider's account. Invalid
providers and empty explicit model values fail configuration loading.
Without an override Claude retains opus for epic/story/project, sonnet for
task/other, and high effort. Codex inherits its CLI model/reasoning settings;
Claude aliases and `--effort` are never sent to Codex.

Selection applies to new issue and project agents. Existing agents are not
replaced merely because configuration changed. Their argv health is checked
against their observed provider; both providers count as resident processes.
Drain existing agents deliberately before a complete provider migration.

Claude receives `CLAUDE.md`, `brief.md`, `ENVIRONMENT.md`, and `mcp.json`,
with the existing permission and development-channel flags. Codex receives
`AGENTS.md`, the same brief/environment, and a launch-scoped TOML `--config`
override for `mcp_servers.butchr`. It supplies the endpoint, `x-issue`, and
`x-butchr-provider=codex` headers. No global Codex config or authentication
files are modified; project config trust is not needed to load this override.
The factory-created workspace is explicitly trusted in launch arguments so
Codex's first-run directory prompt cannot stall unattended startup. This trust
is scoped to that directory and invocation, not written to global config.
The CLI merges MCP tables, so a full-table override does NOT isolate workers.
At daemon startup, Codex mode inventories `codex mcp list --json` without
connecting to servers, blocks new Codex spawns if inventory fails, and explicitly disables
each inherited server except Butchr in worker argv. This preserves native auth
without copying credentials. Inventory output is never logged. Run Butchr and
Herdr with the same Unix user and Codex configuration; restart the daemon after
changing inherited server configuration. Project-specific or later-added MCP
servers and plugin-provided integrations require separate deployment review.
Inventory is bounded to ten seconds with no automatic retries. If it fails,
the daemon continues serving and managing existing workers, logs the failure,
and refuses new Codex spawns before creating workspaces. Argv-based stale
replacement is also suspended before any existing worker is stopped, until
Codex spawning is available again. Fix the service user's
`codex mcp list --json` and restart Butchr to retry. Unsupported server names
or transports also block new Codex spawns. Only names and transports are persisted in each Codex
workspace's `.butchr-codex-isolation.json`, so restore checks still enforce the
original isolation after changing the daemon default back to Claude. Missing
or malformed metadata is not considered healthy. Disabled overrides include
an inert transport stub because injected app servers may lack base config.
Old provider files in reused workspaces are retained, but are not launch inputs.

Both launches retain the factory's unattended execution policy: Claude uses
`bypassPermissions`; Codex uses `--dangerously-bypass-approvals-and-sandbox`.
Use an appropriately isolated service account/environment. The selected CLI
must be installed and authenticated for the Unix account running Herdr.

## Delivery and deployment

Butchr uses `DrovrClient` from the pinned `@brooswit/drovr` v0.2.0 GitHub
release, including its SDK error and type reexports. Drovr corrects supported
Codex directory-trust dialogs from idle/done to blocked. Those corrected
reports feed the existing status watchers and kickoff checks; nudges refuse
an already-blocked agent, report delivery as false when the prompt response
is corrected to blocked, and never send recovery Enter while blocked.
Drovr does not add a Codex quota classifier or confirm prompt completion.

HTTP MCP tool access is separate from unsolicited notifications. Thatch 0.6.0
uses Claude channel notifications; Butchr excludes Codex connections from
that path. Issue and project updates still use Herdr `agent.prompt`, including
the existing idle/blocked safeguards. Acceptance of a prompt does not prove a
turn completed. Claude session-limit detection is not a complete Codex quota
classifier. Codex readiness, busy/idle wake behavior, and restoration depend
on the installed Herdr agent integration and require an isolated smoke test
before production rollout. No shared SDK or Thatch changes are included.

Verified CLI surface: Herdr 0.8.2 lists both providers and accepts argument
arrays; Codex 0.154.0-alpha.6.2 advertises the model, config, cd, and bypass
flags used here. Drovr v0.2.0 uses SDK 0.1.3 and carries kind/args without a
local path dependency. The published release tarball is pinned in `bun.lock`.
The earlier isolated live smoke verified Drovr's idle, done, and blocked state
corrections. The v0.2.0 package and Butchr integration pass their local gates;
the combined release still requires a fresh deployment smoke before activation.
Official references: [MCP](https://developers.openai.com/codex/mcp) and
[AGENTS.md](https://developers.openai.com/codex/guides/agents-md).

This change is based on canonical factory/butchr main at fa314fa (0.15.5).
The running service currently uses the separate brooswit/butchr checkout.
Review and deploy the build to that service explicitly; editing the canonical
checkout alone does not change the running factory. The deployment owner
coordinates the isolated smoke verification, release, and service activation.

Before activation, run `bun run scripts/verify-codex-config.ts` as the intended
service user. It checks generated argv with installed `codex mcp list/get`,
using an inert loopback URL, without a model prompt or server connection.
After review, configure `BUTCHR_AGENT_PROVIDER=codex` and optionally
`BUTCHR_AGENT_MODEL` in the service environment; have the deployment owner
install the reviewed build and schedule activation. Leave provider unset or
`claude` to retain the default. Do not change either user's global MCP config.
