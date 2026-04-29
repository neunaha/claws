#!/usr/bin/env bash
# Tests for M-01+F4: inject_hook awk ONLY strips Claws-marked lines, not generic
# source .../shell-hook.sh lines from other tools. Also verifies backup creation
# and the F4 orphaned-marker edge case (user content after bare marker preserved).
# Run: bash extension/test/install-awk-anchor.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/../../scripts/install.sh"

# ── helper: run the M-01+F4-fixed awk logic in isolation ────────────────────
# Mirrors inject_hook's awk call + mv logic exactly.
# F4: only skip the line after the marker if it is the Claws source line;
# otherwise keep the user content (orphaned-marker edge case).
run_awk_strip() {
  local rcfile="$1"
  local tmp="${rcfile}.claws-tmp.$$"
  if awk '
    /# CLAWS terminal hook/ { skip = 1; next }
    skip && /source.*shell-hook\.sh/ { skip = 0; next }
    skip { skip = 0; print }
    { print }
  ' "$rcfile" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$rcfile" 2>/dev/null || rm -f "$tmp"
  else
    rm -f "$tmp" 2>/dev/null || true
  fi
}

# ── TEST 1: non-Claws source line preserved ──────────────────────────────────
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m01-XXXXXX")
rcfile="$tmpdir/.zshrc"

cat > "$rcfile" <<'RCEOF'
# Other tool hook — must NOT be stripped
source "/usr/local/share/some-other-tool/shell-hook.sh"
export PATH="/usr/local/bin:$PATH"
# CLAWS terminal hook
source "/home/user/.claws-src/scripts/shell-hook.sh"
RCEOF

run_awk_strip "$rcfile"

if grep -q 'some-other-tool/shell-hook.sh' "$rcfile"; then
  pass "non-Claws source line preserved after awk strip"
else
  fail "non-Claws source line was incorrectly stripped (M-01 regression)"
fi

if grep -q 'CLAWS terminal hook' "$rcfile"; then
  fail "Claws marker line not stripped (should be gone)"
else
  pass "Claws marker line stripped"
fi

if grep -q '/claws-src/scripts/shell-hook.sh' "$rcfile"; then
  fail "Claws source line not stripped (should be gone)"
else
  pass "Claws source line stripped"
fi

if grep -q 'export PATH' "$rcfile"; then
  pass "non-Claws PATH export preserved"
else
  fail "non-Claws PATH export was incorrectly stripped"
fi

rm -rf "$tmpdir"

# ── TEST 2: backup created before modification ────────────────────────────────
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m01-bak-XXXXXX")
rcfile="$tmpdir/.zshrc"

cat > "$rcfile" <<'RCEOF'
# My zshrc
export EDITOR=vim
# CLAWS terminal hook
source "/home/user/.claws-src/scripts/shell-hook.sh"
RCEOF

original_content=$(cat "$rcfile")

# Simulate inject_hook's backup creation
_bak_ts=$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%Y%m%dT%H%M%SZ)
if [ -s "$rcfile" ]; then
  cp "$rcfile" "${rcfile}.claws-bak.${_bak_ts}" 2>/dev/null || true
fi

run_awk_strip "$rcfile"

# Backup must exist
bak_file=$(ls "${rcfile}".claws-bak.* 2>/dev/null | head -1)
if [ -n "$bak_file" ] && [ -f "$bak_file" ]; then
  pass "backup file created with claws-bak timestamp"
else
  fail "backup file not created before modification"
fi

# Backup must contain original content
if [ -n "$bak_file" ]; then
  bak_content=$(cat "$bak_file")
  if [ "$bak_content" = "$original_content" ]; then
    pass "backup content matches original dotfile"
  else
    fail "backup content does not match original"
  fi
fi

rm -rf "$tmpdir"

# ── TEST 3: asdf + oh-my-zsh style hooks preserved ───────────────────────────
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m01-asdf-XXXXXX")
rcfile="$tmpdir/.zshrc"

cat > "$rcfile" <<'RCEOF'
# asdf version manager
source "$HOME/.asdf/asdf.sh"
source "$HOME/.asdf/completions/asdf.bash"
# oh-my-zsh
source $ZSH/oh-my-zsh.sh
# Some custom shell-hook.sh from another tool
source "$HOME/.dotfiles/scripts/shell-hook.sh"
# CLAWS terminal hook
source "/Users/user/.claws-src/scripts/shell-hook.sh"
export NVM_DIR="$HOME/.nvm"
RCEOF

run_awk_strip "$rcfile"

if grep -q 'asdf.sh' "$rcfile"; then
  pass "asdf hook preserved"
else
  fail "asdf hook incorrectly stripped"
fi

if grep -q 'oh-my-zsh.sh' "$rcfile"; then
  pass "oh-my-zsh hook preserved"
else
  fail "oh-my-zsh hook incorrectly stripped"
fi

if grep -q '.dotfiles/scripts/shell-hook.sh' "$rcfile"; then
  pass "custom dotfiles shell-hook.sh preserved"
else
  fail "custom dotfiles shell-hook.sh incorrectly stripped (M-01 data loss)"
fi

if grep -q 'NVM_DIR' "$rcfile"; then
  pass "NVM_DIR export preserved"
else
  fail "NVM_DIR export incorrectly stripped"
fi

if grep -q 'CLAWS terminal hook' "$rcfile"; then
  fail "Claws marker not stripped in mixed .zshrc"
else
  pass "Claws marker stripped in mixed .zshrc"
fi

if grep -q '/claws-src/scripts/shell-hook.sh' "$rcfile"; then
  fail "Claws source line not stripped in mixed .zshrc"
else
  pass "Claws source line stripped in mixed .zshrc"
fi

rm -rf "$tmpdir"

# ── TEST 4: verify install.sh removed the generic source regex (M-01+F4) ──────
if grep -q 'M-01' "$INSTALL_SH"; then
  pass "install.sh contains M-01 comment"
else
  fail "install.sh missing M-01 comment — fix not applied"
fi

# The old unguarded top-level awk pattern /source.*shell-hook/ must not appear.
# An awk top-level pattern starts with /.../ at the beginning of a line.
# F4 correctly guards it as: skip && /source.*shell-hook/
if grep -Eq '^\s*/source.*shell-hook' "$INSTALL_SH"; then
  fail "install.sh has unguarded top-level awk pattern /source.*shell-hook/ (M-01 regression)"
else
  pass "install.sh awk: no unguarded /source.*shell-hook/ top-level pattern"
fi

# Backup creation code must exist
if grep -q 'claws-bak' "$INSTALL_SH" && grep -q 'date -u +%Y%m%dT%H%M%SZ' "$INSTALL_SH"; then
  pass "install.sh inject_hook creates timestamped backup"
else
  fail "install.sh missing dotfile backup logic"
fi

# F4: install.sh must use the orphaned-marker-safe awk pattern (3 rules, not 2)
if grep -q 'skip && /source.*shell-hook' "$INSTALL_SH"; then
  pass "install.sh awk: F4 orphaned-marker guard present (skip && /source.*shell-hook/)"
else
  fail "install.sh awk: F4 orphaned-marker guard missing — user content after bare marker gets stripped"
fi

rm -rf "$tmpdir" 2>/dev/null || true

# ── TEST 5: F4 — orphaned marker (no following source line) preserves next line
# Scenario: user manually deleted the source line but left the marker.
# The old awk would silently strip the next line (e.g., NVM_DIR export).
# The F4 fix must preserve it.
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m01-orphan-XXXXXX")
rcfile="$tmpdir/.zshrc"

cat > "$rcfile" <<'RCEOF'
export EDITOR=vim
# CLAWS terminal hook
export NVM_DIR="$HOME/.nvm"
export ANOTHER_VAR=foo
RCEOF

run_awk_strip "$rcfile"

if grep -q 'NVM_DIR' "$rcfile"; then
  pass "F4 orphaned-marker: user content after bare marker preserved (NVM_DIR not stripped)"
else
  fail "F4 orphaned-marker: user content after bare marker was stripped (data loss)"
fi

if grep -q 'ANOTHER_VAR' "$rcfile"; then
  pass "F4 orphaned-marker: content beyond orphaned block preserved"
else
  fail "F4 orphaned-marker: content beyond orphaned block was lost"
fi

if grep -q 'CLAWS terminal hook' "$rcfile"; then
  fail "F4 orphaned-marker: bare marker not stripped (should be removed)"
else
  pass "F4 orphaned-marker: bare marker stripped"
fi

if grep -q 'EDITOR=vim' "$rcfile"; then
  pass "F4 orphaned-marker: content before marker preserved"
else
  fail "F4 orphaned-marker: content before marker was stripped"
fi

rm -rf "$tmpdir"

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) install-awk-anchor check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT install-awk-anchor checks (M-01 anchor + F4 orphaned-marker)"
exit 0
