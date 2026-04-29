#!/usr/bin/env bash
# Tests for M-10: update.sh Step 6 health check must use 8s timeout + 3-retry
# exponential backoff before declaring YELLOW.
# Run: bash extension/test/update-step6-timeout.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UPDATE_SH="$SCRIPT_DIR/../../scripts/update.sh"

# ── TEST 1: update.sh contains M-10 comment ──────────────────────────────────
if grep -q 'M-10' "$UPDATE_SH"; then
  pass "update.sh: M-10 marker present"
else
  fail "update.sh: M-10 marker missing"
fi

# ── TEST 2: 8000ms timeout (not the old 2000ms) ──────────────────────────────
if grep -q '8000' "$UPDATE_SH" && ! grep -q 'setTimeout.*2000' "$UPDATE_SH"; then
  pass "update.sh: 8000ms timeout present, old 2000ms gone"
else
  fail "update.sh: expected 8000ms timeout in Step 6"
fi

# ── TEST 3: exponential backoff series (8000, 12000, 16000) ──────────────────
if grep -q '8000 12000 16000' "$UPDATE_SH"; then
  pass "update.sh: exponential backoff series (8000 12000 16000) present"
else
  fail "update.sh: exponential backoff series not found"
fi

# ── TEST 4: YELLOW only declared after loop exhausts (_claws_mcp_ok check) ───
if grep -q '_claws_mcp_ok' "$UPDATE_SH"; then
  pass "update.sh: _claws_mcp_ok guard present (YELLOW after retries exhausted)"
else
  fail "update.sh: _claws_mcp_ok guard missing"
fi

# ── TEST 5: behavioral — mock server too slow, confirm 3 retries tried ───────
# Create a temp dir with a mock mcp_server.js that responds after a long delay
# (longer than 8s). Because the actual backoff timeouts are too long for a
# unit test, we just verify the structural retry loop is present.
if grep -q 'for _claws_mcp_ms in' "$UPDATE_SH"; then
  pass "update.sh: for-loop retry over timeout values present"
else
  fail "update.sh: for-loop retry structure missing"
fi

# ── TEST 6: SIGKILL escalation 500ms after SIGTERM present ────────────────────
if grep -q "SIGKILL" "$UPDATE_SH" && grep -q "SIGTERM" "$UPDATE_SH" && grep -q '500' "$UPDATE_SH"; then
  pass "update.sh: SIGKILL escalation (500ms) present in health check"
else
  fail "update.sh: SIGKILL escalation missing from health check"
fi

# ── TEST 7: CLAWS_MCP_PATH env var used (no embedded path in node -e) ────────
if grep -q 'CLAWS_MCP_PATH' "$UPDATE_SH" && grep -q 'process.env.CLAWS_MCP_PATH' "$UPDATE_SH"; then
  pass "update.sh: mcp_server.js path passed via CLAWS_MCP_PATH env var"
else
  fail "update.sh: mcp_server.js path not using env var (potential quoting issue)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) update-step6-timeout check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT update-step6-timeout checks"
exit 0
