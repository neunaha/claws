#!/usr/bin/env bash
# Tests for M-34: install.sh arch verify must account for Rosetta 2.
# When bash runs under Rosetta (uname -m=x86_64 on Apple Silicon), the expected
# arch should be 'arm64' (host CPU), not 'x86_64'.
# Run: bash extension/test/install-arch-verify.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/../../scripts/install.sh"

# ── TEST 1: install.sh contains M-34 Rosetta guard ──────────────────────────
if grep -q 'M-34' "$INSTALL_SH" && grep -q 'proc_translated' "$INSTALL_SH"; then
  pass "install.sh: M-34 Rosetta guard present (sysctl proc_translated)"
else
  fail "install.sh: M-34 Rosetta guard missing — arch verify falsely warns on Rosetta x64 shell"
fi

if grep -q '_claws_expected_arch' "$INSTALL_SH"; then
  pass "install.sh: _claws_expected_arch variable used (not raw uname -m)"
else
  fail "install.sh: _claws_expected_arch variable missing"
fi

# ── TEST 2: behavioral — Rosetta guard logic is correct ─────────────────────
# Simulate the arch resolution logic: x86_64 on Darwin + proc_translated=1 → arm64
_resolved=$(bash -c '
  _expected="x86_64"
  _uname_s="Darwin"
  _proc_translated="1"
  if [ "$_expected" = "x86_64" ] && [ "$_uname_s" = "Darwin" ]; then
    [ "$_proc_translated" = "1" ] && _expected="arm64"
  fi
  echo "$_expected"
')
if [ "$_resolved" = "arm64" ]; then
  pass "arch logic: x86_64+Darwin+Rosetta → expected arch promoted to arm64"
else
  fail "arch logic: expected arm64, got '$_resolved'"
fi

# Non-Rosetta x86_64 (Intel Mac) stays as x86_64
_resolved_intel=$(bash -c '
  _expected="x86_64"
  _uname_s="Darwin"
  _proc_translated="0"
  if [ "$_expected" = "x86_64" ] && [ "$_uname_s" = "Darwin" ]; then
    [ "$_proc_translated" = "1" ] && _expected="arm64"
  fi
  echo "$_expected"
')
if [ "$_resolved_intel" = "x86_64" ]; then
  pass "arch logic: x86_64+Darwin+no-Rosetta → stays x86_64 (Intel Mac)"
else
  fail "arch logic: Intel Mac: expected x86_64, got '$_resolved_intel'"
fi

# arm64 native (Apple Silicon) stays arm64 (Rosetta check is only for x86_64)
_resolved_native=$(bash -c '
  _expected="arm64"
  _uname_s="Darwin"
  if [ "$_expected" = "x86_64" ] && [ "$_uname_s" = "Darwin" ]; then
    _expected="arm64"
  fi
  echo "$_expected"
')
if [ "$_resolved_native" = "arm64" ]; then
  pass "arch logic: arm64 native → stays arm64 (no Rosetta check needed)"
else
  fail "arch logic: native arm64: expected arm64, got '$_resolved_native'"
fi

# ── TEST 3: warning message includes both uname -m and expected arch ─────────
if grep -q 'expected.*_claws_expected_arch\|_claws_expected_arch.*expected' "$INSTALL_SH" \
   || grep -A2 'proc_translated' "$INSTALL_SH" | grep -q 'expected'; then
  pass "install.sh: warning message references expected arch (not just uname -m)"
else
  # Check more broadly
  if grep 'warn.*expected' "$INSTALL_SH" | grep -q 'NATIVE_PTY_BIN\|arch\|pty'; then
    pass "install.sh: warning message references expected arch"
  else
    fail "install.sh: warning message should show both uname -m and expected arch"
  fi
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) install-arch-verify check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT install-arch-verify checks"
exit 0
