#!/usr/bin/env bash
# FACTORY-64: WSL-side install entry point.
#
# This script is deliberately thin: its only job is to make sure `bun` is on
# PATH (installing it from https://bun.sh/install if not — already trusted
# by this repo, see package.json's own `engines.bun` requirement) and then
# hand off to the real, unit-tested logic in cli.ts. Every actual decision —
# which prerequisites are missing, how /etc/wsl.conf gets edited, what the
# systemd units look like, whether an env file already exists — lives in
# cli.ts (TypeScript, `bun run`), with every shell-out/file access reached
# through one injected object, so it can be proven correct in
# test/unit/wsl-host-cli.test.ts under plain `bun test` — no real WSL distro,
# no root, no herdr binary required. This mirrors this repo's own
# scripts/deploy/watchdog.ts precedent: bash orchestrates the one step that
# can't be meaningfully unit-tested at all (does `bun` exist yet), a typed
# CLI does everything else.
#
# Usage: bash scripts/wsl-host/install.sh install --repo-dir <dir> [flags...]
#        bash scripts/wsl-host/install.sh verify [flags...]
# (every argument after the script name is passed straight through to
# cli.ts — see `bun run scripts/wsl-host/cli.ts --help` for the full flag
# list.)
# Example:
#   bash scripts/wsl-host/install.sh install --repo-dir "$(pwd)" --default-user "$(whoami)"
#   bash scripts/wsl-host/install.sh install --repo-dir "$(pwd)" --dry-run
#
# Run this from INSIDE the WSL distro, from within an existing clone of this
# repo (the same "assume an existing checkout, don't reinvent git clone"
# shape docs/codey-deploy-runbook.md's own §1.2 uses for the Linux host) —
# see docs/windows-wsl-host.md for the full step-by-step.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found on PATH — installing from https://bun.sh/install ..." >&2
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun install appeared to succeed but 'bun' is still not on PATH — add \$HOME/.bun/bin to PATH and re-run this script." >&2
    exit 1
  fi
fi

exec bun run "$SCRIPT_DIR/cli.ts" "$@"
