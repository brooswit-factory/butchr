# `zendesk-ticket`: Zendesk Support tickets

`zendesk-ticket` is its own resource provider. A rule names Zendesk search
syntax; each matching ticket gets one agent per rule, keyed
`zendesk-ticket:<ruleId>:<subdomain>#<id>` and working in
`<workspace root>/zendesk-ticket/<ruleId>/<subdomain>%23<id>`.

This first version reads tickets and adds **internal notes only** through
its tools: no tool, argument or client method sends a public reply (see
"What an agent can do" below). That is not a security boundary against a
shell-capable agent, so Zendesk is off until explicitly acknowledged (see
"Security limit" next).

## Security limit: the tools are not a sandbox

The internal-note-only guarantee below holds for **the MCP tools only**. It
is not a boundary against the agent itself. Agents run with shell access
(Claude with `bypassPermissions`, Codex without its sandbox) as the same OS
user as the daemon. Such an agent can read `ZENDESK_OAUTH_TOKEN_FILE`, or the
daemon's environment under `/proc`, and call the Zendesk API directly with
the token. That includes posting a public reply, changing any ticket the
account can reach, or sending the token elsewhere. The file-mode checks keep
the token from other users on the host, not from the agents.

So Zendesk staffing is **off by default**, even with rules and credentials
configured, until the operator sets

```sh
BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK=agents-can-read-the-zendesk-token
```

(exactly that value). Without it, no `zendesk-ticket` rule runs, the token
file is not read, leftover `zendesk-ticket` agents are stopped, and startup
and `/health` give the reason.

Before setting it, the real boundary is what Zendesk enforces for the token's
account: a dedicated agent whose role allows private comments only (or a
light agent), limited to the groups the rules need, and the narrowest OAuth
scopes (see "Setting up the Zendesk side"). Butchr does not isolate agents
from its credentials; running them as a separate OS user or in a sandbox
without the token file is not implemented.

## Configuration

| variable | meaning |
|---|---|
| `ZENDESK_SUBDOMAIN` | The subdomain alone: `acme` for `https://acme.zendesk.com`. |
| `ZENDESK_OAUTH_TOKEN_FILE` | Path to a file holding one OAuth access token and nothing else. |
| `BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK` | Must be exactly `agents-can-read-the-zendesk-token`, or Zendesk stays off. See "Security limit". |

They are read only when at least one enabled `zendesk-ticket` rule exists.
Zendesk staffing **fails closed**: if the acknowledgement is not set, or
either of the others is missing, or any check below
fails, no `zendesk-ticket` rule runs. Nothing is searched or spawned, any
`zendesk-ticket` agent left from an earlier run is stopped, and startup logs
the reason. `/health` reports it under `resourceLoops`. Jira, GitHub and idea
rules run as usual.

Checks on the token file (read only after the acknowledgement passes):

- a regular file,
- no group or other permission bits (`chmod 600`, or `400`),
- owned by the daemon's user or by root (the daemon must still be able to read
  it: a root-owned `0600` file works only for a daemon running as root),
- one token, no whitespace inside it.

These checks protect the token from other OS users. They do not protect it
from the agents, which run as the daemon's user.

Email/API-token authentication (`{email}/token:{api_token}` basic auth) is
**not supported**. If `ZENDESK_EMAIL` or `ZENDESK_API_TOKEN` is set, Zendesk
staffing refuses to start until it is removed, so there is never a question
of which credential is in use.

Every request goes to `https://<ZENDESK_SUBDOMAIN>.zendesk.com/api/v2/...` with
`Authorization: Bearer <token>` and refuses redirects, so the token is never
sent to another URL. Log lines, errors and `/health` never include the token.

## Setting up the Zendesk side

Use a **dedicated agent account** for Butchr, not a person's account and not
an admin.

1. **Create the account** as an agent. Every note Butchr writes is authored
   by it, and each note is prefixed `[butchr <rule>]`.
2. **Limit what it can see.** Search results and ticket reads are limited to
   the tickets this account can view. On plans with custom roles, give it a
   role that can view only the groups your rules need. That is the real
   boundary on which tickets an agent can read.
3. **Make public comments impossible for the account too** (recommended
   defence in depth). On plans that offer it, choose a role whose comment
   access is private only, or make the account a light agent. Butchr already
   sends only `public: false`, and this makes Zendesk enforce the same rule.
   Check which option your plan has in Admin Center.
4. **Create an OAuth client** in Admin Center (Apps and integrations → APIs →
   OAuth clients).
5. **Get an access token for the dedicated account**, not for an admin. For
   example, use the authorization-code grant while signed in as that account.
   Request the narrowest scopes that work. Butchr needs to read tickets,
   search tickets, list ticket comments, and update a ticket to add a
   comment. Start with `tickets:read tickets:write`. If search is refused
   with 403, Zendesk may require the broader `read` scope for search. Verify
   this against a test ticket before enabling rules. Never grant scopes for
   users, organizations, triggers, webhooks or admin APIs.
6. **Store the token** on the daemon host, for example:

   ```sh
   install -m 600 -o "$BUTCHR_USER" /dev/null /etc/butchr/zendesk-oauth-token
   # paste the token into the file with an editor; never on a command line
   ```

   and set `ZENDESK_SUBDOMAIN` and `ZENDESK_OAUTH_TOKEN_FILE` in the daemon's
   environment. Butchr does not refresh tokens. When a token expires or is
   revoked, polls fail with HTTP 401 (visible in `/health`). Replace the file
   and restart the daemon.
7. **Audit triggers and automations.** An internal note is a ticket update.
   Butchr guarantees the comment is private, but it cannot control your
   account's business rules. A trigger that emails the requester on any
   update (instead of only on public comments) would still fire. Make sure
   requester notifications check "Comment is public".

## Rules

```json
{ "id": "escalations", "resourceProvider": "zendesk-ticket",
  "query": "status<solved tags:escalate group:\"Tier 2\"",
  "brief": "Investigate and leave an internal note with findings." }
```

- Every search adds `type:ticket`. A query naming `type:` itself, or using
  `AND`/`OR`/`NOT` or parentheses, stops the daemon at startup.
- `zendesk-ticket` rules take no `relationships`. No other rule may reference
  one.
- Searches read every page (`GET /api/v2/search.json`, created order, 100 per
  page). A query matching more than 1000 tickets (the Search API's limit), or
  a response that cannot prove it is complete, fails the whole poll instead
  of stopping agents whose tickets were not listed.
- The loop polls once a minute and shares the host admission cap. It gets no
  label sync, stall/parked/abandoned detection, or respawn and crash-loop
  comments: nothing except an agent's own note is written to a ticket.
- Zendesk's search index lags ticket changes, so a new or changed ticket can
  take a few minutes to match.

## What an agent can do (src/tools/zendesk-ticket.ts)

A `zendesk-ticket` agent identifies to MCP with `x-butchr-agent` alone. A
connection that also sends `x-issue` is refused. Neither tool takes a ticket
argument: the ticket is always the caller's own.

| tool | API | effect |
|---|---|---|
| `zendesk_get_ticket` | `GET /api/v2/tickets/{id}.json`, `GET /api/v2/tickets/{id}/comments.json` (cursor paged) | subject, description, status, priority, type, tags, agent-UI URL, and every comment oldest first, each marked `public` or not |
| `zendesk_add_internal_note` | `PUT /api/v2/tickets/{id}.json` with exactly `{"ticket":{"comment":{"body":…,"public":false}}}` | one private note; the ticket is re-read first, and a closed ticket or a ticket outside `ZENDESK_SUBDOMAIN` is refused |

After the update, Zendesk's audit is checked. A comment recorded as public
is logged as an error and returned to the agent as a tool error. An audit
that does not say is logged as a warning. The note tool changes nothing else:
not status, assignee, group, tags, fields or requester.

Jira, Confluence, GitHub and idea tools refuse `zendesk-ticket` agents, and
the Zendesk tools refuse every other caller. The tools exist only while
Zendesk staffing runs. These are limits on the tools, not on the agent: an
agent that reads the token can bypass them (see "Security limit").

## Change notices (src/rules/zendesk-ticket-type.ts)

An agent is nudged, with a message naming `zendesk_get_ticket` and carrying no
ticket text, when its ticket's status, subject, priority, type or tags change.
It is also nudged when a comment newer than the last poll appears: a move
in `updated` with no field change reads the comments, and anything else
(SLA or metric updates, custom fields) notifies nobody. Its own note is not
echoed back. A ticket entering or leaving a rule's query spawns or stops its
agent and sends no notice.

## Not in this version

- Public replies, status changes, assignment, tags, macros, or creating tickets.
- Attachments, custom fields, side conversations, requester or organization details.
- Relationships to or from other providers.
- Dashboard ticket details and links.

## Needs live verification before enabling

This build was tested against recorded response shapes only. It has made no
live Zendesk calls. Check these against a sandbox or test ticket:

- which OAuth scopes the search endpoint accepts (`tickets:read` alone, or `read`),
- the `audit.events[].public` field on the `PUT` response for a private comment,
- that the chosen role or light-agent setting refuses a public comment from the account,
- the account's triggers do not email requesters on a private update.
