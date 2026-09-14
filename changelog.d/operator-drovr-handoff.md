bump: minor

### Added
- Provider replacements use Drovr's acknowledged native transcript handoff before retiring the previous worker and dispatching kickoff.

### Changed
- Drovr owns managed worker selection, identity, serialization, launch, and retirement; Butchr supplies workspace intent and provider preferences.
- Isolated Antigravity homes reuse completed onboarding and install the official Herdr session integration.

### Fixed
- Preserve the previous worker when history, replacement startup, or compaction acknowledgement cannot be verified.
- Do not repeat kickoff merely because the replacement completed it quickly.
