---
bump: minor
---

### Added
- `get_my_confluence_page` / `get_my_confluence_page_comments`: a read path for a managed-session agent whose own resource is a Confluence page (e.g. a future `confluence-page` ResourceType, FACTORY-992) to read that page's body and footer comments from inside its own session. Both verbs are key-less — the page id is derived exclusively from the caller's own `x-issue` header (a bare numeric Confluence page id, validated by the new `isConfluencePageResourceId`, `src/resources/id.ts`), never from an argument, so a caller can only ever read its OWN resource page. `get_doc`/`set_doc`'s behaviour for Jira-ticket-bound docs, and `get_doc_comments`' project-caller-only behaviour, are unchanged.
