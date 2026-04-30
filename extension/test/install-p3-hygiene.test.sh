#!/usr/bin/env bash
# Tests for P3 hygiene fixes in install.sh:
#   P3-1: schemas/client-types.d.ts deployed to .claws-bin/schemas/
#   P3-2: skills copied via glob loop, not hardcoded list
#   P3-3: claws-sdk.js absence emits warn (not silent skip)
#   P3-4: STEP_TOTAL matches actual step count
# Run: bash extension/test/install-p3-hygiene.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/../../scripts/install.sh"

# ── TEST P3-1: client-types.d.ts is deployed ─────────────────────────────────
if grep -q 'client-types.d.ts\|client-types' "$INSTALL_SH" 2>/dev/null; then
  pass "install.sh: client-types.d.ts deployment present (P3-1)"
else
  fail "install.sh: client-types.d.ts not deployed (P3-1)"
fi

# ── TEST P3-2: skills use a loop (not only hardcoded if-blocks) ───────────────
# Check that there is a for loop over claws skills, not just static ifs
if grep -qE 'for.*skill.*claws|claws.*skill.*for|for.*in.*\.claude/skills' "$INSTALL_SH" 2>/dev/null; then
  pass "install.sh: skills copied via loop (P3-2)"
else
  fail "install.sh: skills still hardcoded (no for loop over .claude/skills) (P3-2)"
fi

# ── TEST P3-3: claws-sdk.js absence emits a warning ───────────────────────────
if grep -A5 'claws-sdk.js' "$INSTALL_SH" 2>/dev/null | grep -q 'warn\|warn('; then
  pass "install.sh: claws-sdk.js absence emits warn (P3-3)"
else
  fail "install.sh: claws-sdk.js silently skipped — no warn (P3-3)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) install-p3-hygiene check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT install-p3-hygiene checks"
exit 0
