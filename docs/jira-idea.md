# `jira-idea`: Jira Product Discovery ideas

`jira-idea` is its own resource provider, separate from `jira-work`, even
though Atlassian's documented basic CRUD for ideas is the ordinary Jira Cloud
REST API: an idea is an issue of type `Idea`. Butchr reuses the Jira
transport (`AtlassianClient`) and nothing else. Ideas get their own rule
provider, agent keys, workspaces, loop, MCP identity and tools.

## The boundary (src/resources/jira-idea.ts)

| issue type | `fields.project.projectTypeKey` | staffed by |
|---|---|---|
| `Idea` | `product_discovery` | `jira-idea` only |
| `Idea` | anything else, or absent | nobody (logged once per rule) |
| anything else | `product_discovery` | nobody (logged once per rule) |
| anything else | anything else, or absent | `jira-work` only |

The check fails closed on both sides. A broad `jira-work` JQL cannot staff an
idea, and a `jira-idea` JQL cannot staff a work item. If Jira stops returning
the project type, ideas stop being staffed rather than turning into work.
The idea tools re-read the issue before every read or comment and refuse
anything this table no longer puts under `jira-idea`, including an issue whose
key now answers as a different key (a moved issue).

## What this build does with an idea

- Search: the rule's JQL through `/rest/api/3/search/jql`, every page, with
  `project` added to the requested fields.
- Change notices: the same issue-level change detection `jira-work` uses
  (status, labels, comments, summary, own-write echoes), with its own nudge
  text naming `jira_idea_get`.
- Agent tools: `jira_idea_get` reads `GET /rest/api/3/issue/{key}` (search
  fields plus `description`) and every comment, oldest first.
  `jira_idea_add_comment` posts one plain ADF paragraph through
  `POST /rest/api/3/issue/{key}/comment`.
- Linked GitHub issues (below): `jira_idea_github_issues` and change
  notices for them.
- No transitions, field edits, issue-link reads, any link writes, labels, or
  detectors that comment.

## GitHub issues linked to an idea (src/rules/jira-idea-type.ts)

**How the link is stored: a Jira remote issue link** on the idea, the
documented Jira Cloud way to point an issue at an item in another system
(`GET /rest/api/3/issue/{issueIdOrKey}/remotelink`, schema
`RemoteIssueLink`: `object.url` and `object.title` required; `globalId`,
`relationship`, `application` optional). Reading needs Browse projects on
the idea's project, and issue linking must be on for the site. JPD ideas are
ordinary Jira issues over the platform REST API, so the endpoint applies to
them. Insights are not used: their API is a separate app-level integration,
and nothing here depends on it.

Recognised: a link whose `object.url` is exactly
`https://github.com/<owner>/<repo>/issues/<n>` (the REST `html_url` form; a
query or fragment is ignored). Owner and repo are lowercased into the
`github-issue` resource id. Pull requests, `www.github.com`, GitHub
Enterprise hosts, other schemes and deeper paths are not issues. Title,
relationship, `globalId` and `application` are free text anyone who can link
the idea may set, and route nothing.

Routing (read-only, one way): agent `R:IDEA` hears GitHub issue `G` when `R`
lists a `github-issue` rule `C` in `inwardConnectionRules`, `C` currently
matches `G`, and `IDEA` has a remote link to `G`. GitHub matches come from
the `github-issue` loop's last complete poll, so ideas hear nothing unless
that loop runs. Notices use GitHub's own change detection. A link appearing
or disappearing is not a change.

Not done, and kept separate until verified live:

- **Creating links** (`POST .../remotelink`). An upsert by `globalId` needs
  Link issues permission and an agreed `globalId` scheme. Nothing writes one.
- **Creating ideas from GitHub issues.**
- **The GitHub for Jira app's development panel.** It is not remote links
  and has no documented read API for this, so its links are invisible here.
- Whether remote links on ideas show in the JPD UI, and whether adding one
  moves the idea's `updated`. Links are re-read every poll instead of
  relying on that.

## Needs empirical proof before any code depends on it

None of the following has been checked against a live site. Each needs a
recorded real response (redacted fixture) before it is modelled:

1. **Project type on search results.** That `/search/jql` with
   `fields=…,project` returns `fields.project.projectTypeKey` =
   `product_discovery` for ideas. The boundary depends on it: without it,
   no idea is staffed.
2. **Issue type name.** That the idea type is named `Idea` on every site,
   and whether a site can rename or localize it. The comparison is
   exact and case-sensitive. The type's `hierarchyLevel` or id may turn out
   to be a better signal.
3. **Other issue types in discovery projects.** Whether a
   `product_discovery` project can hold issue types other than `Idea`. They
   are treated as nobody's today.
4. **JPD fields.** Impact, Effort, Goals, Roadmap/column, Insights (count
   and content), Delivery progress/status, Archived. These are custom
   fields (or Polaris-specific data) whose ids and value shapes vary per
   site. Reading them needs `/rest/api/3/field` discovery plus sample
   values. Writing them needs proof that plain `PUT /issue` edits them.
5. **Delivery links (idea ↔ work item).** The link type JPD creates when an
   idea is delivered by epics or work items (its name and inward/outward
   direction as `issuelinks` reports it), and whether it is visible to the
   Butchr account from both ends. Until that is shown, `jira-idea` rules take
   no `childRule`, their `inwardConnectionRules` name only `github-issue`
   rules, and no other rule may reference a `jira-idea` rule.
9. **Remote links on ideas.** A recorded `GET .../remotelink` for a real
   idea carrying a GitHub issue link, to replace the schema-shaped fixture
   in test/unit/jira-idea-github.test.ts.
6. **Insights.** Whether insights are exposed through any documented REST
   endpoint at all, or only through the JPD UI or GraphQL.
7. **Change detection coverage.** Whether edits to JPD-only fields (votes,
   insights, field values) move `updated`, and whether they are seen at all
   by the fields this build compares.
8. **Comment permissions.** That the configured Jira account may comment on
   ideas in discovery projects (JPD contributor vs creator roles).
