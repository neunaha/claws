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
_claws_prev_sha=$(cd "$INSTALL_DIR" && git rev-parse HEAD 2>/dev/null || echo "unknown")
if ( cd "$INSTALL_DIR" && git pull --ff-only --quiet origin main 2>/tmp/claws-pull-err.$$ ); then
  _claws_new_sha=$(cd "$INSTALL_DIR" && git rev-parse HEAD 2>/dev/null || echo "unknown")
  if [ "$_claws_prev_sha" = "$_claws_new_sha" ]; then
    note "already up-to-date ($(cd "$INSTALL_DIR" && git log --oneline -1))"
  else
    note "git pull OK (${_claws_prev_sha:0:7} → ${_claws_new_sha:0:7})"
  fi
  rm -f /tmp/claws-pull-err.$$
else
  printf "  ${C_YELLOW}!${C_RESET} git pull failed — continuing with existing tree\n"
  if [ -s /tmp/claws-pull-err.$$ ]; then
    sed 's/^/    /' /tmp/claws-pull-err.$$
  fi
  printf "  ${C_YELLOW}!${C_RESET} You will be installing from the LOCAL clone (last commit: $(cd "$INSTALL_DIR" && git log --oneline -1 2>/dev/null))\n"
  rm -f /tmp/claws-pull-err.$$
fi
unset _claws_prev_sha _claws_new_sha

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
#
# Safe socket cleanup (v0.7.3). The previous version used `find -mtime +1
# -delete`, which deleted the LIVE socket if VS Code had been open for >24h
# — the running extension still held the socket fd, but the path was gone,
# so any new MCP child got ENOENT and the user's MCP appeared "broken".
# Now we probe the socket; only delete if it's actually unresponsive.
if [ -S "$PROJECT_ROOT/.claws/claws.sock" ]; then
  _claws_sock="$PROJECT_ROOT/.claws/claws.sock"
  _claws_alive=0
  if command -v node >/dev/null 2>&1; then
    if node --no-deprecation -e "
      const net = require('net');
      const s = net.createConnection('$_claws_sock');
      const t = setTimeout(() => { try { s.destroy(); } catch {} process.exit(1); }, 800);
      s.on('connect', () => { s.write('{\"id\":1,\"cmd\":\"list\"}\n'); });
      s.on('data', () => { clearTimeout(t); try { s.destroy(); } catch {} process.exit(0); });
      s.on('error', () => { clearTimeout(t); process.exit(1); });
    " 2>/dev/null; then
      _claws_alive=1
    fi
  fi
  if [ "$_claws_alive" = "1" ]; then
    note "claws.sock is live (extension responding) — leaving in place"
  else
    rm -f "$_claws_sock" 2>/dev/null || true
    note "claws.sock was unresponsive — removed; reload VS Code to recreate"
  fi
  unset _claws_sock _claws_alive
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

# ─── Step 6: Post-update health check (v0.7.3) ────────────────────────────
# Runs the same diagnostic checks /claws-fix would. If any fail, surface
# them BEFORE the success banner so the user knows recovery steps to take.
header "Post-update health check"
_claws_health_ok=1
_claws_health_warns=()

# pty.node ABI parity — the most common silent breakage after an update.
if [ -f "$INSTALL_DIR/extension/native/.metadata.json" ]; then
  _claws_built_for=$(node -e "try{console.log(require('$INSTALL_DIR/extension/native/.metadata.json').electronVersion||'')}catch(e){}" 2>/dev/null || echo "")
  _claws_using=""
  if [ "$(uname)" = "Darwin" ]; then
    for _claws_app in "/Applications/Visual Studio Code.app" "/Applications/Cursor.app" "/Applications/Windsurf.app"; do
      _claws_plist="$_claws_app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"
      [ -f "$_claws_plist" ] && _claws_using=$(plutil -extract CFBundleVersion raw "$_claws_plist" 2>/dev/null || true) && break
    done
  fi
  if [ -n "$_claws_using" ] && [ -n "$_claws_built_for" ] && [ "$_claws_using" != "$_claws_built_for" ]; then
    _claws_health_ok=0
    _claws_health_warns+=("pty.node was built for Electron $_claws_built_for but VS Code is running $_claws_using — wrapped terminals will fall into pipe-mode")
    _claws_health_warns+=("  fix: CLAWS_FORCE_REBUILD_NPTY=1 bash $INSTALL_DIR/scripts/install.sh")
  else
    note "pty.node ABI matches editor Electron ($_claws_using)"
  fi
  unset _claws_built_for _claws_using _claws_app _claws_plist
fi

# Project .mcp.json sanity
if [ -f "$PROJECT_ROOT/.mcp.json" ]; then
  if node -e "JSON.parse(require('fs').readFileSync('$PROJECT_ROOT/.mcp.json','utf8'))" 2>/dev/null; then
    note "project .mcp.json is valid JSON"
  else
    _claws_health_ok=0
    _claws_health_warns+=("$PROJECT_ROOT/.mcp.json is not valid JSON — MCP server will not load")
    _claws_health_warns+=("  fix: review and repair the file, or rm and re-run install.sh")
  fi
fi

# .claws-bin/mcp_server.js exists and starts
if [ -f "$PROJECT_ROOT/.claws-bin/mcp_server.js" ]; then
  if node --no-deprecation -e "
    const { spawn } = require('child_process');
    const p = spawn('node', ['$PROJECT_ROOT/.claws-bin/mcp_server.js'], { stdio: ['pipe','pipe','ignore'] });
    let out='';
    p.stdout.on('data', d => out += d);
    p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'health',version:'1'}}}) + '\n');
    setTimeout(() => { p.kill(); process.exit(out.includes('claws') ? 0 : 1); }, 2000);
  " 2>/dev/null; then
    note "MCP server handshake OK"
  else
    _claws_health_ok=0
    _claws_health_warns+=("MCP server failed to respond to initialize — see install log: $CLAWS_LOG")
    _claws_health_warns+=("  fix: bash $INSTALL_DIR/scripts/fix.sh")
  fi
fi

# ─── Done ──────────────────────────────────────────────────────────────────
echo ""
if [ "$_claws_health_ok" = "1" ]; then
  printf "${C_GREEN}${C_BOLD}Update complete.${C_RESET}\n"
else
  printf "${C_YELLOW}${C_BOLD}Update completed WITH WARNINGS:${C_RESET}\n"
  for _w in "${_claws_health_warns[@]}"; do
    printf "  ${C_YELLOW}!${C_RESET} %s\n" "$_w"
  done
fi
echo ""
printf "  ${C_BOLD}Two things to activate:${C_RESET}\n"
echo "    1. Reload VS Code:      Cmd+Shift+P → Developer: Reload Window"
echo "    2. Restart Claude Code in this project so the new .mcp.json is picked up"
echo ""
printf "  ${C_BOLD}If anything looks off:${C_RESET}\n"
echo "    /claws-fix       — quick auto-diagnosis + auto-repair"
echo "    /claws-report    — bundle logs + state into a shareable file"
echo ""
unset _claws_health_ok _claws_health_warns _w
