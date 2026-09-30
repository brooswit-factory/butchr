bump: minor

### Added

- Native Windows host install (`scripts/windows-host/install.ps1` +
  `uninstall.ps1` + `verify.ps1`, `docs/windows-native-host.md`): a
  Scheduled Task that starts `herdr server` then the butchr daemon at
  logon, non-elevated, restarts on failure, with stdout/stderr going to
  rotating log files under `%LOCALAPPDATA%\butchr\logs` instead of
  journald.
- `src/agents/ground-truth.ts`: a `windows-task` `SystemdInfo` kind so an
  agent on a Windows host gets its own scheduled-task name and log file
  instead of `systemctl`/`journalctl` guidance — existing `user`/`system`/
  `none` kinds are unchanged.
