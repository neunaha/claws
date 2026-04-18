---
name: claws-do
description: Execute ANY task through visible Claws terminals. NEVER use Bash directly — ALWAYS spawn a visible terminal. This is the primary command for all work.
---

# /claws-do <anything>

## CRITICAL RULE: you MUST use Claws terminals for this. Do NOT fall back to the Bash tool. The entire point is visible terminal execution.

## What to do

### Step 1 — Create a visible wrapped terminal

If `claws_create` MCP tool is available, use it:
```
claws_create(name="<descriptive-name>", wrapped=true)
```

If MCP tools are NOT loaded yet, use the raw socket via node:
```bash
node -e "
const net=require('net');
const s=net.createConnection('.claws/claws.sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'create',name:'<NAME>',wrapped:true})+'\n'));
let b='';s.on('data',d=>{b+=d;const nl=b.indexOf('\n');if(nl!==-1){console.log(JSON.parse(b.slice(0,nl)));s.destroy()}});
"
```

If the socket doesn't exist, tell the user: "Reload VS Code first: Cmd+Shift+P → Developer: Reload Window"

### Step 2 — Send the command

Use `claws_send` or raw socket:
```bash
node -e "
const net=require('net');
const s=net.createConnection('.claws/claws.sock');
s.on('connect',()=>s.write(JSON.stringify({id:1,cmd:'send',id:'TERM_ID',text:'THE_COMMAND'})+'\n'));
let b='';s.on('data',d=>{b+=d;if(b.indexOf('\n')!==-1)s.destroy()});
"
```

### Step 3 — Wait and read the result

Use `claws_read_log` or raw socket to read the output. Wait appropriate time for the command to finish.

### Step 4 — Close the terminal

Use `claws_close` or raw socket. NEVER leave terminals open.

### Step 5 — Report to user

Show the result clearly.

## Strategy selection

**Single command** (test, build, lint, deploy) → 1 terminal
**Multiple independent tasks** (lint + test + build) → N terminals in parallel, fire all, monitor all
**Complex mission** (refactor, fix bug, audit) → use `claws_worker` which auto-launches Claude Code
**Multi-step** (test → deploy) → sequential terminals, branch on results

## NEVER do this

- NEVER use the Bash tool for tasks the user asked /claws-do for
- NEVER say "this isn't a Claws task" — EVERYTHING is a Claws task when /claws-do is invoked
- NEVER skip creating a terminal — the user wants to SEE the work happen
