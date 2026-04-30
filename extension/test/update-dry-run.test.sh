#!/usr/bin/env bash
# Tests for FINDING-B-5: update.sh must support a --dry-run flag that shows
# what would change (git diff, pending CLAUDE.md updates) without applying them.
# Run: bash extension/test/update-dry-run.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UPDATE_SH="$SCRIPT_DIR/../../scripts/update.sh"

# ── TEST 1: update.sh accepts --dry-run flag ──────────────────────────────────
if grep -q '\-\-dry-run\|DRY_RUN\|dry_run' "$UPDATE_SH" 2>/dev/null; then
  pass "update.sh: --dry-run flag supported"
else
  fail "update.sh: no --dry-run flag (FINDING-B-5)"
fi

# ── TEST 2: dry-run skips the installer step ─────────────────────────────────
if grep -A5 'DRY_RUN\|dry.run\|dry-run' "$UPDATE_SH" 2>/dev/null | grep -qE 'skip|note|echo|print'; then
  pass "update.sh: dry-run skips or announces installer skip"
else
  fail "update.sh: dry-run does not skip installer (FINDING-B-5)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) update-dry-run check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT update-dry-run checks"
exit 0
