#!/usr/bin/env bash
# TDD RED: synthetically tests each of the 5 dev hook scripts in scripts/dev-hooks/.
# Implementations do not exist yet — tests will fail until scripts/dev-hooks/*.js exist.
# Each hook must: exit 0 (never crash), write /tmp/claws-dev-hooks.log on error.
# Run: bash extension/test/dev-hook-misfire.test.sh
# Exits 0 on all pass, 1 on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEV_HOOKS_DIR="$REPO_ROOT/scripts/dev-hooks"

DEV_LOG="/tmp/claws-dev-hooks.log"

PASS=0
FAIL=0

assert_pass() {
  local label="$1"
  PASS=$((PASS + 1))
  echo "PASS — $label"
}

assert_fail() {
  local label="$1"
  local reason="$2"
  FAIL=$((FAIL + 1))
  echo "FAIL — $label: $reason"
}

# Run a dev hook script with given env and stdin, assert exit 0.
run_hook_exits_0() {
  local script="$DEV_HOOKS_DIR/$1"
  local label="$2"
  local stdin_data="${3:-}"
  shift 3
  local extra_env=("$@")

  if [ ! -f "$script" ]; then
    assert_fail "$label" "script not found: $script (TDD RED — implementation missing)"
    return
  fi

  local exit_code=0
  if [ -n "${extra_env[*]:-}" ]; then
    env "${extra_env[@]}" node "$script" <<< "$stdin_data" >/dev/null 2>&1 || exit_code=$?
  else
    node "$script" <<< "$stdin_data" >/dev/null 2>&1 || exit_code=$?
  fi

  if [ "$exit_code" -eq 0 ]; then
    assert_pass "$label"
  else
    assert_fail "$label" "exited $exit_code (must exit 0 — hooks must never crash)"
  fi
}

# Assert that /tmp/claws-dev-hooks.log was written (or appended) after running hook.
assert_log_written() {
  local script="$DEV_HOOKS_DIR/$1"
  local label="$2"
  local stdin_data="${3:-}"
  shift 3
  local extra_env=("$@")

  if [ ! -f "$script" ]; then
    assert_fail "$label" "script not found: $script (TDD RED — implementation missing)"
    return
  fi

  # Record pre-run state of the log
  local pre_size=0
  [ -f "$DEV_LOG" ] && pre_size=$(wc -c < "$DEV_LOG" 2>/dev/null || echo 0)

  if [ -n "${extra_env[*]:-}" ]; then
    env "${extra_env[@]}" node "$script" <<< "$stdin_data" >/dev/null 2>&1 || true
  else
    node "$script" <<< "$stdin_data" >/dev/null 2>&1 || true
  fi

  local post_size=0
  [ -f "$DEV_LOG" ] && post_size=$(wc -c < "$DEV_LOG" 2>/dev/null || echo 0)

  if [ "$post_size" -gt "$pre_size" ]; then
    assert_pass "$label"
  else
    assert_fail "$label" "/tmp/claws-dev-hooks.log not written (size before=$pre_size after=$post_size)"
  fi
}

echo "=== dev-hook-misfire.test.sh ==="
echo "DEV_HOOKS_DIR: $DEV_HOOKS_DIR"
echo ""

# ── 1. check-stale-main.js ───────────────────────────────────────────────────
# Missing CLAWS_PROJECT_ROOT env, empty stdin → must exit 0
run_hook_exits_0 "check-stale-main.js" \
  "check-stale-main: empty stdin, no env → exits 0" \
  ""

# Missing CLAWS_PROJECT_ROOT → log error and exit 0
assert_log_written "check-stale-main.js" \
  "check-stale-main: missing CLAWS_PROJECT_ROOT → writes log" \
  "" \
  "CLAWS_PROJECT_ROOT="

# Nonexistent repo path → must exit 0, not throw
run_hook_exits_0 "check-stale-main.js" \
  "check-stale-main: nonexistent repo path → exits 0" \
  "" \
  "CLAWS_PROJECT_ROOT=/tmp/does-not-exist-$$"

# Pipe bad JSON as stdin → must exit 0
echo "not-json-{}{{" | node "$DEV_HOOKS_DIR/check-stale-main.js" >/dev/null 2>&1 && \
  assert_pass "check-stale-main: bad stdin JSON → exits 0" || \
  assert_fail "check-stale-main: bad stdin JSON → exits 0" "exited non-zero"

# ── 2. check-tag-pushed.js ───────────────────────────────────────────────────
# No env, empty stdin
run_hook_exits_0 "check-tag-pushed.js" \
  "check-tag-pushed: empty stdin, no env → exits 0" \
  ""

# Bad stdin (malformed JSON)
run_hook_exits_0 "check-tag-pushed.js" \
  "check-tag-pushed: malformed JSON stdin → exits 0" \
  "{ bad json }"

# Missing CLAWS_PROJECT_ROOT → log written
assert_log_written "check-tag-pushed.js" \
  "check-tag-pushed: missing CLAWS_PROJECT_ROOT → writes log" \
  '{"tool":"Bash","input":{"command":"git push"}}' \
  "CLAWS_PROJECT_ROOT="

# stdin = valid PostToolUse JSON for non-Bash tool (should no-op silently)
run_hook_exits_0 "check-tag-pushed.js" \
  "check-tag-pushed: non-Bash tool in stdin → exits 0 silently" \
  '{"tool":"Edit","input":{"file_path":"/tmp/foo.txt"}}'

# ── 3. check-tag-vs-main.js ──────────────────────────────────────────────────
# No env, empty stdin
run_hook_exits_0 "check-tag-vs-main.js" \
  "check-tag-vs-main: empty stdin, no env → exits 0" \
  ""

# Bad stdin
run_hook_exits_0 "check-tag-vs-main.js" \
  "check-tag-vs-main: malformed JSON stdin → exits 0" \
  "not json at all"

# Missing CLAWS_PROJECT_ROOT → log written
assert_log_written "check-tag-vs-main.js" \
  "check-tag-vs-main: missing CLAWS_PROJECT_ROOT → writes log" \
  '{"tool":"Bash","input":{"command":"git tag v1.0.0"}}' \
  "CLAWS_PROJECT_ROOT="

# Valid but no tags → exit 0
run_hook_exits_0 "check-tag-vs-main.js" \
  "check-tag-vs-main: no git tags → exits 0" \
  '{"tool":"Bash","input":{"command":"echo hello"}}' \
  "CLAWS_PROJECT_ROOT=/tmp"

# ── 4. check-open-claws-terminals.js ────────────────────────────────────────
# No env, empty stdin (Stop hook format)
run_hook_exits_0 "check-open-claws-terminals.js" \
  "check-open-claws-terminals: empty stdin, no env → exits 0" \
  ""

# No CLAWS_SOCK → must exit 0, not throw
run_hook_exits_0 "check-open-claws-terminals.js" \
  "check-open-claws-terminals: missing CLAWS_SOCK → exits 0" \
  "" \
  "CLAWS_SOCK="

# CLAWS_SOCK pointing at nonexistent path → exit 0
run_hook_exits_0 "check-open-claws-terminals.js" \
  "check-open-claws-terminals: nonexistent sock path → exits 0" \
  "" \
  "CLAWS_SOCK=/tmp/no-such-socket-$$.sock"

# Bad stdin JSON
run_hook_exits_0 "check-open-claws-terminals.js" \
  "check-open-claws-terminals: bad JSON stdin → exits 0" \
  "}}invalid{{"

# ── 5. check-extension-dirs.js ───────────────────────────────────────────────
# Empty stdin, no env
run_hook_exits_0 "check-extension-dirs.js" \
  "check-extension-dirs: empty stdin, no env → exits 0" \
  ""

# Fake ~/.vscode/extensions dir: create a tmp dir, point VSCODE_EXTENSIONS_DIR at it
FAKE_VSCODE_DIR="$(mktemp -d /tmp/fake-vscode-ext-XXXXXX)"
mkdir -p "$FAKE_VSCODE_DIR/claws.claws-0.7.7" \
         "$FAKE_VSCODE_DIR/claws.claws-0.7.6" \
         "$FAKE_VSCODE_DIR/ms-python.python-2024.0.0"

run_hook_exits_0 "check-extension-dirs.js" \
  "check-extension-dirs: fake vscode extensions dir → exits 0" \
  "" \
  "VSCODE_EXTENSIONS_DIR=$FAKE_VSCODE_DIR"

# Multiple stale Claws versions in fake dir → log written (stale detected)
assert_log_written "check-extension-dirs.js" \
  "check-extension-dirs: multiple Claws versions (stale) → writes log" \
  "" \
  "VSCODE_EXTENSIONS_DIR=$FAKE_VSCODE_DIR"

# Nonexistent extensions dir → exit 0 (graceful)
run_hook_exits_0 "check-extension-dirs.js" \
  "check-extension-dirs: nonexistent extensions dir → exits 0" \
  "" \
  "VSCODE_EXTENSIONS_DIR=/tmp/no-such-vscode-dir-$$"

rm -rf "$FAKE_VSCODE_DIR"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "$PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
