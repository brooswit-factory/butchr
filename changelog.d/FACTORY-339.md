bump: minor

### Added
- **`GET /resources/for-url`**: resolves a browser URL (Jira work item, GitHub issue/PR, or Zendesk ticket) to its Butchr resource identity and lists the agent(s) staffed on it, keyed off this daemon's own live/known agent registry rather than re-running any rule's query. Built for Clevr (epic FACTORY-330), a Chrome extension that opens a terminal for a page Butchr is already running an agent on. Gated by a new shared bearer-token + `chrome-extension://` origin allowlist (`BUTCHR_EXTENSION_TOKEN`/`BUTCHR_EXTENSION_ORIGINS`), disabled by default and reusable by future extension-facing routes; every existing route (`/health`, `/state`, `/dashboard`, `/agents`) is unchanged. See `docs/resources-for-url.md`.
