#!/usr/bin/env bash
#
# scripts/bump-version.sh — single source of truth for version bumps.
#
# Updates every place where the version is hard-coded:
#   - package.json (root)
#   - extension/package.json
#   - extension/package-lock.json (root + nested "" package)
#
# Usage:
#   bash scripts/bump-version.sh 0.7.10
#
# After running, sync the extension CHANGELOG and refresh .claws-bin if needed:
#   cp CHANGELOG.md extension/CHANGELOG.md
#   cp mcp_server.js .claws-bin/mcp_server.js
#
# This script is the only blessed way to change the version. Manual edits to
# any one file invite drift — and version drift on this codebase has caused
# real shipping bugs (v0.7.7.1 semver invalidation, v0.7.5 stale lockfile, ...).
#
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: bash scripts/bump-version.sh <new-version>" >&2
  echo "  e.g. bash scripts/bump-version.sh 0.7.10" >&2
  exit 64
fi

NEW="$1"
# SemVer 2.0 strict: MAJOR.MINOR.PATCH only. No fourth segment (the v0.7.7.1 trap).
if ! echo "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: '$NEW' is not a valid SemVer 2.0 version (MAJOR.MINOR.PATCH only)." >&2
  echo "  VS Code rejects four-segment versions (this broke v0.7.7.1)." >&2
  exit 65
fi

# Find the project root — script lives in scripts/ which lives at repo root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

cd "$ROOT"

# Capture old version from root package.json so the report is meaningful.
OLD="$(node -p "require('./package.json').version")"

if [ "$OLD" = "$NEW" ]; then
  echo "version is already $NEW — nothing to do."
  exit 0
fi

echo "bumping $OLD → $NEW across all source files…"

# Update each file via Node so the JSON stays well-formed (no sed regex edge cases).
node --no-deprecation -e "
const fs=require('fs');
const targets=[
  'package.json',
  'extension/package.json',
  'extension/package-lock.json',
];
for (const f of targets) {
  const j=JSON.parse(fs.readFileSync(f,'utf8'));
  if (j.version) j.version='$NEW';
  // package-lock has a nested top-level package entry that ALSO carries a
  // version field — keep it in sync so 'npm install' doesn't re-write a stale
  // value back in.
  if (j.packages && j.packages['']) j.packages[''].version='$NEW';
  fs.writeFileSync(f, JSON.stringify(j,null,2)+'\n');
  console.log('  ✓', f);
}
"

echo ""
echo "verify (all 3 should be $NEW):"
echo "  root           $(node -p "require('./package.json').version")"
echo "  extension      $(node -p "require('./extension/package.json').version")"
echo "  extension lock $(node -p "require('./extension/package-lock.json').version")"
echo ""
echo "next steps:"
echo "  1. Update CHANGELOG.md with [$NEW] section"
echo "  2. Sync extension CHANGELOG: cp CHANGELOG.md extension/CHANGELOG.md"
echo "  3. Refresh runtime:          cp mcp_server.js .claws-bin/mcp_server.js"
echo "  4. Run tests:                cd extension && npm test"
echo "  5. Commit + tag:             git tag -a v$NEW -m 'v$NEW'"
