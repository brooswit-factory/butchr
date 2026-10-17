# `trello-card`: Trello cards (FACTORY-1009)

`trello-card` is a new resource provider, **additive** alongside the existing
Jira and Confluence providers — it replaces neither, and this first version
changes no other provider's behavior.

## local/ui: `trello-card` rules

Our branch adds the rule type upstream left out (see the next section for
upstream's original scope). It follows `docs/zendesk-ticket.md` closely.

- **Rules.** `"resourceProvider": "trello-card"`. Each open card the query
  matches on the configured board gets one agent per rule, keyed
  `trello-card:<ruleId>:<boardId>#<cardId>`. A card leaving the query (moved
  out of the rule's list, archived, relabelled) stops its agent.
- **Queries.** Free text is matched as one phrase against the card's name and
  description (case-insensitive). Two qualifiers narrow that:
  `list:<name>` (the card is in one of the named lists) and `label:<name>`
  (the card has every named label). Quote names with spaces:
  `list:"Ready for agent" label:bug login`. An empty query matches every open
  card. Parentheses and `AND`/`OR`/`NOT` in the free text are refused when the
  rules file loads.
- **Off until acknowledged.** Like Zendesk, agents run shell commands as the
  daemon's user, so they can read the key and token files and call Trello
  directly, as the token's account, on every board it can reach. No
  `trello-card` rule runs until butchr's environment sets
  `BUTCHR_TRELLO_ACCEPT_SHELL_CREDENTIAL_RISK=agents-can-read-the-trello-credentials`.
  settings.json can't set it, and the Settings page only shows it.
- **Tools.** `trello_get_card` (name, description, list, labels, due date, url
  and every comment, oldest first) and `trello_add_comment` (one comment,
  prefixed `[butchr <rule>]`; refused on an archived card). Every Trello comment
  is visible to everyone who can see the board.
- **Change notices.** An agent is nudged when its card moves to another list,
  is renamed, has its description, labels or due date changed, or gets a new
  comment. Nudges carry no card text. Its own comment isn't echoed back.
- **Polling.** Once a minute, sharing the host admission cap, with no label
  sync or stall detection. `/health` reports it under `resourceLoops`.
- **Not verified live.** Everything is covered by unit tests against fakes
  only (`test/unit/trello-card-rules.test.ts`); no live Trello board has been
  run against yet.

## Scope of upstream's first version

This ships only `src/resources/trello-card-ref.ts` (resource identity) and
`src/resources/trello-card.ts` (credential loading + REST client), wired into
the shared `capabilities.ts`/`comments.ts` mechanism (`query`, `read`,
`comments` declared true; `snapshot`, `links`, `createTask` false — the same
shape `zendesk-ticket` declares, for the same reasons: no event-rules/poll
wiring exists, and it is excluded from `ResourceRef`/the managed link store).

**Deliberately NOT included**, because no live Trello account exists yet and
the user has not decided whether to adopt Trello at all:

- No `trello-card` rule type or agent staffing (nothing spawns an agent for a
  Trello card today — there is no way to even configure a rule for it).
- No MCP tools (`trello_get_card`, or similar) — no agent can reach this
  client through a tool call yet.
- No daemon loop/event rules — no polling, no notifications.

Everything in `trello-card.ts` is covered by `test/unit/trello-card.test.ts`
and `test/unit/trello-card-ref.test.ts` against a **mocked** `fetch` only.
Nothing in this change has been run against the real Trello API — there is no
configured board/key/token to run it against. If/when staffing, tools, or a
daemon loop are added, they need their own live-acceptance pass the way
`zendesk-ticket`'s did (see `docs/agent-providers.md` and
`docs/provider-capabilities.md` for that bar).

## Identity and scope

A card is `<boardId>#<cardId>` — both Trello board and card ids are 24-hex
Mongo ObjectIds. Card ids are globally unique on their own (unlike a Zendesk
ticket id, which is only unique within one subdomain), but this provider is
still configured for exactly **one** board (`TRELLO_BOARD_ID`): `get`,
`comments` and `addComment` all refuse a card whose `idBoard` doesn't match
it, the same way `zendesk-ticket` refuses a ticket outside its configured
subdomain.

## Auth

Trello's REST API takes an API key **and** an API token as `key`/`token`
query-string parameters on every request — there is no bearer-header scheme
here, unlike Zendesk/GitHub. Both are read from files
(`TRELLO_API_KEY_FILE`, `TRELLO_TOKEN_FILE`), each checked with the exact same
discipline Zendesk's own token file gets:

- a regular file,
- no group or other permission bits (`chmod 600`, or `400`),
- owned by the daemon's user or by root,
- one value, no whitespace inside it.

These checks protect the credentials from other OS users. They do not protect
them from the agents, which (today: not applicable — no agent reaches this
client at all yet) would run as the daemon's user, same caveat
`zendesk-ticket.md`'s own "Security limit" section states for its provider;
revisit this note when staffing/tools are actually added.

Every request goes to `https://api.trello.com/1/...` and refuses redirects,
so neither value is ever sent to another host. `trello-card.ts`'s own request
helper logs method and path only — never the query string, which is where
the key and token live.

## Setting up the Trello side (for a future live pass — not needed to use this code today)

1. Create a **Power-Up** at https://trello.com/power-ups/admin to get an API
   key, or use an existing one.
2. Generate a **token** authorizing that key against the account that owns
   the target board, scoped read/write on `account` as narrowly as Trello's
   token-generation UI allows (read access to cards/comments, write access to
   post comments only — Trello does not have Zendesk-style private notes, so
   there is no "comment visibility" scope to narrow further; every comment
   this client posts is visible to the whole board, like any other Trello
   comment).
3. Store both values on the daemon host, e.g.:

   ```sh
   install -m 600 -o "$BUTCHR_USER" /dev/null /etc/butchr/trello-api-key
   install -m 600 -o "$BUTCHR_USER" /dev/null /etc/butchr/trello-token
   # paste each value into its file with an editor; never on a command line
   ```

   and set `TRELLO_BOARD_ID`, `TRELLO_API_KEY_FILE`, `TRELLO_TOKEN_FILE` in
   the daemon's environment.
4. Nothing in this codebase reads these values today outside tests that pass
   their own fakes — setting them has no effect until a caller (a future rule
   type, tool, or script) is built against `createTrelloCardClient`.
