bump: patch

### Fixed

- The lizard-mode file-execution veto (FACTORY-625/FACTORY-636) no longer
  misreads an option token as the file being executed in its `node`,
  `python`/`python3`, `sh`/`bash`/`zsh`, and `source` branches (`node
  --version`, `node -v`, `python3 --version`, `python3 -m pytest`, `bash -l
  deploy.sh` are approved again; `bash -l deploy.sh` still inspects
  `deploy.sh` itself). `node -e`/`--eval`/`-p`/`--print` and `python`/`python3
  -c` inline bodies are now routed into the same inline-body inspection a
  here-doc already gets, so they are vetoed deliberately when destructive
  rather than only by accident. A bare `bun test`/`bun run <script>` — no
  explicit file argument — is approved rather than vetoed: FACTORY-625's
  fail-closed fallback is scoped to a path outside the workspace, and this
  dialog class has no `[butchr:blocked]` ANSWER-protocol escalation, so
  vetoing the fleet's single most common command risked turning every test
  run into a frozen pane needing a human at the terminal. A bare `bun
  test`/`bun run <script>` still cannot see what the suite/script list
  contains — that content is not inspected.
