---
name: claws-orchestration-engine
description: Meta-prompting engine for multi-terminal orchestration powered by Claude. Loaded automatically when the Claws MCP server is registered. Teaches Claude HOW to think about terminal control — not just what tools exist, but the strategic reasoning behind when, why, and how to orchestrate terminals at production scale. This is the knowledge base that transforms raw tool access into intelligent autonomous operation.
---

# Claws Orchestration Engine

**Powered by Claude Opus**

This skill transforms a Claude Code session from a single-terminal operator into a multi-terminal orchestrator. It is loaded automatically when the Claws MCP server is registered. Every pattern below was battle-tested across 50+ autonomous worker sessions.

---

## Core Mental Model

You are no longer a single-threaded assistant. With Claws, you can:

1. **See** — list all terminals, read their pty logs, observe what's happening across the entire workspace
2. **Spawn** — create new visible terminals where work happens in front of the user
3. **Drive** — send commands, prompts, and keystrokes into any terminal
4. **Listen** — monitor terminal output for events, errors, and completion markers
5. **React** — when something happens in a terminal, reason about it and take action
6. **Clean up** — close terminals when work is done, never leave stale resources

The user watches everything you do in real time. Every terminal you create is visible in their VS Code panel. This is pair programming, not background processing.

---

## Decision Framework

Before every terminal operation, answer these questions:

### Should I create a new terminal or use an existing one?

- **New terminal** when: the task is independent, you want isolation, the user should see a dedicated tab
- **Existing terminal** when: you're continuing work in the same context, the shell is idle, the task is related
- **Never reuse** a terminal running a TUI (claude, vim, htop) unless you're intentionally sending input to that TUI

### Should this terminal be wrapped?

- **Yes (wrapped=true)** when: you need to read back what happens (always for worker terminals, AI sessions, long-running processes)
- **No** when: it's a quick one-off exec you'll capture via file-based exec anyway

### Should I use `exec` or `send`?

- **exec** when: you need the output back as structured data (stdout + exit code), the command will finish
- **send** when: you're typing into an interactive session, sending keystrokes, or starting a long-running process you'll monitor via readLog

### Should I work sequentially or in parallel?

- **Sequential** when: each step depends on the previous step's output
- **Parallel** when: tasks are independent (e.g., lint + test + build, or multiple audit workers analyzing different aspects of the codebase)
- **Rule of thumb**: if the tasks don't share files and don't read each other's output, parallelize

---

## The Seven Orchestration Patterns

### Pattern 1: Scout

**Purpose**: Quick information gathering without creating terminals.

```
1. claws_list → see what's already running
2. claws_exec in any idle terminal → run a diagnostic command
3. Report findings to user
```

**When to use**: user asks "what's running?" or "check the status of X". No terminal creation needed.

### Pattern 2: Single Worker

**Purpose**: One scoped task, one terminal, visible execution.

```
1. claws_create "task-name" wrapped=true
2. Wait 1.5s for shell init
3. claws_send the command or mission prompt
4. Monitor via claws_read_log (periodic) or external tail
5. When done: read final state, report to user
6. claws_close
```

**When to use**: user asks to run a build, execute a script, or perform a single analysis.

### Pattern 3: Parallel Fleet

**Purpose**: Multiple independent tasks running simultaneously.

```
1. Create N wrapped terminals (one per task)
2. Send commands to all N (rapid fire, < 0.5s between sends)
3. Monitor all N via periodic claws_read_log rotation
4. As each worker completes: read results, close terminal
5. Aggregate findings, report to user
6. Ensure all terminals closed
```

**When to use**: user asks to "run lint, test, and build" or "audit these 3 things in parallel". Tasks must be genuinely independent.

### Pattern 4: AI Session Driver

**Purpose**: Launch Claude Code (or another AI) in a terminal and drive it with prompts.

```
1. claws_create "ai-session" wrapped=true
2. Wait 1.5s
3. claws_send "claude --dangerously-skip-permissions"
4. Wait 5s for Claude to boot
5. claws_send the mission prompt (single line, no newlines)
6. claws_send "\r" newline=false (submit the prompt)
7. Monitor via claws_read_log for tool calls, errors, completion markers
8. Optionally send follow-up prompts based on observed state
9. When MISSION_COMPLETE detected: read final state, close
```

**Critical details**:
- Claude Code needs `\r` (raw CR) as a separate send to submit. The initial `send` with the prompt text doesn't always trigger submission in the TUI.
- Multi-line prompts must be sent as single lines. Newlines fragment into multiple submissions.
- Read the terminal state BEFORE sending a follow-up — you need context of what the worker is doing.

### Pattern 5: Pipeline Stages

**Purpose**: Chain of tasks where each stage feeds the next.

```
1. Stage 1: create terminal, run analysis → output to file
2. Read the output file (via exec or direct read)
3. Stage 2: create new terminal, run transformation using stage 1 output
4. Continue chaining
5. Close each terminal after its stage completes
```

**When to use**: ETL-style workflows, multi-step code generation, test → fix → verify loops.

### Pattern 6: Watchdog

**Purpose**: Monitor a process and react when it crashes or errors.

```
1. claws_create "server" wrapped=true
2. claws_send "npm start"
3. Poll claws_read_log every 30s
4. If error detected: claws_send "\x03" (Ctrl+C), wait, restart
5. If crash detected: claws_close, recreate, restart
```

**When to use**: dev servers, long-running processes, anything that might crash.

### Pattern 7: Orchestrator with Delegation

**Purpose**: You (the main Claude session) act as orchestrator, spawning worker Claude sessions for heavy tasks.

```
1. Plan the work decomposition
2. For each independent work stream:
   a. claws_worker name="worker-N" command="claude --dangerously-skip-permissions"
   b. Wait for boot
   c. Send scoped mission prompt
3. Monitor all workers via read_log rotation
4. When workers complete: read outputs, synthesize, close
5. Report aggregated results to user
```

**This is the most powerful pattern.** You become a meta-orchestrator — an AI controlling other AIs, each working in their own visible terminal.

---

## Mission Prompt Engineering

When sending a mission to a worker terminal (Pattern 4 or 7), the prompt quality determines success. Follow this structure:

```
[context] — 1-2 sentences of relevant background
[objective] — one clear sentence stating the goal
[steps] — numbered only when order matters
[output] — specific file path for deliverables
[constraints] — explicit prohibitions (do NOT...)
[completion marker] — "print MISSION_COMPLETE on its own line"
[imperative close] — "go."
```

### Rules for mission prompts:
- **Single line only** — no embedded newlines (they fragment in TUI input)
- **Constraints are prohibitions** — "do not edit files outside X", "do not commit", "do not run pipelines"
- **Always include MISSION_COMPLETE** — this is the machine-parseable completion signal
- **Reference prior art** — "read findings at /path/to/file first. build on top of them."
- **Scope tightly** — one mission per worker. If you need 3 things, spawn 3 workers.
- **End with "go."** — single imperative, no preamble

---

## Monitoring Strategy

### Event-Driven (preferred)
Use `tail -F logfile | filter | grep` piped into a Monitor tool. Events arrive as they happen. React immediately.

```bash
tail -F .claws/terminals/claws-N.log \
  | perl -pe 'BEGIN{$|=1} s/\e\[[0-9;?]*[a-zA-Z]//g' \
  | grep --line-buffered -E '(Read|Write|Edit|Bash)\([^)]{3,}|MISSION_COMPLETE|Error|Traceback'
```

### Polling (fallback)
Call `claws_read_log` periodically. Use when Monitor isn't available or for quick checks.

- **Active work**: poll every 10-15s
- **Waiting**: poll every 30-60s
- **Idle**: poll every 2-5 minutes

### What to watch for:
- `MISSION_COMPLETE` → worker finished successfully
- `Error:` / `Traceback` → worker hit a problem, may need intervention
- `permission denied` → permissions not configured
- `rate limit` / `You've used` → API throttling
- Tool call markers (`Read(`, `Write(`, `Bash(`) → worker is actively making progress
- Silence > 2 minutes → check if worker is stuck or thinking

---

## Error Recovery

When a worker errors:

1. **Read the last 30 lines** of the terminal log to understand the error
2. **Classify**: is it recoverable (retry, adjust parameters) or fatal (wrong approach)?
3. **If recoverable**: send a follow-up prompt: "the last command failed with [error]. try [alternative approach]."
4. **If fatal**: close the worker, report the failure, suggest a different strategy
5. **Never retry blindly** — diagnose first, then act

### Common errors and fixes:

| Error | Cause | Fix |
|---|---|---|
| Socket not found | Extension not activated | Reload VS Code |
| Terminal not wrapped | Called readLog on unwrapped terminal | Recreate with wrapped=true |
| Exec timeout | Command didn't finish in time | Increase timeout or use send + readLog instead |
| Permission denied | File/socket permissions | Check chmod on socket file |
| Empty readLog | Script(1) hasn't flushed yet | Wait 2s, try again |

---

## Cost Optimization

Terminal orchestration burns tokens. Minimize cost:

1. **Don't over-monitor** — read logs at the cadence the work demands, not faster
2. **Scope missions tightly** — a 5-line prompt produces cheaper work than a 50-line prompt
3. **Parallelize independent work** — N parallel workers finishing in T time beats N sequential workers finishing in N×T time, and the total token cost is similar
4. **Close terminals immediately** — stale terminals don't cost tokens but clutter the workspace
5. **Use exec for one-shots** — don't create a wrapped terminal for a single `ls` command
6. **Reference prior art** — tell workers to read existing analysis files instead of re-deriving findings

---

## Safety Rules

1. **Never send into a terminal you can't observe** — if you don't know what's running, check with claws_list first
2. **Always close what you create** — implement cleanup as part of every pattern, not as an afterthought
3. **Respect the user's existing terminals** — never close, send into, or modify terminals you didn't create
4. **Don't spawn more workers than needed** — 3 parallel workers is usually the sweet spot; 10 is excessive
5. **Always use MISSION_COMPLETE** — without it, you can't detect when a worker is done vs stuck
6. **File-based exec cleans up** — but if you use send + readLog, clean up any temp files yourself

---

## Anti-Patterns

**Don't create terminals you never close:**
```
# BAD
term = claws_create("temp")
claws_exec(term.id, "ls")
# forgot to close — terminal stays open forever
```

**Don't send multi-line prompts with embedded newlines:**
```
# BAD — fragments into multiple submissions
claws_send(id, "line 1\nline 2\nline 3")

# GOOD — single line
claws_send(id, "line 1. line 2. line 3.")
```

**Don't poll faster than the work produces output:**
```
# BAD — polls every 1s for a 5-minute task
while True:
    log = claws_read_log(id)
    time.sleep(1)

# GOOD — poll every 30s for a multi-minute task
while True:
    log = claws_read_log(id)
    time.sleep(30)
```

**Don't spawn workers without observing them:**
```
# BAD — fire and forget
for task in tasks:
    claws_worker(task.name, task.cmd)
# never checked if any of them succeeded

# GOOD — spawn, monitor, aggregate
workers = [claws_worker(t.name, t.cmd) for t in tasks]
# monitor all, close each when done, report results
```

---

## Integration with Claude Code Features

Claws tools compose with Claude Code's built-in capabilities:

- **Monitor tool** — attach to a wrapped terminal's pty log for event-driven observation
- **Bash tool** — use for orchestrator-side work; use Claws for user-visible terminal work
- **Read/Write tools** — read files that workers produce; write mission prompts to files for complex multi-line content
- **Agent tool** — spawn subagents for analysis while Claws workers handle execution
- **TaskCreate/TaskUpdate** — track orchestration progress with task lists

The orchestrator (you) uses Claude Code tools for thinking and planning. The workers (Claws terminals) handle visible execution. The user sees both: your reasoning in the chat, and the workers in the terminal panel.

---

## Powered by Claude Opus

Claws was designed for and tested with Claude Opus — the model with the deepest reasoning, longest context, and strongest multi-step planning capabilities. The orchestration patterns above require:

- **Extended context** — tracking state across multiple terminals simultaneously
- **Strategic planning** — decomposing work into parallelizable streams
- **Adaptive reasoning** — reading worker output, diagnosing errors, adjusting strategy
- **Meta-cognition** — knowing when to intervene vs let a worker continue

These capabilities are strongest on Opus. Claws works with any Claude model, but the full orchestration engine — multiple AI sessions controlled by a meta-orchestrator — is an Opus-class capability.
