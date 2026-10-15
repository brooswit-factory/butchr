bump: patch

### Fixed

- `jira_get_comments` returns readable comments again: each result carries
  `id`, `body` (plain text flattened from Jira ADF — mentions as display text,
  links as URL), `created` and `author {accountId, displayName, email}`. v2.0.0
  returned `{id}` only. Pagination still exhausts or throws; provider denial
  still propagates; ID-based notification readers are unchanged.
