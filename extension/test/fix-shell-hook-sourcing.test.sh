#!/usr/bin/env bash
# Tests for FINDING-C-11: fix.sh must detect and auto-repair missing
# shell-hook sourcing in rc files (.zshrc, .bashrc).
# Run: bash extension/test/fix-shell-hook-sourcing.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIX_SH="$SCRIPT_DIR/../../scripts/fix.sh"

# ── TEST 1: fix.sh has a shell-hook sourcing check ───────────────────────────
if grep -q 'shell-hook.*sourc\|sourc.*shell-hook\|Shell hook.*rc\|rc.*shell.hook' "$FIX_SH" 2>/dev/null; then
  pass "fix.sh: shell-hook sourcing check present"
else
  fail "fix.sh: missing shell-hook sourcing check (FINDING-C-11)"
fi

# ── TEST 2: fix.sh scans rc files for shell-hook.sh reference ────────────────
if grep -q '\.zshrc\|\.bashrc\|shell.*rc' "$FIX_SH" 2>/dev/null; then
  pass "fix.sh: rc file scanning present (.zshrc or .bashrc)"
else
  fail "fix.sh: no rc file scanning for shell-hook.sh (FINDING-C-11)"
fi

# ── TEST 3: fix.sh appends source line when shell-hook is missing ─────────────
if grep -A10 'shell.hook.*sourc\|sourc.*shell.hook\|Shell hook.*rc' "$FIX_SH" 2>/dev/null | grep -q 'echo\|append\|>>'; then
  pass "fix.sh: shell-hook sourcing repair appends source line"
else
  fail "fix.sh: no source-line append in shell-hook sourcing repair (FINDING-C-11)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) fix-shell-hook-sourcing check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT fix-shell-hook-sourcing checks"
exit 0
