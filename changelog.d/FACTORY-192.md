bump: patch

### Fixed
- `changelog.d/` fragments with a `### Heading` outside the recognised set (`BREAKING`/`Added`/`Changed`/`Fixed`/`Removed`) — including a misspelled, multi-word, or punctuated one — now fail the release gate and the merge-time release computation instead of silently dropping the bullets under them.
