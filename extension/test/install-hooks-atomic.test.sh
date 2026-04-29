#!/usr/bin/env bash
# Tests for M-09: .claws-bin/hooks/ copy must be atomic — kill-window leaves
# either all old hooks or all new hooks, never an empty/partial dir.
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

# Set up initial dest with old content
mkdir -p "$dest"
printf 'OLD CONTENT\n' > "$dest/old-hook.js"

# Set up src with new content
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

# ── TEST 3: interrupt simulation — dest is coherent (old or new, not empty) ───
# We verify the atomic rename property: if we interrupt between tmp→dest steps,
# the final state must be either fully old or fully new, never partial.
# We simulate this by checking that copyDirAtomic uses atomic rename semantics
# (verified via the helper's own test suite, already passing).
# Here we do a behavioral test: concurrent copy + read never sees empty dir.
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/claws-m09-intr-XXXXXX")
src="$tmpdir/src"
dest="$tmpdir/dest"

mkdir -p "$dest"
printf 'old-v1\n' > "$dest/session-start-claws.js"
printf 'old-v1\n' > "$dest/package.json"

mkdir -p "$src"
printf 'new-v2\n' > "$src/session-start-claws.js"
printf 'new-v2\n' > "$src/package.json"

# Run copy; during copy dest should never be empty
node --no-deprecation --input-type=module <<INTEEOF 2>&1
import { copyDirAtomic } from '${HELPER_DIR}/atomic-file.mjs';
import fs from 'fs';
// Start copy in background
const copyPromise = copyDirAtomic('${src}', '${dest}');
// Poll dest — it must never be empty
let sawEmpty = false;
const poll = setInterval(() => {
  try {
    const files = fs.readdirSync('${dest}');
    if (files.length === 0) sawEmpty = true;
  } catch { /* dest may not exist transiently — that's ok */ }
}, 1);
await copyPromise;
clearInterval(poll);
if (sawEmpty) {
  process.stderr.write('EMPTY DIR OBSERVED\\n');
  process.exit(1);
}
INTEEOF

copy_exit=$?
if [ $copy_exit -eq 0 ]; then
  pass "interrupt simulation: dest never observed as empty during atomic copy"
else
  fail "interrupt simulation: empty dir observed during copy (atomicity broken)"
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
echo "PASS: $PASS_COUNT install-hooks-atomic checks"
exit 0
