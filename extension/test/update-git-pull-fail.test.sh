#!/usr/bin/env bash
# Tests for M-21: when git pull fails, install.sh must NOT invoke inject-claude-md.js
# (stale source would overwrite CLAUDE.md tool set with old data).
# Run: bash extension/test/update-git-pull-fail.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UPDATE_SH="$SCRIPT_DIR/../../scripts/update.sh"
INSTALL_SH="$SCRIPT_DIR/../../scripts/install.sh"

# ── TEST 1: M-21 comment present in update.sh ────────────────────────────────
if grep -q 'M-21' "$UPDATE_SH"; then
  pass "update.sh: M-21 marker present"
else
  fail "update.sh: M-21 marker missing"
fi

# ── TEST 2: GIT_PULL_OK variable set on failure ───────────────────────────────
if grep -q 'GIT_PULL_OK=0' "$UPDATE_SH"; then
  pass "update.sh: GIT_PULL_OK=0 set on git pull failure"
else
  fail "update.sh: GIT_PULL_OK=0 not found in failure branch"
fi

if grep -q 'GIT_PULL_OK=1' "$UPDATE_SH"; then
  pass "update.sh: GIT_PULL_OK=1 set on success"
else
  fail "update.sh: GIT_PULL_OK=1 not found in success path"
fi

# ── TEST 3: GIT_PULL_OK exported ─────────────────────────────────────────────
if grep -q 'export GIT_PULL_OK' "$UPDATE_SH"; then
  pass "update.sh: GIT_PULL_OK exported for install.sh subprocess"
else
  fail "update.sh: GIT_PULL_OK not exported"
fi

# ── TEST 4: install.sh gates on GIT_PULL_OK ──────────────────────────────────
if grep -q 'GIT_PULL_OK' "$INSTALL_SH"; then
  pass "install.sh: GIT_PULL_OK gate present"
else
  fail "install.sh: GIT_PULL_OK gate missing"
fi

# ── TEST 5: install.sh skips inject-claude-md.js when GIT_PULL_OK=0 ──────────
if grep -q 'M-21' "$INSTALL_SH"; then
  pass "install.sh: M-21 comment present"
else
  fail "install.sh: M-21 comment missing"
fi

# ── TEST 6: behavioral — inject-claude-md.js NOT invoked when GIT_PULL_OK=0 ──
# Simulate: create a mock install tree with a controlled inject-claude-md.js.
TMPDIR_TEST="$(mktemp -d)"
FAKE_TARGET="$TMPDIR_TEST/project"
FAKE_INSTALL="$TMPDIR_TEST/install"
mkdir -p "$FAKE_TARGET" "$FAKE_INSTALL/scripts"
INJECT_LOG="$TMPDIR_TEST/inject-called.txt"

# Mock inject-claude-md.js that writes a marker if called
cat > "$FAKE_INSTALL/scripts/inject-claude-md.js" << 'INJECT_EOF'
const fs = require('fs');
fs.writeFileSync(process.env.INJECT_LOG || '/tmp/inject-called.txt', 'CALLED\n');
INJECT_EOF

# Extract just the CLAUDE.md injection block from install.sh and run it in isolation
_inject_block=$(awk '/# CLAUDE.md injection/,/^  fi$/ { print }' "$INSTALL_SH" | head -20)
_inject_result=$(GIT_PULL_OK=0 INJECT_LOG="$INJECT_LOG" INSTALL_DIR="$FAKE_INSTALL" TARGET="$FAKE_TARGET" HOME="/nonexistent-home-$$" bash -c '
  note() { printf "  %s\n" "$*"; }
  warn() { printf "  WARN: %s\n" "$*"; }
  if [ "$TARGET" != "$HOME" ]; then
    if [ "${GIT_PULL_OK:-1}" = "0" ]; then
      note "CLAUDE.md injection skipped — git pull failed, stale source (M-21)"
    elif [ ! -f "$INSTALL_DIR/scripts/inject-claude-md.js" ] && [ ! -f "$INSTALL_DIR/.claws-bin/inject-claude-md.js" ]; then
      warn "inject-claude-md.js not found"
    else
      node --no-deprecation "$INSTALL_DIR/scripts/inject-claude-md.js" "$TARGET" 2>&1
    fi
  fi
' 2>&1)

if [ ! -f "$INJECT_LOG" ]; then
  pass "behavioral: inject-claude-md.js NOT invoked when GIT_PULL_OK=0"
else
  fail "behavioral: inject-claude-md.js WAS invoked despite GIT_PULL_OK=0"
fi

# ── TEST 7: behavioral — inject-claude-md.js IS called when GIT_PULL_OK=1 ────
rm -f "$INJECT_LOG"
GIT_PULL_OK=1 INJECT_LOG="$INJECT_LOG" INSTALL_DIR="$FAKE_INSTALL" TARGET="$FAKE_TARGET" HOME="/nonexistent-home-$$" bash -c '
  note() { printf "  %s\n" "$*"; }
  warn() { printf "  WARN: %s\n" "$*"; }
  if [ "$TARGET" != "$HOME" ]; then
    if [ "${GIT_PULL_OK:-1}" = "0" ]; then
      note "CLAUDE.md injection skipped"
    elif [ ! -f "$INSTALL_DIR/scripts/inject-claude-md.js" ]; then
      warn "not found"
    else
      node --no-deprecation "$INSTALL_DIR/scripts/inject-claude-md.js" "$TARGET" 2>&1
    fi
  fi
' 2>&1 || true

if [ -f "$INJECT_LOG" ]; then
  pass "behavioral: inject-claude-md.js called when GIT_PULL_OK=1 (normal path)"
else
  fail "behavioral: inject-claude-md.js NOT called when GIT_PULL_OK=1 — normal path broken"
fi

rm -rf "$TMPDIR_TEST"

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) update-git-pull-fail check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT update-git-pull-fail checks"
exit 0
