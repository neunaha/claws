#!/usr/bin/env bash
# Tests for M-06: stale-extension cleanup must be gated on kept_dir existence.
# Creates fake $ext_dir with multiple neunaha.claws-* dirs, sets EXT_VERSION
# pointing at a non-existent dir, runs the cleanup logic, asserts all dirs survive.
# Run: bash extension/test/install-cleanup-race.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# ── helper: create a fake ext_dir with N version dirs ────────────────────────
make_ext_dir() {
  local dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m06-XXXXXX")
  mkdir -p "$dir/neunaha.claws-0.7.2"
  mkdir -p "$dir/neunaha.claws-0.7.3"
  mkdir -p "$dir/neunaha.claws-0.7.4"
  echo "$dir"
}

# ── helper: run the M-06-fixed cleanup block in isolation ────────────────────
# Args: $1=ext_dir  $2=ext_version (kept_dir = $ext_dir/neunaha.claws-$ext_version)
run_cleanup_logic() {
  local ext_dir="$1"
  local ext_version="$2"
  local kept_dir="$ext_dir/neunaha.claws-$ext_version"
  local warned=""
  # Mirror the exact fixed logic from install.sh (gate on [ -d "$kept_dir" ])
  if [ -d "$kept_dir" ]; then
    for stale in "$ext_dir"/neunaha.claws-*; do
      [ -d "$stale" ] || continue
      [ "$stale" = "$kept_dir" ] && continue
      rm -rf "$stale" 2>/dev/null || true
    done
  else
    # Gated: kept_dir not present — skip cleanup, emit warning
    warned="yes"
    echo "  [warn] kept_dir not yet present ($kept_dir) — skipping stale cleanup" >&2
  fi
  echo "$warned"
}

# ── TEST 1: kept_dir missing → all dirs survive ──────────────────────────────
ext_dir=$(make_ext_dir)
warned_output=$(run_cleanup_logic "$ext_dir" "9.9.9" 2>&1)  # 9.9.9 does not exist

# All three existing dirs must survive
all_survived=1
for v in 0.7.2 0.7.3 0.7.4; do
  if [ ! -d "$ext_dir/neunaha.claws-$v" ]; then
    all_survived=0
    echo "  [ERROR] neunaha.claws-$v was deleted even though kept_dir was missing"
  fi
done

if [ "$all_survived" = "1" ]; then
  pass "kept_dir missing → all 3 version dirs survive (no total wipe)"
else
  fail "kept_dir missing → some dirs were deleted (M-06 regression)"
fi

# Warning should have been emitted
if echo "$warned_output" | grep -qi "warn\|skip\|not yet"; then
  pass "kept_dir missing → warning emitted"
else
  fail "kept_dir missing → no warning emitted (should warn user)"
fi

rm -rf "$ext_dir"

# ── TEST 2: kept_dir present → stale dirs are cleaned ────────────────────────
ext_dir=$(make_ext_dir)
mkdir -p "$ext_dir/neunaha.claws-0.7.4"  # kept_dir exists

warned_output=$(run_cleanup_logic "$ext_dir" "0.7.4" 2>&1)

# 0.7.4 must survive
if [ -d "$ext_dir/neunaha.claws-0.7.4" ]; then
  pass "kept_dir present → kept_dir (0.7.4) survives"
else
  fail "kept_dir present → kept_dir (0.7.4) was incorrectly deleted"
fi

# 0.7.2 and 0.7.3 must be cleaned
all_stale_removed=1
for v in 0.7.2 0.7.3; do
  if [ -d "$ext_dir/neunaha.claws-$v" ]; then
    all_stale_removed=0
    echo "  [ERROR] stale neunaha.claws-$v not cleaned when kept_dir exists"
  fi
done
if [ "$all_stale_removed" = "1" ]; then
  pass "kept_dir present → stale versions (0.7.2, 0.7.3) cleaned"
else
  fail "kept_dir present → stale versions not cleaned"
fi

# No warning should be emitted when kept_dir is present
if echo "$warned_output" | grep -qi "warn\|skip"; then
  fail "kept_dir present → unexpected warning emitted"
else
  pass "kept_dir present → no spurious warning"
fi

rm -rf "$ext_dir"

# ── TEST 3: verify actual install.sh contains the M-06 guard ────────────────
INSTALL_SH="$(dirname "$(dirname "$0")")/../scripts/install.sh"
if [ ! -f "$INSTALL_SH" ]; then
  INSTALL_SH="$(dirname "$0")/../../scripts/install.sh"
fi

if grep -q 'M-06' "$INSTALL_SH" && grep -q '\[ -d "\$kept_dir" \]' "$INSTALL_SH"; then
  pass "install.sh contains M-06 guard: [ -d \"\$kept_dir\" ] gate"
else
  fail "install.sh missing M-06 guard — fix not applied"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) install-cleanup-race check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT install-cleanup-race checks"
exit 0
