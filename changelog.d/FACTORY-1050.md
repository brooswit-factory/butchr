bump: minor

### Added

- Select "ollama" as a fourth agent harness (alongside Claude, Codex and
  Antigravity), launching the real Claude harness through
  `ollama launch claude --model <model> --yes -- ...` with the exact three
  authorized local models (qwen3.5:4b, gemma4:12b, qwen3.8:27b) — no
  "Other…" custom model for this harness, unlike every other provider.
  CLAUDE.md/mcp.json/the file-execution-veto hook are written for it exactly
  like a direct Claude launch, and the selected model is pulled before every
  launch, never launching after a failed pull.
- Existing Claude-only resume-in-place/native-transcript-handoff behavior is
  unaffected: an ollama agent always falls back to an ordinary fresh
  spawn on drift, never an unverified resume attempt.
