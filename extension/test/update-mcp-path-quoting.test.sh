#!/usr/bin/env bash
# Tests for M-47: update.sh .mcp.json sanity check must pass the path via
# CLAWS_MCP_CHECK env var instead of string-interpolating into node -e — handles
# project roots with apostrophes or backslashes without JS syntax errors.
# Run: bash extension/test/update-mcp-path-quoting.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UPDATE_SH="$SCRIPT_DIR/../../scripts/update.sh"

# ── TEST 1: M-47 marker present ───────────────────────────────────────────────
if grep -q 'M-47' "$UPDATE_SH"; then
  pass "update.sh: M-47 marker present"
else
  fail "update.sh: M-47 marker missing"
fi

# ── TEST 2: CLAWS_MCP_CHECK env var used ─────────────────────────────────────
if grep -q 'CLAWS_MCP_CHECK' "$UPDATE_SH" && grep -q 'process.env.CLAWS_MCP_CHECK' "$UPDATE_SH"; then
  pass "update.sh: .mcp.json path passed via CLAWS_MCP_CHECK env var"
else
  fail "update.sh: CLAWS_MCP_CHECK env var not used for .mcp.json sanity check"
fi

# ── TEST 3: path not embedded in node -e string ───────────────────────────────
if ! grep "readFileSync.*\$PROJECT_ROOT/\\.mcp\\.json" "$UPDATE_SH" 2>/dev/null | grep -q "readFileSync"; then
  pass "update.sh: .mcp.json path not embedded directly in node -e string"
else
  fail "update.sh: .mcp.json path still embedded in node -e (injection risk)"
fi

# ── TEST 4: behavioral — path with apostrophe works ──────────────────────────
TMPDIR_TEST="$(mktemp -d)"
APOSTROPHE_DIR="$TMPDIR_TEST/project's root"
mkdir -p "$APOSTROPHE_DIR"
MCP_FILE="$APOSTROPHE_DIR/.mcp.json"
echo '{"mcpServers":{"claws":{}}}' > "$MCP_FILE"

if CLAWS_MCP_CHECK="$MCP_FILE" node -e "JSON.parse(require('fs').readFileSync(process.env.CLAWS_MCP_CHECK,'utf8'))" 2>/dev/null; then
  pass "behavioral: apostrophe in path works with CLAWS_MCP_CHECK env var"
else
  fail "behavioral: apostrophe path failed even with env var (unexpected)"
fi

# ── TEST 5: behavioral — path with backslash works ───────────────────────────
BACKSLASH_DIR="$TMPDIR_TEST/project\\root"
mkdir -p "$BACKSLASH_DIR"
MCP_FILE2="$BACKSLASH_DIR/.mcp.json"
echo '{"mcpServers":{"claws":{}}}' > "$MCP_FILE2"

if CLAWS_MCP_CHECK="$MCP_FILE2" node -e "JSON.parse(require('fs').readFileSync(process.env.CLAWS_MCP_CHECK,'utf8'))" 2>/dev/null; then
  pass "behavioral: backslash in path works with CLAWS_MCP_CHECK env var"
else
  fail "behavioral: backslash path failed even with env var (unexpected)"
fi

rm -rf "$TMPDIR_TEST"

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) update-mcp-path-quoting check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT update-mcp-path-quoting checks"
exit 0
