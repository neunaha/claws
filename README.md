<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/social-preview.png" alt="Claws" width="720">
</p>

<h1 align="center">Claws</h1>

<p align="center">
  <strong>Your AI just got terminal superpowers.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/VS%20Code-1.93+-007ACC.svg" alt="VS Code">
  <img src="https://img.shields.io/badge/dependencies-zero-brightgreen.svg" alt="Zero Deps">
  <img src="https://img.shields.io/badge/Node.js-only-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/Python-not%20required-lightgrey.svg" alt="No Python">
  <img src="https://img.shields.io/github/stars/neunaha/claws?style=social" alt="Stars">
</p>

---

One VS Code extension. One socket. Full control over every terminal from the outside. Your AI writes code in one terminal, runs tests in another, deploys in a third — while you watch everything happen live.

~~Copy the command from Claude. Paste it in the terminal. Copy the output. Paste it back. Repeat 47 times.~~ **That loop is over.**

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/hero-cinematic.png" alt="Claws Terminal Orchestration" width="720">
</p>

---

## Install

**Paste this into any Claude Code terminal:**

> install claws from https://github.com/neunaha/claws — run the install script and set up everything

**Or run directly (macOS / Linux):**
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.ps1 | iex
```

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/zero-dep-install.png" alt="Zero Dependency Install" width="720">
</p>

**Zero dependencies.** No Python. No pip. No brew. Just Node.js (ships with VS Code). One command, everything works.

After install: `Cmd+Shift+P` → `Developer: Reload Window`. Then type `/claws` to get started.

---

## The Commands

One command to remember: **`/claws`**

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/slash-commands.png" alt="Slash Commands" width="720">
</p>

| Command | What it does |
|---|---|
| `/claws` | Dashboard — status, terminals, version |
| `/claws-do <task>` | Magic — describe anything, AI figures out the strategy |
| `/claws-go <mission>` | Spawn a Claude Code worker instantly |
| `/claws-watch` | Live control room of all terminals |
| `/claws-learn` | Interactive prompt guide (5 levels) |
| `/claws-cleanup` | Close all worker terminals |
| `/claws-update` | Pull latest + full rebuild + what's new |

**Talk naturally:**
```
/claws-do run my tests
/claws-do lint test and build in parallel
/claws-go fix the bug in auth.ts
/claws-go audit this codebase for security issues
```

---

## How It Works

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/architecture.png" alt="Architecture" width="720">
</p>

Claws runs a socket server inside VS Code. Any process connects and controls terminals via JSON commands. **Wrapped terminals** capture full pty output via `script(1)` — readable even for TUI sessions like Claude Code, vim, and htop.

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/wrapped-terminal.png" alt="Wrapped Terminal" width="720">
</p>

---

## Capabilities

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-terminal-mgmt.png" alt="Terminal Management" width="720">
</p>

**Terminal Control** — list, create, focus, send text, close. Stable numeric IDs. Custom names and working directories.

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-pty-capture.png" alt="Pty Capture" width="720">
</p>

**Full Pty Capture** — wrapped terminals log every byte. Read back Claude Code conversations, vim sessions, build logs, REPL outputs — all as clean ANSI-stripped text.

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-exec.png" alt="Command Execution" width="720">
</p>

**Command Execution** — run commands with captured stdout + stderr + exit code. File-based capture that works in every terminal type.

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-safety.png" alt="Safety Gate" width="720">
</p>

**Safety Gate** — detects when a terminal runs a TUI (vim, claude, less). Warns before sending text that would land as TUI input.

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-mcp.png" alt="MCP Server" width="720">
</p>

**MCP Server** — register once, every Claude Code session gets 8 native terminal tools. Node.js, zero dependencies.

```json
{
  "mcpServers": {
    "claws": {
      "command": "node",
      "args": ["/Users/YOU/.claws-src/mcp_server.js"]
    }
  }
}
```

The installer registers this automatically.

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/ai-orchestration.png" alt="AI Orchestration" width="720">
</p>

**AI Worker Spawn** — `claws_worker` creates a terminal, launches Claude Code with full permissions, sends a mission, returns the terminal for monitoring. One tool call = full autonomous worker.

---

## Cross-Device Control (planned)

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-crossdevice.png" alt="Cross-Device" width="720">
</p>

WebSocket transport with token auth + TLS. SSH tunnel works today:
```bash
ssh -L 9999:/remote/.claws/claws.sock user@remote
```

---

## Documentation

| Resource | Description |
|---|---|
| [Complete Guide](docs/guide.md) | 12-chapter course, install to fleet orchestration |
| [Feature Reference](docs/features.md) | Every command, parameter, edge case |
| [Protocol Spec](docs/protocol.md) | Full JSON socket protocol |
| [Prompt Templates](.claude/skills/prompt-templates/SKILL.md) | 7 mission prompt patterns |
| [Landing Page](https://neunaha.github.io/claws/) | Website with visuals + case studies |
| [Contributing](CONTRIBUTING.md) | Dev setup + how to contribute |

---

## Powered by Claude Opus

Claws was designed for and tested with Claude Opus — the model with the deepest reasoning for multi-terminal orchestration. The orchestration engine, lifecycle protocol, and prompt templates are optimized for Opus-class capabilities.

---

## Roadmap

- **v0.3** ✅ Zero dependencies — Node.js only, no Python/pip/brew
- **v0.4** — TypeScript rewrite, VS Code Marketplace publish, tests
- **v0.5** — WebSocket transport, token auth, TLS, cross-device
- **v0.6** — Team config, device discovery, CLI tool, web dashboard

---

## License

[MIT](LICENSE) · [Anish Neunaha](https://github.com/neunaha) · [Website](https://neunaha.github.io/claws/)
