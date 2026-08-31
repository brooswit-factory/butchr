bump: patch

### Fixed
- `briefs/epic.md` never told an epic to move a staffed story to In
  Progress, so a compliant epic filed correctly-assigned stories and then
  left them all in To Do, waiting forever on events from agents that were
  never spawned. Step 2 now states the instruction and its consequence
  inline, mirroring the equivalent rule already present in `briefs/story.md`.
