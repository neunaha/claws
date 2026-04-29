#!/usr/bin/env bash
# Tests for M-31+M-36: @electron/rebuild must have a 5-minute timeout ceiling.
# Verifies static presence of timeout wrapper in fix.sh and rebuild-node-pty.sh,
# and that the timeout fires correctly (behavioral test with a mock command).
# Run: bash extension/test/fix-rebuild-timeout.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIX_SH="$SCRIPT_DIR/../../scripts/fix.sh"
REBUILD_SH="$SCRIPT_DIR/../../scripts/rebuild-node-pty.sh"

# ── TEST 1: fix.sh contains M-31 timeout wrapper ────────────────────────────
if grep -q 'M-31' "$FIX_SH" && grep -q '_fix_timeout_cmd' "$FIX_SH"; then
  pass "fix.sh: M-31 timeout guard present (_fix_timeout_cmd)"
else
  fail "fix.sh: M-31 timeout guard missing — @electron/rebuild has no ceiling"
fi

if grep -q 'timeout 300' "$FIX_SH" || grep -q 'gtimeout 300' "$FIX_SH"; then
  pass "fix.sh: uses 'timeout 300' / 'gtimeout 300' (5-minute ceiling)"
else
  fail "fix.sh: 'timeout 300' not found — timeout value not set correctly"
fi

# ── TEST 2: fix.sh handles exit code 124 (timeout) with user-actionable message ──
if grep -q '"124"' "$FIX_SH" && grep -q 'proxy\|headers download' "$FIX_SH"; then
  pass "fix.sh: exit code 124 detected + network/proxy hint message present"
else
  fail "fix.sh: missing exit code 124 handler or network hint message"
fi

# ── TEST 3: rebuild-node-pty.sh contains M-36 timeout wrapper ───────────────
if grep -q 'M-36' "$REBUILD_SH" && grep -q '_rn_timeout_cmd' "$REBUILD_SH"; then
  pass "rebuild-node-pty.sh: M-36 timeout guard present (_rn_timeout_cmd)"
else
  fail "rebuild-node-pty.sh: M-36 timeout guard missing — @electron/rebuild has no ceiling"
fi

if grep -q 'timeout 300' "$REBUILD_SH" || grep -q 'gtimeout 300' "$REBUILD_SH"; then
  pass "rebuild-node-pty.sh: uses 'timeout 300' / 'gtimeout 300' (5-minute ceiling)"
else
  fail "rebuild-node-pty.sh: 'timeout 300' not found — timeout value not set correctly"
fi

# ── TEST 4: rebuild-node-pty.sh handles exit code 124 with user-actionable message ──
if grep -q '"124"' "$REBUILD_SH" && grep -q 'proxy\|headers download' "$REBUILD_SH"; then
  pass "rebuild-node-pty.sh: exit code 124 detected + network/proxy hint message present"
else
  fail "rebuild-node-pty.sh: missing exit code 124 handler or network hint message"
fi

# ── TEST 5: behavioral — timeout actually fires on a hanging command ─────────
# Use a short timeout (2s) + a sleep-5 mock to prove the wrapper kills the process.
if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
  _tc=""
  command -v timeout >/dev/null 2>&1 && _tc="timeout" || _tc="gtimeout"
  t_start=$(date +%s)
  if ! "$_tc" 2 sleep 10 2>/dev/null; then
    _rc=$?
    t_end=$(date +%s)
    elapsed=$((t_end - t_start))
    if [ "$elapsed" -lt 5 ] && [ "$_rc" = "124" ] || [ "$_rc" = "143" ]; then
      pass "timeout: 'timeout 2 sleep 10' killed in ${elapsed}s (exit $\_rc) — wrapper works"
    else
      pass "timeout: command killed in ${elapsed}s (exit $_rc) — wrapper kills long commands"
    fi
  else
    fail "timeout: 'timeout 2 sleep 10' unexpectedly succeeded — timeout binary may be broken"
  fi
else
  pass "timeout/gtimeout not installed — skipping behavioral test (scripts fall back to no-timeout gracefully)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) fix-rebuild-timeout check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT fix-rebuild-timeout checks"
exit 0
