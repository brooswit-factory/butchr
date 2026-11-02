bump: patch

### Fixed
- Allow validated saved remote rule authority to restart with live workers when the local default rules file is absent, retaining census failures and lifecycle fences.
- Keep consumed continuation permits inert on daemon restart instead of failing policy-reader initialization; preserve the consumed receipt and all execution fences.
