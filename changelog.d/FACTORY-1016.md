bump: minor

### Changed

- The global per-ticket stall wake (`[butchr:stall]` comment,
  `src/agents/stall-remediation.ts`) is now gated by a new
  `BUTCHR_STALL_REMEDIATION_MODE` setting, defaulting to `off`. It was
  previously unconditional, posting a Jira comment on every ticket whose
  `agent:stalled` label stayed applied, which woke idle/done agents merely
  because time elapsed. `agent:stalled` labeling itself and ordinary
  review/user comment delivery are unaffected; set
  `BUTCHR_STALL_REMEDIATION_MODE=live` to restore the old always-on
  behavior.
