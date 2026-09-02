bump: patch

### Fixed
- **The `[butchr:crashloop]` complaint no longer asserts that the agent ran and then failed to stay up or died (BUTCHR-161).** The detector is called with `plan.spawn` *before* the spawn loop runs, so it structurally cannot know whether a repeatedly-spawned resource ever started at all (`workspace.create` returning no root pane, or `agent.start` rejecting, are both indistinguishable from "started and died" to this detector) — the complaint's own doc comment already declared it "Deliberately OBSERVATIONAL, not accusatory", but its prose asserted an outcome anyway. It now states only what was measured (spawned N times in M minutes) and, when directing a human's attention, asks why the resource keeps being spawned rather than why it "keeps dying".
