---
name: claws-status
description: Show Claws extension status — socket path, connected clients, active terminals, wrapped terminals, log sizes. Quick health check.
---

# /claws-status

Show the current state of the Claws extension in this workspace.

## What to do

1. Check if the Claws socket exists and is listening:
```bash
ls -la .claws/claws.sock 2>/dev/null && echo "socket exists" || echo "no socket — is Claws extension activated?"
```

2. List all terminals via the socket:
```bash
node -e "
const net=require('net');
const s=net.createConnection('.claws/claws.sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'list'})+'\n'));
let b='';
s.on('data',d=>{
  b+=d;
  const nl=b.indexOf('\n');
  if(nl!==-1){
    const r=JSON.parse(b.slice(0,nl));
    (r.terminals||[]).forEach(t=>{
      const wrap=t.logPath?'WRAPPED':'unwrapped';
      const marker=t.active?'*':' ';
      console.log(marker+' '+t.id+'  '+t.name.padEnd(30)+'  pid='+t.pid+'  ['+wrap+']');
    });
    s.destroy();
  }
});
"
```

3. Show wrapped terminal log sizes:
```bash
ls -lh .claws/terminals/*.log 2>/dev/null || echo "no wrapped terminal logs"
```

4. Report the status concisely to the user.
