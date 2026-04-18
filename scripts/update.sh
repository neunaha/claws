#!/usr/bin/env bash
# Claws — update runner
#
# Self-contained. Works two ways:
#
#   # 1. Via curl URL (no prior clone needed if ~/.claws-src is already there):
#   bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/update.sh)
#
#   # 2. From the local clone:
#   bash ~/.claws-src/scripts/update.sh
#
# The /claws-update slash command is a thin wrapper around option 2.
#
# New update steps get added to this script and users pick them up on their
# next update — no per-project re-install of the slash-command markdown.
#
# Usage: bash update.sh [project-root]  (defaults to current pwd)

set -eo pipefail

INSTALL_DIR="${CLAWS_DIR:-$HOME/.claws-src}"
# PROJECT_PWD is set by the slash command; fall back to $1, then $PWD.
PROJECT_ROOT="${1:-${PROJECT_PWD:-$(pwd)}}"

# ─── Colors ────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'
  C_GREEN='\033[0;32m'; C_YELLOW='\033[0;33m'; C_DIM='\033[2m'
else
  C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_DIM=''
fi

header() { printf "\n${C_BOLD}═════ %s ═════${C_RESET}\n" "$*"; }
note()   { printf "  ${C_DIM}%s${C_RESET}\n" "$*"; }

# ─── Step 0: Ensure Claws source + pull latest ─────────────────────────────
# Runs whether update.sh was invoked via curl URL or from the local clone —
# this is the one action that can't be delegated to install.sh because
# install.sh's logic assumes INSTALL_DIR is already up-to-date.
if [ ! -d "$INSTALL_DIR/.git" ]; then
  if [ -d "$INSTALL_DIR" ]; then
    echo "Claws source at $INSTALL_DIR exists but is not a git clone." >&2
    echo "Remove it or set CLAWS_DIR to a different path, then re-run." >&2
    exit 1
  fi
  echo "Claws not yet installed — running the installer first."
  bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
  exit 0
fi

header "Pulling latest Claws source"
( cd "$INSTALL_DIR" && git pull --ff-only --quiet origin main ) \
  && note "git pull OK ($(cd "$INSTALL_DIR" && git log --oneline -1))" \
  || note "git pull failed or no changes — continuing with existing tree"

# ─── Step 1: Sync marketplace-facing docs ──────────────────────────────────
# The extension's README and CHANGELOG mirror the repo root so the VSIX (and
# the installed extension folder) stay current.
header "Syncing extension docs"
cp "$INSTALL_DIR/README.md"    "$INSTALL_DIR/extension/README.md"    2>/dev/null && note "README.md   → extension/" || true
cp "$INSTALL_DIR/CHANGELOG.md" "$INSTALL_DIR/extension/CHANGELOG.md" 2>/dev/null && note "CHANGELOG.md → extension/" || true

# ─── Step 2: Run the installer against the user's project ──────────────────
# install.sh is the single source of truth for everything the update does:
# extension build + symlink, project-local files, CLAUDE.md migration +
# injection, shell hook, verification, banner, install log. Anything new we
# want the update flow to do — add it to install.sh, not here.
header "Running installer"
( cd "$PROJECT_ROOT" && bash "$INSTALL_DIR/scripts/install.sh" )

# ─── Step 3: Print the newest CHANGELOG entry ──────────────────────────────
header "What's new"
if [ -f "$INSTALL_DIR/CHANGELOG.md" ]; then
  # Extract exactly the most-recent `## [x.y.z]` section.
  awk '/^## \[/{c++} c==1 && NR>1{print} c==2{exit}' "$INSTALL_DIR/CHANGELOG.md" | head -80
  echo ""
  note "Full CHANGELOG: $INSTALL_DIR/CHANGELOG.md"
fi

# ─── Step 4: Post-update hooks ─────────────────────────────────────────────
# Any future one-off migrations (cleaning up stale sockets, retiring old
# config keys, notifying of breaking changes) go here. On first run each
# migration can write a marker file so it never runs twice.
if [ -d "$PROJECT_ROOT/.claws" ]; then
  # Clean stale sockets from prior VS Code crashes.
  find "$PROJECT_ROOT/.claws" -maxdepth 1 -name 'claws.sock' -type s -mtime +1 -delete 2>/dev/null || true
fi

# ─── Step 5: Re-source the shell hook ──────────────────────────────────────
# Forces the in-terminal CLAWS banner + aliases to refresh without a new
# shell. Best-effort — won't fail the update if the hook is missing.
header "Refreshing shell hook"
unset CLAWS_BANNER_SHOWN 2>/dev/null || true
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/shell-hook.sh" 2>/dev/null \
  && note "shell hook re-sourced" \
  || note "shell hook not sourced (non-interactive shell)"

# ─── Done ──────────────────────────────────────────────────────────────────
echo ""
printf "${C_GREEN}${C_BOLD}Update complete.${C_RESET}\n"
echo ""
printf "  ${C_BOLD}Two things to activate:${C_RESET}\n"
echo "    1. Reload VS Code:      Cmd+Shift+P → Developer: Reload Window"
echo "    2. Restart Claude Code in this project so the new .mcp.json is picked up"
echo ""
printf "  ${C_BOLD}If anything looks off:${C_RESET}\n"
echo "    /claws-fix       — quick auto-diagnosis"
echo "    /claws-report    — bundle logs + state into a shareable file"
echo ""
