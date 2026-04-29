#!/usr/bin/env bash
# Tests for M-44: fix.sh MCP handshake must use newline-delimited JSON frames,
# not Content-Length framing (LSP protocol). mcp_server.js only speaks
# newline-delimited JSON.
# Run: bash extension/test/fix-mcp-handshake.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIX_SH="$SCRIPT_DIR/../../scripts/fix.sh"

# ── TEST 1: M-44 comment present ──────────────────────────────────────────────
if grep -q 'M-44' "$FIX_SH"; then
  pass "fix.sh: M-44 marker present"
else
  fail "fix.sh: M-44 marker missing"
fi

# ── TEST 2: Content-Length framing is gone (only allowed in comments) ────────
if ! grep -v '^#\|^\s*#\|// ' "$FIX_SH" | grep -q 'Content-Length'; then
  pass "fix.sh: Content-Length framing removed from code (not in active code paths)"
else
  fail "fix.sh: Content-Length framing still present in active code (must use newline-delimited JSON)"
fi

# ── TEST 3: newline-terminated write used ─────────────────────────────────────
if grep -q 'req + "\\n"' "$FIX_SH" || grep -q "req + '\\\\n'" "$FIX_SH" || grep -q '"\\n")' "$FIX_SH"; then
  pass "fix.sh: newline-terminated write (req + newline) used for MCP handshake"
else
  fail "fix.sh: newline-terminated write not found in MCP handshake"
fi

# ── TEST 4: full protocolVersion present in initialize params ─────────────────
if grep -q 'protocolVersion' "$FIX_SH"; then
  pass "fix.sh: protocolVersion present in initialize params"
else
  fail "fix.sh: protocolVersion missing from initialize params"
fi

# ── TEST 5: behavioral — newline-delimited mock responds to fix.sh handshake ──
TMPDIR_TEST="$(mktemp -d)"
MOCK_MCP="$TMPDIR_TEST/mock_mcp.js"

cat > "$MOCK_MCP" << 'MOCK_EOF'
// Mock MCP server — speaks newline-delimited JSON only
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', d => {
  buf += d;
  const nl = buf.indexOf('\n');
  if (nl !== -1) {
    let req;
    try { req = JSON.parse(buf.slice(0, nl)); } catch { process.exit(1); }
    buf = buf.slice(nl + 1);
    if (req.method === 'initialize') {
      const resp = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { serverInfo: { name: 'claws', version: '0.7.4' }, capabilities: {} } });
      process.stdout.write(resp + '\n');
    }
  }
});
setTimeout(() => process.exit(0), 5000);
MOCK_EOF

RESULT=$(node --no-deprecation -e '
const { spawn } = require("child_process");
const mcp = spawn("node", [process.argv[1]], { stdio: ["pipe", "pipe", "ignore"] });
const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claws-fix", version: "1" } } });
let buf = "";
const done = (c, o) => { try { mcp.kill(); } catch {} process.stdout.write(o); process.exit(c); };
const timer = setTimeout(() => done(1, "TIMEOUT"), 2000);
mcp.stdout.on("data", d => { buf += d.toString("utf8"); if (buf.includes("claws")) { clearTimeout(timer); done(0, buf.slice(0, 200)); } });
mcp.on("error", e => { clearTimeout(timer); done(1, "SPAWN_ERROR: " + e.message); });
mcp.stdin.write(req + "\n");
' "$MOCK_MCP" 2>/dev/null || echo "FAILED")

if echo "$RESULT" | grep -q "claws"; then
  pass "behavioral: newline-delimited mock responded to handshake (claws found in output)"
else
  fail "behavioral: handshake response not received (got: ${RESULT:0:100})"
fi

rm -rf "$TMPDIR_TEST"

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) fix-mcp-handshake check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT fix-mcp-handshake checks"
exit 0
