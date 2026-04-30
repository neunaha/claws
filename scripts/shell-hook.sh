# ═══════════════════════════════════════════════════════════════
# CLAWS — Terminal Control Bridge
# This hook is sourced by .zshrc/.bashrc after install.
# It displays a startup banner and adds claws shell functions.
# ═══════════════════════════════════════════════════════════════

# Only show banner in interactive shells
if [[ $- == *i* ]] && [[ -z "${CLAWS_BANNER_SHOWN:-}" ]]; then
  export CLAWS_BANNER_SHOWN=1

  # ── Version: CLAWS_VERSION env > nearest package.json from script dir ──
  if [ -n "${CLAWS_VERSION:-}" ]; then
    _CLAWS_VERSION="$CLAWS_VERSION"
  elif command -v node >/dev/null 2>&1; then
    # BASH_SOURCE[0] in bash; ZSH_SCRIPT (zsh 5.3+) in zsh; fallback to common install path
    _csd=""
    [ -n "${BASH_SOURCE[0]:-}" ] && _csd="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)"
    [ -z "$_csd" ] && [ -n "${ZSH_SCRIPT:-}" ] && _csd="$(cd "$(dirname "$ZSH_SCRIPT")" 2>/dev/null && pwd -P)"
    [ -z "$_csd" ] && _csd="$HOME/.claws-src/scripts"
    _CLAWS_VERSION=$(node -e "
const path=require('path'),fs=require('fs');
let d=path.resolve('$_csd');
for(let i=0;i<8&&d&&d!=='/';i++,d=path.dirname(d)){
  try{const v=JSON.parse(fs.readFileSync(path.join(d,'package.json'),'utf8')).version;
      if(v){process.stdout.write(v);process.exit(0)}}catch(e){}
}
process.stdout.write('?.?.?');
" 2>/dev/null || echo "?.?.?")
    unset _csd
  else
    _CLAWS_VERSION="?.?.?"
  fi

  # ── Socket detection ──
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

  # ── Colors (ANSI-C quoting — expand cleanly in printf) ──
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    _GRN=$'\033[32m'; _AMB=$'\033[33m'
    _BLD=$'\033[1;37m'; _DIM=$'\033[2m'; _RST=$'\033[0m'
  else
    _GRN=''; _AMB=''; _BLD=''; _DIM=''; _RST=''
  fi

  # ── Bridge status ──
  if [ -S "${CLAWS_SOCK:-}" ] 2>/dev/null; then
    _bstxt="● connected"
    _bsansi="${_GRN}● connected${_RST}"
    _CLAWS_TERMS=$(node -e "
const net=require('net');
const s=net.createConnection('$CLAWS_SOCK');
s.on('connect',()=>s.write(JSON.stringify({id:0,cmd:'list'})+'\n'));
let b='';
s.on('data',d=>{b+=d;if(b.includes('\n')){
  try{process.stdout.write(String(JSON.parse(b.split('\n')[0]).terminals.length))}
  catch(e){process.stdout.write('?')};s.destroy()}});
s.on('error',()=>{process.stdout.write('?');s.destroy()});
setTimeout(()=>{process.stdout.write('?');s.destroy()},2000);
" 2>/dev/null || echo "?")
  else
    _bstxt="○ socket not found"
    _bsansi="${_AMB}○ socket not found${_RST}"
    _CLAWS_TERMS="-"
  fi

  # ── Wrap / pipe-mode state ──
  if [ "${CLAWS_WRAPPED:-}" = "1" ]; then
    if [ "${CLAWS_PIPE_MODE:-}" = "1" ]; then
      _wrtxt="◑ pipe-mode (degraded)"
      _wransi="${_AMB}◑ pipe-mode (degraded)${_RST}"
    else
      _wrtxt="● wrapped (pty logged)"
      _wransi="${_GRN}● wrapped (pty logged)${_RST}"
    fi
  else
    _wrtxt="○ unwrapped"
    _wransi="${_DIM}○ unwrapped${_RST}"
  fi

  # ── Banner — inner content width = 60 chars between the two ║ ──
  _W=60
  # 60 × ═  (box top/bottom border)
  _BDR="════════════════════════════════════════════════════════════"

  # Center plain text within _W chars → (left_pad, right_pad)
  _t="CLAWS"
  _tl=$(( (_W - ${#_t}) / 2 )); _tr=$(( _W - ${#_t} - _tl ))

  _s="Terminal Control Bridge  v${_CLAWS_VERSION}"
  _sl=$(( (_W - ${#_s}) / 2 )); _sr=$(( _W - ${#_s} - _sl ))
  # Guard against oversized version strings
  [ "$_sl" -lt 0 ] && _sl=0; [ "$_sr" -lt 0 ] && _sr=0

  # Status rows: prefix = 3 (lead) + 9 (label) + 2 (gap) = 14 visible chars
  # trailing = _W - 14 - visible_status_len
  _b1=$(( _W - 14 - ${#_bstxt} ))
  _b2=$(( _W - 14 - ${#_CLAWS_TERMS} - 7 ))   # " active" = 7 chars
  _b3=$(( _W - 14 - ${#_wrtxt} ))
  [ "$_b1" -lt 0 ] && _b1=0
  [ "$_b2" -lt 0 ] && _b2=0
  [ "$_b3" -lt 0 ] && _b3=0

  printf "\n"
  printf "  ╔%s╗\n"                                 "$_BDR"
  printf "  ║%${_W}s║\n"                            ""
  printf "  ║%${_tl}s${_BLD}%s${_RST}%${_tr}s║\n"  "" "$_t" ""
  printf "  ║%${_sl}s${_DIM}%s${_RST}%${_sr}s║\n"  "" "$_s" ""
  printf "  ║%${_W}s║\n"                            ""
  printf "  ║   %-9s  %s%${_b1}s║\n"               "Bridge"    "$_bsansi" ""
  printf "  ║   %-9s  %s active%${_b2}s║\n"        "Terminals" "$_CLAWS_TERMS" ""
  printf "  ║   %-9s  %s%${_b3}s║\n"               "This term" "$_wransi" ""
  printf "  ║%${_W}s║\n"                            ""
  printf "  ╚%s╝\n"                                 "$_BDR"
  printf "\n"

  unset _GRN _AMB _BLD _DIM _RST
  unset _bstxt _bsansi _CLAWS_TERMS _wrtxt _wransi
  unset _t _tl _tr _s _sl _sr _b1 _b2 _b3 _W _BDR
  unset CLAWS_SOCK _CLAWS_VERSION
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
