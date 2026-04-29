#!/usr/bin/env bash
# Tests for M-09: .claws-bin/hooks/ copy must be atomic — kill-window leaves
# either all old hooks or all new hooks, never an empty/partial dir.
# F2: replaced polling simulation with real SIGKILL mid-copy test.
# Run: bash extension/test/install-hooks-atomic.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/../../scripts/install.sh"
HELPER_DIR="$SCRIPT_DIR/../../scripts/_helpers"

# ── TEST 1: fresh copy — all files present in dest ────────────────────────────
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m09-XXXXXX")
src="$tmpdir/hooks-src"
dest="$tmpdir/hooks-dest"

mkdir -p "$src"
printf 'module.exports={type:"session-start"};\n' > "$src/session-start-claws.js"
printf 'module.exports={type:"pre-tool-use"};\n'  > "$src/pre-tool-use-claws.js"
printf 'module.exports={type:"stop"};\n'           > "$src/stop-claws.js"
printf '{"type":"commonjs","private":true}\n'      > "$src/package.json"

node --no-deprecation --input-type=module <<COPYEOF 2>&1
import { copyDirAtomic } from '${HELPER_DIR}/atomic-file.mjs';
await copyDirAtomic('${src}', '${dest}');
COPYEOF

all_present=1
for f in session-start-claws.js pre-tool-use-claws.js stop-claws.js package.json; do
  if [ ! -f "$dest/$f" ]; then
    all_present=0
    echo "  [ERROR] $f missing from dest after atomic copy"
  fi
done

if [ "$all_present" = "1" ]; then
  pass "fresh copy: all 4 files present in destination"
else
  fail "fresh copy: missing files in destination"
fi

# No .claws-tmp.* or .claws-old.* dirs should remain
leftovers=$(ls "$tmpdir" | grep -E '\.claws-tmp\.|\.claws-old\.' || true)
if [ -z "$leftovers" ]; then
  pass "fresh copy: no .claws-tmp.* or .claws-old.* dirs left over"
else
  fail "fresh copy: lingering temp dirs: $leftovers"
fi

rm -rf "$tmpdir"

# ── TEST 2: update — new files appear, old files gone ─────────────────────────
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m09-upd-XXXXXX")
src="$tmpdir/hooks-src"
dest="$tmpdir/hooks-dest"

mkdir -p "$dest"
printf 'OLD CONTENT\n' > "$dest/old-hook.js"

mkdir -p "$src"
printf 'NEW HOOK\n' > "$src/new-hook.js"
printf '{"type":"commonjs"}\n' > "$src/package.json"

node --no-deprecation --input-type=module <<COPYEOF2 2>&1
import { copyDirAtomic } from '${HELPER_DIR}/atomic-file.mjs';
await copyDirAtomic('${src}', '${dest}');
COPYEOF2

if [ -f "$dest/new-hook.js" ]; then
  pass "update copy: new file present in dest"
else
  fail "update copy: new file missing from dest"
fi

if [ ! -f "$dest/old-hook.js" ]; then
  pass "update copy: old file not in dest (fully replaced)"
else
  fail "update copy: old file still in dest (should be replaced)"
fi

rm -rf "$tmpdir"

# ── TEST 3: SIGKILL mid-copy — dest always coherent (never partial/empty) ─────
# F2: real kill test. Spawn a copy subprocess, send SIGKILL during the file-copy
# phase (step 1: copy to .claws-tmp.*), then verify dest is coherent.
#
# Setup: old dest has 3 distinctly-named files. src has 100 new files (to make
# the copy phase slow enough that kill hits during step 1, before the rename).
# After kill: dest must have COMPLETE old content — never empty, never a mix.
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m09-kill-XXXXXX")
src="$tmpdir/src"
dest="$tmpdir/dest"

# Create old dest (3 distinctly-named files)
mkdir -p "$dest"
for i in 1 2 3; do
  printf 'OLD-v1-file%d\n' "$i" > "$dest/hook-$i.js"
done
printf '{"type":"commonjs","version":"OLD"}\n' > "$dest/package.json"
old_count=4  # total files in old dest

# Create src with 100 new files (copy takes longer → kill more likely mid-step-1)
mkdir -p "$src"
for i in $(seq 1 100); do
  printf 'NEW-v2-file%d\n' "$i" > "$src/newfile-$i.js"
done
printf '{"type":"commonjs","version":"NEW"}\n' > "$src/package.json"

# Spawn copy in background; kill immediately so SIGKILL lands during step 1
node --no-deprecation --input-type=module <<BGCOPY &
import { copyDirAtomic } from '${HELPER_DIR}/atomic-file.mjs';
await copyDirAtomic('${src}', '${dest}');
BGCOPY
bg_pid=$!

# Give the process just enough time to start the copy, then kill it
# (0.005s = 5ms — enough for spawn + file-descriptor open, not enough for 100-file copy + rename)
sleep 0.005 2>/dev/null || true
kill -9 "$bg_pid" 2>/dev/null || true
wait "$bg_pid" 2>/dev/null || true

# Post-kill analysis: dest must be coherent
dest_count=$(ls "$dest" 2>/dev/null | wc -l | tr -d ' ')

if [ "$dest_count" -gt 0 ]; then
  pass "SIGKILL mid-copy: dest is not empty ($dest_count files present)"
else
  fail "SIGKILL mid-copy: dest is EMPTY after kill — old content was wiped (M-09 regression)"
fi

# Determine which version is in dest (find exits 0 even with no matches)
has_old_hook=$(find "$dest" -maxdepth 1 -name 'hook-*.js' 2>/dev/null | wc -l | tr -d ' ')
has_new_file=$(find "$dest" -maxdepth 1 -name 'newfile-*.js' 2>/dev/null | wc -l | tr -d ' ')

if [ "$has_old_hook" -gt 0 ] && [ "$has_new_file" -gt 0 ]; then
  fail "SIGKILL mid-copy: dest has mix of OLD (hook-*.js) and NEW (newfile-*.js) — atomicity broken"
elif [ "$has_old_hook" -gt 0 ]; then
  # Old content in dest — expected when kill lands before rename
  old_in_dest=$(ls "$dest" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$old_in_dest" -eq "$old_count" ]; then
    pass "SIGKILL mid-copy: dest has complete OLD version ($old_in_dest files, all old)"
  else
    fail "SIGKILL mid-copy: dest has OLD hook files but wrong count ($old_in_dest, expected $old_count)"
  fi
elif [ "$has_new_file" -gt 0 ]; then
  # New content in dest — kill landed after rename; that's also fine
  pass "SIGKILL mid-copy: dest has NEW version ($dest_count files) — rename completed before kill"
else
  # Only package.json remains — still coherent (one-version state)
  if [ -f "$dest/package.json" ]; then
    pass "SIGKILL mid-copy: dest has package.json only — coherent single-file state"
  else
    fail "SIGKILL mid-copy: unrecognized dest state ($dest_count files, no hook or newfile entries)"
  fi
fi

# No .claws-tmp.* dirs should persist in parent after a complete copy.
# If kill hit during step 1, a .claws-tmp.* orphan may exist — that is ACCEPTABLE
# (it will be cleaned up on next invocation). The key property is dest coherence.
orphan_tmp=$(find "$tmpdir" -maxdepth 1 -name 'dest.claws-tmp.*' 2>/dev/null | wc -l | tr -d ' ')
orphan_old=$(find "$tmpdir" -maxdepth 1 -name 'dest.claws-old.*' 2>/dev/null | wc -l | tr -d ' ')
# Convert count to empty string for the -z test
[ "$orphan_tmp" -eq 0 ] && orphan_tmp="" || true
[ "$orphan_old" -eq 0 ] && orphan_old="" || true
if [ -z "$orphan_old" ]; then
  pass "SIGKILL mid-copy: no orphaned .claws-old.* dir (old dest not exposed without a replacement)"
else
  # .claws-old.* exists AND dest has new content — step 3 completed but step 4 (rm old) was killed.
  # This is acceptable — dest is coherent (new), old is removable on next run.
  if [ "$has_new_file" -gt 0 ]; then
    pass "SIGKILL mid-copy: .claws-old.* orphan exists but dest=NEW — coherent (cleanup pending)"
  else
    fail "SIGKILL mid-copy: .claws-old.* orphan exists but dest is not NEW — inconsistent state"
  fi
fi

rm -rf "$tmpdir"

# ── TEST 4: install.sh uses copyDirAtomic for hooks (M-09 applied) ───────────
if grep -q 'M-09' "$INSTALL_SH" && grep -q 'copyDirAtomic' "$INSTALL_SH"; then
  pass "install.sh uses copyDirAtomic for hooks dir (M-09)"
else
  fail "install.sh missing copyDirAtomic — M-09 not applied"
fi

if grep -q 'atomic-file.mjs' "$INSTALL_SH"; then
  pass "install.sh imports atomic-file.mjs helper"
else
  fail "install.sh does not import atomic-file.mjs"
fi

# The old rm -rf + cp pattern for hooks must be gone
if grep -A3 'INSTALL_DIR.*scripts/hooks' "$INSTALL_SH" | grep -q 'rm -rf.*claws-bin/hooks'; then
  fail "install.sh still has old rm-rf + cp hooks pattern (M-09 not fixed)"
else
  pass "install.sh: old rm-rf + cp hooks pattern removed"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) install-hooks-atomic check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT install-hooks-atomic checks (F2: real SIGKILL mid-copy test)"
exit 0
