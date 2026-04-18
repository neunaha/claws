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

The repo has a **strict separation between product code (ships to GitHub, consumed by the installer) and local-development material (never leaves your machine)**. Anything that isn't product-facing belongs in `.local/` — don't put planning docs, audits, or scratch notes at the repo root.

### Product — ships to GitHub
```
Claws/
├── extension/          # VS Code extension (TypeScript + esbuild bundle)
│   ├── src/            #   source — extension.ts, server.ts, claws-pty.ts, …
│   ├── test/           #   smoke + worker test harnesses
│   ├── package.json    #   manifest, build scripts, deps (node-pty optional)
│   ├── tsconfig.json   #   strict TS config
│   ├── esbuild.mjs     #   bundler entry
│   └── .vscodeignore   #   VSIX packaging exclusions
├── scripts/            # install.sh, shell-hook.sh, terminal-wrapper.sh, test-install.sh
├── mcp_server.js       # MCP server — installer copies into <project>/.claws-bin/
├── cli.js              # root CLI entry (package.json bin)
├── clients/            # optional language clients (python/ — node/ client is planned, not built yet)
├── .claude/            # installer copies these into each project
│   ├── commands/       #   19 claws-* slash commands
│   └── skills/         #   orchestration-engine, prompt-templates
├── rules/              # claws-default-behavior.md — installer copies it
├── templates/          # CLAUDE.claws.md — legacy reference for the injector
├── docs/               # user/architecture docs (protocol.md, guide.md, …)
├── examples/           # orchestrator patterns
├── .github/            # CI workflows, issue templates
├── CLAUDE.md           # this file — contributor architecture doc
├── README.md           # public README
├── CHANGELOG.md        # version history
├── CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md  # community conventions
├── LICENSE             # MIT
├── package.json        # root npm manifest (bin → cli.js)
└── .gitignore
```

### Local-only — gitignored, never leaves your machine
```
.local/
├── README.md           # convention doc — read it before adding anything
├── audits/             # internal audits, post-mortems
├── blueprints/         # roadmaps, rewrite plans (e.g. v0.4-rewrite-plan.md)
└── notes/              # scratch notes, decisions, open questions
```
Plus any top-level `NOTES.md`, `TODO.md`, `SCRATCH.md` — all gitignored by pattern.

### Where does a new file belong?
Ask: "Would a user of Claws want or need this?"
- **Yes** → product tree above (usually `docs/`, `examples/`, or inside an existing product subdir).
- **No, it's internal planning** → `.local/{audits,blueprints,notes}/`.
- **No, it's a build artifact** → don't commit it; extend `.gitignore` if needed.

See `.local/README.md` for the full rubric.

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
