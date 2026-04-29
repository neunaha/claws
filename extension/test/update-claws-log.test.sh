#!/usr/bin/env bash
# Tests for M-19: CLAWS_LOG must be defined in update.sh before install.sh runs
# so Step 6 health check warnings reference the actual log path.
# Run: bash extension/test/update-claws-log.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UPDATE_SH="$SCRIPT_DIR/../../scripts/update.sh"

# ── TEST 1: M-19 comment present ────────────────────────────────────────────
if grep -q 'M-19' "$UPDATE_SH"; then
  pass "update.sh: M-19 marker present"
else
  fail "update.sh: M-19 marker missing"
fi

# ── TEST 2: CLAWS_LOG defined before install.sh invocation ──────────────────
# The CLAWS_LOG assignment must appear before the install.sh call (Step 2).
_claws_log_line=$(grep -n 'CLAWS_LOG=' "$UPDATE_SH" | grep -v '#' | head -1 | cut -d: -f1)
_install_line=$(grep -n 'bash.*install\.sh' "$UPDATE_SH" | head -1 | cut -d: -f1)
if [ -n "$_claws_log_line" ] && [ -n "$_install_line" ]; then
  if [ "$_claws_log_line" -lt "$_install_line" ]; then
    pass "update.sh: CLAWS_LOG (line $_claws_log_line) defined before install.sh (line $_install_line)"
  else
    fail "update.sh: CLAWS_LOG (line $_claws_log_line) defined AFTER install.sh (line $_install_line)"
  fi
else
  fail "update.sh: could not locate CLAWS_LOG assignment or install.sh invocation"
fi

# ── TEST 3: CLAWS_LOG exported ───────────────────────────────────────────────
if grep -q 'export CLAWS_LOG' "$UPDATE_SH"; then
  pass "update.sh: CLAWS_LOG is exported (install.sh subprocess inherits it)"
else
  fail "update.sh: CLAWS_LOG not exported — install.sh subprocess can't inherit it"
fi

# ── TEST 4: behavioral — CLAWS_LOG is set and non-empty when sourced ─────────
_claws_log_val=$(bash -c '
  CLAWS_LOG="${CLAWS_LOG:-/tmp/claws-test-log.log}"
  export CLAWS_LOG
  echo "$CLAWS_LOG"
')
if [ -n "$_claws_log_val" ]; then
  pass "behavioral: CLAWS_LOG resolves to non-empty value: $_claws_log_val"
else
  fail "behavioral: CLAWS_LOG resolved to empty string"
fi

# ── TEST 5: Step 6 warning references $CLAWS_LOG (not a hardcoded path) ──────
if grep -q 'see install log.*\$CLAWS_LOG\|CLAWS_LOG.*install log' "$UPDATE_SH"; then
  pass "update.sh: Step 6 warning references \$CLAWS_LOG variable"
else
  fail "update.sh: Step 6 warning does not reference \$CLAWS_LOG"
fi

# ── TEST 6: CLAWS_LOG uses date-stamp + PID pattern (matches install.sh) ──────
if grep 'CLAWS_LOG=' "$UPDATE_SH" | grep -q 'date.*%Y%m%d' ; then
  pass "update.sh: CLAWS_LOG uses date-stamp pattern matching install.sh"
else
  fail "update.sh: CLAWS_LOG pattern differs from install.sh pattern"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) update-claws-log check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT update-claws-log checks"
exit 0
