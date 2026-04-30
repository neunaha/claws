#!/usr/bin/env bash
# Claws — auto-diagnosis and repair
# Checks every piece of the install chain and repairs what it can. Run this
# when claws_* tools aren't showing up or something feels broken.
#
# Usage: bash ~/.claws-src/scripts/fix.sh [project-root]
#
# The slash command /claws-fix is a thin dispatcher that calls this script.
# Add new checks/repairs here — they'll be picked up on the next git pull
# without any change to the slash-command markdown.

set -eo pipefail

INSTALL_DIR="${CLAWS_DIR:-$HOME/.claws-src}"
PROJECT_ROOT="${1:-$(pwd)}"

# ─── Colors ────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'
  C_GREEN='\033[0;32m'; C_YELLOW='\033[0;33m'; C_RED='\033[0;31m'; C_DIM='\033[2m'
else
  C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''
fi
check()  { printf "${C_BOLD}[check]${C_RESET} %s\n" "$*"; }
ok()     { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
fix()    { printf "  ${C_YELLOW}→${C_RESET} %s\n" "$*"; }
fail()   { printf "  ${C_RED}✗${C_RESET} %s\n" "$*"; }

FIXED=0
ISSUES=0

# ─── 0. System dependencies ────────────────────────────────────────────────
# Fast precheck so users see a clear answer when something upstream broke
# (e.g. they nvm'd to an old Node, uninstalled Xcode CLT, etc).
PLATFORM="$(uname -s)"
check "System dependencies"
if command -v git &>/dev/null; then ok "git ($(git --version | awk '{print $3}'))"
else fail "git not found — install: xcode-select --install (macOS) or sudo apt install git"; ISSUES=$((ISSUES+1)); fi

if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
  if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
    fail "node $(node --version) too old — Claws requires Node 18+"; ISSUES=$((ISSUES+1))
  else
    ok "node ($(node --version))"
  fi
else
  fail "node not found — required for MCP server"; ISSUES=$((ISSUES+1))
fi

if command -v npm &>/dev/null; then ok "npm ($(npm --version))"
else fail "npm not found — required for extension build"; ISSUES=$((ISSUES+1)); fi

if command -v python3 &>/dev/null; then ok "python3 ($(python3 --version 2>&1 | awk '{print $2}'))"
else
  # python3 is only actually needed when node-pty needs to compile from
  # source, which only happens if no prebuild matches the current Node
  # version. Inform but don't count as a failure.
  printf "  ${C_YELLOW}!${C_RESET} python3 not found — only needed if node-pty needs source compile\n"
fi

case "$PLATFORM" in
  Darwin)
    if xcode-select -p &>/dev/null; then ok "Xcode Command Line Tools"
    else
      printf "  ${C_YELLOW}!${C_RESET} Xcode CLT missing — needed only if node-pty must compile (run: xcode-select --install)\n"
    fi
    ;;
  Linux)
    if command -v g++ &>/dev/null; then ok "g++ ($(g++ -dumpversion 2>/dev/null))"
    else printf "  ${C_YELLOW}!${C_RESET} g++ missing — needed only for node-pty source compile (run: sudo apt install build-essential)\n"
    fi
    ;;
esac

# ─── 1. Source clone ───────────────────────────────────────────────────────
check "Claws source clone at $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  ok "clone exists ($(cd "$INSTALL_DIR" && git log --oneline -1 2>/dev/null))"
else
  fail "no clone at $INSTALL_DIR"
  fix "run the installer: bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)"
  ISSUES=$((ISSUES+1))
  exit 1
fi

# ─── 1b. node-pty native binary (ABI-correct for VS Code's Electron) ──────
# node-pty MUST be compiled against VS Code's Electron-embedded Node, not
# system Node. A binary built with plain `node-gyp rebuild` against system
# Node 24 silently fails to load in Electron 39 (Node 22) and the extension
# falls back to pipe-mode. Use @electron/rebuild to target the correct ABI.
check "node-pty native binary (for glitch-free wrapped terminals)"
NPTY_BIN="$INSTALL_DIR/extension/node_modules/node-pty/build/Release/pty.node"
ELECTRON_ABI_FILE="$INSTALL_DIR/extension/dist/.electron-abi"
ELECTRON_VERSION=""
if [ "$(uname)" = "Darwin" ]; then
  # M-32: prefer $TERM_PROGRAM-matching editor; M-33-compat: CURSOR_CHANNEL overrides vscode.
  _fix_tp="${TERM_PROGRAM:-}"
  [ "$_fix_tp" = "vscode" ] && [ -n "${CURSOR_CHANNEL:-}" ] && _fix_tp="cursor"
  _fix_tp=$(echo "$_fix_tp" | tr '[:upper:]' '[:lower:]')
  case "$_fix_tp" in
    cursor)   _fix_darwin_apps=('/Applications/Cursor.app' '/Applications/Visual Studio Code.app' '/Applications/Visual Studio Code - Insiders.app' '/Applications/Windsurf.app') ;;
    windsurf) _fix_darwin_apps=('/Applications/Windsurf.app' '/Applications/Visual Studio Code.app' '/Applications/Visual Studio Code - Insiders.app' '/Applications/Cursor.app') ;;
    *)        _fix_darwin_apps=('/Applications/Visual Studio Code.app' '/Applications/Visual Studio Code - Insiders.app' '/Applications/Cursor.app' '/Applications/Windsurf.app') ;;
  esac
  for _fix_app in "${_fix_darwin_apps[@]}"; do
    plist="$_fix_app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"
    if [ -f "$plist" ]; then
      v=$(plutil -extract CFBundleVersion raw "$plist" 2>/dev/null || true)
      [ -n "$v" ] && ELECTRON_VERSION="$v" && break
    fi
  done
elif [ "$(uname)" = "Linux" ]; then
  # M-33: Linux Cursor/Windsurf paths + TERM_PROGRAM ordering.
  _fix_tp="${TERM_PROGRAM:-}"
  [ "$_fix_tp" = "vscode" ] && [ -n "${CURSOR_CHANNEL:-}" ] && _fix_tp="cursor"
  _fix_tp=$(echo "$_fix_tp" | tr '[:upper:]' '[:lower:]')
  _fix_linux_vscode=('/usr/share/code/electron' '/usr/lib/code/electron' '/opt/visual-studio-code/electron' '/snap/code/current/electron')
  _fix_linux_cursor=('/usr/share/cursor/electron' '/opt/cursor/electron' '/snap/cursor/current/usr/share/cursor/electron')
  _fix_linux_windsurf=('/usr/share/windsurf/electron' '/opt/windsurf/electron')
  _fix_linux_candidates=()
  case "$_fix_tp" in
    cursor)   _fix_linux_candidates=("${_fix_linux_cursor[@]}" "${_fix_linux_vscode[@]}" "${_fix_linux_windsurf[@]}") ;;
    windsurf) _fix_linux_candidates=("${_fix_linux_windsurf[@]}" "${_fix_linux_vscode[@]}" "${_fix_linux_cursor[@]}") ;;
    *)        _fix_linux_candidates=("${_fix_linux_vscode[@]}" "${_fix_linux_cursor[@]}" "${_fix_linux_windsurf[@]}") ;;
  esac
  for _fix_ep in "${_fix_linux_candidates[@]}"; do
    if [ -x "$_fix_ep" ]; then
      v=$("$_fix_ep" --version 2>/dev/null | sed 's/^v//' || true)
      if echo "$v" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then ELECTRON_VERSION="$v" && break; fi
    fi
  done
fi
[ -z "$ELECTRON_VERSION" ] && ELECTRON_VERSION="39.8.5"
LAST_ABI=$(cat "$ELECTRON_ABI_FILE" 2>/dev/null || echo "")

if [ -f "$NPTY_BIN" ] && [ "$LAST_ABI" = "$ELECTRON_VERSION" ]; then
  ok "node-pty binary OK for Electron $ELECTRON_VERSION ($(wc -c < "$NPTY_BIN" | tr -d ' ') bytes)"
elif [ -d "$INSTALL_DIR/extension/node_modules/node-pty" ]; then
  if [ -f "$NPTY_BIN" ] && [ "$LAST_ABI" != "$ELECTRON_VERSION" ]; then
    fix "node-pty built for Electron '$LAST_ABI', need '$ELECTRON_VERSION' — rebuilding"
  else
    fix "node-pty binary missing — rebuilding for Electron $ELECTRON_VERSION"
  fi
  if [ "$(uname)" = "Darwin" ] && ! xcode-select -p &>/dev/null; then
    fail "Xcode Command Line Tools required — run: xcode-select --install"
    ISSUES=$((ISSUES+1))
  else
    # M-31: 5-minute timeout ceiling — prevents indefinite hang on slow Electron header fetch.
    _fix_timeout_cmd=""
    if command -v timeout >/dev/null 2>&1; then _fix_timeout_cmd="timeout 300"
    elif command -v gtimeout >/dev/null 2>&1; then _fix_timeout_cmd="gtimeout 300"
    fi
    if ( cd "$INSTALL_DIR/extension" && $_fix_timeout_cmd npx --yes @electron/rebuild --version="$ELECTRON_VERSION" --only=node-pty --force >/dev/null 2>&1 ); then
      _fix_rebuild_rc=0
    else
      _fix_rebuild_rc=$?
    fi
    if [ "$_fix_rebuild_rc" = "124" ]; then
      fail "@electron/rebuild timed out after 5 min — likely a slow Electron headers download. Check network / proxy settings."
      ISSUES=$((ISSUES+1))
    elif [ "$_fix_rebuild_rc" = "0" ] && [ -f "$NPTY_BIN" ]; then
    echo "$ELECTRON_VERSION" > "$ELECTRON_ABI_FILE" 2>/dev/null || true
    ok "node-pty rebuilt for Electron $ELECTRON_VERSION in source clone"

    # Propagate the rebuilt binary into the source's bundled native/ slot
    # AND into every installed extension directory. Without this, VS Code
    # keeps loading the OLD pty.node from ~/.vscode/extensions/neunaha.claws-X/
    # and the rebuild has no visible effect after reload. (Audit gap #3.)
    SOURCE_NATIVE_DEST="$INSTALL_DIR/extension/native/node-pty/build/Release/pty.node"
    if [ -f "$NPTY_BIN" ] && [ -d "$INSTALL_DIR/extension/native/node-pty/build/Release" ]; then
      cp -f "$NPTY_BIN" "$SOURCE_NATIVE_DEST" 2>/dev/null && ok "propagated to source native/ bundle"
      # Update the metadata.json electronVersion to match
      node --no-deprecation -e "
        const fs=require('fs');
        const p='$INSTALL_DIR/extension/native/.metadata.json';
        try { const m=JSON.parse(fs.readFileSync(p,'utf8')); m.electronVersion='$ELECTRON_VERSION'; m.bundledAt=new Date().toISOString(); fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n'); } catch(e){}
      " 2>/dev/null || true
    fi
    PROPAGATED=0
    for ext_root in "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions" "$HOME/.windsurf/extensions"; do
      [ -d "$ext_root" ] || continue
      for inst in "$ext_root"/neunaha.claws-*; do
        [ -d "$inst" ] || continue
        # Skip if this is a symlink pointing back at the source clone (already updated via source propagation above)
        if [ -L "$inst" ]; then
          ok "skipped $(basename "$inst") — symlink to source"
          PROPAGATED=$((PROPAGATED+1))
          continue
        fi
        target_dir="$inst/native/node-pty/build/Release"
        target="$target_dir/pty.node"
        if [ -d "$target_dir" ]; then
          mkdir -p "$target_dir" 2>/dev/null || true
          if cp -f "$NPTY_BIN" "$target" 2>/dev/null; then
            ok "propagated to $(basename "$inst")"
            PROPAGATED=$((PROPAGATED+1))
          else
            fail "could not write to $target (permissions?)"
            ISSUES=$((ISSUES+1))
          fi
        fi
      done
    done
    if [ "$PROPAGATED" -eq 0 ]; then
      printf "  ${C_YELLOW}!${C_RESET} no installed extension dirs found to propagate to — reload VS Code or run install.sh\n"
    fi
    fix "reload VS Code now: Cmd+Shift+P → Developer: Reload Window"
    FIXED=$((FIXED+1))
    else
      fail "@electron/rebuild failed — wrapped terminals will use pipe-mode"
      ISSUES=$((ISSUES+1))
    fi
  fi
else
  info "node-pty not installed — extension bundle may be missing too (see check 2)"
fi

# ─── 2. Extension bundle ───────────────────────────────────────────────────
check "Extension bundle"
if [ -f "$INSTALL_DIR/extension/dist/extension.js" ]; then
  ok "built ($(wc -c < "$INSTALL_DIR/extension/dist/extension.js" | tr -d ' ') bytes)"
elif [ -f "$INSTALL_DIR/extension/src/extension.js" ]; then
  fix "bundle missing — repointing main to legacy src/extension.js"
  node --no-deprecation -e "const fs=require('fs'),p='$INSTALL_DIR/extension/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.main='./src/extension.js';fs.writeFileSync(p,JSON.stringify(j,null,2));" 2>/dev/null || true
  FIXED=$((FIXED+1))
  # Try to rebuild
  if command -v npm &>/dev/null; then
    fix "attempting to rebuild with npm"
    ( cd "$INSTALL_DIR/extension" && npm install --no-audit --no-fund --loglevel=error --silent && npm run build --silent ) 2>&1 | tail -3 || true
    [ -f "$INSTALL_DIR/extension/dist/extension.js" ] && ok "rebuilt" && FIXED=$((FIXED+1))
  fi
else
  fail "no bundle and no legacy JS fallback"
  ISSUES=$((ISSUES+1))
fi

# ─── 3. Extension installed in editors ─────────────────────────────────────
check "Claws extension installed in VS Code / Cursor / etc"
EXT_VERSION=$(node --no-deprecation -e "try{console.log(require('$INSTALL_DIR/extension/package.json').version)}catch(e){console.log('0.5.0')}" 2>/dev/null || echo "0.5.0")

FOUND_INSTALLS=()
for dir in "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions" "$HOME/.windsurf/extensions"; do
  [ -d "$dir" ] || continue
  for inst in "$dir"/neunaha.claws-*; do
    [ -d "$inst" ] || [ -L "$inst" ] || continue
    FOUND_INSTALLS+=("$(basename "$dir"): $(basename "$inst")")
  done
done

# Warn about DUPLICATE extensions in the same editor dir (FINDING-C-4)
declare -A _EDITOR_COUNT
for entry in "${FOUND_INSTALLS[@]}"; do
  editor="${entry%%:*}"
  _EDITOR_COUNT["$editor"]=$(( ${_EDITOR_COUNT["$editor"]:-0} + 1 ))
done
for editor in "${!_EDITOR_COUNT[@]}"; do
  if [ "${_EDITOR_COUNT[$editor]}" -gt 1 ]; then
    fail "DUPLICATE extensions in $editor (${_EDITOR_COUNT[$editor]} copies) — remove old versions to avoid load-order conflict"
    ISSUES=$((ISSUES+1))
  fi
done
unset _EDITOR_COUNT

if [ "${#FOUND_INSTALLS[@]}" -gt 0 ]; then
  for entry in "${FOUND_INSTALLS[@]}"; do
    ok "installed → $entry"
  done
else
  fix "no Claws extension found in any editor — packaging VSIX and installing"
  VSIX_PATH="/tmp/claws-$EXT_VERSION.vsix"
  if command -v npx &>/dev/null && ( cd "$INSTALL_DIR/extension" && npx --yes @vscode/vsce package --skip-license --no-git-tag-version --no-update-package-json --out "$VSIX_PATH" >/dev/null 2>&1 ); then
    # Try each editor CLI
    INSTALLED=0
    for pair in \
      "code:/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
      "code-insiders:/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders" \
      "cursor:/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
      "windsurf:/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"; do
      label="${pair%%:*}"
      bundled="${pair#*:}"
      cli=""
      if command -v "$label" &>/dev/null; then cli="$(command -v "$label")"
      elif [ -x "$bundled" ]; then cli="$bundled"
      else continue
      fi
      if "$cli" --install-extension "$VSIX_PATH" --force >/dev/null 2>&1; then
        ok "installed into $label"
        INSTALLED=$((INSTALLED+1))
      fi
    done
    if [ "$INSTALLED" -gt 0 ]; then
      FIXED=$((FIXED+1))
    else
      # Fall back to symlink
      TARGET_DIR=""
      for dir in "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions" "$HOME/.windsurf/extensions"; do
        [ -d "$dir" ] && TARGET_DIR="$dir" && break
      done
      [ -z "$TARGET_DIR" ] && TARGET_DIR="$HOME/.vscode/extensions" && mkdir -p "$TARGET_DIR"
      rm -f "$TARGET_DIR"/neunaha.claws-* 2>/dev/null || true
      if ln -sf "$INSTALL_DIR/extension" "$TARGET_DIR/neunaha.claws-$EXT_VERSION" 2>/dev/null \
         || sudo ln -sf "$INSTALL_DIR/extension" "$TARGET_DIR/neunaha.claws-$EXT_VERSION" 2>/dev/null; then
        ok "fallback symlink created at $TARGET_DIR/neunaha.claws-$EXT_VERSION"
        FIXED=$((FIXED+1))
      else
        fail "could not install or symlink extension"
        ISSUES=$((ISSUES+1))
      fi
    fi
  else
    fail "npx/vsce unavailable and no existing install found"
    ISSUES=$((ISSUES+1))
  fi
fi

# ─── 4. Project-local MCP registration ─────────────────────────────────────
check "Project .mcp.json at $PROJECT_ROOT"
PROJECT_MCP="$PROJECT_ROOT/.mcp.json"
if [ -f "$PROJECT_MCP" ] && grep -q '"claws"' "$PROJECT_MCP" 2>/dev/null; then
  ok "claws registered in project"
else
  fix "not registered — adding claws to $PROJECT_MCP"
  # FINDING-B-2 (fix.sh mirror): guard against dangling symlinks before mkdir -p
  if [ -L "$PROJECT_ROOT/.claws-bin" ]; then
    warn ".claws-bin is a symlink — removing before mkdir"
    rm -f "$PROJECT_ROOT/.claws-bin"
  fi
  mkdir -p "$PROJECT_ROOT/.claws-bin"
  cp "$INSTALL_DIR/mcp_server.js" "$PROJECT_ROOT/.claws-bin/mcp_server.js"
  chmod +x "$PROJECT_ROOT/.claws-bin/mcp_server.js"
  # M-45: use fix-repair.js (json-safe.mjs: abort-on-malformed + atomic write).
  # Path passed via env var — no string-interpolation into JS source (M-20).
  if CLAWS_REPAIR_TARGET="$PROJECT_MCP" node --no-deprecation "$INSTALL_DIR/scripts/_helpers/fix-repair.js" mcp 2>&1 | sed 's/^/  /'; then
    ok "wrote $PROJECT_MCP"
    FIXED=$((FIXED+1))
  else
    fail "could not write $PROJECT_MCP — malformed JSON? Check backup above."
    ISSUES=$((ISSUES+1))
  fi
fi

# ─── 4b. Project .vscode/extensions.json recommends claws ─────────────────
check "Project .vscode/extensions.json recommends neunaha.claws"
VSCODE_EXT_JSON="$PROJECT_ROOT/.vscode/extensions.json"
if [ -f "$VSCODE_EXT_JSON" ] && grep -q "neunaha.claws" "$VSCODE_EXT_JSON" 2>/dev/null; then
  ok "already recommended"
else
  fix "adding neunaha.claws to workspace recommendations"
  mkdir -p "$PROJECT_ROOT/.vscode"
  # M-46: use fix-repair.js (json-safe.mjs: abort-on-malformed + atomic write + JSONC-tolerant).
  # Path passed via env var — no string-interpolation into JS source (M-20).
  if CLAWS_REPAIR_TARGET="$VSCODE_EXT_JSON" node --no-deprecation "$INSTALL_DIR/scripts/_helpers/fix-repair.js" extensions 2>&1 | sed 's/^/  /'; then
    ok "wrote $VSCODE_EXT_JSON"
    FIXED=$((FIXED+1))
  else
    fail "could not write $VSCODE_EXT_JSON — malformed JSON? Check backup above."
    ISSUES=$((ISSUES+1))
  fi
fi

# ─── 4c. .claws-bin integrity (unconditional, independent of .mcp.json) ──────
check ".claws-bin integrity"
CLAWS_BIN="$PROJECT_ROOT/.claws-bin"
CLAWS_BIN_SERVER="$CLAWS_BIN/mcp_server.js"
BIN_OK=1
if [ ! -d "$CLAWS_BIN" ]; then
  fix ".claws-bin directory missing — creating and deploying mcp_server.js"
  mkdir -p "$CLAWS_BIN"
  BIN_OK=0
elif [ -L "$CLAWS_BIN_SERVER" ] && [ ! -e "$CLAWS_BIN_SERVER" ]; then
  fix ".claws-bin/mcp_server.js is a dangling symlink — removing"
  rm -f "$CLAWS_BIN_SERVER"
  BIN_OK=0
elif [ ! -f "$CLAWS_BIN_SERVER" ]; then
  fix ".claws-bin/mcp_server.js missing"
  BIN_OK=0
fi
if [ "$BIN_OK" -eq 0 ]; then
  if cp "$INSTALL_DIR/mcp_server.js" "$CLAWS_BIN_SERVER" 2>/dev/null && chmod +x "$CLAWS_BIN_SERVER"; then
    ok ".claws-bin/mcp_server.js restored from $INSTALL_DIR"
    FIXED=$((FIXED+1))
  else
    fail "could not copy mcp_server.js to $CLAWS_BIN — check permissions"
    ISSUES=$((ISSUES+1))
  fi
else
  ok ".claws-bin/mcp_server.js present"
fi

# ─── 5. MCP server handshake ───────────────────────────────────────────────
check "MCP server handshake"
MCP_PATH="$INSTALL_DIR/mcp_server.js"
[ -f "$PROJECT_ROOT/.claws-bin/mcp_server.js" ] && MCP_PATH="$PROJECT_ROOT/.claws-bin/mcp_server.js"
if command -v node &>/dev/null && [ -f "$MCP_PATH" ]; then
  # M-44: mcp_server.js uses newline-delimited JSON, not Content-Length framing.
  # Full protocolVersion + clientInfo required per MCP 2024-11-05 spec.
  HANDSHAKE=$(node --no-deprecation -e '
const { spawn } = require("child_process");
const mcp = spawn("node", [process.argv[1]], { stdio: ["pipe", "pipe", "ignore"] });
const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claws-fix", version: "1" } } });
let buf = "";
const done = (c, o) => { try { mcp.kill(); } catch {} process.stdout.write(o); process.exit(c); };
const timer = setTimeout(() => done(1, "TIMEOUT"), 4000);
mcp.stdout.on("data", d => { buf += d.toString("utf8"); if (buf.includes("claws")) { clearTimeout(timer); done(0, buf.slice(0, 200)); } });
mcp.on("error", e => { clearTimeout(timer); done(1, "SPAWN_ERROR: " + e.message); });
mcp.stdin.write(req + "\n");
' "$MCP_PATH" 2>&1 || echo "FAILED")
  if echo "$HANDSHAKE" | grep -q "claws"; then
    ok "MCP server responds (initialize OK)"
  else
    fail "MCP server failed to respond: ${HANDSHAKE:0:200}"
    ISSUES=$((ISSUES+1))
  fi
else
  fail "node or $MCP_PATH missing"
  ISSUES=$((ISSUES+1))
fi

# ─── 6. Extension socket liveness ──────────────────────────────────────────
check "Extension socket .claws/claws.sock"
SOCK="$PROJECT_ROOT/.claws/claws.sock"
if [ -S "$SOCK" ]; then
  if command -v nc &>/dev/null && echo '{"id":1,"cmd":"list"}' | nc -U "$SOCK" 2>/dev/null | head -c 200 | grep -q '"ok"'; then
    ok "socket is LIVE — extension listening"
  else
    fix "socket is stale — VS Code needs to reload"
    rm -f "$SOCK" 2>/dev/null || true
    fail "after reload the extension will re-create the socket"
    ISSUES=$((ISSUES+1))
  fi
else
  fail "no socket at $SOCK"
  fix "this is normal if VS Code isn't running this project — reload a VS Code window on this folder"
  ISSUES=$((ISSUES+1))
fi

# ─── 6b. Shell hook sourcing in rc files (FINDING-C-11) ─────────────────────
check "Shell hook sourcing in rc files (.zshrc / .bashrc)"
HOOK_SCRIPT="$INSTALL_DIR/scripts/shell-hook.sh"
RC_SOURCED=0
RC_CHECKED=0
for RC in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [ -f "$RC" ] || continue
  RC_CHECKED=$((RC_CHECKED+1))
  if grep -q 'shell-hook.sh' "$RC" 2>/dev/null; then
    ok "shell-hook.sh sourced in $(basename "$RC")"
    RC_SOURCED=$((RC_SOURCED+1))
  fi
done
if [ "$RC_SOURCED" -eq 0 ] && [ -f "$HOOK_SCRIPT" ]; then
  TARGET_RC="$HOME/.zshrc"
  [ -f "$HOME/.bashrc" ] && TARGET_RC="$HOME/.bashrc"
  [ -f "$HOME/.zshrc" ] && TARGET_RC="$HOME/.zshrc"
  fix "shell-hook.sh not sourced in any rc file — appending to $(basename "$TARGET_RC")"
  printf '\n# Claws shell functions (claws-ls, claws-new, claws-run, claws-log)\n[ -f "%s" ] && source "%s"\n' \
    "$HOOK_SCRIPT" "$HOOK_SCRIPT" >> "$TARGET_RC"
  ok "appended source line to $(basename "$TARGET_RC") — open a new terminal to activate"
  FIXED=$((FIXED+1))
elif [ "$RC_CHECKED" -eq 0 ]; then
  fix "no .zshrc or .bashrc found — skipping shell-hook sourcing check"
fi

# ─── 7. Stale global MCP registration in ~/.claude/settings.json ───────────
check "Global ~/.claude/settings.json (informational)"
if [ -f "$HOME/.claude/settings.json" ] && grep -q '"claws"' "$HOME/.claude/settings.json" 2>/dev/null; then
  if [ -f "$PROJECT_MCP" ]; then
    fix "global claws entry exists alongside project .mcp.json — project takes precedence (safe to remove global if you want)"
  else
    ok "global claws registration active"
  fi
fi

# ─── 7b. ~/.claude/settings.json JSON validity (FINDING-C-7, P0) ─────────────
# A malformed settings.json causes EVERY Claude Code hook (SessionStart,
# PreToolUse, Stop) to fail silently on every tool call. Detect and repair
# before the stale-paths check below, so check 8 can assume valid JSON.
check "~/.claude/settings.json is valid JSON"
if [ -f "$HOME/.claude/settings.json" ]; then
  if ! node --no-deprecation -e "
    const fs=require('fs');
    JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
  " "$HOME/.claude/settings.json" 2>/dev/null; then
    fail "settings.json is malformed JSON — ALL claude hooks will fail silently"
    fix "backing up and re-injecting Claws hooks via inject-settings-hooks.js"
    cp "$HOME/.claude/settings.json" "$HOME/.claude/settings.json.bak.$(date +%s)" 2>/dev/null || true
    if node --no-deprecation "$INSTALL_DIR/scripts/inject-settings-hooks.js" --remove >/dev/null 2>&1 \
       && node --no-deprecation "$INSTALL_DIR/scripts/inject-settings-hooks.js" "$INSTALL_DIR/scripts" >/dev/null 2>&1; then
      ok "hooks re-written into repaired settings.json"
      FIXED=$((FIXED+1))
    else
      fail "automatic repair failed — manually edit $HOME/.claude/settings.json (backup saved)"
      ISSUES=$((ISSUES+1))
    fi
  else
    ok "settings.json is valid JSON"
  fi
fi

# ─── 8. Stale Claws hook script paths in ~/.claude/settings.json (v0.7.3) ──
# Detects the "SessionStart:startup hook error / non-blocking status code"
# class of failure: registered hook commands point at a path that no longer
# exists (install dir moved, sandbox path leaked into settings, prior
# install was deleted). Re-registers from the current INSTALL_DIR so
# Claude Code stops reporting hook errors on every tool call.
check "Hook script paths in ~/.claude/settings.json"
if [ -f "$HOME/.claude/settings.json" ] && grep -q '_source.*claws' "$HOME/.claude/settings.json" 2>/dev/null; then
  STALE_HOOKS=$(node --no-deprecation -e "
    const fs=require('fs');
    const j=JSON.parse(fs.readFileSync('$HOME/.claude/settings.json','utf8'));
    const stale=[];
    for(const ev of Object.keys(j.hooks||{})){
      for(const e of (j.hooks[ev]||[])){
        if(e._source!=='claws')continue;
        if(!e.hooks||!e.hooks[0])continue;
        const cmd=e.hooks[0].command||'';
        // Extract the .js path from either: plain 'node \"<path>\"' OR
        // wrapped 'sh -c \"...\" \"<path>\"' (path is the LAST quoted token).
        const matches=[...cmd.matchAll(/\"([^\"]+\\.js)\"/g)];
        if(!matches.length)continue;
        const scriptPath=matches[matches.length-1][1];
        if(!fs.existsSync(scriptPath)) stale.push({event:ev,path:scriptPath});
      }
    }
    if(stale.length===0){console.log('OK')}
    else for(const s of stale)console.log(s.event+'\t'+s.path);
  " 2>/dev/null)
  if [ "$STALE_HOOKS" = "OK" ]; then
    ok "all registered Claws hook paths resolve"
  else
    fail "stale hook path(s) detected:"
    echo "$STALE_HOOKS" | sed 's/^/    /'
    fix "re-registering hooks against $INSTALL_DIR/scripts/hooks/"
    if node --no-deprecation "$INSTALL_DIR/scripts/inject-settings-hooks.js" --remove >/dev/null 2>&1 \
       && node --no-deprecation "$INSTALL_DIR/scripts/inject-settings-hooks.js" "$INSTALL_DIR/scripts" >/dev/null 2>&1; then
      ok "hooks re-registered from $INSTALL_DIR/scripts/hooks/"
      FIXED=$((FIXED+1))
    else
      fail "could not re-register hooks — check $INSTALL_DIR/scripts/inject-settings-hooks.js exists"
      ISSUES=$((ISSUES+1))
    fi
  fi
fi

# ─── 9. Hook script execution probe (v0.7.3) ──────────────────────────────
# Defense in depth: even if the path resolves, the script might crash on
# load (ESM vs CJS, missing deps, etc). Invoke each hook with synthetic
# stdin and confirm exit 0. Hooks were hardened in v0.7.3 to never crash,
# but if a user is running pre-v0.7.3 hook scripts, we surface the gap.
check "Hook scripts execute cleanly"
HOOK_DIR="$INSTALL_DIR/scripts/hooks"
HOOKS_PRESENT=0
HOOKS_OK=0
HOOKS_FAIL=0
HOOKS_FAILED_NAMES=""
for hook in session-start-claws.js pre-tool-use-claws.js stop-claws.js; do
  [ -f "$HOOK_DIR/$hook" ] || continue
  HOOKS_PRESENT=$((HOOKS_PRESENT+1))
  # Use a Node-based 5s ceiling instead of `timeout` (not on macOS by default).
  # The hook should exit in <100ms anyway; this just guards against pathological
  # hangs in pre-v0.7.3 hook scripts.
  if echo '{"cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"ls"}}' \
     | node --no-deprecation -e "
       const { spawn } = require('child_process');
       let buf = '';
       process.stdin.on('data', d => buf += d);
       process.stdin.on('end', () => {
         const ch = spawn('node', ['$HOOK_DIR/$hook'], { stdio: ['pipe','pipe','pipe'] });
         const t = setTimeout(() => { try { ch.kill('SIGKILL'); } catch {} process.exit(124); }, 5000);
         ch.stdin.write(buf); ch.stdin.end();
         ch.on('exit', c => { clearTimeout(t); process.exit(c||0); });
         ch.on('error', () => { clearTimeout(t); process.exit(127); });
       });
     " >/dev/null 2>&1; then
    HOOKS_OK=$((HOOKS_OK+1))
  else
    HOOKS_FAIL=$((HOOKS_FAIL+1))
    HOOKS_FAILED_NAMES="$HOOKS_FAILED_NAMES $hook"
  fi
done
if [ "$HOOKS_PRESENT" -eq 0 ]; then
  fail "no hook scripts found at $HOOK_DIR — run install.sh"
  ISSUES=$((ISSUES+1))
elif [ "$HOOKS_FAIL" -eq 0 ]; then
  ok "all $HOOKS_OK hook script(s) probe clean"
else
  fail "$HOOKS_FAIL of $HOOKS_PRESENT hook(s) exited non-zero on probe:$HOOKS_FAILED_NAMES"
  fix "if you have an older Claws version, run install.sh to refresh hooks (v0.7.3+ hardening)"
  ISSUES=$((ISSUES+1))
fi

# ─── Summary ──────────────────────────────────────────────────────────────
echo ""
if [ "$ISSUES" -eq 0 ]; then
  printf "${C_GREEN}${C_BOLD}All checks passed${C_RESET} — ${FIXED} auto-repairs applied.\n"
else
  printf "${C_YELLOW}${C_BOLD}${FIXED} fixed, ${ISSUES} still open.${C_RESET}\n"
fi
echo ""
printf "${C_BOLD}Activate changes:${C_RESET}\n"
echo "  1. Reload VS Code:      Cmd+Shift+P → Developer: Reload Window"
echo "  2. Restart Claude Code: exit this session and re-open 'claude' in this project"
echo ""
printf "${C_BOLD}Still broken after that?${C_RESET}\n"
echo "  Run /claws-report to bundle logs + state for a support request."
echo ""
