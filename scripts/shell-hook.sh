# ═══════════════════════════════════════════════════════════════
# CLAWS — Terminal Control Bridge
# This hook is sourced by .zshrc/.bashrc after install.
# It displays a startup banner and adds claws shell functions.
# ═══════════════════════════════════════════════════════════════

# Only show banner in interactive shells
if [[ $- == *i* ]] && [[ -z "${CLAWS_BANNER_SHOWN:-}" ]]; then
  export CLAWS_BANNER_SHOWN=1

  # Detect if Claws socket is active.
  # Walk up from $PWD — the extension creates the socket at
  # <workspace-root>/.claws/claws.sock, not relative to $PWD.
  CLAWS_SOCK="${CLAWS_SOCKET:-}"
  if [ -z "$CLAWS_SOCK" ]; then
    _walk="$PWD"
    while [ -n "$_walk" ] && [ "$_walk" != "/" ]; do
      if [ -S "$_walk/.claws/claws.sock" ]; then
        CLAWS_SOCK="$_walk/.claws/claws.sock"
        break
      fi
      _walk="${_walk%/*}"
    done
    unset _walk
  fi
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
  printf "  ${_T}╔══════════════════════════════════════════════════════════════════╗${_R}\n"
  printf "  ${_T}║${_R}                                                        ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_T} ██████╗██╗      █████╗ ██╗    ██╗███████╗${_R} ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_T}██╔════╝██║     ██╔══██╗██║    ██║██╔════╝${_R} ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_T}██║     ██║     ███████║██║ █╗ ██║███████╗${_R} ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_T}██║     ██║     ██╔══██║██║███╗██║╚════██║${_R} ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_T}╚██████╗███████╗██║  ██║╚███╔███╔╝███████║${_R} ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_T} ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝${_R} ${_T}║${_R}\n"
  printf "  ${_T}║${_R}                                                        ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_D}Terminal Control Bridge  v0.6.1${_R}            ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_D}VS Code Extension${_R}                          ${_T}║${_R}\n"
  printf "  ${_T}║${_R}                                                        ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   Bridge:    $_CLAWS_STATUS                            ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   Terminals: ${_W}${_CLAWS_TERMS}${_R} active          ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   This term: $_CLAWS_WRAP                              ${_T}║${_R}\n"
  printf "  ${_T}║${_R}                                                        ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_D}claws-ls${_R}    list terminals                 ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_D}claws-new${_R}   create wrapped terminal        ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_D}claws-run${_R}   exec command in terminal       ${_T}║${_R}\n"
  printf "  ${_T}║${_R}   ${_D}claws-log${_R}   read wrapped terminal log      ${_T}║${_R}\n"
  printf "  ${_T}║${_R}                                                        ${_T}║${_R}\n"
  printf "  ${_T}╚══════════════════════════════════════════════════════════════════╝${_R}\n"
  printf "\n"

  unset _CLAWS_STATUS _CLAWS_TERMS _CLAWS_WRAP
fi

# ═══════════════════════════════════════════════════════════════
# Shell commands — type these in any terminal
# ═══════════════════════════════════════════════════════════════

_claws_find_sock() {
  if [ -n "${CLAWS_SOCKET:-}" ]; then echo "$CLAWS_SOCKET"; return; fi
  local _w="$PWD"
  while [ -n "$_w" ] && [ "$_w" != "/" ]; do
    [ -S "$_w/.claws/claws.sock" ] && { echo "$_w/.claws/claws.sock"; return; }
    _w="${_w%/*}"
  done
  echo ""
}

_claws_require_sock() {
  local _s; _s="$(_claws_find_sock)"
  if [ -z "$_s" ]; then
    echo "claws: no socket found — open a Claws project in VS Code first" >&2
    return 1
  fi
  echo "$_s"
}

claws-ls() {
  local sock; sock="$(_claws_require_sock)" || return 1
  node -e "
const net=require('net');
const s=net.createConnection('$sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'list'})+'\n'));
let b='';
const t=setTimeout(()=>{console.log('error: timeout — is VS Code open with the Claws extension?');s.destroy()},5000);
s.on('data',d=>{b+=d;if(b.includes('\n')){clearTimeout(t);try{const d2=JSON.parse(b.split('\n')[0]);(d2.terminals||[]).forEach(t=>{const w=t.logPath?'WRAPPED':'       ';const a=t.active?'*':' ';console.log(a+' '+String(t.id).padStart(3)+' '+String(t.name||'').padEnd(25)+' pid='+t.pid+'  ['+w+']')})}catch(e){console.log('error: '+e.message)};s.destroy()}});
s.on('error',e=>{clearTimeout(t);console.log('error: '+e.message+' — is the Claws extension running?');s.destroy()});
" 2>/dev/null || echo "error: node not available"
}

claws-new() {
  local name="${1:-claws}"
  local sock; sock="$(_claws_require_sock)" || return 1
  node -e "
const net=require('net');
const s=net.createConnection('$sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'create',name:'$name',wrapped:true})+'\n'));
let b='';
const t=setTimeout(()=>{console.log('error: timeout');s.destroy()},5000);
s.on('data',d=>{b+=d;if(b.includes('\n')){clearTimeout(t);try{const d2=JSON.parse(b.split('\n')[0]);if(d2.ok){console.log('created terminal '+d2.id+' — log: '+(d2.logPath||'none'))}else{console.log('error: '+d2.error)}}catch(e){console.log('error: '+e.message)};s.destroy()}});
s.on('error',e=>{clearTimeout(t);console.log('error: '+e.message);s.destroy()});
" 2>/dev/null || echo "error: node not available"
}

claws-run() {
  if [ -z "$1" ] || [ -z "$2" ]; then
    echo "usage: claws-run <terminal-id> <command>"
    return 1
  fi
  local id="$1"; shift
  local cmd="$*"
  local sock; sock="$(_claws_require_sock)" || return 1
  # Write command to temp file to avoid shell injection via $cmd interpolation
  local tmpf="/tmp/claws-cmd-$$.txt"
  printf '%s' "$cmd" > "$tmpf"
  node -e "
const net=require('net'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const sockPath='$sock',termId='$id',cmdFile='$tmpf';
const cmd=fs.readFileSync(cmdFile,'utf8');
try{fs.unlinkSync(cmdFile)}catch(e){}
const s=net.createConnection(sockPath);
const eid=crypto.randomBytes(4).toString('hex');
const base='/tmp/claws-exec';
try{fs.mkdirSync(base,{recursive:true})}catch(e){}
const outF=path.join(base,eid+'.out'),doneF=path.join(base,eid+'.done');
const wrapper='{ '+cmd+'; } > '+outF+' 2>&1; echo \$? > '+doneF;
s.on('connect',()=>{s.write(JSON.stringify({id:1,cmd:'send',id:termId,text:wrapper})+'\n')});
let b='';
s.on('data',d=>{b+=d;if(b.includes('\n')){poll()}});
function poll(){const deadline=Date.now()+180000;const iv=setInterval(()=>{try{if(fs.existsSync(doneF)){clearInterval(iv);console.log('exit '+fs.readFileSync(doneF,'utf8').trim());try{console.log(fs.readFileSync(outF,'utf8'))}catch(e){};try{fs.unlinkSync(outF)}catch(e){};try{fs.unlinkSync(doneF)}catch(e){};s.destroy()}}catch(e){}if(Date.now()>deadline){clearInterval(iv);console.log('timeout');s.destroy()}},200)}
s.on('error',e=>{console.log('error: '+e.message);s.destroy()});
" 2>/dev/null || echo "error: node not available"
}

claws-log() {
  local id="${1:-}"
  local lines="${2:-30}"
  if [ -z "$id" ]; then
    echo "usage: claws-log <terminal-id> [lines]"
    return 1
  fi
  local sock; sock="$(_claws_require_sock)" || return 1
  node -e "
const net=require('net');
const s=net.createConnection('$sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'readLog',id:'$id',strip:true})+'\n'));
let b='';
const t=setTimeout(()=>{console.log('error: timeout');s.destroy()},10000);
s.on('data',d=>{b+=d;if(b.includes('\n')){clearTimeout(t);try{const d2=JSON.parse(b.split('\n')[0]);if(d2.ok){const lines=(d2.bytes||'').split('\n');lines.slice(-$lines).forEach(l=>console.log(l));console.log('\n['+(d2.totalSize||0)+' bytes total]')}else{console.log('error: '+d2.error)}}catch(e){console.log('error: '+e.message)};s.destroy()}});
s.on('error',e=>{clearTimeout(t);console.log('error: '+e.message);s.destroy()});
" 2>/dev/null || echo "error: node not available"
}
