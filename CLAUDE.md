# Claws — Terminal Control Bridge for VS Code

## What this is

A VS Code extension that turns every integrated terminal into a programmable, observable, controllable endpoint. Any external process (AI orchestrator, automation script, CI runner) can connect via a local socket and:

- **List** all open terminals with PID, shell integration status, and pty log paths
- **Create** new terminals, optionally wrapped in `script(1)` for full pty capture
- **Send** text into any terminal (with safety warnings for non-shell TUIs + bracketed paste for multi-line)
- **Execute** commands with file-based output capture (works even when shell integration doesn't)
- **Read** pty logs from wrapped terminals with ANSI stripping — see everything, including TUI sessions like Claude Code, vim, REPLs
- **Close** terminals and clean up

The extension is the **server**. Clients connect over Unix socket (same machine) or WebSocket (cross-device). Protocol: newline-delimited JSON.

## Architecture

```
┌─ VS Code ──────────────────────────────────────┐
│                                                 │
│  Terminal 1   Terminal 2   Terminal 3   ...      │
│  (unwrapped)  (wrapped)   (wrapped)             │
│       │           │           │                  │
│       └───────────┴───────────┘                  │
│               │                                  │
│        ┌──────┴──────┐                           │
│        │ Claws       │                           │
│        │ Extension   │                           │
│        └──────┬──────┘                           │
│               │                                  │
└───────────────┼──────────────────────────────────┘
                │
     ┌──────────┴──────────┐
     │                     │
Unix Socket           WebSocket
(same machine)        (cross-device)
     │                     │
  Node.js             Node.js
  MCP server          client
```

### Wrapped vs Unwrapped terminals

- **Unwrapped** (default `+` button): standard VS Code terminal. Claws can list/create/send/close but cannot read output (VS Code shell integration is unreliable for TUI sessions).
- **Wrapped** (Claws dropdown or `create wrapped=true`): terminal runs under `script(1)` which logs every pty byte to a file. Claws can `readLog` with ANSI stripping — full visibility into any session, including Claude Code, vim, htop, REPLs. Trade-off: slight buffering delay (~1-2s) on log reads.

### Safety gate

Before sending text into a terminal, Claws checks if the foreground process is a shell (zsh/bash/fish) or a TUI (claude/vim/less/top). If it's a TUI, the send goes through with a warning (not a block) — the caller decides whether to proceed. `strict=true` to hard-block.

## Protocol

Newline-delimited JSON over Unix socket or WebSocket. Every request: `{ id, cmd, ...args }`. Every response: `{ id, ok, ...fields }`.

Commands:
```
list                                → { terminals: [{id, name, pid, logPath, ...}] }
create {name?, cwd?, wrapped?}      → { id, logPath? }
show {id}                           → {}
send {id, text, newline?, paste?}   → {}
exec {id?, command, timeout_ms?}    → { terminalId, commandLine, output, exitCode }
readLog {id, offset?, limit?, strip?} → { bytes, offset, nextOffset, totalSize }
poll {since?}                       → { events: [...], cursor }
close {id}                          → {}
```

Full protocol spec: `@docs/protocol.md`.

## Project structure

```
Claws/
├── extension/          # VS Code extension (the published package)
│   ├── src/            # TypeScript source
│   ├── test/           # Extension tests
│   └── package.json    # Extension manifest
├── clients/
│   ├── python/         # optional — pip install claws-client
│   └── node/           # npm install @claws/client
├── scripts/            # terminal-wrapper.sh and helpers
├── examples/           # Orchestrator patterns
├── docs/               # Architecture, protocol, security
├── CLAUDE.md           # This file
├── README.md           # Public README
└── LICENSE             # MIT
```

## Current state

- **Phase**: 1 — scaffold complete. Extension works as raw JS; TypeScript rewrite planned.
- **Transport**: Unix socket only. WebSocket transport planned (Phase 3).
- **Cross-device**: not yet. SSH tunnel pattern documented as interim. WebSocket + token auth planned.
- **Marketplace**: not published yet. Needs publisher account + bundling + tests.
- **Clients**: MCP server (Node.js) is primary. Python client optional.

## Phase plan

### Phase 1 — Scaffold (current)
- [x] Create project structure
- [x] Extension source (extension.js)
- [x] Python client library (claws-client)
- [x] Terminal wrapper script
- [x] CLAUDE.md + README + LICENSE + CHANGELOG
- [x] Extension package.json with marketplace metadata
- [x] Protocol specification
- [ ] First commit

### Phase 2 — Polish for Marketplace
- [ ] TypeScript rewrite (extension.js → src/*.ts)
- [ ] esbuild bundling
- [ ] contributes.configuration for all settings (socket path, default wrapped, auto-cleanup timeout)
- [ ] Status bar item showing: connected clients count, active terminals count
- [ ] Commands: "Claws: List Terminals", "Claws: Create Wrapped Terminal", "Claws: Show Status"
- [ ] Extension tests with @vscode/test-electron
- [ ] GitHub Actions CI (lint + test on PR, publish on tag)
- [ ] Create VS Code Marketplace publisher account
- [ ] Icon (128×128 PNG) + banner
- [ ] First marketplace publish
- [ ] PyPI publish for claws-client

### Phase 3 — Cross-device
- [ ] WebSocket transport (opt-in, alongside Unix socket)
- [ ] Token-based authentication
- [ ] TLS for WebSocket connections
- [ ] mDNS/Bonjour discovery for LAN
- [ ] "Team" configuration: named devices, per-device terminal access control
- [ ] Cross-device readLog streaming (WebSocket push instead of poll)
- [ ] Node.js client library + npm publish

### Phase 4 — Ecosystem
- [ ] CLI tool (`npx claws list`, `npx claws send 1 "ls"`)
- [ ] REST API mode (HTTP server alongside socket)
- [ ] Dashboard web UI (list terminals, send commands, view logs)
- [ ] VS Code Live Share integration
- [ ] GitHub Action for CI terminal orchestration

## Conventions

- **Node.js only — zero external dependencies.** The extension, MCP server, CLI, and shell hooks are all pure Node.js/JavaScript.
- **TypeScript** for extension code. Strict mode. No `any`.
- **Node 18+** for MCP server and CLI. Zero deps.
- Extension must have **zero npm dependencies** — everything stdlib or VS Code API.
- Python client exists in `clients/python/` as an **optional** convenience — not on the install path.
- `script(1)` wrapper must work on macOS and Linux (BSD vs GNU `script` flags differ).
- Protocol is versioned: `{ protocol: "claws/1", ... }` in handshake.
- MIT license. All contributions welcome.
- Commit messages: conventional commits (`feat:`, `fix:`, `docs:`, `perf:`, `test:`).

## Key design principles

1. **Never use `script -F` with Ink-based TUIs** — `-F` flushes per-write and splits Ink's atomic frames, causing visual corruption. Default buffering is correct.
2. **`parallel: true` must be enforced, not advisory** — if the extension claims parallel dispatch, it must actually dispatch concurrently. Advisory flags create invisible regressions.
3. **Safety gate should warn, not block** — the whole point is sending prompts into Claude Code TUIs. Hard-blocking defeats the use case. Warn + proceed is the right default; `strict=true` for opt-in blocking.
4. **Bracketed paste for multi-line sends** — `\x1b[200~text\x1b[201~` prevents line-by-line fragmentation in shells. Essential for sending prompts.
5. **Monitor pattern for observation** — `tail -F logfile | strip-ansi | grep --line-buffered pattern` piped into a persistent listener is the right cadence for pair-programmer-style observation. Polling is a fallback, not a primary.
6. **Auto-cleanup is mandatory** — every terminal the extension creates must be closeable + cleaned up when the orchestrator session ends. Stale terminals are a UX bug.
7. **File-based exec over shell integration** — VS Code's `onDidEndTerminalShellExecution` is unreliable in wrapped terminals. `{ cmd; } > /tmp/out 2>&1; echo $? > /tmp/done` with polling for the done file is robust across all terminal types.

## What this project is NOT

- Not a terminal emulator (VS Code already is one)
- Not a remote shell (SSH already does that)
- Not a terminal multiplexer (tmux already does that)
- Not a collaboration tool (VS Code Live Share already does that)

It IS: a **bridge** that makes VS Code terminals programmable from the outside. The smallest possible surface area that enables AI-driven terminal orchestration.


## CLAWS — Terminal Orchestration Active

> Injected by Claws v0.2.0 (https://github.com/neunaha/claws)
> Powered by Claude Opus. This section changes how this session operates terminals.

### You are a Claws orchestrator

This Claude Code session has terminal superpowers. You control VS Code terminals from the outside — creating, commanding, reading, monitoring, and closing them programmatically. Everything you do in terminals is visible to the user. You are their AI pair programmer with multi-terminal orchestration.

### Your tools

8 MCP tools are available as native tool calls:

| Tool | What it does |
|---|---|
| `claws_list` | See all open terminals — names, PIDs, wrapped status |
| `claws_create` | Open a new visible terminal (always use `wrapped=true`) |
| `claws_send` | Send text into any terminal — shell commands, TUI input, keystrokes |
| `claws_exec` | Run a command and get stdout + stderr + exit code back |
| `claws_read_log` | Read a wrapped terminal's full output — works on TUI sessions too |
| `claws_poll` | Stream command-completion events across all terminals |
| `claws_close` | Close a terminal — always clean up when done |
| `claws_worker` | One-shot: create terminal → launch Claude Code → send mission → ready to monitor |

### How you operate now

**Before Claws**: you ran commands silently via the Bash tool. The user saw nothing until you reported.

**With Claws**: you run commands in visible terminals. The user watches the work happen live — builds, tests, deploys, AI workers, everything plays out in their terminal panel while you narrate.

**Your default behavior**:

1. **Any task with visible output** → use Claws. Create a wrapped terminal, run the work there, read the result, close the terminal. The user watches.
   - builds, tests, linting, deploys, servers, AI workers, refactoring, audits

2. **Quick lookups** → use Bash directly. No terminal needed for `ls`, `cat`, `git status`, file reads.

3. **Multiple independent tasks** → spawn parallel wrapped terminals. Fire all commands. Monitor all. Close each when done. Report aggregated results.

4. **Complex missions** → use `claws_worker` to spawn a Claude Code session with full permissions in a visible terminal. Send the mission. Monitor via `claws_read_log`. The user watches a second AI working in their terminal panel.

5. **Always visible. Always wrapped. Always clean up. Never headless.**

### Your slash commands

| Command | When to use |
|---|---|
| `/claws` | User wants a dashboard — show terminal status |
| `/claws-do <task>` | User describes a task naturally — you figure out the strategy |
| `/claws-go <mission>` | User wants an AI worker spawned immediately |
| `/claws-watch` | User wants to see all terminals at once |
| `/claws-learn` | User wants to learn how to use Claws |
| `/claws-cleanup` | User wants all worker terminals closed |
| `/claws-update` | User wants the latest version |

### Lifecycle protocol

Every terminal operation follows this sequence:
1. **Plan** — decide how many terminals, what type, what commands
2. **Spawn** — `claws_create` with `wrapped=true`, wait 1.5s for shell init
3. **Deploy** — send the command or mission via `claws_send`
4. **Observe** — monitor via `claws_read_log` at appropriate cadence
5. **React** — if errors, diagnose and intervene or report
6. **Harvest** — read final output, verify deliverables
7. **Cleanup** — `claws_close` every terminal you created
8. **Report** — summarize results to the user

### Rules

- Every terminal you create MUST be closed when done
- Every worker terminal MUST be wrapped (`wrapped=true`)
- Never use headless mode (`claude -p`) — always interactive (`claude --dangerously-skip-permissions`)
- Never touch terminals you didn't create
- Name terminals descriptively: `worker-tests`, `build-server`, `ai-refactor`
- If the user says "stop" — close all worker terminals immediately
