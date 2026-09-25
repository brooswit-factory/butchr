# `mcpServers`: binding a rule to additional MCP servers

BUTCHR-411 (task of story BUTCHR-395, epic BUTCHR-391), CNDLX-45. Adds
`Rule.mcpServers` (`src/rules/rules.ts`): a rule can bind its agent(s) to any
number of MCP servers beyond butchr's own, each independently flagged as a
Claude "channel" (push notifications) or tools-only. This is what lets an
agent receive event-driven pushes from a non-Rocket.Chat MCP server — the
same mechanism `server:butchr` has always used — with no polling substitute
and no dependency on `Rule.account` (BUTCHR-397/398's Rocket.Chat lifecycle
field). Concrete case: the 10 Candlestix MUD players, whose shared
`mud-mcp` HTTP bridge delivers telnet output as MCP channel events, and who
get NO Rocket.Chat account (`account: "none"`) under the sibling S4 task.

## The field

```jsonc
{
  "rules": [
    {
      "id": "mud",
      "resourceProvider": "jira-work",
      "query": "project = CNDLX",
      "brief": "…",
      "account": "none",           // no RC account — see docs/execution-modes.md
      "mcpServers": [
        {
          "name": "mud-mcp",
          "type": "http",
          "url": "https://mud-bridge.internal/mcp",
          "headersEnvVar": "MUD_MCP_HEADERS",   // optional
          "channel": true
        }
      ]
    }
  ]
}
```

| field | required | notes |
|---|---|---|
| `name` | yes | letters/digits/`_`/`-`; unique within the rule's own `mcpServers`; `"butchr"` is reserved (it always names butchr's own server) |
| `type` | yes | `"http"` only, today |
| `url` | yes | absolute `http:`/`https:` URL |
| `headersEnvVar` | no | the NAME of an env var on **this daemon's own process** holding a JSON object of extra HTTP headers — see "Headers are by reference, never inline" below |
| `channel` | yes | `true`: Claude also receives this server's push notifications (one more `--dangerously-load-development-channels=server:<name>`); `false`: MCP tool access only |

Validation (`parseRules`, same house style as every other rule field —
unknown fields rejected, every problem reported at once): a non-empty array,
each entry an object with only the fields above, a well-formed name and
URL, `channel` a boolean, and no duplicate or reserved (`butchr`) names
across one rule's bindings.

**Absent means none.** A rule with no `mcpServers` key parses exactly as it
did before this ticket — no new field appears on the parsed `Rule`, and
every downstream consumer (launch argv, `mcp.json`, staleness) produces
byte-identical output to pre-BUTCHR-411 code. This is deliberate and tested
(`test/unit/rules.test.ts`, `test/unit/argv.test.ts`, `test/unit/workspace.test.ts`):
a deploy of this feature must not respawn a single fleet-wide agent whose
rule doesn't use it.

### Headers are by reference, never inline

A binding never carries a literal header value. `headersEnvVar` names an env
var on the daemon's own process; `resolveMcpServerHeaders` (`src/agents/workspace.ts`)
reads it at launch/workspace-build time, expecting a flat, string-valued
JSON object (`{"Authorization": "Bearer …"}`). Missing, empty, malformed
JSON, or a non-flat/non-string-valued object all resolve to "no extra
headers" rather than throwing — a bad or rotated secret must not crash
workspace building or block every other rule's launch. When that happens,
`resolveMcpServerHeaders` logs exactly one line naming the binding and the
env var — never the raw env value — so an authenticated bridge that
silently ends up unauthenticated has something to point at, rather than
just failing later with no trail.

**Where a resolved header VALUE is allowed to live, and where it is not**
(review finding, PR #387 — the reason this section exists): a resolved
header value may appear in `mcp.json` (Claude only — see the permissions
note just below) and nowhere else. It is NEVER put on a process command
line — Codex's launch deliberately omits it (see "Codex" below) — and it
never appears in a log line: `resolveMcpServerHeaders`'s own diagnostic
line above names the binding/env var, not the value, and nothing downstream
of it (argv, `staleIssues()`'s `observedArgv`, the `[reconcile] … respawned`
journal line) carries header content at all, because none of those inputs
ever contained it in the first place.

**`mcp.json` file permissions.** `buildWorkspace` `chmod`s `mcp.json` to
`0600` (owner read/write only) whenever it embeds a bound server's resolved
header — tightened explicitly with `chmodSync` after the write, not via
`writeFileSync`'s own `mode` option, because that option only applies when
the call CREATES the file; a rebuilt workspace's `mcp.json` already exists
and would otherwise keep whatever permissions it had. A binding-less
`mcp.json`, or one with bindings that carry no resolved header, keeps
today's exact default permissions — untouched, byte-for-byte the same
behaviour as before this ticket.

## Launch wiring

### Claude

- **`mcp.json`** (`buildWorkspace`, `src/agents/workspace.ts`): every bound
  server lands in `mcpServers` alongside `butchr`'s own entry, `channel` or
  not — this is what gives Claude MCP **tool** access to it. No bindings ->
  the exact same `mcp.json` butchr wrote before this ticket.
- **Development channels** (`agentLaunchConfig`, `src/agents/argv.ts`):
  `developmentChannels` is `["server:butchr", ...bound channel:true servers]`
  — `server:butchr` always first, exactly as before. Each channel is its own
  `--dangerously-load-development-channels=server:<name>` flag (Drovr joins
  the value with `=`; the variadic flag would otherwise swallow a trailing
  positional — see argv.ts's own comment and CHANGELOG 0.5.6). The kickoff
  prompt positional stays first, ahead of every flag. Multiple channel
  servers just work: each gets its own flag.
- A `channel: false` binding reaches `mcp.json` but never the channel flag —
  tools yes, push no.

### Codex

Codex has no development-channel concept at all (Codex's own push/wake path
is BUTCHR-359, explicitly out of scope here). Every bound server — `channel`
true or false, the flag is meaningless to Codex — is added to the launch's
`mcpServers` array (`src/agents/argv.ts`, `boundCodexServers`) alongside
`butchr`'s own entry, the same way `mcpIdentityHeaders` already is. Drovr
renders each as its own `--config mcp_servers.<name>={ url = "…", enabled =
true }`. **What a Codex agent gets today, explicitly, per this ticket's own
DoD:** MCP **tools**, yes — the bound server behaves exactly like any other
Codex MCP server; channel **push**, no — there is no channel push to Codex
at all, bound server or not.

**A bound server's `headersEnvVar` is NEVER sent to Codex, loudly by
design** (review finding, PR #387): Drovr renders a Codex MCP server's
`headers` as `http_headers = {...}` inside a `--config` argument — a real
process command-line argument, visible to any other local user on the host
via `ps`/`/proc`, and also exactly what `staleIssues()`/`onRespawn` would
echo verbatim into `observedArgv` and the daemon journal on a stale
respawn. `headersEnvVar` exists specifically so a header value (often a
bearer token) never lands anywhere but the daemon's own process
environment and the agent's own `mcp.json` (Claude only, and permission-
tightened — see above); Codex argv is exactly such an "anywhere else", so
`boundCodexServers` (`src/agents/argv.ts`) never calls
`resolveMcpServerHeaders` at all. A binding with `headersEnvVar` set still
reaches Codex — just with no extra headers, so an authenticated bridge
connects unauthenticated from Codex specifically. If a bound server needs
authentication AND Codex tool access, route Codex's connection through a
mechanism that doesn't put the secret in argv (out of scope for this
ticket) rather than relying on `headersEnvVar`.

### AGY

Unaffected. AGY's launch (`agentLaunchConfig`'s `agy` branch) never reads
`spec.mcpServers`; `buildWorkspace` never writes `mcp.json` for AGY at all
(it uses its own bridge mechanism, `.butchr-agy.json` + `bridgeWorkspace`).
A rule that binds MCP servers and later falls back to (or is configured
for) AGY simply launches exactly as it would have before this ticket —
bindings must not break AGY's launch, and structurally cannot, since AGY's
code path never looks at them.

## Staleness: `staleIssues()` and `mcpBindingsOf`

`HerdrHerd.staleIssues()` (`src/agents/herd.ts`) rebuilds each running
agent's EXPECTED argv from almost nothing — just the decoded agent key
(`key`/`resource`) and provider — because it has no cached copy of the
`SpawnSpec` a rule's agent was originally launched with. Before this
ticket, that was fine: nothing else in argv depended on anything more.
`mcpServers` broke that assumption, so `staleIssues()` needed a new way to
learn a running agent's rule's current bindings.

**The seam:** an optional 9th constructor parameter, `mcpBindingsOf: (issue:
string) => readonly McpServerBinding[] | undefined`. `HerdrHerd` is one flat
instance shared by every rule of every provider (`src/daemon/index.ts`), so
it cannot hold per-rule state itself; the caller resolves an issue id to its
rule's current `mcpServers`. `src/daemon/index.ts` wires this exactly the
way `roleOfAgent` (BUTCHR-398, same file) already resolves a different
rule-level field from a running id: decode the agent key, look up the rule
by `(ruleId, resourceProvider)` in the loaded `rules`, return
`rule?.mcpServers`.

**Why this closes the "fleet-wide respawn on deploy" hazard the ticket's
own survey named:** the parameter is optional and defaults to "no bindings
for anyone." A rule that never sets `mcpServers` — which, on the day this
ships, is every existing rule — resolves to `undefined` either way, so the
expected argv `staleIssues()` computes is byte-identical to what it computed
before this ticket, for every agent already running. Nothing gets
respawned. Only a rule that actually adds `mcpServers` changes what its
OWN agents' expected argv contains, which is exactly what should happen: an
agent launched without the new binding correctly reads as stale against it
(the ticket's own DoD line), and one launched WITH it does not.

Test coverage: `test/unit/herd.test.ts` (`staleIssues — mcpBindingsOf /
MCP server bindings`) covers all four shapes — `mcpBindingsOf` omitted
entirely, resolving bindings for a matching agent, an agent launched
without a binding its rule now has, and a rule `mcpBindingsOf` resolves to
`undefined` for.

**Known gap (review finding, PR #387), recorded rather than silently left**:
staleness compares ARGV, and for Claude a binding's `url` and resolved
headers are NEVER part of argv — only `name` (via the channel flag, and
only for `channel: true` entries) is. So changing an EXISTING binding's
`url` or its `headersEnvVar`'s resolved value (same `name`, same `channel`)
rewrites `mcp.json` the next time that agent is (re)spawned for any other
reason, but does **not**, by itself, make `staleIssues()` respawn an
already-running Claude agent to pick it up — the running agent keeps
talking to the OLD url/headers until it is restarted some other way (a
crash, a manual `stop`, an unrelated respawn). Adding or removing a whole
binding, or flipping its `channel` flag, IS visible to staleness (both
change the channel-flag set), so those cases behave as documented above.
If a rule needs a `url`/header change to reach already-running agents
promptly, restart them explicitly rather than relying on reconciliation.

## Worked example: the Candlestix MUD bridge

```jsonc
{
  "id": "mud", "resourceProvider": "jira-work", "query": "project = CNDLX",
  "brief": "…", "account": "none",
  "mcpServers": [{ "name": "mud-mcp", "type": "http", "url": "https://mud-bridge.internal/mcp", "channel": true }]
}
```

- `specForMatch`/`specForRuleQuery` (`src/rules/resource-type.ts`) copy
  `rule.mcpServers` onto the agent's `SpawnSpec` — the same pattern
  `agentPreferences` already uses. `SpawnSpec` has no `account` field at
  all, so this path structurally cannot read Rocket.Chat account policy
  even by accident.
- `buildWorkspace` writes `mcp.json` with both `butchr` and `mud-mcp`.
- `agentLaunchConfig` produces `developmentChannels: ["server:butchr",
  "server:mud-mcp"]` and the matching `--dangerously-load-development-channels`
  flags.
- The MUD players' agents wake on telnet output the same way every butchr
  agent already wakes on a Jira comment — no `mud_status`/`mud_read`
  polling loop, and no Rocket.Chat account anywhere in the picture.

See `test/unit/rule-engine.test.ts`'s `mud-bridge worked example` describe
block for the executable version of this walkthrough, end to end through
`specForMatch` -> `buildWorkspace` -> `agentLaunchConfig`/`spawnArgs` ->
`checkArgv`.

## Evidence of event-driven delivery: what was verified, and what wasn't

The ticket's own DoD asks for a staged proof that a real Claude session,
launched with this ticket's argv against a tiny local test MCP channel
server, receives that server's push **without polling**. This is what was
actually done, and where it fell short of a clean, unambiguous pass —
recorded here rather than claimed as more than it is.

**Built:** `scripts/verify-channel-delivery.ts` — a minimal MCP server built
directly on `@brooswit/thatch` (the exact library butchr's own daemon uses
for `notifyIssue`/`notifyAgent`, `src/daemon/app.ts`), which repeatedly
pushes a `notifications/claude/channel` frame (via `mcp.sendAll`, thatch's
own real API — not a hand-rolled reimplementation) to whatever connects. It
launches a real `claude` process bound to that server via
`--dangerously-load-development-channels=server:probe`, `--strict-mcp-config`,
and `--tools ""` (a deliberately bounded, text-only, tools-disabled
session), then inspects the session's own JSONL transcript for a reply
containing a one-time token. Not run by `bun run check` — same "manual, not
CI" shape as `scripts/verify-codex-config.ts`.

**Confirmed, directly:**
- The transport-level delivery this ticket's argv/mcp.json wiring is
  actually responsible for: `mcp.sendAll` reported the frame accepted
  (thatch's `"C2"` claim — "a connected client's transport accepted the
  frame") for a **second, non-butchr, arbitrarily-named channel server**,
  repeatedly, over multiple pushes — proving the flag/`mcp.json` machinery
  this ticket adds generalises past `server:butchr` at the wire level.
- The underlying mechanism this whole feature rests on — a Claude session
  receiving a `notifications/claude/channel` push mid-conversation, with no
  polling — is real and already in production: **this very task's own
  agent session received exactly such a push from `server:butchr` twice
  while working this ticket** (`[butchr] Ticket BUTCHR-411 …` arriving
  unprompted, mid-turn, as a `<channel source="butchr" …>` block). That is
  first-hand, not inferred.

**Not conclusively verified:** whether a session launched via Claude Code's
own `--bg` (background-session) feature specifically picks up a LATER push
and starts a new turn from cold-idle with no further input. Repeated runs
(11 pushes over ~50s, all individually transport-confirmed) did not produce
a corresponding reply in the `--bg` session's transcript. The likely reason,
recorded in `scripts/verify-channel-delivery.ts`'s own top comment:
`claude agents --json` shows every REAL butchr/herdr-launched agent as
`"kind": "interactive"` — herdr keeps Claude resident in an actual PTY pane
it continuously manages — while `--bg` is a **different**, Claude-Code-native
background-session residency mechanism (`"kind": "background"`). There is no
way to drive herdr's own PTY-pane residency from outside butchr without
touching the live daemon, which BUTCHR-368 and this ticket's own brief both
forbid. So this gap is a limitation of what could be reproduced in this
environment, not a demonstrated defect in the feature: the piece the gap
touches (does a resident PTY pane's attached channel stream survive across
turns the same way `--bg`'s does) is unchanged by this ticket either way —
this ticket only decides WHICH server names get the flag, identically for
`server:butchr` (already relied on in production) and any bound server.

## Coordination with S2 (BUTCHR-393)

BUTCHR-393 (the managed-session definition format) reuses this shape
verbatim rather than defining its own. `McpServerBinding` (`src/rules/rules.ts`):
`{ name, type: "http", url, headersEnvVar?, channel }`. See the coordination
comment on BUTCHR-411 from the story agent (BUTCHR-395) and the reply
posted on BUTCHR-393 once this branch was pushed.
