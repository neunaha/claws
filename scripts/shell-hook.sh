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
    _CLAWS_TERMS=$(echo '{"id":0,"cmd":"list"}' | nc -U "$CLAWS_SOCK" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('terminals',[])))" 2>/dev/null || echo "?")
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

  # Banner
  printf "\n"
  printf "  \033[38;2;200;90;62m╔═══════════════════════════════════════════╗\033[0m\n"
  printf "  \033[38;2;200;90;62m║\033[0m                                           \033[38;2;200;90;62m║\033[0m\n"
  printf "  \033[38;2;200;90;62m║\033[0m   \033[1;37mCLAWS\033[0m  Terminal Control Bridge         \033[38;2;200;90;62m║\033[0m\n"
  printf "  \033[38;2;200;90;62m║\033[0m   \033[90mPowered by Claude Opus\033[0m                  \033[38;2;200;90;62m║\033[0m\n"
  printf "  \033[38;2;200;90;62m║\033[0m                                           \033[38;2;200;90;62m║\033[0m\n"
  printf "  \033[38;2;200;90;62m║\033[0m   Bridge:    $_CLAWS_STATUS               \n"
  printf "  \033[38;2;200;90;62m║\033[0m   Terminals: \033[1m${_CLAWS_TERMS}\033[0m active                    \n"
  printf "  \033[38;2;200;90;62m║\033[0m   This term: $_CLAWS_WRAP               \n"
  printf "  \033[38;2;200;90;62m║\033[0m                                           \033[38;2;200;90;62m║\033[0m\n"
  printf "  \033[38;2;200;90;62m║\033[0m   \033[90mclaws-ls\033[0m    list terminals               \033[38;2;200;90;62m║\033[0m\n"
  printf "  \033[38;2;200;90;62m║\033[0m   \033[90mclaws-new\033[0m   create wrapped terminal      \033[38;2;200;90;62m║\033[0m\n"
  printf "  \033[38;2;200;90;62m║\033[0m   \033[90mclaws-run\033[0m   exec command in terminal     \033[38;2;200;90;62m║\033[0m\n"
  printf "  \033[38;2;200;90;62m║\033[0m   \033[90mclaws-log\033[0m   read wrapped terminal log    \033[38;2;200;90;62m║\033[0m\n"
  printf "  \033[38;2;200;90;62m║\033[0m                                           \033[38;2;200;90;62m║\033[0m\n"
  printf "  \033[38;2;200;90;62m╚═══════════════════════════════════════════╝\033[0m\n"
  printf "\n"

  unset _CLAWS_STATUS _CLAWS_TERMS _CLAWS_WRAP
fi

# ═══════════════════════════════════════════════════════════════
# Shell commands — type these in any terminal
# ═══════════════════════════════════════════════════════════════

claws-ls() {
  local sock="${CLAWS_SOCKET:-.claws/claws.sock}"
  echo '{"id":1,"cmd":"list"}' | nc -U "$sock" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for t in d.get('terminals', []):
        w = 'WRAPPED' if t.get('logPath') else '       '
        a = '*' if t.get('active') else ' '
        print(f\"{a} {t['id']:>3}  {t.get('name',''):<25} pid={t.get('pid')}  [{w}]\")
except: print('error: is the Claws extension running?')
" 2>/dev/null || echo "error: cannot connect to $sock"
}

claws-new() {
  local name="${1:-claws}"
  local sock="${CLAWS_SOCKET:-.claws/claws.sock}"
  echo "{\"id\":1,\"cmd\":\"create\",\"name\":\"$name\",\"wrapped\":true}" | nc -U "$sock" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('ok'): print(f\"created terminal {d['id']} — log: {d.get('logPath','')}\")
else: print(f\"error: {d.get('error')}\")
" 2>/dev/null || echo "error: cannot connect to $sock"
}

claws-run() {
  if [ -z "$1" ] || [ -z "$2" ]; then
    echo "usage: claws-run <terminal-id> <command>"
    return 1
  fi
  local id="$1"; shift
  local cmd="$*"
  local sock="${CLAWS_SOCKET:-.claws/claws.sock}"
  python3 -c "
import json, socket, time, uuid, os
from pathlib import Path
s = socket.socket(socket.AF_UNIX)
s.connect('$sock')
eid = uuid.uuid4().hex[:8]
base = Path('/tmp/claws-exec'); base.mkdir(exist_ok=True)
out_f = base / f'{eid}.out'; done_f = base / f'{eid}.done'
wrapper = f'{{ $cmd; }} > {out_f} 2>&1; echo \$? > {done_f}'
s.sendall((json.dumps({'id':1,'cmd':'send','id':'$id','text':wrapper}) + '\n').encode())
s.recv(4096); s.close()
deadline = time.time() + 180
while time.time() < deadline:
    if done_f.exists(): break
    time.sleep(0.2)
if done_f.exists():
    print(f'exit {done_f.read_text().strip()}')
    print(out_f.read_text() if out_f.exists() else '')
    out_f.unlink(missing_ok=True); done_f.unlink(missing_ok=True)
else: print('timeout')
" 2>/dev/null || echo "error: cannot connect to $sock"
}

claws-log() {
  local id="${1:-}"
  local lines="${2:-30}"
  if [ -z "$id" ]; then
    echo "usage: claws-log <terminal-id> [lines]"
    return 1
  fi
  local sock="${CLAWS_SOCKET:-.claws/claws.sock}"
  echo "{\"id\":1,\"cmd\":\"readLog\",\"id\":\"$id\",\"strip\":true}" | nc -U "$sock" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('ok'):
    lines = d.get('bytes','').splitlines()
    for l in lines[-$lines:]: print(l)
    print(f'\n[{d.get(\"totalSize\",0)} bytes total]')
else: print(f\"error: {d.get('error')}\")
" 2>/dev/null || echo "error: cannot connect to $sock"
}
