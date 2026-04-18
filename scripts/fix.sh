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
  for app in \
    "/Applications/Visual Studio Code.app" \
    "/Applications/Visual Studio Code - Insiders.app" \
    "/Applications/Cursor.app" \
    "/Applications/Windsurf.app"; do
    plist="$app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"
    if [ -f "$plist" ]; then
      v=$(plutil -extract CFBundleVersion raw "$plist" 2>/dev/null || true)
      [ -n "$v" ] && ELECTRON_VERSION="$v" && break
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
  elif ( cd "$INSTALL_DIR/extension" && npx --yes @electron/rebuild --version="$ELECTRON_VERSION" --which=node-pty --force >/dev/null 2>&1 ) && [ -f "$NPTY_BIN" ]; then
    echo "$ELECTRON_VERSION" > "$ELECTRON_ABI_FILE" 2>/dev/null || true
    ok "node-pty rebuilt for Electron $ELECTRON_VERSION — reload VS Code to pick it up"
    FIXED=$((FIXED+1))
  else
    fail "@electron/rebuild failed — wrapped terminals will use pipe-mode"
    ISSUES=$((ISSUES+1))
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
EXT_VERSION=$(node --no-deprecation -e "try{console.log(require('$INSTALL_DIR/extension/package.json').version)}catch(e){console.log('0.4.0')}" 2>/dev/null || echo "0.4.0")

FOUND_INSTALLS=()
for dir in "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions" "$HOME/.windsurf/extensions"; do
  [ -d "$dir" ] || continue
  # Any `neunaha.claws-*` directory or symlink counts as installed
  if ls "$dir"/neunaha.claws-* &>/dev/null; then
    FOUND_INSTALLS+=("$(basename "$dir"): $(ls -d "$dir"/neunaha.claws-* 2>/dev/null | head -1 | xargs basename)")
  fi
done

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
  mkdir -p "$PROJECT_ROOT/.claws-bin"
  cp "$INSTALL_DIR/mcp_server.js" "$PROJECT_ROOT/.claws-bin/mcp_server.js"
  chmod +x "$PROJECT_ROOT/.claws-bin/mcp_server.js"
  node --no-deprecation -e "
const fs = require('fs');
const p = '$PROJECT_MCP';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
if (!cfg.mcpServers) cfg.mcpServers = {};
cfg.mcpServers.claws = { command: 'node', args: ['./.claws-bin/mcp_server.js'], env: { CLAWS_SOCKET: '.claws/claws.sock' } };
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
"
  ok "wrote $PROJECT_MCP"
  FIXED=$((FIXED+1))
fi

# ─── 4b. Project .vscode/extensions.json recommends claws ─────────────────
check "Project .vscode/extensions.json recommends neunaha.claws"
VSCODE_EXT_JSON="$PROJECT_ROOT/.vscode/extensions.json"
if [ -f "$VSCODE_EXT_JSON" ] && grep -q "neunaha.claws" "$VSCODE_EXT_JSON" 2>/dev/null; then
  ok "already recommended"
else
  fix "adding neunaha.claws to workspace recommendations"
  mkdir -p "$PROJECT_ROOT/.vscode"
  node --no-deprecation -e "
const fs = require('fs');
const p = process.argv[1];
let cfg = {};
try {
  const raw = fs.readFileSync(p, 'utf8');
  const stripped = raw.replace(/\/\/.*\$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  cfg = JSON.parse(stripped);
} catch {}
if (!Array.isArray(cfg.recommendations)) cfg.recommendations = [];
if (!cfg.recommendations.includes('neunaha.claws')) cfg.recommendations.push('neunaha.claws');
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
" "$VSCODE_EXT_JSON" 2>/dev/null && ok "wrote $VSCODE_EXT_JSON" && FIXED=$((FIXED+1)) || fail "could not write $VSCODE_EXT_JSON"
fi

# ─── 5. MCP server handshake ───────────────────────────────────────────────
check "MCP server handshake"
MCP_PATH="$INSTALL_DIR/mcp_server.js"
[ -f "$PROJECT_ROOT/.claws-bin/mcp_server.js" ] && MCP_PATH="$PROJECT_ROOT/.claws-bin/mcp_server.js"
if command -v node &>/dev/null && [ -f "$MCP_PATH" ]; then
  HANDSHAKE=$(node --no-deprecation -e '
const { spawn } = require("child_process");
const mcp = spawn("node", [process.argv[1]], { stdio: ["pipe", "pipe", "ignore"] });
const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
const msg = `Content-Length: ${Buffer.byteLength(req)}\r\n\r\n${req}`;
let buf = "";
const done = (c, o) => { try { mcp.kill(); } catch {}; process.stdout.write(o); process.exit(c); };
const timer = setTimeout(() => done(1, "TIMEOUT"), 4000);
mcp.stdout.on("data", d => { buf += d.toString("utf8"); if (buf.includes("claws")) { clearTimeout(timer); done(0, buf.slice(0, 200)); } });
mcp.on("error", e => { clearTimeout(timer); done(1, "SPAWN_ERROR: " + e.message); });
mcp.stdin.write(msg);
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

# ─── 7. Stale global MCP registration in ~/.claude/settings.json ───────────
check "Global ~/.claude/settings.json (informational)"
if [ -f "$HOME/.claude/settings.json" ] && grep -q '"claws"' "$HOME/.claude/settings.json" 2>/dev/null; then
  if [ -f "$PROJECT_MCP" ]; then
    fix "global claws entry exists alongside project .mcp.json — project takes precedence (safe to remove global if you want)"
  else
    ok "global claws registration active"
  fi
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
