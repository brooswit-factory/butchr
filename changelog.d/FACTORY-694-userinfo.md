bump: patch

### Fixed
- The Settings page no longer shows credentials embedded in a non-secret setting's URL value (`scheme://user:pass@host`): the userinfo is redacted in every returned value, including a password that itself contains `@` (FACTORY-694 item 5, from the FACTORY-664 review).
