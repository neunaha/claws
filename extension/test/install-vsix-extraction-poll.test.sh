#!/usr/bin/env bash
# Tests for FINDING-B-4: install.sh must poll for the kept_dir to appear
# after VS Code VSIX install (async extraction) before deciding it's absent
# and skipping stale cleanup.
# Run: bash extension/test/install-vsix-extraction-poll.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/../../scripts/install.sh"

# ── TEST 1: install.sh polls for kept_dir instead of checking only once ───────
# Look for a retry / sleep loop around the kept_dir check.
if grep -A10 'kept_dir' "$INSTALL_SH" 2>/dev/null | grep -qE 'sleep|poll|retry|for.*[0-9].*in'; then
  pass "install.sh: polls for kept_dir after VSIX install (extraction poll present)"
else
  fail "install.sh: no extraction poll for kept_dir (FINDING-B-4)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) install-vsix-extraction-poll check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT install-vsix-extraction-poll checks"
exit 0
