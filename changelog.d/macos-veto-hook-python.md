---
bump: patch
---

### Fixed

- The file-execution veto hook is no longer installed on a host with no working `python3`. The hook runs `python3 <checker>` on every Bash call an agent makes. On a stock Mac `/usr/bin/python3` is Apple's installer stub (the Xcode Command Line Tools are not installed): it runs nothing, exits 1, and asks macOS to open the "install developer tools" dialog, so the hook was a silent no-op that also fired that stub on every call. The daemon now recognises the stub without running it (`xcode-select -p`, so no dialog) and also skips the hook when `python3` is not on `PATH`. In both cases it logs one `[veto-hook] NOT installed` warning per distinct reason and removes any hook installed earlier, so no agent is left believing it is protected. Install the Command Line Tools (`xcode-select --install`) or put a real `python3` on the daemon's `PATH` to get the hook. Where `python3` works nothing changes.
- The `file-execution-veto checker` tests, which run the real checker with `python3`, are skipped on a host with no working `python3` instead of failing 35 tests.
