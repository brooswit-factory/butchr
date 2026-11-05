bump: minor

### Fixed
- Validation-mode retirement now holds the same kernel-backed exclusive control-directory writer transaction as daemon startup, alongside the canary-control lock and stopped-service checks. Plans bind the existing private lock-file identity; competing writers, replacement files and unknown service state refuse retirement. Unrelated protected processes no longer require inspection. Partial workers and independent holds remain blocked.
