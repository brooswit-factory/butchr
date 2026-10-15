bump: patch

### Fixed

- `jira_get_comments` returns readable comments again: each result carries
  `id`, `body` (plain text flattened from Jira ADF — mentions as display text,
  links as URL), `created`, `author {accountId, displayName, email}` and `bodyRaw` (the provider ADF). Link hrefs are kept, unsupported nodes appear as `[unsupported type]`, and a malformed response or an empty page before the reported total now throws. v2.0.0
  returned `{id}` only. Pagination still exhausts or throws; provider denial
  still propagates; ID-based notification readers are unchanged.
