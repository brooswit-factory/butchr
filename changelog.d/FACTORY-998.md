bump: minor

### Added

- New `confluence-page` resource provider: a rule naming an ancestor
  Confluence page (`{"ancestor": "<page id>"}`) now staffs one agent per
  direct child page, with real cursor-paginated child-page enumeration,
  version/footer-comment change detection, and automatic agent removal when
  a child page disappears.
