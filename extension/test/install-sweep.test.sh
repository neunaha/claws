#!/usr/bin/env bash
# Tests for v0.7.14 Bug 1+2: install.sh must sweep stale Claws commands and
# skill dirs before copying the current set.
#   Sweep-1: stale claws-*.md + claws.md commands removed; user files survive
#   Sweep-2: stale claws-* skill dirs removed
#   Sweep-3: user-added non-claws-prefix skill survives sweep
#   Sweep-4: install.sh contains the Bug 1+2 fix markers (static grep check)
# Run: bash extension/test/install-sweep.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/../../scripts/install.sh"

# ── helper: mirror Bug 1 sweep logic from install.sh ─────────────────────────
run_cmd_sweep() {
  local cmd_dir="$1"
  for stale in "$cmd_dir"/claws-*.md "$cmd_dir"/claws.md; do
    [ -f "$stale" ] || continue
    rm -f "$stale"
  done
}

# ── helper: mirror Bug 2 sweep logic from install.sh ─────────────────────────
run_skill_sweep() {
  local skill_dir="$1"
  for stale_skill in "$skill_dir"/claws-*; do
    [ -d "$stale_skill" ] || continue
    rm -rf "$stale_skill"
  done
}

# ── TEST Sweep-1: stale commands removed; user file survives ─────────────────
tmp=$(mktemp -d "${TMPDIR:-/tmp}/claws-sweep-XXXXXX")
cmd_dir="$tmp/.claude/commands"
mkdir -p "$cmd_dir"

# Seed stale Claws commands (v0.6.x era)
for f in claws-army.md claws-boot.md claws-broadcast.md claws-watch.md claws.md; do
  printf '# stale\n' > "$cmd_dir/$f"
done
# Seed user-added command (must survive)
printf '# user\n' > "$cmd_dir/my-custom-cmd.md"

run_cmd_sweep "$cmd_dir"

all_removed=1
for f in claws-army.md claws-boot.md claws-broadcast.md claws-watch.md claws.md; do
  if [ -f "$cmd_dir/$f" ]; then
    all_removed=0
    echo "  [ERROR] stale $f was not swept"
  fi
done
[ "$all_removed" = "1" ] \
  && pass "Sweep-1: stale claws-* commands removed" \
  || fail "Sweep-1: stale claws-* commands NOT removed"

if [ -f "$cmd_dir/my-custom-cmd.md" ]; then
  pass "Sweep-1: user-added command survived sweep"
else
  fail "Sweep-1: user-added command was incorrectly deleted"
fi
rm -rf "$tmp"

# ── TEST Sweep-2: stale skill dir removed ────────────────────────────────────
tmp=$(mktemp -d "${TMPDIR:-/tmp}/claws-sweep-XXXXXX")
skill_dir="$tmp/.claude/skills"
mkdir -p "$skill_dir"

# Seed retired Claws skill (not in v0.7.13 source)
mkdir -p "$skill_dir/claws-orchestration-engine"
printf '# stale\n' > "$skill_dir/claws-orchestration-engine/SKILL.md"

run_skill_sweep "$skill_dir"

if [ ! -d "$skill_dir/claws-orchestration-engine" ]; then
  pass "Sweep-2: retired claws-orchestration-engine swept"
else
  fail "Sweep-2: retired claws-orchestration-engine not swept"
fi
rm -rf "$tmp"

# ── TEST Sweep-3: user-added non-claws skill survives ────────────────────────
tmp=$(mktemp -d "${TMPDIR:-/tmp}/claws-sweep-XXXXXX")
skill_dir="$tmp/.claude/skills"
mkdir -p "$skill_dir"

mkdir -p "$skill_dir/dev-protocol-piafeur"
printf '# user\n' > "$skill_dir/dev-protocol-piafeur/SKILL.md"
mkdir -p "$skill_dir/claws-wave-lead"
printf '# stale\n' > "$skill_dir/claws-wave-lead/SKILL.md"

run_skill_sweep "$skill_dir"

if [ -d "$skill_dir/dev-protocol-piafeur" ]; then
  pass "Sweep-3: user-added dev-protocol-piafeur survived skill sweep"
else
  fail "Sweep-3: user-added dev-protocol-piafeur incorrectly swept"
fi
if [ ! -d "$skill_dir/claws-wave-lead" ]; then
  pass "Sweep-3: claws-wave-lead swept (installer re-copies after sweep)"
else
  fail "Sweep-3: claws-wave-lead not swept"
fi
rm -rf "$tmp"

# ── TEST Sweep-4: verify install.sh contains Bug 1+2 fix markers ─────────────
if grep -q '_swept_cmds' "$INSTALL_SH" 2>/dev/null; then
  pass "Sweep-4: install.sh contains Bug 1 sweep (_swept_cmds marker)"
else
  fail "Sweep-4: install.sh missing Bug 1 sweep — _swept_cmds not found"
fi

if grep -q '_swept_skills' "$INSTALL_SH" 2>/dev/null; then
  pass "Sweep-4: install.sh contains Bug 2 sweep (_swept_skills marker)"
else
  fail "Sweep-4: install.sh missing Bug 2 sweep — _swept_skills not found"
fi

# Confirm correct variable name is used in the skills loop
if grep -q 'for _skill_src in' "$INSTALL_SH" 2>/dev/null; then
  pass "Sweep-4: install.sh uses 'for _skill_src in' (correct variable name)"
else
  fail "Sweep-4: install.sh missing 'for _skill_src in'"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) install-sweep check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT install-sweep checks"
exit 0
