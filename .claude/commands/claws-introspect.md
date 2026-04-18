---
name: claws-introspect
description: One-shot runtime snapshot from the Claws socket — extension version, Node + Electron ABI, platform, node-pty state, active sockets, terminal count, uptime. The same data that powers the in-UI Health Check command.
---

# /claws-introspect

Call the socket-level `introspect` command and pretty-print the result. No other side effects. Safe to run any time.

## What to do

Run this **one** Node one-liner from the project root. It connects to `.claws/claws.sock`, sends `{cmd:"introspect"}`, and prints a human-readable summary followed by the raw JSON. No dependencies beyond Node itself.

```bash
node -e "
const net=require('net');
const s=net.createConnection('.claws/claws.sock');
let buf='';
const kill=setTimeout(()=>{console.error('timeout — socket did not respond in 2s');process.exit(1);},2000);
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'introspect'})+'\n'));
s.on('error',e=>{clearTimeout(kill);console.error('socket error:',e.code||e.message);process.exit(1);});
s.on('data',d=>{
  buf+=d;
  const nl=buf.indexOf('\n');
  if(nl===-1) return;
  clearTimeout(kill);
  const r=JSON.parse(buf.slice(0,nl));
  s.destroy();
  if(!r.ok){console.error('introspect failed:',r.error);process.exit(1);}
  console.log('Claws introspect snapshot');
  console.log('─────────────────────────');
  console.log('extension     ',r.extensionVersion);
  console.log('protocol      ',r.protocol);
  console.log('node          ',r.nodeVersion);
  console.log('electron abi  ',r.electronAbi);
  console.log('platform      ',r.platform);
  console.log('node-pty      ',r.nodePty.loaded?('loaded from '+r.nodePty.loadedFrom):('FALLBACK — '+(r.nodePty.error||'pipe mode')));
  console.log('terminals     ',r.terminals);
  console.log('uptime        ',Math.round(r.uptime_ms/1000)+'s');
  console.log('sockets:');
  (r.servers||[]).forEach(sv=>console.log('  •',sv.workspace,'→',sv.socket));
  console.log('');
  console.log('raw json:');
  console.log(JSON.stringify(r,null,2));
});
"
```

If the socket doesn't exist or doesn't answer:
- Tell the user: "No Claws server is listening. Try `/claws-fix` or reload VS Code."
- Optionally run `/claws-fix` if the user asks.

Do NOT run multiple commands. Do NOT interpret the snapshot further unless the user asks — just print it.
