# Changelog

All notable changes to Claws will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-04-14

### Changed
- MCP server rewritten from Python to Node.js — zero dependencies
- Install no longer requires Python, pip, or brew
- Shell hook commands rewritten from Python to Node.js

### Removed
- Python dependency from install path (Python client remains as optional)

## [0.2.0] - 2026-04-18

### Added
- **MCP Server** — register once, every Claude Code session gets 8 terminal control tools natively
- **Orchestration Engine skill** — 7 patterns (scout, single worker, parallel fleet, AI session driver, pipeline stages, watchdog, orchestrator with delegation)
- **Lifecycle YAML protocol** — 8-phase terminal lifecycle (plan → spawn → deploy → observe → recover → harvest → cleanup → reflect)
- **Prompt engineering guide** — `/claws-help` with 5 levels from beginner to power user
- **Default behavior rule** — Claude prefers visible Claws terminals over silent Bash
- **CLAUDE.md injection** — installer appends Claws orchestration context to project CLAUDE.md
- **Shell hook** — every terminal shows CLAWS banner with bridge status + 4 shell commands (claws-ls, claws-new, claws-run, claws-log)
- **Auto-launch Claude Code** — `claws_worker` auto-starts `claude --dangerously-skip-permissions` in worker terminals
- **Click-to-copy install prompt** on landing page
- **npx claws-cli** — Node.js CLI installer with `claude mcp add` support
- **11 slash commands** — /claws-help, /claws-install, /claws-update, /claws-status, /claws-connect, /claws-create, /claws-send, /claws-exec, /claws-read, /claws-worker, /claws-fleet
- **7 prompt templates** — single worker, analysis, multi-commit, pair programming, parallel fleet, graphify-driven, error recovery
- **6 cinematic capability images** — terminal mgmt, pty capture, exec, safety gate, MCP, cross-device
- **GitHub Pages landing page** — full website with carousels, stats, animations, case studies
- **Cross-platform installer** — bash (macOS/Linux) + PowerShell (Windows), auto-detects VS Code/Cursor/Windsurf
- **Live demo test script** — spawns 3 parallel workers to prove orchestration works

### Fixed
- Linux `script(1)` compatibility — auto-detects BSD vs GNU arg order
- Shell injection in `claws-run` — commands passed via temp file, not interpolated
- `nc -U` dependency removed — all shell commands use Python sockets
- Install step numbering consistent [1/8] through [8/8]
- MCP server tilde path warning in docs
- Installer never exits — `set +e`, all checks are warnings not blockers
- `pip` install uses `python -m pip` with `--break-system-packages` for macOS compatibility

### Changed
- `/claws-update` is now a full rebuild (re-runs entire installer), not just git pull

## [0.1.0] - 2026-04-17

### Added
- Initial release
- Unix socket server with newline-delimited JSON protocol
- Terminal management: list, create, show, send, close
- Wrapped terminals via `script(1)` for full pty capture
- `readLog` command with ANSI stripping
- `exec` command with file-based output capture
- `poll` command for shell-integration event streaming
- Safety gate: foreground process detection + warnings for non-shell TUIs
- Bracketed paste mode for multi-line sends
- "Claws Wrapped Terminal" dropdown profile
- Python client library (`claws-client`)
- Example scripts: basic orchestrator, parallel workers
