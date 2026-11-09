bump: minor

### Added
- `BUTCHR_ACL_PATH` environment variable, read internally by the control-panel's Windows ACL lockdown/verification PowerShell helper to pass the target path safely (never interpolated into script text). Not intended for operator use.

### Fixed
- Native Windows daemon startup no longer fails with EPERM while fsyncing the deployment identity file (and other control-panel durable writes): the durable-write helper now fsyncs the same writable file descriptor used for the write instead of reopening the file read-only, and deployment-identity creation is skipped entirely when `deployment-id` already exists.
- Windows control-panel directories/files (runtime lock, configuration, remote-authority manifest, overrides, event outbox) now have their NTFS ACL actively locked down to {current user, SYSTEM, Administrators} and verified on read, replacing an unconditional POSIX-only bypass on win32.
