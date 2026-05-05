#!/usr/bin/env bash
set -euo pipefail

ROOT='/Users/ANISH.NEUNAHA/Desktop/Claws'
TMPDIR=$(mktemp -d)
TMPHOME=$(mktemp -d)
trap 'rm -rf "$TMPDIR" "$TMPHOME"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

VERSION=$(node -e "console.log(require('$ROOT/package.json').version)")

# 1. Run project injector against TMPDIR
mkdir -p "$TMPDIR/.claude/commands"
cp "$ROOT/.claude/commands/"claws*.md "$TMPDIR/.claude/commands/" 2>/dev/null || true
node "$ROOT/scripts/inject-claude-md.js" "$TMPDIR" >/dev/null
PROJECT_MD="$TMPDIR/CLAUDE.md"
[ -f "$PROJECT_MD" ] || fail "project CLAUDE.md not created"

# 2. Run global injector with HOME redirected
HOME="$TMPHOME" node "$ROOT/scripts/inject-global-claude-md.js" >/dev/null
GLOBAL_MD="$TMPHOME/.claude/CLAUDE.md"
[ -f "$GLOBAL_MD" ] || fail "global CLAUDE.md not created"

# 3. PROJECT presence assertions
for s in 'claws_done' '__CLAWS_DONE__' 'claws_fleet' 'claws_dispatch_subworker' 'claws_drain_events' 'claws_workers_wait' 'SESSION-BOOT' 'SESSION-END'; do
  grep -q -- "$s" "$PROJECT_MD" || fail "project: missing required string '$s'"
done
grep -q "<!-- CLAWS:BEGIN v$VERSION -->" "$PROJECT_MD" || fail "project: missing versioned sentinel v$VERSION"

# 4. PROJECT absence assertions
for s in 'MARK_M??_OK_COLOR' 'bypass permissions' 'No marker required'; do
  grep -q -- "$s" "$PROJECT_MD" && fail "project: forbidden string '$s' present" || true
done

# 5. GLOBAL presence assertions
for s in 'claws_done' '__CLAWS_DONE__' 'SESSION-BOOT' 'SESSION-END' 'FAILED' 'mode-aware'; do
  grep -q -- "$s" "$GLOBAL_MD" || fail "global: missing required string '$s'"
done
grep -q "<!-- CLAWS-GLOBAL:BEGIN v$VERSION -->" "$GLOBAL_MD" || fail "global: missing versioned sentinel v$VERSION"

# 6. GLOBAL absence assertions
for s in 'MARK_M??_OK_COLOR' 'bypass permissions' 'No marker required'; do
  grep -q -- "$s" "$GLOBAL_MD" && fail "global: forbidden string '$s' present" || true
done

# 7. Tool-list completeness: extracted tools must equal mcp_server.js dispatch surface
INJECTED_TOOLS=$(grep -oE 'claws_[a-z_]+' "$PROJECT_MD" | sort -u)
ACTUAL_TOOLS=$(grep -oE "name === 'claws_[a-z_]+'" "$ROOT/mcp_server.js" | grep -oE 'claws_[a-z_]+' | sort -u)
if [ "$INJECTED_TOOLS" != "$ACTUAL_TOOLS" ]; then
  echo 'TOOL DRIFT:' >&2
  diff <(echo "$INJECTED_TOOLS") <(echo "$ACTUAL_TOOLS") >&2 || true
  fail 'project: injected tool list does not match mcp_server.js surface'
fi

# 8. Phase completeness: phases in injected block must equal Phase enum in lifecycle-store.ts
ACTUAL_PHASES=$(grep -oE "'[A-Z][A-Z0-9-]+'" "$ROOT/extension/src/lifecycle-store.ts" | head -20 | tr -d "'" | sort -u)
for phase in $ACTUAL_PHASES; do
  grep -q -- "$phase" "$PROJECT_MD" || fail "project: missing phase '$phase'"
done

# 9. Idempotence: second run should report unchanged
SECOND=$(node "$ROOT/scripts/inject-claude-md.js" "$TMPDIR")
echo "$SECOND" | grep -q 'already has the current Claws block' || fail "project injector not idempotent: $SECOND"

# 10. Sentinel migration: pre-seed an old unversioned sentinel and verify it's replaced
MIG=$(mktemp -d)
mkdir -p "$MIG/.claude/commands"
printf '# old project\n\n<!-- CLAWS:BEGIN -->\nlegacy text\n<!-- CLAWS:END -->\n' > "$MIG/CLAUDE.md"
node "$ROOT/scripts/inject-claude-md.js" "$MIG" >/dev/null
BLOCKS=$(grep -c '<!-- CLAWS:BEGIN' "$MIG/CLAUDE.md" || true)
[ "$BLOCKS" = '1' ] || fail "sentinel migration: expected 1 BEGIN block, found $BLOCKS"
grep -q "<!-- CLAWS:BEGIN v$VERSION -->" "$MIG/CLAUDE.md" || fail "sentinel migration: new versioned sentinel not present after upgrade"
rm -rf "$MIG"

echo 'OK — all template enforcement checks passed (v'"$VERSION"', '"$(echo "$ACTUAL_TOOLS" | wc -l | tr -d ' ')"' tools)'
