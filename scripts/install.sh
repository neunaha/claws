#!/bin/bash
# Claws — one-command installer with root-level access override
# Run: curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh | bash
# Or:  bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
#
# Environment overrides:
#   CLAWS_DIR=/custom/path    — where to clone (default: ~/.claws-src)
#   CLAWS_SKIP_MCP=1          — skip MCP auto-configure
#   CLAWS_EDITOR=cursor       — target Cursor instead of VS Code

# Never exit on errors — install as much as possible, skip what fails
set +e

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

# ─── Pre-flight: check dependencies ─────────────────────────────────────────
echo "Checking dependencies..."

# Git
if command -v git &>/dev/null; then
  echo "  ✓ git"
else
  echo "  ! git not found — install: xcode-select --install (macOS) or sudo apt install git (Linux)"
  echo "  Continuing anyway..."
fi

# Node.js — soft check (guaranteed on any machine with VS Code / Claude Code)
if command -v node &>/dev/null; then
  echo "  ✓ node ($(node --version 2>&1))"
else
  echo "  ! Node.js not found — some features (MCP server) may be limited"
  echo "  Install later: brew install node (macOS) or sudo apt install nodejs (Linux)"
fi
echo ""

# ─── Step 1: Clone or update ────────────────────────────────────────────────
if [ -d "$INSTALL_DIR" ]; then
  echo "[1/8] Updating existing install..."
  cd "$INSTALL_DIR" && git pull --quiet origin main 2>/dev/null || git pull origin main
else
  echo "[1/8] Cloning..."
  git clone --quiet "$REPO" "$INSTALL_DIR" 2>/dev/null || git clone "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ─── Step 2: Extension symlink with permission handling ─────────────────────
echo "[2/8] Installing extension to $EXT_DIR ..."
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
echo "[3/8] Setting permissions..."
chmod +x scripts/terminal-wrapper.sh scripts/install.sh scripts/test-install.sh 2>/dev/null || true
chmod +x mcp_server.js 2>/dev/null || true
echo "  ✓ Scripts executable"

# ─── Step 4: No Python required ─────────────────────────────────────────────
echo "[4/8] Checking runtime..."
echo "  ✓ No Python required — Claws uses Node.js only"

# ─── Step 5: Auto-configure MCP server ──────────────────────────────────────
MCP_PATH="$INSTALL_DIR/mcp_server.js"
if [ "${CLAWS_SKIP_MCP:-}" != "1" ]; then
  echo "[5/8] Configuring MCP server..."

  # Global Claude Code settings — auto-register claws MCP server
  CLAUDE_SETTINGS="$HOME/.claude/settings.json"
  if [ -f "$CLAUDE_SETTINGS" ]; then
    # Check if claws is already registered
    if grep -q '"claws"' "$CLAUDE_SETTINGS" 2>/dev/null; then
      echo "  ✓ MCP server already registered in $CLAUDE_SETTINGS"
    else
      # Inject claws MCP server into existing settings
      node -e "
const fs = require('fs');
try {
  const cfg = JSON.parse(fs.readFileSync('$CLAUDE_SETTINGS', 'utf8'));
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers.claws = {
    command: 'node',
    args: ['$MCP_PATH'],
    env: { CLAWS_SOCKET: '.claws/claws.sock' }
  };
  fs.writeFileSync('$CLAUDE_SETTINGS', JSON.stringify(cfg, null, 2));
  console.log('  ✓ MCP server registered globally in ~/.claude/settings.json');
} catch (e) {
  console.log('  ! Could not auto-register MCP: ' + e.message);
}
" 2>/dev/null || echo "  ! Auto-register failed — add manually (see below)"
    fi
  else
    # Create settings with just the MCP server
    mkdir -p "$HOME/.claude"
    node -e "
const fs = require('fs');
const cfg = { mcpServers: { claws: { command: 'node', args: ['$MCP_PATH'], env: { CLAWS_SOCKET: '.claws/claws.sock' } } } };
fs.writeFileSync('$HOME/.claude/settings.json', JSON.stringify(cfg, null, 2));
console.log('  ✓ Created ~/.claude/settings.json with MCP server');
" 2>/dev/null || echo "  ! Could not create settings — add MCP manually"
  fi
else
  echo "[5/8] Skipping MCP config (CLAWS_SKIP_MCP=1)"
fi

# ─── Step 6: Global Claude Code context injection ──────────────────────────
echo "[6/8] Injecting Claws into Claude Code globally..."

# Copy default behavior rule — changes Claude's terminal behavior
mkdir -p "$HOME/.claude/rules"
if [ -f "$INSTALL_DIR/rules/claws-default-behavior.md" ]; then
  cp "$INSTALL_DIR/rules/claws-default-behavior.md" "$HOME/.claude/rules/" 2>/dev/null
  echo "  ✓ Default behavior rule installed — Claude now prefers Claws terminals"
fi

# Inject Claws section into current project's CLAUDE.md (if in a project)
CLAWS_TEMPLATE="$INSTALL_DIR/templates/CLAUDE.claws.md"
if [ -f "$CLAWS_TEMPLATE" ]; then
  # Find the workspace root (look for .git or CLAUDE.md going up)
  PROJECT_ROOT=""
  _dir="$(pwd)"
  while [ "$_dir" != "/" ]; do
    if [ -d "$_dir/.git" ] || [ -f "$_dir/CLAUDE.md" ]; then
      PROJECT_ROOT="$_dir"
      break
    fi
    _dir="$(dirname "$_dir")"
  done

  if [ -n "$PROJECT_ROOT" ]; then
    CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
    if [ -f "$CLAUDE_MD" ]; then
      if grep -q "CLAWS — Terminal Orchestration Active" "$CLAUDE_MD" 2>/dev/null; then
        # Already injected — replace with latest version
        node -e "
const fs = require('fs');
let md = fs.readFileSync('$CLAUDE_MD', 'utf8');
const template = fs.readFileSync('$CLAWS_TEMPLATE', 'utf8').trim();
const pattern = /## CLAWS — Terminal Orchestration Active[\s\S]*?Type \x60\/claws-help\x60 for the full prompt guide\./;
md = md.replace(pattern, template);
fs.writeFileSync('$CLAUDE_MD', md);
console.log('  ✓ CLAUDE.md Claws section updated');
" 2>/dev/null || echo "  ✓ CLAUDE.md already has Claws section"
      else
        # Append to end
        printf "\n\n" >> "$CLAUDE_MD"
        cat "$CLAWS_TEMPLATE" >> "$CLAUDE_MD"
        echo "  ✓ CLAUDE.md injected with Claws orchestration context"
      fi
    else
      # Create new CLAUDE.md with Claws section
      cp "$CLAWS_TEMPLATE" "$CLAUDE_MD"
      echo "  ✓ Created CLAUDE.md with Claws orchestration context"
    fi
  fi
fi

# Copy orchestration engine skill
mkdir -p "$HOME/.claude/skills"
if [ -d "$INSTALL_DIR/.claude/skills/claws-orchestration-engine" ]; then
  cp -r "$INSTALL_DIR/.claude/skills/claws-orchestration-engine" "$HOME/.claude/skills/" 2>/dev/null
  echo "  ✓ Orchestration engine skill installed"
fi

# Copy prompt templates skill
if [ -d "$INSTALL_DIR/.claude/skills/prompt-templates" ]; then
  cp -r "$INSTALL_DIR/.claude/skills/prompt-templates" "$HOME/.claude/skills/claws-prompt-templates" 2>/dev/null
  echo "  ✓ Prompt templates installed"
fi

# Copy slash commands
mkdir -p "$HOME/.claude/commands"
for cmd in claws claws-do claws-go claws-watch claws-learn claws-setup claws-cleanup claws-help claws-status claws-connect claws-create claws-send claws-exec claws-read claws-worker claws-fleet claws-update; do
  if [ -f "$INSTALL_DIR/.claude/commands/${cmd}.md" ]; then
    cp "$INSTALL_DIR/.claude/commands/${cmd}.md" "$HOME/.claude/commands/" 2>/dev/null
  fi
done
# Always install claws-install command
cat > "$HOME/.claude/commands/claws-install.md" << 'CLAWSCMD'
---
name: claws-install
description: Install or update Claws — Terminal Control Bridge for VS Code. One command gives you multi-terminal orchestration with 8 native MCP tools.
---

# /claws-install

Install or update Claws from https://github.com/neunaha/claws

## What to do

Run this bash command:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
```

After the script completes, tell the user to reload VS Code: Cmd+Shift+P → Developer: Reload Window.
CLAWSCMD
echo "  ✓ Slash commands installed (/claws-install, /claws-update, /claws-status, /claws-worker, /claws-fleet, ...)"
echo "  ✓ Every Claude Code session now has full Claws context + tools + commands"

# ─── Step 7: Shell hook injection ───────────────────────────────────────────
echo "[7/8] Injecting shell hook..."
HOOK_SOURCE="source \"$INSTALL_DIR/scripts/shell-hook.sh\""
HOOK_MARKER="# CLAWS terminal hook"

inject_hook() {
  local rcfile="$1"
  # Create the file if it doesn't exist — this is the bug fix
  touch "$rcfile" 2>/dev/null
  if grep -q "CLAWS terminal hook" "$rcfile" 2>/dev/null; then
    echo "  ✓ Shell hook already in $(basename $rcfile)"
  else
    printf "\n%s\n%s\n" "$HOOK_MARKER" "$HOOK_SOURCE" >> "$rcfile" 2>/dev/null
    if [ $? -eq 0 ]; then
      echo "  ✓ Shell hook added to $(basename $rcfile)"
    else
      echo "  ! Could not write to $rcfile"
    fi
  fi
}

# Aggressively inject into ALL possible rc files
# The user's actual shell will source the right one

# zsh (default on macOS)
inject_hook "$HOME/.zshrc"

# bash
inject_hook "$HOME/.bashrc"

# macOS bash login shell
if [ "$(uname)" = "Darwin" ]; then
  inject_hook "$HOME/.bash_profile"
fi

# fish (if installed)
if [ -d "$HOME/.config/fish" ]; then
  FISH_CONF="$HOME/.config/fish/conf.d/claws.fish"
  if [ ! -f "$FISH_CONF" ]; then
    mkdir -p "$HOME/.config/fish/conf.d" 2>/dev/null
    echo "# CLAWS terminal hook" > "$FISH_CONF"
    echo "if status is-interactive" >> "$FISH_CONF"
    echo "  source $INSTALL_DIR/scripts/shell-hook.sh" >> "$FISH_CONF"
    echo "end" >> "$FISH_CONF"
    echo "  ✓ Shell hook added to fish"
  fi
fi

# ─── Step 8: Verify ────────────────────────────────────────────────────────
echo "[8/8] Verifying..."
CHECKS=0
[ -L "$EXT_LINK" ] && CHECKS=$((CHECKS+1)) && echo "  ✓ Extension symlink"
[ -x "scripts/terminal-wrapper.sh" ] && CHECKS=$((CHECKS+1)) && echo "  ✓ Wrapper executable"
[ -f "$MCP_PATH" ] && CHECKS=$((CHECKS+1)) && echo "  ✓ MCP server exists"
command -v node &>/dev/null && CHECKS=$((CHECKS+1)) && echo "  ✓ Node.js available"

echo ""
echo "  ✓ All $CHECKS checks passed"
echo ""

# ─── Activate immediately — transform THIS terminal right now ───────────────
echo "  Activating Claws in this terminal..."
echo ""
source "$INSTALL_DIR/scripts/shell-hook.sh"

echo ""
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │                                                             │"
echo "  │  Claws is live. Your terminal has changed.                  │"
echo "  │                                                             │"
echo "  │  Try these right now:                                       │"
echo "  │    claws-ls              list all VS Code terminals         │"
echo "  │    claws-new worker-1    create a wrapped terminal          │"
echo "  │    claws-log 2           read terminal 2's output           │"
echo "  │                                                             │"
echo "  │  Reload VS Code to activate the extension:                  │"
echo "  │    Cmd+Shift+P → 'Developer: Reload Window'                │"
echo "  │                                                             │"
echo "  │  Every new terminal will show the Claws banner.             │"
echo "  │  Every Claude Code session has 8 terminal control tools.    │"
echo "  │                                                             │"
echo "  │  Update anytime:  /claws-update  or re-run this script      │"
echo "  │                                                             │"
echo "  │  Docs:    https://github.com/neunaha/claws                  │"
echo "  │  Website: https://neunaha.github.io/claws/                  │"
echo "  │                                                             │"
echo "  └─────────────────────────────────────────────────────────────┘"
echo ""
