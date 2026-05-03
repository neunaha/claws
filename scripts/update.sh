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

# FINDING-B-5: --dry-run flag — show what would change without applying it.
DRY_RUN=0
_update_args=()
for _arg in "$@"; do
  case "$_arg" in
    --dry-run) DRY_RUN=1 ;;
    *) _update_args+=("$_arg") ;;
  esac
done
set -- "${_update_args[@]+"${_update_args[@]}"}"
unset _update_args _arg

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

# M-19: Anchor CLAWS_LOG BEFORE install.sh runs so Step 6's warning
# "see install log: $CLAWS_LOG" references the real log written by install.sh.
# install.sh uses ${CLAWS_LOG:-...} so it inherits this value when exported.
CLAWS_LOG="${CLAWS_LOG:-/tmp/claws-install-$(date +%Y%m%d-%H%M%S)-$$.log}"
export CLAWS_LOG

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
# M-21: track whether git pull succeeded so install.sh can skip stale-source
# CLAUDE.md re-injection. GIT_PULL_OK=0 exported on failure → install.sh gates on it.
GIT_PULL_OK=1
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
  GIT_PULL_OK=0
  printf "  ${C_YELLOW}!${C_RESET} git pull failed — continuing with existing tree\n"
  if [ -s /tmp/claws-pull-err.$$ ]; then
    sed 's/^/    /' /tmp/claws-pull-err.$$
  fi
  printf "  ${C_YELLOW}!${C_RESET} You will be installing from the LOCAL clone (last commit: $(cd "$INSTALL_DIR" && git log --oneline -1 2>/dev/null))\n"
  printf "  ${C_YELLOW}!${C_RESET} CLAUDE.md re-injection skipped — stale source would overwrite tool set (M-21)\n"
  rm -f /tmp/claws-pull-err.$$
fi
export GIT_PULL_OK
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
if [ "$DRY_RUN" = "1" ]; then
  note "--dry-run: skipping installer. Pending git diff from $INSTALL_DIR:"
  ( cd "$INSTALL_DIR" && git log --oneline origin/main..HEAD 2>/dev/null || true )
  ( cd "$INSTALL_DIR" && git diff --stat origin/main 2>/dev/null || true )
else
  ( cd "$PROJECT_ROOT" && bash "$INSTALL_DIR/scripts/install.sh" )
fi

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
# M-26: Socket probe is health-check only. The previous version deleted the
# socket when the probe failed, which races with VS Code's extension hot-reload
# after a VSIX install — the extension may be momentarily unreachable while
# reactivating, so a failed probe does NOT mean the socket is stale.
# Destructive cleanup is deferred to /claws-fix (user-explicit step).
if [ -S "$PROJECT_ROOT/.claws/claws.sock" ]; then
  _claws_sock="$PROJECT_ROOT/.claws/claws.sock"
  _claws_alive=0
  if command -v node >/dev/null 2>&1; then
    # M-20: pass path via env var — handles project roots with apostrophes/backslashes
    # without causing JS syntax errors from string interpolation in -e argument.
    if CLAWS_PROBE_PATH="$_claws_sock" node --no-deprecation -e "
      const net = require('net');
      const s = net.createConnection(process.env.CLAWS_PROBE_PATH);
      const t = setTimeout(() => { try { s.destroy(); } catch {} process.exit(1); }, 800);
      s.on('connect', () => { s.write('{\"id\":1,\"cmd\":\"list\"}\n'); });
      s.on('data', () => { clearTimeout(t); try { s.destroy(); } catch {} process.exit(0); });
      s.on('error', () => { clearTimeout(t); process.exit(1); });
    " 2>/dev/null; then
      _claws_alive=1
    fi
  fi
  if [ "$_claws_alive" = "1" ]; then
    note "claws.sock is live (extension responding)"
  else
    note "claws.sock probe returned no response (extension may be reloading after VSIX install)"
    note "If 'claws_*' tools fail in your next Claude Code session, run /claws-fix to repair"
    # Do NOT delete the socket here — defer to user-explicit /claws-fix (M-26)
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
    # M-35: prefer the editor that launched this shell ($TERM_PROGRAM) so the
    # user's daily-driver Electron version is checked first, not first-found.
    _claws_u_tp="${TERM_PROGRAM:-}"
    [ "$_claws_u_tp" = "vscode" ] && [ -n "${CURSOR_CHANNEL:-}" ] && _claws_u_tp="cursor"
    _claws_u_tp=$(echo "$_claws_u_tp" | tr '[:upper:]' '[:lower:]')
    case "$_claws_u_tp" in
      cursor)   _claws_update_apps=('/Applications/Cursor.app' '/Applications/Visual Studio Code.app' '/Applications/Windsurf.app') ;;
      windsurf) _claws_update_apps=('/Applications/Windsurf.app' '/Applications/Visual Studio Code.app' '/Applications/Cursor.app') ;;
      *)        _claws_update_apps=('/Applications/Visual Studio Code.app' '/Applications/Cursor.app' '/Applications/Windsurf.app') ;;
    esac
    for _claws_app in "${_claws_update_apps[@]}"; do
      _claws_plist="$_claws_app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"
      [ -f "$_claws_plist" ] && _claws_using=$(plutil -extract CFBundleVersion raw "$_claws_plist" 2>/dev/null || true) && break
    done
    unset _claws_u_tp _claws_update_apps
  elif [ "$(uname)" = "Linux" ]; then
    # F-5: port Linux Electron detection from install.sh so ABI mismatch is caught on Linux too.
    _claws_u_tp="${TERM_PROGRAM:-}"
    [ "$_claws_u_tp" = "vscode" ] && [ -n "${CURSOR_CHANNEL:-}" ] && _claws_u_tp="cursor"
    _claws_u_tp=$(echo "$_claws_u_tp" | tr '[:upper:]' '[:lower:]')
    case "$_claws_u_tp" in
      cursor)
        _claws_linux_eps="/usr/share/cursor/electron /opt/cursor/electron /snap/cursor/current/usr/share/cursor/electron /usr/share/code/electron /usr/lib/code/electron /opt/visual-studio-code/electron /snap/code/current/usr/share/code/electron /usr/share/windsurf/electron /opt/windsurf/electron"
        ;;
      windsurf)
        _claws_linux_eps="/usr/share/windsurf/electron /opt/windsurf/electron /usr/share/code/electron /usr/lib/code/electron /opt/visual-studio-code/electron /snap/code/current/usr/share/code/electron /usr/share/cursor/electron /opt/cursor/electron"
        ;;
      *)
        _claws_linux_eps="/usr/share/code/electron /usr/lib/code/electron /opt/visual-studio-code/electron /snap/code/current/usr/share/code/electron /usr/share/cursor/electron /opt/cursor/electron /snap/cursor/current/usr/share/cursor/electron /usr/share/windsurf/electron /opt/windsurf/electron"
        ;;
    esac
    for _claws_ep in $_claws_linux_eps; do
      if [ -x "$_claws_ep" ]; then
        _claws_using=$("$_claws_ep" --version 2>/dev/null | sed 's/^v//' | head -1)
        [ -n "$_claws_using" ] && break
      fi
    done
    unset _claws_u_tp _claws_linux_eps _claws_ep
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

# BUG-28: MCP spawn-class PreToolUse hooks — Monitor arm gate
if [ -f "$HOME/.claude/settings.json" ]; then
  if CLAWS_SETTINGS_CHECK="$HOME/.claude/settings.json" node --no-deprecation -e "
    const s = JSON.parse(require('fs').readFileSync(process.env.CLAWS_SETTINGS_CHECK, 'utf8'));
    const h = (s.hooks && s.hooks.PreToolUse) || [];
    process.exit(h.some(e => e.matcher && e.matcher.includes('mcp__claws__claws_worker')) ? 0 : 1);
  " 2>/dev/null; then
    note "MCP spawn-class PreToolUse hooks registered (Monitor arm gate active)"
  else
    _claws_health_ok=0
    _claws_health_warns+=("MCP spawn-class PreToolUse hooks missing — Monitor arm gate is inactive")
    _claws_health_warns+=("  fix: node $INSTALL_DIR/scripts/inject-settings-hooks.js $INSTALL_DIR/scripts --update")
  fi
fi

# Wave C: PostToolUse spawn-class hooks — monitor race-close
if [ -f "$HOME/.claude/settings.json" ]; then
  if CLAWS_SETTINGS_CHECK="$HOME/.claude/settings.json" node --no-deprecation -e "
    const s = JSON.parse(require('fs').readFileSync(process.env.CLAWS_SETTINGS_CHECK, 'utf8'));
    const h = (s.hooks && s.hooks.PostToolUse) || [];
    process.exit(h.some(e => e.matcher && e.matcher.includes('mcp__claws__claws_worker')) ? 0 : 1);
  " 2>/dev/null; then
    note "PostToolUse spawn-class hooks registered (Wave C monitor race-close active)"
  else
    _claws_health_ok=0
    _claws_health_warns+=("PostToolUse spawn-class hooks missing — Wave C monitor race-close is inactive")
    _claws_health_warns+=("  fix: node $INSTALL_DIR/scripts/inject-settings-hooks.js $INSTALL_DIR/scripts --update")
  fi
fi

# Project .mcp.json sanity
# M-47: path passed via env var — handles project roots with apostrophes/backslashes
# without causing JS syntax errors from string interpolation in -e argument.
if [ -f "$PROJECT_ROOT/.mcp.json" ]; then
  if CLAWS_MCP_CHECK="$PROJECT_ROOT/.mcp.json" node -e "JSON.parse(require('fs').readFileSync(process.env.CLAWS_MCP_CHECK,'utf8'))" 2>/dev/null; then
    note "project .mcp.json is valid JSON"
  else
    _claws_health_ok=0
    _claws_health_warns+=("$PROJECT_ROOT/.mcp.json is not valid JSON — MCP server will not load")
    _claws_health_warns+=("  fix: review and repair the file, or rm and re-run install.sh")
  fi
fi

# Fix #1 (v0.7.12): ensure .claws-bin/package.json exists with {"type":"commonjs"}.
# Auto-restores on every update so existing installs without it get fixed automatically.
if [ -d "$PROJECT_ROOT/.claws-bin" ] && [ ! -f "$PROJECT_ROOT/.claws-bin/package.json" ]; then
  printf '{\n  "type": "commonjs",\n  "_comment": "Forces CommonJS for .js files in .claws-bin/. Required when the parent project has type:module in its package.json (Next.js, Vite, etc.)"\n}\n' > "$PROJECT_ROOT/.claws-bin/package.json"
  note "wrote .claws-bin/package.json (ESM compat shim)"
fi

# .claws-bin/mcp_server.js exists and starts
# M-10: up to 3 attempts with exponential timeouts (8s, 12s, 16s); only YELLOW after all exhausted.
if [ -f "$PROJECT_ROOT/.claws-bin/mcp_server.js" ]; then
  _claws_mcp_ok=0
  _claws_attempt=0
  for _claws_mcp_ms in 8000 12000 16000; do
    [ "$_claws_mcp_ok" = "1" ] && break
    _claws_attempt=$(( _claws_attempt + 1 ))
    [ "$_claws_attempt" -gt 1 ] && note "MCP handshake timeout — retry $_claws_attempt of 3 (${_claws_mcp_ms}ms)..."
    if CLAWS_MCP_PATH="$PROJECT_ROOT/.claws-bin/mcp_server.js" node --no-deprecation -e "
      const { spawn } = require('child_process');
      const p = spawn('node', [process.env.CLAWS_MCP_PATH], { stdio: ['pipe','pipe','ignore'] });
      let out='';
      p.stdout.on('data', d => { out += d; });
      p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'health',version:'1'}}}) + '\n');
      setTimeout(() => {
        p.kill('SIGTERM');
        setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 500);
        setTimeout(() => { process.exit(out.includes('claws') ? 0 : 1); }, 600);
      }, $_claws_mcp_ms);
    " 2>/dev/null; then
      _claws_mcp_ok=1
    fi
  done
  unset _claws_mcp_ms _claws_attempt
  if [ "$_claws_mcp_ok" = "1" ]; then
    note "MCP server handshake OK"
  else
    _claws_health_ok=0
    _claws_health_warns+=("MCP server failed to respond to initialize — see install log: $CLAWS_LOG")
    _claws_health_warns+=("  fix: bash $INSTALL_DIR/scripts/fix.sh")
  fi
  unset _claws_mcp_ok
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
