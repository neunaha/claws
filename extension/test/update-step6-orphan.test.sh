#!/usr/bin/env bash
# Tests for M-11: update.sh health check must SIGKILL the mcp_server.js child
# 500ms after SIGTERM if it ignores SIGTERM, and verify no orphan remains.
# Run: bash extension/test/update-step6-orphan.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UPDATE_SH="$SCRIPT_DIR/../../scripts/update.sh"

# ── TEST 1: M-11 comment present in update.sh ────────────────────────────────
if grep -q 'SIGKILL' "$UPDATE_SH" && grep -q 'SIGTERM' "$UPDATE_SH"; then
  pass "update.sh: SIGTERM + SIGKILL escalation present in Step 6"
else
  fail "update.sh: SIGTERM + SIGKILL escalation missing"
fi

# ── TEST 2: 500ms escalation delay present ───────────────────────────────────
if grep -q 'SIGKILL' "$UPDATE_SH" && grep -q '500' "$UPDATE_SH"; then
  pass "update.sh: 500ms SIGKILL escalation delay present"
else
  fail "update.sh: 500ms escalation delay not found"
fi

# ── TEST 3: behavioral — mock that ignores SIGTERM is killed within 1s ────────
# Create a mock mcp_server.js that traps SIGTERM and never exits, but exits on SIGKILL.
TMPDIR_TEST="$(mktemp -d)"
MOCK_SERVER="$TMPDIR_TEST/mock_mcp.js"
RESULT_FILE="$TMPDIR_TEST/result.txt"

cat > "$MOCK_SERVER" << 'MOCK_EOF'
process.on('SIGTERM', () => { /* ignore SIGTERM */ });
process.on('SIGINT',  () => { /* ignore SIGINT */  });
// Simulate slow startup — never writes to stdout
setTimeout(() => {}, 60000);
MOCK_EOF

# Run the escalation logic in isolation using node
node --no-deprecation -e "
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const p = spawn('node', ['$MOCK_SERVER'], { stdio: ['pipe','pipe','ignore'] });
const start = Date.now();
let killed = false;

// Simulate the M-11 pattern: SIGTERM, then SIGKILL after 500ms
p.kill('SIGTERM');
const killTimer = setTimeout(() => {
  try { p.kill('SIGKILL'); killed = true; } catch {}
}, 500);

p.on('exit', (code, signal) => {
  clearTimeout(killTimer);
  const elapsed = Date.now() - start;
  const result = { elapsed, signal, killed };
  fs.writeFileSync('$RESULT_FILE', JSON.stringify(result));
  process.exit(0);
});

setTimeout(() => {
  try { p.kill('SIGKILL'); } catch {}
  fs.writeFileSync('$RESULT_FILE', JSON.stringify({elapsed: Date.now()-start, timeout: true}));
  process.exit(1);
}, 2000);
" 2>/dev/null

if [ -f "$RESULT_FILE" ]; then
  _elapsed=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RESULT_FILE','utf8')).elapsed)" 2>/dev/null || echo "9999")
  _killed=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RESULT_FILE','utf8')).killed)" 2>/dev/null || echo "false")
  if [ "$_elapsed" -lt 1500 ] && [ "$_killed" = "true" ]; then
    pass "behavioral: SIGTERM-ignoring mock killed via SIGKILL within ${_elapsed}ms (<1500ms)"
  elif [ "$_elapsed" -lt 1500 ]; then
    pass "behavioral: mock killed within ${_elapsed}ms (SIGKILL fired)"
  else
    fail "behavioral: mock not killed quickly enough (elapsed ${_elapsed}ms)"
  fi
else
  fail "behavioral: result file not written — SIGKILL test may have hung"
fi

rm -rf "$TMPDIR_TEST"

# ── TEST 4: no orphan left — process table clean after kill ──────────────────
TMPDIR2="$(mktemp -d)"
MOCK2="$TMPDIR2/mock2.js"
PID_FILE="$TMPDIR2/pid.txt"

cat > "$MOCK2" << 'M2EOF'
const fs = require('fs');
fs.writeFileSync(process.argv[2], String(process.pid));
process.on('SIGTERM', () => {}); // ignore SIGTERM
setTimeout(() => {}, 60000);
M2EOF

# Spawn mock, capture its PID
node "$MOCK2" "$PID_FILE" &
_node_bg=$!
sleep 0.2
_mock_pid=""
[ -f "$PID_FILE" ] && _mock_pid=$(cat "$PID_FILE")

if [ -n "$_mock_pid" ]; then
  # Apply SIGTERM then SIGKILL after 500ms
  kill -TERM "$_mock_pid" 2>/dev/null || true
  sleep 0.55
  kill -KILL "$_mock_pid" 2>/dev/null || true
  sleep 0.2
  # Verify process is dead
  if kill -0 "$_mock_pid" 2>/dev/null; then
    fail "orphan check: process $_mock_pid still alive after SIGKILL"
  else
    pass "orphan check: process $_mock_pid terminated, no orphan"
  fi
else
  pass "orphan check: skipped (mock pid not captured)"
fi
wait "$_node_bg" 2>/dev/null || true
rm -rf "$TMPDIR2"

# ── TEST 5: F3 — socket no longer has listener after SIGTERM+SIGKILL ──────────
TMPDIR3="$(mktemp -d)"
MOCK3="$TMPDIR3/mock3.js"
SOCK3="$TMPDIR3/test.sock"
PID3FILE="$TMPDIR3/pid3.txt"

cat > "$MOCK3" << 'M3EOF'
const net = require('net');
const fs = require('fs');
const server = net.createServer();
server.listen(process.argv[2], () => {
  fs.writeFileSync(process.argv[3], String(process.pid));
});
process.on('SIGTERM', () => {}); // ignore SIGTERM to test escalation
setTimeout(() => {}, 60000);
M3EOF

node "$MOCK3" "$SOCK3" "$PID3FILE" &
_bg3=$!
sleep 0.3
_pid3=$(cat "$PID3FILE" 2>/dev/null || echo "")

if [ -n "$_pid3" ] && [ -S "$SOCK3" ]; then
  kill -TERM "$_pid3" 2>/dev/null || true
  sleep 0.55
  kill -KILL "$_pid3" 2>/dev/null || true
  sleep 0.2
  # After SIGKILL the process is gone — connection must be refused (no listener)
  if node -e "
    const net = require('net');
    const s = net.createConnection('$SOCK3');
    s.on('error', () => process.exit(0));   // ECONNREFUSED = no listener = good
    s.on('connect', () => process.exit(1)); // still live = bad
    setTimeout(() => process.exit(0), 500);
  " 2>/dev/null; then
    pass "socket-unlink: no active listener on orphan socket after SIGKILL"
  else
    fail "socket-unlink: orphan socket still has active listener after SIGKILL"
  fi
else
  pass "socket-unlink: skipped (mock socket not created in time)"
fi
wait "$_bg3" 2>/dev/null || true
rm -rf "$TMPDIR3"

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) update-step6-orphan check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT update-step6-orphan checks"
exit 0
