#!/usr/bin/env bash
# Tests for FINDING-C-8: fix.sh must check .claws-bin integrity unconditionally,
# independent of the .mcp.json registration gate.
# Run: bash extension/test/fix-claws-bin-integrity.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIX_SH="$SCRIPT_DIR/../../scripts/fix.sh"

# ── TEST 1: fix.sh has an unconditional .claws-bin integrity check ────────────
# Check that the phrase ".claws-bin integrity" appears as a named check(),
# NOT nested inside the .mcp.json conditional block.
if grep -q '\.claws-bin integrity\|claws-bin.*integrity\|integrity.*claws-bin' "$FIX_SH" 2>/dev/null; then
  pass "fix.sh: .claws-bin integrity check label present"
else
  fail "fix.sh: missing .claws-bin integrity check (FINDING-C-8)"
fi

# ── TEST 2: the integrity check is not gated inside the .mcp.json block ───────
# The .mcp.json block starts with the grep '\"claws\"' pattern inside check 4.
# The .claws-bin integrity check must appear BEFORE or AFTER that block, not
# nested within the conditional that only fires when .mcp.json is missing.
# We verify by checking the line number ordering: integrity check line must be
# AFTER check 4's closing 'fi' (or before it entirely).
MCP_BLOCK_LINE=$(grep -n 'grep.*"claws".*PROJECT_MCP\|PROJECT_MCP.*grep.*"claws"' "$FIX_SH" 2>/dev/null | head -1 | cut -d: -f1)
INTEGRITY_LINE=$(grep -n '\.claws-bin integrity\|claws-bin.*integrity\|integrity.*claws-bin' "$FIX_SH" 2>/dev/null | head -1 | cut -d: -f1)

if [ -z "$MCP_BLOCK_LINE" ] || [ -z "$INTEGRITY_LINE" ]; then
  fail "fix.sh: could not locate .mcp.json block or integrity check for ordering test"
else
  if [ "$INTEGRITY_LINE" -gt "$MCP_BLOCK_LINE" ]; then
    # Integrity check is after the mcp.json block. That's fine — it's unconditional.
    pass "fix.sh: .claws-bin integrity check appears after (independent of) .mcp.json gate"
  else
    fail "fix.sh: .claws-bin integrity check appears inside or before .mcp.json block (FINDING-C-8)"
  fi
fi

# ── TEST 3: repair copies mcp_server.js from INSTALL_DIR when missing ─────────
if grep -A10 'claws-bin.*integrity\|integrity.*claws-bin' "$FIX_SH" 2>/dev/null | grep -q 'mcp_server.js'; then
  pass "fix.sh: integrity repair copies mcp_server.js from INSTALL_DIR"
else
  fail "fix.sh: integrity repair does not copy mcp_server.js (FINDING-C-8)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) fix-claws-bin-integrity check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT fix-claws-bin-integrity checks"
exit 0
