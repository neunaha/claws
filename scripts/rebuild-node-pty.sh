#!/usr/bin/env bash
# Claws — force-rebuild node-pty against VS Code's Electron ABI
#
# Run when the extension keeps saying "[claws] running in pipe-mode
# (node-pty unavailable)" and /claws-update didn't fix it. This script is
# deliberately independent of /claws-update / /claws-fix — pure bash, shows
# every step, so you (and I) can see exactly where things go wrong.
#
# Usage:
#   # From repo clone:
#   bash ~/.claws-src/scripts/rebuild-node-pty.sh
#
#   # Direct from GitHub (no clone needed):
#   bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/rebuild-node-pty.sh)
#
# Env overrides:
#   CLAWS_DIR=/path         Override ~/.claws-src location
#   ELECTRON_VERSION=X.Y.Z  Force a specific Electron target (otherwise auto-detected)

# Deliberately NOT using `set -e` — we want to continue past individual
# step failures so the user sees the full diagnostic.

INSTALL_DIR="${CLAWS_DIR:-$HOME/.claws-src}"
C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'; C_RED=$'\033[0;31m'; C_BLUE=$'\033[0;34m'; C_DIM=$'\033[2m'

h1()   { printf "\n${C_BOLD}${C_BLUE}═══ %s ═══${C_RESET}\n" "$*"; }
ok()   { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn() { printf "  ${C_YELLOW}!${C_RESET} %s\n" "$*"; }
bad()  { printf "  ${C_RED}✗${C_RESET} %s\n" "$*"; }
info() { printf "  ${C_DIM}%s${C_RESET}\n" "$*"; }

# ─── 0. Pre-flight ─────────────────────────────────────────────────────────
h1 "Pre-flight"
info "PLATFORM: $(uname -s) $(uname -r) $(uname -m)"
info "node:     $(command -v node 2>/dev/null) $(node --version 2>/dev/null)"
info "npm:      $(command -v npm 2>/dev/null) $(npm --version 2>/dev/null)"
info "npx:      $(command -v npx 2>/dev/null)"
if [ "$(uname -s)" = "Darwin" ]; then
  if xcode-select -p &>/dev/null; then
    ok "Xcode CLT at $(xcode-select -p)"
  else
    bad "Xcode Command Line Tools NOT installed"
    warn "without them node-pty cannot compile. Install with:"
    echo "      xcode-select --install"
    echo "   then re-run this script."
    exit 1
  fi
fi

if [ ! -d "$INSTALL_DIR/extension" ]; then
  bad "Claws source not found at $INSTALL_DIR/extension"
  warn "install Claws first: bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)"
  exit 1
fi
ok "source clone at $INSTALL_DIR"

NPTY_DIR="$INSTALL_DIR/extension/node_modules/node-pty"
NPTY_BIN="$NPTY_DIR/build/Release/pty.node"
ABI_FILE="$INSTALL_DIR/extension/dist/.electron-abi"

# ─── 1. Detect VS Code's Electron version ──────────────────────────────────
h1 "Detect VS Code Electron version"
if [ -n "$ELECTRON_VERSION" ]; then
  info "ELECTRON_VERSION env override: $ELECTRON_VERSION"
elif [ "$(uname -s)" = "Darwin" ]; then
  for app in \
    "/Applications/Visual Studio Code.app" \
    "/Applications/Visual Studio Code - Insiders.app" \
    "/Applications/Cursor.app" \
    "/Applications/Windsurf.app"; do
    plist="$app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"
    if [ -f "$plist" ]; then
      v=$(plutil -extract CFBundleVersion raw "$plist" 2>/dev/null || true)
      if [ -n "$v" ]; then
        ELECTRON_VERSION="$v"
        ok "$(basename "$app") uses Electron $v"
        break
      fi
    else
      info "$(basename "$app"): not installed"
    fi
  done
fi
if [ -z "$ELECTRON_VERSION" ]; then
  ELECTRON_VERSION="39.8.5"
  warn "couldn't auto-detect — using fallback $ELECTRON_VERSION"
fi

# ─── 2. Current binary state ───────────────────────────────────────────────
h1 "Current node-pty state"
if [ -d "$NPTY_DIR" ]; then
  ok "node-pty package installed at $NPTY_DIR"
  pkg_ver=$(node -p "require('$NPTY_DIR/package.json').version" 2>/dev/null)
  info "node-pty version: $pkg_ver"
else
  warn "node-pty not installed — running npm install first"
  ( cd "$INSTALL_DIR/extension" && npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -5 )
fi

if [ -f "$NPTY_BIN" ]; then
  size=$(wc -c < "$NPTY_BIN" | tr -d ' ')
  mtime=$(stat -f '%Sm' "$NPTY_BIN" 2>/dev/null || stat -c '%y' "$NPTY_BIN" 2>/dev/null)
  info "binary exists: $size bytes, mtime $mtime"
else
  warn "binary NOT present at $NPTY_BIN"
fi

if [ -f "$ABI_FILE" ]; then
  last_abi=$(cat "$ABI_FILE")
  info "last-built ABI: Electron $last_abi"
  if [ "$last_abi" = "$ELECTRON_VERSION" ]; then
    ok "recorded ABI matches current Electron"
  else
    warn "recorded ABI '$last_abi' ≠ current Electron '$ELECTRON_VERSION' — rebuild needed"
  fi
else
  warn "no ABI marker — treating as stale"
fi

# ─── 3. Force-rebuild with @electron/rebuild ───────────────────────────────
h1 "Rebuilding node-pty for Electron $ELECTRON_VERSION"
info "removing old binary + ABI marker to force a clean rebuild"
rm -f "$NPTY_BIN" "$ABI_FILE" 2>/dev/null

info "running: npx --yes @electron/rebuild --version=$ELECTRON_VERSION --which=node-pty --force"
rebuild_log=$(mktemp -t claws-rebuild.XXXXXX.log)
if ( cd "$INSTALL_DIR/extension" && npx --yes @electron/rebuild --version="$ELECTRON_VERSION" --which=node-pty --force ) >"$rebuild_log" 2>&1; then
  ok "@electron/rebuild completed"
  info "log: $rebuild_log (last 5 lines below)"
  tail -5 "$rebuild_log" | sed 's/^/    /'
else
  bad "@electron/rebuild FAILED"
  info "full log: $rebuild_log"
  info "last 20 lines:"
  tail -20 "$rebuild_log" | sed 's/^/    /'
  echo ""
  bad "cannot proceed — node-pty will not work until the build succeeds"
  exit 1
fi

# ─── 4. Verify the new binary ──────────────────────────────────────────────
h1 "Verify new binary"
if [ ! -f "$NPTY_BIN" ]; then
  bad "rebuild reported success but $NPTY_BIN is still missing"
  exit 1
fi
new_size=$(wc -c < "$NPTY_BIN" | tr -d ' ')
new_mtime=$(stat -f '%Sm' "$NPTY_BIN" 2>/dev/null || stat -c '%y' "$NPTY_BIN" 2>/dev/null)
ok "binary: $NPTY_BIN ($new_size bytes, mtime $new_mtime)"

echo "$ELECTRON_VERSION" > "$ABI_FILE"
ok "recorded Electron ABI → $ABI_FILE"

# ─── 5. ABI sanity check ───────────────────────────────────────────────────
# We can't fully simulate Electron's Node from a plain shell. But we can
# detect the NODE_MODULE_VERSION embedded in the .node binary by looking at
# raw bytes. Matching ABIs:
#   Node 22 (Electron 39) → NODE_MODULE_VERSION=127
#   Node 24 (system)      → NODE_MODULE_VERSION=131
h1 "ABI sanity check"
info "system node would load the binary as:"
sys_load=$(node -e "try{require('$NPTY_BIN');console.log('LOADS IN SYSTEM NODE')}catch(e){console.log('FAILS IN SYSTEM NODE:',e.message.split('\\n')[0])}" 2>&1)
info "    $sys_load"

if echo "$sys_load" | grep -q "FAILS IN SYSTEM NODE.*NODE_MODULE_VERSION"; then
  ok "binary REJECTED by system Node — this is the GOOD sign"
  info "    it means the binary's ABI doesn't match system Node 24,"
  info "    which is exactly what we want for Electron 39 (Node 22)"
elif echo "$sys_load" | grep -q "LOADS IN SYSTEM NODE"; then
  if [ "$ELECTRON_VERSION" = "39.8.5" ] || echo "$ELECTRON_VERSION" | grep -qE "^(3[0-9]|4[0-9])\."; then
    bad "binary LOADS in system Node — that's WRONG for Electron $ELECTRON_VERSION"
    warn "it means the rebuild actually targeted system Node, not Electron."
    warn "this is the bug that keeps pipe-mode warnings active. Try:"
    echo ""
    echo "    cd $INSTALL_DIR/extension"
    echo "    rm -rf node_modules/node-pty"
    echo "    npm install node-pty"
    echo "    npx @electron/rebuild --version=$ELECTRON_VERSION --which=node-pty --force"
    echo ""
    exit 1
  else
    ok "binary loads in system Node (expected for Electron versions that share Node ABI)"
  fi
else
  warn "couldn't interpret result: $sys_load"
fi

# ─── 6. Done ───────────────────────────────────────────────────────────────
h1 "Next step"
echo ""
printf "  ${C_BOLD}1. Reload VS Code${C_RESET}\n"
echo "       Cmd+Shift+P → Developer: Reload Window"
echo ""
printf "  ${C_BOLD}2. Open the Output panel${C_RESET}\n"
echo "       Cmd+Shift+U → dropdown → 'Claws'"
echo "       You should see 'activating (typescript)' with NO pipe-mode warning."
echo ""
printf "  ${C_BOLD}3. Spawn a wrapped terminal${C_RESET}\n"
echo "       + dropdown → 'Claws Wrapped Terminal'"
echo "       Should open cleanly, no '[claws] running in pipe-mode' line."
echo ""
printf "  ${C_BOLD}If it still shows pipe-mode after reload:${C_RESET}\n"
echo "       bash $INSTALL_DIR/scripts/report.sh \"\$(pwd)\""
echo "       and share the generated ~/claws-report-*.txt"
echo ""
