#!/usr/bin/env bash
# scripts/dev-vsix-install.sh
#
# Rebuild + repackage + reinstall the Claws extension as a fresh VSIX —
# the missing dev-loop step that complements `npm run deploy:dev`.
#
# Why both exist:
#   deploy:dev (fast, ~5s)  — copies new dist into installed dir; does NOT
#                              refresh extensions.json metadata. Panel keeps
#                              showing original VSIX date — silent staleness risk.
#   dev-vsix-install (~25s) — full vsce package + code --install-extension.
#                              Refreshes installedTimestamp, version label, and
#                              panel date. Use after material extension changes
#                              or whenever you want a clean dev-install.
#
# After this finishes: Cmd+Shift+P → Developer: Reload Window.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$REPO_ROOT/extension"
VSIX_OUT="${TMPDIR:-/tmp}/claws-dev-$(date +%s).vsix"

[ -d "$EXT_DIR" ] || { echo "[dev-vsix-install] FATAL: $EXT_DIR not found" >&2; exit 1; }
command -v code >/dev/null 2>&1 || {
  echo "[dev-vsix-install] FATAL: 'code' CLI not on PATH" >&2
  echo "[dev-vsix-install]   Install via VS Code: Cmd+Shift+P → 'Shell Command: Install code in PATH'" >&2
  exit 1
}

echo "[dev-vsix-install] step 1/3 — rebuilding extension"
( cd "$EXT_DIR" && npm run build )

echo "[dev-vsix-install] step 2/3 — packaging VSIX → $VSIX_OUT"
( cd "$EXT_DIR" && npx -y @vscode/vsce package \
    --skip-license --no-git-tag-version --no-update-package-json \
    --out "$VSIX_OUT" )

echo "[dev-vsix-install] step 3/3 — installing into VS Code"
code --install-extension "$VSIX_OUT" --force
echo
echo "[dev-vsix-install] install complete — reload required:"
echo "[dev-vsix-install]    Cmd+Shift+P -> Developer: Reload Window"
echo "[dev-vsix-install] vsix kept at: $VSIX_OUT"
