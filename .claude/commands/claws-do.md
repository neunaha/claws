---
name: claws-do
description: Execute ANY task through visible Claws terminals. Boots a Claude Code worker for missions; uses claws_exec for one-shot shell commands. NEVER use Bash directly.
---

# /claws-do <anything>

## CRITICAL RULE: you MUST use Claws for this. Do NOT fall back to the Bash tool. The entire point is visible, monitorable execution.

## Pick the right shape FIRST

Before creating any terminal, classify the request:

| Shape | Example | Tool |
|---|---|---|
| **One-shot shell command** (test, build, lint, deploy, script) | `npm test`, `pytest`, `cargo build` | `claws_exec` — captures output, exit code, no terminal needed |
| **Mission for a Claude worker** (refactor, fix bug, audit, multi-step task) | "fix the auth race", "audit the migration" | `claws_create wrapped=true` + 7-step Claude Code boot + mission |

**Wrapped terminals are for hosting a Claude Code instance. They are NOT for running bare shell commands.**
If the answer is "just run this command and show me the output", use `claws_exec` and stop.
If the answer is "an autonomous agent needs to take this on", boot a Claude worker (steps below).

## Path A — one-shot shell command

```
claws_exec(command="<the command>", timeout_ms=120000)
```

Read `output` and `exitCode` from the result. Report both to the user. Done. No terminal to clean up — `claws_exec` is auto-managed.

If `claws_exec` is not available, MCP failed to load — tell the user: "Reload VS Code (Cmd+Shift+P → Developer: Reload Window) and restart Claude Code in this project. The Claws MCP server is not connected." Stop here.

## Path B — Claude Code worker (mission-shaped)

Follow the 7-step boot sequence — every step in order, do not skip.

1. `claws_lifecycle_plan(plan="<2-3 sentence plan>")` — required before any create.
2. `claws_create(name="worker-<slug>", wrapped=true)` → terminal id N.
3. `claws_send(id=N, text="claude --model claude-sonnet-4-6 --dangerously-skip-permissions")`
4. Poll `claws_read_log` every 5s until output contains `"trust"` (~20s).
5. `claws_send(id=N, text="1", newline=false)` — accept trust prompt.
6. Poll `claws_read_log` every 5s until output contains `"bypass"` (~10s).
7. `claws_send(id=N, text="<full mission text>", newline=false)`
   `claws_send(id=N, text="\n", newline=false)` — submit (separate call).

Then poll `claws_read_log` every 10s until `MISSION_COMPLETE` appears, harvest the output, and `claws_close(id=N)`.

Every mission must end with `print MISSION_COMPLETE when done. go.`

## NEVER do this

- NEVER spawn a wrapped terminal and send raw shell commands into it. Wrapped terminals host Claude Code, not shells. If you only need a shell command, use `claws_exec`.
- NEVER use the Bash tool for tasks the user asked /claws-do for.
- NEVER skip the lifecycle plan call before `claws_create` — the server gate will reject the create.
- NEVER skip the trust + bypass polling — the mission will be lost.
- NEVER leave a terminal open. `claws_close` is mandatory.
- NEVER delegate to the Agent tool — execute the boot sequence yourself.

## If MCP tools are not loaded

Tell the user: "Reload VS Code (Cmd+Shift+P → Developer: Reload Window) and restart Claude Code in this project. The Claws MCP server is not connected." Stop. Do NOT attempt a raw-socket workaround.
