#!/usr/bin/env bash
# Tests for FINDING-C-4: fix.sh must detect multiple neunaha.claws-* dirs
# in the same editor extensions folder and warn about load-order conflict.
# Run: bash extension/test/fix-multiple-ext-dirs.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIX_SH="$SCRIPT_DIR/../../scripts/fix.sh"

# ── TEST 1: fix.sh no longer uses head -1 to truncate extension dir listing ──
# The old: ls -d "$dir"/neunaha.claws-* 2>/dev/null | head -1
if grep -q '| head -1 | xargs basename' "$FIX_SH" 2>/dev/null; then
  fail "fix.sh: still uses 'head -1' to mask multiple extension dirs (FINDING-C-4 not fixed)"
else
  pass "fix.sh: head -1 pattern removed from extension dir scan"
fi

# ── TEST 2: fix.sh iterates all neunaha.claws-* entries ──────────────────────
if grep -A3 'FOUND_INSTALLS' "$FIX_SH" 2>/dev/null | grep -q 'for inst'; then
  pass "fix.sh: iterates all extension dir entries with a for loop"
else
  fail "fix.sh: no 'for inst' loop found in FOUND_INSTALLS section (FINDING-C-4)"
fi

# ── TEST 3: fix.sh detects DUPLICATE extensions in same editor dir ────────────
if grep -q 'DUPLICATE extensions' "$FIX_SH" 2>/dev/null; then
  pass "fix.sh: DUPLICATE extensions warning present"
else
  fail "fix.sh: no DUPLICATE extensions detection (FINDING-C-4)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) fix-multiple-ext-dirs check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT fix-multiple-ext-dirs checks"
exit 0
