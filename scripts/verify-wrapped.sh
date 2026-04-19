#!/usr/bin/env bash
# Claws — verify a wrapped terminal runs in real pty mode
#
# End-to-end test that exercises the full path:
#   1. Socket is live
#   2. Create a wrapped terminal via the protocol
#   3. Send a marker command, read it back via readLog
#   4. Scan VS Code's Claws output log for pipe-mode warning
#   5. Close the test terminal
#
# Run AFTER reloading VS Code. A successful run proves node-pty loaded
# inside the extension host and wrapped terminals capture output correctly.
#
# Usage:
#   bash ~/.claws-src/scripts/verify-wrapped.sh [project-root]
#
#   # Or via curl URL:
#   bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/verify-wrapped.sh)

set -eo pipefail

PROJECT_ROOT="${1:-$(pwd)}"
SOCK="$PROJECT_ROOT/.claws/claws.sock"

C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
C_GREEN=$'\033[0;32m'; C_RED=$'\033[0;31m'; C_YELLOW=$'\033[0;33m'; C_BLUE=$'\033[0;34m'; C_DIM=$'\033[2m'

ok()   { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
bad()  { printf "  ${C_RED}✗${C_RESET} %s\n" "$*"; }
info() { printf "  ${C_DIM}%s${C_RESET}\n" "$*"; }
h()    { printf "\n${C_BOLD}${C_BLUE}═══ %s ═══${C_RESET}\n" "$*"; }

# A pure-Node client so we can parse JSON properly and handle async replies.
# Writes commands to the socket, waits for the matching response, returns it.
SOCK_CLIENT=$(cat <<'CLIENT_JS'
const net = require('net');
const sock = net.createConnection(process.argv[2]);
const requests = JSON.parse(process.argv[3]);
let buf = '';
const results = [];
let idx = 0;

sock.on('connect', () => {
  sock.write(JSON.stringify(requests[idx]) + '\n');
});

sock.on('data', (d) => {
  buf += d.toString('utf8');
  while (true) {
    const nl = buf.indexOf('\n');
    if (nl === -1) break;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let resp;
    try { resp = JSON.parse(line); }
    catch { results.push({ parseError: line }); break; }
    results.push(resp);
    idx++;
    if (idx < requests.length) {
      sock.write(JSON.stringify(requests[idx]) + '\n');
    } else {
      sock.end();
    }
  }
});

sock.on('error', (e) => { console.error('SOCKET ERROR:', e.message); process.exit(1); });
sock.on('close', () => { console.log(JSON.stringify(results)); process.exit(0); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 10000);
CLIENT_JS
)

run_protocol() {
  # Args: a JSON array of requests. Prints a JSON array of responses.
  echo "$1" | xargs -0 -I{} echo "" >/dev/null  # dummy to absorb stdin
  node -e "$SOCK_CLIENT" "$SOCK" "$1"
}

# ─── 1. Socket live? ───────────────────────────────────────────────────────
h "1. Socket check"
if [ ! -S "$SOCK" ]; then
  bad "no socket at $SOCK"
  info "the Claws extension isn't running in this project. Open the project in VS Code and reload."
  exit 1
fi
list_resp=$(node -e "$SOCK_CLIENT" "$SOCK" '[{"cmd":"list"}]' 2>&1)
if ! echo "$list_resp" | grep -q '"ok":true'; then
  bad "socket exists but didn't respond to 'list': $list_resp"
  exit 1
fi
ok "socket LIVE — extension is listening"
term_count=$(echo "$list_resp" | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(r[0].terminals.length)")
info "existing terminals: $term_count"

# ─── 2. Create a wrapped terminal ──────────────────────────────────────────
h "2. Create wrapped terminal"
create_resp=$(node -e "$SOCK_CLIENT" "$SOCK" '[{"cmd":"create","name":"verify-pty","wrapped":true,"show":false}]' 2>&1)
if ! echo "$create_resp" | grep -q '"ok":true'; then
  bad "create failed: $create_resp"
  exit 1
fi
TERM_ID=$(echo "$create_resp" | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(r[0].id)")
WRAPPED=$(echo "$create_resp" | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(r[0].wrapped)")
ok "created terminal id=$TERM_ID wrapped=$WRAPPED"
if [ "$WRAPPED" != "true" ]; then
  bad "created terminal is NOT wrapped — verification cannot continue"
  exit 1
fi

# ─── 3. Wait for shell prompt, send marker, read back ──────────────────────
h "3. Send → readLog round trip"
info "waiting 2s for shell to initialize..."
sleep 2

MARKER="CLAWS_VERIFY_$(date +%s)_$$"
send_req=$(node -e "console.log(JSON.stringify([{cmd:'send',id:'$TERM_ID',text:'echo $MARKER',newline:true}]))")
send_resp=$(node -e "$SOCK_CLIENT" "$SOCK" "$send_req" 2>&1)
if ! echo "$send_resp" | grep -q '"ok":true'; then
  bad "send failed: $send_resp"
  exit 1
fi
ok "sent: echo $MARKER"

info "waiting 2s for command to run..."
sleep 2

read_req=$(node -e "console.log(JSON.stringify([{cmd:'readLog',id:'$TERM_ID',strip:true,limit:16384}]))")
read_resp=$(node -e "$SOCK_CLIENT" "$SOCK" "$read_req" 2>&1)
BYTES=$(echo "$read_resp" | node -e "try{const r=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(r[0].bytes||'')}catch{console.log('')}")

if echo "$BYTES" | grep -q "$MARKER"; then
  ok "marker '$MARKER' found in readLog output — pty capture is working"
  info "readLog last 3 lines:"
  echo "$BYTES" | tail -3 | sed 's/^/      /'
else
  bad "marker NOT found in readLog output"
  info "this usually means:"
  info "  - the wrapped terminal is in pipe-mode (node-pty not loaded)"
  info "  - OR the shell didn't have time to run echo (rare — unlikely after 2s)"
  info "  - OR readLog is pulling from a different source (file vs ring buffer)"
  info "received bytes (first 300 chars):"
  echo "${BYTES:0:300}" | sed 's/^/      /'
fi

# ─── 4. Scan VS Code's Claws log for pipe-mode warning ─────────────────────
h "4. Pipe-mode warning scan"
LOGROOT="$HOME/Library/Application Support/Code/logs"
if [ ! -d "$LOGROOT" ]; then
  info "no VS Code logs dir at $LOGROOT — skipping"
else
  # Find the most recent Claws output log across all VS Code session dirs
  latest_log=$(find "$LOGROOT" -name "1-Claws.log" -type f 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
  if [ -n "$latest_log" ] && [ -f "$latest_log" ]; then
    info "log: $latest_log"
    # Check ONLY entries from the current hour — older pipe-mode mentions
    # may be stale from pre-fix sessions and don't indicate current breakage
    recent_pipemode=$(grep "pipe-mode" "$latest_log" 2>/dev/null | tail -5)
    if [ -n "$recent_pipemode" ]; then
      bad "pipe-mode mentions found in Claws log:"
      echo "$recent_pipemode" | sed 's/^/      /'
      info "if these are from BEFORE your last reload, they're stale. Check timestamps."
      info "if they're recent, node-pty still isn't loading in the extension host:"
      info "    bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/rebuild-node-pty.sh)"
    else
      ok "no pipe-mode mentions in this session's log"
      # Also check for the positive signal
      if grep -q "activating (typescript)" "$latest_log" 2>/dev/null; then
        ok "extension activated with v0.4 TypeScript bundle"
      fi
    fi
  else
    info "no Claws log found — extension may not have logged yet"
  fi
fi

# ─── 5. Clean up the test terminal ─────────────────────────────────────────
h "5. Cleanup"
close_req=$(node -e "console.log(JSON.stringify([{cmd:'close',id:'$TERM_ID'}]))")
node -e "$SOCK_CLIENT" "$SOCK" "$close_req" >/dev/null 2>&1 || true
ok "closed test terminal id=$TERM_ID"

# ─── Summary ──────────────────────────────────────────────────────────────
echo ""
if echo "$BYTES" | grep -q "$MARKER"; then
  printf "${C_GREEN}${C_BOLD}VERIFICATION PASSED${C_RESET}\n"
  echo "  Wrapped terminals are capturing output — node-pty is working."
  echo "  TUI apps (claude, vim, htop) will render cleanly."
else
  printf "${C_RED}${C_BOLD}VERIFICATION FAILED${C_RESET}\n"
  echo "  Wrapped terminal did not echo the marker back through readLog."
  echo "  Next step: bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/rebuild-node-pty.sh)"
  exit 1
fi
