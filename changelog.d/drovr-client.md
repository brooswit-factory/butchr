bump: patch

### Fixed

- Route Butchr's runtime and operational clients through Drovr v0.1.0 and
  import SDK errors and types through its reexports. Corrected Codex trust
  dialog status reaches the existing blocked-agent handling. Refuse nudges
  to already-blocked agents before sending a prompt, and report delivery as
  false when Drovr corrects the prompt response to blocked.
