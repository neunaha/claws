<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/extension/icon.png" alt="Claws" width="100" height="100">
</p>

<h1 align="center">Claws</h1>

<p align="center">
  <strong>Control any VS Code terminal from the outside.</strong>
</p>

<p align="center">
  <a href="#install">Install</a> &middot;
  <a href="#usage">Usage</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="docs/protocol.md">Protocol</a> &middot;
  <a href="#configuration">Config</a>
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

## Features

**Terminal Control** — list, create, focus, send text, close. Stable numeric IDs. Custom names and working directories.

**Wrapped Terminals** — create terminals under `script(1)` that log every pty byte to disk. Read back any session — shells, TUIs, REPLs, AI agents — with ANSI escapes stripped to clean text. Available from the terminal dropdown or via API.

**Command Execution** — run commands with captured stdout + stderr + exit code. File-based capture that works in any terminal, no shell integration dependency.

**Multi-line Paste** — auto-wraps multi-line text in bracketed paste mode so terminals receive it as one atomic input, not line-by-line.

**Safety Gate** — detects when a terminal is running a TUI (vim, claude, less) and warns before sending text that would land as TUI input instead of a shell command.

**Event Streaming** — poll for finished-command events across all terminals, or tail pty logs in real-time for wrapped terminals.

**Zero Dependencies** — the extension is pure JavaScript with no npm packages. The Python client is stdlib-only.

---

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `claws.socketPath` | `.claws/claws.sock` | Socket location (relative to workspace) |
| `claws.logDirectory` | `.claws/terminals` | Where wrapped terminal logs go |
| `claws.defaultWrapped` | `false` | Make all new terminals wrapped by default |
| `claws.maxOutputBytes` | `262144` | Max output per command event (256KB) |
| `claws.maxHistory` | `500` | Command events retained in ring buffer |

---

## Protocol

Newline-delimited JSON over Unix socket. [Full spec →](docs/protocol.md)

```
{"id":1, "cmd":"list"}                                    → terminals
{"id":2, "cmd":"create", "name":"w", "wrapped":true}      → id + logPath
{"id":3, "cmd":"send", "id":"2", "text":"ls -la"}         → ok
{"id":4, "cmd":"readLog", "id":"2"}                        → clean text
{"id":5, "cmd":"close", "id":"2"}                          → ok
```

---

## How It Works

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/architecture.png" alt="Claws Architecture" width="720">
</p>

Claws runs a socket server inside VS Code. Clients connect and control terminals via JSON commands. Wrapped terminals capture full pty output via `script(1)` — readable even for TUI sessions.

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/wrapped-terminal.png" alt="Wrapped Terminal Data Flow" width="720">
</p>

### Cross-Device Control (planned)

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cross-device.png" alt="Cross-Device Architecture" width="720">
</p>

WebSocket transport with token auth + TLS for controlling terminals across machines. SSH tunnel pattern works today as an interim solution.

---

## MCP Server — instant Claude Code integration

Register Claws as an MCP server and every Claude Code session gets native terminal control tools — no client library needed.

```json
// .claude/settings.json (in any project)
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

Claude Code immediately gets: `claws_list`, `claws_create`, `claws_send`, `claws_exec`, `claws_read_log`, `claws_poll`, `claws_close`, `claws_worker`.

No imports. No client code. Just register the server and your AI can control terminals.

---

## Deep Dives

- **[Complete Feature Reference](docs/features.md)** — every feature explained in depth with parameters, examples, and internals
- **[Protocol Specification](docs/protocol.md)** — full socket protocol spec with all commands, fields, and error codes
- **[Prompt Templates](/.claude/skills/prompt-templates/SKILL.md)** — 7 production-grade templates for worker missions, fleet dispatch, pair-programming, debugging, and graphify-driven exploration

## Roadmap

- **v0.2** — TypeScript rewrite, VS Code Marketplace publish, status bar, tests
- **v0.3** — WebSocket transport for cross-device control, token auth, TLS
- **v0.4** — Team config, device discovery, CLI tool, web dashboard

---

## License

[MIT](LICENSE) &copy; Anish Neunaha
