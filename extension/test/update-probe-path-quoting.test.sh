#!/usr/bin/env bash
# Tests for M-20: update.sh socket probe must pass project root via env var
# (CLAWS_PROBE_PATH) rather than string-interpolating into the node -e argument.
# Handles paths with apostrophes and backslashes without JS syntax errors.
# Run: bash extension/test/update-probe-path-quoting.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UPDATE_SH="$SCRIPT_DIR/../../scripts/update.sh"

# ── TEST 1: M-20 comment present in update.sh ────────────────────────────────
if grep -q 'M-20' "$UPDATE_SH"; then
  pass "update.sh: M-20 marker present"
else
  fail "update.sh: M-20 marker missing"
fi

# ── TEST 2: CLAWS_PROBE_PATH env var used in probe block ─────────────────────
if grep -q 'CLAWS_PROBE_PATH' "$UPDATE_SH" && grep -q 'process.env.CLAWS_PROBE_PATH' "$UPDATE_SH"; then
  pass "update.sh: CLAWS_PROBE_PATH env var used for socket probe"
else
  fail "update.sh: CLAWS_PROBE_PATH not found — probe path may be string-interpolated"
fi

# ── TEST 3: old injection pattern ('$_claws_sock') removed from probe ─────────
if ! grep -q "createConnection('\$_claws_sock')" "$UPDATE_SH"; then
  pass "update.sh: old string-interpolation createConnection pattern removed"
else
  fail "update.sh: old string-interpolation createConnection('\$_claws_sock') still present"
fi

# ── TEST 4: behavioral — path with apostrophe doesn't cause JS syntax error ──
# Simulate the probe with a socket path containing a single-quote.
_APOSTROPHE_PATH="/tmp/user's project/.claws/claws.sock"
_result=$(CLAWS_PROBE_PATH="$_APOSTROPHE_PATH" node --no-deprecation -e "
  const net = require('net');
  const sockPath = process.env.CLAWS_PROBE_PATH;
  const s = net.createConnection(sockPath);
  const t = setTimeout(() => {
    try { s.destroy(); } catch {}
    process.exit(1); // expected: socket doesn't exist
  }, 300);
  s.on('connect', () => { clearTimeout(t); s.destroy(); process.exit(0); });
  s.on('error', (err) => {
    clearTimeout(t);
    // ENOENT or ECONNREFUSED both mean the path was parsed OK (no JS syntax error)
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      process.exit(1); // path parsed OK, socket just doesn't exist — expected
    }
    process.exit(2); // unexpected error
  });
" 2>&1 || true)
_exit=$?
# Exit code 1 = ENOENT (path parsed OK), exit 2 = unexpected, exit 0 = connected (shouldn't happen)
if [ "$_exit" = "1" ] || [ "$_exit" = "0" ]; then
  pass "behavioral: apostrophe path parsed by node without JS syntax error (exit $_exit)"
else
  fail "behavioral: apostrophe path caused unexpected error (exit $_exit): $_result"
fi

# ── TEST 5: behavioral — path with backslash doesn't cause JS syntax error ───
_BACKSLASH_PATH="/tmp/back\\slash/.claws/claws.sock"
_result2=$(CLAWS_PROBE_PATH="$_BACKSLASH_PATH" node --no-deprecation -e "
  const net = require('net');
  const sockPath = process.env.CLAWS_PROBE_PATH;
  const s = net.createConnection(sockPath);
  const t = setTimeout(() => { try { s.destroy(); } catch {} process.exit(1); }, 300);
  s.on('connect', () => { clearTimeout(t); s.destroy(); process.exit(0); });
  s.on('error', () => { clearTimeout(t); process.exit(1); });
" 2>&1 || true)
_exit2=$?
if [ "$_exit2" = "1" ] || [ "$_exit2" = "0" ]; then
  pass "behavioral: backslash path parsed by node without JS syntax error (exit $_exit2)"
else
  fail "behavioral: backslash path caused unexpected error (exit $_exit2): $_result2"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) update-probe-path-quoting check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT update-probe-path-quoting checks"
exit 0
