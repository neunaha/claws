# CLAWS — Terminal Control Bridge
# Native fish hook — sourced from ~/.config/fish/conf.d/claws.fish
# No bass dependency. Pure fish syntax.

if not status is-interactive
    exit
end

# Avoid showing banner more than once per session
if set -q CLAWS_BANNER_SHOWN
    # Still define functions even if banner already shown
else
    set -gx CLAWS_BANNER_SHOWN 1

    # Detect socket status.
    # Walk up from $PWD — the extension creates the socket at
    # <workspace-root>/.claws/claws.sock, not relative to $PWD.
    set -l sock ""
    if test -n "$CLAWS_SOCKET"
        set sock $CLAWS_SOCKET
    else
        set -l _walk (pwd)
        while test "$_walk" != "/"
            if test -S "$_walk/.claws/claws.sock"
                set sock "$_walk/.claws/claws.sock"
                break
            end
            set _walk (dirname $_walk)
        end
    end
    set -l claws_status ""
    set -l claws_terms "-"

    if test -n "$sock"; and test -S $sock
        set claws_status "\033[32m● connected\033[0m"
        set claws_terms (node -e "
const net=require('net');
const s=net.createConnection('$sock');
s.on('connect',()=>s.write(JSON.stringify({id:0,cmd:'list'})+'\n'));
let b='';
s.on('data',d=>{b+=d;if(b.includes('\n')){try{process.stdout.write(String(JSON.parse(b.split('\n')[0]).terminals.length))}catch(e){process.stdout.write('?')};s.destroy()}});
s.on('error',()=>{process.stdout.write('?');s.destroy()});
setTimeout(()=>{process.stdout.write('?');s.destroy()},2000);
" 2>/dev/null; or echo "?")
    else
        set claws_status "\033[33m○ socket not found\033[0m"
    end

    # Detect wrapped
    set -l claws_wrap ""
    if test -n "$CLAWS_WRAPPED" && test "$CLAWS_WRAPPED" = "1"
        set claws_wrap "\033[32m● wrapped\033[0m (pty logged)"
    else
        set claws_wrap "\033[90m○ unwrapped\033[0m"
    end

    set -l T "\033[38;2;200;90;62m"
    set -l W "\033[1;37m"
    set -l D "\033[90m"
    set -l R "\033[0m"

    printf "\n"
    printf "  $T╔═══════════════════════════════════════════════╗$R\n"
    printf "  $T║$R                                               $T║$R\n"
    printf "  $T║$R   $T ██████╗██╗      █████╗ ██╗    ██╗███████╗$R $T║$R\n"
    printf "  $T║$R   $T██╔════╝██║     ██╔══██╗██║    ██║██╔════╝$R $T║$R\n"
    printf "  $T║$R   $T██║     ██║     ███████║██║ █╗ ██║███████╗$R $T║$R\n"
    printf "  $T║$R   $T██║     ██║     ██╔══██║██║███╗██║╚════██║$R $T║$R\n"
    printf "  $T║$R   $T╚██████╗███████╗██║  ██║╚███╔███╔╝███████║$R $T║$R\n"
    printf "  $T║$R   $T ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝$R $T║$R\n"
    printf "  $T║$R                                               $T║$R\n"
    printf "  $T║$R   ${D}Terminal Control Bridge$R                     $T║$R\n"
    printf "  $T║$R                                               $T║$R\n"
    printf "  $T║$R   Bridge:    $claws_status                   $T║$R\n"
    printf "  $T║$R   Terminals: $W$claws_terms$R active                        $T║$R\n"
    printf "  $T║$R   This term: $claws_wrap                   $T║$R\n"
    printf "  $T║$R                                               $T║$R\n"
    printf "  $T║$R   ${D}claws-ls$R    list terminals                 $T║$R\n"
    printf "  $T║$R   ${D}claws-new$R   create wrapped terminal        $T║$R\n"
    printf "  $T║$R   ${D}claws-run$R   exec command in terminal       $T║$R\n"
    printf "  $T║$R   ${D}claws-log$R   read wrapped terminal log      $T║$R\n"
    printf "  $T║$R                                               $T║$R\n"
    printf "  $T╚═══════════════════════════════════════════════╝$R\n"
    printf "\n"
end

# ── Shell functions ─────────────────────────────────────────────────────────

function _claws_find_sock
    if test -n "$CLAWS_SOCKET"
        echo $CLAWS_SOCKET; return
    end
    set -l _w (pwd)
    while test "$_w" != "/"
        if test -S "$_w/.claws/claws.sock"
            echo "$_w/.claws/claws.sock"; return
        end
        set _w (dirname $_w)
    end
    echo ".claws/claws.sock"
end

function claws-ls
    set -l sock (_claws_find_sock)
    node -e "
const net=require('net');
const s=net.createConnection('$sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'list'})+'\n'));
let b='';
s.on('data',d=>{b+=d;if(b.includes('\n')){try{const d2=JSON.parse(b.split('\n')[0]);(d2.terminals||[]).forEach(t=>{const w=t.logPath?'WRAPPED':'       ';const a=t.active?'*':' ';console.log(a+' '+String(t.id).padStart(3)+' '+String(t.name||'').padEnd(25)+' pid='+t.pid+'  ['+w+']')})}catch(e){console.log('error: '+e.message)};s.destroy()}});
s.on('error',e=>{console.log('error: '+e.message+' — is the Claws extension running?');s.destroy()});
setTimeout(()=>{console.log('error: timeout');s.destroy()},5000);
" 2>/dev/null; or echo "error: node not available"
end

function claws-new
    set -l name (test -n "$argv[1]" && echo $argv[1] || echo "claws")
    set -l sock (_claws_find_sock)
    node -e "
const net=require('net');
const s=net.createConnection('$sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'create',name:'$name',wrapped:true})+'\n'));
let b='';
s.on('data',d=>{b+=d;if(b.includes('\n')){try{const r=JSON.parse(b.split('\n')[0]);console.log('created terminal id='+r.id+(r.logPath?' log='+r.logPath:''))}catch(e){console.log('error: '+e.message)};s.destroy()}});
s.on('error',e=>{console.log('error: '+e.message);s.destroy()});
setTimeout(()=>{console.log('error: timeout');s.destroy()},5000);
" 2>/dev/null; or echo "error: node not available"
end

function claws-run
    set -l cmd (string join " " $argv)
    set -l sock (_claws_find_sock)
    node -e "
const net=require('net');
const s=net.createConnection('$sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'exec',command:'$cmd'})+'\n'));
let b='';
s.on('data',d=>{b+=d;if(b.includes('\n')){try{const r=JSON.parse(b.split('\n')[0]);console.log(r.output||'');process.exit(r.exitCode||0)}catch(e){console.log('error: '+e.message)};s.destroy()}});
s.on('error',e=>{console.log('error: '+e.message);s.destroy()});
setTimeout(()=>{console.log('error: timeout');s.destroy()},30000);
" 2>/dev/null; or echo "error: node not available"
end

function claws-log
    set -l id $argv[1]
    set -l sock (_claws_find_sock)
    node -e "
const net=require('net');
const s=net.createConnection('$sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'readLog',id:'$id',strip:true})+'\n'));
let b='';
s.on('data',d=>{b+=d;if(b.includes('\n')){try{const r=JSON.parse(b.split('\n')[0]);process.stdout.write(r.bytes||'')}catch(e){console.log('error: '+e.message)};s.destroy()}});
s.on('error',e=>{console.log('error: '+e.message);s.destroy()});
setTimeout(()=>{console.log('error: timeout');s.destroy()},5000);
" 2>/dev/null; or echo "error: node not available"
end
