#!/usr/bin/env bash
# Tests for M-02: .mcp.json merge uses json-safe helper — never resets on parse error.
# Verifies: JSONC preserved, user's other MCP servers preserved, backup on parse failure.
# Run: bash extension/test/install-mcp-merge.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/../../scripts/install.sh"
HELPER_DIR="$SCRIPT_DIR/../../scripts/_helpers"

# ── helper: run the M-02 merge step directly via mergeIntoFile ───────────────
run_mcp_merge() {
  local mcp_path="$1"
  local project_root="$2"
  node --no-deprecation --input-type=module <<MERGEEOF
import { mergeIntoFile } from '${HELPER_DIR}/json-safe.mjs';
const mcpPath = '${mcp_path}';
const projectRoot = '${project_root}';
const result = await mergeIntoFile(mcpPath, cfg => {
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers.claws = { command: 'node', args: [projectRoot + '/.claws-bin/mcp_server.js'] };
});
if (!result.ok) {
  const e = result.error;
  process.stderr.write('[M-02] .mcp.json merge failed: ' + e.message + '\\n');
  if (e.backupSavedAt) {
    process.stderr.write('[M-02] backup: ' + e.backupSavedAt + '\\n');
  }
  process.exit(1);
}
process.stdout.write('ok\\n');
MERGEEOF
}

# ── TEST 1: valid JSON .mcp.json — other servers preserved ───────────────────
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m02-XXXXXX")
mcp_file="$tmpdir/.mcp.json"
project_root="$tmpdir"

cat > "$mcp_file" <<'MCPEOF'
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
MCPEOF

set +e; output=$(run_mcp_merge "$mcp_file" "$project_root" 2>&1); exit_code=$?; set -e

if [ $exit_code -eq 0 ]; then
  pass "valid JSON merge exits 0"
else
  fail "valid JSON merge exited $exit_code: $output"
fi

# Other MCP servers must be preserved
if node -e "
const f = require('fs').readFileSync('$mcp_file','utf8');
const c = JSON.parse(f);
if (!c.mcpServers.filesystem) { process.stderr.write('filesystem missing\\n'); process.exit(1); }
if (!c.mcpServers.github) { process.stderr.write('github missing\\n'); process.exit(1); }
if (!c.mcpServers.claws) { process.stderr.write('claws missing\\n'); process.exit(1); }
" 2>/dev/null; then
  pass "other MCP servers (filesystem, github) preserved after merge"
  pass "claws entry added"
else
  fail "other MCP servers not preserved — M-02 regression (catastrophic wipe)"
fi

# Claws server must point to correct path
if node -e "
const c = JSON.parse(require('fs').readFileSync('$mcp_file','utf8'));
const args = c.mcpServers.claws.args;
if (!args || !args[0].includes('mcp_server.js')) { process.exit(1); }
" 2>/dev/null; then
  pass "claws mcpServer args point to mcp_server.js"
else
  fail "claws mcpServer args incorrect"
fi

rm -rf "$tmpdir"

# ── TEST 2: JSONC .mcp.json (line comments + trailing comma) — preserved ─────
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m02-jsonc-XXXXXX")
mcp_file="$tmpdir/.mcp.json"
project_root="$tmpdir"

cat > "$mcp_file" <<'MCPEOF'
{
  // This file has JSONC line comments
  "mcpServers": {
    /* block comment here */
    "sentry": {
      "command": "node",
      "args": ["/home/user/sentry-mcp/index.js"],
    },
  },
}
MCPEOF

set +e; output=$(run_mcp_merge "$mcp_file" "$project_root" 2>&1); exit_code=$?; set -e

if [ $exit_code -eq 0 ]; then
  pass "JSONC .mcp.json merge exits 0"
else
  fail "JSONC .mcp.json merge failed (exit $exit_code): $output"
fi

if node -e "
const c = JSON.parse(require('fs').readFileSync('$mcp_file','utf8'));
if (!c.mcpServers.sentry) { process.stderr.write('sentry missing\\n'); process.exit(1); }
if (!c.mcpServers.claws) { process.stderr.write('claws missing\\n'); process.exit(1); }
" 2>/dev/null; then
  pass "sentry server preserved after JSONC merge"
else
  fail "sentry server lost after JSONC merge — M-02 regression"
fi

rm -rf "$tmpdir"

# ── TEST 3: malformed JSON — backup created, original UNCHANGED, exit non-zero
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m02-bad-XXXXXX")
mcp_file="$tmpdir/.mcp.json"
project_root="$tmpdir"

original='{mcpServers: {broken: true}  -- definitely not JSON'
printf '%s' "$original" > "$mcp_file"

set +e; output=$(run_mcp_merge "$mcp_file" "$project_root" 2>&1); exit_code=$?; set -e

if [ $exit_code -ne 0 ]; then
  pass "malformed JSON merge exits non-zero"
else
  fail "malformed JSON merge should exit non-zero but exited 0"
fi

# Original must be UNCHANGED
if [ "$(cat "$mcp_file")" = "$original" ]; then
  pass "original .mcp.json UNCHANGED after parse failure"
else
  fail "original .mcp.json was overwritten on parse failure (M-02 catastrophic wipe)"
fi

# Backup must be created
bak_file=$(ls "${mcp_file}".claws-bak.* 2>/dev/null | head -1)
if [ -n "$bak_file" ] && [ -f "$bak_file" ]; then
  pass "backup file created for malformed .mcp.json"
  if [ "$(cat "$bak_file")" = "$original" ]; then
    pass "backup content matches original malformed content"
  else
    fail "backup content does not match original"
  fi
else
  fail "no backup file created for malformed .mcp.json"
fi

rm -rf "$tmpdir"

# ── TEST 4: verify install.sh uses mergeIntoFile (M-02 applied) ──────────────
if grep -q 'M-02' "$INSTALL_SH" && grep -q 'mergeIntoFile' "$INSTALL_SH"; then
  pass "install.sh uses mergeIntoFile (M-02)"
else
  fail "install.sh missing mergeIntoFile — M-02 not applied"
fi

if grep -q 'json-safe.mjs' "$INSTALL_SH"; then
  pass "install.sh imports json-safe.mjs helper"
else
  fail "install.sh does not import json-safe.mjs"
fi

# The old unsafe try{}catch{} reset in the PROJECT_MCP block must be gone.
# We search for the mergeIntoFile heredoc block which replaced it.
if grep -q 'MCPMERGEEOF' "$INSTALL_SH" 2>/dev/null; then
  pass "install.sh PROJECT_MCP uses mergeIntoFile heredoc (old cfg={} reset removed)"
else
  fail "install.sh PROJECT_MCP block missing mergeIntoFile heredoc (M-02 not applied)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) install-mcp-merge check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT install-mcp-merge checks"
exit 0
