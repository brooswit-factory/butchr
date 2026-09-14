# Provider handoff

Butchr supplies role provider preferences, workspace intent, launch configuration,
and kickoff text to Drovr's `ManagedHerdrLifecycle`. Drovr owns provider selection,
Herdr launch transport, native transcript import, current identity, and retirement.

A replacement reads the old worker's saved native transcript before preparation
or pane creation. The target starts with compaction-only instructions. Each chunk
must produce a fresh acknowledgement and working summary in a native model reply.
Only then does Drovr mark the target current, retire the old pane, and send kickoff
once. Idle or done after kickoff does not cause work to be repeated.

Claude, Codex, and verified AGY full transcripts use Drovr's native reader. AGY
launch preparation supplies isolated HOME when needed. Pane screenshots only
support the existing Claude quota classifier; they are never imported as history.
There is no Codex or AGY quota inference.

Missing history, changed native identity, launch failure, and acknowledgement
failure preserve the old worker. A handoff blocked before commit closes only the
candidate pane, with best-effort cleanup. Failure to retire the old pane after
acknowledgement retains the new current identity but sends no kickoff. Such a
blocked result is logged for operator recovery; no destructive fallback occurs.

Butchr serializes each issue's spawn, recovery, nudge, and stop. Drovr also
serializes lifecycle mutations sharing a client and workspace. During overlap,
listings and commands use the recorded current pane, never an arbitrary worker
sharing its directory. Current identity is in memory: after a restart, duplicate
workers at one directory require explicit recovery and fail closed. Independent
processes do not share a transaction lock.

Runtime and integration tests require a Drovr dependency version exporting
`ManagedHerdrLifecycle`.

The service account needs Herdr's official Codex integration installed and its
specific hook reviewed in Codex before unattended launches. AGY workspace
preparation reuses that account's completed onboarding/theme and installs the
official AGY integration inside its private HOME through Drovr. No automatic
approval of unrelated hooks is performed.
