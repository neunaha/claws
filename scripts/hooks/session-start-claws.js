#!/usr/bin/env node
// Claws SessionStart hook — detects Claws socket and emits lifecycle reminder.
//
// SAFETY CONTRACT: this hook MUST NEVER block, crash, or exit non-zero.
// Any internal error → silent exit 0. Hooks are advisory; failing loud
// blocks the user's tool calls and creates the very "hook errors" we're
// trying to eliminate. v0.7.3 hardening.
'use strict';

// M-24: gate error handlers on CLAWS_DEBUG — when CLAWS_DEBUG=1, errors
// propagate visibly for debugging instead of being silently swallowed.
if (!process.env.CLAWS_DEBUG) {
  process.on('uncaughtException', () => { try { process.exit(0); } catch {} });
  process.on('unhandledRejection', () => { try { process.exit(0); } catch {} });
}

// M-13: 5-second self-kill safety timer — hook can never hang the parent process.
// .unref() so the timer doesn't prevent normal early exit.
setTimeout(() => { process.exit(0); }, 5000).unref();

let input = '';
// M-13: single try block wrapping both 'data' and 'end' listeners — if either
// registration throws (pathological stdin state), both fail together cleanly.
try {
  process.stdin.on('data', d => { input += d; });
  process.stdin.on('end', () => {
    try {
      const fs   = require('fs');
      const path = require('path');

      let cwd = process.cwd();
      try {
        const parsed = JSON.parse(input);
        if (parsed.cwd) cwd = parsed.cwd;
      } catch { /* use process.cwd() */ }

      const socketPath = path.join(cwd, '.claws', 'claws.sock');
      if (!fs.existsSync(socketPath)) { process.exit(0); return; }

      // events.log: bus push events from the sidecar are piped here so the
      // orchestrator can arm a Monitor on it and receive real-time notifications.
      const logPath = path.join(cwd, '.claws', 'events.log');

      // Spawn stream-events.js sidecar daemon if not already running (idempotent).
      // SIM2B-P2b: include socket path in pgrep pattern so per-project sidecars are
      // distinct — a stale sidecar from a different project won't block this session.
      // pgrep exit 0 = found (running), non-zero = not found.
      try {
        const { spawnSync, spawn } = require('child_process');
        const sidecarPath = path.join(__dirname, '..', 'stream-events.js');
        if (fs.existsSync(sidecarPath)) {
          // Escape regex metacharacters in the socket path for the pgrep pattern.
          const escapedSocket = socketPath.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
          const pg = spawnSync('pgrep', ['-f', `stream-events\\.js.*--auto-sidecar.*${escapedSocket}`], { stdio: 'ignore' });
          if (pg.status !== 0) {
            // Pre-create events.log so 'tail -F' has a file to watch immediately
            // (sidecar writes the first event only after the first publish arrives).
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            try { fs.writeFileSync(logPath, '', { flag: 'a' }); } catch {}
            let logFd = null;
            try { logFd = fs.openSync(logPath, 'a'); } catch {}
            const sidecar = spawn(process.execPath, [sidecarPath, '--auto-sidecar', socketPath], {
              detached: true,
              stdio: ['ignore', logFd !== null ? logFd : 'ignore', 'ignore'],
              cwd,
            });
            sidecar.unref();
            // Close the fd in the parent — the child has its own copy after fork.
            if (logFd !== null) { try { fs.closeSync(logFd); } catch {} }
          }
        }
      } catch { /* sidecar spawn failure must never block the hook */ }

      // BUG-29: lifecycle-bound Monitor description — include session start timestamp
      // so stale Monitors from prior sessions are visually distinguishable.
      // Format: "claws bus | sess=<ISO-hour>" — add plan slug once lifecycle plan is active.
      const sessTs = new Date().toISOString().slice(0, 13); // "2026-05-02T04"

      const reminder = [
        '## Claws active in this project',
        '',
        `Bus events stream to ${logPath}. Server enforces lifecycle (sess=${sessTs}).`,
        '',
        'Spawn-class MCP tools (claws_create / claws_worker / claws_fleet / claws_dispatch_subworker)',
        'require an active Monitor on the bus stream — server refuses spawn without it.',
        'See docs/ENFORCEMENT.md for the architectural contract.',
      ].join('\n');

      try { process.stdout.write(JSON.stringify({ type: 'system', content: reminder }) + '\n'); } catch {}
      process.exit(0);
    } catch {
      process.exit(0);
    }
  });
} catch {
  process.exit(0);
}
