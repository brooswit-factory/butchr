bump: patch

### Fixed

- **A managed session's per-session workspace directory on Windows joined the
  RAW drive path onto the workspace root instead of an encoded slug, and
  `mkdir` failed with `ENOENT`** (FACTORY-570, part of the FACTORY-555
  native-Windows effort). `managedSessionShortDisplayId`
  (`src/rules/session-definition-type.ts`) finds a definition's bare name by
  looking for the last `/`; on a backslash-separated Windows resourceId
  (`C:\Users\broos\...\codex-test.json`) there is none, so it returned almost
  the entire raw path — including the drive letter's `:` and every `\`
  separator — as the candidate workspace-directory leaf. `isValidLeaf`
  (`src/agents/workspace.ts`) only ever rejected `/`, so it accepted that
  hostile shape verbatim, and the leaf was joined straight onto the
  workspace root: `mkdir
  '<root>\filesystem\managed-sessions\C:\Users\broos\...\codex-test'` — an
  invalid Windows path (a drive letter and separators mid-path), which
  `mkdir` failed with `ENOENT` on every poll.
  `isValidLeaf` now also rejects `:` and `\` when `platform: "win32"` (an
  injectable parameter, defaulting to `process.platform`, threaded through
  `newLayoutDirFor`/`workspaceDirFor`/`ensureWorkspaceDir`/
  `agentIdOfWorkspacePath`/`ruleAgentIdOfWorkspacePath`, and — for the same
  round trip — `isResourceId`/`encodeAgentKey`/`decodeAgentKey`/
  `decodeAnyAgentKey` in `src/rules/agent-key.ts`), so a hostile Windows-shaped
  candidate falls back to the existing legacy leaf: the resourceId's own
  `encodeURIComponent`, a single flat segment with `:`, `\`, and `/` all
  percent-encoded — exactly the technique POSIX already uses for a short id
  `isValidLeaf` rejects. The encode → workspace path → decode round trip now
  holds for a drive-letter id and a UNC id alike, on `win32`. POSIX behavior
  (including every existing `:`-containing short id, e.g. the generic
  filesystem provider's `parent:name`) is unchanged — the new checks are
  gated on `platform: "win32"` only.
