#!/usr/bin/env bash
# Tests for FINDING-C-10: fix.sh must auto-refresh mcp_server.js from INSTALL_DIR
# and re-probe once when the MCP handshake fails (instead of just reporting the error).
# Run: bash extension/test/fix-mcp-recovery.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIX_SH="$SCRIPT_DIR/../../scripts/fix.sh"

# ── TEST 1: fix.sh has a recovery action after MCP handshake failure ──────────
# Look for a cp/refresh of mcp_server.js in the handshake failure branch.
if grep -A10 'MCP server failed to respond' "$FIX_SH" 2>/dev/null | grep -q 'cp\|refresh\|restore\|re-prob\|reprob'; then
  pass "fix.sh: MCP handshake failure triggers recovery (copy/refresh mcp_server.js)"
else
  fail "fix.sh: no recovery action after MCP handshake failure (FINDING-C-10)"
fi

# ── TEST 2: recovery re-probes the handshake after refresh ────────────────────
if grep -A20 'MCP server failed to respond' "$FIX_SH" 2>/dev/null | grep -q 'HANDSHAKE\|handshake\|initialize'; then
  pass "fix.sh: MCP recovery re-probes handshake after refresh"
else
  fail "fix.sh: no re-probe after MCP recovery (FINDING-C-10)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) fix-mcp-recovery check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT fix-mcp-recovery checks"
exit 0
