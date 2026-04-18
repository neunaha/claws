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

## The Problem → The Solution

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/before-after.png" alt="Before and After Claws" width="720">
</p>

**Before Claws**: copy a command from Claude → paste in terminal → copy the output → paste it back → repeat 47 times. One terminal. No visibility. No parallelism.

**After Claws**: your AI controls every terminal directly. Spawns workers. Runs tests, builds, deploys — all in parallel, all visible. You just watch.

---

## Get Started in 3 Steps

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/install-flow.png" alt="Install Flow" width="720">
</p>

### Step 1 — Install

**Paste this into any Claude Code terminal:**

> install claws from https://github.com/neunaha/claws — run the install script and set up everything

**Or run directly:**
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
```

**Zero dependencies.** No Python. No pip. No brew. Just Node.js (ships with VS Code).

### Step 2 — Reload VS Code

`Cmd+Shift+P` → `Developer: Reload Window`

### Step 3 — You're ready

Type `/claws` to see the dashboard. Type `/claws-do run my tests` to see it work.

---

## What You'll See

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/what-you-see.png" alt="What You See" width="720">
</p>

After install, your VS Code terminal panel transforms:
- **CLAWS banner** appears in every new terminal with live bridge status
- **"Claws Wrapped Terminal"** appears in the terminal dropdown — click it for full pty capture
- **Multiple worker tabs** appear when AI spawns parallel terminals
- **Shell commands** (`claws-ls`, `claws-new`, `claws-run`, `claws-log`) work in any terminal

---

## The Commands

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/slash-commands.png" alt="Slash Commands" width="720">
</p>

One command to remember: **`/claws`**

| Command | What it does |
|---|---|
| `/claws` | Dashboard — status, terminals, version |
| `/claws-do <task>` | Magic — describe anything, AI figures out the strategy |
| `/claws-go <mission>` | Spawn a Claude Code worker instantly |
| `/claws-watch` | Live control room of all terminals |
| `/claws-learn` | Interactive prompt guide (5 levels) |
| `/claws-cleanup` | Close all worker terminals |
| `/claws-update` | Pull latest + full rebuild + what's new |

### Talk naturally — examples:

```
/claws-do run my tests                              → single terminal, runs tests, reports
/claws-do lint test and build in parallel            → 3 terminals, all running simultaneously
/claws-go fix the bug in auth.ts                     → spawns a Claude worker to fix it
/claws-go audit this codebase for security issues    → spawns a Claude worker to audit
/claws-watch                                          → shows all terminals + their latest output
/claws-cleanup                                        → closes all worker terminals
```

---

## How It Works

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/architecture.png" alt="Architecture" width="720">
</p>

Claws runs a socket server inside VS Code. Any process connects and controls terminals via JSON commands.

**Wrapped terminals** are the key feature — they run your shell inside `script(1)`, which logs every byte to a file. Claws reads it back with ANSI escapes stripped, giving you clean text of everything — including TUI sessions like Claude Code, vim, htop.

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/wrapped-terminal.png" alt="Wrapped Terminal Data Flow" width="720">
</p>

---

## Capabilities

### Terminal Management
<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-terminal-mgmt.png" alt="Terminal Management" width="720">
</p>

List all terminals with PID, name, status. Create new ones with custom names. Focus, show, close programmatically. Every terminal gets a stable numeric ID.

### Full Pty Capture
<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-pty-capture.png" alt="Pty Capture" width="720">
</p>

Read back anything — Claude Code conversations, vim sessions, build logs, REPL outputs. The terminal looks and behaves normally. The capture layer is invisible.

### Command Execution
<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-exec.png" alt="Command Execution" width="720">
</p>

Run commands with captured stdout + stderr + exit code. File-based capture works in every terminal type without shell integration.

### Safety Gate
<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-safety.png" alt="Safety Gate" width="720">
</p>

Detects TUI vs shell. Warns before sending text into vim/claude instead of a shell prompt. Non-blocking by default.

### MCP Server — Native Claude Code Integration
<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-mcp.png" alt="MCP Server" width="720">
</p>

Register once, every Claude Code session gets 8 native terminal tools. The installer does this automatically.

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

**Tools:** `claws_list` · `claws_create` · `claws_send` · `claws_exec` · `claws_read_log` · `claws_poll` · `claws_close` · `claws_worker`

### AI Worker Orchestration
<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/ai-orchestration.png" alt="AI Orchestration" width="720">
</p>

`claws_worker` creates a visible terminal, launches Claude Code with full permissions, sends a mission. One tool call = full autonomous worker that the user watches in real time.

### Cross-Device Control (planned)
<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-crossdevice.png" alt="Cross-Device" width="720">
</p>

WebSocket transport with token auth + TLS. SSH tunnel works today:
```bash
ssh -L 9999:/remote/.claws/claws.sock user@remote
```

---

## What Gets Installed

The installer does everything in one command. Here's exactly what lands on your machine:

| What | Where | Purpose |
|---|---|---|
| VS Code extension | `~/.vscode/extensions/neunaha.claws-0.1.0` | Socket server + terminal control |
| MCP server | `~/.claws-src/mcp_server.js` | 8 native Claude Code tools |
| Behavior rule | `~/.claude/rules/claws-default-behavior.md` | Claude prefers visible terminals |
| Orchestration engine | `~/.claude/skills/claws-orchestration-engine/` | 7 patterns + lifecycle protocol |
| Prompt templates | `~/.claude/skills/claws-prompt-templates/` | 7 mission templates |
| 17 slash commands | `~/.claude/commands/claws*.md` | `/claws`, `/claws-do`, `/claws-go`, etc. |
| Shell hook | `~/.zshrc` or `~/.bashrc` | CLAWS banner + shell commands |
| Terminal wrapper | `~/.claws-src/scripts/terminal-wrapper.sh` | `script(1)` for pty capture |

**To uninstall**: remove `~/.claws-src`, the extension symlink, and the shell hook line from your rc file.

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

Claws was designed for and tested with Claude Opus — the model with the deepest reasoning for multi-terminal orchestration.

---

## Roadmap

- **v0.3** ✅ Zero dependencies — Node.js only
- **v0.4** — TypeScript rewrite, VS Code Marketplace publish
- **v0.5** — WebSocket transport, cross-device control
- **v0.6** — Team config, device discovery, web dashboard

---

## License

[MIT](LICENSE) · [Anish Neunaha](https://github.com/neunaha) · [Website](https://neunaha.github.io/claws/)
