#!/bin/bash
# Claws — single self-contained health check
# Usage: bash ~/.claws-src/scripts/doctor.sh
#        OR via slash command: /claws-doctor
#
# Each check prints PASS / FAIL / WARN and, on FAIL, a copy-pasteable one-liner
# that fixes it. At the end you get a single verdict: "X/Y passed" plus the
# next step.

# Don't bail on individual check failures — we want to report them all.
set +e

# ─── Colors (gracefully degrade if the terminal doesn't support them) ───
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  G="$(tput setaf 2)"; R="$(tput setaf 1)"; Y="$(tput setaf 3)"; D="$(tput setaf 8 2>/dev/null || tput setaf 7)"; B="$(tput bold)"; N="$(tput sgr0)"
else
  G=""; R=""; Y=""; D=""; B=""; N=""
fi

PASS_MARK="${G}✓ PASS${N}"
FAIL_MARK="${R}✗ FAIL${N}"
WARN_MARK="${Y}! WARN${N}"

# ─── State ───
PASS=0
FAIL=0
WARN=0
FAILURES=()  # human-readable "Check N: brief reason" lines

# ─── Constants ───
INSTALL_DIR="${CLAWS_DIR:-$HOME/.claws-src}"
MCP_PATH="$INSTALL_DIR/mcp_server.js"
SETTINGS_PATH="$HOME/.claude/settings.json"

record_pass() { PASS=$((PASS+1)); }
record_fail() {
  FAIL=$((FAIL+1))
  FAILURES+=("$1")
}
record_warn() { WARN=$((WARN+1)); }

print_fix() {
  # Indented, dim-coloured fix block. $1 = fix command (single line).
  printf "         ${D}→ Fix: %s${N}\n" "$1"
}

print_hint() {
  printf "         ${D}→ %s${N}\n" "$1"
}

# ─── Header ───
printf "\n"
printf "  ${B}Claws Doctor${N} — checking your install\n"
printf "  ${D}install dir: %s${N}\n" "$INSTALL_DIR"
printf "\n"

# ═══════════════════════════════════════════════════════════════
# Check 1 — Node.js
# ═══════════════════════════════════════════════════════════════
printf "  [1/8] Node.js available ........... "
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node --version 2>/dev/null)"
  printf "%s  ${D}(%s)${N}\n" "$PASS_MARK" "$NODE_VER"
  record_pass
else
  printf "%s\n" "$FAIL_MARK"
  print_fix "macOS: brew install node   |   Linux: sudo apt install nodejs"
  record_fail "1: node not found in PATH"
fi

# ═══════════════════════════════════════════════════════════════
# Check 2 — Install directory exists
# ═══════════════════════════════════════════════════════════════
printf "  [2/8] Install dir exists .......... "
if [ -d "$INSTALL_DIR" ]; then
  printf "%s\n" "$PASS_MARK"
  record_pass
else
  printf "%s\n" "$FAIL_MARK"
  print_fix "bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)"
  record_fail "2: install dir missing at $INSTALL_DIR"
fi

# ═══════════════════════════════════════════════════════════════
# Check 3 — MCP server file present
# ═══════════════════════════════════════════════════════════════
printf "  [3/8] MCP server file present ..... "
if [ -f "$MCP_PATH" ]; then
  printf "%s\n" "$PASS_MARK"
  record_pass
else
  printf "%s\n" "$FAIL_MARK"
  print_hint "expected at: $MCP_PATH"
  print_fix "Re-run the installer (see Check 2 fix)."
  record_fail "3: MCP server missing at $MCP_PATH"
fi

# ═══════════════════════════════════════════════════════════════
# Check 4 — MCP server actually starts and responds
# ═══════════════════════════════════════════════════════════════
printf "  [4/8] MCP server starts + responds  "
if command -v node >/dev/null 2>&1 && [ -f "$MCP_PATH" ]; then
  # MCP server speaks Content-Length-framed JSON-RPC (LSP style), not
  # newline-delimited. Spawn it as a child and write a properly framed
  # initialize request, then bound the wait ourselves — `timeout` is
  # not portable on macOS without coreutils.
  MCP_OUT=$(MCP_PATH="$MCP_PATH" node -e '
    const cp = require("child_process");
    const c = cp.spawn("node", [process.env.MCP_PATH], { stdio: ["pipe","pipe","ignore"] });
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {},
                clientInfo: { name: "claws-doctor", version: "1" } }
    });
    c.stdin.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);
    let out = "";
    const done = (ok) => { try { c.kill(); } catch(e){} process.stdout.write(out); process.exit(ok ? 0 : 1); };
    c.stdout.on("data", (d) => {
      out += d.toString("utf8");
      if (out.includes("\"result\"") || out.includes("serverInfo")) done(true);
    });
    c.on("error", () => done(false));
    setTimeout(() => done(false), 3000);
  ' 2>/dev/null)
  if printf '%s' "$MCP_OUT" | grep -q '"result"\|serverInfo'; then
    printf "%s\n" "$PASS_MARK"
    record_pass
  else
    printf "%s\n" "$FAIL_MARK"
    print_hint "MCP server didn't return an initialize response within 3s."
    print_fix "node $MCP_PATH   ${D}# run manually to see startup errors${N}"
    record_fail "4: MCP server didn't respond to initialize"
  fi
else
  printf "%s\n" "$FAIL_MARK"
  print_hint "Skipped: needs Check 1 (node) and Check 3 (mcp_server.js) first."
  record_fail "4: prerequisites missing for MCP startup test"
fi

# ═══════════════════════════════════════════════════════════════
# Check 5 — MCP path registered in ~/.claude/settings.json
# ═══════════════════════════════════════════════════════════════
printf "  [5/8] MCP registered in settings .. "
if [ -f "$SETTINGS_PATH" ] && grep -q "$MCP_PATH" "$SETTINGS_PATH" 2>/dev/null; then
  printf "%s\n" "$PASS_MARK"
  record_pass
elif [ -f "$SETTINGS_PATH" ] && grep -q '"claws"' "$SETTINGS_PATH" 2>/dev/null; then
  printf "%s\n" "$FAIL_MARK"
  print_hint "claws is registered, but the path doesn't match $MCP_PATH"
  print_hint "Mismatched path = MCP server can't start = no claws_* tools."
  print_fix "Re-run the installer to refresh the path."
  record_fail "5: MCP registered with wrong path (won't start)"
else
  printf "%s\n" "$FAIL_MARK"
  print_hint "expected entry: mcpServers.claws.command='node', args=['$MCP_PATH']"
  print_fix "Re-run the installer — it auto-registers the MCP server."
  record_fail "5: MCP not registered in $SETTINGS_PATH"
fi

# ═══════════════════════════════════════════════════════════════
# Check 6 — Extension symlinked into the editor's extensions dir
# ═══════════════════════════════════════════════════════════════
printf "  [6/8] Extension installed ......... "
EXT_FOUND=""
for ext_dir in "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions" "$HOME/.windsurf/extensions"; do
  if ls "$ext_dir"/neunaha.claws-* >/dev/null 2>&1; then
    EXT_FOUND="$ext_dir"
    break
  fi
done
if [ -n "$EXT_FOUND" ]; then
  printf "%s  ${D}(%s)${N}\n" "$PASS_MARK" "$EXT_FOUND"
  record_pass
else
  printf "%s\n" "$FAIL_MARK"
  print_hint "Looked in: ~/.vscode, ~/.vscode-insiders, ~/.cursor, ~/.windsurf"
  print_fix "Re-run the installer — it symlinks the extension automatically."
  record_fail "6: extension not symlinked into any known editor"
fi

# ═══════════════════════════════════════════════════════════════
# Check 7 — Shell hook injected into at least one rc file
# ═══════════════════════════════════════════════════════════════
printf "  [7/8] Shell hook installed ........ "
HOOK_RC=""
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.config/fish/conf.d/claws.fish"; do
  if [ -f "$rc" ] && grep -q "CLAWS terminal hook" "$rc" 2>/dev/null; then
    HOOK_RC="$rc"
    break
  fi
done
if [ -n "$HOOK_RC" ]; then
  printf "%s  ${D}(%s)${N}\n" "$PASS_MARK" "$(basename "$HOOK_RC")"
  record_pass
else
  printf "%s\n" "$WARN_MARK"
  print_hint "Shell commands (claws-ls, claws-new, etc.) won't work without it."
  print_hint "MCP tools still work — this only affects shell-side commands."
  print_fix "Re-run the installer."
  record_warn
fi

# ═══════════════════════════════════════════════════════════════
# Check 8 — Bridge socket exists in the current project
# ═══════════════════════════════════════════════════════════════
printf "  [8/8] Bridge socket active ........ "
SOCK_PATH="$(pwd)/.claws/claws.sock"
if [ -S "$SOCK_PATH" ]; then
  printf "%s  ${D}(%s)${N}\n" "$PASS_MARK" "$SOCK_PATH"
  record_pass
else
  printf "%s\n" "$WARN_MARK"
  print_hint "No socket at $SOCK_PATH — extension hasn't started here yet."
  print_hint "Open this folder in VS Code (or reload it) to activate the bridge."
  print_fix "VS Code: Cmd+Shift+P → 'Developer: Reload Window'"
  record_warn
fi

# ═══════════════════════════════════════════════════════════════
# Verdict
# ═══════════════════════════════════════════════════════════════
TOTAL=8
printf "\n"
printf "  ${B}Result:${N} %d/%d passed" "$PASS" "$TOTAL"
[ "$WARN" -gt 0 ] && printf "   ${Y}(%d warnings)${N}" "$WARN"
[ "$FAIL" -gt 0 ] && printf "   ${R}(%d failures)${N}" "$FAIL"
printf "\n"

if [ "$FAIL" -eq 0 ] && [ "$WARN" -eq 0 ]; then
  printf "\n  ${G}${B}All systems go.${N}  Try ${B}/claws${N} in Claude Code.\n\n"
  exit 0
elif [ "$FAIL" -eq 0 ]; then
  printf "\n  ${Y}Mostly OK with %d warning(s).${N}  MCP tools should work.\n" "$WARN"
  printf "  Address warnings above when convenient.\n\n"
  exit 0
else
  printf "\n  ${R}${B}%d issue(s) need attention:${N}\n" "$FAIL"
  for f in "${FAILURES[@]}"; do
    printf "    ${R}•${N} Check %s\n" "$f"
  done
  printf "\n"
  printf "  ${B}Next step:${N} run the fix shown above each FAIL line, then:\n"
  printf "    ${B}bash %s${N}\n" "$INSTALL_DIR/scripts/doctor.sh"
  printf "\n"
  printf "  After everything passes:\n"
  printf "    1. Reload VS Code   ${D}(Cmd+Shift+P → Developer: Reload Window)${N}\n"
  printf "    2. Restart Claude Code   ${D}(type 'exit', then 'claude')${N}\n"
  printf "    3. Open a new terminal   ${D}(loads the shell hook)${N}\n"
  printf "\n"
  exit 1
fi
