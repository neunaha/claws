#!/usr/bin/env bash
# Claws — diagnostic bundle generator
# Usage: bash ~/.claws-src/scripts/report.sh [project-dir]
#
# Produces a single file with everything needed to diagnose install/runtime
# issues: OS info, Node version, install log, extension state, VS Code
# extension logs, project-local file presence. The output file path is
# printed at the end — share it in a GitHub issue.

set -eo pipefail

PROJECT_ROOT="${1:-$(pwd)}"
INSTALL_DIR="${CLAWS_DIR:-$HOME/.claws-src}"
REPORT_DIR="${CLAWS_REPORT_DIR:-$HOME}"
REPORT="$REPORT_DIR/claws-report-$(date +%Y%m%d-%H%M%S).txt"

redact() {
  # Replace the user's home path with $HOME to reduce leaked info in pastes.
  # Also strip anything that looks like a token/key.
  sed -e "s|$HOME|\$HOME|g" \
      -e 's|[A-Za-z0-9]\{32,\}|<redacted>|g'
}

say() { echo "$@" >> "$REPORT"; }
section() { echo "" >> "$REPORT"; echo "═════ $1 ═════" >> "$REPORT"; }

{
  echo "Claws Diagnostic Report"
  echo "Generated: $(date)"
  echo "Project:   $PROJECT_ROOT"
  echo "Install:   $INSTALL_DIR"
} > "$REPORT"

section "System dependencies"
PLATFORM="$(uname -s)"
say "OS:            $(uname -a)"
say "Shell:         $SHELL ($(basename "$SHELL"))"
say "bash:          $BASH_VERSION"
say ""
say "git:           $(command -v git 2>/dev/null || echo '—') $(git --version 2>/dev/null || echo 'NOT INSTALLED')"
say "node:          $(command -v node 2>/dev/null || echo '—') $(node --version 2>/dev/null || echo 'NOT INSTALLED')"
if command -v node &>/dev/null; then
  nm=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null)
  say "node major:    $nm$([ "$nm" -lt 18 ] 2>/dev/null && echo ' (TOO OLD — requires 18+)')"
fi
say "npm:           $(command -v npm 2>/dev/null || echo '—') $(npm --version 2>/dev/null || echo 'NOT INSTALLED')"
say "python3:       $(command -v python3 2>/dev/null || echo '—') $(python3 --version 2>&1 | awk '{print $2}' || echo 'NOT INSTALLED')"
say "npx:           $(command -v npx 2>/dev/null || echo '—')"
case "$PLATFORM" in
  Darwin)
    say "xcode-select:  $(xcode-select -p 2>/dev/null || echo 'NOT INSTALLED')"
    ;;
  Linux)
    say "g++:           $(command -v g++ 2>/dev/null || echo '—') $(g++ -dumpversion 2>/dev/null || echo '')"
    say "make:          $(command -v make 2>/dev/null || echo '—')"
    ;;
esac

section "Editor CLIs"
for pair in \
  "code:/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "code-insiders:/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders" \
  "cursor:/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
  "windsurf:/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"; do
  label="${pair%%:*}"
  bundled="${pair#*:}"
  if command -v "$label" &>/dev/null; then
    say "  ✓ $label  ($(command -v "$label")) — $("$label" --version 2>&1 | head -1)"
  elif [ -x "$bundled" ]; then
    say "  ✓ $label  (bundled: $bundled) — $("$bundled" --version 2>&1 | head -1)"
  else
    say "  — $label  not found"
  fi
done

section "Claws source clone"
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Exists:    $INSTALL_DIR"
  say "HEAD:      $(cd "$INSTALL_DIR" && git log --oneline -1 2>/dev/null)"
  say "Branch:    $(cd "$INSTALL_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  say "Remote:    $(cd "$INSTALL_DIR" && git config --get remote.origin.url 2>/dev/null)"
else
  say "MISSING:   $INSTALL_DIR (no git clone — installer may have failed at step 1)"
fi

section "Extension manifest + bundle"
if [ -f "$INSTALL_DIR/extension/package.json" ]; then
  say "Version:   $(node -e "console.log(require('$INSTALL_DIR/extension/package.json').version)" 2>/dev/null)"
  say "Main:      $(node -e "console.log(require('$INSTALL_DIR/extension/package.json').main)" 2>/dev/null)"
  say "Bundle:    $([ -f "$INSTALL_DIR/extension/dist/extension.js" ] && wc -c < "$INSTALL_DIR/extension/dist/extension.js" | tr -d ' ' || echo 'MISSING')"
  say "Build SHA: $(cat "$INSTALL_DIR/extension/dist/.build-sha" 2>/dev/null || echo 'unknown')"

  # Detailed node-pty state: installed? binary built? against which ABI?
  # The Electron version matters — a binary built against system Node
  # loads from `node` fine but fails inside VS Code's extension host.
  NPTY_DIR="$INSTALL_DIR/extension/node_modules/node-pty"
  NPTY_BIN="$NPTY_DIR/build/Release/pty.node"
  NPTY_ABI=$(cat "$INSTALL_DIR/extension/dist/.electron-abi" 2>/dev/null || echo "unknown")
  if [ -f "$NPTY_BIN" ]; then
    say "node-pty:  ✓ installed, binary present ($(wc -c < "$NPTY_BIN" | tr -d ' ') bytes)"
    say "           built for Electron $NPTY_ABI"
  elif [ -d "$NPTY_DIR" ]; then
    say "node-pty:  ✗ installed but BINARY MISSING — extension in pipe-mode fallback"
    say "           fix with: /claws-fix"
  else
    say "node-pty:  ✗ not installed — pipe-mode fallback active"
  fi
else
  say "MISSING manifest at $INSTALL_DIR/extension/package.json"
fi

section "Editor extension symlinks"
for dir in "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions" "$HOME/.windsurf/extensions"; do
  if [ -d "$dir" ]; then
    matches=$(find "$dir" -maxdepth 1 -name 'neunaha.claws-*' 2>/dev/null)
    if [ -n "$matches" ]; then
      echo "$dir:" >> "$REPORT"
      ls -la "$dir" 2>/dev/null | grep 'neunaha.claws' >> "$REPORT" 2>&1 || true
    fi
  fi
done

section "Project-local files"
for f in .mcp.json .claws-bin/mcp_server.js .claws-bin/shell-hook.sh .vscode/extensions.json CLAUDE.md; do
  if [ -e "$PROJECT_ROOT/$f" ]; then
    say "  ✓ $f  ($(wc -c < "$PROJECT_ROOT/$f" | tr -d ' ') bytes)"
  else
    say "  ✗ $f  MISSING"
  fi
done
# Confirm neunaha.claws is in the recommendations list specifically
if [ -f "$PROJECT_ROOT/.vscode/extensions.json" ]; then
  if grep -q "neunaha.claws" "$PROJECT_ROOT/.vscode/extensions.json" 2>/dev/null; then
    say "  ✓ .vscode/extensions.json recommends neunaha.claws"
  else
    say "  ✗ .vscode/extensions.json MISSING claws recommendation"
  fi
fi
for d in .claude/commands .claude/rules .claude/skills; do
  if [ -d "$PROJECT_ROOT/$d" ]; then
    count=$(find "$PROJECT_ROOT/$d" -type f 2>/dev/null | wc -l | tr -d ' ')
    say "  ✓ $d/  ($count files)"
  else
    say "  ✗ $d/  MISSING"
  fi
done

section "Socket state"
SOCK_PATH="$PROJECT_ROOT/.claws/claws.sock"
if [ -S "$SOCK_PATH" ]; then
  say "Socket:    $SOCK_PATH"
  say "Mtime:     $(stat -f '%Sm' "$SOCK_PATH" 2>/dev/null || stat -c '%y' "$SOCK_PATH" 2>/dev/null)"
  if command -v nc &>/dev/null; then
    if echo '{"id":1,"cmd":"list"}' | nc -U "$SOCK_PATH" 2>/dev/null | head -c 200 | grep -q '"ok"'; then
      say "Status:    LIVE — extension is listening"
    else
      say "Status:    STALE — file exists but no process listening"
    fi
  fi
else
  say "Socket:    NOT PRESENT at $SOCK_PATH  (extension not activated in this project yet)"
fi

section "MCP server handshake test"
MCP_PATH="$INSTALL_DIR/mcp_server.js"
[ -f "$PROJECT_ROOT/.claws-bin/mcp_server.js" ] && MCP_PATH="$PROJECT_ROOT/.claws-bin/mcp_server.js"
if command -v node &>/dev/null && [ -f "$MCP_PATH" ]; then
  say "Testing:   $MCP_PATH"
  HANDSHAKE=$(node --no-deprecation -e '
const { spawn } = require("child_process");
const mcp = spawn("node", [process.argv[1]], { stdio: ["pipe", "pipe", "ignore"] });
const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
const msg = `Content-Length: ${Buffer.byteLength(req)}\r\n\r\n${req}`;
let buf = "";
const done = (c, o) => { try { mcp.kill(); } catch {}; process.stdout.write(o); process.exit(c); };
const timer = setTimeout(() => done(1, "TIMEOUT"), 4000);
mcp.stdout.on("data", d => { buf += d.toString("utf8"); if (buf.includes("claws")) { clearTimeout(timer); done(0, buf.slice(0, 200)); } });
mcp.on("error", e => { clearTimeout(timer); done(1, "SPAWN_ERROR: " + e.message); });
mcp.stdin.write(msg);
' "$MCP_PATH" 2>&1)
  say "Response:  ${HANDSHAKE:0:300}"
fi

section "Shell hook state"
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$rc" ]; then
    if grep -q "CLAWS terminal hook" "$rc" 2>/dev/null; then
      say "  ✓ $(basename "$rc") — hook installed"
    else
      say "  ✗ $(basename "$rc") — hook NOT installed"
    fi
  fi
done

section "Latest install log"
LATEST_LOG=$(ls -t /tmp/claws-install-*.log 2>/dev/null | head -1)
if [ -n "$LATEST_LOG" ] && [ -f "$LATEST_LOG" ]; then
  say "File:      $LATEST_LOG"
  say "Last 100 lines:"
  tail -100 "$LATEST_LOG" | redact >> "$REPORT"
else
  say "No recent install log found in /tmp/claws-install-*.log"
fi

section "VS Code extension host logs (claws only, last 50 matches)"
LOGDIR=$(ls -dt "$HOME/Library/Application Support/Code/logs/"*/ 2>/dev/null | head -1)
if [ -n "$LOGDIR" ] && [ -d "$LOGDIR" ]; then
  say "From:      $LOGDIR"
  grep -r "claws\|neunaha" "$LOGDIR" 2>/dev/null | tail -50 | redact >> "$REPORT" || say "(no claws references)"
else
  say "No VS Code logs found at ~/Library/Application Support/Code/logs/"
fi

section "Report location"
echo "" >> "$REPORT"
echo "Share this file in an issue: https://github.com/neunaha/claws/issues/new" >> "$REPORT"
echo "File path: $REPORT" >> "$REPORT"

# Print to stdout for the caller
echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║  Claws diagnostic report written to:                   ║"
echo "╚════════════════════════════════════════════════════════╝"
echo "  $REPORT"
echo ""
echo "Summary of checks:"
grep -E '✓|✗|MISSING|STALE|LIVE|Status:' "$REPORT" | head -30 | sed 's/^/  /'
echo ""
echo "Next steps:"
echo "  1. Open the report:    cat \"$REPORT\""
echo "  2. Share it:           https://github.com/neunaha/claws/issues/new"
echo "  3. Or paste contents into a new issue — HOMEDIR already redacted."
