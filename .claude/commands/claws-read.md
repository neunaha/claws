---
name: claws-read
description: Read a wrapped terminal's pty log — see everything that happened including TUI sessions. Arguments — terminal ID (required), lines (optional, default 50).
---

# /claws-read <id> [lines]

Read the last N lines from a wrapped terminal's pty log with ANSI stripping.

## What to do

1. Read via the socket:
```bash
node -e "
const net=require('net');
const s=net.createConnection('.claws/claws.sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'readLog',tid:'$1',strip:true})+'\n'));
let b='';
s.on('data',d=>{
  b+=d;
  const nl=b.indexOf('\n');
  if(nl!==-1){
    const r=JSON.parse(b.slice(0,nl));
    if(r.ok){
      const body=r.bytes||'';
      const lines=body.split('\n');
      const n=parseInt('${2:-50}',10);
      lines.slice(-n).forEach(l=>console.log(l));
      console.log('\n['+r.totalSize+' bytes total \xb7 showing last '+Math.min(n,lines.length)+' of '+lines.length+' lines]');
    } else {
      console.log('ERROR: '+r.error);
    }
    s.destroy();
  }
});
"
```

2. Show the clean text output to the user. Note: this only works for wrapped terminals (created with `wrapped: true`).
