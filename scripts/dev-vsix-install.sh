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

# Resolve the VS Code CLI. Mirrors install.sh::_find_editor_cli — PATH first,
# then macOS app-bundle fallback. Lets the script work from worker terminals
# whose PATH may not include /usr/local/bin.
_find_code_cli() {
  command -v code 2>/dev/null && return 0
  case "$(uname -s)" in
    Darwin)
      local p="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
      [ -x "$p" ] && echo "$p" && return 0
      ;;
  esac
  return 1
}
CODE_CLI="$(_find_code_cli)" || {
  echo "[dev-vsix-install] FATAL: 'code' CLI not found" >&2
  echo "[dev-vsix-install]   tried: PATH, /Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" >&2
  echo "[dev-vsix-install]   install via VS Code: Cmd+Shift+P -> 'Shell Command: Install code in PATH'" >&2
  exit 1
}

echo "[dev-vsix-install] step 1/3 — rebuilding extension"
( cd "$EXT_DIR" && npm run build )

echo "[dev-vsix-install] step 2/3 — packaging VSIX → $VSIX_OUT"
( cd "$EXT_DIR" && npx -y @vscode/vsce package \
    --skip-license --no-git-tag-version --no-update-package-json \
    --out "$VSIX_OUT" )

echo "[dev-vsix-install] step 3/3 — installing into VS Code via $CODE_CLI"
"$CODE_CLI" --install-extension "$VSIX_OUT" --force
echo
echo "[dev-vsix-install] install complete — reload required:"
echo "[dev-vsix-install]    Cmd+Shift+P -> Developer: Reload Window"
echo "[dev-vsix-install] vsix kept at: $VSIX_OUT"
