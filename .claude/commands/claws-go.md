---
name: claws-go
description: Spawn a Claude Code worker terminal instantly. ALWAYS creates a visible terminal and launches Claude inside it. NEVER falls back to Bash.
---

# /claws-go <mission>

## CRITICAL: you MUST spawn a visible terminal with Claude Code inside it. This is NOT optional. Do NOT use Bash.

## What to do

### Step 1 — Create a wrapped terminal

If `claws_worker` MCP tool is available:
```
claws_worker(name="worker-<slug>", mission="<user's text> print MISSION_COMPLETE when done. go.")
```

If MCP tools are NOT loaded, use raw socket calls:

```bash
# Create terminal
node -e "
const net=require('net');
const s=net.createConnection('.claws/claws.sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'create',name:'worker-SLUG',wrapped:true})+'\n'));
let b='';s.on('data',d=>{b+=d;const nl=b.indexOf('\n');if(nl!==-1){console.log(JSON.parse(b.slice(0,nl)));s.destroy()}});
"
```

Wait 1.5 seconds, then launch Claude Code:
```bash
node -e "
const net=require('net');
const s=net.createConnection('.claws/claws.sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'send',id:'TERM_ID',text:'claude --dangerously-skip-permissions'})+'\n'));
let b='';s.on('data',d=>{b+=d;if(b.indexOf('\n')!==-1)s.destroy()});
"
```

Wait 5 seconds for Claude to boot, then send the mission:
```bash
node -e "
const net=require('net');
const s=net.createConnection('.claws/claws.sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'send',id:'TERM_ID',text:'THE MISSION PROMPT. print MISSION_COMPLETE when done. go.'})+'\n'));
let b='';s.on('data',d=>{b+=d;if(b.indexOf('\n')!==-1)s.destroy()});
"
```

Then send raw CR to submit:
```bash
node -e "
const net=require('net');
const s=net.createConnection('.claws/claws.sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'send',id:'TERM_ID',text:'\r',newline:false})+'\n'));
let b='';s.on('data',d=>{b+=d;if(b.indexOf('\n')!==-1)s.destroy()});
"
```

### Step 2 — Monitor

Use `claws_read_log` or raw socket readLog to check progress periodically.

### Step 3 — Report + Cleanup

When MISSION_COMPLETE detected or error occurs, read final state, report to user, close the terminal.

## NEVER do this

- NEVER say "this isn't a Claws worker task"
- NEVER use Bash to do the work yourself instead of spawning a worker
- NEVER skip the terminal creation step
