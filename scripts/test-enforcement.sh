#!/usr/bin/env bash
# Integration test for Claws behavioral injection enforcement pipeline.
# Tests all four stages: project CLAUDE.md, global CLAUDE.md, hooks, session-start.
# Usage: bash scripts/test-enforcement.sh
# Exit 0 = all tests pass. Exit 1 = one or more tests failed.

set -eo pipefail
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0

pass() { printf "  \033[32m✓\033[0m %s\n" "$*"; PASS=$((PASS+1)); }
fail() { printf "  \033[31m✗\033[0m %s\n" "$*"; FAIL=$((FAIL+1)); }
header() { printf "\n\033[1m── %s ──\033[0m\n" "$*"; }

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# ── Test 1: inject-claude-md.js writes imperative content ─────────────────
header "Test 1: inject-claude-md.js"
TEST_PROJECT="$TMPDIR_TEST/test-project"
mkdir -p "$TEST_PROJECT"
node "$INSTALL_DIR/scripts/inject-claude-md.js" "$TEST_PROJECT" >/dev/null 2>&1

if [ -f "$TEST_PROJECT/CLAUDE.md" ]; then pass "CLAUDE.md created"; else fail "CLAUDE.md not created"; fi

if grep -q "MUST\|MANDATORY\|ALWAYS\|NEVER" "$TEST_PROJECT/CLAUDE.md" 2>/dev/null; then
  pass "CLAUDE.md contains imperative language (MUST/ALWAYS/NEVER)"
else
  fail "CLAUDE.md missing imperative language — advisory content only"
fi

if grep -q "CLAWS:BEGIN" "$TEST_PROJECT/CLAUDE.md" 2>/dev/null; then
  pass "CLAUDE.md has CLAWS:BEGIN sentinel"
else
  fail "CLAUDE.md missing CLAWS:BEGIN sentinel"
fi

if grep -q "claws_create\|claws_send" "$TEST_PROJECT/CLAUDE.md" 2>/dev/null; then
  pass "CLAUDE.md lists MCP tools"
else
  fail "CLAUDE.md missing MCP tool list"
fi

# Idempotency: run again and verify no duplicate sentinel
node "$INSTALL_DIR/scripts/inject-claude-md.js" "$TEST_PROJECT" >/dev/null 2>&1
SENTINEL_COUNT=$(grep -c "CLAWS:BEGIN" "$TEST_PROJECT/CLAUDE.md" 2>/dev/null || echo 0)
if [ "$SENTINEL_COUNT" -eq 1 ]; then
  pass "inject-claude-md.js is idempotent (sentinel count=1 after 2 runs)"
else
  fail "inject-claude-md.js not idempotent (sentinel count=$SENTINEL_COUNT after 2 runs)"
fi

# ── Test 2: inject-global-claude-md.js dry-run ────────────────────────────
header "Test 2: inject-global-claude-md.js"
DRY_OUT=$(node "$INSTALL_DIR/scripts/inject-global-claude-md.js" --dry-run 2>&1)

if echo "$DRY_OUT" | grep -q "CLAWS-GLOBAL:BEGIN v1"; then
  pass "inject-global-claude-md.js dry-run emits CLAWS-GLOBAL:BEGIN v1"
else
  fail "inject-global-claude-md.js dry-run missing CLAWS-GLOBAL:BEGIN v1"
fi

if echo "$DRY_OUT" | grep -q "MUST\|ALWAYS\|NEVER"; then
  pass "inject-global-claude-md.js dry-run contains imperative language"
else
  fail "inject-global-claude-md.js dry-run missing imperative language"
fi

# ── Test 3: inject-settings-hooks.js dry-run ──────────────────────────────
header "Test 3: inject-settings-hooks.js"
HOOKS_DRY=$(node "$INSTALL_DIR/scripts/inject-settings-hooks.js" "$INSTALL_DIR/.claws-bin" --dry-run 2>&1)

if echo "$HOOKS_DRY" | grep -q "SessionStart"; then
  pass "inject-settings-hooks.js dry-run includes SessionStart hook"
else
  fail "inject-settings-hooks.js dry-run missing SessionStart hook"
fi

if echo "$HOOKS_DRY" | grep -q "PreToolUse\|Bash"; then
  pass "inject-settings-hooks.js dry-run includes PreToolUse hook"
else
  fail "inject-settings-hooks.js dry-run missing PreToolUse hook"
fi

if echo "$HOOKS_DRY" | grep -q '"_source".*claws\|claws.*_source'; then
  pass "inject-settings-hooks.js tags hooks with _source:claws"
else
  fail "inject-settings-hooks.js missing _source:claws tag"
fi

# ── Test 4: session-start-claws.js emits lifecycle reminder ───────────────
header "Test 4: session-start-claws.js"
FAKE_PROJECT="$TMPDIR_TEST/fake-claws-project"
mkdir -p "$FAKE_PROJECT/.claws"
touch "$FAKE_PROJECT/.claws/claws.sock"

HOOK_OUT=$(echo "{\"cwd\":\"$FAKE_PROJECT\"}" | node "$INSTALL_DIR/.claws-bin/hooks/session-start-claws.js" 2>&1)

if echo "$HOOK_OUT" | grep -q "MANDATORY"; then
  pass "session-start-claws.js emits MANDATORY reminder when socket present"
else
  fail "session-start-claws.js missing MANDATORY reminder"
fi

if echo "$HOOK_OUT" | grep -q "claws_create\|boot sequence"; then
  pass "session-start-claws.js includes boot sequence or claws_create"
else
  fail "session-start-claws.js missing boot sequence reference"
fi

NO_SOCK_OUT=$(echo "{\"cwd\":\"$TMPDIR_TEST\"}" | node "$INSTALL_DIR/.claws-bin/hooks/session-start-claws.js" 2>&1)
if [ -z "$NO_SOCK_OUT" ]; then
  pass "session-start-claws.js silent when no socket present"
else
  fail "session-start-claws.js emitted output when no socket (should be silent)"
fi

# ── Test 5: hook scripts have correct exit codes ───────────────────────────
header "Test 5: hook exit codes"
echo '{}' | node "$INSTALL_DIR/.claws-bin/hooks/pre-tool-use-claws.js" >/dev/null 2>&1 && pass "pre-tool-use-claws.js exits 0 on empty input" || fail "pre-tool-use-claws.js non-zero exit on empty input"
echo '{}' | node "$INSTALL_DIR/.claws-bin/hooks/stop-claws.js" >/dev/null 2>&1 && pass "stop-claws.js exits 0 on empty input" || fail "stop-claws.js non-zero exit on empty input"

# ── Summary ────────────────────────────────────────────────────────────────
printf "\n\033[1m── Results ──\033[0m\n"
printf "  Passed: \033[32m%d\033[0m  Failed: \033[31m%d\033[0m  Total: %d\n" "$PASS" "$FAIL" "$((PASS+FAIL))"

if [ "$FAIL" -gt 0 ]; then
  printf "\n\033[31mSome tests failed.\033[0m\n"
  exit 1
else
  printf "\n\033[32mAll tests passed.\033[0m\n"
fi
