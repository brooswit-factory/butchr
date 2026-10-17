bump: major

### BREAKING

- **The transcript-size resume cutoff is removed.** `resumeContextCutoff`
  (`Rule.resumeContextCutoff`, FACTORY-851), `DEFAULT_RESUME_CONTEXT_CUTOFF`,
  and `estimateTranscriptTokens` are gone from `src/rules/rules.ts` /
  `src/agents/workspace.ts`; `decideRespawnResume`
  (`src/agents/respawn.ts`) no longer vetoes an otherwise-valid saved
  session merely because its transcript is large — a reviewer (or any
  `resumeOnRespawn` rule) now resumes its own prior conversation across the
  normal In Review -> In Progress -> In Review cycle regardless of
  transcript size, as long as the existing resume conditions (flag on, an
  UNINTENDED stop, a persisted session id, an existing transcript) are
  otherwise met. The `[resume] <issue> respawn-fresh — over cutoff
  (estimated ~N tokens > cutoff)` log line and `RESUME_DECISION_REASON.overCutoff`
  are removed along with it — no code emits that reason any more.
  `resumeContextCutoff` stays in the rules-file parser's accepted-key set
  (`src/rules/rules.ts`'s `REMOVED_RULE_FIELDS`) purely as an upgrade
  affordance: an already-deployed `rules.json` carrying the old field
  still loads instead of failing every rule with "unknown field," but the
  field is parsed into nothing and never limits resume, even at its old
  value. `resumeOnRespawn` (the separate on/off switch) is UNCHANGED and
  still honoured exactly as before — only the size-cutoff half of
  FACTORY-851's two fields is removed.
- The rules write API (`PUT /api/rules/:id`, `POST /api/rules`) no longer
  accepts `resumeContextCutoff` at all — it is refused as an unknown field,
  same as any other field this schema never had. The rules API response
  (`GET /api/rules`) no longer surfaces a `resumeContextCutoff` field. The
  dashboard's Rules page no longer shows a "Resume context cutoff" row or
  input, and the `resume: on/off (cutoff: ...)` cell is now just
  `resume: on/off`.

### Removed

- `resumeContextCutoff` from the `Rule` schema's active/validated field
  set (still accepted, migration-only — see above).
