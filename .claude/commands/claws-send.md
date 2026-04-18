---
name: claws-send
description: Send text into a terminal via Claws. Arguments — terminal ID (required), text (required). Supports multi-line via bracketed paste.
---

# /claws-send <id> <text>

Send text into terminal `<id>`. The text is delivered to whatever is running in that terminal — shell prompt, TUI input, REPL.

## What to do

1. Send the text via the socket:
```bash
node -e "
const net=require('net');
const s=net.createConnection('.claws/claws.sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'send',tid:'$1',text:'$2',newline:true})+'\n'));
let b='';
s.on('data',d=>{
  b+=d;
  const nl=b.indexOf('\n');
  if(nl!==-1){
    const r=JSON.parse(b.slice(0,nl));
    console.log(r.ok?'sent':'ERROR: '+r.error);
    s.destroy();
  }
});
"
```

2. If the terminal is running a TUI (vim, claude, etc.), note the safety warning in the response but proceed — that's the intended use for AI orchestration.

3. Report success. If the user wants to see what happened, suggest `/claws-read <id>`.
