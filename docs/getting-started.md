# Getting started with butchr

butchr is a local daemon that watches your Jira tickets and runs one coding agent per ticket that matches a **rule** you choose. You set it up and manage it from a dashboard in your browser; you do not edit files or run a command-line tool for day-to-day use.

This guide takes you from nothing to one working rule.

## What you need

| Requirement | Why |
| --- | --- |
| Linux or macOS | Linux uses systemd user services, macOS uses launchd, to keep the daemon (and herdr) running. Windows runs butchr inside WSL; see [windows-wsl-agent-guide.md](windows-wsl-agent-guide.md). |
| [Bun](https://bun.sh) | runs the daemon and builds the dashboard |
| `git` | to download butchr |
| herdr, already running and on the daemon's `PATH` | the terminal manager each agent runs in — see "Installing herdr" below |
| The `claude` command-line tool, signed in | the default agent provider (Codex is also supported, see [agent-providers.md](agent-providers.md)) — see "Installing the `claude` tool" below |
| `python3` on the daemon's `PATH` | used by a safety hook that runs before each agent shell command. On macOS run `xcode-select --install` if `python3` is only Apple's stub |
| A Jira Cloud site and an API token | create the token at <https://id.atlassian.com/manage-profile/security/api-tokens>. The account that owns it is the one butchr reads and writes tickets as |

Your Jira site address must look like `https://<name>.atlassian.net`.

You do **not** need a GitHub account or `gh login` for any of this: cloning butchr below is an anonymous, unauthenticated `git clone` over HTTPS. (A GitHub token is only needed later if you turn on this daemon's own `github-issue`/`github-pr` rule providers — see the root `README.md` — which is unrelated to getting the daemon itself installed.)

### Installing herdr

This repo does not vendor or build herdr. Get the binary for your platform from <https://herdr.dev> and put it somewhere on the daemon's `PATH`, for example `~/.local/bin/herdr`. Confirm it with `herdr --version`.

herdr must already be running before butchr starts a rule's first agent — step 3 below runs it as its own service, started before butchr. If you're just trying things out in a terminal rather than under a service manager, start it yourself first, in another terminal: `herdr server`.

### Installing the `claude` command-line tool

```
npm install -g @anthropic-ai/claude-code
claude
```

The second command, run once, walks you through signing in.

## 1. Install

```
git clone https://github.com/brooswit-factory/butchr.git
cd butchr
bun install
bun run build
```

`bun run build` produces the dashboard. If you skip it, the dashboard page answers 503 and tells you to build.

## 2. Start the daemon

Keep it running under your system's service manager (step 3 shows how, and starts herdr too). To try it first, make sure herdr is already running (see "Installing herdr" above), then run butchr in a terminal:

```
bun run start
```

On a fresh install, with no Jira settings anywhere, butchr starts in **setup mode**. It prints lines like these and keeps running:

```
butchr: starting in SETUP MODE — no Atlassian identity configured yet.
butchr: setup code (10 min, single-use, 5 attempts): ABCDEFGH23456
```

The **setup code is printed in the daemon's log**, nowhere else. It is the proof that you control the machine the daemon runs on. Where to find the log:

- started in a terminal: that terminal
- systemd: `journalctl --user -u butchr.service -e`
- launchd: the file you set as `StandardErrorPath` in the plist (step 3)

The code lasts 10 minutes, works once, and allows 5 wrong attempts. To get a new one:

```
kill -USR2 <daemon pid>                      # in a terminal (the pid is in the log line above)
systemctl --user kill -s SIGUSR2 butchr.service   # under systemd
```

## 3. Keep it running (required for the end of setup)

When you finish setup the daemon **exits on purpose and relies on its service manager to start it again** in normal mode. Without a service manager, you start it yourself once after setup. Running it under one is the supported way — and it's also how herdr itself should stay up, since butchr needs herdr already running to start any agent.

**Linux (systemd user services).** Give herdr its own unit, and make butchr's unit depend on it. Create `~/.config/systemd/user/herdr.service`, adjusting the path to wherever you installed herdr:

```ini
[Unit]
Description=herdr

[Service]
ExecStart=%h/.local/bin/herdr server
Restart=always
RestartSec=2
LimitNOFILE=65536

[Install]
WantedBy=default.target
```

(`LimitNOFILE` is raised because herdr holds one pty per running agent, and the default per-process file-descriptor limit is often too low for a busy fleet.)

Create `~/.config/systemd/user/butchr.service`, adjusting the paths:

```ini
[Unit]
Description=butchr
After=herdr.service
Wants=herdr.service

[Service]
WorkingDirectory=%h/butchr
ExecStart=%h/.bun/bin/bun run src/daemon/index.ts
Restart=always
RestartSec=2
# herdr, claude and python3 must be on this PATH:
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

`ExecStart` runs the daemon's entry file directly rather than going through `bun run start`'s own wrapper process. With that wrapper as the unit's `MainPID`, the dashboard's Settings → **Restart** control answers 409, and the process does not survive a second signal — running the entry file directly avoids both.

Then:

```
systemctl --user daemon-reload
systemctl --user enable --now herdr.service butchr.service
```

To keep both running when you are logged out: `loginctl enable-linger $USER`.

**macOS (launchd).** Create `~/Library/LaunchAgents/herdr.plist`, adjusting the paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>herdr</string>
  <key>ProgramArguments</key><array>
    <string>/Users/YOU/.local/bin/herdr</string><string>server</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>/Users/YOU/herdr.log</string>
</dict></plist>
```

Then create `~/Library/LaunchAgents/butchr.plist`, adjusting the paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>butchr</string>
  <key>WorkingDirectory</key><string>/Users/YOU/butchr</string>
  <key>ProgramArguments</key><array>
    <string>/Users/YOU/.bun/bin/bun</string><string>run</string><string>src/daemon/index.ts</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/Users/YOU/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>/Users/YOU/butchr/butchr.log</string>
</dict></plist>
```

Load both, herdr first: `launchctl load ~/Library/LaunchAgents/herdr.plist && launchctl load ~/Library/LaunchAgents/butchr.plist`.

launchd has no equivalent of the dashboard's Settings → **Restart** control (that only works when butchr detects it is running under systemd, today). Restart the daemon yourself instead: `launchctl kickstart -k gui/$(id -u)/butchr` (match the label to your plist's `Label`, and use `/herdr` the same way for herdr). Do this after any settings change, and as the last step of rotating your Jira token — mint a fresh setup code first (the `kill -USR2`/log step from "2. Start the daemon" above), paste it into the Settings page, then kick-start.

## 4. Open the dashboard and finish setup

Open <http://127.0.0.1:7717/dashboard-app/> (7717 is the default port; set `BUTCHR_PORT` to change it). The dashboard only listens on loopback, so on a headless box — no browser on the machine butchr runs on — forward the port over SSH first: `ssh -L 7717:127.0.0.1:7717 <host>`, then open that same URL in a browser on your own machine.

In setup mode the page asks for:

1. your **Jira site** (`https://<name>.atlassian.net`),
2. your **account email**,
3. your **API token** (pasted into a password field; it is tested against Jira and stored in an owner-only file, never shown again),
4. the **setup code** from the log.

Choose **Configure**. butchr checks the token against Jira first and saves it only if Jira accepts it. The page then says butchr is restarting; the service manager starts it again, and the page reloads into the dashboard by itself. If it does not come back, the daemon is not under a service manager: start it again with `bun run start`.

To rotate the token later, use the Jira connection card on the **Settings** page; it asks for a fresh setup code from the log the same way. Rotation is only accepted for the same Jira account. If the token comes from an environment variable (`ATLASSIAN_TOKEN` or `ATLASSIAN_TOKEN_FILE`), the page tells you it is provided by the environment and cannot change it.

## 5. Your first rule

A rule is a Jira search (JQL) plus instructions. butchr runs one agent for each ticket the search returns, and stops the agent when the ticket stops matching.

On first run butchr creates one **disabled** starter rule so nothing starts by surprise. Open **Rules** in the dashboard and use "Set up your first rule":

1. **Set the query.** Pick a starter ("one specific ticket" is the safest first try), edit it to a real ticket key, and choose **save query**. Start with one ticket you own.
2. **Preview.** Choose **Preview**. butchr asks Jira what the query matches and lists the tickets, without starting anything. Adjust until the list is what you expect.
3. **Enable.** Choose **Enable**. A rule that starts one agent per ticket asks you to confirm and says how many tickets it would start; confirm to go ahead. Agents start within one poll.
4. **Undo.** **Undo last change** reverts the most recent change from a backup.
5. **Reload.** Changes made in the dashboard are applied by the running daemon immediately; no restart. If you edit the rules file by hand instead, send the daemon `SIGHUP` (`kill -HUP <pid>`, or `systemctl --user kill -s HUP butchr.service`) to re-read it.

The instructions each agent receives (the rule's `brief`) are edited in the rules file, not the dashboard. The file is `$BUTCHR_RULES_FILE`, else `$XDG_CONFIG_HOME/butchr/rules.json`, else `~/.config/butchr/rules.json`.

## 6. Settings

The **Settings** page shows each setting and where its value comes from: the environment, `settings.json`, or the default. You can edit a few from the page: the maximum number of agents at once (`BUTCHR_MAX_AGENTS`), the default agent provider and provider order, the default model, and the poll-staleness tolerance. Changes are written to `settings.json` and take effect after a restart (the page has a **Restart** control that works when butchr runs under its service manager). A setting that an environment variable already sets cannot be changed here, since the environment wins. The fleet cap has a hard maximum of 100.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The setup page says the token was rejected (401/403) | The email must be the account that created the token; create a fresh token and paste the whole value. |
| "could not reach Jira" | Network, proxy or a wrong site address. Open the site in a browser from the same machine. |
| "must look like https://<name>.atlassian.net" | Use the exact `https://` address, with no path and no trailing slash. |
| "setup code: expired / locked / mismatch" | Codes last 10 minutes and allow 5 wrong tries. Mint a new one (step 2) and copy it from the log exactly. |
| Jira says you have no access / preview is empty but tickets exist | The token's account cannot see those tickets or projects. Check its permissions in Jira. |
| Preview shows an error about the query | The query is not valid JQL. Try it in Jira's own search first. |
| Preview shows 0 tickets | The query is valid but nothing matches. Loosen it (for example drop a status clause). |
| An agent does not start after enabling | Check the maximum agent count on Settings, then the daemon log. |
| The page will not load / "connection refused" | The daemon is down. `curl http://127.0.0.1:7717/health`; check `systemctl --user status butchr.service` (Linux) or `launchctl list | grep butchr` (macOS), then the log. |
| The dashboard says it is not built | Run `bun run build` in the butchr folder and reload. |
| On macOS, Settings → Restart does nothing | That control only works under systemd today. Use `launchctl kickstart -k gui/$(id -u)/butchr` instead (see step 3). |
| The daemon exits at start with "Missing required config" | Jira settings are only partly present (for example site and email but no token). Set all of site, email and token, or delete the identity file `~/.config/butchr/jira-identity.json` and the token file `~/.config/butchr/secrets/atlassian-token` to start setup over. |

## Reporting a problem

Open an issue on the project's GitHub repository. Include the butchr version (`curl http://127.0.0.1:7717/health` shows the build), what you did, what you expected, and the relevant lines of the daemon log. **Remove tokens and setup codes from anything you paste.**

## Known limits

This version covers first-time setup, one rule, and the Settings page from the dashboard. More rules and definitions, and more agent controls, are managed by editing files today and move into the dashboard in later versions. Setup mode only runs on a fresh install with no Jira configuration at all.
