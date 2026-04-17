<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/extension/icon.png" alt="Claws" width="100" height="100">
</p>

<h1 align="center">Claws</h1>

<p align="center">
  <strong>Control any VS Code terminal from the outside.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/VS%20Code-1.93+-007ACC.svg" alt="VS Code">
  <img src="https://img.shields.io/badge/dependencies-zero-brightgreen.svg" alt="Zero Deps">
  <img src="https://img.shields.io/badge/macOS%20%7C%20Linux-supported-lightgrey.svg" alt="Platform">
</p>

---

Claws is a VS Code extension that exposes your integrated terminals over a local socket. List, create, send commands, capture output, read TUI sessions, and close terminals — all from Python, Node, or any language that speaks JSON.

**Built for AI pair programming.** One AI agent spawns, monitors, and drives multiple terminals in parallel — watching output, reacting to errors, sending prompts. Works with Claude Code, Cursor, Copilot, or any terminal-based workflow.

---

## Install

```bash
# 1. Clone
git clone https://github.com/neunaha/claws.git
cd claws

# 2. Symlink into VS Code
ln -s "$(pwd)/extension" ~/.vscode/extensions/neunaha.claws-0.1.0

# 3. Make the wrapper executable
chmod +x scripts/terminal-wrapper.sh

# 4. Reload VS Code
#    Cmd+Shift+P → "Developer: Reload Window"

# 5. (Optional) Install Python client
pip install -e clients/python
```

That's it. Open the terminal dropdown (arrow next to `+`) — you'll see **"Claws Wrapped Terminal"**.

---

## Usage

```python
from claws import ClawsClient

client = ClawsClient(".claws/claws.sock")

# See all terminals
for t in client.list():
    print(f"{t.id}  {t.name}  pid={t.pid}")

# Create a terminal you can read
worker = client.create("build", wrapped=True)

# Run a command, get the output
result = client.exec(worker.id, "npm test")
print(result.output)       # full stdout + stderr
print(result.exit_code)    # 0

# Read a TUI session (Claude Code, vim, htop)
log = client.read_log(worker.id, lines=50)

# Done
client.close(worker.id)
```

Or use raw sockets from any language:

```bash
echo '{"id":1,"cmd":"list"}' | nc -U .claws/claws.sock
```

---

## How It Works

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/architecture.png" alt="Claws Architecture" width="720">
</p>

Claws runs a socket server inside VS Code. Clients connect and control terminals via JSON commands. Wrapped terminals capture full pty output via `script(1)` — readable even for TUI sessions.

---

## Wrapped Terminals — Full Pty Capture

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/wrapped-terminal.png" alt="Wrapped Terminal Data Flow" width="720">
</p>

The killer feature. A wrapped terminal runs your shell inside `script(1)`, which logs every byte that flows through the pty to a file. Claws reads that file back with ANSI escapes stripped — giving you **clean, readable text of everything that happened**.

What you can read:
- Interactive TUI sessions (Claude Code, vim, nano, htop)
- REPL outputs (Python, Node, irb, ghci)
- Build logs, test runners, server output
- Full conversation transcripts from AI coding assistants

The terminal looks and behaves identically to a regular terminal. The `script(1)` layer is invisible to the user.

**Create from the UI**: Click the dropdown arrow next to `+` → **"Claws Wrapped Terminal"**

**Create from code**: `client.create("name", wrapped=True)`

```python
# Read the last 50 lines of a wrapped terminal
log = client.read_log(terminal_id, lines=50)
print(log)
# Output (clean text, ANSI stripped):
#   $ npm test
#   PASS src/utils.test.ts (3.421s)
#     ✓ should parse JSON correctly (5ms)
#   Tests: 2 passed, 2 total
```

---

## Command Execution with Output Capture

Two modes:

### `send` — Raw Text Injection

Send text into any terminal. Supports single-line, multi-line (auto bracketed paste), and raw keystrokes (`\r`, `\x03` for Ctrl+C).

```python
client.send(terminal_id, "git status")
client.send(terminal_id, "\x03")  # Ctrl+C to interrupt
```

### `exec` — Structured Output Capture

Run a command, wait for it to finish, get stdout + stderr + exit code:

```python
result = client.exec(terminal_id, "python3 -c 'print(2+2)'")
# result.output = "4\n"
# result.exit_code = 0
```

Uses file-based capture under the hood — works in every terminal type without depending on shell integration.

---

## Safety Gate

Before sending text into a terminal, Claws checks the foreground process. If the terminal is running a TUI (claude, vim, less, top), it warns you — because your text will land as TUI input, not a shell command.

```
[warning: foreground is 'vim' (not a shell)] sent
```

Default: warn and proceed (non-blocking). Set `strict: true` to hard-block. The warning prevents accidental sends while still allowing intentional AI orchestration of TUI sessions.

---

## Event Streaming

### `poll` — Shell Integration Events

Stream finished-command events across all terminals:

```python
events, cursor = client.poll(since=0)
for e in events:
    print(f"[{e['terminalName']}] $ {e['commandLine']} → exit {e['exitCode']}")
```

### `readLog` — Pty Log Tailing

Tail a wrapped terminal's log with ANSI stripping. Supports offset-based incremental reads:

```python
log = client.read_log(terminal_id, lines=100)
```

---

## Cross-Device Control (planned)

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cross-device.png" alt="Cross-Device Architecture" width="720">
</p>

WebSocket transport with token auth + TLS for controlling terminals across machines. SSH tunnel pattern works today:

```bash
ssh -L 9999:/remote/workspace/.claws/claws.sock user@remote
```

---

## Protocol

Newline-delimited JSON over Unix socket.

```
{"id":1, "cmd":"list"}                                    → terminals
{"id":2, "cmd":"create", "name":"w", "wrapped":true}      → id + logPath
{"id":3, "cmd":"send", "id":"2", "text":"ls -la"}         → ok
{"id":4, "cmd":"readLog", "id":"2"}                        → clean text
{"id":5, "cmd":"exec", "id":"2", "command":"npm test"}     → output + exitCode
{"id":6, "cmd":"close", "id":"2"}                          → ok
```

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `claws.socketPath` | `.claws/claws.sock` | Socket location relative to workspace |
| `claws.logDirectory` | `.claws/terminals` | Wrapped terminal log directory |
| `claws.defaultWrapped` | `false` | Make all new terminals wrapped |
| `claws.maxOutputBytes` | `262144` | Max output per event (256KB) |
| `claws.maxHistory` | `500` | Event ring buffer size |

---

## AI Orchestration Patterns

Claws ships with 7 production-grade prompt templates for terminal orchestration:

**Single Mission Worker** — scoped task, one terminal, one deliverable

**Parallel Fleet** — N workers, N terminals, aggregated results

**Interactive Pair Programming** — ongoing conversation, send follow-ups based on observed output

**Graphify-Driven Exploration** — use a knowledge graph as the primary reasoning surface

**Error Recovery** — diagnose + fix with minimal diffs and verification

See the full [Prompt Templates](https://github.com/neunaha/claws/blob/main/.claude/skills/prompt-templates/SKILL.md) reference.

---

## Slash Commands

When using Claude Code in the Claws project, these commands are available:

| Command | Description |
|---|---|
| `/claws-connect` | Verify the bridge is live |
| `/claws-status` | Full health check |
| `/claws-create <name>` | Create a wrapped terminal |
| `/claws-send <id> <text>` | Send text to a terminal |
| `/claws-exec <id> <cmd>` | Execute with captured output |
| `/claws-read <id>` | Read wrapped terminal log |
| `/claws-worker <name> <cmd>` | Full worker pattern with monitoring |
| `/claws-fleet <tasks>` | Parallel fleet dispatch |

---

## Roadmap

- **v0.2** — TypeScript rewrite, Marketplace publish, status bar, tests
- **v0.3** — WebSocket transport, token auth, TLS, cross-device control
- **v0.4** — Team config, device discovery, CLI tool, web dashboard

---

## License

[MIT](https://github.com/neunaha/claws/blob/main/LICENSE) &copy; Anish Neunaha
