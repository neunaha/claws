---
name: claws
description: Master command for Claws terminal orchestration. Shows live status or routes to /claws-do.
---

## MANDATORY cold-start sequence — execute in order, no deliberation

1. **Acknowledge in 1 line.** "Got it — <one-sentence task summary>." No more.
2. **Do NOT enter plan mode.** This is an ACTION command. If the task is complex
   enough to need a plan, redirect to `/claws-plan` and stop.
3. **Do NOT call TodoWrite for the task itself.** Single-MCP-call command.
4. **Do NOT pre-verify the sidecar, Monitor, or hooks.** Guaranteed by
   SessionStart in v0.7.13+. Trust the system.
5. **Classify the task in 1 sentence.** If you cannot, default to Bucket 2
   (single worker via `claws_worker`).
6. **Make the spawn call IMMEDIATELY.** ONE MCP tool call. No prelude.
7. **Use the `monitor_arm_command` from the spawn response verbatim.** This MUST
   be the very next tool call after the spawn returns. Any other tool call
   between the spawn and the Monitor arming is a bug — abort and arm the
   Monitor first. (This is Bug 6 Layer 0 — server-side enforcement coming in
   Layers 1+2.)
8. **Wait. Don't poll.** When Monitor returns, read output, report, close
   terminal.

If a PreToolUse hook denies a call, READ the error message — it tells you what's
wrong. Don't loop or work around. Almost always: sidecar missing, advise user
to reload VS Code rather than trying to start it manually.

If you find yourself deliberating between steps, you've already failed cold
start. Just classify and act.

---

# /claws [task]

## What this does
Context-aware master command. With no arguments it shows a live dashboard of all active terminals and the Claws version. With arguments it forwards the request to /claws-do so you never need to remember which command to use.

## Behavior

**No arguments — show status dashboard:**
- Call `claws_list` to enumerate all active terminals
- Read the first version line from CHANGELOG.md for the Claws version
- Format terminals as a table: ID | Name | Wrapped | PID
- End with: "Type /claws-do '<task>' to do anything. /claws-help for the full reference."

**If `.claws/claws.sock` is absent:**
- "Claws is not active. Reload VS Code: Cmd+Shift+P → Developer: Reload Window."
- If `~/.claws-src` is missing: "Claws is not installed — contact your project owner."

**With arguments:**
- Treat the arguments as a task and execute /claws-do behavior directly.
- Do not ask clarifying questions — classify and act.

## Examples
```
/claws
/claws fix the failing test in auth.test.ts
/claws run npm test and show me the output
```

## When NOT to use
If you want the full command reference, use /claws-help.
If you want to close terminals, use /claws-cleanup.
