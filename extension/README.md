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

### Step 1 — Install into your project

**From the project root**, paste this into any terminal:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
```

The installer is **project-local** — it writes `.mcp.json`, `.claws-bin/mcp_server.js`, and `.claude/{commands,rules,skills}/` into the project you're in. Each project gets its own configurable Claws setup. Re-run it in any other project to enable Claws there.

**Zero runtime dependencies.** Just Node.js (ships with VS Code). The extension is built from TypeScript on install; `node-pty` is an optional native dep with a pure-Node fallback.

### Step 2 — Reload VS Code

`Cmd+Shift+P` → `Developer: Reload Window`

### Step 3 — Restart Claude Code in this project

Exit your current Claude Code session and re-open `claude` from the project root so it picks up the project-local `.mcp.json` and registers the 8 Claws tools. If the tools don't appear, run `/claws-fix`.

### Step 4 — You're ready

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

**Wrapped terminals** are the key feature — as of v0.4 they use VS Code's native `Pseudoterminal` API (backed by `node-pty`, with a `child_process` pipe-mode fallback). No `script(1)` wrapping means **zero rendering corruption** for TUI apps like Claude Code, vim, htop, k9s. Every byte the shell emits flows through the extension's own `onDidWrite` event and into an in-memory ring buffer — readable via `readLog` with ANSI escapes stripped, giving you clean text of everything that happened.

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

### MCP Server — Native Claude Code Integration (project-local)
<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-mcp.png" alt="MCP Server" width="720">
</p>

As of v0.4, every project you install into gets its own `.mcp.json` pointing at a vendored `mcp_server.js` under `.claws-bin/`. Each project's Claws setup is independent — customize per-project, commit with the repo, or gitignore it. The installer handles this automatically.

```json
// <project>/.mcp.json
{
  "mcpServers": {
    "claws": {
      "command": "node",
      "args": ["./.claws-bin/mcp_server.js"],
      "env": { "CLAWS_SOCKET": ".claws/claws.sock" }
    }
  }
}
```

**Tools:** `claws_list` · `claws_create` · `claws_send` · `claws_exec` · `claws_read_log` · `claws_poll` · `claws_close` · `claws_worker`

### AI Worker Orchestration (blocking lifecycle)
<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/ai-orchestration.png" alt="AI Orchestration" width="720">
</p>

`claws_worker` is a **single blocking tool call that runs the full worker lifecycle**: spawn a wrapped terminal → launch Claude Code with full permissions → detect boot → send mission → poll the capture buffer for `MISSION_COMPLETE` (or a custom marker) → harvest the last N lines → auto-close the terminal → return a structured result.

```json
{
  "name": "claws_worker",
  "arguments": {
    "name": "refactor-auth",
    "mission": "Refactor auth.ts to use bcrypt. Write MISSION_COMPLETE when done.",
    "timeout_ms": 900000,
    "harvest_lines": 300
  }
}
```

Returns `{ status: "completed" | "failed" | "timeout", terminal_id, duration_ms, marker_line, harvest, cleaned_up }`. No manual polling, no manual cleanup. Pass `detach: true` to keep the old fire-and-forget behavior.

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

The installer writes files in **two scopes**: the machine (once) and the project you ran it in (per-project, re-run for each project you want Claws in).

### Machine-level (written once, shared by all projects)

| What | Where | Purpose |
|---|---|---|
| Cloned source | `~/.claws-src/` | Full repo clone — used by `/claws-update` |
| VS Code extension | `~/.vscode/extensions/neunaha.claws-0.4.0` | Symlink → `~/.claws-src/extension` |
| Extension bundle | `~/.claws-src/extension/dist/extension.js` | Built from TypeScript on install |
| Shell hook | `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, `~/.config/fish/conf.d/claws.fish` | CLAWS banner + `claws-*` shell commands |

### Project-level (written into the project you installed from)

| What | Where | Purpose |
|---|---|---|
| MCP registration | `<project>/.mcp.json` | Registers Claws MCP for this project |
| Self-contained MCP | `<project>/.claws-bin/mcp_server.js` | Vendored copy — relative-path registration |
| Slash commands | `<project>/.claude/commands/claws-*.md` | 19 commands: `/claws`, `/claws-do`, `/claws-go`, `/claws-worker`, `/claws-fleet`, `/claws-fix`, `/claws-update`, … |
| Behavior rule | `<project>/.claude/rules/claws-default-behavior.md` | Claude prefers visible terminals in this project |
| Orchestration skill | `<project>/.claude/skills/claws-orchestration-engine/` | 7 patterns + lifecycle protocol |
| Prompt templates | `<project>/.claude/skills/claws-prompt-templates/` | 7 mission templates |
| Dynamic CLAUDE.md block | `<project>/CLAUDE.md` (fenced `<!-- CLAWS:BEGIN -->` … `<!-- CLAWS:END -->`) | Tool list + operating principles (generated at install time) |

### Opt-in: global install

Set `CLAWS_GLOBAL_CONFIG=1` to mirror the per-project config into `~/.claude/`. Set `CLAWS_GLOBAL_MCP=1` to also register the MCP globally in `~/.claude/settings.json`. Both default to off.

### Uninstall

Machine-wide: `rm -rf ~/.claws-src`, remove the extension symlink, remove the shell-hook line. Project-level: `rm -rf .claws-bin .claude/commands/claws-*.md .claude/rules/claws-default-behavior.md .claude/skills/claws-* .mcp.json` and delete the fenced block from `CLAUDE.md`.

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
- **v0.4** ✅ TypeScript rewrite, Pseudoterminal (no glitching), blocking `claws_worker`, project-local install, dynamic CLAUDE.md, automatic legacy migration
- **v0.5** — State persistence across VS Code reload, `claws_ping` health check, WebSocket transport, VS Code Marketplace publish
- **v0.6** — Cross-device control, team config, device discovery, web dashboard

---

## License

[MIT](LICENSE) · [Anish Neunaha](https://github.com/neunaha) · [Website](https://neunaha.github.io/claws/)
