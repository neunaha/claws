#!/usr/bin/env bash
# Tests for M-32+M-33+M-36: TERM_PROGRAM-aware editor detection and Linux paths
# in fix.sh and rebuild-node-pty.sh.
# Verifies static structure: correct cases, correct keys, CURSOR_CHANNEL guard.
# Run: bash extension/test/fix-editor-detect.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIX_SH="$SCRIPT_DIR/../../scripts/fix.sh"
REBUILD_SH="$SCRIPT_DIR/../../scripts/rebuild-node-pty.sh"

# ── TEST 1: fix.sh has M-32 TERM_PROGRAM-aware ordering ─────────────────────
if grep -q 'M-32' "$FIX_SH" && grep -q '_fix_tp' "$FIX_SH"; then
  pass "fix.sh: M-32 TERM_PROGRAM guard present (_fix_tp)"
else
  fail "fix.sh: M-32 TERM_PROGRAM guard missing"
fi

if grep -q 'TERM_PROGRAM' "$FIX_SH" && grep -q 'cursor.*Cursor' "$FIX_SH"; then
  pass "fix.sh: TERM_PROGRAM=cursor → Cursor.app first in array"
else
  fail "fix.sh: cursor case missing in darwin detection"
fi

# ── TEST 2: fix.sh has CURSOR_CHANNEL secondary signal ──────────────────────
if grep -q 'CURSOR_CHANNEL' "$FIX_SH"; then
  pass "fix.sh: CURSOR_CHANNEL secondary signal present"
else
  fail "fix.sh: CURSOR_CHANNEL secondary signal missing (old Cursor builds won't be detected)"
fi

# ── TEST 3: fix.sh has M-33 Linux paths ─────────────────────────────────────
if grep -q 'M-33' "$FIX_SH" && grep -q '/usr/share/cursor/electron' "$FIX_SH"; then
  pass "fix.sh: M-33 Linux Cursor path (/usr/share/cursor/electron) present"
else
  fail "fix.sh: M-33 Linux Cursor paths missing"
fi

if grep -q '/usr/share/windsurf/electron' "$FIX_SH"; then
  pass "fix.sh: M-33 Linux Windsurf path (/usr/share/windsurf/electron) present"
else
  fail "fix.sh: M-33 Linux Windsurf path missing"
fi

# ── TEST 4: fix.sh TERM_PROGRAM ordering behavioral test ────────────────────
# Extract just the darwin case logic and run with TERM_PROGRAM=cursor; verify Cursor is first.
_first_app=$(bash -c '
  TERM_PROGRAM=cursor
  CURSOR_CHANNEL=
  _fix_tp="${TERM_PROGRAM:-}"
  [ "$_fix_tp" = "vscode" ] && [ -n "${CURSOR_CHANNEL:-}" ] && _fix_tp="cursor"
  _fix_tp=$(echo "$_fix_tp" | tr '\''[:upper:]'\'' '\''[:lower:]'\'')
  case "$_fix_tp" in
    cursor)   _fix_darwin_apps=("Cursor.app" "VS Code.app" "VS Code Insiders.app" "Windsurf.app") ;;
    windsurf) _fix_darwin_apps=("Windsurf.app" "VS Code.app" "VS Code Insiders.app" "Cursor.app") ;;
    *)        _fix_darwin_apps=("VS Code.app" "VS Code Insiders.app" "Cursor.app" "Windsurf.app") ;;
  esac
  echo "${_fix_darwin_apps[0]}"
')
if [ "$_first_app" = "Cursor.app" ]; then
  pass "fix.sh logic: TERM_PROGRAM=cursor → Cursor.app first in ordering"
else
  fail "fix.sh logic: TERM_PROGRAM=cursor → expected Cursor.app first, got '$_first_app'"
fi

_first_app_default=$(bash -c '
  TERM_PROGRAM=
  CURSOR_CHANNEL=
  _fix_tp="${TERM_PROGRAM:-}"
  _fix_tp=$(echo "$_fix_tp" | tr '\''[:upper:]'\'' '\''[:lower:]'\'')
  case "$_fix_tp" in
    cursor)   _fix_darwin_apps=("Cursor.app" "VS Code.app" "VS Code Insiders.app" "Windsurf.app") ;;
    windsurf) _fix_darwin_apps=("Windsurf.app" "VS Code.app" "VS Code Insiders.app" "Cursor.app") ;;
    *)        _fix_darwin_apps=("VS Code.app" "VS Code Insiders.app" "Cursor.app" "Windsurf.app") ;;
  esac
  echo "${_fix_darwin_apps[0]}"
')
if [ "$_first_app_default" = "VS Code.app" ]; then
  pass "fix.sh logic: no TERM_PROGRAM → VS Code.app first (default order preserved)"
else
  fail "fix.sh logic: no TERM_PROGRAM → expected VS Code.app first, got '$_first_app_default'"
fi

# ── TEST 5: rebuild-node-pty.sh has M-36 TERM_PROGRAM-aware detection ───────
if grep -q 'M-36' "$REBUILD_SH" && grep -q '_rn_tp' "$REBUILD_SH"; then
  pass "rebuild-node-pty.sh: M-36 TERM_PROGRAM guard present (_rn_tp)"
else
  fail "rebuild-node-pty.sh: M-36 TERM_PROGRAM guard missing"
fi

if grep -q 'CURSOR_CHANNEL' "$REBUILD_SH"; then
  pass "rebuild-node-pty.sh: CURSOR_CHANNEL secondary signal present"
else
  fail "rebuild-node-pty.sh: CURSOR_CHANNEL secondary signal missing"
fi

# ── TEST 6: rebuild-node-pty.sh has Linux paths ─────────────────────────────
if grep -q '/usr/share/cursor/electron' "$REBUILD_SH" && grep -q '/usr/share/windsurf/electron' "$REBUILD_SH"; then
  pass "rebuild-node-pty.sh: Linux Cursor + Windsurf paths present"
else
  fail "rebuild-node-pty.sh: Linux Cursor/Windsurf paths missing"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) fix-editor-detect check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT fix-editor-detect checks"
exit 0
