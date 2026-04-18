---
name: claws-exec
description: Execute a command in a terminal and capture stdout + stderr + exit code. Arguments — terminal ID (optional, auto-creates if omitted), command (required).
---

# /claws-exec [id] <command>

Run a shell command in a terminal and return the captured output.

## What to do

1. If no terminal ID provided, create a temporary wrapped terminal first using `/claws-create exec-worker`.

2. Execute via file-based capture:
```bash
node -e "
const net=require('net');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

const tid='$1';
const cmd='$2';
const eid=crypto.randomBytes(4).toString('hex');
const base='/tmp/claws-exec';
fs.mkdirSync(base,{recursive:true});
const outF=path.join(base,eid+'.out');
const doneF=path.join(base,eid+'.done');
const wrapper='{ '+cmd+'; } > '+outF+' 2>&1; echo \$? > '+doneF;

const s=net.createConnection('.claws/claws.sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'send',tid:tid,text:wrapper})+'\n'));
let b='';
s.on('data',d=>{
  b+=d;
  const nl=b.indexOf('\n');
  if(nl!==-1){ s.destroy(); }
});
s.on('close',()=>{
  const deadline=Date.now()+180000;
  const poll=setInterval(()=>{
    if(fs.existsSync(doneF)){
      clearInterval(poll);
      const exitCode=fs.readFileSync(doneF,'utf8').trim();
      const output=fs.existsSync(outF)?fs.readFileSync(outF,'utf8'):'';
      console.log('exit='+exitCode);
      process.stdout.write(output);
      try{fs.unlinkSync(outF);}catch(_){}
      try{fs.unlinkSync(doneF);}catch(_){}
    } else if(Date.now()>deadline){
      clearInterval(poll);
      console.log('TIMEOUT');
    }
  },200);
});
"
```

3. Report the exit code and output to the user.
