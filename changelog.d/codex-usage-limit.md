bump: minor

### Fixed
- A Codex worker at its usage limit is no longer left idle forever. Codex switches itself to a fallback model ("Automatically switched to Luna Reserve medium due to usage limits.") and Herdr reports the pane idle; Butchr now recognises that notice through Drovr, marks the Codex account quota-blocked until its printed reset, and replaces the worker by re-running provider selection from the top of the configured order (so under `claude,codex` it goes back to Claude). A codex-only configuration marks the worker quota-blocked and waits instead of sitting silently.
- Nudging a Codex worker that is showing the usage-limit menu reports the refusal instead of pressing Enter on the menu's "Add Credits" option.

### Changed
- Bump `@brooswit/drovr` to 0.11.1 for the Codex usage-limit classifier and provider-neutral `observePane`.
