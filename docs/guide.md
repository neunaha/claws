# The Complete Claws Guide

A comprehensive course-level guide to mastering terminal control with Claws — from first install to production AI orchestration fleets.

> **Note:** The Python client shown in this guide is **optional**. The MCP server (Node.js) provides the same 8 terminal control tools natively in Claude Code with zero install. If you are using Claude Code, you do not need the Python client -- everything works through MCP tool calls out of the box.

---

## Table of Contents

1. [Chapter 1 — Getting Started](#chapter-1--getting-started)
2. [Chapter 2 — Your First Terminal Control](#chapter-2--your-first-terminal-control)
3. [Chapter 3 — Wrapped Terminals Deep Dive](#chapter-3--wrapped-terminals-deep-dive)
4. [Chapter 4 — Command Execution Patterns](#chapter-4--command-execution-patterns)
5. [Chapter 5 — The Safety Gate](#chapter-5--the-safety-gate)
6. [Chapter 6 — Event Streaming and Monitoring](#chapter-6--event-streaming-and-monitoring)
7. [Chapter 7 — AI Pair Programming](#chapter-7--ai-pair-programming)
8. [Chapter 8 — Parallel Worker Fleets](#chapter-8--parallel-worker-fleets)
9. [Chapter 9 — Advanced Patterns](#chapter-9--advanced-patterns)
10. [Chapter 10 — Cross-Device Control](#chapter-10--cross-device-control)
11. [Chapter 11 — Troubleshooting](#chapter-11--troubleshooting)
12. [Chapter 12 — Architecture Internals](#chapter-12--architecture-internals)

---

## Chapter 1 — Getting Started

### Prerequisites

- VS Code 1.93.0 or later
- macOS or Linux (Windows support planned)
- Node.js 18+ (bundled with most systems)
- A terminal (the irony is intentional)

### Installation

```bash
git clone https://github.com/neunaha/claws.git
cd claws
ln -s "$(pwd)/extension" ~/.vscode/extensions/neunaha.claws-0.1.0
chmod +x scripts/terminal-wrapper.sh
```

Open VS Code. Press `Cmd+Shift+P` → "Developer: Reload Window".

### Verification

Open the Output panel (`Cmd+Shift+U`) and select "Claws" from the dropdown. You should see:

```
[claws] activating
[claws] listening on /your/workspace/.claws/claws.sock
```

If you see this, Claws is running. Try listing terminals:

```bash
echo '{"id":1,"cmd":"list"}' | nc -U .claws/claws.sock
```

You should get back a JSON response with all your open terminals.

### Installing the Python Client

```bash
cd claws
pip install -e clients/python
```

Verify:

```python
python3 -c "from claws import ClawsClient; print('OK')"
```

---

## Chapter 2 — Your First Terminal Control

### Listing Terminals

```python
from claws import ClawsClient

client = ClawsClient(".claws/claws.sock")
for t in client.list():
    print(f"{t.id}  {t.name}  pid={t.pid}  active={t.active}")
```

Every terminal gets a stable numeric ID. This ID persists for the terminal's lifetime — use it for all subsequent commands.

### Creating a Terminal

```python
term = client.create("my-first-terminal")
print(f"Created: id={term.id}")
```

A new terminal tab appears in VS Code. You can see it in the terminal panel.

### Sending Text

```python
client.send(term.id, "echo hello from Claws")
```

Switch to VS Code — you'll see the command typed and executed in the terminal you created.

### Closing a Terminal

```python
client.close(term.id)
```

The terminal tab disappears from VS Code. Clean up after yourself.

### The Full Loop

```python
from claws import ClawsClient
import time

client = ClawsClient(".claws/claws.sock")

# Create
term = client.create("demo")
time.sleep(1)  # let shell initialize

# Execute
result = client.exec(term.id, "echo hello && date && whoami")
print(f"exit {result.exit_code}")
print(result.output)

# Close
client.close(term.id)
```

This is the fundamental pattern: create → use → close. Everything else builds on this.

---

## Chapter 3 — Wrapped Terminals Deep Dive

### The Problem with Regular Terminals

When you `send` text into a regular terminal, it goes in — but nothing comes back through the Claws API. You're writing into a black box. The `exec` command works around this with file-based capture, but that only captures individual commands. You can't read an ongoing interactive session.

### What Wrapping Does

A wrapped terminal runs your shell inside `script(1)`:

```
Your Terminal Tab
└── script(1) — logs every byte to .claws/terminals/claws-N.log
    └── /bin/zsh — your actual shell
        └── whatever you run
```

Every character that appears on screen is recorded in the log file. Claws can then read this file back with ANSI escapes stripped, giving you clean text.

### Creating a Wrapped Terminal

```python
term = client.create("worker", wrapped=True)
print(f"Log: {term.log_path}")
# Log: /your/workspace/.claws/terminals/claws-5.log
```

Or from the VS Code UI: click the dropdown arrow next to `+` in the terminal panel → "Claws Wrapped Terminal".

### Reading the Log

```python
import time

# Send some commands
client.send(term.id, "ls -la")
time.sleep(1)
client.send(term.id, "git status")
time.sleep(1)

# Read back everything
log = client.read_log(term.id, lines=30)
print(log)
```

Output (ANSI-stripped):

```
$ ls -la
total 96
drwxr-xr-x  15 user  staff   480 Apr 18 01:00 .
-rw-r--r--   1 user  staff  9067 Apr 18 00:30 CLAUDE.md
...
$ git status
On branch main
nothing to commit, working tree clean
$
```

### Incremental Tailing

For real-time monitoring, use offset-based reading:

```python
cursor = 0
while True:
    # This is the raw socket approach; the Python client wraps this
    resp = client._send({
        "cmd": "readLog",
        "id": term.id,
        "offset": cursor,
        "strip": True,
    })
    if resp["nextOffset"] > cursor:
        new_text = resp["bytes"]
        print(new_text, end="")
        cursor = resp["nextOffset"]
    time.sleep(1)
```

### Reading TUI Sessions

The real power of wrapped terminals: reading interactive programs that shell integration can't capture.

```python
# Launch Claude Code in a wrapped terminal
term = client.create("ai-session", wrapped=True)
time.sleep(2)
client.send(term.id, "claude")
time.sleep(5)

# Read the Claude Code welcome screen
log = client.read_log(term.id, lines=30)
print(log)
# Shows: Claude Code banner, model info, session state
```

This works for vim, htop, python3 REPL, node REPL, irb — anything that renders to a terminal.

### Log Buffering

`script(1)` buffers output before writing to disk (~1-2 second delay). This is intentional — aggressive flushing (`-F` flag) corrupts Ink-based TUI renderers like Claude Code. Accept the delay; it doesn't affect usability.

### Detecting Wrapped Terminals

```python
for t in client.list():
    if t.log_path:
        print(f"{t.id} {t.name} — WRAPPED (log: {t.log_path})")
    else:
        print(f"{t.id} {t.name} — regular")
```

### Environment Variable

Inside a wrapped terminal, `CLAWS_WRAPPED=1` is set in the environment. Your scripts can detect this:

```bash
if [ "${CLAWS_WRAPPED:-}" = "1" ]; then
    echo "I'm in a Claws-wrapped terminal"
fi
```

---

## Chapter 4 — Command Execution Patterns

### exec — Structured Output

`exec` is for when you need the output back programmatically:

```python
result = client.exec(term.id, "python3 -c 'import sys; print(sys.version)'")
assert result.exit_code == 0
print(result.output)  # "3.11.9 (main, ...)\n"
```

### send — Fire and Forget

`send` is for when you just need text to arrive at the terminal's input:

```python
client.send(term.id, "npm start")
# No output captured — use readLog to see what happened
```

### When to Use Which

| Scenario | Use |
|---|---|
| Run a command, check the output | `exec` |
| Type into a shell prompt | `send` |
| Type into a TUI (vim, claude, REPL) | `send` |
| Send Ctrl+C / Ctrl+D | `send` with `\x03` / `\x04` |
| Run a long-running process | `send` + monitor with `readLog` |
| Run a command in a specific directory | `exec` with `cd /path && cmd` |

### Multi-line Commands

Claws auto-wraps multi-line text in bracketed paste mode:

```python
script = """
for i in range(5):
    print(f"Line {i}")
"""
client.send(term.id, f"python3 -c '{script}'")
```

The shell receives this as one atomic paste, not 3 separate Enter presses.

### Timeouts

`exec` waits up to 180 seconds by default. For longer commands:

```python
result = client.exec(term.id, "npm run build", timeout_ms=600000)  # 10 minutes
```

If it times out, you get a `ClawsError` with whatever partial output was captured.

### Auto-Created Exec Terminal

If you call `exec` without a terminal ID, Claws creates (or reuses) a terminal named `claws-work`:

```python
# No need to create a terminal first
result = client.exec(None, "echo quick one-off")
```

---

## Chapter 5 — The Safety Gate

### What It Protects Against

Imagine you have a terminal running vim. You send `ls -la` via Claws, intending it as a shell command. Instead, vim receives "ls -la" as normal-mode keystrokes — jumping to line `l`, then `s` enters insert mode, then `- la` types literal characters. Your file is corrupted.

The safety gate prevents this by checking what's actually running in the terminal before sending.

### How It Works

1. Claws reads the terminal's shell PID from VS Code
2. Runs `pgrep -P <pid>` to find the foreground child process
3. If the child is a known shell (bash, zsh, fish, sh, dash, ksh) → safe
4. If it's anything else (claude, vim, less, python3, node) → warning

### Default Behavior (warn + proceed)

```python
# Terminal is running vim
client.send(term.id, "hello")
# Response includes: [warning: foreground is 'vim' (not a shell)]
# But the text IS sent — Claws doesn't block by default
```

### Strict Mode (block)

```python
# Block sends into non-shell TUIs
client._send({
    "cmd": "send",
    "id": term.id,
    "text": "hello",
    "strict": True,
})
# Returns: {"ok": false, "error": "BLOCKED (strict): ..."}
```

### Why Warn Instead of Block

The primary use case for Claws is AI pair programming — where you **intentionally** send prompts into Claude Code's TUI. Blocking that defeats the purpose. The warning is for accidental sends; intentional TUI interaction should proceed.

---

## Chapter 6 — Event Streaming and Monitoring

### poll — Shell Integration Events

VS Code's shell integration fires an event when a command finishes. Claws captures these in a ring buffer:

```python
events, cursor = client.poll(since=0)
for e in events:
    print(f"[{e['terminalName']}] $ {e['commandLine']}")
    print(f"  exit={e['exitCode']}, {len(e['output'])} bytes output")
```

Save the cursor and pass it next time to get only new events:

```python
cursor = 0
while True:
    events, cursor = client.poll(since=cursor)
    for e in events:
        print(f"[{e['terminalName']}] {e['commandLine']} → {e['exitCode']}")
    time.sleep(2)
```

### poll Limitations

- Requires VS Code shell integration to be active
- Doesn't fire in wrapped terminals (shell integration doesn't inject through script(1))
- Doesn't fire for TUI sessions
- Ring buffer holds last 500 events — old events are dropped

For reliable observation, use `readLog` on wrapped terminals instead.

### The Monitor Pattern

The most powerful observation pattern combines `tail -F` with a filter:

```bash
tail -F .claws/terminals/claws-5.log \
  | perl -pe 'BEGIN{$|=1} s/\e\[[0-9;?]*[a-zA-Z]//g' \
  | grep --line-buffered -E 'Error|DONE|FAIL|exit'
```

This gives you real-time, filtered, ANSI-stripped event streaming from any wrapped terminal. In Claude Code, you can use the `Monitor` tool for this:

```
Monitor(
  description: "worker errors and completion",
  persistent: true,
  command: "tail -F .claws/terminals/claws-5.log | perl ... | grep ..."
)
```

---

## Chapter 7 — AI Pair Programming

This is what Claws was built for. One AI session controls multiple terminal sessions — spawning workers, sending mission prompts, monitoring progress, reacting to errors.

### The Basic Pattern

```python
from claws import ClawsClient
import time

client = ClawsClient(".claws/claws.sock")

# 1. Create a wrapped terminal
worker = client.create("ai-worker", wrapped=True)
time.sleep(1.5)

# 2. Launch Claude Code inside it
client.send(worker.id, "claude --dangerously-skip-permissions")
time.sleep(5)

# 3. Send a mission prompt
mission = (
    "fix the failing test in src/utils.test.ts. "
    "read the error first, then fix the implementation. "
    "commit when green. print MISSION_COMPLETE when done."
)
client.send(worker.id, mission)
time.sleep(0.3)
# Submit with raw CR (Claude Code needs explicit Enter)
client.send(worker.id, "\r", newline=False)

# 4. Monitor progress
while True:
    log = client.read_log(worker.id, lines=20)
    if "MISSION_COMPLETE" in log:
        break
    if "Error" in log:
        print("Worker hit an error — check the log")
    time.sleep(10)

# 5. Read final state
full_log = client.read_log(worker.id, lines=200)
print(full_log)

# 6. Clean up
client.close(worker.id)
```

### Writing Good Mission Prompts

A mission prompt should have:

1. **Context** — what the worker needs to know
2. **Objective** — one clear sentence
3. **Steps** — numbered if order matters
4. **Constraints** — explicit prohibitions
5. **Completion marker** — `MISSION_COMPLETE` for machine parsing
6. **Imperative close** — "go."

```
fix the type error in pipeline/committee.py line 234.
read the error, trace the root cause, apply a minimal fix.
do not refactor surrounding code. do not commit.
print MISSION_COMPLETE when the fix is verified. go.
```

### Sending Follow-ups

After reading the worker's state, you can send a follow-up prompt:

```python
# Read what the worker did
log = client.read_log(worker.id, lines=30)

# If it's stuck, redirect
if "I need clarification" in log:
    client.send(worker.id, "use option B. the database is PostgreSQL 15.")
    client.send(worker.id, "\r", newline=False)
```

This is true pair programming — read, think, respond.

---

## Chapter 8 — Parallel Worker Fleets

### Spawning Multiple Workers

```python
tasks = {
    "lint": "npm run lint",
    "test": "npm test",
    "typecheck": "npx tsc --noEmit",
}

workers = {}
for name, cmd in tasks.items():
    term = client.create(f"worker-{name}", wrapped=True)
    workers[name] = term
    time.sleep(0.5)  # stagger to avoid shell init race

# Fire all commands
for name, cmd in tasks.items():
    client.send(workers[name].id, cmd)

# Wait and collect
import time
time.sleep(15)
for name, term in workers.items():
    log = client.read_log(term.id, lines=10)
    passed = "PASS" in log or "0 errors" in log
    status = "PASS" if passed else "FAIL"
    print(f"{status}  {name}")
    client.close(term.id)
```

### AI Agent Fleet

Spawn multiple Claude Code sessions with different missions:

```python
missions = [
    ("audit-a", "analyze pipeline latency from artifact mtimes. write to /tmp/latency.md"),
    ("audit-b", "analyze token consumption from budget_ledger.jsonl. write to /tmp/tokens.md"),
    ("audit-c", "analyze runbook dependencies and parallelism. write to /tmp/critpath.md"),
]

workers = {}
for name, mission in missions:
    term = client.create(name, wrapped=True)
    time.sleep(1.5)
    client.send(term.id, "claude --dangerously-skip-permissions")
    time.sleep(5)
    client.send(term.id, mission + " print MISSION_COMPLETE when done. go.")
    time.sleep(0.3)
    client.send(term.id, "\r", newline=False)
    workers[name] = term

# Monitor all workers
while workers:
    for name, term in list(workers.items()):
        log = client.read_log(term.id, lines=5)
        if "MISSION_COMPLETE" in log:
            print(f"{name} — DONE")
            client.close(term.id)
            del workers[name]
    time.sleep(15)

print("All workers complete.")
```

### Auto-Cleanup

Every terminal you create must be closed. Implement a cleanup handler:

```python
import atexit

created_terminals = []

def create_worker(name, **kwargs):
    term = client.create(name, **kwargs)
    created_terminals.append(term.id)
    return term

@atexit.register
def cleanup():
    for tid in created_terminals:
        try:
            client.close(tid)
        except:
            pass
```

---

## Chapter 9 — Advanced Patterns

### Pattern: Orchestrator with Monitor

Use `tail -F` as a real-time event source instead of polling:

```bash
# Terminal 1: monitor
tail -F .claws/terminals/claws-5.log \
  | perl -pe 'BEGIN{$|=1} s/\e\[[0-9;?]*[a-zA-Z]//g; s/\e\][^\a]*\a//g; s/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]//g' \
  | grep --line-buffered -E '(Read|Write|Edit|Bash)\([^)]{3,}|MISSION_COMPLETE|Error|Traceback'
```

This gives you a filtered stream of tool calls and errors from the worker, arriving in real-time.

### Pattern: Conditional Branching

Read the worker's state and make decisions:

```python
log = client.read_log(worker.id, lines=20)

if "test failed" in log.lower():
    client.send(worker.id, "revert the last change and try approach B instead")
elif "permission denied" in log.lower():
    client.send(worker.id, "use sudo for that command")
elif "MISSION_COMPLETE" in log:
    print("Success!")
    client.close(worker.id)
else:
    print("Still working...")
```

### Pattern: Pipeline Stages

Chain workers — output of one feeds the next:

```python
# Stage 1: analyze
analyzer = client.create("stage-1-analyze", wrapped=True)
client.send(analyzer.id, "python3 analyze.py > /tmp/analysis.json")
time.sleep(10)
client.close(analyzer.id)

# Stage 2: transform (reads stage 1 output)
transformer = client.create("stage-2-transform", wrapped=True)
client.send(transformer.id, "python3 transform.py /tmp/analysis.json > /tmp/result.json")
time.sleep(10)
client.close(transformer.id)
```

### Pattern: Watchdog

Monitor a long-running process and restart if it crashes:

```python
import time

while True:
    term = client.create("server", wrapped=True)
    client.send(term.id, "npm start")

    while True:
        time.sleep(30)
        log = client.read_log(term.id, lines=5)
        if "EADDRINUSE" in log or "FATAL" in log or "crashed" in log.lower():
            print("Server crashed — restarting...")
            client.close(term.id)
            time.sleep(2)
            break
```

### Pattern: Multi-Language Raw Socket

You don't need Python. Any language works:

**bash:**
```bash
echo '{"id":1,"cmd":"list"}' | nc -U .claws/claws.sock
```

**Node.js:**
```javascript
const net = require('net');
const sock = net.createConnection('.claws/claws.sock');
sock.write('{"id":1,"cmd":"list"}\n');
sock.on('data', d => console.log(JSON.parse(d.toString())));
```

**Go:**
```go
conn, _ := net.Dial("unix", ".claws/claws.sock")
conn.Write([]byte(`{"id":1,"cmd":"list"}` + "\n"))
buf := make([]byte, 65536)
n, _ := conn.Read(buf)
fmt.Println(string(buf[:n]))
```

---

## Chapter 10 — Cross-Device Control

### Today: SSH Tunnel

You can control a remote VS Code instance right now using SSH port forwarding:

```bash
# On your local machine — forward the remote socket
ssh -L /tmp/remote-claws.sock:/remote/workspace/.claws/claws.sock user@remote-host

# Connect to the forwarded socket
from claws import ClawsClient
client = ClawsClient("/tmp/remote-claws.sock")
terminals = client.list()  # shows remote VS Code terminals
```

### Planned: WebSocket Transport

v0.3 will add WebSocket alongside the Unix socket:

1. Enable in VS Code settings: `"claws.enableWebSocket": true`
2. Claws starts a WebSocket server on port 9876
3. Connect from anywhere: `ws://remote-host:9876`
4. Token auth required (token shown in Output panel)
5. TLS support for encrypted connections

### Planned: Team Configuration

Named devices with per-terminal access control:

```json
{
  "team": {
    "dev-laptop": { "role": "controller", "access": "read-write" },
    "build-server": { "role": "worker", "access": "read-write" },
    "dashboard": { "role": "observer", "access": "read-only" }
  }
}
```

---

## Chapter 11 — Troubleshooting

### "No socket found"

The extension isn't running. Check:
1. Is VS Code open?
2. Is the Claws extension installed? (`Cmd+Shift+X` → search "Claws")
3. Did you reload? (`Cmd+Shift+P` → "Developer: Reload Window")
4. Check the Output panel → "Claws" for errors

### "Terminal not wrapped"

You called `readLog` on a regular terminal. Only terminals created with `wrapped: true` have pty logs. Create a new one:

```python
term = client.create("name", wrapped=True)
```

### Wrapped terminal shows visual glitches

You're probably running a TUI (Claude Code, vim) and the wrapper script has the `-F` flag enabled. Remove it — default `script` buffering is correct for TUI sessions. Check `scripts/terminal-wrapper.sh`.

### Multi-line send fragments into separate commands

This happens when bracketed paste isn't working. Claws auto-wraps multi-line text in `\x1b[200~...\x1b[201~`. If your shell doesn't support bracketed paste, each `\n` becomes a separate Enter. Fix: upgrade your shell or send the text as a file: `cat /tmp/prompt.txt`.

### exec times out but the command is running

`exec` polls for a `.done` marker file. If the command runs but doesn't produce the marker (e.g., it runs in a subshell that doesn't inherit the wrapper), the marker never appears. Check `/tmp/claws-exec/` for orphaned `.out` files.

### Socket permission denied

The socket is created with `chmod 600`. Only the user who started VS Code can connect. If you're running your script as a different user, that's the problem.

---

## Chapter 12 — Architecture Internals

### Extension Lifecycle

1. VS Code loads the extension on `onStartupFinished`
2. `activate()` runs:
   - Creates the output channel
   - Attaches shell integration listeners
   - Starts the socket server
   - Registers the terminal profile provider
   - Registers commands
3. On each request: parse JSON → dispatch to handler → write response
4. `deactivate()` closes the server and cleans up the socket file

### Socket Server

- Standard Node.js `net.createServer`
- Each connection gets its own buffer for newline-delimited framing
- Requests are handled asynchronously — multiple concurrent requests work
- Socket file created with `chmod 600` for security

### Terminal ID Assignment

- `WeakMap<Terminal, string>` maps VS Code Terminal objects to stable string IDs
- IDs are monotonically increasing integers as strings ("1", "2", "3", ...)
- The WeakMap ensures IDs are garbage-collected when terminals are disposed
- For wrapped terminals created via the profile provider, the ID is pre-reserved before the Terminal object exists

### Wrapped Terminal Mechanics

1. `createTerminal({ shellPath: "scripts/terminal-wrapper.sh", env: { CLAWS_TERM_LOG: path } })`
2. The wrapper script runs: `exec script -q "$CLAWS_TERM_LOG" /bin/zsh -il`
3. `script(1)` creates a pseudo-terminal pair and records all output to the log file
4. The user's shell runs inside this pseudo-terminal — completely transparent
5. `readLog` opens the log file, reads a byte range, strips ANSI via regex, returns clean text

### ANSI Stripping

Two regex patterns applied sequentially:
- CSI sequences: `[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-ntqry=><]`
- Control characters: `[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]`

This removes colors, cursor positioning, screen clearing, and control chars. Newlines (`\n`) and tabs (`\t`) are preserved.

### Configuration Resolution

Settings are read via `vscode.workspace.getConfiguration('claws')` on every request. No caching — changes take effect immediately without reload. Defaults are hardcoded constants that match `package.json` defaults.
