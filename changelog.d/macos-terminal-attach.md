---
bump: patch
---

### Fixed

- Opening an agent's terminal from the dashboard now works on macOS. It could never work there: the terminal was detected only from a list of Linux emulators, and the attach was refused as "no display" because macOS sets neither `DISPLAY` nor `WAYLAND_DISPLAY`. On macOS the daemon now assumes a display and, with no `BUTCHR_TERMINAL` set, opens Terminal.app (scripted through `osascript`, since Terminal takes no command on its argv) running `herdr agent attach <pane>`. `BUTCHR_TERMINAL=macos-terminal` selects it explicitly; any other `BUTCHR_TERMINAL` value still wins. macOS may ask once to let the daemon control Terminal.
