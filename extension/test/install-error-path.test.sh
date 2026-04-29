#!/usr/bin/env bash
# Tests for F1: node-heredoc error paths fire messages before set-e exit.
# Under set -eo pipefail, `if [ $? -ne 0 ]` after a heredoc is unreachable because
# the shell aborts at the heredoc line when node exits non-zero. The fix wraps each
# heredoc with set+e / capture $? / set-e so the die/warn fires reliably.
# Run: bash extension/test/install-error-path.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/../../scripts/install.sh"

# ── TEST 1: set+e pattern present for M-09 hooks block ───────────────────────
# The M-09 heredoc must be wrapped: set +e ... _hooks_exit=$? ... set -e
if grep -q '_hooks_exit=\$?' "$INSTALL_SH"; then
  pass "install.sh M-09 hooks block uses _hooks_exit capture (F1 applied)"
else
  fail "install.sh M-09 hooks block missing _hooks_exit capture — F1 not applied"
fi

if grep -q '"$_hooks_exit"' "$INSTALL_SH"; then
  pass "install.sh M-09 checks \$_hooks_exit after restoring set -e"
else
  fail "install.sh M-09 does not check \$_hooks_exit after set -e — F1 not applied"
fi

# ── TEST 2: set+e pattern present for M-02 .mcp.json block ───────────────────
if grep -A5 'MCPMERGEEOF' "$INSTALL_SH" | grep -q '_mcp_exit=\$?' || \
   grep -q '_mcp_exit=\$?' "$INSTALL_SH"; then
  pass "install.sh M-02 mcp block uses _mcp_exit capture (F1 applied)"
else
  fail "install.sh M-02 mcp block missing _mcp_exit capture — F1 not applied"
fi

if grep -q '"$_mcp_exit"' "$INSTALL_SH"; then
  pass "install.sh M-02 checks \$_mcp_exit after restoring set -e"
else
  fail "install.sh M-02 does not check \$_mcp_exit after set -e — F1 not applied"
fi

# ── TEST 3: old unreachable pattern is gone ───────────────────────────────────
# The old pattern `if [ $? -ne 0 ]; then` directly after a heredoc is dead code
# under set -eo pipefail. Verify neither the M-02 nor M-09 heredoc block uses it.
# Note: there may be other legitimate uses of `if [ $? -ne 0 ]` elsewhere in
# install.sh — we only check there's no UNREMEDIATED instance adjacent to our
# known heredoc sentinels (MCPMERGEEOF, HOOKSATOMICEOF).
if awk '/MCPMERGEEOF/{found=1} found && /if \[ \$\? -ne 0 \]/{print NR": "$0; exit 1} /MCPMERGEEOF.*end/{found=0}' \
     "$INSTALL_SH" > /dev/null 2>&1; then
  pass "no dead-code if [\$? -ne 0] directly after MCPMERGEEOF heredoc"
else
  fail "dead-code if [\$? -ne 0] found after MCPMERGEEOF — F1 not applied"
fi

if awk '/HOOKSATOMICEOF/{found=1} found && /if \[ \$\? -ne 0 \]/{print NR": "$0; exit 1} /HOOKSATOMICEOF.*end/{found=0}' \
     "$INSTALL_SH" > /dev/null 2>&1; then
  pass "no dead-code if [\$? -ne 0] directly after HOOKSATOMICEOF heredoc"
else
  fail "dead-code if [\$? -ne 0] found after HOOKSATOMICEOF — F1 not applied"
fi

# ── TEST 4: behavioral — simulate a failing node heredoc under set -eo pipefail
# Creates a small bash harness that mimics install.sh's pattern: set +e around
# a node call that exits non-zero, then checks exit code and emits a message.
# Verifies the message is printed (not swallowed by set -e abort).
tmpout=$(mktemp "${TMPDIR:-/tmp}/claws-f1-XXXXXX")

set +e
bash -c '
set -eo pipefail
set +e
node --no-deprecation -e "process.exit(42)"
_exit=$?
set -e
if [ "$_exit" -ne 0 ]; then
  echo "ERRORMSG: node exited $_exit" >&2
fi
exit "$_exit"
' > /dev/null 2>"$tmpout"
_bash_exit=$?
set -e

if [ "$_bash_exit" -ne 0 ]; then
  pass "harness exits non-zero when node fails (exit code propagated)"
else
  fail "harness should exit non-zero but exited 0"
fi

if grep -q 'ERRORMSG' "$tmpout"; then
  pass "error message is printed before set-e exit (F1 pattern works)"
else
  fail "error message was swallowed — set -e killed script before message (F1 not working)"
fi

rm -f "$tmpout"

# ── TEST 5: behavioral — without F1 fix, message would be swallowed ──────────
# Demonstrate the pre-F1 pattern DOES swallow the message (regression detector).
tmpout2=$(mktemp "${TMPDIR:-/tmp}/claws-f1-pre-XXXXXX")

set +e
bash -c '
set -eo pipefail
# PRE-F1 pattern: no set+e wrapper — node exit triggers -e abort
node --no-deprecation -e "process.exit(42)"
if [ $? -ne 0 ]; then
  echo "ERRORMSG: should never print" >&2
fi
' > /dev/null 2>"$tmpout2"
_pre_exit=$?
set -e

if ! grep -q 'ERRORMSG' "$tmpout2"; then
  pass "pre-F1 pattern confirms message is swallowed (validates test correctness)"
else
  fail "pre-F1 pattern unexpectedly printed message — test setup wrong"
fi

rm -f "$tmpout2"

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) install-error-path check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT install-error-path checks (F1 set+e error-path pattern)"
exit 0
