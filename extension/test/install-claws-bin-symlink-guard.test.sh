#!/usr/bin/env bash
# Tests for FINDING-B-2: install.sh must guard against dangling/loop symlinks
# at $PROJECT_ROOT/.claws-bin before running mkdir -p.
# Run: bash extension/test/install-claws-bin-symlink-guard.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/../../scripts/install.sh"

# ── TEST 1: install.sh has a symlink guard before mkdir -p .claws-bin ────────
# Check that a symlink check (using -L) appears before the mkdir -p .claws-bin
# in the script's textual order.
SYMLINK_CHECK_LINE=$(grep -n '\-L.*claws-bin\|claws-bin.*\-L\|readlink.*claws-bin' "$INSTALL_SH" 2>/dev/null | head -1 | cut -d: -f1)
MKDIR_LINE=$(grep -n 'mkdir -p.*\.claws-bin"$' "$INSTALL_SH" 2>/dev/null | head -1 | cut -d: -f1)

if [ -z "$SYMLINK_CHECK_LINE" ]; then
  fail "install.sh: no symlink guard (-L check) for .claws-bin (FINDING-B-2)"
elif [ -z "$MKDIR_LINE" ]; then
  fail "install.sh: could not locate mkdir -p .claws-bin line"
elif [ "$SYMLINK_CHECK_LINE" -lt "$MKDIR_LINE" ]; then
  pass "install.sh: symlink guard appears before mkdir -p .claws-bin"
else
  fail "install.sh: symlink guard (line $SYMLINK_CHECK_LINE) is AFTER mkdir -p (line $MKDIR_LINE) — wrong order"
fi

# ── TEST 2: guard handles dangling symlinks by removing them ─────────────────
if grep -A5 '\-L.*claws-bin\|claws-bin.*\-L' "$INSTALL_SH" 2>/dev/null | grep -q 'rm\|unlink\|remove'; then
  pass "install.sh: symlink guard removes dangling symlinks"
else
  fail "install.sh: symlink guard does not remove dangling symlinks (FINDING-B-2)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) install-claws-bin-symlink-guard check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT install-claws-bin-symlink-guard checks"
exit 0
