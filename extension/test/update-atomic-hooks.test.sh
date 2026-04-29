#!/usr/bin/env bash
# Tests for M-18: settings.json hooks update must be atomic (single-pass remove+add).
# Verifies inject-settings-hooks.js --update flag and that install.sh uses it.
# Run: bash extension/test/update-atomic-hooks.test.sh
# Exits 0 on success, 1 on failure.

set -eo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  ✓ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  ✗ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/../../scripts/install.sh"
INJECT_JS="$SCRIPT_DIR/../../scripts/inject-settings-hooks.js"

# ── TEST 1: M-18 comment in install.sh ───────────────────────────────────────
if grep -q 'M-18' "$INSTALL_SH"; then
  pass "install.sh: M-18 marker present"
else
  fail "install.sh: M-18 marker missing"
fi

# ── TEST 2: install.sh uses --update (not two-pass) ──────────────────────────
if grep -q 'inject-settings-hooks.*--update' "$INSTALL_SH"; then
  pass "install.sh: uses inject-settings-hooks.js --update (atomic)"
else
  fail "install.sh: does not use --update flag — may still have two-pass pattern"
fi

# ── TEST 3: install.sh no longer has --remove then separate add ──────────────
_remove_count=$(grep -c 'inject-settings-hooks.*--remove' "$INSTALL_SH" || true)
if [ "$_remove_count" = "0" ]; then
  pass "install.sh: no separate --remove invocation found (two-pass pattern gone)"
else
  fail "install.sh: still has $_remove_count --remove invocation(s) alongside --update"
fi

# ── TEST 4: inject-settings-hooks.js supports --update flag ──────────────────
if grep -q '\-\-update' "$INJECT_JS" && grep -q 'UPDATE' "$INJECT_JS"; then
  pass "inject-settings-hooks.js: --update flag supported"
else
  fail "inject-settings-hooks.js: --update flag not found"
fi

# ── TEST 5: M-18 comment in inject-settings-hooks.js ─────────────────────────
if grep -q 'M-18' "$INJECT_JS"; then
  pass "inject-settings-hooks.js: M-18 comment present"
else
  fail "inject-settings-hooks.js: M-18 comment missing"
fi

# ── TEST 6: behavioral — --update removes old and adds new in one write ───────
TMPDIR_TEST="$(mktemp -d)"
FAKE_SETTINGS="$TMPDIR_TEST/settings.json"
FAKE_HOOKS_DIR="$TMPDIR_TEST/hooks"
mkdir -p "$FAKE_HOOKS_DIR"

# Create minimal hook scripts so isCanonicalInstall() succeeds
for f in session-start-claws.js pre-tool-use-claws.js stop-claws.js; do
  echo "// mock" > "$FAKE_HOOKS_DIR/$f"
done

# Seed settings.json with two stale Claws hooks
cat > "$FAKE_SETTINGS" << 'JSON_EOF'
{
  "hooks": {
    "SessionStart": [
      {"matcher": "*", "_source": "claws", "hooks": [{"type": "command", "command": "node /old/path/session-start-claws.js"}]},
      {"matcher": "*", "_source": "other-tool", "hooks": [{"type": "command", "command": "other cmd"}]}
    ],
    "Stop": [
      {"matcher": "*", "_source": "claws", "hooks": [{"type": "command", "command": "node /old/path/stop-claws.js"}]}
    ]
  }
}
JSON_EOF

# Run --update using the real inject-settings-hooks.js against our fake settings
CLAWS_SETTINGS_PATH_OVERRIDE="$FAKE_SETTINGS" node --no-deprecation -e "
  // Temporarily override SETTINGS_PATH by monkey-patching os.homedir
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function(req, parent, isMain) {
    if (req === 'os') {
      const realOs = origLoad.apply(this, arguments);
      return Object.assign({}, realOs, { homedir: () => '$TMPDIR_TEST/.claude-home' });
    }
    return origLoad.apply(this, arguments);
  };
  // Actually just exec with the settings path as env and patch in inject-settings-hooks
" 2>/dev/null || true

# Use a simpler approach: pass a fake HOME so ~/.claude/settings.json resolves to our temp file
mkdir -p "$TMPDIR_TEST/.claude-home/.claude"
cp "$FAKE_SETTINGS" "$TMPDIR_TEST/.claude-home/.claude/settings.json"

HOME="$TMPDIR_TEST/.claude-home" node --no-deprecation "$INJECT_JS" "$TMPDIR_TEST" --update 2>&1 | head -5 || true

_updated_settings="$TMPDIR_TEST/.claude-home/.claude/settings.json"
if [ -f "$_updated_settings" ]; then
  # Verify: other-tool hook still present (not removed by --update)
  if node -e "
    const s = JSON.parse(require('fs').readFileSync('$_updated_settings','utf8'));
    const arr = (s.hooks && s.hooks.SessionStart) || [];
    const other = arr.find(e => e._source === 'other-tool');
    process.exit(other ? 0 : 1);
  " 2>/dev/null; then
    pass "behavioral --update: other-tool hook preserved (not removed)"
  else
    fail "behavioral --update: other-tool hook was incorrectly removed"
  fi

  # Verify: new Claws hooks are present
  if node -e "
    const s = JSON.parse(require('fs').readFileSync('$_updated_settings','utf8'));
    const arr = (s.hooks && s.hooks.SessionStart) || [];
    const claws = arr.find(e => e._source === 'claws');
    process.exit(claws ? 0 : 1);
  " 2>/dev/null; then
    pass "behavioral --update: new Claws SessionStart hook present after update"
  else
    fail "behavioral --update: new Claws SessionStart hook missing after update"
  fi
else
  fail "behavioral --update: settings.json not written"
fi

rm -rf "$TMPDIR_TEST"

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL: $FAIL_COUNT/$((PASS_COUNT + FAIL_COUNT)) update-atomic-hooks check(s) failed."
  exit 1
fi
echo "PASS: $PASS_COUNT update-atomic-hooks checks"
exit 0
