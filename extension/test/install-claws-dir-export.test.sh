#!/usr/bin/env bash
# Tests for FINDING-A-2: slash commands must use $CLAWS_DIR (or fallback) instead
# of hardcoded ~/.claws-src so that a CLAWS_DIR override works correctly.
# Run: bash extension/test/install-claws-dir-export.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/../.."
FIX_CMD="$REPO_ROOT/.claude/commands/claws-fix.md"
UPDATE_CMD="$REPO_ROOT/.claude/commands/claws-update.md"

# ── TEST 1: claws-fix.md uses CLAWS_DIR variable (not hardcoded ~/.claws-src) ─
if grep -q 'CLAWS_DIR\|claws-src.*CLAWS_DIR\|\${CLAWS_DIR' "$FIX_CMD" 2>/dev/null; then
  pass "claws-fix.md: uses CLAWS_DIR variable"
elif grep -q '~/.claws-src' "$FIX_CMD" 2>/dev/null; then
  fail "claws-fix.md: still hardcodes ~/.claws-src (FINDING-A-2)"
else
  fail "claws-fix.md: cannot determine if CLAWS_DIR is used"
fi

# ── TEST 2: claws-update.md uses CLAWS_DIR variable ───────────────────────────
if grep -q 'CLAWS_DIR\|\${CLAWS_DIR' "$UPDATE_CMD" 2>/dev/null; then
  pass "claws-update.md: uses CLAWS_DIR variable"
elif grep -q '~/.claws-src' "$UPDATE_CMD" 2>/dev/null; then
  fail "claws-update.md: still hardcodes ~/.claws-src (FINDING-A-2)"
else
  fail "claws-update.md: cannot determine if CLAWS_DIR is used"
fi

# ── TEST 3: shell-hook.sh exports CLAWS_DIR ───────────────────────────────────
SHELL_HOOK="$REPO_ROOT/scripts/shell-hook.sh"
if grep -q 'export CLAWS_DIR\|CLAWS_DIR=' "$SHELL_HOOK" 2>/dev/null; then
  pass "shell-hook.sh: exports CLAWS_DIR"
else
  fail "shell-hook.sh: does not export CLAWS_DIR (FINDING-A-2)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) install-claws-dir-export check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT install-claws-dir-export checks"
exit 0
