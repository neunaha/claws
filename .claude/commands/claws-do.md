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

If `claws_create` MCP tool is not available, MCP failed to load — do NOT use the raw socket.
Tell the user: "Reload VS Code (Cmd+Shift+P → Developer: Reload Window) and restart
Claude Code in this project. The Claws MCP server is not connected." Stop here.

### Step 2 — Send the command

Use `claws_send`:
```
claws_send(id=TERM_ID, text="THE_COMMAND")
```
If `claws_send` is not available, MCP failed to load — reload VS Code and restart. Do NOT bypass via raw socket.

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

## CRITICAL: Do NOT spawn sub-agents

Call `claws_create`, `claws_send`, `claws_read_log`, `claws_close` yourself directly. Never delegate to the Agent tool or any sub-agent — the point is that YOU execute the boot sequence, not a proxy.

When the task needs Claude Code running inside the terminal, follow this exact boot sequence manually:

1. `claws_create(name="worker-<slug>", wrapped=true)` → get terminal ID N
2. `claws_send(id=N, text="claude --model claude-sonnet-4-6 --dangerously-skip-permissions")`
3. Poll `claws_read_log` every 5s until output contains "trust" (~20s)
4. `claws_send(id=N, text="1", newline=false)` — accept trust
5. Poll `claws_read_log` every 5s until output contains "bypass" (~10s)
6. `claws_send(id=N, text="<mission>", newline=false)`
7. `claws_send(id=N, text="\n", newline=false)` — submit
8. Poll `claws_read_log` every 10s until MISSION_COMPLETE appears
9. `claws_close(id=N)` — ALWAYS close when done

If MCP tools are not loaded, do NOT use the raw socket. Reload VS Code and restart Claude Code.

## NEVER do this

- NEVER use the Bash tool for tasks the user asked /claws-do for
- NEVER say "this isn't a Claws task" — EVERYTHING is a Claws task when /claws-do is invoked
- NEVER skip creating a terminal — the user wants to SEE the work happen
