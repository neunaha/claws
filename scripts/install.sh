#!/bin/bash
# Claws — one-command installer
# Run: curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh | bash
# Or:  bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)

set -e

REPO="https://github.com/neunaha/claws.git"
INSTALL_DIR="${CLAWS_DIR:-$HOME/.claws-src}"
EXT_LINK="$HOME/.vscode/extensions/neunaha.claws-0.1.0"

echo ""
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║                                           ║"
echo "  ║   CLAWS — Terminal Control Bridge         ║"
echo "  ║   Your terminals are now programmable.    ║"
echo "  ║                                           ║"
echo "  ╚═══════════════════════════════════════════╝"
echo ""

# Step 1: Clone
if [ -d "$INSTALL_DIR" ]; then
  echo "[1/5] Updating existing install..."
  cd "$INSTALL_DIR" && git pull --quiet origin main
else
  echo "[1/5] Cloning..."
  git clone --quiet "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# Step 2: Symlink extension
echo "[2/5] Installing VS Code extension..."
rm -f "$EXT_LINK"
ln -s "$INSTALL_DIR/extension" "$EXT_LINK"

# Step 3: Make wrapper executable
echo "[3/5] Setting up terminal wrapper..."
chmod +x scripts/terminal-wrapper.sh

# Step 4: Install Python client
echo "[4/5] Installing Python client..."
if command -v pip3 &>/dev/null; then
  pip3 install -e clients/python --quiet 2>/dev/null || pip3 install -e clients/python 2>&1 | tail -1
elif command -v pip &>/dev/null; then
  pip install -e clients/python --quiet 2>/dev/null || pip install -e clients/python 2>&1 | tail -1
else
  echo "  (skipped — pip not found. install manually: pip install -e $INSTALL_DIR/clients/python)"
fi

# Step 5: MCP server hint
echo "[5/5] Setting up MCP server path..."
MCP_PATH="$INSTALL_DIR/mcp_server.py"
echo ""
echo "  ✓ Extension installed at: $EXT_LINK"
echo "  ✓ Python client: from claws import ClawsClient"
echo "  ✓ MCP server at: $MCP_PATH"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │ NEXT STEPS                                                  │"
echo "  │                                                             │"
echo "  │ 1. Reload VS Code:                                         │"
echo "  │    Cmd+Shift+P → 'Developer: Reload Window'                │"
echo "  │                                                             │"
echo "  │ 2. Open a Claws terminal:                                   │"
echo "  │    Terminal dropdown (▾ next to +) → 'Claws Wrapped Terminal│"
echo "  │                                                             │"
echo "  │ 3. Add MCP server to any project (.claude/settings.json):   │"
echo "  │    \"mcpServers\": {                                          │"
echo "  │      \"claws\": {                                             │"
echo "  │        \"command\": \"python3\",                                │"
echo "  │        \"args\": [\"$MCP_PATH\"]                                │"
echo "  │      }                                                      │"
echo "  │    }                                                        │"
echo "  │                                                             │"
echo "  │ 4. Test it:                                                 │"
echo "  │    echo '{\"id\":1,\"cmd\":\"list\"}' | nc -U .claws/claws.sock  │"
echo "  │                                                             │"
echo "  └─────────────────────────────────────────────────────────────┘"
echo ""
echo "  Docs:    https://github.com/neunaha/claws"
echo "  Website: https://neunaha.github.io/claws/"
echo ""
