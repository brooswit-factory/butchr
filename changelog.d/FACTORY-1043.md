bump: patch

### Fixed
- Native Windows daemon startup no longer fails with EPERM while fsyncing the deployment identity file (and other control-panel durable writes): the durable-write helper now fsyncs the same writable file descriptor used for the write instead of reopening the file read-only, and deployment-identity creation is skipped entirely when `deployment-id` already exists.
