<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/social-preview.png" alt="Claws Banner" width="720">
</p>

<h1 align="center">Claws</h1>

<p align="center">
  <strong>Your AI just got terminal superpowers.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/VS%20Code-1.93+-007ACC.svg" alt="VS Code">
  <img src="https://img.shields.io/badge/dependencies-zero-brightgreen.svg" alt="Zero Deps">
  <img src="https://img.shields.io/badge/macOS%20%7C%20Linux-supported-lightgrey.svg" alt="Platform">
  <img src="https://img.shields.io/github/stars/neunaha/claws?style=social" alt="Stars">
</p>

---

One extension. One socket. Full control over every VS Code terminal from the outside. Your AI writes code in one terminal, tests in another, deploys in a third — while you watch.

~~Copy the command from Claude. Paste it in the terminal. Copy the output. Paste it back. Repeat 47 times.~~ **That loop is over.**

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/hero-cinematic.png" alt="Claws Terminal Orchestration" width="720">
</p>

---

## Install

```bash
git clone https://github.com/neunaha/claws.git
cd claws
ln -s "$(pwd)/extension" ~/.vscode/extensions/neunaha.claws-0.1.0
chmod +x scripts/terminal-wrapper.sh
# Cmd+Shift+P → "Developer: Reload Window"
```

---

## 5 Lines to Full Control

```python
from claws import ClawsClient

client = ClawsClient(".claws/claws.sock")
worker = client.create("build", wrapped=True)
result = client.exec(worker.id, "npm test")
print(f"exit {result.exit_code}: {result.output}")
client.close(worker.id)
```

---

## Capabilities

### Terminal Management

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-terminal-mgmt.png" alt="Terminal Management" width="720">
</p>

List every terminal with PID, name, and status. Create new ones with custom names and working directories. Focus, show, or close any terminal programmatically. Every terminal gets a stable numeric ID that persists for the session — no fragile name-matching.

---

### Full Pty Capture — Read Everything

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-pty-capture.png" alt="Full Pty Capture" width="720">
</p>

Regular terminals are write-only from the outside. **Wrapped terminals change that.** They run your shell inside `script(1)`, logging every pty byte to disk. Claws reads it back with ANSI escapes stripped — giving you clean, readable text of everything that happened.

Read back: Claude Code conversations, vim sessions, build logs, REPL outputs, htop dashboards — anything rendered to a terminal.

The terminal looks and behaves identically to a regular one. The capture layer is invisible.

```python
# Read the last 50 lines of a wrapped terminal
log = client.read_log(terminal_id, lines=50)
print(log)
# $ npm test
# PASS src/utils.test.ts (3.421s)
#   ✓ should parse JSON correctly (5ms)
# Tests: 2 passed, 2 total
```

**Create from the UI:** Click the dropdown arrow next to `+` → **"Claws Wrapped Terminal"**

---

### Command Execution with Structured Output

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-exec.png" alt="Command Execution" width="720">
</p>

Two modes:

- **`send`** — fire and forget. Text arrives at whatever input is active (shell, TUI, REPL). Supports multi-line via bracketed paste + raw keystrokes (`\r`, `\x03` for Ctrl+C).
- **`exec`** — wait for completion, get structured results. stdout + stderr + exit code. File-based capture that works in every terminal type without shell integration.

```python
result = client.exec(term_id, "git status --porcelain")
# result.output = "M  src/main.ts\n"
# result.exit_code = 0
```

---

### Safety Gate — Foreground Process Detection

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-safety.png" alt="Safety Gate" width="720">
</p>

Before sending text, Claws checks what's running in the terminal. If it's a TUI (vim, claude, less, top) instead of a shell, it warns you — because your text would land as TUI input, not a shell command.

**Default:** warn and proceed (non-blocking — AI pair programming needs to send into Claude Code's TUI intentionally). **Strict mode:** hard-block with `strict: true`.

---

### MCP Server — Native Claude Code Integration

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-mcp.png" alt="MCP Server" width="720">
</p>

Register one JSON block in any project. Claude Code instantly gets 8 terminal control tools as native MCP calls. No imports, no client library, no socket code.

```json
{
  "mcpServers": {
    "claws": {
      "command": "python3",
      "args": ["/path/to/claws/mcp_server.py"],
      "env": { "CLAWS_SOCKET": ".claws/claws.sock" }
    }
  }
}
```

**Tools injected:** `claws_list` · `claws_create` · `claws_send` · `claws_exec` · `claws_read_log` · `claws_poll` · `claws_close` · `claws_worker`

---

### Cross-Device Control (planned)

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-crossdevice.png" alt="Cross-Device Control" width="720">
</p>

Control terminals on remote machines via WebSocket with token auth + TLS. Team configuration with per-device access control. **Available today via SSH tunnel:**

```bash
ssh -L 9999:/remote/.claws/claws.sock user@remote
client = ClawsClient("/tmp/forwarded.sock")
```

---

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/architecture.png" alt="Architecture" width="720">
</p>

### How Wrapped Terminals Work

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/wrapped-terminal.png" alt="Wrapped Terminal Data Flow" width="720">
</p>

---

## Protocol

Newline-delimited JSON over Unix socket.

| Command | What it does |
|---|---|
| `list` | Enumerate all terminals with PID, name, log path |
| `create` | Open a new terminal (optionally wrapped for pty capture) |
| `show` | Focus a terminal in the panel |
| `send` | Send text into a terminal (shell or TUI) |
| `exec` | Execute command with captured stdout + stderr + exit code |
| `readLog` | Read wrapped terminal's pty log with ANSI stripping |
| `poll` | Stream shell-integration command events |
| `close` | Dispose a terminal |

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/protocol-flow.png" alt="Protocol Flow" width="720">
</p>

---

## AI Pair Programming

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/ai-orchestration.png" alt="AI Orchestration" width="720">
</p>

Spawn multiple Claude Code sessions in separate terminals. Send mission prompts to each. Monitor progress via pty log tailing. React to errors in real time. Clean up when done.

```python
# Spawn 3 parallel workers
for name, cmd in [("lint","npm run lint"),("test","npm test"),("build","npm run build")]:
    term = client.create(f"worker-{name}", wrapped=True)
    client.send(term.id, cmd)

# Monitor all
import time; time.sleep(10)
for name in ["lint","test","build"]:
    log = client.read_log(workers[name].id, lines=20)
    print(f"=== {name} ===\n{log}")
```

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `claws.socketPath` | `.claws/claws.sock` | Socket location (relative to workspace) |
| `claws.logDirectory` | `.claws/terminals` | Wrapped terminal log directory |
| `claws.defaultWrapped` | `false` | Make all new terminals wrapped by default |
| `claws.maxOutputBytes` | `262144` | Max output per command event (256KB) |
| `claws.maxHistory` | `500` | Event ring buffer size |

---

## Prompt Templates

7 battle-tested mission prompt templates for AI terminal orchestration:

1. **Single Mission Worker** — one terminal, one scoped task, one deliverable
2. **Analysis + Write Findings** — read-only audit with structured output
3. **Multi-Commit Implementation** — N atomic commits with verification
4. **Interactive Pair Programming** — ongoing multi-turn conversation
5. **Parallel Fleet Dispatch** — N workers, N terminals, aggregated results
6. **Graphify-Driven Exploration** — knowledge graph as primary reasoning surface
7. **Error Recovery / Debugging** — diagnose, fix, verify with minimal diffs

[Full templates →](https://github.com/neunaha/claws/blob/main/.claude/skills/prompt-templates/SKILL.md)

---

## Documentation

| Resource | Description |
|---|---|
| [Complete Guide](https://github.com/neunaha/claws/blob/main/docs/guide.md) | 12-chapter course, install to fleet orchestration |
| [Feature Reference](https://github.com/neunaha/claws/blob/main/docs/features.md) | Every command, parameter, edge case |
| [Protocol Spec](https://github.com/neunaha/claws/blob/main/docs/protocol.md) | Full JSON socket protocol |
| [Prompt Templates](https://github.com/neunaha/claws/blob/main/.claude/skills/prompt-templates/SKILL.md) | 7 mission prompt patterns |
| [Contributing](https://github.com/neunaha/claws/blob/main/CONTRIBUTING.md) | Dev setup + how to contribute |
| [Security](https://github.com/neunaha/claws/blob/main/SECURITY.md) | Trust model + vulnerability reporting |
| [Landing Page](https://neunaha.github.io/claws/) | Full website with visuals + case studies |

---

## Roadmap

- **v0.2** — TypeScript rewrite, Marketplace publish, status bar, tests
- **v0.3** — WebSocket transport, token auth, TLS, cross-device
- **v0.4** — Team config, device discovery, CLI tool, web dashboard

---

## License

[MIT](https://github.com/neunaha/claws/blob/main/LICENSE) · [Anish Neunaha](https://github.com/neunaha) · [Website](https://neunaha.github.io/claws/)
