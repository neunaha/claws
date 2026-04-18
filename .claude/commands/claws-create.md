---
name: claws-create
description: Create a new wrapped terminal via Claws. Arguments — name (required), cwd (optional). Always creates wrapped for full pty capture.
---

# /claws-create <name> [cwd]

Create a new wrapped terminal with the given name.

## What to do

1. Parse the arguments. First arg is the terminal name, second is optional cwd.

2. Create the terminal via the socket:
```bash
node -e "
const net=require('net');
const s=net.createConnection('.claws/claws.sock');
s.on('connect',()=>{
  const req={id:1,cmd:'create',name:'$1',wrapped:true};
  if('$2') req.cwd='$2';
  s.write(JSON.stringify(req)+'\n');
});
let b='';
s.on('data',d=>{
  b+=d;
  const nl=b.indexOf('\n');
  if(nl!==-1){
    const r=JSON.parse(b.slice(0,nl));
    if(r.ok) console.log('created terminal id='+r.id+' logPath='+r.logPath);
    else console.log('ERROR: '+r.error);
    s.destroy();
  }
});
"
```

3. Report the terminal ID and log path. Remind the user they can now use `/claws-send <id> <text>` or `/claws-exec <id> <command>`.
