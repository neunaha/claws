#!/usr/bin/env bash
# Tests for M-17: inject_hook awk empty-file edge case.
# When .zshrc contains ONLY the Claws block, awk output is empty. Previously
# the [ -s "$tmp" ] guard prevented promotion, leaving the original intact and
# causing duplicate blocks on the next install. Fixed: always promote on awk exit 0.
# Run: bash extension/test/install-awk-empty.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/../../scripts/install.sh"

# ── helper: simulate inject_hook's M-17-fixed awk logic ─────────────────────
# Arguments: $1=rcfile $2=hook_marker $3=hook_source
run_inject_hook_simulation() {
  local rcfile="$1"
  local hook_marker="${2:-# CLAWS terminal hook}"
  local hook_source="${3:-source \"/fake/claws-src/scripts/shell-hook.sh\"}"
  local tmp="${rcfile}.claws-tmp.$$"

  # Backup (M-01 behavior)
  if [ -s "$rcfile" ]; then
    local _bak_ts
    _bak_ts=$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%Y%m%dT%H%M%SZ)
    cp "$rcfile" "${rcfile}.claws-bak.${_bak_ts}" 2>/dev/null || true
  fi

  # M-17: awk without [ -s "$tmp" ] guard — always promote when awk exits 0
  if awk '
    /# CLAWS terminal hook/ { skip = 1; next }
    skip { skip = 0; next }
    { print }
  ' "$rcfile" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$rcfile" 2>/dev/null || rm -f "$tmp"
  else
    rm -f "$tmp" 2>/dev/null || true
  fi

  # Append new hook block
  printf '\n%s\n%s\n' "$hook_marker" "$hook_source" >> "$rcfile" 2>/dev/null || true
}

# ── TEST 1: Claws-only .zshrc — no duplicate after re-inject ─────────────────
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m17-XXXXXX")
rcfile="$tmpdir/.zshrc"

# Write a .zshrc that contains ONLY the Claws block
cat > "$rcfile" <<'RCEOF'
# CLAWS terminal hook
source "/fake/claws-src/scripts/shell-hook.sh"
RCEOF

# Run inject twice to simulate re-install
run_inject_hook_simulation "$rcfile"
run_inject_hook_simulation "$rcfile"

# Count how many times the marker appears
marker_count=$(grep -c '# CLAWS terminal hook' "$rcfile" 2>/dev/null || echo 0)

if [ "$marker_count" -eq 1 ]; then
  pass "Claws-only .zshrc: exactly 1 CLAWS marker after double inject (no duplicate)"
else
  fail "Claws-only .zshrc: found $marker_count CLAWS markers — duplicate block created (M-17 regression)"
fi

rm -rf "$tmpdir"

# ── TEST 2: file with content + Claws block — only Claws block stripped ───────
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m17-mix-XXXXXX")
rcfile="$tmpdir/.zshrc"

cat > "$rcfile" <<'RCEOF'
export PATH="/usr/local/bin:$PATH"
export EDITOR=vim
# CLAWS terminal hook
source "/fake/claws-src/scripts/shell-hook.sh"
RCEOF

run_inject_hook_simulation "$rcfile"
run_inject_hook_simulation "$rcfile"

# Non-Claws content must survive
if grep -q 'export PATH' "$rcfile" && grep -q 'export EDITOR' "$rcfile"; then
  pass "mixed .zshrc: non-Claws content preserved after double inject"
else
  fail "mixed .zshrc: non-Claws content lost"
fi

marker_count=$(grep -c '# CLAWS terminal hook' "$rcfile" 2>/dev/null || echo 0)
if [ "$marker_count" -eq 1 ]; then
  pass "mixed .zshrc: exactly 1 CLAWS marker after double inject"
else
  fail "mixed .zshrc: found $marker_count CLAWS markers (expected 1)"
fi

rm -rf "$tmpdir"

# ── TEST 3: empty .zshrc — stays writable, block appended once ───────────────
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m17-empty-XXXXXX")
rcfile="$tmpdir/.zshrc"
touch "$rcfile"  # empty file

run_inject_hook_simulation "$rcfile"

if grep -q '# CLAWS terminal hook' "$rcfile"; then
  pass "empty .zshrc: CLAWS block appended"
else
  fail "empty .zshrc: CLAWS block not found after inject"
fi

rm -rf "$tmpdir"

# ── TEST 4: verify install.sh has M-17 fix (no [ -s "$tmp" ] guard) ──────────
if grep -q 'M-17' "$INSTALL_SH"; then
  pass "install.sh contains M-17 comment"
else
  fail "install.sh missing M-17 comment — fix not applied"
fi

# The old guarded condition must be gone; the new unconditional mv must be present.
# We check that the awk block ends with `} 2>/dev/null; then` (no -s guard)
if grep -A6 'CLAWS terminal hook.*skip = 1' "$INSTALL_SH" | grep -q '2>/dev/null; then'; then
  pass "install.sh awk: unconditional mv (M-17 guard removed)"
else
  fail "install.sh awk: still has conditional mv — M-17 not applied"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) install-awk-empty check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT install-awk-empty checks"
exit 0
