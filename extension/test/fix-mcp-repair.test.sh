#!/usr/bin/env bash
# Tests for M-45+M-46: fix.sh .mcp.json and .vscode/extensions.json repair blocks
# must use json-safe.mjs (abort-on-malformed + atomic write + JSONC-tolerant) via
# fix-repair.js helper, with paths passed via env var (no string injection).
# Run: bash extension/test/fix-mcp-repair.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIX_SH="$SCRIPT_DIR/../../scripts/fix.sh"
FIX_REPAIR_JS="$SCRIPT_DIR/../../scripts/_helpers/fix-repair.js"

# ── TEST 1: M-45 marker present in fix.sh ────────────────────────────────────
if grep -q 'M-45' "$FIX_SH"; then
  pass "fix.sh: M-45 marker present"
else
  fail "fix.sh: M-45 marker missing"
fi

# ── TEST 2: M-46 marker present in fix.sh ────────────────────────────────────
if grep -q 'M-46' "$FIX_SH"; then
  pass "fix.sh: M-46 marker present"
else
  fail "fix.sh: M-46 marker missing"
fi

# ── TEST 3: fix-repair.js helper exists ──────────────────────────────────────
if [ -f "$FIX_REPAIR_JS" ]; then
  pass "fix-repair.js: helper script exists"
else
  fail "fix-repair.js: helper script not found at scripts/_helpers/fix-repair.js"
fi

# ── TEST 4: fix.sh uses CLAWS_REPAIR_TARGET env var (no embedded paths) ───────
if grep -q 'CLAWS_REPAIR_TARGET' "$FIX_SH" && ! grep -q "'\$PROJECT_MCP'" "$FIX_SH"; then
  pass "fix.sh: .mcp.json path passed via CLAWS_REPAIR_TARGET env var (no injection)"
else
  fail "fix.sh: .mcp.json path still embedded in JS source (injection risk)"
fi

# ── TEST 5: fix.sh .mcp.json block no longer uses silent JSON.parse ──────────
# The old pattern: try { cfg = JSON.parse(...); } catch {}
if ! grep -A3 'CLAWS_REPAIR_TARGET.*mcp' "$FIX_SH" | grep -q 'JSON.parse'; then
  pass "fix.sh: silent JSON.parse removed from .mcp.json repair (uses fix-repair.js now)"
else
  fail "fix.sh: silent JSON.parse still in .mcp.json repair block"
fi

# ── TEST 6: fix.sh .mcp.json block no longer uses writeFileSync ──────────────
if ! grep -A5 'CLAWS_REPAIR_TARGET.*mcp' "$FIX_SH" | grep -q 'writeFileSync'; then
  pass "fix.sh: non-atomic writeFileSync removed from .mcp.json repair"
else
  fail "fix.sh: non-atomic writeFileSync still in .mcp.json repair block"
fi

# ── TEST 7: fix-repair.js uses CLAWS_REPAIR_TARGET env var ───────────────────
if [ -f "$FIX_REPAIR_JS" ] && grep -q 'CLAWS_REPAIR_TARGET' "$FIX_REPAIR_JS"; then
  pass "fix-repair.js: uses CLAWS_REPAIR_TARGET env var for path"
else
  fail "fix-repair.js: CLAWS_REPAIR_TARGET env var not used"
fi

# ── TEST 8: fix-repair.js uses mergeIntoFile (abort-on-malformed + atomic) ───
if [ -f "$FIX_REPAIR_JS" ] && grep -q 'mergeIntoFile' "$FIX_REPAIR_JS"; then
  pass "fix-repair.js: mergeIntoFile from json-safe.mjs used"
else
  fail "fix-repair.js: mergeIntoFile not found (json-safe.mjs not used)"
fi

# ── TEST 9: behavioral — fix-repair.js mcp on clean file ─────────────────────
TMPDIR_TEST="$(mktemp -d)"
MCP_FILE="$TMPDIR_TEST/.mcp.json"

if CLAWS_REPAIR_TARGET="$MCP_FILE" node --no-deprecation "$FIX_REPAIR_JS" mcp 2>/dev/null; then
  if node -e "const d=JSON.parse(require('fs').readFileSync('$MCP_FILE','utf8')); process.exit(d.mcpServers && d.mcpServers.claws ? 0 : 1)" 2>/dev/null; then
    pass "behavioral mcp: fix-repair.js wrote valid .mcp.json with claws mcpServers entry"
  else
    fail "behavioral mcp: claws mcpServers not found in output"
  fi
else
  fail "behavioral mcp: fix-repair.js exited non-zero on clean file"
fi

# ── TEST 10: behavioral — fix-repair.js extensions on JSONC file ─────────────
EXT_FILE="$TMPDIR_TEST/extensions.json"
cat > "$EXT_FILE" << 'JSONC_EOF'
{
  // existing comment
  "recommendations": ["ms-python.python"]
}
JSONC_EOF

if CLAWS_REPAIR_TARGET="$EXT_FILE" node --no-deprecation "$FIX_REPAIR_JS" extensions 2>/dev/null; then
  if node -e "const d=JSON.parse(require('fs').readFileSync('$EXT_FILE','utf8')); process.exit(d.recommendations&&d.recommendations.includes('neunaha.claws')&&d.recommendations.includes('ms-python.python')?0:1)" 2>/dev/null; then
    pass "behavioral extensions: JSONC preserved, neunaha.claws added, ms-python.python retained"
  else
    fail "behavioral extensions: unexpected content in repaired extensions.json"
  fi
else
  fail "behavioral extensions: fix-repair.js exited non-zero on JSONC file"
fi

rm -rf "$TMPDIR_TEST"

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) fix-mcp-repair check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT fix-mcp-repair checks"
exit 0
