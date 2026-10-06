bump: minor

### Added
- Setup now finishes without a shell: after a successful first-run setup the daemon exits so its supervisor (systemd or launchd) restarts it in normal mode, and the Setup page reloads when it is back.

### Fixed
- A mistyped setup code no longer spends rate-limit budget; the limits apply only after a correct code.
- Settings: an environment-set key is refused with 409 and shown as not editable; the fleet cap has a hard maximum of 100 that `confirm` cannot lift, and a confirmed value up to it survives the next start.
- Partial Atlassian configuration exits with a message naming every input (including the identity and token files).
