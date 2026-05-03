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
│   ├── src/            #   source — extension.ts, server.ts, claws-pty.ts,
│   │                   #            terminal-manager.ts, capture-store.ts,
│   │                   #            server-config.ts, status-bar.ts,
│   │                   #            uninstall-cleanup.ts, protocol.ts,
│   │                   #            ansi-strip.ts, safety.ts,
│   │                   #            peer-registry.ts, task-registry.ts
│   ├── test/           #   smoke, native-bundle, config-reload, capture-store,
│   │                   #   oversized-line, pty-lifecycle, profile-provider,
│   │                   #   multi-connection, claws-v2-hello, claws-v2-pubsub, claws-v2-tasks
│   │                   #   (90+ checks across 11 suites)
│   ├── native/         #   bundled node-pty (self-contained, no global install)
│   ├── package.json    #   manifest, build scripts, deps (node-pty optional)
│   ├── tsconfig.json   #   strict TS config
│   ├── esbuild.mjs     #   bundler entry
│   └── .vscodeignore   #   VSIX packaging exclusions
├── scripts/            # install.sh, shell-hook.sh, terminal-wrapper.sh, test-install.sh
│                       # inject-claude-md.js      — writes imperative CLAWS:BEGIN block into CLAUDE.md
│                       # inject-global-claude-md.js — writes machine-wide policy to ~/.claude/CLAUDE.md
│                       # inject-settings-hooks.js  — registers SessionStart/PreToolUse/Stop hooks
│                       # test-enforcement.sh        — integration test for full injection pipeline
├── mcp_server.js       # MCP server — installer copies into <project>/.claws-bin/
│                       # .claws-bin/hooks/  — lifecycle hook scripts (session-start, pre-tool-use, stop)
├── cli.js              # root CLI entry (package.json bin)
├── clients/            # optional language clients (python/ — node/ client is planned, not built yet)
├── .claude/            # installer copies these into each project
│   ├── commands/       #   19 claws-* slash commands
│   └── skills/         #   orchestration-engine, prompt-templates
├── rules/              # claws-default-behavior.md — installer copies it
├── templates/          # CLAUDE.project.md — imperative project-level injection template
│                       # CLAUDE.global.md  — machine-wide policy template (~/.claude/CLAUDE.md)
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

- **Version**: 0.7.10 — behavioral injection enforcement overhaul (Waves 1–3). Imperative templates, three injector scripts, three hook scripts, install.sh wiring. See `.local/audits/lifecycle-enforcement-gap.md` for the gap analysis this closes.
- **Previous**: 0.6.0 — claws/2 Agentic SDLC Protocol (Phase A + B). Peer registry, pub/sub message bus, task registry, 6 new MCP tools. 33 new checks → 90 total across 11 suites.
- **Phase**: 2 (complete) + Phase A/B (claws/2). All Phase 2 items landed. Phase A: peer registry + pub/sub. Phase B: task registry + MCP tools. Marketplace publish and WebSocket transport are Phase 3.
- **Transport**: Unix socket only (per-folder sockets for multi-root workspaces). WebSocket transport planned (Phase 3).
- **Cross-device**: not yet. SSH tunnel pattern documented as interim. WebSocket + token auth planned.
- **Marketplace**: not published yet. Needs publisher account + final VSIX validation.
- **Clients**: MCP server (Node.js) is primary. Python client optional. `introspect` command gives all clients a structured runtime snapshot.

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
- [x] TypeScript rewrite (extension.js → src/*.ts)
- [x] esbuild bundling
- [x] contributes.configuration for all 10 settings (socket path, default wrapped, capture/exec/poll limits, WebSocket opts)
- [x] Status bar item showing live terminal count + socket state (6B)
- [x] Commands: Status, List Terminals, Health Check, Show Log, Rebuild Native PTY, Uninstall Cleanup, Refresh Status Bar (7 total, all under `Claws:` category)
- [x] Chord keybindings: `cmd+alt+c h/l/s` (6B)
- [x] Extension tests — 57 checks / 8 suites (smoke, native-bundle, config-reload, capture-store, oversized-line, pty-lifecycle, profile-provider, multi-connection)
- [x] Icon (128×128 PNG) + banner
- [x] Bundled `node-pty` under `extension/native/node-pty/`
- [ ] GitHub Actions CI (lint + test on PR, publish on tag)
- [ ] Create VS Code Marketplace publisher account
- [ ] First marketplace publish
- [ ] PyPI publish for claws-client

### Phase A/B — claws/2 Agentic SDLC Protocol (shipped in v0.6.0)
- [x] Peer registry (`peer-registry.ts`) — in-memory map keyed by peerId, role, peerName; WeakMap<Socket, peerId> for O(1) disconnect cleanup
- [x] hello / ping — handshake + heartbeat
- [x] subscribe / unsubscribe / publish / broadcast — pub/sub with wildcard topic patterns (`*` / `**`)
- [x] Server-push frames — `{ push: 'message', ... }` without `rid`; clients distinguish by absence of rid
- [x] Task registry (`task-registry.ts`) — assign / update / complete / cancel / list with five-state lifecycle
- [x] MCP tools — `claws_hello`, `claws_subscribe`, `claws_publish`, `claws_broadcast`, `claws_ping`, `claws_peers`
- [x] inject-claude-md.js — TOOLS_V2 array + claws/2 subsection emitted into CLAUDE.md
- [x] Three new slash commands — `/claws-v2-orchestrate`, `/claws-v2-worker`, `/claws-v2-task-demo`
- [x] 33 new automated checks (claws-v2-hello: 6, claws-v2-pubsub: 11, claws-v2-tasks: 16)
- [ ] `peers` server command — Phase C (claws_peers currently returns stub `[]`)

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
- Protocol is versioned: `{ protocol: "claws/1", ... }` in handshake. claws/2 extends this with peer identity, pub/sub, and task assignment — all backward compatible with claws/1 clients.

**Behavioral injection enforcement** (v0.6.1):
The enforcement chain — every layer auto-loads, outer layers are fallbacks for inner:
1. `~/.claude/CLAUDE.md` (global, always loaded) — written by `inject-global-claude-md.js` from `templates/CLAUDE.global.md`
2. `<project>/CLAUDE.md` CLAWS:BEGIN block (project, always loaded) — written by `inject-claude-md.js` from `templates/CLAUDE.project.md`
3. `SessionStart` hook in `~/.claude/settings.json` — `session-start-claws.js` fires when `.claws/claws.sock` detected, emits lifecycle reminder
4. `PreToolUse:Bash` hook — `pre-tool-use-claws.js` nudges long-running commands toward `claws_create`
5. `Stop` hook — `stop-claws.js` reminds model to close terminals before session ends
Hooks are registered by `inject-settings-hooks.js` (called from `install.sh`). All tagged `_source:"claws"` for clean removal.

**claws/2 additions** (v0.6.0):
- `hello` — register as orchestrator / worker / observer; returns peerId
- `ping` — heartbeat, refreshes lastSeen
- `subscribe` / `unsubscribe` / `publish` — topic pub/sub with `*` and `**` wildcards
- `broadcast` — orchestrator-only fan-out to all workers
- `task.assign` / `task.update` / `task.complete` / `task.cancel` / `task.list` — full task lifecycle
- Server-push frames: `{ push: 'message', protocol: 'claws/2', topic, from, payload, sentAt }` — no `rid` field
- MIT license. All contributions welcome.
- Commit messages: conventional commits (`feat:`, `fix:`, `docs:`, `perf:`, `test:`).

## Key design principles

1. **Never use `script -F` with Ink-based TUIs** — `-F` flushes per-write and splits Ink's atomic frames, causing visual corruption. Default buffering is correct.
2. **`parallel: true` must be enforced, not advisory** — if the extension claims parallel dispatch, it must actually dispatch concurrently. Advisory flags create invisible regressions.
3. **Safety gate should warn, not block** — the whole point is sending prompts into Claude Code TUIs. Hard-blocking defeats the use case. Warn + proceed is the right default; `strict=true` for opt-in blocking.
4. **Bracketed paste for multi-line sends** — `\x1b[200~text\x1b[201~` prevents line-by-line fragmentation in shells. Essential for sending prompts.
5. **Monitor pattern for observation — bus-stream subscription, NOT file polling.** Claws is built on pub/sub event streaming. The Monitor tool consumes that stream directly via `scripts/stream-events.js` (a thin sidecar that subscribes to the claws/2 bus and emits each push frame as one stdout line). The `tail -F file | grep` pattern is a passive idle wait — Claude Code's background-process supervisor kills it with SIGURG (exit 144) within ~30s of inactivity. The bus-stream pattern emits constantly (heartbeats every ≤60s, system.metrics, every worker event, every tool invocation) — sub-100ms event latency, no SIGURG kill, and `each push frame becomes one Monitor notification` (literally what stream-events.js was designed for). Per-worker monitor command pattern:
   ```
   Monitor(command="CLAWS_TOPIC='system.worker.*' CLAWS_PEER_NAME='monitor-term-<id>' CLAWS_ROLE='observer' node <claws>/scripts/stream-events.js | grep --line-buffered '\"correlation_id\":\"<UUID>\"' | grep --line-buffered -m1 'system\\.worker\\.completed'", description="claws monitor | term=<id> | corr=<short>", timeout_ms=600000, persistent=false)
   ```
   `correlation_id` (Wave A D+F) filters to one worker; `grep -m1` exits on first completion → SIGPIPE closes stream-events.js → Monitor self-exits cleanly. Polling and `tail -F | grep` are anti-patterns — DO NOT use them.
6. **Auto-cleanup is mandatory** — every terminal the extension creates must be closeable + cleaned up when the orchestrator session ends. Stale terminals are a UX bug.
7. **File-based exec over shell integration** — VS Code's `onDidEndTerminalShellExecution` is unreliable in wrapped terminals. `{ cmd; } > /tmp/out 2>&1; echo $? > /tmp/done` with polling for the done file is robust across all terminal types.
8. **Non-blocking by default** — `claws_fleet` and `claws_worker` never hold the MCP socket open; they spawn terminals and return immediately with `terminal_ids`. The MCP stdio transport cannot safely hold a response open for more than a few seconds. Orchestrators poll completion via `claws_workers_wait` or by reading audit files written to `.local/audits/` on disk. Blocking modes (`wait:true` / `detach:false`) remain available behind an explicit opt-in but are flagged unsafe — use only when the caller's event loop can tolerate an indefinite hang.

## What this project is NOT

- Not a terminal emulator (VS Code already is one)
- Not a remote shell (SSH already does that)
- Not a terminal multiplexer (tmux already does that)
- Not a collaboration tool (VS Code Live Share already does that)

It IS: a **bridge** that makes VS Code terminals programmable from the outside. The smallest possible surface area that enables AI-driven terminal orchestration.
