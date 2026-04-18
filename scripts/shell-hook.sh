# ═══════════════════════════════════════════════════════════════
# CLAWS — Terminal Control Bridge
# This hook is sourced by .zshrc/.bashrc after install.
# It displays a startup banner and adds claws shell functions.
# ═══════════════════════════════════════════════════════════════

# Only show banner in interactive shells
if [[ $- == *i* ]] && [[ -z "${CLAWS_BANNER_SHOWN:-}" ]]; then
  export CLAWS_BANNER_SHOWN=1

  # Detect if Claws socket is active
  CLAWS_SOCK="${CLAWS_SOCKET:-.claws/claws.sock}"
  if [ -S "$CLAWS_SOCK" ] 2>/dev/null; then
    _CLAWS_STATUS="\033[32m● connected\033[0m"
    _CLAWS_TERMS=$(node -e "
const net=require('net');
const s=net.createConnection('$CLAWS_SOCK');
s.on('connect',()=>s.write(JSON.stringify({id:0,cmd:'list'})+'\n'));
let b='';
s.on('data',d=>{b+=d;if(b.includes('\n')){try{console.log(JSON.parse(b.split('\n')[0]).terminals.length)}catch(e){console.log('?')};s.destroy()}});
s.on('error',()=>{console.log('?');s.destroy()});
setTimeout(()=>{console.log('?');s.destroy()},2000);
" 2>/dev/null || echo "?")
  else
    _CLAWS_STATUS="\033[33m○ socket not found\033[0m"
    _CLAWS_TERMS="-"
  fi

  # Detect if wrapped
  if [ "${CLAWS_WRAPPED:-}" = "1" ]; then
    _CLAWS_WRAP="\033[32m● wrapped\033[0m (pty logged)"
  else
    _CLAWS_WRAP="\033[90m○ unwrapped\033[0m"
  fi

  # Banner — ASCII art CLAWS logo matching the install-flow image
  _T="\033[38;2;200;90;62m"  # terracotta
  _W="\033[1;37m"             # bold white
  _G="\033[32m"               # green
  _D="\033[90m"               # dim
  _R="\033[0m"                # reset

  printf "\n"
  printf "  ${_T}╔═══════════════════════════════════════════════╗${_R}\n"
  printf "  ${_T}║${_R}                                               ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_T} ██████╗██╗      █████╗ ██╗    ██╗███████╗${_R} ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_T}██╔════╝██║     ██╔══██╗██║    ██║██╔════╝${_R} ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_T}██║     ██║     ███████║██║ █╗ ██║███████╗${_R} ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_T}██║     ██║     ██╔══██║██║███╗██║╚════██║${_R} ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_T}╚██████╗███████╗██║  ██║╚███╔███╔╝███████║${_R} ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_T} ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝${_R} ${_T}║${_R}\n"
  printf "  ${_T}║${_R}                                               ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_D}Terminal Control Bridge  v0.3.0${_R}             ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_D}Powered by Claude Opus${_R}                     ${_T}║${_R}\n"
  printf "  ${_T}║${_R}                                               ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   Bridge:    $_CLAWS_STATUS                   ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   Terminals: ${_W}${_CLAWS_TERMS}${_R} active                        ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   This term: $_CLAWS_WRAP                   ${_T}║${_R}\n"
  printf "  ${_T}║${_R}                                               ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_D}claws-ls${_R}    list terminals                 ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_D}claws-new${_R}   create wrapped terminal        ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_D}claws-run${_R}   exec command in terminal       ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_D}claws-log${_R}   read wrapped terminal log      ${_T}║${_R}\n"
  printf "  ${_T}║${_R}                                               ${_T}║${_R}\n"
  printf "  ${_T}╚═══════════════════════════════════════════════╝${_R}\n"
  printf "\n"

  unset _CLAWS_STATUS _CLAWS_TERMS _CLAWS_WRAP
fi

# ═══════════════════════════════════════════════════════════════
# Shell commands — type these in any terminal
# ─────────────────────────────────────────────────────────────────
# All user input is passed via env vars (process.env.*). The node
# scripts are single-quoted heredocs so bash performs zero
# interpolation — argument values can never be interpreted as JS.
# ═══════════════════════════════════════════════════════════════

claws-ls() {
  CLAWS_SOCK="${CLAWS_SOCKET:-.claws/claws.sock}" node -e '
const net = require("net");
const s = net.createConnection(process.env.CLAWS_SOCK);
s.on("connect", () => s.write(JSON.stringify({ id: 1, cmd: "list" }) + "\n"));
let b = "";
s.on("data", (d) => {
  b += d;
  if (b.includes("\n")) {
    try {
      const r = JSON.parse(b.split("\n")[0]);
      (r.terminals || []).forEach((t) => {
        const w = t.logPath ? "WRAPPED" : "       ";
        const a = t.active ? "*" : " ";
        console.log(a + " " + String(t.id).padStart(3) + " " +
          String(t.name || "").padEnd(25) + " pid=" + t.pid + "  [" + w + "]");
      });
    } catch (e) {
      console.log("error: " + e.message + " — is the Claws extension running?");
    }
    s.destroy();
  }
});
s.on("error", (e) => { console.log("error: " + e.message + " — is the Claws extension running?"); s.destroy(); });
setTimeout(() => { console.log("error: timeout"); s.destroy(); }, 5000);
' 2>/dev/null || echo "error: node not available"
}

claws-new() {
  CLAWS_SOCK="${CLAWS_SOCKET:-.claws/claws.sock}" \
  CLAWS_NAME="${1:-claws}" \
  node -e '
const net = require("net");
const s = net.createConnection(process.env.CLAWS_SOCK);
s.on("connect", () => s.write(JSON.stringify({
  id: 1, cmd: "create", name: process.env.CLAWS_NAME, wrapped: true,
}) + "\n"));
let b = "";
s.on("data", (d) => {
  b += d;
  if (b.includes("\n")) {
    try {
      const r = JSON.parse(b.split("\n")[0]);
      if (r.ok) console.log("created terminal " + r.id + " — log: " + (r.logPath || ""));
      else console.log("error: " + r.error);
    } catch (e) { console.log("error: " + e.message); }
    s.destroy();
  }
});
s.on("error", (e) => { console.log("error: " + e.message); s.destroy(); });
setTimeout(() => { console.log("error: timeout"); s.destroy(); }, 5000);
' 2>/dev/null || echo "error: node not available"
}

claws-run() {
  if [ -z "$1" ] || [ -z "$2" ]; then
    echo "usage: claws-run <terminal-id> <command>"
    return 1
  fi
  local id="$1"; shift
  local cmd="$*"
  # Command goes via tempfile so it is never on a command line; id and
  # sock go via env so they can never be interpreted as JS.
  local tmpf
  # Portable mktemp: pass an explicit template path so both BSD (macOS) and
  # GNU (Linux) substitute the X's. `-t prefix` differs between the two.
  tmpf="$(mktemp "${TMPDIR:-/tmp}/claws-cmd.XXXXXX")" || return 1
  printf '%s' "$cmd" > "$tmpf"
  CLAWS_SOCK="${CLAWS_SOCKET:-.claws/claws.sock}" \
  CLAWS_TERM_ID="$id" \
  CLAWS_CMD_FILE="$tmpf" \
  node -e '
const net = require("net"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const sockPath = process.env.CLAWS_SOCK;
const termId   = process.env.CLAWS_TERM_ID;
const cmdFile  = process.env.CLAWS_CMD_FILE;
const cmd = fs.readFileSync(cmdFile, "utf8");
try { fs.unlinkSync(cmdFile); } catch (e) {}
const eid = crypto.randomBytes(4).toString("hex");
const base = path.join(require("os").tmpdir(), "claws-exec");
try { fs.mkdirSync(base, { recursive: true }); } catch (e) {}
const outF  = path.join(base, eid + ".out");
const doneF = path.join(base, eid + ".done");
const wrapper = "{ " + cmd + "; } > " + outF + " 2>&1; echo $? > " + doneF;
const s = net.createConnection(sockPath);
s.on("connect", () => s.write(JSON.stringify({
  id: termId, cmd: "send", text: wrapper,
}) + "\n"));
let b = "";
s.on("data", (d) => { b += d; if (b.includes("\n")) poll(); });
function poll() {
  const deadline = Date.now() + 180000;
  const iv = setInterval(() => {
    try {
      if (fs.existsSync(doneF)) {
        clearInterval(iv);
        console.log("exit " + fs.readFileSync(doneF, "utf8").trim());
        try { console.log(fs.readFileSync(outF, "utf8")); } catch (e) {}
        try { fs.unlinkSync(outF); } catch (e) {}
        try { fs.unlinkSync(doneF); } catch (e) {}
        s.destroy();
      }
    } catch (e) {}
    if (Date.now() > deadline) {
      clearInterval(iv);
      console.log("timeout");
      s.destroy();
    }
  }, 200);
}
s.on("error", (e) => { console.log("error: " + e.message); s.destroy(); });
' 2>/dev/null || echo "error: node not available"
}

claws-log() {
  local id="${1:-}"
  local lines="${2:-30}"
  if [ -z "$id" ]; then
    echo "usage: claws-log <terminal-id> [lines]"
    return 1
  fi
  CLAWS_SOCK="${CLAWS_SOCKET:-.claws/claws.sock}" \
  CLAWS_TERM_ID="$id" \
  CLAWS_LINES="$lines" \
  node -e '
const net = require("net");
// Coerce CLAWS_LINES to a positive integer; never trust the env var as code.
const linesN = Math.max(1, parseInt(process.env.CLAWS_LINES, 10) || 30);
const s = net.createConnection(process.env.CLAWS_SOCK);
s.on("connect", () => s.write(JSON.stringify({
  id: process.env.CLAWS_TERM_ID, cmd: "readLog", strip: true,
}) + "\n"));
let b = "";
s.on("data", (d) => {
  b += d;
  if (b.includes("\n")) {
    try {
      const r = JSON.parse(b.split("\n")[0]);
      if (r.ok) {
        const arr = (r.bytes || "").split("\n");
        arr.slice(-linesN).forEach((l) => console.log(l));
        console.log("\n[" + (r.totalSize || 0) + " bytes total]");
      } else {
        console.log("error: " + r.error);
      }
    } catch (e) { console.log("error: " + e.message); }
    s.destroy();
  }
});
s.on("error", (e) => { console.log("error: " + e.message); s.destroy(); });
setTimeout(() => { console.log("error: timeout"); s.destroy(); }, 10000);
' 2>/dev/null || echo "error: node not available"
}
