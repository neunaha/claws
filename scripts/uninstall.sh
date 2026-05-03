#!/usr/bin/env bash
# Claws — uninstall script
# Removes all Claws artifacts from the current project and the user's shell config.
# Idempotent: re-running is safe even if some components were already removed.
#
# Usage (from your project root or any directory):
#   bash ~/.claws-src/scripts/uninstall.sh
#   bash /path/to/claws/scripts/uninstall.sh
#
# What is NOT removed automatically (requires manual steps):
#   - The VS Code extension — run: code --uninstall-extension neunaha.claws
#   - The Claws source repo (~/.claws-src) — remove manually if desired: rm -rf ~/.claws-src

set -eo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'
  C_BLUE='\033[0;34m'; C_GREEN='\033[0;32m'; C_YELLOW='\033[0;33m'; C_RED='\033[0;31m'; C_DIM='\033[2m'
else
  C_RESET=''; C_BOLD=''; C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''
fi

ok()   { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn() { printf "  ${C_YELLOW}!${C_RESET} %s\n" "$*"; }
info() { printf "  ${C_DIM}%s${C_RESET}\n" "$*"; }
step() { printf "\n${C_BOLD}${C_BLUE}%s${C_RESET}\n" "$*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="${PWD}"

echo ""
printf "${C_BOLD}${C_BLUE}Claws Uninstaller${C_RESET}\n"
printf "${C_DIM}Project root: %s${C_RESET}\n" "$PROJECT_ROOT"
printf "${C_DIM}Claws source: %s${C_RESET}\n" "$INSTALL_DIR"
echo ""

# ── Step 1: Deregister lifecycle hooks from ~/.claude/settings.json ──────────
step "[1/5] Removing lifecycle hooks from ~/.claude/settings.json"
HOOKS_SCRIPT="$INSTALL_DIR/scripts/inject-settings-hooks.js"
if [ -f "$HOOKS_SCRIPT" ]; then
  if node "$HOOKS_SCRIPT" --remove 2>/dev/null; then
    ok "hooks deregistered"
  else
    warn "hook removal returned non-zero — hooks may already be absent"
  fi
else
  warn "inject-settings-hooks.js not found at $HOOKS_SCRIPT — skipping hook removal"
fi

# ── Step 2: Strip CLAWS:BEGIN/END blocks from CLAUDE.md files ────────────────
step "[2/5] Stripping CLAWS:BEGIN blocks from CLAUDE.md files"

strip_claws_block() {
  local file="$1"
  if [ ! -f "$file" ]; then
    info "not found: $file — skipping"
    return
  fi
  if ! grep -q "CLAWS:BEGIN" "$file" 2>/dev/null; then
    info "no CLAWS:BEGIN block in $file — nothing to strip"
    return
  fi
  local tmp
  tmp=$(mktemp)
  awk '/# CLAWS:BEGIN/,/# CLAWS:END/{next} {print}' "$file" > "$tmp" && mv "$tmp" "$file"
  ok "stripped CLAWS:BEGIN block from $file"
}

strip_claws_block "$PROJECT_ROOT/CLAUDE.md"
strip_claws_block "$HOME/.claude/CLAUDE.md"

# ── Step 3: Remove shell hook source line from rc files ──────────────────────
step "[3/5] Removing shell hook from rc files"

remove_hook_from_rc() {
  local rcfile="$1"
  if [ ! -f "$rcfile" ]; then
    return
  fi
  if ! grep -q "CLAWS terminal hook\|shell-hook\.sh" "$rcfile" 2>/dev/null; then
    return
  fi
  local tmp
  tmp=$(mktemp)
  awk '
    /# CLAWS terminal hook/ { skip=1; next }
    skip && /shell-hook\.sh/ { skip=0; next }
    skip { skip=0; print }
    { print }
  ' "$rcfile" > "$tmp" && mv "$tmp" "$rcfile"
  ok "removed Claws hook from $rcfile"
}

remove_hook_from_rc "$HOME/.zshrc"
remove_hook_from_rc "$HOME/.bashrc"
remove_hook_from_rc "$HOME/.bash_profile"

FISH_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/claws.fish"
if [ -f "$FISH_CONF" ]; then
  rm -f "$FISH_CONF"
  ok "removed $FISH_CONF"
fi

NUSHELL_ENV="${XDG_CONFIG_HOME:-$HOME/.config}/nushell/env.nu"
if [ -f "$NUSHELL_ENV" ] && grep -q "CLAWS_DIR\|claws" "$NUSHELL_ENV" 2>/dev/null; then
  _nu_tmp=$(mktemp)
  grep -v "CLAWS_DIR\|claws" "$NUSHELL_ENV" > "$_nu_tmp" && mv "$_nu_tmp" "$NUSHELL_ENV"
  ok "removed Claws lines from $NUSHELL_ENV"
fi

# ── Step 4: Remove project-local Claws directories ───────────────────────────
step "[4/5] Removing .claws-bin/ and .claws/ from project root"

if [ -d "$PROJECT_ROOT/.claws-bin" ]; then
  rm -rf "$PROJECT_ROOT/.claws-bin"
  ok "removed $PROJECT_ROOT/.claws-bin"
else
  info ".claws-bin/ not found — already removed"
fi

if [ -d "$PROJECT_ROOT/.claws" ]; then
  rm -rf "$PROJECT_ROOT/.claws"
  ok "removed $PROJECT_ROOT/.claws"
else
  info ".claws/ not found — already removed"
fi

# ── Step 5: Manual step — uninstall VS Code extension ────────────────────────
step "[5/5] VS Code extension (manual step required)"
echo ""
printf "  Run this command to uninstall the Claws VS Code extension:\n\n"
printf "    ${C_BOLD}code --uninstall-extension neunaha.claws${C_RESET}\n\n"
printf "  (If you use Cursor: ${C_BOLD}cursor --uninstall-extension neunaha.claws${C_RESET})\n"
printf "  (If you use Windsurf: ${C_BOLD}windsurf --uninstall-extension neunaha.claws${C_RESET})\n\n"

echo ""
ok "Claws uninstall complete."
info "You may also remove the source repo: rm -rf $INSTALL_DIR"
echo ""
