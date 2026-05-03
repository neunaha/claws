#!/usr/bin/env node
// Claws PreToolUse hook — Bash long-running enforcement.
//
// Default mode: long-running Bash patterns hard-block via exit 2 + stderr.
// STRICT=1: deny via permissionDecision JSON (cleaner inline reason).
//
// CLAWS_STRICT=1 (env var, set in user shell or settings.json env block):
// long-running Bash patterns return permissionDecision:"deny" via the
// PreToolUse hookSpecificOutput. Claude Code blocks the tool call and shows
// the reason — which tells the model exactly what to use instead.
//
// Lifecycle gate moved server-side in v0.6.5 — removed from this hook.
//
// SAFETY CONTRACT (v0.7.3): this hook MUST NEVER block, crash, or exit
// non-zero EXCEPT when intentionally denying via permissionDecision. Any
// internal error → silent exit 0. Avoids the "non-blocking status code"
// error spam that breaks user workflows.
'use strict';

// M-24: gate error handlers on CLAWS_DEBUG — when CLAWS_DEBUG=1, errors
// propagate visibly for debugging instead of being silently swallowed.
if (!process.env.CLAWS_DEBUG) {
  process.on('uncaughtException', () => { try { process.exit(0); } catch {} });
  process.on('unhandledRejection', () => { try { process.exit(0); } catch {} });
}

// M-13: 5-second self-kill safety timer — hook can never hang the parent process.
setTimeout(() => { process.exit(0); }, 5000).unref();

let input = '';
// M-13: single try block for both 'data' and 'end' — fail together or not at all.
try {
  process.stdin.on('data', d => { input += d; });
  process.stdin.on('end', () => {
    try {
      const fs   = require('fs');
      const path = require('path');

      // Patterns that almost always indicate orchestration work — long-running
      // servers, watchers, or background processes — where a wrapped Claws
      // terminal is strictly better than a fire-and-forget Bash call.
      // Conservative list: every entry should be unambiguously long-running
      // so strict mode never blocks ordinary commands like `ls`, `git status`,
      // or one-shot builds.
      const LONG_RUNNING_PATTERNS = [
        /\bnpm (run )?(start|dev|serve|watch)\b/i,
        /\byarn (start|dev|serve|watch)\b/i,
        /\bpnpm (run )?(start|dev|serve|watch)\b/i,
        /\bbun (run )?(start|dev|serve|watch)\b/i,
        /\bnode\b.*\bserver\b/i,
        /\bpython\b.*\bserver\b/i,
        /\b(uvicorn|gunicorn|hypercorn)\b/i,
        /\bflask run\b/i,
        /\brails (server|s)\b/i,
        /\bcargo (watch|run)\b/i,
        /\bgo run\b/i,
        /\bmake (run|serve|start|dev)\b/i,
        /\bnodemon\b/i,
        /\bnohup\b/i,
        // Always-block patterns: interactive/long-lived by nature
        /\bclaude(?!\s+-p\b)(?!\s+--print\b)(\s|$)/,   // claude without -p/--print (interactive TUI)
        /\bpython\s+-m\b/i,                              // python -m <module> (often servers/long-running)
        /\bvite\b(?!\s+build\b)/i,                      // vite dev server (not vite build)
        /\bwebpack(-dev-server|.*--watch)\b/i,           // webpack-dev-server or webpack --watch
        /\bnode\b.*\bserver\.js\b/i,                    // node server.js
      ];

      // BUG-16: argv[0] allowlist — LONG_RUNNING_PATTERNS only run when the
      // command name (first token, basename) is a known long-running candidate.
      // Prevents false positives when keywords appear in arguments, not commands
      // (e.g. `grep "node server"` or `cat node-server-config.json`).
      const LONG_RUNNING_ARGV0 = new Set([
        'npm', 'yarn', 'pnpm', 'bun', 'bunx', 'npx',
        'node', 'python', 'python3',
        'uvicorn', 'gunicorn', 'hypercorn', 'flask',
        'rails', 'cargo', 'go', 'make',
        'nodemon', 'nohup', 'claude',
        'vite', 'webpack', 'webpack-dev-server',
      ]);

      const STRICT = process.env.CLAWS_STRICT === '1';

      let data = {};
      try { data = JSON.parse(input); } catch { process.exit(0); return; }

      const toolName = data.tool_name || '';
      const cwd      = data.cwd || process.cwd();

      // Only act if Claws socket is present in the cwd
      const socketPath = path.join(cwd, '.claws', 'claws.sock');
      if (!fs.existsSync(socketPath)) { process.exit(0); return; }

      // --- Edit/Write guard: block direct edits to mcp_server.js from orchestrator ---
      if (toolName === 'Edit' || toolName === 'Write') {
        const filePath = (data.tool_input && data.tool_input.file_path) || '';
        if (/mcp_server\.js$/.test(filePath)) {
          // BUG-27: workers spawned by claws_worker/fleet/dispatch_subworker carry
          // CLAWS_WORKER=1 — allow them to edit mcp_server.js directly.
          if (process.env.CLAWS_WORKER === '1') { process.exit(0); return; }
          try {
            process.stderr.write(
              `[claws] Direct edits to mcp_server.js from orchestrator are forbidden.\n` +
              `        Dispatch a worker via claws_worker instead.\n`
            );
          } catch {}
          process.exit(2);
          return;
        }
      }

      // --- MCP spawn-class gate: enforce Monitor arm after grace period ---
      // claws_create / claws_worker / claws_fleet / claws_dispatch_subworker all
      // spawn terminals; requiring an active Monitor prevents silent orphans.
      // BUG-28: 5 s grace window (was 60 s) — tight enough to catch any spawn call
      // after the SessionStart reminder has been processed. Grace state lives in
      // /tmp keyed by a hash of cwd so it survives hook restarts within a session.
      const SPAWN_CLASS = /^mcp__claws__(claws_create|claws_worker|claws_fleet|claws_dispatch_subworker)$/;
      if (SPAWN_CLASS.test(toolName)) {
        const cwdKey = Buffer.from(cwd).toString('base64').replace(/[+/=]/g, '_').slice(0, 12);
        const graceFile = `/tmp/claws-pretooluse-grace-${cwdKey}`;
        let enforceNow = false;
        try {
          if (!fs.existsSync(graceFile)) {
            fs.writeFileSync(graceFile, String(Date.now()), 'utf8');
          } else {
            const ts = parseInt(fs.readFileSync(graceFile, 'utf8').trim(), 10);
            enforceNow = (Date.now() - ts) > 5000;
          }
        } catch { /* grace check failure → never block */ }

        if (enforceNow) {
          const { spawnSync } = require('child_process');
          const pg = spawnSync('pgrep', ['-f', 'tail.*\\.claws/events\\.log'], { stdio: 'ignore' });
          if (pg.status !== 0) {
            const eventsLog = path.join(cwd, '.claws', 'events.log');
            try {
              process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason:
                    `Monitor not armed on .claws/events.log. Run: Bash(command="tail -F ${eventsLog}", run_in_background=true) FIRST, then retry this MCP call. (This is required per the Claws lifecycle contract.)`,
                },
              }) + '\n');
            } catch {}
            process.exit(0);
            return;
          }
        }
      }

      // --- Bash long-running guard ---
      if (toolName === 'Bash') {
        const cmd = (data.tool_input && data.tool_input.command) || '';
        // BUG-16: extract argv[0] (basename of first token) and gate pattern
        // matching on the argv0 allowlist — prevents false positives from
        // keywords appearing inside arguments rather than as the command name.
        const argv0 = path.basename((cmd.trim().split(/\s+/)[0] || ''));
        const match = LONG_RUNNING_ARGV0.has(argv0) && LONG_RUNNING_PATTERNS.find(p => p.test(cmd));
        if (match) {
          const msg = [
            `[claws] Bash command matches a long-running pattern.`,
            `Run this in a visible, monitorable Claws terminal instead:`,
            ``,
            `  1. claws_create({ name: "<slug>", wrapped: true })`,
            `  2. claws_send({ id: <N>, text: ${JSON.stringify(cmd)} })`,
            `  3. claws_read_log({ id: <N>, lines: 50 }) — to observe`,
            `  4. claws_close({ id: <N> }) — when done`,
            ``,
            `Or use claws_worker for AI-driven tasks.`,
          ].join('\n');
          if (STRICT) {
            // STRICT mode: deny via permissionDecision JSON on stdout (M-16)
            try {
              process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: msg,
                },
              }) + '\n');
            } catch {}
            process.exit(0);
            return;
          }
          // Default: hard-block via exit 2 + stderr
          try { process.stderr.write(msg + '\n'); } catch {}
          process.exit(2);
          return;
        }
      }
      process.exit(0);
    } catch {
      process.exit(0);
    }
  });
} catch {
  process.exit(0);
}
