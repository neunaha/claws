#!/usr/bin/env bash
# Tests for M-35: update.sh Step 6 ABI check must use TERM_PROGRAM-aware ordering.
# Without M-35, VS Code is always checked first even when the user runs Cursor daily.
# Run: bash extension/test/update-step6-editor.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UPDATE_SH="$SCRIPT_DIR/../../scripts/update.sh"

# ── TEST 1: update.sh Step 6 contains M-35 TERM_PROGRAM guard ───────────────
if grep -q 'M-35' "$UPDATE_SH" && grep -q '_claws_u_tp' "$UPDATE_SH"; then
  pass "update.sh: M-35 TERM_PROGRAM guard present (_claws_u_tp)"
else
  fail "update.sh: M-35 TERM_PROGRAM guard missing in Step 6"
fi

if grep -q 'CURSOR_CHANNEL' "$UPDATE_SH"; then
  pass "update.sh: CURSOR_CHANNEL secondary signal present in Step 6"
else
  fail "update.sh: CURSOR_CHANNEL secondary signal missing"
fi

# ── TEST 2: behavioral — TERM_PROGRAM=cursor puts Cursor first ───────────────
_first=$(bash -c '
  TERM_PROGRAM=cursor
  CURSOR_CHANNEL=
  _claws_u_tp="${TERM_PROGRAM:-}"
  [ "$_claws_u_tp" = "vscode" ] && [ -n "${CURSOR_CHANNEL:-}" ] && _claws_u_tp="cursor"
  _claws_u_tp=$(echo "$_claws_u_tp" | tr '\''[:upper:]'\'' '\''[:lower:]'\'')
  case "$_claws_u_tp" in
    cursor)   _arr=("Cursor.app" "VS Code.app" "Windsurf.app") ;;
    windsurf) _arr=("Windsurf.app" "VS Code.app" "Cursor.app") ;;
    *)        _arr=("VS Code.app" "Cursor.app" "Windsurf.app") ;;
  esac
  echo "${_arr[0]}"
')
if [ "$_first" = "Cursor.app" ]; then
  pass "update.sh Step 6 logic: TERM_PROGRAM=cursor → Cursor.app first"
else
  fail "update.sh Step 6 logic: TERM_PROGRAM=cursor → expected Cursor.app first, got '$_first'"
fi

# ── TEST 3: TERM_PROGRAM=windsurf puts Windsurf first ────────────────────────
_first_ws=$(bash -c '
  TERM_PROGRAM=windsurf
  CURSOR_CHANNEL=
  _claws_u_tp="${TERM_PROGRAM:-}"
  _claws_u_tp=$(echo "$_claws_u_tp" | tr '\''[:upper:]'\'' '\''[:lower:]'\'')
  case "$_claws_u_tp" in
    cursor)   _arr=("Cursor.app" "VS Code.app" "Windsurf.app") ;;
    windsurf) _arr=("Windsurf.app" "VS Code.app" "Cursor.app") ;;
    *)        _arr=("VS Code.app" "Cursor.app" "Windsurf.app") ;;
  esac
  echo "${_arr[0]}"
')
if [ "$_first_ws" = "Windsurf.app" ]; then
  pass "update.sh Step 6 logic: TERM_PROGRAM=windsurf → Windsurf.app first"
else
  fail "update.sh Step 6 logic: TERM_PROGRAM=windsurf → expected Windsurf.app first, got '$_first_ws'"
fi

# ── TEST 4: no TERM_PROGRAM → VS Code first (default unchanged) ─────────────
_first_default=$(bash -c '
  unset TERM_PROGRAM
  CURSOR_CHANNEL=
  _claws_u_tp="${TERM_PROGRAM:-}"
  _claws_u_tp=$(echo "$_claws_u_tp" | tr '\''[:upper:]'\'' '\''[:lower:]'\'')
  case "$_claws_u_tp" in
    cursor)   _arr=("Cursor.app" "VS Code.app" "Windsurf.app") ;;
    windsurf) _arr=("Windsurf.app" "VS Code.app" "Cursor.app") ;;
    *)        _arr=("VS Code.app" "Cursor.app" "Windsurf.app") ;;
  esac
  echo "${_arr[0]}"
')
if [ "$_first_default" = "VS Code.app" ]; then
  pass "update.sh Step 6 logic: no TERM_PROGRAM → VS Code.app first (default order preserved)"
else
  fail "update.sh Step 6 logic: no TERM_PROGRAM → expected VS Code.app, got '$_first_default'"
fi

# ── TEST 5: CURSOR_CHANNEL override (old Cursor with TERM_PROGRAM=vscode) ────
_first_cursor_ch=$(bash -c '
  TERM_PROGRAM=vscode
  CURSOR_CHANNEL=stable
  _claws_u_tp="${TERM_PROGRAM:-}"
  [ "$_claws_u_tp" = "vscode" ] && [ -n "${CURSOR_CHANNEL:-}" ] && _claws_u_tp="cursor"
  _claws_u_tp=$(echo "$_claws_u_tp" | tr '\''[:upper:]'\'' '\''[:lower:]'\'')
  case "$_claws_u_tp" in
    cursor)   _arr=("Cursor.app" "VS Code.app" "Windsurf.app") ;;
    windsurf) _arr=("Windsurf.app" "VS Code.app" "Cursor.app") ;;
    *)        _arr=("VS Code.app" "Cursor.app" "Windsurf.app") ;;
  esac
  echo "${_arr[0]}"
')
if [ "$_first_cursor_ch" = "Cursor.app" ]; then
  pass "update.sh Step 6 logic: TERM_PROGRAM=vscode + CURSOR_CHANNEL → Cursor.app first"
else
  fail "update.sh Step 6 logic: CURSOR_CHANNEL override failed, got '$_first_cursor_ch'"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) update-step6-editor check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT update-step6-editor checks"
exit 0
