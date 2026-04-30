#!/usr/bin/env bash
# Tests for D-2: .claude/settings.json dev-hooks must use .claws-bin/dev-hooks/
# path (canonical production path), not scripts/dev-hooks/ (source path).
# Run: bash extension/test/dev-hooks-path-canonical.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS="$SCRIPT_DIR/../../.claude/settings.json"

# ── TEST 1: no stale scripts/dev-hooks/ paths in .claude/settings.json ────────
if grep -q 'scripts/dev-hooks' "$SETTINGS" 2>/dev/null; then
  fail ".claude/settings.json: still references scripts/dev-hooks/ (stale source path — D-2)"
else
  pass ".claude/settings.json: no stale scripts/dev-hooks/ paths"
fi

# ── TEST 2: dev-hook commands use .claws-bin/dev-hooks/ ───────────────────────
if grep -q '_source.*claws-dev-hooks\|"claws-dev-hooks"' "$SETTINGS" 2>/dev/null; then
  if grep -q '\.claws-bin/dev-hooks' "$SETTINGS" 2>/dev/null; then
    pass ".claude/settings.json: dev-hook commands reference .claws-bin/dev-hooks/"
  else
    fail ".claude/settings.json: dev-hook commands do not reference .claws-bin/dev-hooks/ (D-2)"
  fi
else
  # No dev hooks registered at all — also fine (inject hasn't run yet)
  pass ".claude/settings.json: no dev-hooks registered (not an error)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) dev-hooks-path-canonical check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT dev-hooks-path-canonical checks"
exit 0
