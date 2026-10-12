bump: minor

### Added

- New `confluence-page` resource provider: a rule naming an ancestor
  Confluence page (`{"ancestor": "<page id>"}`) now staffs one agent per
  direct child page, with real cursor-paginated child-page enumeration,
  version/footer-comment change detection, and automatic agent removal when
  a child page disappears.
- Each child agent now receives that child's current Confluence storage body
  as its own bounded, explicitly untrusted brief. Bodies over 32,000
  characters or without a readable storage body are refused for that poll
  rather than being silently truncated into a partial prompt.
