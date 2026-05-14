#!/usr/bin/env bash
# scripts/test-installer-parity.sh — parity harness: bash install.sh vs node bin/cli.js install
#
# Creates two temp project dirs, runs bash and node installers, diffs:
#   .mcp.json claws entry (normalized), CLAUDE.md CLAWS:BEGIN block,
#   .claude/settings.json hooks, .claws-bin/ file list, shell rc hook line.
# Exits 0 on zero diff, 1 otherwise with concrete diff output.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d /tmp/claws-parity-XXXXXX)"
# Use same basename so {PROJECT_NAME} matches in both CLAUDE.md blocks
A="$TMP/a/claws-parity-project"
B="$TMP/b/claws-parity-project"
SRC="$TMP/src"
HOME_A="$TMP/home-a"
HOME_B="$TMP/home-b"
trap 'rm -rf "$TMP"' EXIT
FAIL=0

_ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
_fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
_diff() { diff -u "$1" "$2" 2>/dev/null | head -30 || true; }

mkdir -p "$A" "$B" "$HOME_A/.claude" "$HOME_B/.claude"

# ── Build source clone for bash installer ─────────────────────────────────────
printf '\n[parity] cloning source for bash installer...\n'
git clone --local --no-hardlinks -q "$REPO" "$SRC"
# Pre-seed pre-built artifacts so bash skips extension build
[ -d "$REPO/extension/dist"   ] && cp -R "$REPO/extension/dist"   "$SRC/extension/"
[ -d "$REPO/extension/native" ] && cp -R "$REPO/extension/native" "$SRC/extension/"
# Align .build-sha with clone HEAD so needs_build() returns false
git -C "$SRC" rev-parse HEAD > "$SRC/extension/dist/.build-sha" 2>/dev/null || true
# Touch bundle so find -newer finds no src files newer than it
touch "$SRC/extension/dist/extension.js" 2>/dev/null || true

# ── Run bash installer ────────────────────────────────────────────────────────
printf '[parity] running bash install.sh in proj A...\n'
(
  cd "$A"
  CLAWS_DIR="$SRC" CLAWS_NO_LOG=1 CLAWS_NO_GLOBAL_HOOKS=1 \
  CLAWS_EDITOR=skip CLAWS_SKIP_EXTENSION_COPY=1 CLAWS_SKIP_VSCODE_RECOMMEND=1 \
  HOME="$HOME_A" \
  bash "$REPO/scripts/install.sh" 2>&1
) | grep -E '^\s*(✓|!|✗|\[)' | head -20 || true

# ── Run node installer ────────────────────────────────────────────────────────
printf '[parity] running node bin/cli.js install in proj B...\n'
(
  cd "$B"
  HOME="$HOME_B" \
  node "$REPO/bin/cli.js" install --no-hooks 2>&1
) | grep -E '^\s*(✓|!|\[)' | head -20 || true

# ── Compare artifacts ─────────────────────────────────────────────────────────
printf '\n[parity] comparing artifacts...\n'

# (a) .mcp.json: normalize absolute paths → relative before comparing
_norm_mcp() {
  node -e "
    const c = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
    const e = (c.mcpServers||{}).claws || {};
    const args = (e.args||[]).map(a => a.replace(/^.*\\/\\.claws-bin\\//, '.claws-bin/'));
    process.stdout.write(JSON.stringify({ command: e.command||'', args }) + '\n');
  " "$1"
}
if [ -f "$A/.mcp.json" ] && [ -f "$B/.mcp.json" ]; then
  A_MCP="$(_norm_mcp "$A/.mcp.json")"; B_MCP="$(_norm_mcp "$B/.mcp.json")"
  if [ "$A_MCP" = "$B_MCP" ]; then _ok ".mcp.json"
  else _fail ".mcp.json"; printf '    bash: %s\n    node: %s\n' "$A_MCP" "$B_MCP"; fi
else
  _fail ".mcp.json missing: bash=$( [ -f "$A/.mcp.json" ] && echo Y || echo N) node=$( [ -f "$B/.mcp.json" ] && echo Y || echo N)"
fi

# (b) CLAUDE.md CLAWS:BEGIN block (normalize project-name and cmds-list lines)
_extract_block() {
  awk '/<!-- CLAWS:BEGIN/,/<!-- CLAWS:END/{print}' "$1" 2>/dev/null \
    | grep -vE '\{PROJECT_NAME\}|claws-parity-project|^.*\bclaws-[a-z-]+\b.*$|CMDS_COUNT|CMDS_LIST|Slash commands \([0-9]+\)' \
    || true
}
if [ -f "$A/CLAUDE.md" ] && [ -f "$B/CLAUDE.md" ]; then
  BA="$(_extract_block "$A/CLAUDE.md")"; BB="$(_extract_block "$B/CLAUDE.md")"
  if [ "$BA" = "$BB" ] && [ -n "$BA" ]; then _ok "CLAUDE.md CLAWS:BEGIN block"
  else _fail "CLAUDE.md CLAWS:BEGIN block"; _diff <(echo "$BA") <(echo "$BB"); fi
else
  _fail "CLAUDE.md missing: bash=$( [ -f "$A/CLAUDE.md" ] && echo Y || echo N) node=$( [ -f "$B/CLAUDE.md" ] && echo Y || echo N)"
fi

# (c) .claude/settings.json hooks (both --no-hooks → should be absent)
_get_hooks() {
  [ -f "$1" ] && node -e "
    try{ const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
    process.stdout.write(JSON.stringify(c.hooks||{})); }catch{process.stdout.write('{}')}
  " "$1" 2>/dev/null || printf '{}'
}
HA="$(_get_hooks "$HOME_A/.claude/settings.json")"
HB="$(_get_hooks "$HOME_B/.claude/settings.json")"
if [ "$HA" = "$HB" ]; then _ok ".claude/settings.json hooks"
else _fail ".claude/settings.json hooks differ"; printf '    bash: %s\n    node: %s\n' "$HA" "$HB"; fi

# (d) .claws-bin/ file list
FILES_A="$(cd "$A" && find .claws-bin -type f 2>/dev/null | sort || true)"
FILES_B="$(cd "$B" && find .claws-bin -type f 2>/dev/null | sort || true)"
if [ "$FILES_A" = "$FILES_B" ] && [ -n "$FILES_A" ]; then _ok ".claws-bin/ file list"
else _fail ".claws-bin/ file list"; _diff <(echo "$FILES_A") <(echo "$FILES_B"); fi

# (e) Shell rc-file: both must reference shell-hook.sh
RC_A="$(grep -rh 'shell-hook\.sh' "$HOME_A"/.zshrc "$HOME_A"/.bashrc 2>/dev/null | head -1 || true)"
RC_B="$(grep -rh 'shell-hook\.sh' "$HOME_B"/.zshrc "$HOME_B"/.bashrc 2>/dev/null | head -1 || true)"
if [ -n "$RC_A" ] && [ -n "$RC_B" ]; then _ok "shell rc-file (shell-hook.sh sourced in both)"
else _fail "shell rc-file: bash='${RC_A:-MISSING}' node='${RC_B:-MISSING}'"; fi

printf '\n[parity] '
[ "$FAIL" -eq 0 ] && printf '\033[32mPASS\033[0m — all %d checks green\n' 5 || \
  printf '\033[31mFAIL\033[0m — %d check(s) failed\n' "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
