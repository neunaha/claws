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

**From the project root**, run one of:

```bash
# Primary — requires Node.js 18+ (ships with VS Code)
npx claws-code install
```

```bash
# Fallback — non-Node systems, air-gapped environments, or CI
# Note: curl installer is supported through v0.8.x and will be deprecated in v0.9
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
```

The installer is **project-local** — it writes `.mcp.json`, `.claws-bin/mcp_server.js`, and `.claude/{commands,rules,skills}/` into the project you're in. Each project gets its own configurable Claws setup. Re-run it in any other project to enable Claws there.

**Zero runtime dependencies.** Just Node.js (ships with VS Code). The extension is built from TypeScript on install; `node-pty` is an optional native dep with a pure-Node fallback.

### Step 2 — Reload VS Code

`Cmd+Shift+P` → `Developer: Reload Window`

### Step 3 — Restart Claude Code in this project

Exit your current Claude Code session and re-open `claude` from the project root so it picks up the project-local `.mcp.json` and registers the 39 Claws tools. If the tools don't appear, run `/claws-fix`.

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
| `/claws` | Status — live dashboard; forwards to `/claws-do` |
| `/claws-do <task>` | Universal verb — classifies into shell / worker / fleet / wave |
| `/claws-status` | Live terminal + lifecycle dashboard |
| `/claws-help` | Full command and tool reference |
| `/claws-cleanup` | Close all worker terminals |
| `/claws-fix` | Diagnose and auto-repair a broken Claws install |
| `/claws-report` | Bundle logs and diagnostics for a bug report |
| `/claws-update` | Pull latest version |

### Talk naturally — examples:

```
/claws-do run my tests                              → single terminal, runs tests, reports
/claws-do lint test and build in parallel            → 3 terminals, all running simultaneously
/claws-do fix the bug in auth.ts                     → spawns a Claude worker to fix it
/claws-do audit this codebase for security issues    → spawns a Claude worker to audit
/claws-status                                         → shows all terminals + lifecycle state
/claws-cleanup                                        → closes all worker terminals
```

---

## How It Works

<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/architecture.png" alt="Architecture" width="720">
</p>

Claws runs a socket server inside VS Code. Any process connects and controls terminals via JSON commands.

**Wrapped terminals** are the key feature — as of v0.4 they use VS Code's native `Pseudoterminal` API (backed by `node-pty`, with a `child_process` pipe-mode fallback). No `script(1)` wrapping means **zero rendering corruption** for TUI apps like Claude Code, vim, htop, k9s. Every byte the shell emits flows through the extension's own `onDidWrite` event and into an in-memory ring buffer — readable via `readLog` with ANSI escapes stripped, giving you clean text of everything that happened.

A **status bar item** (right side, `$(terminal) Claws (N)`) shows live socket + terminal count at a glance; click it to run Health Check. Color shifts to warning-yellow in pipe-mode and error-red when no server is running.

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

### Self-Diagnosis & Cleanup

Every install ships with a first-class diagnostic surface — no external tools, no guesswork.

- **Status bar item** — live `$(terminal) Claws (N)` with socket + node-pty state in the tooltip. Click to run Health Check. Warning-yellow in pipe-mode, error-red when no server is running.
- **Health Check** (`cmd+alt+c h` / palette → `Claws: Health Check`) — one-shot introspection snapshot: extension version, Node + Electron ABI, platform, `node-pty` load path (or fallback reason), every active socket, MCP server version, uptime.
- **Show Log** (`cmd+alt+c l`) — focuses the `Claws` Output channel with the full runtime trace.
- **Show Status** (`cmd+alt+c s`) — markdown-formatted runtime block, copy-pasteable into a bug report.
- **List Terminals** — QuickPick of every Claws-known terminal (`id · name · wrapped/unwrapped · pid`); selecting one focuses it.
- **Rebuild Native PTY** — runs `@electron/rebuild` against the bundled `node-pty`. Use after a VS Code major upgrade if pipe-mode fallback kicks in.
- **Uninstall Cleanup** — scans open workspace folders, inventories every Claws-installed file (`.mcp.json` entry, `.claws-bin/`, `.claude/commands/claws-*`, skill dirs, `.vscode/extensions.json` recommendation, fenced block in `CLAUDE.md`), shows a per-folder confirmation, removes only what was installed, and writes a summary to the Output channel.

All seven commands are also reachable from the command palette under the `Claws:` category.

### MCP Server — Native Claude Code Integration (project-local)
<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/cap-mcp.png" alt="MCP Server" width="720">
</p>

As of v0.4, every project you install into gets its own `.mcp.json` pointing at a vendored `mcp_server.js` under `.claws-bin/`. Each project's Claws setup is independent — customize per-project, commit with the repo, or gitignore it. The installer handles this automatically.

```json
// <project>/.mcp.json  (generated at install time — absolute paths, machine-specific)
{
  "mcpServers": {
    "claws": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/.claws-bin/mcp_server.js"],
      "cwd": "/absolute/path/to/project",
      "env": { "CLAWS_SOCKET": "/absolute/path/to/.claws/claws.sock" }
    }
  }
}
```

The installer pins absolute paths at install time so the server resolves correctly regardless of which directory Claude Code is launched from.

**39 tools across 8 groups:**

| Group | Tools |
|---|---|
| Terminal control (8) | `claws_list` · `claws_create` · `claws_send` · `claws_exec` · `claws_read_log` · `claws_poll` · `claws_close` · `claws_done` |
| Worker spawn (4) | `claws_worker` · `claws_fleet` · `claws_dispatch_subworker` · `claws_workers_wait` |
| Pub/sub (7) | `claws_hello` · `claws_subscribe` · `claws_publish` · `claws_broadcast` · `claws_ping` · `claws_peers` · `claws_drain_events` |
| Tasks (5) | `claws_task_assign` · `claws_task_update` · `claws_task_complete` · `claws_task_cancel` · `claws_task_list` |
| Lifecycle (4) | `claws_lifecycle_plan` · `claws_lifecycle_advance` · `claws_lifecycle_snapshot` · `claws_lifecycle_reflect` |
| Waves (3) | `claws_wave_create` · `claws_wave_status` · `claws_wave_complete` |
| Pipelines (3) | `claws_pipeline_create` · `claws_pipeline_list` · `claws_pipeline_close` |
| RPC / schemas (5) | `claws_schema_list` · `claws_schema_get` · `claws_rpc_call` · `claws_deliver_cmd` · `claws_cmd_ack` |

### Claws/2 — Multi-Agent Orchestration Protocol

As of v0.6, Claws includes a built-in coordination layer so an **orchestrator Claude** can spawn and manage a **fleet of worker Claudes** over the same socket — no extra infrastructure required.

- **Peer identity** — each agent registers with `claws_hello` (role: orchestrator | worker | observer) and gets a stable `peerId` for the session
- **Pub/sub message bus** — `claws_subscribe` / `claws_publish` / `claws_broadcast` with `*` and `**` wildcard topic patterns; server-push frames delivered without polling
- **Task registry** — orchestrator assigns tasks via `claws_task_assign`; workers report progress with `claws_task_update` and `claws_task_complete`; full lifecycle: pending → running → succeeded / failed / skipped
- **Backward compatible** — all claws/1 terminal-control commands continue to work unchanged

Quick start: type `/claws-v2-orchestrate` in an orchestrator Claude session to see the step-by-step bootstrap guide.

### AI Worker Orchestration
<p align="center">
  <img src="https://raw.githubusercontent.com/neunaha/claws/main/docs/images/ai-orchestration.png" alt="AI Orchestration" width="720">
</p>

`claws_worker` uses a **mode-aware detach default**: in mission-mode (pass `mission=…`) it returns immediately with `terminal_id` + `correlation_id` — non-blocking by default. In command-mode (pass `command=…`) it blocks until the command exits. Override either direction with `detach: true|false`.

```json
{
  "name": "claws_worker",
  "arguments": {
    "name": "refactor-auth",
    "mission": "Refactor auth.ts to use bcrypt. Call claws_done() when done.",
    "timeout_ms": 900000,
    "harvest_lines": 300
  }
}
```

Returns `{ status: "completed" | "failed" | "timeout", terminal_id, correlation_id, duration_ms, harvest, cleaned_up }`. Poll completion with `claws_workers_wait(terminal_ids=[…])`, or arm the per-worker `monitor_arm_command` from the spawn response for event-driven notification.

### claws_done() — the completion primitive

Zero-arg MCP tool. Reads `CLAWS_TERMINAL_ID` from the worker's environment (set by the extension at spawn time), publishes `system.worker.completed` with marker `__CLAWS_DONE__`, and closes the terminal. This is **F3** — the primary close trigger in the 5-layer worker-completion convention.

```json
{ "name": "claws_done", "arguments": {} }
```

No arguments. No peerId needed. No prior `claws_hello` required. The extension injects `CLAWS_TERMINAL_ID` into every worker terminal at boot, so `claws_done()` always knows which terminal to close and which correlation to signal.

Wave D fallback: if a worker exits without calling `claws_done()`, VS Code's `onDidCloseTerminal` fires → the extension publishes `system.worker.terminated` → the server upgrades it to `system.worker.completed` with `completion_signal: 'terminated'`. Workers that die still get accounted for.

### Wave Army — coordinated multi-worker missions

Spawn a fleet of parallel Claude workers for independent or coordinated tasks.

- **`claws_fleet(workers=[…])`** — launch N independent jobs in parallel (lint / test / build). Each gets its own terminal and mission; returns `terminal_ids` immediately.
- **`claws_dispatch_subworker(waveId, role, mission)`** — wave-discipline sub-worker with heartbeat protocol (publish `worker.<peerId>.heartbeat` every 20 s, phase events on each transition, complete event as final act).
- **`claws_workers_wait(terminal_ids=[…])`** — poll completion across a fleet. Blocks until all workers signal done or timeout.

Use cases: parallel test/build/lint pipelines; multi-role audits with a LEAD orchestrator managing specialist sub-workers; any task that benefits from visible progress in multiple terminal tabs.

### Behavioral injection enforcement

Five-layer chain that auto-loads Claws lifecycle context into every Claude session — no manual configuration required:

1. **`~/.claude/CLAUDE.md` global block** — written by `inject-global-claude-md.js` from `templates/CLAUDE.global.md`; always loaded by Claude Code.
2. **`<project>/CLAUDE.md` CLAWS:BEGIN block** — written by `inject-claude-md.js` from `templates/CLAUDE.project.md`; loaded whenever Claude opens this project.
3. **SessionStart hook** — fires when `.claws/claws.sock` is detected; auto-spawns the sidecar (`stream-events.js --auto-sidecar`) and emits a lifecycle reminder.
4. **PreToolUse hook** — gates spawn-class MCP calls (`claws_create`, `claws_worker`, `claws_fleet`, `claws_dispatch_subworker`); refuses if no Monitor process is detected (5 s grace).
5. **Stop hook** — kills the sidecar cleanly at session end via `pgrep` + `kill -TERM`.

All injectors are versioned, regex-matched, and atomic-write safe. All hooks are tagged `_source: "claws"` for clean removal. The chain ensures that even a fresh Claude session in this project has the full operating contract loaded before the first tool call.

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
| VS Code extension | `~/.vscode/extensions/neunaha.claws-0.7.13` | Symlink → `~/.claws-src/extension` |
| Extension bundle | `~/.claws-src/extension/dist/extension.js` | Built from TypeScript on install |
| Bundled native PTY | `~/.claws-src/extension/native/node-pty/` | Self-contained `node-pty` — keeps wrapped terminals glitch-free without a global install |
| Shell hook | `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, `~/.config/fish/conf.d/claws.fish` | CLAWS banner + `claws-*` shell commands |

### Project-level (written into the project you installed from)

| What | Where | Purpose |
|---|---|---|
| MCP registration | `<project>/.mcp.json` | Registers Claws MCP for this project |
| Self-contained MCP | `<project>/.claws-bin/mcp_server.js` | Vendored copy — relative-path registration |
| Slash commands | `<project>/.claude/commands/claws-*.md` | 8 commands: `/claws`, `/claws-do`, `/claws-status`, `/claws-help`, `/claws-cleanup`, `/claws-fix`, `/claws-report`, `/claws-update` |
| Behavior rule | `<project>/.claude/rules/claws-default-behavior.md` | Claude prefers visible terminals in this project |
| Prompt templates skill | `<project>/.claude/skills/claws-prompt-templates/` | 7 mission templates |
| Dynamic CLAUDE.md block | `<project>/CLAUDE.md` (fenced `<!-- CLAWS:BEGIN -->` … `<!-- CLAWS:END -->`) | Tool list + operating principles (generated at install time) |
| Workspace recommendation | `<project>/.vscode/extensions.json` | Adds `neunaha.claws` to `recommendations` so teammates are prompted to install on open |

### Opt-in: global install

Set `CLAWS_GLOBAL_CONFIG=1` to mirror the per-project config into `~/.claude/`. Set `CLAWS_GLOBAL_MCP=1` to also register the MCP globally in `~/.claude/settings.json`. Both default to off.

### Uninstall

Run the uninstall script (from any project you have Claws installed in):

```bash
bash ~/.claws-src/scripts/uninstall.sh
```

Then uninstall the VS Code extension manually:

```bash
code --uninstall-extension neunaha.claws
```

The uninstall script removes: lifecycle hooks from `~/.claude/settings.json`, the `CLAWS:BEGIN` block from `CLAUDE.md`, the shell hook line from `.zshrc`/`.bashrc`, and `.claws-bin/` and `.claws/` from the project root. It is idempotent — safe to re-run.

### Windows

**Windows native install is not supported.** Use WSL2 (Windows Subsystem for Linux) and follow the Unix install steps above. Install WSL2 via: `wsl --install` in an elevated PowerShell, then open a WSL terminal and run the `install.sh` command.

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

## Powered by Claude

Claws worker terminals boot with `claude-sonnet-4-6` by default — the best coding model for orchestration missions. Pass `model=` to `claws_worker` or `claws_fleet` to override per-worker.

---

## Roadmap

- **v0.3** ✅ Zero dependencies — Node.js only
- **v0.4** ✅ TypeScript rewrite, Pseudoterminal (no glitching), project-local install, dynamic CLAUDE.md, automatic legacy migration
- **v0.5** ✅ Hardening sweep — status bar item, Health Check / Uninstall Cleanup, chord keybindings, hot-reloadable config, bundled `node-pty`, 57 automated checks
- **v0.6** ✅ Agentic SDLC Protocol — claws/2 peer registry, pub/sub message bus, task assignment engine, 6 new MCP tools, 33 new automated checks
- **v0.7.x** ✅ Fleet & completion overhaul:
  - `claws_done()` — zero-arg completion primitive (F3 of the 5-layer convention)
  - Wave Army — `claws_fleet` / `claws_dispatch_subworker` / `claws_workers_wait`
  - `/claws-do` — universal verb, classifies any task into shell / worker / fleet / wave (8-command consolidation)
  - Non-blocking workers by default in mission-mode (`detach: true`), mode-aware detach
  - Behavioral injection enforcement — 5-layer chain auto-loads on every session
  - LH-9 TTL watchdog — idle/max timeouts on every worker
  - Lifecycle engine — 10-phase state machine with auto-advance and FAILED recovery
  - 39 MCP tools total
- **v0.8** — WebSocket transport, VS Code Marketplace publish, cross-device control, web dashboard

---

## License

[MIT](LICENSE) · [Anish Neunaha](https://github.com/neunaha) · [Website](https://neunaha.github.io/claws/)
