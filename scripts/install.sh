#!/bin/bash
# Claws — one-command installer with root-level access override
# Run: curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh | bash
# Or:  bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
#
# Environment overrides:
#   CLAWS_DIR=/custom/path    — where to clone (default: ~/.claws-src)
#   CLAWS_SUDO=1              — force sudo for pip install
#   CLAWS_SKIP_PIP=1          — skip Python client install
#   CLAWS_SKIP_MCP=1          — skip MCP auto-configure
#   CLAWS_EDITOR=cursor       — target Cursor instead of VS Code

set -e

REPO="https://github.com/neunaha/claws.git"
INSTALL_DIR="${CLAWS_DIR:-$HOME/.claws-src}"

# Detect editor — VS Code, VS Code Insiders, Cursor, Windsurf
detect_ext_dir() {
  local editor="${CLAWS_EDITOR:-auto}"
  if [ "$editor" = "auto" ]; then
    # Check which editors exist
    if [ -d "$HOME/.vscode/extensions" ]; then
      echo "$HOME/.vscode/extensions"
    elif [ -d "$HOME/.vscode-insiders/extensions" ]; then
      echo "$HOME/.vscode-insiders/extensions"
    elif [ -d "$HOME/.cursor/extensions" ]; then
      echo "$HOME/.cursor/extensions"
    elif [ -d "$HOME/.windsurf/extensions" ]; then
      echo "$HOME/.windsurf/extensions"
    else
      # Create VS Code default
      mkdir -p "$HOME/.vscode/extensions"
      echo "$HOME/.vscode/extensions"
    fi
  elif [ "$editor" = "cursor" ]; then
    mkdir -p "$HOME/.cursor/extensions"
    echo "$HOME/.cursor/extensions"
  elif [ "$editor" = "insiders" ]; then
    mkdir -p "$HOME/.vscode-insiders/extensions"
    echo "$HOME/.vscode-insiders/extensions"
  elif [ "$editor" = "windsurf" ]; then
    mkdir -p "$HOME/.windsurf/extensions"
    echo "$HOME/.windsurf/extensions"
  else
    mkdir -p "$HOME/.vscode/extensions"
    echo "$HOME/.vscode/extensions"
  fi
}

EXT_DIR=$(detect_ext_dir)
EXT_LINK="$EXT_DIR/neunaha.claws-0.1.0"

echo ""
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║                                           ║"
echo "  ║   CLAWS — Terminal Control Bridge         ║"
echo "  ║   Your terminals are now programmable.    ║"
echo "  ║                                           ║"
echo "  ╚═══════════════════════════════════════════╝"
echo ""

# ─── Step 1: Clone or update ────────────────────────────────────────────────
if [ -d "$INSTALL_DIR" ]; then
  echo "[1/6] Updating existing install..."
  cd "$INSTALL_DIR" && git pull --quiet origin main 2>/dev/null || git pull origin main
else
  echo "[1/6] Cloning..."
  git clone --quiet "$REPO" "$INSTALL_DIR" 2>/dev/null || git clone "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ─── Step 2: Extension symlink with permission handling ─────────────────────
echo "[2/6] Installing extension to $EXT_DIR ..."
# Remove stale links (any version)
rm -f "$EXT_DIR"/neunaha.claws-* 2>/dev/null || sudo rm -f "$EXT_DIR"/neunaha.claws-* 2>/dev/null || true
# Create symlink — try without sudo first, fall back to sudo
if ln -sf "$INSTALL_DIR/extension" "$EXT_LINK" 2>/dev/null; then
  echo "  ✓ Extension symlinked"
elif sudo ln -sf "$INSTALL_DIR/extension" "$EXT_LINK" 2>/dev/null; then
  echo "  ✓ Extension symlinked (sudo)"
else
  echo "  ✗ Could not symlink extension. Manually run:"
  echo "    ln -s $INSTALL_DIR/extension $EXT_LINK"
fi

# ─── Step 3: Executable permissions ─────────────────────────────────────────
echo "[3/6] Setting permissions..."
chmod +x scripts/terminal-wrapper.sh scripts/install.sh scripts/test-install.sh 2>/dev/null || true
chmod +x mcp_server.py 2>/dev/null || true
echo "  ✓ Scripts executable"

# ─── Step 4: Python client ──────────────────────────────────────────────────
if [ "${CLAWS_SKIP_PIP:-}" != "1" ]; then
  echo "[4/6] Installing Python client..."
  PIP_CMD=""
  if command -v pip3 &>/dev/null; then PIP_CMD="pip3"
  elif command -v pip &>/dev/null; then PIP_CMD="pip"
  fi

  if [ -n "$PIP_CMD" ]; then
    if [ "${CLAWS_SUDO:-}" = "1" ]; then
      sudo $PIP_CMD install -e clients/python --quiet 2>/dev/null && echo "  ✓ Python client installed (sudo)" || echo "  ! pip install failed with sudo"
    else
      # Try user install first, then system, then sudo
      $PIP_CMD install -e clients/python --quiet 2>/dev/null \
        || $PIP_CMD install -e clients/python --user --quiet 2>/dev/null \
        || sudo $PIP_CMD install -e clients/python --quiet 2>/dev/null \
        || echo "  ! pip install failed — try: sudo pip3 install -e $INSTALL_DIR/clients/python"
      echo "  ✓ Python client installed"
    fi
  else
    echo "  (skipped — pip not found)"
  fi
else
  echo "[4/6] Skipping Python client (CLAWS_SKIP_PIP=1)"
fi

# ─── Step 5: Auto-configure MCP server ──────────────────────────────────────
MCP_PATH="$INSTALL_DIR/mcp_server.py"
if [ "${CLAWS_SKIP_MCP:-}" != "1" ]; then
  echo "[5/6] Configuring MCP server..."

  # Global Claude Code settings — auto-register claws MCP server
  CLAUDE_SETTINGS="$HOME/.claude/settings.json"
  if [ -f "$CLAUDE_SETTINGS" ]; then
    # Check if claws is already registered
    if grep -q '"claws"' "$CLAUDE_SETTINGS" 2>/dev/null; then
      echo "  ✓ MCP server already registered in $CLAUDE_SETTINGS"
    else
      # Inject claws MCP server into existing settings
      python3 -c "
import json, sys
try:
    with open('$CLAUDE_SETTINGS') as f:
        cfg = json.load(f)
    if 'mcpServers' not in cfg:
        cfg['mcpServers'] = {}
    cfg['mcpServers']['claws'] = {
        'command': 'python3',
        'args': ['$MCP_PATH'],
        'env': {'CLAWS_SOCKET': '.claws/claws.sock'}
    }
    with open('$CLAUDE_SETTINGS', 'w') as f:
        json.dump(cfg, f, indent=2)
    print('  ✓ MCP server registered globally in ~/.claude/settings.json')
except Exception as e:
    print(f'  ! Could not auto-register MCP: {e}')
    print(f'  Add manually to {sys.argv[0]}')
" 2>/dev/null || echo "  ! Auto-register failed — add manually (see below)"
    fi
  else
    # Create settings with just the MCP server
    mkdir -p "$HOME/.claude"
    python3 -c "
import json
cfg = {'mcpServers': {'claws': {'command': 'python3', 'args': ['$MCP_PATH'], 'env': {'CLAWS_SOCKET': '.claws/claws.sock'}}}}
with open('$HOME/.claude/settings.json', 'w') as f:
    json.dump(cfg, f, indent=2)
print('  ✓ Created ~/.claude/settings.json with MCP server')
" 2>/dev/null || echo "  ! Could not create settings — add MCP manually"
  fi
else
  echo "[5/6] Skipping MCP config (CLAWS_SKIP_MCP=1)"
fi

# ─── Step 6: Shell hook injection ───────────────────────────────────────────
echo "[6/7] Injecting shell hook..."
HOOK_SOURCE="source \"$INSTALL_DIR/scripts/shell-hook.sh\""
HOOK_MARKER="# CLAWS terminal hook"

inject_hook() {
  local rcfile="$1"
  if [ -f "$rcfile" ]; then
    if grep -q "CLAWS terminal hook" "$rcfile" 2>/dev/null; then
      echo "  ✓ Shell hook already in $rcfile"
    else
      printf "\n%s\n%s\n" "$HOOK_MARKER" "$HOOK_SOURCE" >> "$rcfile"
      echo "  ✓ Shell hook added to $rcfile"
    fi
  fi
}

# Detect shell and inject
if [ -n "${ZSH_VERSION:-}" ] || [ -f "$HOME/.zshrc" ]; then
  inject_hook "$HOME/.zshrc"
fi
if [ -n "${BASH_VERSION:-}" ] || [ -f "$HOME/.bashrc" ]; then
  inject_hook "$HOME/.bashrc"
fi
# Also try .bash_profile for macOS login shells
if [ -f "$HOME/.bash_profile" ] && ! [ -f "$HOME/.bashrc" ]; then
  inject_hook "$HOME/.bash_profile"
fi

# ─── Step 7: Verify ────────────────────────────────────────────────────────
echo "[7/7] Verifying..."
CHECKS=0
[ -L "$EXT_LINK" ] && CHECKS=$((CHECKS+1)) && echo "  ✓ Extension symlink"
[ -x "scripts/terminal-wrapper.sh" ] && CHECKS=$((CHECKS+1)) && echo "  ✓ Wrapper executable"
python3 -c "from claws import ClawsClient" 2>/dev/null && CHECKS=$((CHECKS+1)) && echo "  ✓ Python client importable"
[ -f "$MCP_PATH" ] && CHECKS=$((CHECKS+1)) && echo "  ✓ MCP server exists"

echo ""
echo "  ╔═══════════════════════════════════════════════════════════╗"
echo "  ║                                                           ║"
echo "  ║   CLAWS INSTALLED — $CHECKS/4 checks passed                       ║"
echo "  ║                                                           ║"
echo "  ║   Extension: $EXT_LINK"
echo "  ║   MCP server: $MCP_PATH"
echo "  ║                                                           ║"
echo "  ║   NEXT:                                                   ║"
echo "  ║   1. Reload VS Code (Cmd+Shift+P → Reload Window)        ║"
echo "  ║   2. Open a Claws terminal from the dropdown              ║"
echo "  ║   3. Every Claude Code session now has terminal control   ║"
echo "  ║                                                           ║"
echo "  ║   Test: bash $INSTALL_DIR/scripts/test-install.sh"
echo "  ║                                                           ║"
echo "  ╚═══════════════════════════════════════════════════════════╝"
echo ""
echo "  Docs:    https://github.com/neunaha/claws"
echo "  Website: https://neunaha.github.io/claws/"
echo ""
