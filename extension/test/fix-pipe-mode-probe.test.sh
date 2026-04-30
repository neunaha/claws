#!/usr/bin/env bash
# Tests for FINDING-C-13: fix.sh must probe wrapped-terminal health inside the
# socket-LIVE branch — flag terminals where wrapped=true but logPath is null,
# and verify script(1) is available on Linux.
# Run: bash extension/test/fix-pipe-mode-probe.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIX_SH="$SCRIPT_DIR/../../scripts/fix.sh"

# ── TEST 1: fix.sh probes wrapped terminals in the socket-LIVE branch ─────────
# Look for a check of wrapped && !logPath (or similar) after the socket list call.
if grep -q 'wrapped.*logPath\|logPath.*null\|wrapped.*true.*log\|no logPath\|missing.*log' "$FIX_SH" 2>/dev/null; then
  pass "fix.sh: probes wrapped terminal logPath in socket-LIVE branch"
else
  fail "fix.sh: no wrapped terminal logPath probe in socket-LIVE branch (FINDING-C-13)"
fi

# ── TEST 2: fix.sh probes script(1) availability on Linux ────────────────────
# Match "command -v script" or "which script" as availability checks for script(1)
if grep -qE 'command -v script|which script' "$FIX_SH" 2>/dev/null; then
  pass "fix.sh: script(1) availability probe present"
else
  fail "fix.sh: no script(1) availability probe (FINDING-C-13)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) fix-pipe-mode-probe check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT fix-pipe-mode-probe checks"
exit 0
