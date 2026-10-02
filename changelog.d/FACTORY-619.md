bump: patch

### Fixed
- `.env.example` no longer ships real Atlassian accountIds as ACTIVE values
  for `BUTCHR_ASSIGNEE_STORY`/`BUTCHR_ASSIGNEE_TASK` — both are now
  commented out with placeholders, so an unedited copy leaves the roles
  unset and the `jira_create_issue` refusal protects a new user (FACTORY-619,
  GitHub #617).
- `release.yml`'s dead npm-publish path (the step, `id-token: write`, and the
  `setup-node`/`npm install -g npm@latest` steps it needed) is removed; the
  workflow stays disabled, now with a header comment saying so and why.
  `README.md`'s install instructions now describe the clone/`bun
  install`/`bun run build`/run steps that actually work, replacing the
  `npm i -g @brooswit/butchr` line (FACTORY-620, GitHub #615).
