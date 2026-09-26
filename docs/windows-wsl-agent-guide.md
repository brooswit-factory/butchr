# Windows/WSL host guide for agents

FACTORY-63 (story FACTORY-61, epic FACTORY-58, "Supported Windows hosts via
WSL"). This doc is for an agent — ticket-worker or managed-session — running
on a Windows host where Butchr and herdr run **inside WSL** (Ubuntu, in the
epic's chosen shape). It covers three things: calling Windows programs from
a WSL shell (`.exe` interop), choosing a managed session's working directory
on such a host, and translating paths between the two file systems.

**Not verified on a live host.** Nothing in this repo's own test/CI
environment is a Windows/WSL machine, so nothing below has been run here.
Every behavioral claim is either (a) cited to Microsoft's own WSL
documentation, with a link, or (b) marked as a recommendation/judgment call
rather than an observed fact. Where the two might drift (Microsoft ships WSL
updates continuously), treat the cited page as the current source of truth
over this doc's own paraphrase of it.

Installing Butchr/herdr on Windows, systemd, and autostart are **not** this
doc's concern — that is a sibling story's docs (FACTORY-59, install/systemd/
autostart/health-check), in its own file(s). Coexisting with another
supervisor on the same host (e.g. usrr) is also a sibling story's docs
(FACTORY-62). This doc does not duplicate either.

## 1. `.exe` interop: calling Windows programs from a WSL shell

WSL lets a Linux shell call a Windows executable directly by name, and lets
a Windows shell call into WSL the same way (`wsl <command>`). The agent-facing
direction — WSL calling out to Windows — is what matters here; see
[WSL interop — Windows and Linux integration](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop)
and [Working across file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)
for the source material this section cites.

### Calling convention

- **The `.exe` extension is required.** `notepad` resolves to nothing; the
  shell looks for a Linux binary of that name. `notepad.exe` resolves to the
  Windows one. ("Windows executables must include the file extension, match
  the file case, and be executable. Non-executables including batch scripts
  [do not run this way]" — filesystems.md, "Run Windows tools from Linux".)
  Batch scripts and other non-`.exe` Windows commands (`dir`, a `.bat`, a
  `.cmd`) are not directly invocable this way — go through `cmd.exe /C
  <command>` instead (below).
- **PATH resolution reaches into Windows.** A Windows executable on your
  Windows `PATH` is invocable by bare name (with the extension) from a WSL
  shell without a full path, because WSL appends Windows `PATH` entries to
  its own `$PATH` — this is the `appendWindowsPath` setting (see "Disabling
  interop" below); it is on by default.
- **`cmd.exe /C <command>`** runs a CMD-native command or batch file that has
  no standalone `.exe` — e.g. `cmd.exe /C dir` to list a Windows directory,
  since `dir` itself is a CMD built-in, not `dir.exe`.
- **`powershell.exe -Command "<script>"`** runs a PowerShell command or
  script block the same way — e.g. `powershell.exe -Command "Get-Date"`.
- **Piping and redirection work across the boundary in both directions** —
  `cat /etc/hosts | clip.exe`, `ipconfig.exe | grep IPv4 | cut -d: -f2`, and
  ordinary output redirection to a file, exactly as with a native Linux
  process (filesystems.md, "Run Windows tools from Linux"; wsl-interop,
  "Run Windows executables from Linux").

### Quoting/escaping across the shell boundary

Everything after `cmd.exe /C` or `powershell.exe -Command` is a **string**
that gets re-parsed by a *second* shell (CMD's or PowerShell's own), after
your Linux shell has already done its own quoting/expansion pass on the
whole command line. Two layers of quoting rules — bash's and the target
Windows shell's — apply to the same characters, and they disagree on
several of them (`"`, `$`, backslash, `%`). There is no citable Microsoft
page for "how bash and PowerShell quoting compose" specifically (this is a
composition of two independently-documented shells, not a documented WSL
feature) — treat this as a judgment call, not a verified fact:

- Prefer wrapping the whole target-side command in single quotes at the
  bash level when it contains no bash expansion you actually want, so bash
  passes it through byte-for-byte and only the target shell interprets it:
  `powershell.exe -Command 'Get-ChildItem -Path C:\Users'`.
  A double-quoted bash string is expanded by bash FIRST (`$`, backticks,
  `\`), which is rarely what you want when the string is meant for
  PowerShell or CMD to parse.
- A literal Windows path with backslashes inside a *double*-quoted bash
  string needs each backslash escaped for bash (`"C:\\temp\\foo.txt"` —
  bash collapses each `\\` to one `\`, reaching Windows as `C:\temp\foo.txt`)
  or, simpler, use a single-quoted bash string so bash does not touch the
  backslashes at all.
- `notepad.exe "C:\temp\foo.txt"` and `notepad.exe C:\\temp\\foo.txt` both
  reach Windows correctly per filesystems.md's own examples — i.e. Windows
  arguments are passed through largely unmodified once bash's own quoting is
  satisfied; the escaping burden is bash's parsing, not something WSL adds
  on top.
- When a value must survive both layers reliably (a path with spaces, an
  environment-derived value), build it as a `wslpath`-translated Windows-form
  path first (section 3), then interpolate that already-Windows-shaped
  string into a single-quoted (or carefully-escaped) command, rather than
  trying to hand-escape a Linux path through two shells at once.

### Path form: Windows program, Windows-shaped path

A Windows executable expects a **Windows-shaped path** (`C:\Users\...` or the
`C:/Users/...` forward-slash form), never a bare WSL path (`/home/...` or
`/mnt/c/...`) — a Linux path handed directly to a Windows program is not
something Windows path-parsing understands. Convert with `wslpath -w` or
`wslpath -m` first (section 3) whenever the path came from WSL-side state
(a repo checkout, a generated file) rather than being typed by a human
already in Windows form.

### Exit codes, stdout/stderr, encoding, and line endings

- **A Windows executable invoked via interop is exec'd like a native process**
  (filesystems.md: "Windows executables run in WSL are handled similarly to
  native Linux executables -- piping, redirects, and even backgrounding work
  as expected"), so ordinary exit-code checking (`$?`, `set -e`, `||`) works
  the same as with any Linux command. Neither cited page states this
  explicitly as an "exit code" guarantee — it is an inference from "handled
  similarly to native Linux executables," not a directly quoted claim —
  verify empirically on the actual host before depending on a specific
  program's exit-code contract.
- **Encoding and line endings are not unified.** Many Windows console tools
  emit UTF-16LE and/or CRLF line endings; a WSL Linux shell and its text
  tools (`grep`, `sed`, `wc -l`) expect UTF-8 and LF. Neither cited page
  documents this conversion happening automatically for arbitrary programs
  (only the documented examples — `ipconfig.exe | grep IPv4` — work,
  presumably because `ipconfig.exe`'s ASCII output round-trips cleanly). For
  a Windows tool whose output an agent needs to parse reliably, treat
  encoding/CRLF as unverified per-tool behavior — pipe through `iconv`/
  `dos2unix`/`tr -d '\r'` defensively rather than assuming clean text.
- **Working directory is "retained, for the most part."** Filesystems.md:
  Windows tools invoked from WSL "retain the working directory as the WSL
  command prompt (for the most part -- exceptions are explained below)" —
  the cited page's own hedge, not resolved further on that page. The
  concrete exception this doc can point at: **`cmd.exe` (and CMD-native
  commands run through it) does not support a UNC current directory.**
  When a WSL Linux-filesystem cwd is exposed to a Windows process as a
  `\\wsl$\...`/`\\wsl.localhost\...` UNC path, CMD prints a warning to the
  effect of "CMD.EXE was started with the above path as the current
  directory. UNC paths are not supported. Defaulting to Windows directory,"
  and actually runs from `C:\Windows` (or another default) instead of the
  directory you expected — a general `cmd.exe` limitation, not WSL-specific,
  but one an agent hits specifically when its own cwd is on the WSL
  filesystem and it shells out to `cmd.exe` (see the Microsoft Q&A thread
  ["CMD does not support UNC paths"](https://learn.microsoft.com/en-us/answers/questions/2538977/cmd-does-not-support-ucn-paths)
  and [microsoft/terminal#17998](https://github.com/microsoft/terminal/issues/17998),
  which reports the exact WSL-triggered case). `powershell.exe` does not
  have this limitation (PowerShell supports a UNC current location). If a
  `cmd.exe`-invoked command's output looks like it ran in the wrong place,
  check for this warning before assuming the command itself is broken. A
  `pushd \\wsl$\...` (rather than `cd`) is CMD's own documented workaround
  for a UNC path, per the same thread — pushd temporarily maps a drive
  letter.
- **stdin/TTY**: an interop-launched Windows console program shares the
  calling shell's console per the "handled similarly to native Linux
  executables" behavior above, so simple stdin piping works (the
  `notepad.exe "C:\temp\foo.txt"` and `clip.exe` examples above are
  one-shot, non-interactive). Neither cited page addresses a **Windows GUI
  application** or an interactive full-screen console program (something
  that wants its own window, or raw keyboard control of a console) launched
  this way — treat that as unverified; a persistent/managed-session agent
  wanting a Windows GUI likely needs a different mechanism entirely (WSLg
  for a Linux GUI app is the documented-but-different feature; a Windows GUI
  app launched via interop opens its own Windows window, outside the
  calling pane's control either way).

### When to prefer interop vs. a native WSL/Linux tool

Prefer a native Linux tool already on the WSL side — `git`, `node`/`bun`,
`curl`, `grep`, etc. — over the Windows-side equivalent whenever both can do
the job: it avoids every quoting/encoding/UNC pitfall above, and (per the
performance note in section 2) Linux tools are faster against files that
live on the Linux filesystem. Reach for `.exe` interop only when:

- the task is Windows-only tooling with no WSL-side equivalent (a
  Windows-specific CLI, a vendor tool that only ships a `.exe`);
- the task needs a **Windows GUI application** specifically (interop can
  launch one; it opens on the Windows desktop, not inside the WSL pane);
- the task needs **Windows-host state** a Linux process cannot see or
  change from inside the WSL VM (the Windows clipboard via `clip.exe`,
  Windows Explorer via `explorer.exe`, a Windows service, the Windows
  registry).

### Diagnosing "command not found" for a `.exe`

Two `wsl.conf` `[interop]` settings, both on by default, can make a `.exe`
call fail with "command not found" or similar even though the program
exists on the Windows side (source:
[Advanced settings configuration in WSL](https://learn.microsoft.com/en-us/windows/wsl/wsl-config),
"Interop settings"):

| `wsl.conf` `[interop]` key | Default | Effect when `false` |
|---|---|---|
| `enabled` | `true` | "Setting this key will determine whether WSL will support launching Windows processes" — `false` blocks ALL `.exe` interop outright. |
| `appendWindowsPath` | `true` | "Setting this key will determine whether WSL will add Windows path elements to the `$PATH` environment variable" — `false` means a `.exe` on the Windows PATH is no longer found by bare name (an absolute/`/mnt/...` path to it may still work if `enabled` is still `true`). |

Interop can also be disabled **per-session** (not via `wsl.conf`, and not
persisted across a new session) by writing to a Linux kernel switch:
`echo 0 > /proc/sys/fs/binfmt_misc/WSLInterop` as root disables it;
`echo 1 > /proc/sys/fs/binfmt_misc/WSLInterop` (or starting a fresh WSL
session) re-enables it (filesystems.md, "Disable interoperability"). If a
`.exe` call that used to work suddenly reports "not found" or refuses to
launch, check both: the `[interop]` block of `/etc/wsl.conf` (needs a full
WSL restart to take effect — `wsl.exe --shutdown` from the Windows side,
then relaunch — per the "8 second rule" in the same wsl-config page), and
this kernel switch (takes effect immediately, no restart, but only for the
current session).

## 2. Managed-session cwd choice on a Windows host

A [managed session](managed-sessions.md) definition's `workingDirectory`
field is where the agent is told to `cd` at kickoff (see that doc's
"Working directory wiring" section for the full mechanism — the field name
and the fact that it is communicated via the kickoff prompt rather than a
real process `cwd` are both verified against this repo's own source, not
assumed). **Verify the field name yourself against `docs/managed-sessions.md`
in your own checkout before relying on it** — this doc doesn't re-derive the
schema, it only adds host-specific guidance for choosing the value.

On a Windows/WSL host, that path can point at either of two file systems,
with different tradeoffs:

| | WSL home (`~`, e.g. `~/code/some-project`) | Windows filesystem (`/mnt/c/...`) |
|---|---|---|
| Underlying filesystem | Linux (ext4, inside the WSL VM) | NTFS, accessed cross-OS via the 9P protocol |
| I/O speed for many small files (`node_modules`, a git working tree with many objects) | Fast (native) | Slow — Microsoft's own guidance: "avoid for build systems, `node_modules`, git repos" over `/mnt/c` |
| Visible to Windows-side tools/GUI apps directly | No — only via `\\wsl$\<distro>\...` / `\\wsl.localhost\<distro>\...` (see section 3) | Yes — it's already a Windows path (`C:\...`) |
| Case sensitivity | Case-sensitive (ordinary Linux behavior) | Case-*insensitive* by default (Windows-native semantics); WSL's per-directory case-sensitivity flag can change this — see [Case sensitivity](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity) — not re-derived here |
| Exec bit / Linux permission metadata | Full native support | Depends on the `/mnt` mount's `metadata` option (default `disabled`) — without it, DrvFs does not track a per-file Linux exec bit the way a native filesystem does; see `options`/`metadata` in the wsl-config table below |
| Line endings | Whatever the repo/tool writes (typically LF) | Same bytes on disk either way — the FILESYSTEM doesn't rewrite line endings; a Windows-side EDITOR or `core.autocrlf` git setting might, independently of which filesystem the repo lives on |
| git behavior | Ordinary — this is the filesystem git and its object store expect | Works, but slower per-object; and see the exec-bit caveat above — a `metadata`-less mount can make `git status`/`diff` show spurious mode changes on every file, since git tracks the exec bit as part of a file's tree entry |

**Rule of thumb:** default to the WSL home (`~/...`) for a managed session
whose own agent is running WSL/Linux-side tools (git, node, bun, a Claude/
Codex CLI itself) against its own project checkout — this is the ordinary
case for a Butchr-managed agent, since the agent process itself runs inside
WSL regardless of which filesystem its `workingDirectory` points at. Choose
`/mnt/c/...` only when the actual **point** of the session is to operate on
a directory Windows-side tooling also needs direct, unmounted access to —
e.g. a directory a Windows-native build tool, installer, or GUI application
reads or writes outside of anything the agent itself does. If a session
straddles both (an agent that mostly runs Linux tools against a repo, but
occasionally needs a Windows tool to also see that exact directory without
crossing the 9P boundary), the tradeoff is real and there is no universal
right answer — prefer the WSL home for the agent's own I/O-heavy work by
default, and reach for `wslpath`/UNC translation (section 3) to hand a
specific file or directory to the occasional Windows-side consumer instead
of relocating the whole working directory to `/mnt/c` for that consumer's
sake.

`/etc/wsl.conf`'s `[automount]` section (same
[wsl-config](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) page)
governs how `/mnt/c` itself is mounted and is worth knowing about even
though it's host configuration, not something a managed-session definition
controls:

| `[automount]` key | Default | Relevance here |
|---|---|---|
| `enabled` | `true` | `false` means `/mnt/c` isn't there at all unless mounted by hand/`fstab` — a `workingDirectory` under `/mnt/c` would simply not resolve. |
| `root` | `/mnt/` | If an operator changed this (e.g. to `/`), `/mnt/c/...` paths in a definition would be wrong for that host — the doc's own examples assume the default. |
| `options` → `metadata` | `disabled` | Enables Linux permission-bit tracking on `/mnt/c` when turned on — relevant to the exec-bit caveat in the table above. |
| `options` → `case` | `off` | Controls whether directories under `/mnt/c` behave case-sensitively — see the case-sensitivity link above. |

## 3. Path translation

Use `wslpath` (inside WSL) whenever a path needs to cross the WSL/Windows
boundary — handing a path to a `.exe` program (section 1), or writing one
into a config file a Windows-side tool reads. Its flags, per the Microsoft
documentation that introduced the tool
([WSL release notes](https://learn.microsoft.com/en-us/windows/wsl/release-notes),
Build 17046 entry) and confirmed in current usage examples in
[WSL interop](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop):

```
wslpath usage:
  -a    force result to absolute path format
  -u    translate from a Windows path to a WSL path (default)
  -w    translate from a WSL path to a Windows path
  -m    translate from a WSL path to a Windows path, with '/' instead of '\'
```

This repo's own dev environment is not a WSL host, so these flags could not
be re-run against a live `wslpath --help`/`man wslpath` here — the table
above is transcribed from the cited Microsoft page, not independently
verified in this environment. On an actual WSL host, `wslpath --help` (or
`man wslpath` where installed) is the authoritative, always-current source —
prefer it over this table if the two ever disagree.

**Worked examples** (from the WSL interop page above):

```bash
# Windows path → WSL path (the default direction, -u is implicit)
wslpath "C:\Users\username\file.txt"
# -> /mnt/c/Users/username/file.txt

# WSL path → Windows UNC path
wslpath -w /home/username/file.txt
# -> \\wsl.localhost\Ubuntu-22.04\home\username\file.txt

# WSL path → Windows drive-letter path (only meaningful for a path already
# under /mnt/<drive>; a WSL-home path like /home/... has no drive-letter
# form, which is exactly why -w above produces a UNC path for it instead)
wslpath -m /mnt/c/Users/username/file.txt
# -> C:/Users/username/file.txt
```

**Drive-letter mapping** follows the `[automount]` `root` setting from
section 2 — by default, `C:\` (or `C:/`) on the Windows side is `/mnt/c/` on
the WSL side, `D:\` is `/mnt/d/`, and so on; letter-for-letter, lowercased.

**`\\wsl$\<distro>\...`/`\\wsl.localhost\<distro>\...`** is the reverse
direction: a Windows-side UNC form for reaching into the WSL Linux
filesystem (a WSL-home path has no drive-letter equivalent, only this UNC
form — that's what `wslpath -w` produces for it above). Per
[WSL interop](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop):
"The `\\wsl$\` path is only available when the WSL instance is running. If
the distribution is shut down, the path does not resolve" — `\\wsl.localhost\`
is the newer form and, per the same page, can auto-start the distribution on
Windows 11, which `\\wsl$\` does not.

**Passing a path to a `.exe` program**: translate WSL→Windows first
(`wslpath -w` for a UNC-safe form that works for anything, or `wslpath -m`
when the target only accepts a drive-letter form and the path is already
under `/mnt/<drive>`), then interpolate the *already-translated* string into
the command — see the quoting guidance in section 1 for why translating
first, rather than hand-quoting the original Linux path, is the safer
order.

## 4. Worked example, generic pattern

This is a **generic pattern**, not a report on any specific live host — no
session, service, or scheduled task on any real Windows/WSL machine was
read, queried, or modified to produce it; every name and value below is a
placeholder. If you are reconciling this pattern against a real deployment,
read that deployment's own definitions and this repo's own
`docs/managed-sessions.md` schema directly — do not treat anything here as
asserting what a real host's manifests actually contain.

A Windows host running Butchr+herdr inside WSL might define two managed
sessions of two different shapes:

- **A persistent, singleton query-agent session** — a long-lived agent that
  mostly answers questions or triages incoming work, rather than driving a
  ticket to completion. Its `workingDirectory` would typically be a WSL-home
  path (fast I/O, no Windows-tool consumer), `role: "sentinel"` (fleet-cap
  exempt, per `docs/managed-sessions.md`'s "role -> fleet-capacity
  admission" section), and whatever `execution`/`permissionMode` shape a
  persistent query agent needs — **verify the exact field names/values
  against this repo's own schema doc before writing a real manifest; nothing
  here invents a value not already in that schema.**

  ```json
  {
    "workingDirectory": "~/<placeholder-path>",
    "brief": "<placeholder: the query-agent's role>",
    "vendor": "claude",
    "tier": "tier2",
    "permissionMode": "default",
    "role": "sentinel"
  }
  ```

- **A "director"-style session** — an agent whose job is to direct or
  coordinate other work (the exact scope is host-specific and irrelevant to
  this doc). Same cwd reasoning applies: WSL-home by default unless a
  Windows-side tool specifically needs unmounted access to that directory.

  ```json
  {
    "workingDirectory": "~/<placeholder-path>",
    "brief": "<placeholder: the director's role>",
    "vendor": "claude",
    "tier": "tier2",
    "permissionMode": "default"
  }
  ```

Both placeholders omit every optional field this doc has no basis to fill in
(`mcpServers`, `freezeControllers`/`unfreezeControllers`, `strictMcpConfig`,
`account`, `execution`) — add only what a real deployment's own
requirements call for, following `docs/managed-sessions.md`'s field table
directly rather than this example.

## See also

- [`docs/managed-sessions.md`](managed-sessions.md) — the managed-session
  definition schema this doc's section 2 and section 4 build on.
- [WSL interop — Windows and Linux integration](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop)
- [Working across file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)
- [Advanced settings configuration in WSL](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) (`wsl.conf`'s `[interop]`/`[automount]` sections)
- [WSL release notes](https://learn.microsoft.com/en-us/windows/wsl/release-notes) (`wslpath`'s own documented usage text, Build 17046)
- [Case sensitivity](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity)
