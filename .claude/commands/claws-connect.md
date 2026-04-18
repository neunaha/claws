---
name: claws-connect
description: Connect to the Claws socket and verify the bridge is live. Run this first in any new Claude Code session to confirm terminal control is available.
---

# /claws-connect

Verify the Claws bridge is reachable and ready for terminal control.

## What to do

1. Detect the socket path (check config, fall back to default):
```bash
SOCK="${1:-.claws/claws.sock}"
test -S "$SOCK" && echo "socket found: $SOCK" || { echo "ERROR: no socket at $SOCK — is VS Code running with Claws extension?"; exit 1; }
```

2. Send a ping (list command) to verify the server responds:
```bash
node -e "
const net=require('net');
const sock='${SOCK:-.claws/claws.sock}';
const s=net.createConnection(sock);
s.on('connect',()=>s.write(JSON.stringify({id:0,cmd:'list'})+'\n'));
let b='';
s.on('data',d=>{
  b+=d;
  const nl=b.indexOf('\n');
  if(nl!==-1){
    const r=JSON.parse(b.slice(0,nl));
    const n=(r.terminals||[]).length;
    console.log('Claws connected — '+n+' terminal(s) active');
    s.destroy();
  }
});
s.on('error',e=>{console.error('ERROR: '+e.message);process.exit(1);});
"
```

3. If connected, report: "Claws bridge live. N terminals visible. Ready for /claws-create, /claws-send, /claws-exec."
4. If failed, suggest: check that VS Code is open with the Claws extension installed, and run `Cmd+Shift+P → Developer: Reload Window`.
